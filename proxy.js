const crypto = require('crypto');

const COUNTRY = 'br'; // app is Brazil-only; hardcoded, not an env var

function getProxyLaunchArgs() {
    const { PROXY_HOST, PROXY_PORT } = process.env;
    if (!PROXY_HOST || !PROXY_PORT) return [];
    return [`--proxy-server=${PROXY_HOST}:${PROXY_PORT}`];
}

async function authenticateProxy(page) {
    const { PROXY_USERNAME, PROXY_PASSWORD } = process.env;
    if (!PROXY_USERNAME || !PROXY_PASSWORD) return;
    const sessionId = crypto.randomUUID().replace(/-/g, '');
    const username = `${PROXY_USERNAME}__cr.${COUNTRY};sessid.${sessionId}`;
    await page.authenticate({ username, password: PROXY_PASSWORD });
}

module.exports = { getProxyLaunchArgs, authenticateProxy };
