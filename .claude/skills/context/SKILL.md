---
name: context
description: Verion Shop project context — architecture, modules, money-flow rules, deploy, testing approach, security rules and open decisions. Load at the start of any work on this repository, or when the user types /context.
---

# Verion Shop — project context

Verion Shop (verionshop.uz) is a Telegram Mini App store for Uzbekistan. It sells:
- game top-ups;
- Telegram Stars, Premium and gifts;
- SMM services ("nakrutka");
- Steam wallet top-ups;
- virtual numbers;
- digital goods;
- Skins store: CS2, Dota 2 and Rust.

Prices are in so'm. Customers pay into an in-app balance with Humo or Uzcard card transfers, matched automatically from bank SMS.

## Working with this user

- **Language:** write to the user in Uzbek (Latin script), short and plain. The user is not a developer. Their phone UI is in Russian, so when pointing at app or settings menus, give the Russian label as well.
- **Finish what you start:** test it, take screenshots, push, and confirm the deploy. The user wants complete results, not partial drafts. Send screenshots with `SendUserFile` after visual changes.
- **Branches:**
  - Work directly on `main`; this is a standing permission.
  - Push every commit to `main` and also to the working branch: `git push origin main` and then `git push origin main:claude/nimalar-qila-olaman-7d9a7l`.
  - Do not open pull requests.
- **Commit trailers:** end every commit message with the `Co-Authored-By` and `Claude-Session` lines from the session's system reminder.

## Security rules (hard rules)

- **API keys and tokens:** never ask the user to paste them into chat. They go only into the admin panel or Railway Variables. If the user pastes one anyway, advise revoking it and do not use it.
- **No automated crypto wallets:** no wallet seed or private key on the server, and no automatic top-ups or transfers from a wallet. This was declined earlier because transfers are irreversible.
- **Admin alert wording:** alerts that mention supplier balances must not use crypto terms (TON, USDT, gas). Say "coin" instead.
- **Customer API responses:** never leak internal fields such as supplier or line, cost, raw supplier responses, trade tokens or purchase ids. Every customer response goes through `pubOrder()` or `pubPayment()`, which are whitelists in `server.js` (`ORDER_PUB`). A new product type adds its own small public subset there.
- **Request handling:**
  - Request bodies go through `readBody()`, which accepts objects only and has size limits.
  - Handlers run inside `runSafe()`.
  - Customer endpoints check `auth(req)` (signed Telegram initData in the `X-Init-Data` header). Admin endpoints check `isAdm(auth(req))`.
- **Outbound URLs:** external URLs that the server fetches or redirects to must be validated. Examples: the `internalHost()` guard in `games.js`, and the CS2 inspect redirect, which only redirects to links the server itself stored.

## Architecture

Node 22 with no framework and almost no dependencies. Railway runs `node server.js`.

| File | Role |
|---|---|
| `server.js` | HTTP server, auth, balance and payments, catalog, orders, admin API, Telegram bot, readiness, finance, line watcher. `BUILD` constant at the top. |
| `verion-shop.html` | The whole client: one file holding HTML, CSS and JS, plus the admin panel. `CLIENT_BUILD` constant. |
| `db.js` | Storage in `node:sqlite` with diff-based save into `DATA_DIR` (a Railway volume at `/data`). |
| `games.js` | Games shop: games, packages, supplier "lines", fulfilment with an `INFLIGHT` lock and status polling. |
| `lines.js` | Supplier adapters: MooGold, G2Bulk, Smile.one, Ludovex and others. |
| `extra.js` | Steam wallet (via Ludovex, or manual) and virtual numbers (5sim). |
| `smm.js` | SMM panels (JAP and others) for nakrutka. |
| `ai.js` | AI support assistant (Claude or Gemini). Has operator hours and a queue. |
| `adminbot.js` | Separate Telegram admin bot: alerts, finance, actions. |
| `cs2.js` | Skins store (CS2, Dota 2, Rust) through the lis-skins.com API (details below). |
| `userbot/userbot_sms.py` | Reads bank SMS so card top-ups are confirmed automatically. |

Modules receive a `ctx` from `server.js` and expose `handle(req, res, url, m, q)`, which returns `true` when it handled the request. See the `GAMES`, `EXTRA` and `CS2` setup in `server.js`.

On every user-visible release, bump both `BUILD` (in `server.js`) and `CLIENT_BUILD` (in `verion-shop.html`) to the same value, formatted `YYYY-MM-DD.N`.

### Money-flow invariants (keep these in every new product)

1. **Reserve first, then call out.** Deduct the balance and create the order (`status: "pending"`) before calling the supplier. Use the order id as the supplier's idempotency key (`custom_id`) so a retry can never buy twice.
2. **A definite rejection refunds immediately.** This covers 4xx responses, "not enough funds" and "sold out".
3. **An unknown result keeps the money reserved.** This covers timeouts, 5xx and unparseable responses. Resolve the order later through the supplier's status endpoint. Refund only after it is confirmed not bought, or not found after a timeout.
4. **Refunds are idempotent.** A refund helper runs only while `status === "pending"`. An admin cancel through `adminOrderAction` also refunds once, and later supplier updates must not change a cancelled order.
5. **Credit bonuses once.** When an order completes, call `creditReferralOnOrder` and `creditLoyaltyOnOrder` once, then `notifyOrderChannel`.
6. **Add new products to readiness.** Each new product type gets an item in `computeReadiness()` (levels: `must` = 3, `test` = 2, `should` = 1). It also gets a "test purchase" (`t_*`) item, and its supplier balance goes into `allLineBalances()` so the 20-minute line watcher can alert.

## Skins store (`cs2.js` and the `.sk` / `sk*` code in `verion-shop.html`)

### lis-skins API
Full docs are public at `lis-skins.stoplight.io` (Stoplight project id 288247; node JSON via `https://lis-skins.stoplight.io/api/v1/projects/cHJqOjI4ODI0Nw/nodes/<slug>`). Base `https://api.lis-skins.com/v1/`, header `Authorization: Bearer <key>`. Key and lis-skins User ID are set in Admin → «Skinlar do'koni». The account is funded.

| Endpoint | Used for |
|---|---|
| `GET market/search` | `game` (csgo/dota2/rust), `names[]`, `price_from/to` (admin min/max always sent), `float_from/to`, `only_unlocked`, `unlock_days[]` (0–8), `sort_by` (oldest/newest/lowest_price/highest_price), `cursor` |
| `GET market/check-availability` | `ids[]` → `{available_skins:{id:price}, unavailable_skin_ids}`; called in `buy()` before money is reserved |
| `POST market/buy` | `{ids, partner, token, max_price, custom_id, skip_unavailable}`; 400 errors: custom_id_already_exists, skins_unavailable, skins_price_higher_than_max_price, insufficient_funds, invalid_trade_url, user_trade_ban, user_cant_trade, private_inventory, too_many_failed_attempts_for_user; 422 invalid_*_value |
| `GET market/info` | `custom_ids[]`, `purchase_ids[]` (max 200) |
| `GET market/history` | `page`, `start_unix_time`, `end_unix_time`; admin «Xaridlar tarixi» |
| `POST market/withdraw` / `withdraw-all` | send unlocked (wait_withdraw) skins, optional new `partner/token`; must happen within 12 h |
| `POST market/return` | return a `wait_unlock` purchase; lis charges 3% (we keep 3% from the customer refund) |
| `GET user/balance`, `GET user/get-ws-token` | balance; Centrifugo token |

- Skin statuses: `processing`, `wait_accept`, `accepted`, `return`, `wait_unlock`, `wait_withdraw` → our `o.cs2.state`: sent, accept, done, (refund), locked, withdraw (`ST_MAP`, `stateOf`, `settle`). Unknown words fall back to `stateWord()` and alert the admin once.
- Skin fields stored by `applySkin`: `st`, `tradeId` (steam_trade_offer_id), `expiry`, `unlockAt`, `err` (error enum), `rr` (return_reason enum), `fee`. `pubOrder` exposes these (never partner/token/purchaseId/usd).
- Search item extras: `item_class_id` (image fallback `economy/image/class/<appid>/<id>/360fx360f`), `delivery_type` (2 = up to 12 h), `stickers[].image`, Dota `gems[]` and `styles{}`. Image hosts allowed: `*.steamstatic.com`, `steamcdn-a.akamaihd.net`, `lis-skins.com`.
- Rate limit 200/min (buy 500/min); 429 + `retry-after` sets `coolUntil` and pauses searches.
- WebSocket: Centrifugo JSON protocol over Node 22 global `WebSocket` (`wss://ws.lis-skins.com/connection/websocket`): connect with token, subscribe `public:obtained-skins` (events obtained_skin_added / _deleted / _price_changed → `LIVE`, `GONE`, `of.live`) and `private:purchase-skins#<userId>` (purchase_skin_info_updated, matched by skin id = `o.cs2.offerId`). Ping `{}` → pong `{}`; reconnect with backoff; polling stays as fallback.
- JSON price lists: `https://lis-skins.com/market_export_json/{csgo|dota2|rust}.json` (short) and `api_{game}_full.json`.

### Games
- `GAMES` in `cs2.js`: `cs2` (lis `csgo`, appid 730), `dota2` (570), `rust` (252490). Every `/api/cs2/*` endpoint takes `game` (default `cs2`).
- `ready(g)` = master `enabled` + API key + `games[g]`. Settings: `settings.cs2.games` (default only `cs2`) and `settings.cs2.pricesUrls[g]`.
- `/api/me` returns `skins: {cs2, dota2, rust}` (and legacy `cs2` = any open). Orders keep `cs2.game`; `itemId` is `cs2:` or `g:`.
- Favorites `acc.cs2Fav`: CS2 keys are plain names, others `game|name`.

### Steam login (OpenID 2.0)
- `POST /api/steam/link-start` → Steam `checkid_setup` URL with `return_to = <appOrigin>/api/steam/return?n=<one-time key>` (15 min, single use; `LINKS` map). `appOrigin` = `STEAM_RETURN_BASE` env or `ctx.appUrl()` (= `publicBase()`).
- `GET /api/steam/return` checks mode, op_endpoint, exact return_to, claimed_id `https://steamcommunity.com/openid/id/7656119…`, then POSTs `check_authentication` to Steam (`is_valid:true`). Saves `acc.steam = {id, name, avatar, privacy, tradeBan, vac}` (profile from `https://steamcommunity.com/profiles/<id>/?xml=1`). Answers a small HTML page (CSP, escaped).
- Trade URL ownership: `partner` must equal `steamid64 − 76561197960265728` (`accountIdOf`) when `acc.steam` exists; checked on save and in `buy()`. `POST /api/steam/unlink`, `POST /api/steam/refresh` (once a minute).
- Test env: `STEAM_OPENID_URL`, `STEAM_PROFILE_URL`, `STEAM_RETURN_BASE`.
- Client: Steam card in the store profile (`skSteamLink`, `skSteamWait` polls `/api/cs2` and listens to `visibilitychange`). Telegram BackButton: `skBack` / `skBackOn` (sheet → modal → item page → home tab → close).

### Catalog and prices
- **CS2 catalog:** ByMykel CSGO-API `skins_not_grouped.json` (about 21k variants, grouped into about 1,974 skins). Cached in `DATA_DIR/cs2-catalog.json`, refreshed weekly, format version `CAT_V`.
- **Dota 2 / Rust catalog:** crawled from the Steam market (`/market/search/render/?appid=&norender=1&count=100&start=&sort_column=popular`), slow on purpose (`STEAM_DELAY_MS`, default 4 s; 40 / 30 pages). `dotaMeta(type)` reads rarity and category from the Steam `type`; `rustMeta(name, type)` guesses the category by keyword. Files `skins-dota2.json` / `skins-rust.json`; refreshed weekly only while that game is enabled. A failed crawl keeps the old catalog and shows the error in admin.
- Only `*.steamstatic.com` image URLs are accepted.
- **"From" prices:** a lis-skins JSON price list per game. Admin field per game: «Narxlar ro'yxati havolasi». The real URL is still unknown; it is in the lis-skins docs section "JSON Price Lists" (lis-skins.stoplight.io).
- **Fallback without a price list:** prices come from search. The UI then hides the price, wear and type filters and the sort list.

### Pricing and safeguards
- **Price:** `ceil(usd × rate × (1 + markup%) / 100) × 100` so'm. Rate, markup and min/max USD are set in the admin panel.
- **Request budget** for lis-skins calls that miss the cache: 150 per minute in total and 20 per minute per customer. Over the limit the server returns HTTP 429.
- **Shown offers only:** offers the customer was shown are remembered in `OFFERS` (15 minutes), and a purchase is allowed only for those offers. `max_price` is set to the price the customer saw.

### Client
- **Separate in-app store** `#sk` (class `.sk`, z-index 92), always dark; fonts Unbounded + Inter Tight loaded lazily; accent `#ffb81c`, prices green. Sheets use `.sheet.sks`.
- **Entry:** `[data-cs2open="cs2|dota2|rust"]` product cards, shown per `ME.skins`. `openCs2(el, game)` expands a `.sk-fx` layer from the tapped card's rect, then shows the store (skipped under reduced motion).
- **Tabs:** `skTab("home"|"market"|"orders"|"profile")` with bottom nav. Item page `.sk-page` slides in; confirm / done are centered `.sk-modal` dialogs inside `#sk`.
- **State and functions:** state in `SK`. Main functions: `skHome`, `skMarket`, `skLoad`, `skPaint`, `skCard`, `skOfferCard`, `skOpenItem`, `skItemPaint`, `skConfirm`, `skModalAct`, `skDone`, `skOrders`, `skProfile`, `skFilterSheet`, `skHelpSheet`, `skTradeSheet`. One delegated click handler: `skClick`.
- **Admin:** `openAdminCs2` — per-game toggles `#skOn_<g>`, catalog status `#skSt_<g>`, price URL `#skPu_<g>`, refresh `[data-skcat2]`.

### Design reference
The user likes skinsavdo.uz (an Uzbek CS2 skins market). Take ideas only, not their branding, yellow `#fbd506`, logo or text.

## Deploy

- Railway auto-deploys `main`.
- Check the result through the public GitHub API: `https://api.github.com/repos/shaxavipp/verionshoporg/commits/<sha>/status`.
  - Wait for context **`Verionshop - verionshoporg`** to show `success`.
  - Ignore `Verionshop - autotolov`, which is another service.

## Testing approach

The test scripts from earlier sessions lived in the session scratchpad and are **not in the repo**, so recreate what you need. The pattern:

- **Start the server:** run it with `BOT_TOKEN=123456:TEST_DUMMY_TOKEN`, `PORT=…` and `DATA_DIR=<temp dir>`. Stub Telegram by monkey-patching `https.request` for `api.telegram.org`.
- **Authenticate:** sign `initData` exactly like Telegram does. The secret is HMAC-SHA256 with key `"WebAppData"` over the bot token; the hash is HMAC of the sorted `k=v\n` data. Send it in the `X-Init-Data` header. The default `ADMIN_IDS` in `server.js` are the admins.
- **Fake suppliers:** run local HTTP servers and point the env base URLs at them:
  - `LIS_BASE`, `CS2_DATA_URL`, `LIS_PRICES_URL` (CS2), `LIS_PRICES_URL_DOTA2`, `LIS_PRICES_URL_RUST`;
  - `STEAM_MARKET_URL`, `STEAM_DELAY_MS`, `STEAM_PAGES_DOTA2`, `STEAM_PAGES_RUST` (Dota 2 / Rust catalog crawl);
  - `LIS_WS_URL`, `LIS_WS_RETRY_MS`, `LIS_WS_DELAY_MS`, `LIS_WS_CHECK_MS` (fake Centrifugo; the `ws` npm package works for a test server);
  - `LUDOVEX_BASE`, `FIVESIM_BASE`.
- **Speed up polling:** set `CS2_POLL_MS`, `CS2_UNKNOWN_MS`, `CS2_BUY_TIMEOUT`, `EXTRA_POLL_MS`, `GAMES_POLL_MS` and `LINE_WATCH_MS`.
- **Money-flow tests to write:** success; sold out; insufficient funds; bad key; 5xx (unknown result, then refund); timeout (unknown, then found by `custom_id`); two buys at the same moment; refund only once after an admin cancel; IDOR checks; unauthenticated requests.
- **UI tests:**
  - Use Playwright, which is preinstalled; `require('playwright')` works.
  - Stub `window.Telegram.WebApp` (`initData`, `openLink`, `HapticFeedback`, …) in `addInitScript`.
  - Use a 400×860 viewport with `deviceScaleFactor` 2.
  - Steam CDN images are blocked in the sandbox, so route `steamstatic.com` to a placeholder SVG.
- **Regression:** run the full regression before each push.

## Network in this environment

- Many hosts are blocked by the environment allowlist, which the user edits under Environment → «Доступ к сети».
- Allowed now: `skinsavdo.uz`, `www.skinsavdo.uz`, `api.skinsavdo.uz`.
- Allowed too: `lis-skins.stoplight.io` (docs).
- Blocked: `lis-skins.com`, `api.lis-skins.com`, Steam CDN (`community.akamai.steamstatic.com`, `community.cloudflare.steamstatic.com`) and `steamcommunity.com`. Ask the user to allow them if real skin images are needed in screenshots.
- Reachable: PyPI, `raw.githubusercontent.com`, `api.github.com` (public).

## Open decisions and next steps (as of 2026-10-31)

- **NFT rentals via MarketApp:** waiting for the user to choose:
  - A — manual, which is recommended;
  - B — automated with a small dedicated wallet and limits;
  - C — postpone.

  The MarketApp rent API returns a TON transaction that our wallet must sign.
- **lis-skins price list URL:** known now (see above) and tried automatically; check the admin diagnostics after deploy.
- **Steam login:** agreed to do later.
  - Phase 1: done (see «Steam login» above).
  - Phase 2 (separate decision): customers sell skins to us. This needs a Steam bot account and an 8-day hold because of Steam's 7-day trade reversal.
- **Later ideas:** Click/Payme, onboarding, a proof channel.
