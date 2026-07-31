const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { getProxyLaunchArgs, authenticateProxy } = require('./proxy');
require('dotenv').config();

puppeteer.use(StealthPlugin());

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
        const thumbnail = card.querySelector('img')?.getAttribute('src')
            || card.querySelector('img')?.getAttribute('data-src')
            || null;
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
        await authenticateProxy(page);
        await page.setViewport({ width: 1280, height: 800 });

        const url = buildSearchUrl(query);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        const finalUrl = page.url();
        if (finalUrl.includes('/account-verification') || finalUrl.includes('/gz/login') || finalUrl.includes('/jms/')) {
            throw new Error(`Redirected to ${finalUrl}. Search blocked or flagged as a bot.`);
        }

        await page.waitForSelector('li.ui-search-layout__item', { timeout: 10000 }).catch(() => {});

        return await page.evaluate(extractProducts, limit);
    } finally {
        await browser.close();
    }
}

module.exports = { searchProducts, buildSearchUrl, extractProducts };
