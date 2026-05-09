const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'affiliate',
    user:     process.env.DB_USER     || 'affiliate',
    password: process.env.DB_PASSWORD || '',
});

async function waitForDb(maxAttempts = 10, delayMs = 2000) {
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            const client = await pool.connect();
            client.release();
            return;
        } catch (err) {
            if (i === maxAttempts) throw err;
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS affiliate_cache (
            origin_url     TEXT        NOT NULL,
            tag            TEXT        NOT NULL,
            affiliate_link TEXT        NOT NULL,
            generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (origin_url, tag)
        )
    `);
}

async function getCacheEntry(originUrl, tag) {
    const { rows } = await pool.query(
        'SELECT origin_url, affiliate_link, tag, generated_at FROM affiliate_cache WHERE origin_url = $1 AND tag = $2',
        [originUrl, tag]
    );
    if (!rows[0]) return null;
    return { ...rows[0], generated_at: rows[0].generated_at.toISOString() };
}

async function setCacheEntry(originUrl, tag, affiliateLink, generatedAt) {
    await pool.query(
        `INSERT INTO affiliate_cache (origin_url, tag, affiliate_link, generated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (origin_url, tag) DO UPDATE
           SET affiliate_link = EXCLUDED.affiliate_link,
               generated_at   = EXCLUDED.generated_at`,
        [originUrl, tag, affiliateLink, generatedAt]
    );
}

async function getAllCacheEntries() {
    const { rows } = await pool.query(
        'SELECT origin_url, affiliate_link, tag, generated_at FROM affiliate_cache ORDER BY generated_at DESC'
    );
    return rows.map(r => ({ ...r, generated_at: r.generated_at.toISOString() }));
}

module.exports = { waitForDb, initDb, getCacheEntry, setCacheEntry, getAllCacheEntries };
