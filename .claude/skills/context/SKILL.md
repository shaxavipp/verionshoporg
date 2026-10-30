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
- CS2 skins.

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
| `cs2.js` | CS2 skins store through the lis-skins.com API (details below). |
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

## CS2 store (`cs2.js` and the `.c2` / `c2*` code in `verion-shop.html`)

### lis-skins API
Base `https://api.lis-skins.com/v1/` with header `Authorization: Bearer <key>`. The key is set in Admin → «CS2 skinlar». The lis-skins account needed a $100 deposit to unlock the API, and it is funded.

| Endpoint | Used for | Notes |
|---|---|---|
| `GET market/search` | Search | Params: `game=csgo`, `names[]`, `price_from`/`price_to`, `only_unlocked`, `sort_by` (`lowest_price`, `highest_price`, `newest`, `oldest`), `cursor` (paging via `meta.next_cursor`) |
| `POST market/buy` | Purchase | Body: `{ids, partner, token, max_price, custom_id}` |
| `GET market/info` | Purchase status | Params: `custom_ids[]`, `purchase_ids[]` |
| `GET user/balance` | Balance check | |

Real `market/search` item fields:
- `id`;
- `name` (the market hash name);
- `price` — USD as a number; it can be `0`, and such items are skipped;
- `unlock_at`;
- `item_float` — a string;
- `item_link` — `steam://run/730//+csgo_econ_action_preview…`;
- `name_tag`, `item_paint_seed`, `stickers[]`;
- `created_at`, `item_asset_id`, `delivery_type`, `is_internal`.

The purchase status words are not documented. `stateWord()` matches them broadly. An unrecognised word keeps the order pending and alerts the admin once. When that alert arrives, add the new word to `stateWord()`.

### Catalog and prices
- **Catalog:** comes from ByMykel CSGO-API `skins_not_grouped.json` (about 21k variants, grouped into about 1,974 skins). It is cached in `DATA_DIR/cs2-catalog.json`, refreshed weekly, with format version `CAT_V`. Only `*.steamstatic.com` image URLs are accepted.
- **"From" prices:** come from a lis-skins JSON price list. Admin field: «Narxlar ro'yxati havolasi». The real URL is still unknown; it is in the lis-skins docs section "JSON Price Lists" (lis-skins.stoplight.io).
- **Fallback without a price list:** prices come from search. The UI then hides the price, wear and type filters and the sort list.

### Pricing and safeguards
- **Price:** `ceil(usd × rate × (1 + markup%) / 100) × 100` so'm. Rate, markup and min/max USD are set in the admin panel.
- **Request budget** for lis-skins calls that miss the cache: 150 per minute in total and 20 per minute per customer. Over the limit the server returns HTTP 429.
- **Shown offers only:** offers the customer was shown are remembered in `OFFERS` (15 minutes), and a purchase is allowed only for those offers. `max_price` is set to the price the customer saw.

### Client
- **Overlay:** `#c2`, a dark theme with accent `#f0a030`. The Oxanium display font is loaded lazily. Sheets use the `.sheet.c2s` class.
- **State and functions:** state lives in the `C2` object. Main functions: `openCs2`, `c2Load`, `c2Paint`, `c2Card`, `c2OpenItem`, `c2Confirm`, `c2FilterSheet`, `c2HelpSheet`, `c2TradeSheet`.
- **Entry point:** `[data-cs2open]`, shown only when `/api/me` returns `cs2: true`.
- **Features:**
  - hero block;
  - filters: favorites, price, wear, rarity, type, ★;
  - favorites stored as `acc.cs2Fav`;
  - "Yaqinda sotib olindi" feed;
  - quick buy;
  - inspect link;
  - help FAQ.

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
  - `LIS_BASE`, `CS2_DATA_URL`, `LIS_PRICES_URL` (CS2);
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
- Blocked: `lis-skins.com`, `lis-skins.stoplight.io`, Steam CDN.
- Reachable: PyPI, `raw.githubusercontent.com`, `api.github.com` (public).

## Open decisions and next steps (as of 2026-10-31)

- **NFT rentals via MarketApp:** waiting for the user to choose:
  - A — manual, which is recommended;
  - B — automated with a small dedicated wallet and limits;
  - C — postpone.

  The MarketApp rent API returns a TON transaction that our wallet must sign.
- **lis-skins price list URL:** the user should paste the "JSON Price Lists" link into the admin panel.
- **Steam login:** agreed to do later.
  - Phase 1: Steam OpenID login, which links a SteamID and verifies that the trade URL partner matches it.
  - Phase 2 (separate decision): customers sell skins to us. This needs a Steam bot account and an 8-day hold because of Steam's 7-day trade reversal.
- **Later ideas:** Dota 2 and Rust skins, Click/Payme, onboarding, a proof channel.
