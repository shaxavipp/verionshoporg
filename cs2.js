/* ================= CS2 skinlar do'koni (lis-skins.com) =================
   Katalog (nomlar, rasmlar, toifa, noyoblik) — ochiq CS2 bazasi (ByMykel/CSGO-API, ~21k skin),
   haftada bir yangilanadi va diskda saqlanadi. Narx va sotuvdagi takliflar — jonli, lis-skins API'dan.
   Xarid: mijoz Steam trade havolasini bir marta saqlaydi → pul band qilinadi → lis-skins
   POST market/buy (ids, partner, token, max_price, custom_id) → skin to'g'ridan-to'g'ri mijozning
   Steam'iga trade bo'lib keladi. max_price — narx shu orada oshsa xarid bo'lmaydi (zarar yo'q);
   custom_id = buyurtma ID — bitta buyurtma ikki marta sotib olinmaydi va aloqa uzilsa ham
   holatini keyin aniqlab olamiz. Sotib olinmasa yoki trade qaytsa — pul balansga qaytadi.
   API manzillari: lis-skins.stoplight.io hujjatiga mos (api.lis-skins.com/v1, Bearer kalit).
   Javob maydon nomlari bir nechta variant bo'yicha o'qiladi; admin "Sinash" haqiqiy javobni ko'rsatadi. */
"use strict";
const https = require("https");
const http = require("http");
const lib = u => (String(u).indexOf("http:") === 0 ? http : https);   // sinov uchun http ham
const fs = require("fs");
const path = require("path");

const LIS = () => String(process.env.LIS_BASE || "https://api.lis-skins.com/v1/").replace(/\/?$/, "/");
const DATA_URL = () => process.env.CS2_DATA_URL || "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json";
const SNIPERS = ["AWP", "SSG 08", "SCAR-20", "G3SG1"];
const CATS = [["knife", "Pichoqlar"], ["gloves", "Qo'lqoplar"], ["rifle", "Avtomatlar"], ["sniper", "Snayperlar"],
  ["pistol", "To'pponchalar"], ["smg", "PP"], ["heavy", "Og'ir qurollar"]];
const WEAR = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };
// Noyoblik tartibi (qimmatbaholari oldin)
const RARITY_RANK = { "#e4ae39": 0, "#eb4b4b": 1, "#d32ce6": 2, "#8847ff": 3, "#4b69ff": 4, "#5e98d9": 5, "#b0c3d9": 6 };

module.exports = function (ctx) {
  const DBx = () => ctx.getDB();
  const send = ctx.send;
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const money = n => Math.round(n).toLocaleString("ru-RU").replace(/,/g, " ").replace(/ /g, " ") + " so'm";

  function cfg() {
    const s = DBx().settings;
    const c = s.cs2 || (s.cs2 = {});
    if (c.enabled === undefined) c.enabled = false;
    if (!(c.rate > 0)) c.rate = 12900;          // 1$ = shuncha so'm
    if (!(c.markup >= 0)) c.markup = 15;        // ustama, %
    if (!(c.minUsd > 0)) c.minUsd = 0.3;
    if (!(c.maxUsd > 0)) c.maxUsd = 3000;
    if (c.onlyUnlocked === undefined) c.onlyUnlocked = true;   // faqat darhol yuboriladigan skinlar
    return c;
  }
  const ready = () => { const c = cfg(); return !!(c.enabled && c.apiKey); };
  const uzs = usd => Math.ceil(usd * cfg().rate * (1 + cfg().markup / 100) / 100) * 100;
  const usdOf = so => so / (cfg().rate * (1 + cfg().markup / 100));

  /* ---------- lis-skins HTTP ---------- */
  function qsOf(params) {
    const p = [];
    for (const k of Object.keys(params || {})) {
      const v = params[k];
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const x of v) p.push(encodeURIComponent(k + "[]") + "=" + encodeURIComponent(x));
      else p.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
    return p.length ? "?" + p.join("&") : "";
  }
  function call(method, p, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      let u; try { u = new URL(LIS() + p + qsOf(opts.params)); } catch (e) { return resolve({ sent: false, error: "BAD_URL" }); }
      const body = opts.json ? JSON.stringify(opts.json) : null;
      const h = { Accept: "application/json", Authorization: "Bearer " + String(cfg().apiKey || "") };
      if (body) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(body); }
      let done = false; const fin = r => { if (!done) { done = true; resolve(r); } };
      const req = lib(u.protocol).request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method, headers: h, timeout: opts.timeout || 20000 }, res => {
        const ch = []; let n = 0;
        res.on("data", c => { if (n < 4e6) { const x = Buffer.isBuffer(c) ? c : Buffer.from(String(c)); ch.push(x); n += x.length; } });
        res.on("end", () => { const b = Buffer.concat(ch).toString("utf8"); let j = null; try { j = JSON.parse(b); } catch (e) {} fin({ sent: true, status: res.statusCode, json: j, text: b.slice(0, 400) }); });
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
      req.on("error", e => fin({ sent: ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].indexOf(e.code) === -1, error: e.code || e.message }));
      if (body) req.write(body);
      req.end();
    });
  }
  const listOf = j => Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j && Array.isArray(j.items) ? j.items
    : j && j.data && Array.isArray(j.data.items) ? j.data.items : [];
  const errOf = j => j ? str(j.error && (j.error.message || j.error) || j.message || (j.errors && JSON.stringify(j.errors)) || "", 200) : "";
  const pick = (o, keys) => { for (const k of keys) { const v = k.split(".").reduce((a, x) => a == null ? a : a[x], o); if (v !== undefined && v !== null && v !== "") return v; } return null; };

  /* ---------- katalog (ochiq CS2 bazasi) ---------- */
  const CAT_FILE = path.join(ctx.DATA_DIR, "cs2-catalog.json");
  let CAT = [], BY_NAME = new Map(), GROUPS = [], G_BY = new Map(), CAT_TS = 0, catLoading = null;
  function catKey(x) {
    const c = (x.category && x.category.name) || "", w = (x.weapon && x.weapon.name) || "";
    if (c === "Knives") return "knife";
    if (c === "Gloves") return "gloves";
    if (c === "Rifles") return SNIPERS.indexOf(w) !== -1 ? "sniper" : "rifle";
    if (c === "Pistols") return "pistol";
    if (c === "SMGs") return "smg";
    if (c === "Heavy") return "heavy";
    return "other";
  }
  // Bitta skin (masalan "AK-47 | Redline") — barcha eskirganlik darajalari, StatTrak™ va Souvenir variantlari bir guruhda.
  const baseOf = n => String(n).replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)\s*$/, "")
    .replace(/StatTrak™ /, "").replace(/^Souvenir /, "");
  function index(list) {
    CAT = []; BY_NAME = new Map(); const g = new Map();
    for (const e of list) {
      if (BY_NAME.has(e.n)) continue;   // Doppler fazalari bir xil nom bilan keladi
      BY_NAME.set(e.n, e); CAT.push(e);
      const b = baseOf(e.n);
      let G = g.get(b);
      if (!G) { G = { b, w: e.w, s: e.s, c: e.c, r: e.r, rn: e.rn, st: false, sv: false, i: e.i, v: [] }; g.set(b, G); }
      if (e.st) G.st = true;
      if (e.sv) G.sv = true;
      G.v.push(e.n);
    }
    G_BY = g;
    GROUPS = [...g.values()].sort((a, b) => (RARITY_RANK[a.r] ?? 9) - (RARITY_RANK[b.r] ?? 9) || a.b.localeCompare(b.b));
  }
  function loadCatalogFromDisk() {
    try { const j = JSON.parse(fs.readFileSync(CAT_FILE, "utf8")); if (Array.isArray(j.items) && j.items.length) { index(j.items); CAT_TS = j.ts || 0; return true; } } catch (e) {}
    return false;
  }
  function downloadCatalog() {
    if (catLoading) return catLoading;
    catLoading = new Promise(resolve => {
      const get = (url, depth) => lib(url).get(url, { timeout: 60000 }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) { r.resume(); return get(new URL(r.headers.location, url).toString(), depth + 1); }
        if (r.statusCode !== 200) { r.resume(); return resolve({ ok: false, error: "HTTP " + r.statusCode }); }
        const ch = []; r.on("data", c => ch.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
        r.on("end", () => {
          try {
            const raw = JSON.parse(Buffer.concat(ch).toString("utf8"));
            const items = [];
            for (const x of raw) {
              const n = x.market_hash_name || x.name;
              if (!n || typeof n !== "string" || !/^https:\/\/[a-z0-9.-]+\.steamstatic\.com\//.test(String(x.image || ""))) continue;
              items.push({ n, w: (x.weapon && x.weapon.name) || "", s: (x.pattern && x.pattern.name) || "", c: catKey(x),
                r: (x.rarity && x.rarity.color) || "#b0c3d9", rn: (x.rarity && x.rarity.name) || "", wr: WEAR[x.wear && x.wear.name] || "",
                st: !!x.stattrak, sv: !!x.souvenir, i: x.image });
            }
            if (items.length < 1000) return resolve({ ok: false, error: "baza juda kichik (" + items.length + ")" });
            index(items); CAT_TS = Date.now();
            fs.writeFile(CAT_FILE, JSON.stringify({ ts: CAT_TS, items }), () => {});
            resolve({ ok: true, count: items.length });
          } catch (e) { resolve({ ok: false, error: e.message }); }
        });
      }).on("timeout", function () { this.destroy(new Error("timeout")); }).on("error", e => resolve({ ok: false, error: e.message }));
      get(DATA_URL(), 0);
    }).finally(() => { catLoading = null; });
    return catLoading;
  }
  if (!loadCatalogFromDisk() || Date.now() - CAT_TS > 7 * 86400e3) setTimeout(() => { downloadCatalog().then(r => console.log("[cs2] katalog: " + (r.ok ? r.count + " ta skin" : r.error))); }, 5000).unref();
  { const t = setInterval(() => { if (Date.now() - CAT_TS > 7 * 86400e3) downloadCatalog(); }, 6 * 3600e3); if (t.unref) t.unref(); }

  /* ---------- eng arzon narxlar ro'yxati (ixtiyoriy) ----------
     lis-skins butun bozorning eng arzon narxlarini bitta JSON qilib beradi (nom → narx, soni).
     Bo'lsa — katalogda har skinning "...dan" narxi va "sotuvda bor" belgisi shundan olinadi
     (10 daqiqada yangilanadi). Bo'lmasa yoki o'qib bo'lmasa — narxlar API qidiruvidan olinadi. */
  const PRICES_URL = () => process.env.LIS_PRICES_URL || "https://lis-skins.com/market_export_json/csgo.json";
  let PRICES = null, PRICES_TS = 0, pricesBusy = false;
  function loadPrices() {
    if (pricesBusy || !ready()) return;
    pricesBusy = true;
    const done = () => { pricesBusy = false; };
    const get = (url, depth) => lib(url).get(url, { timeout: 60000, headers: { Accept: "application/json" } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) { r.resume(); return get(new URL(r.headers.location, url).toString(), depth + 1); }
      if (r.statusCode !== 200) { r.resume(); return done(); }
      const ch = []; let n = 0;
      r.on("data", c => { const x = Buffer.isBuffer(c) ? c : Buffer.from(String(c)); n += x.length; if (n < 60e6) ch.push(x); });
      r.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(ch).toString("utf8"));
          const arr = listOf(j).length ? listOf(j) : (j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j).map(k => Object.assign({ name: k }, typeof j[k] === "object" ? j[k] : { price: j[k] })) : []);
          const m = new Map();
          for (const x of arr) {
            const name = pick(x, ["name", "market_hash_name"]), usd = Number(pick(x, ["price", "min_price", "price_usd"]));
            if (!name || !(usd > 0)) continue;
            const cnt = Number(pick(x, ["count", "quantity", "amount"])) || 1;
            const h = m.get(name);
            if (!h || usd < h.usd) m.set(name, { usd, cnt: (h ? h.cnt : 0) + cnt }); else h.cnt += cnt;
          }
          if (m.size > 500) { PRICES = m; PRICES_TS = Date.now(); }
        } catch (e) {}
        done();
      });
    }).on("timeout", function () { this.destroy(new Error("timeout")); }).on("error", done);
    get(PRICES_URL(), 0);
  }
  setTimeout(loadPrices, 8000).unref();
  { const t = setInterval(loadPrices, 10 * 60e3); if (t.unref) t.unref(); }
  const pricesFresh = () => !!PRICES && Date.now() - PRICES_TS < 60 * 60e3;
  function fromOf(G) {
    const c = cfg(); let best = null, cnt = 0;
    for (const n of G.v) { const p = PRICES.get(n); if (p && p.usd >= c.minUsd && p.usd <= c.maxUsd) { cnt += p.cnt; if (best === null || p.usd < best) best = p.usd; } }
    return { usd: best, cnt };
  }

  /* ---------- takliflar (lis-skins) ---------- */
  // Mijozga ko'rsatilgan har taklif eslab qolinadi: xarid shu narx bilan (max_price) qilinadi.
  const OFFERS = new Map();   // id -> { usd, name, float, ts }
  function rememberOffer(o) {
    OFFERS.set(o.id, { usd: o.usd, name: o.name, float: o.float, ts: Date.now() });
    if (OFFERS.size > 20000) { const cut = Date.now() - 20 * 60e3; for (const [k, v] of OFFERS) if (v.ts < cut) OFFERS.delete(k); }
  }
  function normOffer(x) {
    if (!x || typeof x !== "object") return null;
    const id = pick(x, ["id", "item_id", "skin_id"]);
    const name = pick(x, ["name", "market_hash_name", "full_name", "title"]);
    const usd = Number(pick(x, ["price", "price_usd", "usd", "amount"]));
    const fl = pick(x, ["item_float", "float", "float_value", "floatvalue"]);
    const unlock = pick(x, ["unlock_at", "unlocked_at", "hold_until", "trade_lock_until"]);
    if (id == null || !name || !(usd > 0)) return null;
    return { id: String(id), name: String(name), usd, float: fl != null && isFinite(Number(fl)) ? Number(fl) : null,
      locked: !!unlock && Date.parse(unlock) > Date.now() };
  }
  function pubOffer(o) {
    const e = BY_NAME.get(o.name) || {};
    return { id: o.id, name: o.name, b: baseOf(o.name), w: e.w || "", s: e.s || "", price: uzs(o.usd), float: o.float, wear: e.wr || "",
      img: e.i || "", rc: e.r || "#b0c3d9", rn: e.rn || "", cat: e.c || "other", st: /StatTrak/.test(o.name), sv: /^Souvenir /.test(o.name), locked: o.locked };
  }
  const CACHE = new Map();   // so'rov -> { ts, val }
  // lis-skins'ga keshdan tashqari so'rovlar chegarasi: daqiqasiga jami 150, bitta mijozdan 20
  // (aks holda kimdir qidiruvni ketma-ket bosib kalitimizni sayt limitiga tiqib qo'yishi mumkin).
  const BUDGET = { min: 0, n: 0 }, PER_USER = new Map();
  function allow(uid) {
    const min = Math.floor(Date.now() / 60e3);
    if (BUDGET.min !== min) { BUDGET.min = min; BUDGET.n = 0; PER_USER.clear(); }
    const k = String(uid || "-"), n = (PER_USER.get(k) || 0) + 1;
    if (BUDGET.n >= 150 || n > 20) return false;
    BUDGET.n++; PER_USER.set(k, n); return true;
  }
  async function cached(key, ms, fn, uid) {
    const h = CACHE.get(key);
    if (h && Date.now() - h.ts < ms) return h.val;
    if (!allow(uid)) throw Object.assign(new Error("busy"), { busy: true });
    const val = await fn();
    CACHE.set(key, { ts: Date.now(), val });
    if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value);
    return val;
  }
  async function search(params) {
    const c = cfg();
    const r = await call("GET", "market/search", { params: Object.assign({ game: "csgo", only_unlocked: c.onlyUnlocked ? 1 : 0 }, params) });
    if (!r.json || r.status >= 400) throw new Error(errOf(r.json) || r.error || ("HTTP " + r.status));
    const items = listOf(r.json).map(normOffer).filter(Boolean)
      .filter(o => o.usd >= c.minUsd && o.usd <= c.maxUsd && (!c.onlyUnlocked || !o.locked));
    items.forEach(rememberOffer);
    return { items, next: str(pick(r.json, ["meta.next_cursor", "next_cursor", "meta.cursor"]) || "", 200) };
  }

  /* ---------- buyurtma va pul ---------- */
  const ALERT = {};
  function alertOnce(key, text) {
    const now = Date.now(); if (ALERT[key] && now - ALERT[key] < 10 * 60e3) return;
    if (Object.keys(ALERT).length > 200) for (const k of Object.keys(ALERT)) delete ALERT[k];
    ALERT[key] = now; ctx.notifyAdmins(text);
  }
  function refund(o, why) {
    if (o.status !== "pending") return;
    o.status = "cancelled"; o.cancelReason = why || "";
    const acc = DBx().users[String(o.uid)] || (DBx().users[String(o.uid)] = { balance: 0 });
    acc.balance += o.price; o.refunded = true;
    ctx.save();
    ctx.tgSend(o.uid, "❌ " + o.item + " — bekor qilindi, " + money(o.price) + " balansingizga qaytarildi." + (why ? "\n" + why : ""));
    ctx.notifyOrderChannel(o);
  }
  function markDone(o) {
    if (o.status !== "pending") return;
    o.status = "done"; o.doneTs = Date.now(); o.cs2.state = "done";
    o.delivered = "🎯 " + o.cs2.name + (o.cs2.float != null ? " (float " + o.cs2.float.toFixed(4) + ")" : "") + " — Steam hisobingizga tushdi.";
    ctx.save();
    try { ctx.creditReferralOnOrder(o); ctx.creditLoyaltyOnOrder(o); } catch (e) {}
    ctx.tgSend(o.uid, "✅ " + o.delivered);
    ctx.notifyOrderChannel(o);
  }
  function parseTrade(url) {
    let u; try { u = new URL(String(url || "").trim()); } catch (e) { return null; }
    if (u.protocol !== "https:" || !/^(www\.)?steamcommunity\.com$/i.test(u.hostname) || !/^\/tradeoffer\/new\/?$/.test(u.pathname)) return null;
    const partner = u.searchParams.get("partner"), token = u.searchParams.get("token");
    if (!/^\d{1,12}$/.test(partner || "") || !/^[A-Za-z0-9_-]{4,20}$/.test(token || "")) return null;
    return { partner, token, url: "https://steamcommunity.com/tradeoffer/new/?partner=" + partner + "&token=" + token };
  }
  const STEAM_OFFERS = "https://steamcommunity.com/my/tradeoffers/";
  async function buy(u, offerId) {
    const c = cfg();
    if (!ready()) return { code: 503, body: { error: "off", message: "CS2 do'koni hozircha yopiq" } };
    const acc = ctx.user(u), tu = parseTrade(acc.cs2Trade);
    if (!tu) return { code: 400, body: { error: "trade_url", message: "Avval Steam trade havolangizni kiriting" } };
    const of = OFFERS.get(String(offerId));
    if (!of || Date.now() - of.ts > 15 * 60e3) return { code: 409, body: { error: "stale", message: "Narxlar yangilandi — skinni qaytadan oching" } };
    const price = uzs(of.usd);
    if (!(acc.balance >= price)) return { code: 402, body: { error: "balance", need: price - acc.balance } };
    acc.balance -= price;
    const e = BY_NAME.get(of.name) || {};
    const o = { id: ctx.genId("VN"), seq: ctx.nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: "cs2:" + offerId,
      item: "🎯 CS2: " + of.name, price, status: "pending", ts: Date.now(), delivered: null, doneTs: null, quantity: 1,
      cs2: { name: of.name, offerId: String(offerId), usd: of.usd, float: of.float, img: e.i || "", partner: tu.partner, token: tu.token, state: "buying" },
      costUzs: Math.round(of.usd * c.rate) };
    DBx().orders.push(o); ctx.save(); ctx.notifyOrder(o);
    OFFERS.delete(String(offerId));
    const r = await call("POST", "market/buy", { timeout: Number(process.env.CS2_BUY_TIMEOUT) || 30000, json: { ids: [/^\d+$/.test(String(offerId)) ? Number(offerId) : String(offerId)],
      partner: tu.partner, token: tu.token, max_price: Math.round(of.usd * 100) / 100, custom_id: o.id } });
    const j = r.json, msg = errOf(j);
    if (r.sent && j && r.status >= 200 && r.status < 300 && !(j.error || j.success === false || j.status === false)) {
      o.cs2.purchaseId = str(pick(j, ["data.purchase_id", "purchase_id", "data.id", "id", "data.0.purchase_id"]) || "", 60);
      o.cs2.state = "sent"; ctx.save();
      if (o.status !== "pending") ctx.notifyAdmins("⚠️ #" + o.seq + " CS2: " + of.name + " — buyurtma admin tomonidan bekor qilingan, lekin lis-skins xaridni bajardi (skin mijozga yuborildi). Tekshiring.", { order: o });
      return { code: 200, body: { ok: true, order: ctx.pubOrder(o), balance: acc.balance, steamOffers: STEAM_OFFERS } };
    }
    if (r.sent && (r.status === 401 || r.status === 403)) {
      alertOnce("cs2-auth", "⛔ CS2 (lis-skins): kalit noto'g'ri yoki ruxsat yo'q (HTTP " + r.status + "). Admin panel → CS2 skinlar.");
      refund(o, "CS2 do'koni hozircha ishlamayapti, keyinroq urinib ko'ring.");
      return { code: 503, body: { error: "off", message: "Hozircha ishlamayapti, keyinroq urinib ko'ring", balance: acc.balance } };
    }
    // 4xx — so'rov rad etilgan (xarid bo'lmagan) yoki so'rov umuman yetib bormagan: pul qaytadi
    if (!r.sent || (r.status >= 400 && r.status < 500)) {
      const funds = /balance|fund|insufficient|not enough|недостаточно|баланс/i.test(msg);
      if (funds) alertOnce("cs2-bal", "🚨 CS2 skinlar ishlamayapti — lis-skins hamyonida coin yetarli emas. Hamyonni to'ldiring.");
      else if (r.sent) alertOnce("cs2-rej-" + msg.slice(0, 40), "⚠️ CS2 xaridi rad etildi: " + msg);
      const userMsg = funds || !r.sent ? "Hozircha ishlamayapti, keyinroq urinib ko'ring" : "Bu skin sotilib ketdi yoki narxi o'zgardi — boshqasini tanlang";
      refund(o, userMsg + ".");
      return { code: funds || !r.sent ? 503 : 409, body: { error: funds || !r.sent ? "off" : "gone", message: userMsg, balance: acc.balance } };
    }
    // Javob noaniq — sotib olingan bo'lishi mumkin. Pul band, holat custom_id bo'yicha aniqlanadi.
    o.cs2.state = "unknown"; o.cs2.raw = str(r.error || r.text, 200); ctx.save();
    ctx.notifyAdmins("❓ #" + o.seq + " CS2: " + of.name + " — lis-skins javobi noaniq (" + o.cs2.raw + "). Holati avtomatik tekshirilmoqda.", { order: o });
    return { code: 200, body: { ok: true, pending: true, order: ctx.pubOrder(o), balance: acc.balance, steamOffers: STEAM_OFFERS } };
  }
  // Holat so'zlari hujjatda aniq emas — keng mos keladi, xom qiymat saqlanadi (admin ko'radi).
  function stateWord(s) {
    s = String(s || "").toLowerCase();
    if (/not[_ -]|return|refund|cancel|fail|declin|expire|error|reject/.test(s)) return "failed";
    if (/accept|complet|success|deliver|done|finish|transferred/.test(s)) return "done";
    if (!s || /process|pend|wait|new|creat|send|sent|queue|hold|lock|progress|trade/.test(s)) return "pending";
    return "other";
  }
  const SEEN_STATES = new Set();
  const UNKNOWN_MS = Number(process.env.CS2_UNKNOWN_MS) || 15 * 60e3;
  let polling = false;
  async function poll() {
    if (polling || !ready()) return;
    polling = true;
    try {
      const list = DBx().orders.filter(o => o.status === "pending" && o.cs2 && (o.cs2.state === "sent" || o.cs2.state === "unknown"));
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const pids = chunk.map(o => o.cs2.purchaseId).filter(x => /^\d+$/.test(x || ""));
        const r = await call("GET", "market/info", { params: { "custom_ids": chunk.map(o => o.id), "purchase_ids": pids.length ? pids : undefined } });
        if (!r.json || r.status >= 400) continue;
        const seen = new Set();
        for (const x of listOf(r.json)) {
          const cid = str(pick(x, ["custom_id"]) || "", 40), pid = str(pick(x, ["purchase_id", "id"]) || "", 60);
          const o = chunk.find(z => z.id === cid || (pid && z.cs2.purchaseId === pid));
          if (o) seen.add(o.id);
          if (!o || o.status !== "pending") continue;
          const skins = Array.isArray(x.skins) ? x.skins : Array.isArray(x.items) ? x.items : [];
          const raw = String(pick(x, ["status", "state"]) || (skins[0] && pick(skins[0], ["status", "state"])) || "");
          if (pid && !o.cs2.purchaseId) o.cs2.purchaseId = pid;
          if (o.cs2.state === "unknown") o.cs2.state = "sent";
          o.cs2.raw = str(raw, 60);
          const w = stateWord(raw);
          // Hujjatda yo'q holat nomi kelsa — adminga bir marta: shu orqali haqiqiy nomlarni bilib olamiz
          if (w === "other" && !SEEN_STATES.has(o.cs2.raw) && SEEN_STATES.size < 50) {
            SEEN_STATES.add(o.cs2.raw);
            ctx.notifyAdmins("ℹ️ CS2: lis-skins'dan yangi holat keldi: «" + o.cs2.raw + "» (#" + o.seq + "). Buyurtma kutishda turibdi — bu xabarni dasturchiga yuboring.");
          }
          if (w === "done") markDone(o);
          else if (w === "failed") {
            refund(o, "Trade qabul qilinmadi yoki bekor bo'ldi — pul balansga qaytdi.");
            ctx.notifyAdmins("↩️ #" + o.seq + " CS2: " + o.cs2.name + " — lis-skins holati «" + o.cs2.raw + "», mijozga pul qaytarildi. lis-skins balansiga qaytganini tekshiring.");
          } else ctx.save();
        }
        // Javob noaniq bo'lgan xarid lis-skins'da custom_id bo'yicha uzoq vaqt topilmasa — demak sotib olinmagan.
        for (const o of chunk) if (o.status === "pending" && o.cs2.state === "unknown" && !seen.has(o.id) && Date.now() - o.ts > UNKNOWN_MS) {
          refund(o, "Xarid amalga oshmadi — pul balansga qaytdi.");
          ctx.notifyAdmins("↩️ #" + o.seq + " CS2: " + o.cs2.name + " — lis-skins'da bu xarid topilmadi, mijozga pul qaytarildi.");
        }
      }
      // Trade 2 soatdan beri qabul qilinmagan bo'lsa — mijozga bir marta eslatma.
      for (const o of list) if (o.status === "pending" && o.cs2.state === "sent" && !o.cs2.reminded && Date.now() - o.ts > 2 * 3600e3) {
        o.cs2.reminded = true; ctx.save();
        ctx.tgSend(o.uid, "⏳ " + o.cs2.name + " — Steam'dagi trade taklifini qabul qiling: " + STEAM_OFFERS);
      }
    } catch (e) { console.log("[cs2] holat: " + e.message); }
    finally { polling = false; }
  }
  { const t = setInterval(() => { poll(); }, Number(process.env.CS2_POLL_MS) || 60000); if (t.unref) t.unref(); }
  async function balance() {
    const r = await call("GET", "user/balance", { timeout: 15000 });
    const b = r.json && pick(r.json, ["data.balance", "balance", "data.amount"]);
    if (b != null) return { id: "cs2", name: "CS2 · lis-skins", ok: true, message: "Balans: " + b + " USD" };
    return { id: "cs2", name: "CS2 · lis-skins", ok: false, message: errOf(r.json) || r.error || ("HTTP " + r.status) };
  }

  /* ---------- HTTP ---------- */
  const catsPublic = () => CATS.map(([k, label]) => ({ k, label }));
  function handle(req, res, url, m, q) {
    if (url === "/api/cs2" && m === "GET") {
      const u = ctx.auth(req);
      const acc = u ? DBx().users[String(u.id)] : null;
      send(res, 200, { enabled: ready(), cats: catsPublic(), catalog: CAT.length, tradeUrl: (acc && acc.cs2Trade) || "", steamOffers: STEAM_OFFERS });
      return true;
    }
    // Jonli bozor: sotuvdagi takliflar (narx bo'yicha, oraliq bilan)
    const busy = (res, e) => e && e.busy ? send(res, 429, { error: "busy", message: "Juda ko'p so'rov — birozdan keyin urinib ko'ring" })
      : send(res, 502, { error: "market", message: "Bozor hozir javob bermadi, birozdan keyin urinib ko'ring" });
    if (url === "/api/cs2/market" && m === "GET") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      if (!ready()) { send(res, 503, { error: "off" }); return true; }
      const sort = ["lowest_price", "highest_price", "newest"].indexOf(q.get("sort")) !== -1 ? q.get("sort") : "lowest_price";
      const pmin = Math.max(0, Number(q.get("pmin")) || 0), pmax = Math.max(0, Number(q.get("pmax")) || 0), cursor = str(q.get("cursor"), 200);
      const key = "m|" + sort + "|" + pmin + "|" + pmax + "|" + cursor;
      cached(key, 60000, () => search({ sort_by: sort, cursor, price_from: pmin ? Math.floor(usdOf(pmin) * 100) / 100 : undefined, price_to: pmax ? Math.ceil(usdOf(pmax) * 100) / 100 : undefined }), u.id)
        .then(r => send(res, 200, { items: r.items.filter(o => BY_NAME.has(o.name) && OFFERS.has(o.id)).map(pubOffer), next: r.next }))
        .catch(e => busy(res, e));
      return true;
    }
    // Katalog: toifa yoki qidiruv bo'yicha skinlar (har biriga "dan" narx — shu sahifa uchun)
    if (url === "/api/cs2/catalog" && m === "GET") {
      const cat = str(q.get("cat"), 10), text = str(q.get("q"), 60).toLowerCase(), page = Math.max(0, Math.min(500, Number(q.get("page")) || 0));
      const sort = str(q.get("sort"), 10);
      const words = text.split(/\s+/).filter(Boolean);
      let all = GROUPS.filter(g => (!cat || g.c === cat) && (!words.length || words.every(w => g.b.toLowerCase().indexOf(w) !== -1)));
      const PER = 20;
      const out = (g, f) => ({ b: g.b, w: g.w, s: g.s, img: g.i, rc: g.r, rn: g.rn, st: g.st, sv: g.sv, cat: g.c,
        from: f && f.usd ? uzs(f.usd) : null, cnt: f ? f.cnt : null });
      if (ready() && pricesFresh()) {
        // Narxlar ro'yxati bor: faqat sotuvdagilari, kerakli tartibda
        let rows = all.map(g => ({ g, f: fromOf(g) })).filter(x => x.f.usd);
        if (sort === "cheap") rows.sort((a, b) => a.f.usd - b.f.usd);
        else if (sort === "expensive") rows.sort((a, b) => b.f.usd - a.f.usd);
        // Ommabop: bozorda ko'p sotiladigan (taklif soni) va noyobroq skinlar oldinda
        else rows.sort((a, b) => b.f.cnt * (7 - (RARITY_RANK[b.g.r] ?? 6)) - a.f.cnt * (7 - (RARITY_RANK[a.g.r] ?? 6)) || a.g.b.localeCompare(b.g.b));
        const slice = rows.slice(page * PER, page * PER + PER);
        send(res, 200, { items: slice.map(x => out(x.g, x.f)), total: rows.length, page, more: rows.length > (page + 1) * PER, priced: true });
        return true;
      }
      const slice = all.slice(page * PER, page * PER + PER);
      if (!ready() || !slice.length) { send(res, 200, { items: slice.map(g => out(g)), total: all.length, page, more: all.length > (page + 1) * PER }); return true; }
      // Narxlar ro'yxati yo'q: shu sahifadagi skinlarning oddiy variantlari bo'yicha bitta qidiruv
      const names = slice.reduce((a, g) => a.concat(g.v.filter(n => !/StatTrak™|^Souvenir /.test(n))), []).slice(0, 100);
      const uc = ctx.auth(req);
      cached("c|" + names.join("|"), 10 * 60e3, () => search({ names, sort_by: "lowest_price" }).catch(() => ({ items: [] })), uc ? uc.id : "-")
        .catch(() => ({ items: [] }))
        .then(r => {
          const min = new Map();
          for (const o of r.items) { const b = baseOf(o.name); if (!min.has(b) || o.usd < min.get(b)) min.set(b, o.usd); }
          send(res, 200, { items: slice.map(g => out(g, min.has(g.b) ? { usd: min.get(g.b), cnt: null } : null)), total: all.length, page, more: all.length > (page + 1) * PER });
        });
      return true;
    }
    // Bitta skin: barcha eskirganlik darajalari bo'yicha sotuvdagi takliflar
    if (url === "/api/cs2/item" && m === "GET") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      const b = str(q.get("b"), 200);
      const g = G_BY.get(b);
      const nm = g ? g.v : (BY_NAME.has(b) ? [b] : []);
      if (!nm.length) { send(res, 404, { error: "not_found" }); return true; }
      const head = g ? { b: g.b, w: g.w, s: g.s, img: g.i, rc: g.r, rn: g.rn, st: g.st } : null;
      if (!ready()) { send(res, 200, { item: head, offers: [] }); return true; }
      cached("i|" + nm.join("|"), 60000, () => search({ names: nm, sort_by: "lowest_price" }), u.id)
        .then(r => send(res, 200, { item: head, offers: r.items.filter(o => OFFERS.has(o.id)).slice(0, 40).map(pubOffer) }))
        .catch(e => busy(res, e));
      return true;
    }
    if (url === "/api/cs2/trade-url" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => {
        const raw = str(b.url, 300);
        if (!raw) { const acc = ctx.user(u); acc.cs2Trade = ""; ctx.save(); return send(res, 200, { ok: true, tradeUrl: "" }); }
        const t = parseTrade(raw);
        if (!t) return send(res, 400, { error: "trade_url", message: "Havola noto'g'ri. U shunday ko'rinishda bo'ladi: https://steamcommunity.com/tradeoffer/new/?partner=…&token=…" });
        const acc = ctx.user(u); acc.cs2Trade = t.url; ctx.save();
        send(res, 200, { ok: true, tradeUrl: t.url });
      });
      return true;
    }
    if (url === "/api/cs2/buy" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => buy(u, str(b.offerId, 40)).then(r => send(res, r.code, r.body)));
      return true;
    }
    // --- admin ---
    if (url === "/api/admin/cs2" && (m === "GET" || m === "POST")) {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      const view = () => { const c = cfg(); return { enabled: c.enabled, rate: c.rate, markup: c.markup, minUsd: c.minUsd, maxUsd: c.maxUsd, onlyUnlocked: c.onlyUnlocked,
        apiKeySet: !!c.apiKey, catalog: CAT.length, skins: GROUPS.length, catalogTs: CAT_TS, prices: PRICES ? PRICES.size : 0, pricesTs: PRICES_TS }; };
      if (m === "GET") { send(res, 200, view()); return true; }
      ctx.readBody(req, res, b => {
        const c = cfg(), num = (x, lo, hi) => { const n = Number(x); return n >= lo && n <= hi ? n : null; };
        if ("enabled" in b) c.enabled = !!b.enabled;
        if ("onlyUnlocked" in b) c.onlyUnlocked = !!b.onlyUnlocked;
        const r = num(b.rate, 1000, 100000); if (r) c.rate = r;
        const mk = num(b.markup, 0, 300); if (mk !== null && b.markup !== undefined && b.markup !== "") c.markup = mk;
        const mn = num(b.minUsd, 0.01, 1000); if (mn) c.minUsd = mn;
        const mx = num(b.maxUsd, 1, 100000); if (mx) c.maxUsd = mx;
        if (b.apiKey) { c.apiKey = str(b.apiKey, 500); setTimeout(loadPrices, 500); }
        CACHE.clear(); ctx.save();
        send(res, 200, Object.assign({ ok: true }, view()));
      });
      return true;
    }
    if (url === "/api/admin/cs2/test" && m === "POST") {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      (async () => {
        if (!cfg().apiKey) return send(res, 200, { ok: false, message: "API kalit kiritilmagan" });
        const bal = await balance();
        const r = await call("GET", "market/search", { params: { game: "csgo", sort_by: "lowest_price", only_unlocked: 1 } });
        const first = listOf(r.json)[0];
        const norm = normOffer(first);
        send(res, 200, { ok: bal.ok && !!norm, balance: bal.message, search: r.status, sample: first ? JSON.stringify(first).slice(0, 600) : str(r.text, 300),
          parsed: norm ? (norm.name + " — $" + norm.usd + (norm.float != null ? ", float " + norm.float : "") + " → " + money(uzs(norm.usd))) : "Javobni o'qib bo'lmadi — namunani dasturchiga yuboring",
          catalog: CAT.length });
      })().catch(e => send(res, 200, { ok: false, message: e.message }));
      return true;
    }
    if (url === "/api/admin/cs2/catalog-refresh" && m === "POST") {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      downloadCatalog().then(r => send(res, 200, r));
      return true;
    }
    return false;
  }
  return { handle, ready, balance, cfg, poll, parseTrade, _internal: { normOffer, stateWord, index, OFFERS } };
};
