const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { getProxyLaunchArgs, authenticateProxy, isProxyConfigured, getExitIp } = require('./proxy');
require('dotenv').config();

puppeteer.use(StealthPlugin());

/**
 * True if a URL indicates Mercado Livre has redirected the request to a
 * login/verification/bot-check page instead of serving results.
 */
function isBlockedUrl(url) {
    return url.includes('/account-verification')
        || url.includes('/gz/login')
        || url.includes('/jms/')
        || url.includes('/security/');
}

/**
 * Builds a lista.mercadolivre.com.br search URL from a free-text query,
 * matching the slug format the site itself uses (e.g. "whey protein" -> .../whey-protein).
 */
function buildSearchUrl(query) {
    const slug = query
        .trim()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-');
    return `https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}`;
}

/**
 * Runs inside the page. Reads product cards from the rendered DOM rather than
 * the internal React-flight payload the page streams down (undocumented,
 * versioned wire format that can change on any frontend deploy).
 */
function extractProducts(limit) {
    const cards = [...document.querySelectorAll('li.ui-search-layout__item')].slice(0, limit);

    function parseMoney(fraction, cents) {
        if (!fraction) return null;
        const whole = fraction.replace(/\./g, '');
        return Number(`${whole}.${cents || '00'}`);
    }

    return cards.map(card => {
        const link = card.querySelector('a.poly-component__title, a[href*="/p/MLB"], a[href*="/MLB-"]');
        const href = link ? link.href : null;
        const sponsored = !!href && href.startsWith('https://click1.mercadolivre.com.br');

        // Product/item ids ride in the URL hash (polycard tracking params) on
        // every card, sponsored or not. Rebuilding a plain /p/<id> permalink
        // from them means we never return an ad-click redirect URL.
        const hash = href && href.includes('#') ? href.split('#')[1] : null;
        const hashParams = hash ? new URLSearchParams(hash) : null;
        const productId = hashParams ? hashParams.get('searchVariation') : null;
        const itemId = hashParams ? hashParams.get('wid') : null;

        let url = null;
        if (productId) {
            url = `https://www.mercadolivre.com.br/p/${productId}`;
        } else if (href && !sponsored) {
            url = href.split('#')[0];
        }

        const title = card.querySelector('.poly-component__title')?.textContent?.trim()
            || link?.textContent?.trim()
            || null;
        const priceFraction = card.querySelector('.poly-price__current .andes-money-amount__fraction')?.textContent?.trim();
        const priceCents = card.querySelector('.poly-price__current .andes-money-amount__cents')?.textContent?.trim();
        const originalPriceFraction = card.querySelector('s.andes-money-amount--previous .andes-money-amount__fraction')?.textContent?.trim();
        // Product photo is the sole img.poly-component__picture in the card (verified
        // against live markup: src is always a real http2.mlstatic.com URL, not a lazy
        // placeholder). Fall back to a generic img/data-src lookup in case the class
        // name ever changes, and treat a data: URI as an unloaded placeholder.
        const image = card.querySelector('img.poly-component__picture') || card.querySelector('img');
        const imageSrc = image?.getAttribute('src');
        const thumbnail = (imageSrc && !imageSrc.startsWith('data:'))
            ? imageSrc
            : image?.getAttribute('data-src') || null;
        const seller = card.querySelector('.poly-component__seller')?.textContent?.trim() || null;
        const freeShipping = !!card.querySelector('.poly-component__shipping');

        return {
            title,
            url,
            itemId,
            productId,
            price: parseMoney(priceFraction, priceCents),
            originalPrice: originalPriceFraction ? Number(originalPriceFraction.replace(/\./g, '')) : null,
            thumbnail,
            seller,
            freeShipping,
            sponsored
        };
    });
}

/**
 * Scrapes Mercado Livre search results for a query. Renders the page with
 * Puppeteer (rather than a plain fetch) because lista.mercadolivre.com.br
 * serves results via client-side hydration and flags plain HTTP clients as
 * bots. No login session is needed: search results are public, and testing
 * showed anonymous requests return the same product data as authenticated
 * ones (Puppeteer + stealth is enough to get past the bot check).
 *
 * @param {string} query - free-text search query, e.g. "whey protein"
 * @param {object} [options]
 * @param {number} [options.limit=20] - max products to return
 */
async function searchProducts(query, options = {}) {
    const limit = options.limit || 20;

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', ...getProxyLaunchArgs()]
    });

    try {
        const page = await browser.newPage();
        const sessionId = await authenticateProxy(page);
        console.log(`[scrapeSearch] proxy ${isProxyConfigured() ? 'enabled' : 'disabled'}`, sessionId ? { sessionId } : {});

        if (isProxyConfigured() && process.env.LOG_LEVEL === 'debug') {
            const exitIp = await getExitIp(page);
            console.log(`[scrapeSearch] proxy exit IP: ${exitIp || 'unknown (IP check failed)'}`);
        }

        // Logs proxy config + exit IP at the moment a block is detected - the IP tells
        // us whether we're going out over the residential proxy (and it's flagged) or
        // over the host's own IP (proxy env vars missing/misconfigured on this deploy).
        const logBlocked = async (reason, blockedUrl) => {
            const exitIp = await getExitIp(page);
            console.warn(`[scrapeSearch] BLOCKED query="${query}" reason="${reason}" proxy=${isProxyConfigured() ? 'enabled' : 'DISABLED'} exitIp=${exitIp || 'unknown'} url=${blockedUrl}`);
        };

        await page.setViewport({ width: 1280, height: 800 });

        const url = buildSearchUrl(query);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        if (isBlockedUrl(page.url())) {
            await logBlocked('redirected after initial navigation', page.url());
            throw new Error(`Redirected to ${page.url()}. Search blocked or flagged as a bot.`);
        }

        // Mercado Livre also runs a client-side bot/proof-of-work challenge that only
        // redirects *after* the initial goto settles (no new network activity while it
        // computes, so networkidle2 fires on the challenge page itself). Re-check the
        // URL once we're done waiting for cards so that case surfaces as an error too,
        // instead of silently falling through to a 0-result page.evaluate.
        const foundSelector = await page.waitForSelector('li.ui-search-layout__item', { timeout: 10000 })
            .then(() => true)
            .catch(() => false);

        if (!foundSelector && isBlockedUrl(page.url())) {
            await logBlocked('redirected while waiting for results (bot challenge)', page.url());
            throw new Error(`Redirected to ${page.url()} while waiting for results. Search blocked or flagged as a bot.`);
        }

        const products = await page.evaluate(extractProducts, limit);

        console.log(`[scrapeSearch] query="${query}" foundSelector=${foundSelector} cardCount=${products.length} url=${page.url()} title="${await page.title()}"`);

        if (products.length === 0) {
            await logBlocked('page loaded normally but no product cards found', page.url());
        }

        return products;
    } finally {
        await browser.close();
    }
}

module.exports = { searchProducts, buildSearchUrl, extractProducts };
