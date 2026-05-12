const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
require('dotenv').config();

puppeteer.use(StealthPlugin());

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const SESSION_PATH = path.join(process.cwd(), 'session.json');

// Cookies required by the affiliate API
const RELEVANT_COOKIES = [
    'ssid', 'orguseridp', 'orgnickp', 'orguserid',
    'ftid', '_csrf', '_d2id', '_mldataSessionId',
    'nsa_rotok', 'main_domain'
];

// ---------- Pure/mockable helpers (testable) ----------

/**
 * Recursively extracts text body from a Gmail API message payload.
 * @param {object} message - Gmail message with .payload
 * @returns {string} concatenated text of all parts
 */
function getEmailBody(message) {
    let body = '';
    function extractParts(payload) {
        if (payload?.body?.data) {
            body += Buffer.from(payload.body.data, 'base64').toString('utf-8');
        }
        if (payload?.parts) payload.parts.forEach(extractParts);
    }
    extractParts(message.payload);
    return body;
}

/**
 * Extracts a 6-digit OTP code from a string.
 * @param {string} text
 * @returns {string|null} the OTP or null if none found
 */
function extractOTP(text) {
    if (!text) return null;
    const match = text.match(/\b(\d{6})\b/);
    return match ? match[1] : null;
}

/**
 * Formats an array of puppeteer cookies into a Cookie header string.
 * @param {Array<{name:string, value:string}>} cookies
 * @returns {string}
 */
function formatCookieHeader(cookies) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Filters cookies to only include those relevant to the affiliate API.
 * @param {Array<{name:string, value:string}>} cookies
 * @param {string[]} [relevantNames] - defaults to RELEVANT_COOKIES
 * @returns {Array<{name:string, value:string}>}
 */
function filterRelevantCookies(cookies, relevantNames = RELEVANT_COOKIES) {
    return cookies.filter(c => relevantNames.includes(c.name));
}

/**
 * Polls Gmail for an OTP email. Uses injected gmail client and timing config.
 * @param {object} gmail - Gmail API client from googleapis
 * @param {object} [options]
 * @param {number} [options.maxAttempts=15]
 * @param {number} [options.delayMs=3000]
 * @param {function} [options.sleep]
 * @returns {Promise<string>} the OTP
 */
async function pollGmailForOTP(gmail, options = {}) {
    const maxAttempts = options.maxAttempts ?? 15;
    const delayMs = options.delayMs ?? 3000;
    const sleep = options.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));

    for (let i = 0; i < maxAttempts; i++) {
        await sleep(delayMs);

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'from:(mercadolivre OR mercadolibre) newer_than:1h',
            maxResults: 5
        });

        if (res.data.messages && res.data.messages.length > 0) {
            for (const message of res.data.messages) {
                const msg = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'full'
                });
                const body = getEmailBody(msg.data);
                const otp = extractOTP(body);
                if (otp) return otp;
            }
        }
    }
    throw new Error(`Could not find OTP email after ${maxAttempts} attempts`);
}

// ---------- Gmail auth (harder to unit test, depend on disk + OAuth) ----------

async function loadSavedCredentialsIfExist(tokenPath = TOKEN_PATH) {
    try {
        const content = await fs.readFile(tokenPath);
        return google.auth.fromJSON(JSON.parse(content));
    } catch {
        return null;
    }
}

async function saveCredentials(client, credentialsPath = CREDENTIALS_PATH, tokenPath = TOKEN_PATH) {
    const content = await fs.readFile(credentialsPath);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    await fs.writeFile(tokenPath, JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    }));
}

async function authorizeGmail() {
    let client = await loadSavedCredentialsIfExist();
    if (client) return client;
    client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
    if (client.credentials) await saveCredentials(client);
    return client;
}

// ---------- Puppeteer flow (only runs when invoked directly) ----------

async function runLoginFlow() {
    console.log('Authorizing Gmail API...');
    const auth = await authorizeGmail();
    console.log('Gmail authorized.');

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const page = await browser.newPage();
    const timeout = 15000;
    page.setDefaultTimeout(timeout);

    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.goto('https://www.mercadolivre.com/jms/mlb/lgz/msl/login', {
        waitUntil: 'networkidle2'
    });

    const emailInput = await page.waitForSelector("[data-testid='user_id']");
    await emailInput.click();
    await page.type("[data-testid='user_id']", process.env.MELI_EMAIL, { delay: 80 });
    await new Promise(r => setTimeout(r, 1500));

    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, [role="button"]')]
            .find(el => el.textContent.includes('Continuar'));
        if (btn) btn.click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => {
        const emailOption = document.querySelector('#code_validation button');
        if (emailOption) emailOption.click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    console.log('Waiting for OTP email...');
    const gmail = google.gmail({ version: 'v1', auth });
    const otp = await pollGmailForOTP(gmail);
    console.log('OTP received:', otp);

    const otpSelector = 'input[data-testid="code_input"], input[name="code"], input[type="tel"], input[inputmode="numeric"]';
    const otpInput = await page.waitForSelector(otpSelector);
    await otpInput.click();
    await page.type(otpSelector, otp, { delay: 100 });
    await new Promise(r => setTimeout(r, 1000));

    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, [role="button"]')]
            .find(el => el.textContent.includes('Verificar') || el.textContent.includes('Continuar') || el.textContent.includes('Confirmar'));
        if (btn) btn.click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('Login successful!');

    await page.goto('https://www.mercadolivre.com.br/afiliados/linkbuilder', {
        waitUntil: 'networkidle2'
    });
    await new Promise(r => setTimeout(r, 2000));

    const allCookies = await page.cookies();
    console.log(`Captured ${allCookies.length} cookies`);

    const csrfToken = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="csrf-token"]') ||
                     document.querySelector('meta[name="_csrf"]');
        if (meta) return meta.getAttribute('content');
        if (window.__PRELOADED_STATE__?.csrfToken) return window.__PRELOADED_STATE__.csrfToken;
        if (window.CSRF_TOKEN) return window.CSRF_TOKEN;
        const html = document.documentElement.outerHTML;
        const patterns = [
            /"csrfToken"\s*:\s*"([^"]+)"/,
            /"csrf_token"\s*:\s*"([^"]+)"/,
            /"x-csrf-token"\s*:\s*"([^"]+)"/i,
            /csrfToken['"]?\s*[:=]\s*['"]([^'"]+)['"]/
        ];
        for (const p of patterns) {
            const m = html.match(p);
            if (m) return m[1];
        }
        return null;
    });

    const relevantCookies = filterRelevantCookies(allCookies);
    const session = {
        cookieHeader: formatCookieHeader(allCookies),
        relevantCookieHeader: formatCookieHeader(relevantCookies),
        csrfToken,
        relevantCookies: Object.fromEntries(relevantCookies.map(c => [c.name, c.value])),
        userAgent: await page.evaluate(() => navigator.userAgent),
        capturedAt: new Date().toISOString()
    };
    await fs.writeFile(SESSION_PATH, JSON.stringify(session, null, 2));

    console.log('\n=== Session captured ===');
    console.log('CSRF token:', csrfToken || '(not found)');
    console.log('Relevant cookies found:');
    relevantCookies.forEach(c => console.log(`  ${c.name}=${c.value.substring(0, 40)}${c.value.length > 40 ? '...' : ''}`));

    await browser.close();
}

// Only run when invoked directly, not when imported for tests
if (require.main === module) {
    runLoginFlow().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = {
    runLoginFlow,
    getEmailBody,
    extractOTP,
    formatCookieHeader,
    filterRelevantCookies,
    pollGmailForOTP,
    loadSavedCredentialsIfExist,
    saveCredentials,
    RELEVANT_COOKIES
};
