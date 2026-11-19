# Wallapop MCP Server

Hybrid, unofficial MCP server for the Wallapop marketplace, built in TypeScript.

- **HTTP primary**: reverse-engineered calls to the private `api.wallapop.com` v3 endpoints
- **SSR fallback**: `__NEXT_DATA__` scraping of `es.wallapop.com` pages (item details, seller profiles)
- **Playwright fallback**: off-screen headed browser as last resort (Wallapop's CDN blocks headless Chrome)
- **Authentication**: optional email/password or browser-cookie import for favorites, saved searches, chat and offers (token refresh + session persistence)

> Unofficial and unaffiliated. Uses Wallapop's undocumented API, which can change or block traffic at any time — use at your own risk, keep request volume low, and respect their Terms of Service.

## Tools

| Tool | Auth | Description |
|---|---|---|
| `search_products` | – | Keyword search with category / price / location / radius / sort filters, cursor pagination (`nextPage`), reserved items filtered out |
| `scan_products` | – | Multi-query keyword scan with dedupe, price filtering and scam-flagging (shippable listings) |
| `get_listing` | – | Full listing detail: description, condition, price, images, views, favorites, seller, shipping |
| `get_seller` | – | Seller profile by id or web slug: rating (0–100), sold/published counts, registration date, location |
| `list_categories` | – | Marketplace category tree with ids |
| `server_status` | – | Health / auth / browser-fallback status (session file, browser profile, pending login) |
| `login_start` | credentials | Step 1 of the Keycloak login: types email/password in the persistent browser profile and returns `otp_required` when Wallapop sends the SMS code (or `authenticated` if the profile is already logged in). `dryRun: true` only checks the flow |
| `login_submit_code` | credentials | Step 2: submits the SMS code and saves the session |
| `login_status` / `login_cancel` | credentials | Check / abort a pending login (never sends an SMS) |
| `import_session_cookies` | credentials | Import a cookies JSON exported from a logged-in browser and validate it |
| `refresh_session` | required | Refresh the stored session via the web session endpoint (never logs in) |
| `favorite_listing` / `unfavorite_listing` | required | Favorites by numeric id, web slug or item URL (API + browser fallback) |
| `get_saved_searches` / `create_saved_search` / `delete_saved_search` | required | Saved search alerts |
| `list_conversations` | required | Chat inbox: other user, item, unread count, last message |
| `get_messages` | required | Full message history of a conversation |
| `send_message` | required | Send a chat message (real-time channel) |
| `make_offer` | required | Send a purchase offer (EUR) — seller gets it in chat and can accept/reject. Blocks in-person-only listings outside your pickup radius and reports the real total (offer + Wallapop protection + shipping) |

## Quick start

```bash
git clone <this-repo>
cd WallpopMCP
npm install
npm run build
cp .env.example .env   # fill in your keys (see Configuration)
npm run smoke          # live sanity check against the API
```

### Connect to an MCP client

```bash
# Claude Code (stdio)
claude mcp add wallapop -- node /absolute/path/to/WallpopMCP/dist/index.js
```

```bash
# Inspector (browse tools interactively)
npm run inspector
```

## Configuration (`.env`, see `.env.example`)

| Variable | Purpose |
|---|---|
| `WALLAPOP_EMAIL` / `WALLAPOP_PASSWORD` | Enable auth tools (favorites, saved searches, chat, offers) |
| `WALLAPOP_COOKIES_FILE` | Optional JSON array of browser cookies (`[{ name, value }]`) exported from a logged-in session — the most reliable authenticated path |
| `WALLAPOP_DEFAULT_LAT` / `LNG` / `DISTANCE_KM` | Default search location (Barcelona center) |
| `WALLAPOP_SESSION_FILE` | Token/cookie persistence (default `./wallapop-session.json`, gitignored) |
| `WALLAPOP_RATE_DELAY_MS` | Min delay between API calls (default 600) |
| `WALLAPOP_MAX_RESULTS` | Search results cap, 1–200 (default 200) |
| `WALLAPOP_PICKUP_LAT` / `LNG` / `RADIUS_KM` | Your pickup location — `make_offer` refuses in-person-only listings outside this radius |
| `WALLAPOP_PROTECTION_PCT` / `WALLAPOP_SHIPPING_FEE_EUR` | Wallapop protection fee % (≈8–10) and shipping fee (≈3–5) used to report the real total of an offer |
| `WALLAPOP_BROWSER` | `auto` (default) \| `chrome` \| `msedge` \| `chromium` \| `off` |
| `WALLAPOP_BROWSER_PROFILE` | Persistent Chrome profile dir (default: `wallapop-browser` next to the session file; absolute, independent of the working directory) |
| `WALLAPOP_AUTO_LOGIN` | `0` (default) \| `1` — legacy automatic API login on each authenticated call (endpoint removed by Wallapop; keep off) |

> Values containing `#` must be quoted (`WALLAPOP_PASSWORD='abc#123'`): dotenv treats an unquoted `#` as a comment and truncates the value. The server prints a warning at startup if it detects this.

> Note: Wallapop's login is now Keycloak (`accounts.wallapop.com`, realm `wallapop-internal`) with an SMS verification code. Use `login_start` → `login_submit_code` (see below), or export cookies from a logged-in browser into `WALLAPOP_COOKIES_FILE` / `import_session_cookies`.

## How it works

### Search (two-step API flow)
1. `GET /api/v3/search/components` → `search_id`
2. `GET /api/v3/search/section` (40 items/page) → `meta.next_page` JWT; the server packs `search_id` + cursor into an opaque `nextPage` token so clients just pass it back.

### Chat & offers
- Messages are sent through the real-time channel (PubNub) and also land in the inbox API (`/bff/messaging/inbox`) — both verified end-to-end.
- Offers are created via `POST /api/v3/delivery/buyer/offers` with a client-generated offer id; sellers receive them in the conversation.

### Authentication (Keycloak + SMS, two steps)
The old `POST /api/v3/access/login` endpoint is gone (it answers `400` with an empty body). The web app now signs in with NextAuth + Keycloak and asks for an SMS code, so login is an explicit two-step flow driven by the MCP client:

1. `login_start` — opens `es.wallapop.com/auth/onboarding` in the persistent off-screen Chrome profile, accepts the cookie banner, clicks *Iniciar sesión con email*, types the credentials on the Keycloak page (human-like typing) and submits once (click on the `walla-button` submit, falling back to Enter / `form.requestSubmit()` only if no POST was observed). It returns `otp_required` as soon as the SMS screen appears (or `authenticated` if the profile was already logged in — no SMS). Each step has its own timeout and the whole call stays under ~50 s; errors name the failing step and include the Keycloak error text and a reCAPTCHA diagnostic.
2. `login_submit_code { code }` — types the SMS code into the pending page, waits for the redirect back to Wallapop, reads `/api/auth/session` and saves cookies (+ access token if exposed) to `WALLAPOP_SESSION_FILE` (mode 600).

Authenticated tools never trigger a login by themselves (that would send an SMS on every call). Expired tokens are refreshed through `GET es.wallapop.com/api/auth/session` with the stored NextAuth cookies, or from the persistent browser profile. Do not call `login_start` repeatedly: each real attempt can send a new SMS.

### Fallback chain
1. API request with browser-like headers, UA rotation, exponential back-off on 429, and `X-Signature` retry on 403
2. SSR HTML scraping (`es.wallapop.com/item/...`, `/user/...`) — richer data for sellers (ratings, counters)
3. Off-screen headed Chrome via Playwright (needs an X display on Linux; the server picks one from `/tmp/.X11-unix` if `DISPLAY` is unset, and closes Chrome when the MCP client disconnects) (captures `api.wallapop.com` XHR responses) — Wallapop's CDN blocks headless mode, so never use `WALLAPOP_BROWSER=chromium` without manual browser downloads; `auto` prefers installed Chrome/Edge

### Notes and known limits
- `search_products` price filtering (`minPrice`/`maxPrice`) and radius filtering (`distance_in_km`) are API-side parameters.
- `favorite_listing`/`unfavorite_listing` use best-effort endpoint candidates — verify with your account; endpoints change.
- Item `condition` is only reliably available via `get_listing` (search results usually omit it).
- Some sellers disable offers — `make_offer` surfaces a 409 error in that case.
## License

MIT � see [LICENSE](LICENSE). Unofficial project, not affiliated with or endorsed by Wallapop.

