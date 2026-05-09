const fs = require('fs');
const path = require('path');

class SessionExpiredError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'SessionExpiredError';
        this.status = status;
    }
}

/**
 * Generate affiliate links via Mercado Livre's internal API.
 *
 * @param {string[]} urls - product URLs to generate affiliate links for
 * @param {string} tag - affiliate tag
 * @param {object} [options]
 * @param {string} [options.sessionPath] - path to session.json (default: ./session.json)
 * @param {function} [options.fetchFn] - custom fetch implementation (for testing)
 */
async function createAffiliateLink(urls, tag, options = {}) {
    const sessionPath = options.sessionPath || process.env.SESSION_PATH || path.join(process.cwd(), 'session.json');
    const fetchFn = options.fetchFn || fetch;

    let session;
    try {
        session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
        throw new SessionExpiredError(
            'No session.json found. Run Meli_Login.js to authenticate first.',
            null
        );
    }

    const response = await fetchFn('https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink', {
        method: 'POST',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'content-type': 'application/json',
            'origin': 'https://www.mercadolivre.com.br',
            'referer': 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
            'user-agent': session.userAgent,
            'x-csrf-token': session.csrfToken,
            'cookie': session.cookieHeader
        },
        body: JSON.stringify({ urls, tag })
    });

    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
        throw new SessionExpiredError(
            `Mercado Livre returned ${response.status}. Session expired or CSRF invalid. Re-run Meli_Login.js.`,
            response.status
        );
    }

    if (response.headers.get('content-type')?.includes('text/html')) {
        throw new SessionExpiredError(
            'Mercado Livre returned HTML instead of JSON. Likely redirected to login. Re-run Meli_Login.js.',
            response.status
        );
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`Unexpected non-JSON response (status ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!data?.urls) {
        throw new Error(`Unexpected response shape: ${JSON.stringify(data).slice(0, 300)}`);
    }

    // Normalize per-URL results into success/error shape
    const results = data.urls.map(u => {
        if (u.short_url) {
            return {
                origin_url: u.origin_url,
                status: 'success',
                tag: u.tag,
                affiliate_link: u.short_url
            };
        }
        return {
            origin_url: u.origin_url,
            status: 'error',
            error_code: u.error_code,
            error_message: u.message || 'Unknown error'
        };
    });

    return {
        http_status: response.status,
        total_items: data.total_items,
        total_success: data.total_success,
        total_error: data.total_error,
        results
    };
}

module.exports = { createAffiliateLink, SessionExpiredError };
