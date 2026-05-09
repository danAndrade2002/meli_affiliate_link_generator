const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    extractOTP,
    getEmailBody,
    formatCookieHeader,
    filterRelevantCookies,
    pollGmailForOTP,
    RELEVANT_COOKIES
} = require('../../Meli_Login');

// Helper: encode string as base64 like Gmail API does
function b64(s) {
    return Buffer.from(s, 'utf-8').toString('base64');
}

describe('extractOTP', () => {
    test('extracts a 6-digit code from text', () => {
        assert.equal(extractOTP('Your code is 123456 please use it'), '123456');
    });

    test('returns null when no 6-digit code is present', () => {
        assert.equal(extractOTP('no codes here 12345 or 1234567'), null);
    });

    test('returns null for empty or null input', () => {
        assert.equal(extractOTP(''), null);
        assert.equal(extractOTP(null), null);
        assert.equal(extractOTP(undefined), null);
    });

    test('returns the first 6-digit code found', () => {
        assert.equal(extractOTP('First 111222 second 333444'), '111222');
    });

    test('matches 6-digit codes at word boundaries only', () => {
        // 7-digit or longer numbers should not match as 6-digit OTPs
        assert.equal(extractOTP('Order #1234567890'), null);
    });

    test('extracts OTP from multi-line Portuguese email body', () => {
        const body = 'Olá Danilo,\n\nSeu código de verificação é: 654321\n\nUse-o em até 10 minutos.';
        assert.equal(extractOTP(body), '654321');
    });
});

describe('getEmailBody', () => {
    test('extracts body from payload with direct body data', () => {
        const message = {
            payload: {
                body: { data: b64('Hello world') }
            }
        };
        assert.equal(getEmailBody(message), 'Hello world');
    });

    test('extracts body from single text/plain part', () => {
        const message = {
            payload: {
                parts: [
                    { mimeType: 'text/plain', body: { data: b64('Plain text') } }
                ]
            }
        };
        assert.equal(getEmailBody(message), 'Plain text');
    });

    test('concatenates multiple parts', () => {
        const message = {
            payload: {
                parts: [
                    { mimeType: 'text/plain', body: { data: b64('Part A ') } },
                    { mimeType: 'text/html', body: { data: b64('<p>Part B</p>') } }
                ]
            }
        };
        assert.equal(getEmailBody(message), 'Part A <p>Part B</p>');
    });

    test('handles nested multipart structures recursively', () => {
        const message = {
            payload: {
                parts: [{
                    mimeType: 'multipart/alternative',
                    parts: [
                        { mimeType: 'text/plain', body: { data: b64('nested plain') } },
                        { mimeType: 'text/html', body: { data: b64('nested html') } }
                    ]
                }]
            }
        };
        assert.equal(getEmailBody(message), 'nested plainnested html');
    });

    test('returns empty string when no body data present', () => {
        const message = { payload: { parts: [] } };
        assert.equal(getEmailBody(message), '');
    });

    test('handles missing parts gracefully', () => {
        const message = { payload: {} };
        assert.equal(getEmailBody(message), '');
    });
});

describe('formatCookieHeader', () => {
    test('joins cookies as name=value pairs with "; " separator', () => {
        const cookies = [
            { name: 'ssid', value: 'abc' },
            { name: 'csrf', value: 'xyz' }
        ];
        assert.equal(formatCookieHeader(cookies), 'ssid=abc; csrf=xyz');
    });

    test('returns empty string for empty cookie list', () => {
        assert.equal(formatCookieHeader([]), '');
    });

    test('handles a single cookie', () => {
        assert.equal(
            formatCookieHeader([{ name: 'only', value: 'one' }]),
            'only=one'
        );
    });
});

describe('filterRelevantCookies', () => {
    test('keeps only cookies whose names are in the relevant list', () => {
        const cookies = [
            { name: 'ssid', value: 'a' },
            { name: 'random_tracker', value: 'b' },
            { name: '_csrf', value: 'c' },
            { name: '_gcl_au', value: 'd' }
        ];
        const filtered = filterRelevantCookies(cookies);
        assert.deepEqual(
            filtered.map(c => c.name).sort(),
            ['_csrf', 'ssid']
        );
    });

    test('accepts a custom list of relevant names', () => {
        const cookies = [
            { name: 'foo', value: '1' },
            { name: 'bar', value: '2' }
        ];
        const filtered = filterRelevantCookies(cookies, ['bar']);
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'bar');
    });

    test('returns empty array when no cookies match', () => {
        const cookies = [{ name: 'irrelevant', value: 'x' }];
        assert.deepEqual(filterRelevantCookies(cookies), []);
    });

    test('RELEVANT_COOKIES contains the critical session identifiers', () => {
        assert.ok(RELEVANT_COOKIES.includes('ssid'));
        assert.ok(RELEVANT_COOKIES.includes('_csrf'));
        assert.ok(RELEVANT_COOKIES.includes('orguseridp'));
    });
});

describe('pollGmailForOTP', () => {
    /**
     * Builds a mock Gmail client with configurable list and get responses.
     */
    function mockGmail({ listResponses = [], getResponses = {} } = {}) {
        const calls = { list: 0, get: [] };
        return {
            users: {
                messages: {
                    list: async () => {
                        const resp = listResponses[calls.list] ?? listResponses[listResponses.length - 1] ?? { data: {} };
                        calls.list++;
                        return resp;
                    },
                    get: async ({ id }) => {
                        calls.get.push(id);
                        return getResponses[id] || { data: { payload: {} } };
                    }
                }
            },
            _calls: calls
        };
    }

    test('returns OTP as soon as one is found', async () => {
        const gmail = mockGmail({
            listResponses: [{ data: { messages: [{ id: 'msg1' }] } }],
            getResponses: {
                msg1: { data: { payload: { body: { data: Buffer.from('Code: 123456').toString('base64') } } } }
            }
        });

        const otp = await pollGmailForOTP(gmail, {
            maxAttempts: 1,
            delayMs: 0,
            sleep: async () => {}
        });

        assert.equal(otp, '123456');
        assert.equal(gmail._calls.list, 1);
    });

    test('retries when no messages exist initially', async () => {
        const gmail = mockGmail({
            listResponses: [
                { data: {} },
                { data: {} },
                { data: { messages: [{ id: 'msg1' }] } }
            ],
            getResponses: {
                msg1: { data: { payload: { body: { data: Buffer.from('Code 654321').toString('base64') } } } }
            }
        });

        const otp = await pollGmailForOTP(gmail, {
            maxAttempts: 5,
            delayMs: 0,
            sleep: async () => {}
        });

        assert.equal(otp, '654321');
        assert.equal(gmail._calls.list, 3);
    });

    test('throws after max attempts with no matching email', async () => {
        const gmail = mockGmail({ listResponses: [{ data: {} }] });

        await assert.rejects(
            () => pollGmailForOTP(gmail, {
                maxAttempts: 3,
                delayMs: 0,
                sleep: async () => {}
            }),
            /Could not find OTP email after 3 attempts/
        );
    });

    test('skips messages that do not contain an OTP and checks next', async () => {
        const gmail = mockGmail({
            listResponses: [{ data: { messages: [{ id: 'noise' }, { id: 'real' }] } }],
            getResponses: {
                noise: { data: { payload: { body: { data: Buffer.from('no code here').toString('base64') } } } },
                real:  { data: { payload: { body: { data: Buffer.from('OTP: 999888').toString('base64') } } } }
            }
        });

        const otp = await pollGmailForOTP(gmail, {
            maxAttempts: 1,
            delayMs: 0,
            sleep: async () => {}
        });

        assert.equal(otp, '999888');
        assert.deepEqual(gmail._calls.get, ['noise', 'real']);
    });

    test('uses the injected sleep function (not real setTimeout)', async () => {
        let sleepCalls = 0;
        const gmail = mockGmail({ listResponses: [{ data: {} }] });

        await assert.rejects(
            () => pollGmailForOTP(gmail, {
                maxAttempts: 4,
                delayMs: 9999,
                sleep: async () => { sleepCalls++; }
            })
        );

        assert.equal(sleepCalls, 4, 'sleep should be called once per attempt');
    });
});
