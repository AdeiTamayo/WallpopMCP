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
| `server_status` | – | Health / auth / browser-fallback status |
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

> Note: `WALLAPOP_EMAIL`/`WALLAPOP_PASSWORD` may fail for accounts with MFA or Keycloak flows — in that case export cookies from a logged-in browser into `WALLAPOP_COOKIES_FILE` (a JSON array of cookie objects) and the server will use them directly.

## How it works

### Search (two-step API flow)
1. `GET /api/v3/search/components` → `search_id`
2. `GET /api/v3/search/section` (40 items/page) → `meta.next_page` JWT; the server packs `search_id` + cursor into an opaque `nextPage` token so clients just pass it back.

### Chat & offers
- Messages are sent through the real-time channel (PubNub) and also land in the inbox API (`/bff/messaging/inbox`) — both verified end-to-end.
- Offers are created via `POST /api/v3/delivery/buyer/offers` with a client-generated offer id; sellers receive them in the conversation.

### Authentication
- Tries `POST /api/v3/access/login` → stores access/refresh tokens + cookies to the session file, refreshes via `POST /api/v3/access/refresh` when the JWT is about to expire.
- Falls back to an automated browser login; MFA challenges are detected and surfaced as an error (complete it manually, then export cookies to `WALLAPOP_COOKIES_FILE`).

### Fallback chain
1. API request with browser-like headers, UA rotation, exponential back-off on 429, and `X-Signature` retry on 403
2. SSR HTML scraping (`es.wallapop.com/item/...`, `/user/...`) — richer data for sellers (ratings, counters)
3. Off-screen headed Chrome via Playwright (captures `api.wallapop.com` XHR responses) — Wallapop's CDN blocks headless mode, so never use `WALLAPOP_BROWSER=chromium` without manual browser downloads; `auto` prefers installed Chrome/Edge

### Notes and known limits
- `search_products` price filtering (`minPrice`/`maxPrice`) and radius filtering (`distance_in_km`) are API-side parameters.
- `favorite_listing`/`unfavorite_listing` use best-effort endpoint candidates — verify with your account; endpoints change.
- Item `condition` is only reliably available via `get_listing` (search results usually omit it).
- Some sellers disable offers — `make_offer` surfaces a 409 error in that case.
## License

MIT � see [LICENSE](LICENSE). Unofficial project, not affiliated with or endorsed by Wallapop.

