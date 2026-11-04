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
- **HTML headers:** the app page is served with HSTS, `Permissions-Policy`, `nosniff`, `Referrer-Policy` and a CSP that limits only `frame-ancestors` (self + `web.telegram.org` / `*.telegram.org`), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. Don't add script/img/connect restrictions without testing inline scripts, CDN skin images and Telegram Web.
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
| `extra.js` | Steam wallet (via Ludovex, or manual) and virtual numbers: TG-Lion (default; `?action=` API, getNumber/getCode, no cancel, code+2FA password, refresh 24h) or 5sim (SMS, cancel+refund). Admin `/api/admin/vnum`, `/vnum/test`, `/vnum/countries`. |
| `smm.js` | SMM panels (JAP and others) for nakrutka. |
| `ai.js` | AI support assistant (Claude or Gemini). Has operator hours and a queue. |
| `adminbot.js` | Separate Telegram admin bot: alerts, finance, actions. |
| `tgsupport.js` | Support Telegram account over MTProto (`teleproto`): phone/code/2FA login from the admin panel, incoming DMs go to the support inbox, AI and admins reply as that account. |
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
- **Dota 2 / Rust catalog:** `buildCatalog(g)` merges (1) the Steam market crawl `crawlSteam(g)` — Steam returns at most 10 results per request and 429s when hit fast, so it pages with `start += results.length` until `total_count`, waits `STEAM_429_MS` (90 s) on 429, saves `steam-<g>.json` (weekly, `catStale`) and rebuilds every 20 pages — with (2) every on-sale name from the lis-skins price list that Steam didn't return, imaged by `item_class_id` (`economy/image/class/<appid>/<id>/360fx360f`) and categorised by name (`dotaGuess`, `rustMeta`). A Steam failure only sets `C.warn`. Admin shows `steam`, `lisN`, `crawl` progress.
- **Price lists are stream-parsed** (`streamList`: scans array elements, `JSON.parse` per object; keeps the whole text only if < 30 MB). Lists > `LIS_BIG_BYTES` (20 MB) refresh every 30 min instead of 10; admin save forces a reload (`loadPrices(g, true)`).
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
- **Branding:** `SK_LOGO` = a fixed webp data URI: the splash logo's VER⚡ON top with «SKINS» underneath, drawn in the original «SHOP» style (Orbitron 900, stretched to the same letter width, same blue gradient). Used in the header, the entry fx and the faded card watermark (`.wm`, CSS var `--sklogo`). No bolt icon or text mark besides it. Game art: `skGimg(g)` / `skTile(g)` use `cdn.cloudflare.steamstatic.com/steam/apps/<appid>/header.jpg` with a monogram fallback.
- **Real images only (user rule: never hand-draw game/app images):** category chips use `SK.info.catImg` from `/api/cs2` → `catImgs(g)`: CS2 = base weapon renders (`CAT_REP` names → `base_weapons.json` from the same ByMykel source, cached in `cs2-base.json`, env `CS2_BASE_URL`), otherwise the rarest item image of that category. Weapon dropdown rows carry `img` (most popular skin of that weapon, from `weaponsOf`). Only «Hammasi»/«Jonli» keep UI icons.
- **Market extras:** CS2 category buttons carry ▾; tapping the active one toggles the weapon dropdown `#skWpn` (`SK.wOpen`). Item page shows «So'nggi sotuvlar» from `/api/cs2/item` → `sales` (last 8 of our done orders for that skin; no buyer data).
- **Languages:** store follows `S.lang`. Uzbek text stays in the code; RU/EN come from `SK_L` (exact strings) and `SK_TRX` (patterns with numbers/dates/amounts, Russian plurals via `skPl`, amounts via `skAmt`), split on « · » and trailing « ✕ ». `skTrOn(true)` in `openCs2` starts a `MutationObserver` that translates text nodes and placeholder / aria-label / title inside `.sk`, `.sheet.sks`, `.sk-fx` and `#toast` (only while `body.sk-open`); `closeCs2` stops it. In code use `_t(s)`; "from" prices use `skFromH`. When adding a new Uzbek string to the store, add its RU/EN line to `SK_L`. Admin stays Uzbek.
- **Steam login domain:** `siteBase()` in server.js returns `SITE_URL` (default `https://verionshop.uz`) only after `probeAppUrl` confirms it reaches a Verion Shop server (`app === "verion-shop"`; the instance id is NOT required — during a deploy the domain briefly hits the old container). First check 15 s after listen, retries every 30 s ×10 then every 5 min, 6 h when OK; `SITE.ip` = resolved IP for diagnostics. `ctx.siteRecheck()` backs admin `GET /api/admin/cs2?site=1` («Qayta tekshirish»). cs2.js `appOrigin()` uses `STEAM_RETURN_BASE` → `ctx.siteUrl()` → `ctx.appUrl()`; the base is stored per nonce in `LINKS` so the return check uses the same origin. Admin view field `site` (`?site=1` forces a recheck).
- **Admin:** `openAdminCs2` — per-game toggles `#skOn_<g>`, catalog status `#skSt_<g>`, price URL `#skPu_<g>`, refresh `[data-skcat2]`.

### Design system v3 (main app)
- Palette = Verion brand (v3.1, restored at the user's request because the logo and avatar use it): bg `#080a12`/`#0d1120`, cards `#131728`/`#1b2038`/`#242b4a`, text `#f3f6fd`, accent `#2f8fff`/`#8fc2ff`. Gradients: `--grad` (brand, `#0b57cf→#2f8fff→#8fc2ff`), `--grad-btn` (primary buttons, selected tabs, FAB, chat bubbles), `--grad-hero` (balance cards), `--grad-navy` (category icon chips), `--grad-gold`. `--shadow-acc` is a soft offset blue shadow under primary buttons. Light theme uses the old light brand tokens. Do NOT switch back to neutral grey: the user rejected it ("eski ranglar ... botimizning asosiy ajralib turishi"). Radius scale: `--r-xs 6` (badges) / `--r-sm 10` (chips, small controls, icon chips) / `--r 14` (buttons, inputs) / `--r-lg 20` (every panel and compact tile) / `--r-xl 24` (product/category cards, hero cards, banner) / `--r-sheet 28`. Type scale `--fs-*`: 11/12.5/13.5/15/17/20/24/30; inputs 16px (no iOS zoom). Heights: 34 small/header buttons, 36 pill tabs, 40 rect toggles, 48 inputs/search/buttons, 52 big buttons. Card grids have two sizes. Sections and groups (`.grid.groupgrid`, incl. home `.homecats`) are big: 2 cols, `.pcard` r-xl + 8 padding, `.ptile` 1:1 r16. Products (`.grid` without groupgrid) stay at the OLD small size: 3 cols, square tile r14, name 13px + price below, no card box. The user explicitly asked: products smaller than sections, don't touch product size. All grids use `repeat(n,minmax(0,1fr))` so long text can't widen a column. Keep new CSS on these tokens; don't add one-off px radii or font sizes. Motion: `--spring`, `--ease`, 150–360 ms. No strong glow, no infinite idle animations (the splash bolt flash is the one brand exception).
- Font: Onest, self-hosted from `fonts/` (OFL) through the server route `GET /fonts/<name>.woff2` (name checked by regex). Numbers use `tabular-nums`. Inter was dropped because the impeccable detector flags it as an overused "AI" font.
- Icons: Lucide (ISC) in `ICON`/`IC` (stroke 1.75) and `SK_I` (skins store, stroke 2). Don't hand-draw new icons. Take them from Lucide.
- Patterns: floating iOS "liquid glass" tab bar (`nav` + sliding `.navind`; `updateNavActive()` sets `--ni`). `--navh` = 84 px + safe area (floating bar + gap), used by toast, FAB, buy bars and body padding. Home categories = big minimal tiles `.grid.groupgrid.homecats` (the user asked for big tiles back; don't shrink them). Balance cards `.balcard` / `.pbal` use `--grad-hero`. iOS segmented control `.seg` (neutral thumb), iOS switch `.swbtn` 51×31. Sheets: radius 28; `closeSheet()` animates out (removes ids at once, element gone after 300 ms); `openSheet()` clears exiting sheets instantly. Section labels are sentence case. `curS(html)` renders the trailing "so'm" small and muted. `body.no-fab` hides the support FAB on profile, pay, Steam and virtual number pages.
- Motion: `.screen.enter` stagger runs only when the view key changes (`_lastViewKey` in `render()`), never on plain re-renders. Other motion: `balBump()` (number roll on balance change, text is final at once, so tests can read it), `.favbtn.pop` heart beat, `navPop` icon pop, toast spring (`--ios` `linear()` with a cubic-bezier fallback declared first), header hairline on scroll (`body.scrolled`). Respect `[data-reduce-motion="1"]` and `prefers-reduced-motion` for every new animation.
- Performance: no `backdrop-filter` on per-card elements (favbtn, stkb, admpen, gback) — that caused jank on phones. Product cards use `content-visibility:auto`. Videos/lottie play only in view (`watchMedia()`). `html.lite` (Telegram-Android UA perf class LOW/AVERAGE or weak Android) disables blur, the body glow and decorative loops. Keep new decorative animations transform/opacity-only, and add them to the reduce-motion and `.lite` off-lists.
- Colors: profile hero `.profhero` (brand gradient + rotating avatar ring), stats `.stat .sic` with `--sc`, iOS-style colored icon chips `.ibadge` / `.adm-ic` via `--ib` (color from `svcRow(...,color,...)` / ADM_TILES), home categories get `--cc` from `CAT_COLOR`. Uses `color-mix()` with plain fallbacks.
- Motion v3.5: screen enter is direction-aware (`.screen.enter.fwd` / `.back` from depth), 0.65 s. The balance, pay and profile hero cards get a light sweep every 7 s. Category icons float. Sheet content staggers on open (`.sheet.intro` for 900 ms).
- The skins store (`.sk`) keeps its own dark look. Only its icons were switched to Lucide, and its glow shadows were removed. Sparks and the grid texture stay on purpose (the user asked for them).
- v3.7: product cards show only name and price. The user asked to remove captions under names ("Steam'ga darhol", "N ta paket"); don't add them back. Profile rows each have their own icon and color: loyalty = gold crown, never the same emoji or icon as another row. Version line is admin-only. Reviews and leaderboard blocks hide when empty. Skins entry `.sk-fx`: clip-path expands from the card rect, then gold glow, two rings, blur-in logo with light sweep and «CS2 · DOTA 2 · RUST»; store shows at 1050 ms, layer removed at 1600 ms.
- Support v3.8 (ai.js + tgsupport.js + server.js):
  - One thread per customer in `DB.settings.support[uid]` (max 150 msgs) plus `DB.settings.supportMeta[uid]` (name, via app|bot|tg, seen, want, closed, attn).
  - AI never answers "can't answer": `runAgent` tries the chosen provider, then the other one. Gemini rotates keys and models (`coolModel`). If both fail or no key, `localAnswer()` gives keyword answers in UZ/RU/EN and flags the chat for an operator.
  - `call_human` / `toOperator` only flag `want` and notify. AI keeps answering until an admin replies (`inboxReply` sets `aiHuman[uid]`).
  - Admin API: `/api/admin/inbox` (tab want|all|ai|closed), `/inbox/thread`, `/inbox/reply` (via `operatorSend`: support account if `via==="tg"`, else shop bot), `/inbox/state` (ai|human|close|open), `/api/admin/badges`, `/api/admin/notices` (+`/seen`), `/api/admin/tgsupport` (+`/creds|options|login|code|password|logout`).
  - Support account = `tgsupport.js` on `teleproto` (maintained GramJS fork). Login: sendCode → auth.SignIn → SESSION_PASSWORD_NEEDED → computeCheck + auth.CheckPassword. Session in `settings.tgSupport.session`, never returned. Peers' accessHash in `settings.tgSupportPeers`. Ignores groups, bots and 777000.
  - Tests use a fake lib: `TGS_TEST=1 TGS_FAKE_LIB=<path>` (scratchpad `sup/fake-tp.js`, `sup/sup-test.js`).
  - Admin bot defaults (`NOTIFY_DEFAULT`): orders and payments on; sms and support off. Those go to the «Xabarlar» feed (`addNotice`, kinds sms|handoff|queue|support|tgs, max 400, per-admin `noticeSeen`).
  - Client: `openAdminSupport(uid)`, `openSupportThread`, `openAdminNotices`, `openAdminTgSupport`, `admBadges()`. Start param `open_<section>` opens a section (links sent from the support account).
- v3.9:
  - games.js has sections `games` and `obuna` (`secOf()`; the old `ai` section was removed by the owner). Obuna games may have no fields: the supplier returns a code, shown in `o.delivered`. A field with key `email` accepts email or login (loose check).
  - Client: `gamesOf("obuna")` cards appear in the Obuna category and on the products screen.
  - Admin «Mahsulotlar» = `openAdminProducts()` (tile `catalog`). Rows come from `prdRows()`: catalog groups (one row per `kind::group`), single items, `gifts`, `game` (games/obuna), `steam`, `vnum`, `skins`, `nakrutka`. Detail `prdOpen(key)` shows `prdConnHTML` (lines/providers with balances from `/api/admin/products/overview`) and `prdInnerHTML` (items/packages → existing editors `openAdminForm(id, preset)`, `openAdminPackageForm`, `openAdminGamePrices`, `openAdminGameForm`).
  - `PRD.dirty` + a 900 ms watcher refreshes the list after an editor sheet closes.
- Main-app RU/EN for Steam, virtual number and profile extras: `XT` dict keyed by the Uzbek string, `_x(s)`. HTML fragments use `XT_HTML` + `_xh(key)`. Add new Uzbek strings there with RU/EN.
- Accessibility: `ic()` and nav icons are `aria-hidden`. Icon-only buttons carry `aria-label`. Escape closes the sheet. Empty lists show one next-action button (`[data-gonav]`, `[data-gotopay]`).
- Skills to use for UI work (all in `.claude/skills/`): `impeccable` (polish/audit/critique/typeset/layout references), `make-interfaces-feel-better`, `emil-design-eng`, `apple-design`, `baseline-ui`, `fixing-accessibility`, `fixing-motion-performance`, `better-typography`, `better-colors`, `better-interface`, `interface-review`, `web-design-guidelines`, `rams`. For security: built-in `security-review` + `owasp-review-2026` + `best-practices`. Polish rules already applied: press scale 0.96 everywhere (never below 0.95), `--spring` = strong ease-out `cubic-bezier(.23,1,.32,1)`, sheet 360 ms iOS drawer curve, ~44 px hit areas via `::after` on small controls, concentric radius on the balance card (24 = 10 + 14). Fetch more skills with `NODE_USE_ENV_PROXY=1 npx ui-skills get <slug>`. Design lint: `npx impeccable detect --json verion-shop.html` (works offline; its skill bundle download from impeccable.style is blocked in the cloud env).

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

## Admin edit pens (✏️ inside product pages)
- `admPen(act, arg, cls)` renders a small pencil only when `ME.isAdmin === true`; one capture-phase document listener (`[data-admpen]`) stops propagation (so the back row / store click handlers don't fire) and calls `admPenGo`.
- Acts: `item` (catalog product → `openAdminForm(id)`), `group` (`openGroupForm`), `cat`, `games`, `ai`, `nk`, `steam`, `vnum`, `skins` (menus via `admMenu`). `ADM_PAGE` is captured by `openAdminForm` / `openGroupForm`; when set, saving calls `publishCatalog()` so the change goes live immediately.
- Special cards (steam, vnum, cs2, dota2, rust): `CARD_DEF` defaults, `cardArt/cardImg/cardTxt/cardTile`, editor `openCardArt(k)`; stored in `extras.cards` (server `CARD_KEYS`, POST `/api/admin/extras {cards:{k: {...}|null}}` merges per key, `/gimg/` or https images only).
- Tests: `admin-pen-test.js` (scratchpad) — client sees no pens and gets 403; admin edits card art, a catalog product (published) and skins cards inside the store.

## Product images (transparent, file-backed)
- Server `extractImages()` (server.js) turns any `data:image/(png|jpeg|webp);base64` string (>200 chars) inside the catalog (`POST /api/catalog`), `catmeta`, `nkcatmeta` and extras `cards[].img` into `/gimg/<sha1>.<ext>` via `GAMES.saveDataImage()`; `migrateInlineImages()` runs once 2 s after listen for old data. Never store images inline again.
- Client: `imgCutBg(canvas)` removes a uniform border-connected background (border ≥86% within ΔE 42, flood fill, feathered edges; returns cut/already/photo), `imgEncode` → WebP (PNG fallback), `imgPrep(fileOrUrl, maxSide, cut, cb)`. Product form toggle `#f_cut` (default on), `tile.fit="contain"` renders `.ptile img.fit`, `tile.img0` keeps the original («↩ Asl rasm»). Batch: `admCutAll(btn)` (catalog items, groups, nakrutka meta, extras cards) then `publishCatalog()`; `publishCatalog` re-fetches the server catalog so the device keeps the light `/gimg/` copy.
- One-time auto run: server `IMG_CUT_V` vs `DB.settings.imgCutV` → `/api/me.imgCut` for admins; client `admAutoCut()` (4 s after ME loads, retries until the server catalog is loaded) runs `admCutAll(null, done)` headless, publishes via `publishCatalogQuiet` (no navigation), then `POST /api/admin/img-cut-done`. Skipped when the device has unpublished drafts (`S.over/custom/removed/imported`). Bump `IMG_CUT_V` to make it run once more.
- Test: `img-cut-test.js` (spawns its own server with a pre-seeded sqlite).

