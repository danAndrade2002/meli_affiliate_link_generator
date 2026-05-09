const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAffiliateLink, SessionExpiredError } = require('../../createAffiliateLink');

const FIXTURE_SESSION = path.join(__dirname, '..', 'fixtures', 'session.json');

/**
 * Builds a minimal mock response that mimics the fetch Response API.
 */
function mockResponse({ status = 200, body = {}, contentType = 'application/json' }) {
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        status,
        headers: {
            get: (name) => name.toLowerCase() === 'content-type' ? contentType : null
        },
        text: async () => bodyText
    };
}

/**
 * Records calls to fetch and returns a configurable response.
 */
function createMockFetch(responseConfig) {
    const calls = [];
    const fetchFn = async (url, options) => {
        calls.push({ url, options });
        return mockResponse(responseConfig);
    };
    fetchFn.calls = calls;
    return fetchFn;
}

describe('createAffiliateLink – response normalization', () => {
    test('normalizes a successful URL into { status: "success", affiliate_link }', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: {
                status: 200,
                urls: [{
                    id: 'abc123',
                    created: true,
                    tag: 'mytag',
                    short_url: 'https://meli.la/abc123',
                    origin_url: 'https://www.mercadolivre.com.br/p/MLB1'
                }],
                total_items: 1,
                total_success: 1,
                total_error: 0
            }
        });

        const result = await createAffiliateLink(
            ['https://www.mercadolivre.com.br/p/MLB1'],
            'mytag',
            { sessionPath: FIXTURE_SESSION, fetchFn }
        );

        assert.equal(result.http_status, 200);
        assert.equal(result.total_success, 1);
        assert.equal(result.total_error, 0);
        assert.equal(result.results.length, 1);
        assert.deepEqual(result.results[0], {
            origin_url: 'https://www.mercadolivre.com.br/p/MLB1',
            status: 'success',
            tag: 'mytag',
            affiliate_link: 'https://meli.la/abc123'
        });
    });

    test('normalizes an invalid URL into { status: "error", error_code, error_message }', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: {
                status: 200,
                urls: [{
                    origin_url: 'https://www.mercadolivre.com.br/invalid',
                    message: 'URL not allowed in affiliates program',
                    error_code: 111,
                    status: 200
                }],
                total_items: 1,
                total_success: 0,
                total_error: 1
            }
        });

        const result = await createAffiliateLink(
            ['https://www.mercadolivre.com.br/invalid'],
            'mytag',
            { sessionPath: FIXTURE_SESSION, fetchFn }
        );

        assert.equal(result.results[0].status, 'error');
        assert.equal(result.results[0].error_code, 111);
        assert.equal(result.results[0].error_message, 'URL not allowed in affiliates program');
        assert.equal(result.results[0].affiliate_link, undefined);
    });

    test('handles mixed success and error responses in a single request', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: {
                status: 200,
                urls: [
                    { origin_url: 'https://valid/p/1', short_url: 'https://meli.la/x', tag: 't' },
                    { origin_url: 'https://invalid/x', error_code: 111, message: 'Invalid' }
                ],
                total_items: 2,
                total_success: 1,
                total_error: 1
            }
        });

        const result = await createAffiliateLink(
            ['https://valid/p/1', 'https://invalid/x'],
            't',
            { sessionPath: FIXTURE_SESSION, fetchFn }
        );

        assert.equal(result.results.length, 2);
        assert.equal(result.results[0].status, 'success');
        assert.equal(result.results[1].status, 'error');
    });

    test('uses "Unknown error" when error message is missing', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: {
                status: 200,
                urls: [{ origin_url: 'https://x', error_code: 999 }],
                total_items: 1,
                total_success: 0,
                total_error: 1
            }
        });

        const result = await createAffiliateLink(
            ['https://x'],
            't',
            { sessionPath: FIXTURE_SESSION, fetchFn }
        );

        assert.equal(result.results[0].error_message, 'Unknown error');
    });

    test('returns empty results when upstream returns empty urls array', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: { status: 200, urls: [], total_items: 0, total_success: 0, total_error: 0 }
        });

        const result = await createAffiliateLink(
            ['https://x'],
            't',
            { sessionPath: FIXTURE_SESSION, fetchFn }
        );

        assert.deepEqual(result.results, []);
        assert.equal(result.total_items, 0);
    });
});

describe('createAffiliateLink – error handling', () => {
    test('throws SessionExpiredError on 401', async () => {
        const fetchFn = createMockFetch({ status: 401, body: { error: 'unauthorized' } });

        await assert.rejects(
            () => createAffiliateLink(['https://x'], 't', { sessionPath: FIXTURE_SESSION, fetchFn }),
            (err) => {
                assert.ok(err instanceof SessionExpiredError);
                assert.equal(err.status, 401);
                assert.match(err.message, /401/);
                return true;
            }
        );
    });

    test('throws SessionExpiredError on 403', async () => {
        const fetchFn = createMockFetch({ status: 403, body: { error: 'forbidden' } });

        await assert.rejects(
            () => createAffiliateLink(['https://x'], 't', { sessionPath: FIXTURE_SESSION, fetchFn }),
            SessionExpiredError
        );
    });

    test('throws SessionExpiredError when response is HTML (login redirect)', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: '<html><body>Login page</body></html>',
            contentType: 'text/html; charset=utf-8'
        });

        await assert.rejects(
            () => createAffiliateLink(['https://x'], 't', { sessionPath: FIXTURE_SESSION, fetchFn }),
            (err) => {
                assert.ok(err instanceof SessionExpiredError);
                assert.match(err.message, /HTML/);
                return true;
            }
        );
    });

    test('throws SessionExpiredError when session file is missing', async () => {
        const fetchFn = createMockFetch({ status: 200, body: {} });

        await assert.rejects(
            () => createAffiliateLink(['https://x'], 't', {
                sessionPath: '/nonexistent/session.json',
                fetchFn
            }),
            (err) => {
                assert.ok(err instanceof SessionExpiredError);
                assert.match(err.message, /No session.json/);
                return true;
            }
        );
    });

    test('throws on non-JSON non-HTML response', async () => {
        const fetchFn = createMockFetch({
            status: 500,
            body: 'Internal Server Error',
            contentType: 'text/plain'
        });

        await assert.rejects(
            () => createAffiliateLink(['https://x'], 't', { sessionPath: FIXTURE_SESSION, fetchFn }),
            /Unexpected non-JSON response/
        );
    });

    test('throws on unexpected response shape (missing urls field)', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: { status: 'ok', wrong_field: [] }
        });

        await assert.rejects(
            () => createAffiliateLink(['https://x'], 't', { sessionPath: FIXTURE_SESSION, fetchFn }),
            /Unexpected response shape/
        );
    });
});

describe('createAffiliateLink – request construction', () => {
    test('sends POST to the correct endpoint', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: { status: 200, urls: [], total_items: 0, total_success: 0, total_error: 0 }
        });

        await createAffiliateLink(['https://x'], 't', { sessionPath: FIXTURE_SESSION, fetchFn });

        assert.equal(fetchFn.calls.length, 1);
        assert.equal(
            fetchFn.calls[0].url,
            'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink'
        );
        assert.equal(fetchFn.calls[0].options.method, 'POST');
    });

    test('includes CSRF token and cookie header from session file', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: { status: 200, urls: [], total_items: 0, total_success: 0, total_error: 0 }
        });

        await createAffiliateLink(['https://x'], 't', { sessionPath: FIXTURE_SESSION, fetchFn });

        const headers = fetchFn.calls[0].options.headers;
        assert.equal(headers['x-csrf-token'], 'test-csrf-token');
        assert.equal(headers['cookie'], 'test_cookie=test_value; ssid=test_ssid');
        assert.equal(headers['user-agent'], 'Mozilla/5.0 Test');
        assert.equal(headers['content-type'], 'application/json');
        assert.equal(headers['referer'], 'https://www.mercadolivre.com.br/afiliados/linkbuilder');
    });

    test('serializes urls and tag into the request body', async () => {
        const fetchFn = createMockFetch({
            status: 200,
            body: { status: 200, urls: [], total_items: 0, total_success: 0, total_error: 0 }
        });

        await createAffiliateLink(
            ['https://a', 'https://b'],
            'mytag',
            { sessionPath: FIXTURE_SESSION, fetchFn }
        );

        const body = JSON.parse(fetchFn.calls[0].options.body);
        assert.deepEqual(body, { urls: ['https://a', 'https://b'], tag: 'mytag' });
    });
});
