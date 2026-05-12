# Mercado Livre Affiliate Link Generator

An HTTP service that generates Mercado Livre affiliate links. Automates login with Puppeteer (stealth plugin + Gmail OTP), captures the session, and exposes a REST API that consumer apps call to generate affiliate links at scale.

## Architecture

```
┌──────────────────┐   session.json   ┌──────────────────┐   HTTP   ┌──────────────┐
│  Meli_Login.js   │ ───────────────→ │    server.js     │ ───────→ │  Your app    │
│  (one-time)      │                  │  (long-running)  │          │  (consumer)  │
│                  │                  │                  │ ←─────── │              │
│  Puppeteer +     │                  │  Express API     │          │              │
│  Gmail OTP       │                  │  + file cache    │          │              │
└──────────────────┘                  └──────────────────┘          └──────────────┘
          │                                      │
          └──────────── Mercado Livre ───────────┘
                    (login page + affiliate API)
```

Two separate processes:

- **`Meli_Login.js`** — run once (or when session expires). Logs into Mercado Livre using Puppeteer, pulls the OTP from Gmail, captures cookies and CSRF token into `session.json`.
- **`server.js`** — long-running HTTP server. Reads `session.json` and proxies requests to the Mercado Livre affiliate API with caching.

## Prerequisites

- Node.js 18+ (uses native `fetch` and `node:test`)
- macOS, Linux, or Windows with a display (Puppeteer launches a visible Chrome)
- A Gmail account that receives Mercado Livre OTP emails
- A Mercado Livre account with the affiliate program enabled

## Installation

```bash
npm install
```

This installs Puppeteer (downloads Chromium automatically), Express, googleapis, and other dependencies.

## Setup

### 1. Gmail API credentials — `credentials.json`

The login flow reads the OTP email via the Gmail API, so you need to create an OAuth client:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Enable the **Gmail API** for that project.
4. Go to **APIs & Services → OAuth consent screen** and configure it (Internal audience is easiest if you have a Workspace account, otherwise External with your Gmail added as a test user).
5. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
6. Choose **Desktop app** as the application type.
7. Download the JSON file and save it in the project root as `credentials.json`.

On first run, the script opens a browser to authorize access to your Gmail. Once authorized, a `token.json` is saved and you won't be prompted again.

### 2. Environment variables — `.env`

Create a `.env` file in the project root:

```bash
# Mercado Livre account
MELI_EMAIL=your_email@gmail.com
MELI_AFFILIATE_TAG=your_affiliate_tag

# Server config
PORT=3000
LOG_LEVEL=info                 # debug | info | warn | error

# Optional: require an API key on every request
# API_KEY=some-secret-string
```

### 3. Run the login flow — generates `session.json`

```bash
npm run login
```

What happens:

1. Gmail API authorization (first run only — opens a browser for OAuth consent).
2. A Chrome window opens and navigates to the Mercado Livre login page.
3. Your email is typed in automatically; the "Continuar" button is clicked.
4. "E-mail" is picked as the verification method.
5. The script polls your Gmail inbox for the OTP (up to ~45 seconds).
6. The OTP is typed and the login is completed.
7. The browser navigates to the affiliate linkbuilder page to capture the CSRF token.
8. Cookies and session metadata are saved to `session.json`.

**First run prompts you once for Gmail OAuth. Subsequent logins are fully unattended.**

### 4. Start the server

```bash
npm start
```

You should see:

```
[2026-05-07T01:00:00.000Z] INFO  Affiliate link server listening on http://localhost:3000
```

## Files generated/consumed

| File | Who writes it | Who reads it | Description |
|------|---------------|--------------|-------------|
| `.env` | you | both | config and secrets |
| `credentials.json` | you (from Google) | `Meli_Login.js` | Gmail API OAuth client |
| `token.json` | `Meli_Login.js` | `Meli_Login.js` | cached Gmail refresh token |
| `session.json` | `Meli_Login.js` | `server.js` | Mercado Livre cookies + CSRF token |
| `affiliate_cache.json` | `server.js` | `server.js` | URL → affiliate link cache |

## API

### `POST /affiliate-links`

Generate (or fetch from cache) affiliate links for one or more product URLs.

**Request**

```json
{
  "urls": [
    "https://www.mercadolivre.com.br/100-whey-pote-900g/p/MLB25427536",
    "https://www.mercadolivre.com.br/leite-italac-400g/p/MLB18310757"
  ],
  "tag": "oliveiradanilo20211125223941",
  "force": false
}
```

Fields:
- `urls` (required) — array of Mercado Livre product URLs
- `tag` (optional) — affiliate tag. Defaults to `MELI_AFFILIATE_TAG` from `.env`
- `force` (optional) — `true` to bypass the cache and regenerate links

**Response (200 — all or partial success)**

```json
{
  "total": 2,
  "success_count": 2,
  "error_count": 0,
  "results": [
    {
      "origin_url": "https://www.mercadolivre.com.br/100-whey-pote-900g/p/MLB25427536",
      "status": "success",
      "affiliate_link": "https://meli.la/34cPm1M",
      "tag": "oliveiradanilo20211125223941",
      "generated_at": "2026-05-07T01:06:23.000Z",
      "cached": false
    },
    { "...": "..." }
  ]
}
```

**Response (422 — all URLs failed)**

```json
{
  "total": 1,
  "success_count": 0,
  "error_count": 1,
  "results": [
    {
      "origin_url": "https://www.mercadolivre.com.br/invalid",
      "status": "error",
      "error_code": 111,
      "error_message": "URL not allowed in affiliates program"
    }
  ]
}
```

**Response (401 — session expired)**

```json
{
  "error": "session_expired",
  "message": "Mercado Livre returned 401. Session expired or CSRF invalid. Re-run Meli_Login.js.",
  "action": "Run `node Meli_Login.js` to re-authenticate."
}
```

Run `npm run login` again to refresh the session.

### `GET /affiliate-links`

Returns all cached links.

### `GET /health`

Returns server health and whether a session file is present.

```json
{ "status": "ok", "session_available": true }
```

### Optional API key

If `API_KEY` is set in `.env`, every request must include an `x-api-key` header with that value, otherwise the server responds 401.

## Example usage

```bash
curl -X POST http://localhost:3000/affiliate-links \
  -H 'content-type: application/json' \
  -d '{"urls":["https://www.mercadolivre.com.br/100-whey-pote-900g/p/MLB25427536"]}'
```

```javascript
// From your consumer app
const res = await fetch('http://localhost:3000/affiliate-links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
        urls: ['https://www.mercadolivre.com.br/.../p/MLB25427536']
    })
});
const { results } = await res.json();
const link = results[0].affiliate_link;
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run login` | Run the Puppeteer + Gmail OTP login flow to capture a session |
| `npm start` | Start the HTTP server |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run unit tests in watch mode |

## Troubleshooting

**`TimeoutError: waiting for selector` on login**
Mercado Livre may have updated the page. Run with the browser visible (already the default — `headless: false`), watch what happens, and adjust the selectors in `Meli_Login.js`.

**Captcha appears during login**
The stealth plugin usually dodges this, but if you hit a captcha, solve it manually in the visible browser — the script will continue once the page moves on. Repeated captchas usually mean Mercado Livre flagged your IP or user-agent.

**OTP not arriving**
Check that the Gmail OAuth scope is `gmail.readonly` and that the email is being sent to the Gmail account you authorized. The script looks for emails from `mercadolivre` or `mercadolibre` within the last hour.

**`session_expired` errors from the server**
The Mercado Livre `ssid` cookie typically lasts hours to a few days. Re-run `npm run login` whenever this happens. Automating re-login on expiry is possible but not built in.

**`URL not allowed in affiliates program` (error_code 111)**
The URL isn't a valid Mercado Livre product page. Make sure the URL has a product ID (like `.../p/MLB25427536`) and belongs to a category allowed by the affiliate program.

## Security notes

- `.env`, `credentials.json`, `token.json`, and `session.json` are all gitignored by default. Don't commit them.
- Anyone with your `session.json` can make authenticated requests as you until the session expires. Treat it like a password.
- If you expose the server outside localhost (e.g. via ngrok), always set `API_KEY` in `.env`.

## Project layout

```
.
├── Meli_Login.js            # Puppeteer + Gmail OTP login flow
├── createAffiliateLink.js   # Mercado Livre API client (used by server)
├── server.js                # Express HTTP API
├── test/
│   ├── fixtures/
│   │   └── session.json     # dummy session for tests
│   └── unit/
│       ├── createAffiliateLink.test.js
│       └── Meli_Login.test.js
├── package.json
├── .env                     # you create this
├── credentials.json         # you create this (Google OAuth client)
├── token.json               # auto-generated (Gmail refresh token)
├── session.json             # auto-generated (ML session)
└── affiliate_cache.json     # auto-generated (URL → link cache)
```
