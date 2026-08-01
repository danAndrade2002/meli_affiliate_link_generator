const crypto = require('crypto');

const COUNTRY = 'br'; // app is Brazil-only; hardcoded, not an env var

function isProxyConfigured() {
    const { PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD } = process.env;
    return !!(PROXY_HOST && PROXY_PORT && PROXY_USERNAME && PROXY_PASSWORD);
}

function getProxyLaunchArgs() {
    const { PROXY_HOST, PROXY_PORT } = process.env;
    if (!PROXY_HOST || !PROXY_PORT) return [];
    return [`--proxy-server=${PROXY_HOST}:${PROXY_PORT}`];
}

async function authenticateProxy(page) {
    const { PROXY_USERNAME, PROXY_PASSWORD } = process.env;
    if (!PROXY_USERNAME || !PROXY_PASSWORD) return null;
    const sessionId = crypto.randomUUID().replace(/-/g, '');
    const username = `${PROXY_USERNAME}__cr.${COUNTRY};sessid.${sessionId}`;
    await page.authenticate({ username, password: PROXY_PASSWORD });
    return sessionId;
}

/**
 * Fetches the page's current public IP (through the proxy, if one is
 * active) for diagnostic logging. Never throws - returns null on failure
 * so a broken IP-echo endpoint can't break the real scrape/login flow.
 */
async function getExitIp(page) {
    try {
        return await page.evaluate(() =>
            fetch('https://api.ipify.org?format=json').then(r => r.json()).then(d => d.ip)
        );
    } catch {
        return null;
    }
}

module.exports = { isProxyConfigured, getProxyLaunchArgs, authenticateProxy, getExitIp };
