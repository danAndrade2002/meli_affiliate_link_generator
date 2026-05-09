const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAffiliateLink, SessionExpiredError } = require('./createAffiliateLink');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEFAULT_TAG = process.env.MELI_AFFILIATE_TAG || 'oliveiradanilo20211125223941';
const CACHE_PATH = path.join(process.cwd(), 'affiliate_cache.json');
const API_KEY = process.env.API_KEY;

// ---------- Logger ----------
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
    debug: '\x1b[90m',  // gray
    info:  '\x1b[36m',  // cyan
    warn:  '\x1b[33m',  // yellow
    error: '\x1b[31m',  // red
    reset: '\x1b[0m'
};

function log(level, message, meta = {}) {
    if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
    const ts = new Date().toISOString();
    const color = COLORS[level] || '';
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    console.log(`${color}[${ts}] ${level.toUpperCase().padEnd(5)}${COLORS.reset} ${message}${metaStr}`);
}
const logger = {
    debug: (m, meta) => log('debug', m, meta),
    info:  (m, meta) => log('info',  m, meta),
    warn:  (m, meta) => log('warn',  m, meta),
    error: (m, meta) => log('error', m, meta),
};

// ---------- Request logging middleware ----------
app.use((req, res, next) => {
    req.id = crypto.randomBytes(4).toString('hex');
    req.startTime = Date.now();
    logger.info(`→ ${req.method} ${req.path}`, {
        reqId: req.id,
        ip: req.ip,
        ua: req.headers['user-agent']?.slice(0, 60)
    });

    res.on('finish', () => {
        const duration = Date.now() - req.startTime;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger[level](`← ${req.method} ${req.path} ${res.statusCode} (${duration}ms)`, { reqId: req.id });
    });
    next();
});

// ---------- Cache ----------
function loadCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ---------- API key middleware ----------
app.use((req, res, next) => {
    if (!API_KEY) return next();
    if (req.headers['x-api-key'] === API_KEY) return next();
    logger.warn('Unauthorized request (missing/invalid API key)', { reqId: req.id, path: req.path });
    return res.status(401).json({ error: 'unauthorized' });
});

// ---------- Routes ----------
app.get('/health', (req, res) => {
    const sessionExists = fs.existsSync(path.join(process.cwd(), 'session.json'));
    logger.debug('Health check', { reqId: req.id, session_available: sessionExists });
    res.json({ status: 'ok', session_available: sessionExists });
});

app.post('/affiliate-links', async (req, res) => {
    const { urls, tag = DEFAULT_TAG, force = false } = req.body || {};

    if (!Array.isArray(urls) || urls.length === 0) {
        logger.warn('Bad request: urls missing or not array', { reqId: req.id, body: req.body });
        return res.status(400).json({ error: 'urls must be a non-empty array' });
    }

    logger.info(`Request to generate links`, {
        reqId: req.id,
        count: urls.length,
        tag,
        force
    });

    const cache = loadCache();
    const results = [];
    const urlsToGenerate = [];

    for (const url of urls) {
        const cached = cache[url];
        if (cached && cached.tag === tag && !force) {
            results.push({ origin_url: url, ...cached, cached: true });
        } else {
            urlsToGenerate.push(url);
        }
    }

    logger.info(`Cache check: ${results.length} hit, ${urlsToGenerate.length} miss`, { reqId: req.id });

    if (urlsToGenerate.length > 0) {
        const t0 = Date.now();
        try {
            logger.debug('Calling Mercado Livre API', { reqId: req.id, urls: urlsToGenerate });
            const apiResult = await createAffiliateLink(urlsToGenerate, tag);

            if (apiResult.http_status !== 200) {
                logger.error('Mercado Livre API returned non-200', {
                    reqId: req.id,
                    status: apiResult.http_status,
                    detail: apiResult
                });
                return res.status(502).json({
                    error: 'mercado_livre_api_error',
                    detail: apiResult
                });
            }

            for (const r of apiResult.results) {
                if (r.status === 'success') {
                    const entry = {
                        affiliate_link: r.affiliate_link,
                        tag: r.tag,
                        generated_at: new Date().toISOString()
                    };
                    cache[r.origin_url] = entry;
                    results.push({
                        origin_url: r.origin_url,
                        status: 'success',
                        ...entry,
                        cached: false
                    });
                } else {
                    results.push({
                        origin_url: r.origin_url,
                        status: 'error',
                        error_code: r.error_code,
                        error_message: r.error_message
                    });
                }
            }
            saveCache(cache);

            logger.info(`Upstream generation complete`, {
                reqId: req.id,
                duration_ms: Date.now() - t0,
                success: apiResult.total_success,
                errors: apiResult.total_error
            });
        } catch (err) {
            if (err instanceof SessionExpiredError) {
                logger.error('Session expired', { reqId: req.id, message: err.message, status: err.status });
                return res.status(401).json({
                    error: 'session_expired',
                    message: err.message,
                    action: 'Run `node Meli_Login.js` to re-authenticate.'
                });
            }
            logger.error('Link generation failed', { reqId: req.id, message: err.message, stack: err.stack });
            return res.status(500).json({ error: 'generation_failed', message: err.message });
        }
    }

    // Normalize cached results to include status field
    const normalized = results.map(r => r.status ? r : { ...r, status: 'success' });
    const successCount = normalized.filter(r => r.status === 'success').length;
    const errorCount = normalized.length - successCount;

    // If all URLs failed, return 422 so the consumer can fail fast
    const statusCode = successCount === 0 ? 422 : 200;

    res.status(statusCode).json({
        total: normalized.length,
        success_count: successCount,
        error_count: errorCount,
        results: normalized
    });
});

app.get('/affiliate-links', (req, res) => {
    const cache = loadCache();
    const results = Object.entries(cache).map(([origin_url, entry]) => ({
        origin_url,
        ...entry
    }));
    logger.debug(`Listing cached links`, { reqId: req.id, count: results.length });
    res.json({ count: results.length, results });
});

// ---------- Error & startup ----------
app.use((err, req, res, next) => {
    logger.error('Unhandled error', { reqId: req.id, message: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal_error', message: err.message });
});

app.listen(PORT, () => {
    logger.info(`Affiliate link server listening on http://localhost:${PORT}`, {
        log_level: LOG_LEVEL,
        api_key_required: !!API_KEY,
        default_tag: DEFAULT_TAG
    });
});
