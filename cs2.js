/* ================= Skinlar do'koni: CS2 · Dota 2 · Rust (lis-skins.com) =================
   Katalog (nomlar, rasmlar, toifa, noyoblik):
     - CS2 — ochiq CS2 bazasi (ByMykel/CSGO-API, ~21k variant);
     - Dota 2 va Rust — Steam bozoridan (eng ommabop narsalar, rasm va turi bilan).
   Har biri haftada bir yangilanadi va diskda saqlanadi. Narx va sotuvdagi takliflar — jonli, lis-skins API'dan.
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
const crypto = require("crypto");

const LIS = () => String(process.env.LIS_BASE || "https://api.lis-skins.com/v1/").replace(/\/?$/, "/");
const DATA_URL = () => process.env.CS2_DATA_URL || "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json";
// Qurollarning o'yindagi standart (skinsiz) rasmlari — o'sha bazadan; toifa tugmalari uchun
const BASE_URL = () => process.env.CS2_BASE_URL != null ? process.env.CS2_BASE_URL
  : (/skins_not_grouped\.json$/.test(DATA_URL()) ? DATA_URL().replace(/skins_not_grouped\.json$/, "base_weapons.json") : "");
const STEAM_URL = () => process.env.STEAM_MARKET_URL || "https://steamcommunity.com/market/search/render/";
// O'yinlar: lis — lis-skins API'dagi nomi, appid — Steam ilova raqami, label — mijozga ko'rinadigan nomi
const GAMES = {
  cs2: { lis: "csgo", appid: 730, label: "CS2", icon: "🎯" },
  dota2: { lis: "dota2", appid: 570, label: "Dota 2", icon: "🛡" },
  rust: { lis: "rust", appid: 252490, label: "Rust", icon: "🪓" }
};
const GAME_KEYS = Object.keys(GAMES);
const SNIPERS = ["AWP", "SSG 08", "SCAR-20", "G3SG1"];
const CATS = {
  cs2: [["knife", "Pichoqlar"], ["gloves", "Qo'lqoplar"], ["rifle", "Avtomatlar"], ["sniper", "Snayperlar"], ["pistol", "To'pponchalar"], ["smg", "PP"], ["heavy", "Og'ir qurollar"]],
  dota2: [["wearable", "Kiyimlar"], ["courier", "Kuryerlar"], ["ward", "Wardlar"], ["treasure", "Sandiqlar"], ["bundle", "To'plamlar"], ["taunt", "Taunt"], ["other", "Boshqa"]],
  rust: [["weapon", "Qurollar"], ["tool", "Asboblar"], ["clothing", "Kiyimlar"], ["deploy", "Jihozlar"], ["other", "Boshqa"]]
};
const WEAR = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };
// Noyoblik tartibi (qimmatbaholari oldin)
const RARITY_RANK = { "#e4ae39": 0, "#ade55c": 0, "#eb4b4b": 1, "#d32ce6": 2, "#8847ff": 3, "#4b69ff": 4, "#5e98d9": 5, "#b0c3d9": 6 };
// Filtr uchun noyoblik kalitlari (rang bo'yicha)
const RARITY_KEY = { contraband: "#e4ae39", covert: "#eb4b4b", classified: "#d32ce6", restricted: "#8847ff", milspec: "#4b69ff", industrial: "#5e98d9", consumer: "#b0c3d9", arcana: "#ade55c" };
// Dota 2 noyobliklari → rang
const DOTA_RARITY = { Common: "#b0c3d9", Uncommon: "#5e98d9", Rare: "#4b69ff", Mythical: "#8847ff", Legendary: "#d32ce6", Immortal: "#e4ae39", Arcana: "#ade55c", Ancient: "#eb4b4b", Seasonal: "#fff34f" };
const RUST_COLOR = "#cd6f3b";
const IMG_OK = u => /^https:\/\/[a-z0-9.-]+\.steamstatic\.com\//.test(String(u || ""));

module.exports = function (ctx) {
  const DBx = () => ctx.getDB();
  const send = ctx.send;
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const money = n => Math.round(n).toLocaleString("ru-RU").replace(/,/g, " ").replace(/ /g, " ") + " so'm";
  const gameOf = v => (GAME_KEYS.indexOf(String(v || "")) !== -1 ? String(v) : "cs2");

  function cfg() {
    const s = DBx().settings;
    const c = s.cs2 || (s.cs2 = {});
    if (c.enabled === undefined) c.enabled = false;
    if (!(c.rate > 0)) c.rate = 12900;          // 1$ = shuncha so'm
    if (!(c.markup >= 0)) c.markup = 15;        // ustama, %
    if (!(c.minUsd > 0)) c.minUsd = 0.3;
    if (!(c.maxUsd > 0)) c.maxUsd = 3000;
    if (c.onlyUnlocked === undefined) c.onlyUnlocked = true;   // faqat darhol yuboriladigan skinlar
    if (!c.games || typeof c.games !== "object") c.games = { cs2: true, dota2: false, rust: false };
    if (!c.pricesUrls || typeof c.pricesUrls !== "object") c.pricesUrls = {};
    return c;
  }
  // g berilsa — o'sha o'yin ochiqmi; berilmasa — do'kon umuman ishlayaptimi (kamida bitta o'yin)
  const ready = g => { const c = cfg(); if (!(c.enabled && c.apiKey)) return false; return g ? !!c.games[g] : GAME_KEYS.some(k => c.games[k]); };
  const uzs = usd => Math.ceil(usd * cfg().rate * (1 + cfg().markup / 100) / 100) * 100;
  const usdOf = so => so / (cfg().rate * (1 + cfg().markup / 100));

  /* ---------- lis-skins HTTP ---------- */
  // Sayt limiti: 200 so'rov/daqiqa (xarid — 500). 429 kelsa, retry-after tugaguncha qidiruv so'rovlari yuborilmaydi.
  let coolUntil = 0;
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
        if (res.statusCode === 429) { const ra = Number(res.headers["retry-after"]); coolUntil = Date.now() + (ra > 0 && ra <= 600 ? ra : 30) * 1000; }
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
  // Oddiy JSON GET (katalog, narxlar ro'yxati, Steam bozori)
  function getJson(url, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const fin = o => resolve(Object.assign({ url }, o));
      const get = (u, depth) => lib(u).get(u, { timeout: opts.timeout || 90000, headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (VerionShop)" } }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) { r.resume(); return get(new URL(r.headers.location, u).toString(), depth + 1); }
        if (r.statusCode !== 200) { r.resume(); return fin({ error: "HTTP " + r.statusCode, status: r.statusCode }); }
        const ch = []; let n = 0, big = false; const lim = opts.limit || 80e6;
        r.on("data", c => { const x = Buffer.isBuffer(c) ? c : Buffer.from(String(c)); n += x.length; if (n < lim) ch.push(x); else if (!big) { big = true; r.destroy(); fin({ error: "juda katta" }); } });
        r.on("end", () => { if (big) return;
          let j; try { j = JSON.parse(Buffer.concat(ch).toString("utf8")); } catch (e) { return fin({ error: "JSON emas (" + Math.round(n / 1024) + " KB)" }); }
          fin({ json: j, bytes: n });
        });
      }).on("timeout", function () { this.destroy(new Error("timeout")); }).on("error", e => fin({ error: e.message }));
      try { get(url, 0); } catch (e) { fin({ error: e.message }); }
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- katalog (har o'yin uchun alohida) ---------- */
  const CAT_V = 2;
  const CG = {};   // o'yin -> { list, BY_NAME, GROUPS, G_BY, TS, loading, file, err }
  const cat = g => CG[g] || (CG[g] = { list: [], BY_NAME: new Map(), GROUPS: [], G_BY: new Map(), TS: 0, loading: null, err: "",
    file: path.join(ctx.DATA_DIR, g === "cs2" ? "cs2-catalog.json" : "skins-" + g + ".json") });
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
  // CS2: bitta skin (masalan "AK-47 | Redline") — barcha eskirganlik darajalari, StatTrak™ va Souvenir variantlari bir guruhda.
  // Dota 2 va Rust'da har narsa o'zi bitta guruh.
  const baseOf = (n, g) => (g && g !== "cs2") ? String(n) : String(n).replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)\s*$/, "")
    .replace(/StatTrak™ /, "").replace(/^Souvenir /, "");
  function index(list, g) {
    g = g || "cs2";
    const C = cat(g); C.list = []; C.BY_NAME = new Map(); const m = new Map();
    for (const e of list) {
      if (C.BY_NAME.has(e.n)) continue;   // Doppler fazalari bir xil nom bilan keladi
      C.BY_NAME.set(e.n, e); C.list.push(e);
      const b = baseOf(e.n, g);
      let G = m.get(b);
      if (!G) { G = { b, w: e.w, s: e.s, c: e.c, r: e.r, rn: e.rn, st: false, sv: false, i: e.i, v: [], mn: e.mn, mx: e.mx, pop: e.pop }; m.set(b, G); }
      if (e.st) G.st = true;
      if (e.sv) G.sv = true;
      G.v.push(e.n);
    }
    C.G_BY = m;
    C.GROUPS = [...m.values()].sort((a, b) => (g === "cs2" ? 0 : (a.pop || 1e9) - (b.pop || 1e9)) || (RARITY_RANK[a.r] ?? 9) - (RARITY_RANK[b.r] ?? 9) || a.b.localeCompare(b.b));
  }
  function loadCatalogFromDisk(g) {
    const C = cat(g);
    try {
      const j = JSON.parse(fs.readFileSync(C.file, "utf8"));
      // CAT_V — saqlangan katalog tuzilishi; eskisi bo'lsa ham ishlatiladi, lekin darhol yangilanadi
      if (Array.isArray(j.items) && j.items.length) { index(j.items, g); C.TS = j.v === CAT_V ? j.ts || 0 : 0; return true; }
    } catch (e) {}
    return false;
  }
  function saveCatalog(g, items) { const C = cat(g); C.TS = Date.now(); C.err = ""; fs.writeFile(C.file, JSON.stringify({ v: CAT_V, ts: C.TS, items }), () => {}); }
  async function downloadCs2() {
    const r = await getJson(DATA_URL(), { timeout: 120000 });
    if (r.error) return { ok: false, error: r.error };
    const items = [];
    for (const x of Array.isArray(r.json) ? r.json : []) {
      const n = x.market_hash_name || x.name;
      if (!n || typeof n !== "string" || !IMG_OK(x.image)) continue;
      items.push({ n, w: (x.weapon && x.weapon.name) || "", s: (x.pattern && x.pattern.name) || "", c: catKey(x),
        r: (x.rarity && x.rarity.color) || "#b0c3d9", rn: (x.rarity && x.rarity.name) || "", wr: WEAR[x.wear && x.wear.name] || "",
        st: !!x.stattrak, sv: !!x.souvenir, i: x.image,
        mn: isFinite(x.min_float) ? Number(x.min_float) : null, mx: isFinite(x.max_float) ? Number(x.max_float) : null });
    }
    if (items.length < 1000) return { ok: false, error: "baza juda kichik (" + items.length + ")" };
    index(items, "cs2"); saveCatalog("cs2", items);
    return { ok: true, count: items.length };
  }
  // Dota 2: Steam "type" maydonidan noyoblik va toifa ("Immortal Wearable", "Rare Courier"...)
  function dotaMeta(type) {
    const t = String(type || "");
    const rar = Object.keys(DOTA_RARITY).find(k => new RegExp("\\b" + k + "\\b").test(t)) || "";
    const c = /Courier/i.test(t) ? "courier" : /Ward/i.test(t) ? "ward" : /Treasure|Chest|Cache/i.test(t) ? "treasure" : /Bundle|Set\b/i.test(t) ? "bundle"
      : /Taunt/i.test(t) ? "taunt" : /Wearable|Ability|Weapon|Effect|Head|Back|Arms|Armor|Shoulder|Belt/i.test(t) ? "wearable" : "other";
    return { rn: rar, r: DOTA_RARITY[rar] || "#b0c3d9", c, w: t.replace(new RegExp("\\b(" + Object.keys(DOTA_RARITY).join("|") + "|Inscribed|Genuine|Heroic|Autographed|Frozen|Corrupted|Exalted|Unusual|Elder|Cursed)\\b", "g"), "").trim() || "Dota 2" };
  }
  // Rust: nomi va turidan toifa
  function rustMeta(name, type) {
    const s = name + " " + (type || "");
    const c = /AK47|AK-47|Assault Rifle|LR-?300|MP5|Thompson|SMG|SAR\b|Semi[- ]Auto|Bolt Action|Python|Revolver|Shotgun|Double Barrel|Waterpipe|M249|L96|M39|Crossbow|\bBow\b|Rocket|Eoka|Nailgun|M92|Spas|HMLMG/i.test(s) ? "weapon"
      : /Hatchet|Pick ?axe|\bRock\b|Salvaged|Machete|Sword|Mace|Knife|Hammer|Jackhammer|Chainsaw|Torch|Spear/i.test(s) ? "tool"
      : /Hoodie|Pants|Jacket|Shirt|T-Shirt|Boots|Shoes|Gloves|\bHat\b|\bCap\b|Beanie|Bandana|Mask|Helmet|Facemask|Chest ?plate|Kilt|Vest|Coat|Burlap|Hide|Balaclava|Tank Top|Poncho|Skirt|Shorts/i.test(s) ? "clothing"
      : /Door|\bBox\b|Sleeping Bag|\bRug\b|Furnace|Locker|Garage|Window|Sign|Fridge|Chair|Table|Barricade|\bBed\b|Vending|Storage|Large Wood|Bench|Sofa|Drop Box|Water Purifier/i.test(s) ? "deploy" : "other";
    return { c, r: RUST_COLOR, rn: "", w: str(type || "Rust", 40) };
  }
  // Dota 2: nomidan taxminiy toifa (Steam'dan turi kelmagan narsalar uchun)
  const dotaGuess = n => ({ c: /Treasure|Chest|Cache|Trove|Crate/i.test(n) ? "treasure" : /\bWard\b/i.test(n) ? "ward" : /Bundle|\bSet\b|Collection|Pack\b/i.test(n) ? "bundle"
    : /Taunt/i.test(n) ? "taunt" : /Courier|Roshan|Greevil/i.test(n) ? "courier" : "other" });
  /* ---------- Dota 2 / Rust: Steam bozoridan rasm, turi va ommabopligi ----------
     Steam search/render so'rovga 10 tagacha natija beradi va tez so'ralsa 429 qaytaradi — shuning uchun
     sekin, sahifalab (start += kelgan soni) va 429 da kutib olinadi. Natija diskda saqlanadi (haftada bir yangilanadi). */
  const SC = {};   // o'yin -> { items, ts }
  const scFile = g => path.join(ctx.DATA_DIR, "steam-" + g + ".json");
  function loadSteamCache(g) { try { const j = JSON.parse(fs.readFileSync(scFile(g), "utf8")); if (Array.isArray(j.items)) SC[g] = { items: j.items, ts: j.ts || 0 }; } catch (e) {} }
  async function crawlSteam(g) {
    const appid = GAMES[g].appid, max = Number(process.env["STEAM_MAX_" + g.toUpperCase()]) || (g === "dota2" ? 2500 : 1500);
    const delay = Number(process.env.STEAM_DELAY_MS) || 4000, wait429 = Number(process.env.STEAM_429_MS) || 90000;
    const C = cat(g), items = [], seen = new Set();
    let start = 0, total = Infinity, fails = 0, calls = 0;
    const keep = () => { if (items.length) { SC[g] = { items: items.slice(), ts: Date.now() }; fs.writeFile(scFile(g), JSON.stringify({ ts: Date.now(), items }), () => {}); } };
    while (items.length < max && start < total && calls < 800) {
      calls++;
      const url = STEAM_URL() + "?appid=" + appid + "&norender=1&count=100&start=" + start + "&sort_column=popular&sort_dir=desc&search_descriptions=0&l=english";
      const r = await getJson(url, { timeout: 30000, limit: 8e6 });
      const res = r.json && r.json.success !== false && Array.isArray(r.json.results) ? r.json.results : null;
      if (!res) { if (++fails >= 6) break; await sleep(r.status === 429 ? wait429 : delay * 3); continue; }
      fails = 0;
      const tc = Number(r.json.total_count); if (tc >= 0) total = tc;
      if (!res.length) break;
      for (const x of res) {
        const d = x.asset_description || {}, n = str(x.hash_name || d.market_hash_name || x.name, 200);
        if (!n || seen.has(n) || !d.icon_url) continue;
        const img = "https://community.cloudflare.steamstatic.com/economy/image/" + String(d.icon_url).replace(/[^\w-]/g, "") + "/360fx360f";
        if (!IMG_OK(img)) continue;
        seen.add(n);
        const meta = g === "dota2" ? dotaMeta(d.type) : rustMeta(n, d.type);
        items.push({ n, s: str(x.name || n, 200), w: meta.w, c: meta.c, r: meta.r, rn: meta.rn, wr: "", st: false, sv: false, i: img, pop: items.length + 1 });
      }
      start += res.length;
      C.crawl = { got: items.length, total: total === Infinity ? 0 : total };
      // Har 20 sahifada katalog yangilanadi — ommabop narsalar rasmi va turi bilan darhol ko'rinadi
      if (calls % 20 === 0) { keep(); buildCatalog(g); }
      await sleep(delay);
    }
    keep();
    return { ok: items.length > 0, count: items.length, error: items.length ? "" : "Steam bozori javob bermadi" };
  }
  // Dota 2 / Rust katalogi = Steam'dan olingan narsalar (rasm, turi, noyoblik) + lis-skins'da sotuvdagi qolganlari
  // (rasmi — Steam sinf raqami item_class_id orqali). Shunda do'konda aynan sotib olish mumkin bo'lganlar ko'rinadi.
  function buildCatalog(g) {
    const C = cat(g), S = (SC[g] && SC[g].items) || [], P = pr(g), have = new Set(S.map(x => x.n)), extra = [];
    if (P.map) {
      const rows = [...P.map.entries()].filter(([n]) => !have.has(n)).sort((a, b) => b[1].cnt - a[1].cnt);
      for (const [n, v] of rows) {
        const ci = P.cls && P.cls.get(n); if (!ci) continue;
        const meta = g === "dota2" ? dotaGuess(n) : rustMeta(n, "");
        extra.push({ n, s: n, w: g === "rust" ? meta.w : "", c: meta.c, r: g === "rust" ? RUST_COLOR : "#b0c3d9", rn: "", wr: "", st: false, sv: false,
          i: "https://community.cloudflare.steamstatic.com/economy/image/class/" + GAMES[g].appid + "/" + ci + "/360fx360f", pop: 100000 + extra.length });
        if (extra.length >= 30000) break;
      }
    }
    const items = S.concat(extra);
    C.steamN = S.length; C.lisN = extra.length;
    if (items.length < 20) return { ok: false, error: "katalog uchun ma'lumot kam (Steam: " + S.length + ", lis-skins: " + extra.length + ")" };
    index(items, g); saveCatalog(g, items);
    return { ok: true, count: items.length };
  }
  function downloadCatalog(g) {
    g = gameOf(g);
    const C = cat(g);
    if (C.loading) return C.loading;
    const job = g === "cs2" ? downloadCs2() : (async () => {
      if (!pr(g).map && ready(g)) await loadPrices(g, true);   // lis-skins'da sotuvdagilar (nomi, sinf raqami)
      if (pr(g).map) buildCatalog(g);                          // darhol — Steam'ni kutmasdan
      const r1 = await crawlSteam(g);
      const r2 = buildCatalog(g);
      C.warn = r1.ok ? "" : r1.error;
      return r2.ok ? r2 : { ok: false, error: r2.error + (r1.ok ? "" : "; " + r1.error) };
    })();
    C.loading = job.catch(e => ({ ok: false, error: e.message }))
      .then(r => { C.err = r.ok ? "" : r.error; C.crawl = null; console.log("[skins] " + g + " katalog: " + (r.ok ? r.count + " ta" : r.error)); return r; })
      .finally(() => { C.loading = null; });
    return C.loading;
  }
  /* ---------- toifa va qurol rasmlari (qo'lda chizilgan belgi emas — o'yindagi haqiqiy rasmlar) ----------
     CS2: har toifa uchun o'yindagi standart qurol rasmi (AK-47, AWP, Desert Eagle, Karambit, Sport Gloves…);
     Dota 2 / Rust (va CS2 zaxira): shu toifadagi eng noyob predmetning rasmi. */
  const BASE = { img: new Map(), ts: 0, file: path.join(ctx.DATA_DIR, "cs2-base.json"), loading: null };
  try { const j = JSON.parse(fs.readFileSync(BASE.file, "utf8")); for (const [k, v] of j.items || []) if (IMG_OK(v)) BASE.img.set(k, v); BASE.ts = j.ts || 0; } catch (e) {}
  function loadBase() {
    const u = BASE_URL(); if (!u || BASE.loading) return BASE.loading;
    BASE.loading = getJson(u, { timeout: 60000, limit: 5e6 }).then(r => {
      if (r.error || !Array.isArray(r.json)) { console.log("[skins] qurol rasmlari yuklanmadi: " + (r.error || "format")); return; }
      const mm = new Map(); for (const x of r.json) if (x && typeof x.name === "string" && IMG_OK(x.image)) mm.set(x.name.slice(0, 60), x.image);
      if (mm.size < 10) return;
      BASE.img = mm; BASE.ts = Date.now(); fs.writeFile(BASE.file, JSON.stringify({ ts: BASE.ts, items: [...mm] }), () => {});
    }).finally(() => { BASE.loading = null; });
    return BASE.loading;
  }
  setTimeout(() => { if (Date.now() - BASE.ts > 7 * 86400e3) loadBase(); }, 6000).unref();
  { const t = setInterval(() => { if (Date.now() - BASE.ts > 7 * 86400e3) loadBase(); }, 12 * 3600e3); if (t.unref) t.unref(); }
  const CAT_REP = { knife: "Karambit", gloves: "Sport Gloves", rifle: "AK-47", sniper: "AWP", pistol: "Desert Eagle", smg: "P90", heavy: "Nova" };
  const CI_C = {};
  function catImgs(g) {
    const C = cat(g), k = C.TS + "|" + BASE.ts + "|" + C.GROUPS.length;
    if (CI_C[g] && CI_C[g].k === k) return CI_C[g].map;
    const best = {};
    for (const G of C.GROUPS) { if (!G.i || !G.c) continue; const sc = RARITY_RANK[G.r] ?? 9; if (!best[G.c] || sc < best[G.c].sc) best[G.c] = { sc, i: G.i }; }
    const map = {}; for (const c of Object.keys(best)) map[c] = best[c].i;
    if (g === "cs2") for (const c of Object.keys(CAT_REP)) { const b = BASE.img.get(CAT_REP[c]); if (b) map[c] = b; }
    CI_C[g] = { k, map };
    return map;
  }
  // Katalog eskirganmi: CS2 — katalog sanasi, Dota 2 / Rust — Steam ma'lumoti sanasi (haftada bir)
  const catStale = g => Date.now() - (g === "cs2" ? cat(g).TS : (SC[g] ? SC[g].ts : 0)) > 7 * 86400e3;
  // Ishga tushganda: diskdagisi yuklanadi; eski yoki yo'q bo'lsa — yangilanadi (Dota/Rust faqat yoqilgan bo'lsa)
  setTimeout(() => {
    for (const g of GAME_KEYS) if ((!cat(g).list.length || catStale(g)) && (g === "cs2" || cfg().games[g])) downloadCatalog(g);
  }, 5000).unref();
  { const t = setInterval(() => { for (const g of GAME_KEYS) if (catStale(g) && (g === "cs2" || cfg().games[g])) downloadCatalog(g); }, 6 * 3600e3); if (t.unref) t.unref(); }
  for (const g of GAME_KEYS) { loadCatalogFromDisk(g); if (g !== "cs2") loadSteamCache(g); }

  /* ---------- oqim bilan JSON ro'yxat o'qish ----------
     lis-skins to'liq ro'yxatlari katta (Dota 2 ~75 MB, CS2 undan ham katta). Butunicha JSON.parse qilinsa xotira
     bir necha yuz MB ga sakraydi — shuning uchun massivdagi har obyekt alohida o'qiladi (xotira deyarli o'smaydi).
     Massiv topilmasa (masalan nom → narx obyekti) va fayl kichik bo'lsa — odatdagidek butunicha o'qiladi. */
  const { StringDecoder } = require("string_decoder");
  function streamList(url, onItem, opts) {
    opts = opts || {};
    const keepMax = opts.keep || 30e6, limit = opts.limit || 800e6;
    return new Promise(resolve => {
      let n = 0, bytes = 0, done = false, kept = [], keepOk = true;
      let inStr = false, esc = false, cap = null, capStart = 0, capLevel = -1;
      const st = [];
      const fin = o => { if (!done) { done = true; resolve(Object.assign({ url, n, bytes }, o)); } };
      const scan = s => {
        if (cap) capStart = 0;
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
          if (c === 34) { inStr = true; continue; }
          if (c === 123 || c === 91) {   // { [
            if (c === 123 && !cap && st.length && st[st.length - 1] === 91) { cap = []; capStart = i; capLevel = st.length; }
            st.push(c);
          } else if (c === 125 || c === 93) {   // } ]
            st.pop();
            if (cap && c === 125 && st.length === capLevel) {
              cap.push(s.slice(capStart, i + 1));
              const txt = cap.join(""); cap = null;
              let o = null; try { o = JSON.parse(txt); } catch (e) {}
              if (o && typeof o === "object") { n++; try { onItem(o); } catch (e) {} }
            }
          }
        }
        if (cap) cap.push(s.slice(capStart));
      };
      const get = (u, depth) => lib(u).get(u, { timeout: opts.timeout || 120000, headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (VerionShop)" } }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) { r.resume(); return get(new URL(r.headers.location, u).toString(), depth + 1); }
        if (r.statusCode !== 200) { r.resume(); return fin({ error: "HTTP " + r.statusCode, status: r.statusCode }); }
        const dec = new StringDecoder("utf8");
        r.on("data", ch => {
          if (done) return;
          bytes += ch.length;
          if (bytes > limit) { r.destroy(); return fin({ error: "juda katta" }); }
          const s = dec.write(ch);
          if (keepOk) { if (bytes <= keepMax) kept.push(s); else { keepOk = false; kept = []; } }
          scan(s);
        });
        r.on("end", () => {
          if (done) return;
          const s = dec.end(); if (s) { scan(s); if (keepOk) kept.push(s); }
          if (n) return fin({});
          if (keepOk) { try { return fin({ json: JSON.parse(kept.join("")) }); } catch (e) { return fin({ error: "JSON emas (" + Math.round(bytes / 1024) + " KB)" }); } }
          fin({ error: "ro'yxat topilmadi (" + Math.round(bytes / 1024) + " KB)" });
        });
        r.on("error", e => fin({ error: e.message }));
      }).on("timeout", function () { this.destroy(new Error("timeout")); }).on("error", e => fin({ error: e.message }));
      try { get(url, 0); } catch (e) { fin({ error: e.message }); }
    });
  }

  /* ---------- eng arzon narxlar ro'yxati (lis-skins JSON Price Lists, har o'yin uchun) ----------
     lis-skins butun bozorning narxlarini JSON qilib beradi. Bo'lsa — katalogda har skinning "...dan" narxi va
     "sotuvda bor" belgisi shundan olinadi (10 daqiqada; katta ro'yxat — 30 daqiqada yangilanadi).
     To'liq ro'yxatdagi item_class_id — Dota 2 / Rust katalogidagi rasm uchun. Bo'lmasa — narxlar API qidiruvidan. */
  const PR = {};   // o'yin -> { map, cls, ts, src, diag, busy, bytes }
  const pr = g => PR[g] || (PR[g] = { map: null, cls: null, ts: 0, src: "", diag: [], busy: false, bytes: 0 });
  const BIG = () => Number(process.env.LIS_BIG_BYTES) || 20e6;
  // Admin o'zi havola kiritsa — o'sha; aks holda ma'lum manzillar ketma-ket sinaladi (birinchi ishlagani eslab qolinadi).
  const PRICE_URLS = g => {
    const c = cfg(), l = GAMES[g].lis, env = process.env[g === "cs2" ? "LIS_PRICES_URL" : "LIS_PRICES_URL_" + g.toUpperCase()];
    // Hujjatdagi manzillar: qisqa ro'yxat (nom → narx, soni) va to'liq ro'yxat (har taklif alohida)
    return [c.pricesUrls[g], g === "cs2" ? c.pricesUrl : "", env, "https://lis-skins.com/market_export_json/" + l + ".json",
      "https://lis-skins.com/market_export_json/api_" + l + "_full.json"]
      .filter((u, i, a) => u && a.indexOf(u) === i);
  };
  async function loadPrices(g, force) {
    if (!g) { for (const k of GAME_KEYS) if (ready(k)) await loadPrices(k, force); return; }
    const P = pr(g);
    if (P.busy || !ready(g)) return;
    // Katta ro'yxat (o'nlab MB) har 10 daqiqada emas, 30 daqiqada bir yuklanadi
    if (!force && P.map && P.bytes > BIG() && Date.now() - P.ts < 30 * 60e3) return;
    P.busy = true;
    const diag = [];
    try {
      const urls = PRICE_URLS(g);
      if (P.src && urls.indexOf(P.src) > 0) { urls.splice(urls.indexOf(P.src), 1); urls.unshift(P.src); }
      for (const url of urls) {
        const m = new Map(), cls = new Map(), onlyU = cfg().onlyUnlocked;
        const add = x => {
          const name = pick(x, ["name", "market_hash_name"]), usd = Number(pick(x, ["price", "min_price", "price_usd"]));
          if (!name || typeof name !== "string" || !(usd > 0)) return;
          // To'liq ro'yxatda har taklif alohida qator: trade-lock'dagilari (sozlamaga ko'ra) hisobga olinmaydi
          const ul = x.unlock_at; if (ul && onlyU && Date.parse(ul) > Date.now()) return;
          const cnt = Number(pick(x, ["count", "quantity", "amount"])) || 1;
          const h = m.get(name);
          if (!h || usd < h.usd) m.set(name, { usd, cnt: (h ? h.cnt : 0) + cnt }); else h.cnt += cnt;
          const ci = x.item_class_id; if (ci != null && !cls.has(name) && /^\d{1,20}$/.test(String(ci))) cls.set(name, String(ci));
        };
        const r = await streamList(url, add);
        if (r.error) { diag.push({ url, error: r.error }); continue; }
        if (!r.n && r.json) {
          const j = r.json;
          (listOf(j).length ? listOf(j) : (j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j).map(k => Object.assign({ name: k }, typeof j[k] === "object" ? j[k] : { price: j[k] })) : [])).forEach(add);
        }
        diag.push({ url, rows: m.size, kb: Math.round(r.bytes / 1024) });
        if (m.size > (g === "cs2" ? 500 : 50)) {
          P.map = m; P.cls = cls.size ? cls : (P.src === url ? P.cls : null); P.ts = Date.now(); P.src = url; P.bytes = r.bytes;
          if (g !== "cs2" && !cat(g).loading) buildCatalog(g);   // yangi sotuvdagilar katalogga qo'shiladi
          break;
        }
      }
    } finally { P.diag = diag; P.busy = false; }
  }
  setTimeout(() => loadPrices().catch(() => {}), 8000).unref();
  { const t = setInterval(() => loadPrices().catch(() => {}), 10 * 60e3); if (t.unref) t.unref(); }
  const pricesFresh = g => !!pr(g).map && Date.now() - pr(g).ts < 60 * 60e3;
  // f — mijoz filtrlari: wear (FN..BS), types (st/sv/plain), umin/umax (so'mda narx oralig'i)
  function fromOf(G, f, g) {
    const c = cfg(), C = cat(g), P = pr(g).map; let best = null, cnt = 0;
    for (const n of G.v) {
      if (f && f.wear.length && f.wear.indexOf((C.BY_NAME.get(n) || {}).wr) === -1) continue;
      if (f && f.types.length) {   // st — StatTrak™, sv — Souvenir, plain — oddiy
        const t = n.indexOf("StatTrak™") !== -1 ? "st" : /^Souvenir /.test(n) ? "sv" : "plain";
        if (f.types.indexOf(t) === -1) continue;
      }
      const p = P.get(n);
      if (!p || p.usd < c.minUsd || p.usd > c.maxUsd) continue;
      if (f && (f.umin || f.umax)) { const so = uzs(p.usd); if ((f.umin && so < f.umin) || (f.umax && so > f.umax)) continue; }
      cnt += p.cnt; if (best === null || p.usd < best) best = p.usd;
    }
    return { usd: best, cnt };
  }

  /* ---------- takliflar (lis-skins) ---------- */
  // Mijozga ko'rsatilgan har taklif eslab qolinadi: xarid shu narx bilan (max_price) qilinadi.
  const OFFERS = new Map();   // id -> { usd, name, float, insp, game, ts, unlockAt, live }
  const GONE = new Map();     // WebSocket: bozordan o'chgan takliflar (id -> vaqt)
  const BUYING = new Set();   // hozir xarid qilinayotgan takliflar (bir taklifni ikki kishi bir vaqtda ololmaydi)
  function rememberOffer(o, g) {
    OFFERS.set(o.id, { usd: o.usd, name: o.name, float: o.float, insp: o.insp, game: g || "cs2", ts: Date.now(), unlockAt: o.unlockAt || 0 });
    if (OFFERS.size > 20000) { const cut = Date.now() - 20 * 60e3; for (const [k, v] of OFFERS) if (v.ts < cut) OFFERS.delete(k); }
  }
  // Stiker va Dota 2 toshlari rasmlari faqat shu manzillardan
  const IMG_EXTRA = u => /^https:\/\/(steamcdn-a\.akamaihd\.net|[a-z0-9.-]+\.steamstatic\.com|lis-skins\.(com|ru))\/[\w%.\/-]+$/i.test(String(u || "")) && String(u).length < 400;
  function normOffer(x) {
    if (!x || typeof x !== "object") return null;
    const id = pick(x, ["id", "item_id", "skin_id"]);
    const name = pick(x, ["name", "market_hash_name", "full_name", "title"]);
    const usd = Number(pick(x, ["price", "price_usd", "usd", "amount"]));
    const fl = pick(x, ["item_float", "float", "float_value", "floatvalue"]);
    const unlock = pick(x, ["unlock_at", "unlocked_at", "hold_until", "trade_lock_until"]);
    if (id == null || !name || !(usd > 0)) return null;
    const ua = unlock ? Date.parse(unlock) : NaN;
    // O'yinda ko'rish havolasi (faqat CS2 inspect), stikerlar, nom yorlig'i, pattern
    const link = String(pick(x, ["item_link", "inspect_link", "inspect"]) || "");
    const sr = (Array.isArray(x.stickers) ? x.stickers : []).slice(0, 6);
    const stk = sr.map(t => str(t && typeof t === "object" ? pick(t, ["name", "title", "market_hash_name"]) : t, 80).replace(/^Sticker \| /, "")).filter(Boolean);
    const stki = sr.filter(t => t && (typeof t !== "object" || pick(t, ["name", "title", "market_hash_name"]))).map(t => t && typeof t === "object" && IMG_EXTRA(t.image) ? t.image : "");
    // Dota 2: toshlar (gems) va ochilgan uslublar (styles)
    const gems = (Array.isArray(x.gems) ? x.gems : []).slice(0, 6).map(m => m && typeof m === "object" ? {
      n: str(m.name, 60), d: str(m.description, 90), c: /^[0-9a-f]{6}$/i.test(String(m.color || "")) ? "#" + m.color : "",
      img: Array.isArray(m.image_urls) && IMG_EXTRA(m.image_urls[0]) ? m.image_urls[0] : "" } : null).filter(m => m && m.n);
    const styles = x.styles && typeof x.styles === "object" && !Array.isArray(x.styles) ? Object.keys(x.styles).filter(k => x.styles[k] === true).slice(0, 8).map(k => str(k, 50)) : [];
    const cls = String(pick(x, ["item_class_id"]) || "");
    const seedRaw = pick(x, ["item_paint_seed", "paint_seed", "pattern"]), seed = seedRaw == null ? NaN : Number(seedRaw);   // yo'q bo'lsa 0 emas, null
    return { id: String(id), name: String(name), usd, float: fl != null && isFinite(Number(fl)) ? Number(fl) : null,
      locked: ua > Date.now(), unlockAt: ua > Date.now() ? ua : 0, slow: Number(x.delivery_type) === 2, cls: /^\d{1,20}$/.test(cls) ? cls : "",
      insp: /^steam:\/\/(run|rungame)\/730\/[\w%+\/.-]*$/i.test(link) && link.length < 400 ? link : "",
      stk, stki, gems, styles, nt: str(pick(x, ["name_tag", "nametag"]) || "", 60), seed: Number.isInteger(seed) && seed >= 0 && seed < 100000 ? seed : null };
  }
  function pubOffer(o, g) {
    g = g || "cs2";
    const e = cat(g).BY_NAME.get(o.name) || {};
    // Katalogda rasm bo'lmasa — Steam'ning sinf (class_id) rasmi
    const img = e.i || (o.cls ? "https://community.cloudflare.steamstatic.com/economy/image/class/" + GAMES[g].appid + "/" + o.cls + "/360fx360f" : "");
    return { id: o.id, game: g, name: o.name, b: baseOf(o.name, g), w: e.w || "", s: e.s || "", price: uzs(o.usd), float: o.float, wear: e.wr || "",
      img, rc: e.r || (g === "rust" ? RUST_COLOR : "#b0c3d9"), rn: e.rn || "", cat: e.c || "other", st: /StatTrak/.test(o.name), sv: /^Souvenir /.test(o.name),
      locked: !!o.locked, lockDays: o.unlockAt ? Math.max(1, Math.ceil((o.unlockAt - Date.now()) / 86400e3)) : 0, slow: !!o.slow,
      insp: !!o.insp, stk: o.stk || [], stki: o.stki || [], gems: o.gems || [], styles: o.styles || [], nt: o.nt || "", seed: o.seed == null ? null : o.seed };
  }
  const CACHE = new Map();   // so'rov -> { ts, val }
  // lis-skins'ga keshdan tashqari so'rovlar chegarasi: daqiqasiga jami 150 (sayt limiti 200), bitta mijozdan 20
  // (aks holda kimdir qidiruvni ketma-ket bosib kalitimizni sayt limitiga tiqib qo'yishi mumkin).
  const BUDGET = { min: 0, n: 0 }, PER_USER = new Map();
  function allow(uid) {
    if (Date.now() < coolUntil) return false;   // lis-skins 429 qaytargan — retry-after tugaguncha kutamiz
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
  // params: lis-skins market/search parametrlari (names, sort_by, cursor, price_from/to, float_from/to, unlock_days, only_unlocked)
  async function search(params, g) {
    g = g || "cs2";
    const c = cfg(), p = Object.assign({ game: GAMES[g].lis, only_unlocked: c.onlyUnlocked ? 1 : 0 }, params);
    if (c.onlyUnlocked) { p.only_unlocked = 1; delete p.unlock_days; }
    // Admin narx oralig'i ($) lis-skins'ga ham beriladi — aks holda "arzon avval" sahifasi oraliqdan tashqaridagilar bilan to'lib, bo'sh chiqadi
    p.price_from = Math.max(Number(p.price_from) || 0, c.minUsd); p.price_to = Math.min(Number(p.price_to) || Infinity, c.maxUsd);
    if (g !== "cs2") { delete p.float_from; delete p.float_to; }
    const r = await call("GET", "market/search", { params: p });
    if (!r.json || r.status >= 400) throw new Error(errOf(r.json) || r.error || ("HTTP " + r.status));
    const items = listOf(r.json).map(normOffer).filter(Boolean)
      .filter(o => o.usd >= c.minUsd && o.usd <= c.maxUsd && (!c.onlyUnlocked || !o.locked) && !GONE.has(o.id));
    items.forEach(o => rememberOffer(o, g));
    return { items, next: str(pick(r.json, ["meta.next_cursor", "next_cursor", "meta.cursor"]) || "", 200) };
  }

  /* ---------- buyurtma va pul ---------- */
  const ALERT = {};
  function alertOnce(key, text) {
    const now = Date.now(); if (ALERT[key] && now - ALERT[key] < 10 * 60e3) return;
    if (Object.keys(ALERT).length > 200) for (const k of Object.keys(ALERT)) delete ALERT[k];
    ALERT[key] = now; ctx.notifyAdmins(text);
  }
  // amt — qaytariladigan summa (berilmasa to'liq narx). Faqat kutilayotgan buyurtma uchun, bir marta.
  function refund(o, why, amt) {
    if (o.status !== "pending") return;
    const sum = amt == null ? o.price : Math.max(0, Math.min(o.price, Math.round(amt)));
    o.status = "cancelled"; o.cancelReason = why || "";
    const acc = DBx().users[String(o.uid)] || (DBx().users[String(o.uid)] = { balance: 0 });
    acc.balance += sum; o.refunded = true; o.refundAmt = sum;
    ctx.save();
    ctx.tgSend(o.uid, "❌ " + o.item + " — bekor qilindi, " + money(sum) + " balansingizga qaytarildi." + (why ? "\n" + why : ""));
    ctx.notifyOrderChannel(o);
  }
  function markDone(o) {
    if (o.status !== "pending") return;
    o.status = "done"; o.doneTs = Date.now(); o.cs2.state = "done";
    RECENT = {};
    o.delivered = (GAMES[o.cs2.game || "cs2"] || GAMES.cs2).icon + " " + o.cs2.name + (o.cs2.float != null ? " (float " + o.cs2.float.toFixed(4) + ")" : "") + " — Steam hisobingizga tushdi.";
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
  const offerUrl = o => o.cs2 && o.cs2.tradeId ? "https://steamcommunity.com/tradeoffer/" + o.cs2.tradeId + "/" : STEAM_OFFERS;
  // lis-skins xato kodlari (hujjat) → mijozga tushunarli matn
  const STEAM_ERR = {
    invalid_trade_url: "Steam trade havolangiz eskirgan yoki noto'g'ri — yangisini kiriting.",
    user_cant_trade: "Steam akkauntingiz hozir savdo qila olmaydi (Steam Guard 7 kundan kam yoqilgan yoki Steam cheklovi).",
    private_inventory: "Steam inventaringiz yopiq — Steam → Profil → Maxfiylik sozlamalarida «Inventar: Ochiq» qiling.",
    user_trade_ban: "Steam akkauntingizda savdo taqiqi bor.",
    user_inventory_full: "Steam inventaringiz to'lib qolgan — joy bo'shating.",
    too_many_failed_attempts_for_user: "Bu Steam akkaunt uchun urinishlar ko'p bo'ldi — birozdan keyin urinib ko'ring.",
    unknown_error: "Steam xatosi — birozdan keyin urinib ko'ring."
  };
  const RETURN_WHY = {
    trade_timeout: "Steam'dagi trade taklifi muddatida qabul qilinmadi.",
    trade_canceled: "Steam'dagi trade taklifi bekor qilindi.",
    trade_create_error: "Steam'da trade taklifini yaratib bo'lmadi.",
    manual_cancel: "Xarid bekor qilindi.",
    wait_withdraw_timeout: "Skin trade-lock'dan chiqqach o'z vaqtida yuborilmadi.",
    rollback_user: "Steam'dagi trade qaytarildi.",
    rollback_supplier: "Sotuvchi tomonidan trade qaytarildi."
  };
  const errCode = j => str(j && (typeof j.error === "string" ? j.error : j.error && (j.error.code || j.error.message)) || (j && j.message) || "", 80).split(/[\s(]/)[0];
  const ok2 = (code, body) => ({ code, body });
  async function buy(u, offerId) {
    const c = cfg(), id = String(offerId == null || typeof offerId === "object" ? "" : offerId).slice(0, 40);
    const of = OFFERS.get(id), g = of ? of.game : "cs2", G = GAMES[g];
    if (!ready(g)) return ok2(503, { error: "off", message: "Skinlar do'koni hozircha yopiq" });
    const acc = ctx.user(u), tu = parseTrade(acc.cs2Trade);
    if (!tu) return ok2(400, { error: "trade_url", message: "Avval Steam trade havolangizni kiriting" });
    if (acc.steam && tu.partner !== accountIdOf(acc.steam.id)) return ok2(400, { error: "trade_url", message: "Trade havola ulangan Steam akkauntiga tegishli emas — yangisini kiriting" });
    if (of && GONE.has(id)) { OFFERS.delete(id); return ok2(409, { error: "gone", message: "Bu skin sotilib ketdi — boshqasini tanlang" }); }
    if (!of || Date.now() - of.ts > 15 * 60e3) return ok2(409, { error: "stale", message: "Narxlar yangilandi — skinni qaytadan oching" });
    if (of.unlockAt && c.onlyUnlocked) return ok2(409, { error: "gone", message: "Bu skin hozir sotilmaydi — boshqasini tanlang" });
    if (BUYING.has(id)) return ok2(409, { error: "gone", message: "Bu skinni hozir boshqa xaridor olmoqda" });
    if (!(acc.balance >= uzs(of.usd))) return ok2(402, { error: "balance", need: uzs(of.usd) - acc.balance });
    BUYING.add(id);
    try {
      const idParam = /^\d+$/.test(id) ? Number(id) : id;
      // Pul yechilishidan oldin: hali sotuvdami va narxi o'zgarmadimi (lis-skins check-availability; WebSocket xabari ham hisobga olinadi)
      let now = of.live > 0 ? of.live : 0;
      if (allow(u.id)) {
        const ca = await call("GET", "market/check-availability", { params: { ids: [idParam] }, timeout: 8000 });
        const d = ca.status === 200 && ca.json && ca.json.data;
        if (d && typeof d === "object") {
          const un = (Array.isArray(d.unavailable_skin_ids) ? d.unavailable_skin_ids : []).map(String);
          const av = d.available_skins && typeof d.available_skins === "object" ? d.available_skins : {};
          if (un.indexOf(id) !== -1) { OFFERS.delete(id); GONE.set(id, Date.now()); return ok2(409, { error: "gone", message: "Bu skin sotilib ketdi — boshqasini tanlang" }); }
          if (Number(av[id]) > 0) now = Number(av[id]);
        }
      }
      if (OFFERS.get(id) !== of || GONE.has(id)) return ok2(409, { error: "gone", message: "Bu skin sotilib ketdi — boshqasini tanlang" });
      if (now > 0) {
        if (now > c.maxUsd) { OFFERS.delete(id); return ok2(409, { error: "gone", message: "Bu skin hozir sotilmaydi — boshqasini tanlang" }); }
        if (uzs(now) > uzs(of.usd)) {   // qimmatlashgan — mijoz yangi narxni ko'rib qayta tasdiqlaydi
          of.usd = now; of.ts = Date.now(); of.live = 0;
          return ok2(409, { error: "price", price: uzs(now), message: "Narx o'zgardi: " + money(uzs(now)) + " — qayta tasdiqlang" });
        }
        if (now < of.usd) of.usd = now;   // arzonlashgan — mijoz kamroq to'laydi
      }
      const price = uzs(of.usd);
      if (!(acc.balance >= price)) return ok2(402, { error: "balance", need: price - acc.balance });
      acc.balance -= price;
      const e = cat(g).BY_NAME.get(of.name) || {};
      const o = { id: ctx.genId("VN"), seq: ctx.nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: (g === "cs2" ? "cs2:" : g + ":") + id,
        item: G.icon + " " + G.label + ": " + of.name, price, status: "pending", ts: Date.now(), delivered: null, doneTs: null, quantity: 1,
        cs2: { game: g, name: of.name, offerId: id, usd: of.usd, float: of.float, img: e.i || "", partner: tu.partner, token: tu.token, state: "buying",
          unlockAt: of.unlockAt || null },
        costUzs: Math.round(of.usd * c.rate) };
      DBx().orders.push(o); ctx.save(); ctx.notifyOrder(o);
      OFFERS.delete(id);
      const r = await call("POST", "market/buy", { timeout: Number(process.env.CS2_BUY_TIMEOUT) || 30000, json: { ids: [idParam],
        partner: tu.partner, token: tu.token, max_price: Math.round(of.usd * 100) / 100, custom_id: o.id } });
      const j = r.json, code = errCode(j), msg = errOf(j);
      if (r.sent && j && r.status >= 200 && r.status < 300 && !(j.error || j.success === false || j.status === false)) {
        o.cs2.purchaseId = str(pick(j, ["data.purchase_id", "purchase_id", "data.id", "id", "data.0.purchase_id"]) || "", 60);
        o.cs2.state = "sent";
        const sk = j.data && Array.isArray(j.data.skins) ? j.data.skins[0] : null;
        if (sk) { applySkin(o, sk); if (o.status === "pending") settle(o, sk.status, true); }
        ctx.save();
        if (o.status === "cancelled" && !o.cs2.cancelReq) ctx.notifyAdmins("⚠️ #" + o.seq + " " + G.label + ": " + of.name + " — buyurtma admin tomonidan bekor qilingan, lekin lis-skins xaridni bajardi (skin mijozga yuborildi). Tekshiring.", { order: o });
        return ok2(200, { ok: true, order: ctx.pubOrder(o), balance: acc.balance, steamOffers: STEAM_OFFERS });
      }
      // Shu custom_id bilan xarid allaqachon bor — demak sotib olingan: holat tekshiruvda aniqlanadi
      if (r.sent && code === "custom_id_already_exists") {
        o.cs2.state = "unknown"; ctx.save();
        return ok2(200, { ok: true, pending: true, order: ctx.pubOrder(o), balance: acc.balance, steamOffers: STEAM_OFFERS });
      }
      if (r.sent && (r.status === 401 || r.status === 403)) {
        alertOnce("cs2-auth", "⛔ Skinlar (lis-skins): kalit noto'g'ri yoki ruxsat yo'q (HTTP " + r.status + "). Admin panel → Skinlar do'koni.");
        refund(o, "Skinlar do'koni hozircha ishlamayapti, keyinroq urinib ko'ring.");
        return ok2(503, { error: "off", message: "Hozircha ishlamayapti, keyinroq urinib ko'ring", balance: acc.balance });
      }
      if (r.sent && r.status === 429) {
        refund(o, "Bozor band — birozdan keyin urinib ko'ring.");
        return ok2(429, { error: "busy", message: "Bozor band — birozdan keyin urinib ko'ring", balance: acc.balance });
      }
      // 4xx — so'rov rad etilgan (xarid bo'lmagan) yoki so'rov umuman yetib bormagan: pul qaytadi
      if (!r.sent || (r.status >= 400 && r.status < 500)) {
        const funds = code === "insufficient_funds" || /balance|fund|insufficient|not enough|недостаточно|баланс/i.test(msg);
        if (r.sent && (code === "invalid_trade_url" || code === "invalid_partner_value" || code === "invalid_token_value")) {
          acc.cs2Trade = "";
          refund(o, STEAM_ERR.invalid_trade_url);
          return ok2(400, { error: "trade_url", message: STEAM_ERR.invalid_trade_url, balance: acc.balance });
        }
        if (r.sent && STEAM_ERR[code]) {
          refund(o, STEAM_ERR[code]);
          return ok2(400, { error: "steam", code, message: STEAM_ERR[code], balance: acc.balance });
        }
        if (r.sent && code === "skins_price_higher_than_max_price") {
          refund(o, "Narx o'zgardi — skinni qaytadan oching.");
          return ok2(409, { error: "gone", message: "Narx o'zgardi — skinni qaytadan oching", balance: acc.balance });
        }
        if (funds) alertOnce("cs2-bal", "🚨 Skinlar ishlamayapti — lis-skins hamyonida coin yetarli emas. Hamyonni to'ldiring.");
        else if (r.sent && code !== "skins_unavailable") alertOnce("cs2-rej-" + msg.slice(0, 40), "⚠️ " + G.label + " xaridi rad etildi: " + msg);
        if (code === "skins_unavailable") GONE.set(id, Date.now());
        const userMsg = funds || !r.sent ? "Hozircha ishlamayapti, keyinroq urinib ko'ring" : "Bu skin sotilib ketdi yoki narxi o'zgardi — boshqasini tanlang";
        refund(o, userMsg + ".");
        return ok2(funds || !r.sent ? 503 : 409, { error: funds || !r.sent ? "off" : "gone", message: userMsg, balance: acc.balance });
      }
      // Javob noaniq — sotib olingan bo'lishi mumkin. Pul band, holat custom_id bo'yicha aniqlanadi.
      o.cs2.state = "unknown"; o.cs2.raw = str(r.error || r.text, 200); ctx.save();
      ctx.notifyAdmins("❓ #" + o.seq + " " + G.label + ": " + of.name + " — lis-skins javobi noaniq (" + o.cs2.raw + "). Holati avtomatik tekshirilmoqda.", { order: o });
      return ok2(200, { ok: true, pending: true, order: ctx.pubOrder(o), balance: acc.balance, steamOffers: STEAM_OFFERS });
    } finally { BUYING.delete(id); }
  }
  // Holat so'zlari: avval hujjatdagi aniq nomlar, keyin keng moslik (eski/yangi nomlar uchun)
  const ST_MAP = { processing: "sent", proccessing: "sent", wait_accept: "accept", accepted: "done", return: "failed", wait_unlock: "locked", wait_withdraw: "withdraw" };
  function stateWord(s) {
    s = String(s || "").toLowerCase();
    if (/not[_ -]|return|refund|cancel|fail|declin|expire|error|reject/.test(s)) return "failed";
    if (/accept|complet|success|deliver|done|finish|transferred/.test(s)) return "done";
    if (!s || /process|pend|wait|new|creat|send|sent|queue|hold|lock|progress|trade/.test(s)) return "pending";
    return "other";
  }
  function stateOf(raw) {
    const s = String(raw || "").toLowerCase().trim();
    if (ST_MAP[s]) return ST_MAP[s];
    const w = stateWord(s);
    return w === "pending" ? "sent" : w;
  }
  // lis-skins'dagi bitta skin ma'lumotini buyurtmaga yozadi (holatni o'zgartirmaydi)
  function applySkin(o, sk) {
    if (!sk || typeof sk !== "object") return;
    const C = o.cs2, raw = str(pick(sk, ["status", "state"]) || "", 60);
    if (raw) C.st = raw;
    const tid = String(sk.steam_trade_offer_id || ""); if (/^\d{1,20}$/.test(tid)) C.tradeId = tid;
    const ex = Date.parse(sk.steam_trade_offer_expiry_at || ""); if (ex) C.expiry = ex;
    const ua = Date.parse(sk.unlock_at || ""); if (ua) C.unlockAt = ua;
    if (sk.error && STEAM_ERR[sk.error]) C.err = String(sk.error);
    if (sk.return_reason && RETURN_WHY[sk.return_reason]) C.rr = String(sk.return_reason);
    if (C.float == null && sk.item_float != null && isFinite(Number(sk.item_float))) C.float = Number(sk.item_float);
    if (Number(sk.return_charged_commission) > 0) C.fee = Number(sk.return_charged_commission);
  }
  const SEEN_STATES = new Set();
  // Holatga qarab: bajarildi / pul qaytdi / kutish (yuborilmoqda, qabul kutilmoqda, trade-lock, yuborish kerak)
  function settle(o, raw, quiet) {
    if (o.status !== "pending") return;
    const C = o.cs2, w = stateOf(raw);
    if (raw) C.raw = str(raw, 60);
    if (w === "done") return markDone(o);
    if (w === "failed") {
      if (C.cancelReq && (C.rr === "manual_cancel" || !C.rr)) return refundCancel(o);
      const why = (C.err && STEAM_ERR[C.err]) || (C.rr && RETURN_WHY[C.rr]) || "Trade qabul qilinmadi yoki bekor bo'ldi.";
      if (C.err === "invalid_trade_url") { const acc = DBx().users[String(o.uid)]; if (acc && acc.cs2Trade) acc.cs2Trade = ""; }
      refund(o, why + " Pul balansga qaytdi.");
      ctx.notifyAdmins("↩️ #" + o.seq + " " + C.name + " — lis-skins holati «" + (C.raw || "return") + "»" + (C.rr ? " (" + C.rr + ")" : "") + (C.err ? " [" + C.err + "]" : "") + ", mijozga pul qaytarildi.");
      return;
    }
    if (w === "other") {
      // Hujjatda yo'q holat nomi kelsa — adminga bir marta: shu orqali haqiqiy nomlarni bilib olamiz
      if (!SEEN_STATES.has(C.raw) && SEEN_STATES.size < 50) {
        SEEN_STATES.add(C.raw);
        ctx.notifyAdmins("ℹ️ Skinlar: lis-skins'dan yangi holat keldi: «" + C.raw + "» (#" + o.seq + "). Buyurtma kutishda turibdi — bu xabarni dasturchiga yuboring.");
      }
      if (C.state === "unknown") C.state = "sent";
      ctx.save(); return;
    }
    const prev = C.state; C.state = w;
    ctx.save();
    if (quiet || prev === w) return;
    if (w === "accept") ctx.tgSend(o.uid, "📩 " + C.name + " — Steam'ga trade taklifi yuborildi. " + (C.expiry ? fmtTime(C.expiry) + " gacha " : "") + "qabul qiling: " + offerUrl(o));
    else if (w === "locked") ctx.tgSend(o.uid, "🔒 " + C.name + " sotib olindi. Skin trade-lock'da" + (C.unlockAt ? " — " + fmtTime(C.unlockAt) + " da ochiladi" : "") + " va avtomatik Steam'ga yuboriladi.");
    else if (w === "withdraw" && prev === "locked") ctx.tgSend(o.uid, "🔓 " + C.name + " trade-lock'dan chiqdi — Steam'ga yuborilmoqda.");
  }
  const fmtTime = ts => { try { return new Date(ts).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };
  // Mijoz trade-lock'dagi xaridini bekor qildi: lis-skins 3% komissiya oladi — shuncha ushlab qolinadi
  const cancelFee = o => Math.ceil(o.price * 0.03 / 100) * 100;
  function refundCancel(o) { refund(o, "Trade-lock'dagi xarid bekor qilindi (3% komissiya ushlab qolindi).", o.price - cancelFee(o)); }
  async function cancelLocked(u, oid) {
    const o = DBx().orders.find(x => x.id === oid && String(x.uid) === String(u.id) && x.cs2);
    if (!o) return ok2(404, { error: "not_found" });
    if (o.status !== "pending" || o.cs2.state !== "locked") return ok2(409, { error: "cant", message: "Bu xaridni hozir bekor qilib bo'lmaydi" });
    if (o.cs2.cancelReq && Date.now() - o.cs2.cancelReq < 60e3) return ok2(409, { error: "busy", message: "So'rov yuborilgan — natijani kuting" });
    o.cs2.cancelReq = Date.now(); ctx.save();
    const r = await call("POST", "market/return", { json: { custom_id: o.id }, timeout: 20000 });
    const d = r.status === 200 && r.json ? r.json.data : null, rec = Array.isArray(d) ? d[0] : d;
    const sk = rec && Array.isArray(rec.skins) ? rec.skins[0] : null;
    const acc = ctx.user(u);
    if (sk) {
      applySkin(o, sk);
      if (stateOf(sk.status) === "failed") { refundCancel(o); return ok2(200, { ok: true, order: ctx.pubOrder(o), balance: acc.balance }); }
      o.cs2.cancelReq = 0; settle(o, sk.status, true);
      return ok2(409, { error: "cant", message: "Bekor qilinmadi — skin holati o'zgargan", order: ctx.pubOrder(o) });
    }
    if (r.sent && r.status >= 400 && r.status < 500) { o.cs2.cancelReq = 0; ctx.save(); return ok2(409, { error: "cant", message: "Bu xaridni hozir bekor qilib bo'lmaydi" }); }
    // Javob noaniq — natija keyingi holat tekshiruvida aniqlanadi (bekor bo'lsa 3% ushlab qaytariladi)
    return ok2(202, { ok: true, pending: true, message: "So'rov yuborildi — natija bir necha daqiqada" });
  }
  // Trade-lock'dan chiqqan skinni mijozning hozirgi trade havolasiga yuborish (12 soat ichida kerak)
  async function withdraw(o) {
    o.cs2.wdTs = Date.now(); ctx.save();
    const acc = DBx().users[String(o.uid)] || {}, tu = parseTrade(acc.cs2Trade);
    const r = await call("POST", "market/withdraw", { json: Object.assign({ custom_id: o.id }, tu ? { partner: tu.partner, token: tu.token } : {}), timeout: 20000 });
    if (r.status === 200 && r.json) {
      const rec = listOf(r.json)[0] || (r.json.data && r.json.data.skins ? r.json.data : null);
      const sk = rec && Array.isArray(rec.skins) ? rec.skins[0] : null;
      if (sk) { applySkin(o, sk); settle(o, sk.status); } else if (o.status === "pending") { o.cs2.state = "sent"; ctx.save(); }
      return { ok: true };
    }
    const e = errCode(r.json) || r.error || ("HTTP " + r.status);
    if (e !== "no_suitable_skins_for_withdrawal") alertOnce("cs2-wd-" + o.id, "⚠️ #" + o.seq + " " + o.cs2.name + " — trade-lock'dan chiqqan skinni yuborib bo'lmadi: " + e + ". 12 soat ichida yuborilmasa lis-skins qaytaradi.");
    return { ok: false, error: e };
  }
  // Bir nechta xaridning holati (custom_id va purchase_id bo'yicha) — WebSocket bo'lmasa ham ishlaydi
  const UNKNOWN_MS = Number(process.env.CS2_UNKNOWN_MS) || 15 * 60e3;
  const LIVE_STATES = ["sent", "unknown", "accept", "locked", "withdraw"];
  let polling = false;
  async function poll() {
    if (polling || !ready()) return;
    polling = true;
    try {
      const list = DBx().orders.filter(o => o.status === "pending" && o.cs2 && LIVE_STATES.indexOf(o.cs2.state) !== -1);
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
          if (skins[0]) applySkin(o, skins[0]);
          settle(o, raw);
        }
        // Javob noaniq bo'lgan xarid lis-skins'da custom_id bo'yicha uzoq vaqt topilmasa — demak sotib olinmagan.
        for (const o of chunk) if (o.status === "pending" && o.cs2.state === "unknown" && !seen.has(o.id) && Date.now() - o.ts > UNKNOWN_MS) {
          refund(o, "Xarid amalga oshmadi — pul balansga qaytdi.");
          ctx.notifyAdmins("↩️ #" + o.seq + " " + o.cs2.name + " — lis-skins'da bu xarid topilmadi, mijozga pul qaytarildi.");
        }
      }
      // Trade-lock'dan chiqqanlar — darhol yuboriladi (5 daqiqada bir urinish)
      for (const o of list) if (o.status === "pending" && o.cs2.state === "withdraw" && !(Date.now() - (o.cs2.wdTs || 0) < 5 * 60e3)) await withdraw(o);
      // Trade 2 soatdan beri qabul qilinmagan bo'lsa — mijozga bir marta eslatma.
      for (const o of list) if (o.status === "pending" && (o.cs2.state === "sent" || o.cs2.state === "accept") && !o.cs2.reminded && Date.now() - o.ts > 2 * 3600e3) {
        o.cs2.reminded = true; ctx.save();
        ctx.tgSend(o.uid, "⏳ " + o.cs2.name + " — Steam'dagi trade taklifini qabul qiling" + (o.cs2.expiry ? " (" + fmtTime(o.cs2.expiry) + " gacha)" : "") + ": " + offerUrl(o));
      }
    } catch (e) { console.log("[skins] holat: " + e.message); }
    finally { polling = false; }
  }
  { const t = setInterval(() => { poll(); }, Number(process.env.CS2_POLL_MS) || 60000); if (t.unref) t.unref(); }

  /* ---------- WebSocket (Centrifugo): jonli bozor va xarid holatlari ----------
     public:obtained-skins — yangi / o'chgan / narxi o'zgargan skinlar (qidiruvdan bir necha daqiqa oldin);
     private:purchase-skins#<lis-skins User ID> — xaridlar holati darhol. Uzilsa qayta ulanadi; so'rov orqali tekshiruv baribir ishlaydi. */
  const WS = { state: "off", since: 0, err: "", pub: 0, priv: 0, sock: null, retry: 0, timer: null, ver: 0, last: 0, pong: false, privOk: false };
  const WS_URL = () => process.env.LIS_WS_URL || "wss://ws.lis-skins.com/connection/websocket";
  const LIVE = {};   // o'yin -> WebSocket orqali kelgan eng yangi takliflar (eng yangisi oldin)
  const wsWanted = () => ready() && cfg().ws !== false && typeof WebSocket === "function";
  function wsClose(st) {
    WS.ver++; clearTimeout(WS.timer); WS.timer = null; WS.state = st || "off"; WS.privOk = false;
    const s = WS.sock; WS.sock = null; if (s) try { s.close(); } catch (e) {}
  }
  function wsRetry() {
    if (WS.state === "off") return;
    WS.state = "retry"; clearTimeout(WS.timer);
    const d = Number(process.env.LIS_WS_RETRY_MS) || Math.min(300, 5 * Math.pow(2, WS.retry++)) * 1000;
    WS.timer = setTimeout(() => { WS.timer = null; wsConnect().catch(() => {}); }, d); if (WS.timer.unref) WS.timer.unref();
  }
  async function wsConnect() {
    if (!wsWanted()) { if (WS.sock || WS.state !== "off") wsClose("off"); return; }
    if (WS.sock || WS.state === "connecting") return;
    const ver = ++WS.ver; WS.state = "connecting";
    const t = await call("GET", "user/get-ws-token", { timeout: 15000 });
    if (ver !== WS.ver) return;
    const token = t.json && pick(t.json, ["data.token", "token"]);
    if (!token) { WS.err = "token: " + (errOf(t.json) || t.error || ("HTTP " + t.status)); return wsRetry(); }
    let s; try { s = new WebSocket(WS_URL()); } catch (e) { WS.err = e.message; return wsRetry(); }
    WS.sock = s; let n = 0; const wait = new Map();
    const send = o => { try { s.send(JSON.stringify(o)); } catch (e) {} };
    const cmd = (o, cb) => { o.id = ++n; if (cb) wait.set(o.id, cb); send(o); };
    s.addEventListener("open", () => {
      WS.last = Date.now();
      cmd({ connect: { token: String(token), name: "verionshop" } }, r => {
        if (r.error) { WS.err = "connect: " + (r.error.message || r.error.code); try { s.close(); } catch (e) {} return; }
        const cn = r.connect || {};
        WS.state = "connected"; WS.since = Date.now(); WS.err = ""; WS.retry = 0; WS.pong = !!cn.pong;
        // Token muddati tugashidan oldin qayta ulanamiz (yangi token bilan)
        if (cn.expires && Number(cn.ttl) > 60) { const tt = setTimeout(() => { if (WS.sock === s) try { s.close(); } catch (e) {} }, (Number(cn.ttl) - 30) * 1000); if (tt.unref) tt.unref(); }
        cmd({ subscribe: { channel: "public:obtained-skins" } }, x => { if (x.error) WS.err = "public: " + (x.error.message || x.error.code); });
        const uid = cfg().lisUserId;
        if (uid) cmd({ subscribe: { channel: "private:purchase-skins#" + uid } }, x => { if (x.error) WS.err = "private: " + (x.error.message || x.error.code); else WS.privOk = true; });
      });
    });
    s.addEventListener("message", ev => {
      WS.last = Date.now();
      const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (!m || typeof m !== "object") continue;
        if (!Object.keys(m).length) { if (WS.pong) send({}); continue; }   // ping → pong
        if (m.id && wait.has(m.id)) { const cb = wait.get(m.id); wait.delete(m.id); try { cb(m); } catch (e) {} continue; }
        if (m.push && m.push.pub) { try { wsPub(String(m.push.channel || ""), m.push.pub.data); } catch (e) { console.log("[skins] ws: " + e.message); } }
      }
    });
    s.addEventListener("error", () => { if (!WS.err) WS.err = "ulanish xatosi"; });
    s.addEventListener("close", ev => {
      if (WS.sock !== s) return;
      WS.sock = null; WS.privOk = false;
      if (ev && ev.code && ev.code !== 1000 && !WS.err) WS.err = "uzildi (" + ev.code + (ev.reason ? " " + String(ev.reason).slice(0, 60) : "") + ")";
      wsRetry();
    });
  }
  function gameOfName(n) { for (const g of GAME_KEYS) if (ready(g) && cat(g).BY_NAME.has(n)) return g; return ""; }
  function wsPub(ch, d) {
    if (!d || typeof d !== "object") return;
    if (ch.indexOf("private:purchase-skins") === 0) {
      WS.priv++;
      const id = String(d.id || ""), os = DBx().orders;
      for (let i = os.length - 1; i >= 0 && i >= os.length - 5000; i--) {
        const o = os[i];
        if (o.cs2 && o.status === "pending" && o.cs2.offerId === id && o.cs2.state !== "buying") { applySkin(o, d); settle(o, d.status); break; }
      }
      return;
    }
    if (ch !== "public:obtained-skins") return;
    WS.pub++;
    const ev = String(d.event || ""), id = String(d.id || "");
    if (ev === "obtained_skin_deleted") {
      GONE.set(id, Date.now());
      if (GONE.size > 20000) { const cut = Date.now() - 30 * 60e3; for (const [k, v] of GONE) if (v < cut) GONE.delete(k); }
      return;
    }
    if (ev === "obtained_skin_price_changed") { const of = OFFERS.get(id), p = Number(d.price); if (of && p > 0) of.live = p; return; }
    if (ev === "obtained_skin_added") {
      const o = normOffer(d); if (!o) return;
      GONE.delete(o.id);
      const g = gameOfName(o.name), c = cfg();
      if (!g || o.usd < c.minUsd || o.usd > c.maxUsd || (c.onlyUnlocked && o.locked)) return;
      const L = LIVE[g] || (LIVE[g] = []); L.unshift(Object.assign(o, { liveTs: Date.now() })); if (L.length > 60) L.length = 60;
    }
  }
  setTimeout(() => wsConnect().catch(() => {}), Number(process.env.LIS_WS_DELAY_MS) || 6000).unref();
  { const t = setInterval(() => {
      if (!wsWanted()) { if (WS.sock || WS.state !== "off") wsClose("off"); return; }
      if (!WS.sock && !WS.timer && WS.state !== "connecting") wsConnect().catch(() => {});
      // Server har ~25 soniyada ping yuboradi — uzoq jim tursa ulanish o'lik: qayta ulanamiz
      if (WS.sock && WS.state === "connected" && Date.now() - WS.last > 90e3) try { WS.sock.close(); } catch (e) {}
    }, Number(process.env.LIS_WS_CHECK_MS) || 30000); if (t.unref) t.unref(); }
  async function balance() {
    const r = await call("GET", "user/balance", { timeout: 15000 });
    const b = r.json && pick(r.json, ["data.balance", "balance", "data.amount"]);
    if (b != null) return { id: "cs2", name: "Skinlar · lis-skins", ok: true, message: "Balans: " + b + " USD" };
    return { id: "cs2", name: "Skinlar · lis-skins", ok: false, message: errOf(r.json) || r.error || ("HTTP " + r.status) };
  }

  /* ---------- Steam akkauntini ulash (OpenID 2.0) ----------
     Mijoz «Steam orqali ulash»ni bosadi → tashqi brauzerda Steam'ga kiradi → Steam bizga qaytaradi;
     javob Steam'ning o'zida tekshiriladi (check_authentication). Ulangandan keyin trade havola faqat shu
     akkauntniki bo'lishi mumkin — skin adashib boshqa odamga ketmaydi. */
  const STEAM_OPENID = () => process.env.STEAM_OPENID_URL || "https://steamcommunity.com/openid/login";
  const STEAM_PROFILE = () => process.env.STEAM_PROFILE_URL || "https://steamcommunity.com/profiles/";
  const SID_BASE = 76561197960265728n;
  const LINKS = new Map();   // bir martalik kalit -> { uid, ts }
  const accountIdOf = sid => { try { return String(BigInt(sid) - SID_BASE); } catch (e) { return ""; } };
  // Steam sahifasida ko'rinadigan sayt: brend domeni (verionshop.uz, server tekshirgan bo'lsa), bo'lmasa ilova manzili
  const appOrigin = () => { try { return new URL(String(process.env.STEAM_RETURN_BASE || (ctx.siteUrl && ctx.siteUrl()) || (ctx.appUrl && ctx.appUrl()) || "")).origin; } catch (e) { return ""; } };
  const escH = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function steamLinkUrl(uid) {
    const base = appOrigin(); if (!base) return "";
    for (const [k, v] of LINKS) if (Date.now() - v.ts > 15 * 60e3) LINKS.delete(k);
    if (LINKS.size > 5000) LINKS.clear();
    const n = crypto.randomBytes(16).toString("hex");
    LINKS.set(n, { uid: String(uid), ts: Date.now(), base });   // qaysi domen bilan boshlangan bo'lsa, javob ham o'shanga qaytadi
    const ret = base + "/api/steam/return?n=" + n;
    const q = { "openid.ns": "http://specs.openid.net/auth/2.0", "openid.mode": "checkid_setup", "openid.return_to": ret, "openid.realm": base,
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select", "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select" };
    return STEAM_OPENID() + "?" + Object.keys(q).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(q[k])).join("&");
  }
  // Steam javobini Steam'ning o'zida tekshirish: imzo to'g'ri bo'lsa "is_valid:true"
  function steamVerify(params) {
    return new Promise(resolve => {
      const body = Object.keys(params).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(k === "openid.mode" ? "check_authentication" : params[k])).join("&");
      let u; try { u = new URL(STEAM_OPENID()); } catch (e) { return resolve(false); }
      const rq = lib(u.protocol).request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method: "POST", timeout: 15000,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body), "User-Agent": "Mozilla/5.0 (VerionShop)" } }, r => {
        let t = ""; r.on("data", c => { if (t.length < 4000) t += c; }); r.on("end", () => resolve(r.statusCode === 200 && /(^|\n)is_valid:true(\n|$)/.test(t)));
      });
      rq.on("timeout", () => rq.destroy(new Error("timeout"))); rq.on("error", () => resolve(false));
      rq.end(body);
    });
  }
  // Ochiq profil ma'lumoti (nomi, rasmi, maxfiylik, savdo taqiqi) — Steam API kalitisiz, XML orqali
  function steamProfile(sid) {
    return new Promise(resolve => {
      const url = STEAM_PROFILE() + sid + "/?xml=1";
      try {
        lib(url).get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (VerionShop)" } }, r => {
          if (r.statusCode !== 200) { r.resume(); return resolve(null); }
          let t = ""; r.on("data", c => { if (t.length < 200000) t += c; });
          r.on("end", () => {
            const tag = n => { const m = new RegExp("<" + n + ">(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</" + n + ">").exec(t); return m ? m[1].trim() : ""; };
            const av = tag("avatarFull");
            resolve({ name: str(tag("steamID"), 64), avatar: IMG_OK(av) ? av : "", privacy: str(tag("privacyState"), 20), tradeBan: str(tag("tradeBanState"), 30), vac: tag("vacBanned") === "1" });
          });
        }).on("timeout", function () { this.destroy(new Error("timeout")); }).on("error", () => resolve(null));
      } catch (e) { resolve(null); }
    });
  }
  function steamPage(res, ok, title, text) {
    const bot = ctx.botUsername && ctx.botUsername();
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https:" });
    res.end('<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verion Shop — Steam</title>'
      + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1013;color:#fff;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px;box-sizing:border-box}'
      + '.c{max-width:380px;text-align:center}.i{font-size:56px}.t{font-size:22px;font-weight:800;margin:12px 0 8px}.p{color:#a3adbb}'
      + 'a{display:inline-block;margin-top:22px;padding:14px 26px;border-radius:14px;background:#ffb81c;color:#141414;font-weight:800;text-decoration:none}</style></head><body><div class="c">'
      + '<div class="i">' + (ok ? "✅" : "⚠️") + '</div><div class="t">' + escH(title) + '</div><div class="p">' + escH(text) + '</div>'
      + (bot ? '<a href="https://t.me/' + escH(bot) + '">Telegram\'ga qaytish</a>' : '') + '</div></body></html>');
  }
  async function steamReturn(res, q) {
    const n = str(q.get("n"), 64), L = LINKS.get(n);
    if (!L || Date.now() - L.ts > 15 * 60e3) return steamPage(res, false, "Havola eskirgan", "Ilovada «Steam orqali ulash» tugmasini qaytadan bosing.");
    const P = {}; for (const [k, v] of q) if (k.indexOf("openid.") === 0) P[k] = String(v).slice(0, 2000);
    const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/.exec(P["openid.claimed_id"] || "");
    const okReq = P["openid.mode"] === "id_res" && P["openid.op_endpoint"] === STEAM_OPENID() && P["openid.return_to"] === L.base + "/api/steam/return?n=" + n
      && m && P["openid.identity"] === P["openid.claimed_id"] && P["openid.sig"] && P["openid.signed"];
    if (!okReq) return steamPage(res, false, "Ulanmadi", "Steam javobi noto'g'ri. Qaytadan urinib ko'ring.");
    LINKS.delete(n);   // bir martalik
    if (!(await steamVerify(P))) return steamPage(res, false, "Ulanmadi", "Steam kirishni tasdiqlamadi. Qaytadan urinib ko'ring.");
    const sid = m[1], acc = DBx().users[L.uid];
    if (!acc) return steamPage(res, false, "Ulanmadi", "Hisob topilmadi.");
    acc.steam = { id: sid, ts: Date.now(), name: "", avatar: "", privacy: "", tradeBan: "" };
    // Saqlangan trade havola boshqa akkauntniki bo'lsa — o'chiriladi (yangisini kiritadi)
    const tu = parseTrade(acc.cs2Trade);
    let note = "";
    if (tu && tu.partner !== accountIdOf(sid)) { acc.cs2Trade = ""; note = " Saqlangan trade havola boshqa akkauntniki edi — yangisini kiriting."; }
    ctx.save();
    const pf = await steamProfile(sid);
    if (pf && acc.steam && acc.steam.id === sid) { Object.assign(acc.steam, pf); ctx.save(); }
    steamPage(res, true, "Steam ulandi" + (pf && pf.name ? ": " + pf.name : ""), "Endi Telegram'ga qayting — skinlar shu akkauntga yuboriladi." + note);
  }
  const steamPub = acc => acc && acc.steam ? { id: acc.steam.id, name: acc.steam.name || "", avatar: acc.steam.avatar || "", privacy: acc.steam.privacy || "",
    tradeBan: acc.steam.tradeBan && acc.steam.tradeBan !== "None" ? acc.steam.tradeBan : "", vac: !!acc.steam.vac } : null;

  /* ---------- HTTP ---------- */
  const WEAR_KEYS = ["FN", "MW", "FT", "WW", "BS"];
  let RECENT = {}, DONE_C = { ts: 0, n: 0 };
  // Yetkazilgan skin buyurtmalari soni (ishonch uchun), 1 daqiqa keshlanadi
  const DONE_N = () => { if (Date.now() - DONE_C.ts > 60000) { let n = 0; for (const o of DBx().orders) if (o.cs2 && o.status === "done") n++; DONE_C = { ts: Date.now(), n }; } return DONE_C.n; };
  const favKey = (g, b) => (g === "cs2" ? b : g + "|" + b);
  const gamesPublic = () => { const o = {}; for (const g of GAME_KEYS) o[g] = ready(g); return o; };
  function handle(req, res, url, m, q) {
    if (url === "/api/cs2" && m === "GET") {
      const u = ctx.auth(req), g = gameOf(q.get("game"));
      const acc = u ? DBx().users[String(u.id)] : null;
      send(res, 200, { enabled: ready(g), any: ready(), games: gamesPublic(), game: g, cats: CATS[g].map(([k, label]) => ({ k, label })), catalog: cat(g).list.length,
        tradeUrl: (acc && acc.cs2Trade) || "", steamOffers: STEAM_OFFERS,
        favs: acc && Array.isArray(acc.cs2Fav) ? acc.cs2Fav : [], inStock: ready(g) && pricesFresh(g) ? pr(g).map.size : null,
        delivered: DONE_N(), locks: !cfg().onlyUnlocked, cancelFee: 3, live: WS.state === "connected", steam: steamPub(acc), steamLogin: !!appOrigin(), catImg: catImgs(g) });
      return true;
    }
    // Sevimli skinlar (mijoz hisobida, 200 tagacha). CS2 — nomi, boshqalar — "o'yin|nomi"
    if (url === "/api/cs2/fav" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => {
        const g = gameOf(b.game), name = str(b.b, 200);
        if (!cat(g).G_BY.has(name)) return send(res, 404, { error: "not_found" });
        const key = favKey(g, name);
        const acc = ctx.user(u); const f = Array.isArray(acc.cs2Fav) ? acc.cs2Fav.filter(x => typeof x === "string") : [];
        const i = f.indexOf(key);
        if (b.on && i === -1) { f.unshift(key); if (f.length > 200) f.length = 200; }
        if (!b.on && i !== -1) f.splice(i, 1);
        acc.cs2Fav = f; ctx.save();
        send(res, 200, { ok: true, favs: f });
      });
      return true;
    }
    // Jonli bozor: sotuvdagi takliflar (narx bo'yicha, oraliq bilan)
    const busy = (res, e) => e && e.busy ? send(res, 429, { error: "busy", message: "Juda ko'p so'rov — birozdan keyin urinib ko'ring" })
      : send(res, 502, { error: "market", message: "Bozor hozir javob bermadi, birozdan keyin urinib ko'ring" });
    if (url === "/api/cs2/market" && m === "GET") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      const g = gameOf(q.get("game"));
      if (!ready(g)) { send(res, 503, { error: "off" }); return true; }
      const sort = ["lowest_price", "highest_price", "newest", "oldest"].indexOf(q.get("sort")) !== -1 ? q.get("sort") : "lowest_price";
      const pmin = Math.max(0, Number(q.get("pmin")) || 0), pmax = Math.max(0, Number(q.get("pmax")) || 0), cursor = str(q.get("cursor"), 200);
      // float oralig'i (CS2) va trade-lock: now — faqat darhol, lock — faqat trade-lock'dagilar (1–8 kun)
      const f01 = v => { const n = Number(v); return v !== null && v !== "" && n >= 0 && n <= 1 ? Math.round(n * 1e4) / 1e4 : undefined; };
      const ff = f01(q.get("ffrom")), ft = f01(q.get("fto")), un = ["now", "lock"].indexOf(q.get("unlock")) !== -1 ? q.get("unlock") : "";
      const key = "m|" + g + "|" + sort + "|" + pmin + "|" + pmax + "|" + cursor + "|" + ff + "|" + ft + "|" + un;
      const sp = { sort_by: sort, cursor, price_from: pmin ? Math.floor(usdOf(pmin) * 100) / 100 : undefined, price_to: pmax ? Math.ceil(usdOf(pmax) * 100) / 100 : undefined,
        float_from: ff, float_to: ft, only_unlocked: un === "now" ? 1 : undefined, unlock_days: un === "lock" ? [1, 2, 3, 4, 5, 6, 7, 8] : undefined };
      const okF = o => (g !== "cs2" || cat(g).BY_NAME.has(o.name)) && (ff === undefined || (o.float != null && o.float >= ff)) && (ft === undefined || (o.float != null && o.float <= ft))
        && (!un || (un === "now" ? !o.locked : o.locked)) && (!pmin || uzs(o.usd) >= pmin) && (!pmax || uzs(o.usd) <= pmax);
      cached(key, 60000, () => search(sp, g), u.id)
        .then(r => {
          // WebSocket orqali kelgan eng yangilari (qidiruvda hali ko'rinmaydi) — "yangi" ro'yxat boshida
          const live = sort === "newest" && !cursor ? (LIVE[g] || []).filter(o => !GONE.has(o.id) && okF(o) && Date.now() - o.liveTs < 30 * 60e3).slice(0, 20) : [];
          live.forEach(o => rememberOffer(o, g));
          const ids = new Set(live.map(o => o.id));
          const items = live.map(o => Object.assign(pubOffer(o, g), { fresh: true })).concat(r.items.filter(o => !ids.has(o.id) && okF(o) && OFFERS.has(o.id) && !GONE.has(o.id)).map(o => pubOffer(o, g)));
          send(res, 200, { items, next: r.next });
        })
        .catch(e => busy(res, e));
      return true;
    }
    // Katalog: toifa yoki qidiruv bo'yicha skinlar (har biriga "dan" narx)
    if (url === "/api/cs2/catalog" && m === "GET") {
      const g = gameOf(q.get("game")), C = cat(g);
      const ct = str(q.get("cat"), 10), text = str(q.get("q"), 60).toLowerCase(), page = Math.max(0, Math.min(500, Number(q.get("page")) || 0));
      const sort = str(q.get("sort"), 10), wpn = str(q.get("w"), 40);
      const list = k => String(q.get(k) || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 10);
      const types = list("type").filter(t => ["st", "sv", "plain"].indexOf(t) !== -1);
      if (q.get("st") === "1" && types.indexOf("st") === -1) types.push("st");   // eski mijozlar uchun
      const flt = { wear: list("wear").filter(w => WEAR_KEYS.indexOf(w) !== -1), types,
        umin: Math.max(0, Math.floor(Number(q.get("pmin")) || 0)), umax: Math.max(0, Math.floor(Number(q.get("pmax")) || 0)) };
      const rar = list("rar").map(k => RARITY_KEY[k]).filter(Boolean), star = q.get("star") === "1";
      let favs = null;
      if (q.get("fav") === "1") { const uf = ctx.auth(req), acc = uf && DBx().users[String(uf.id)]; favs = new Set(acc && Array.isArray(acc.cs2Fav) ? acc.cs2Fav : []); }
      const words = text.split(/\s+/).filter(Boolean);
      const inCat = C.GROUPS.filter(G => (!ct || G.c === ct) && (!words.length || words.every(w => G.b.toLowerCase().indexOf(w) !== -1))
        && (!rar.length || rar.indexOf(G.r) !== -1) && (!star || G.c === "knife" || G.c === "gloves") && (!favs || favs.has(favKey(g, G.b))));
      const all = wpn ? inCat.filter(G => G.w === wpn) : inCat;
      const PER = 20;
      const out = (G, f) => ({ game: g, b: G.b, w: G.w, s: G.s, img: G.i, rc: G.r, rn: G.rn, st: G.st, sv: G.sv, cat: G.c,
        from: f && f.usd ? uzs(f.usd) : null, cnt: f ? f.cnt : null });
      // Toifa tanlanganda — undagi qurollar (ko'p skinlilari oldin), qurol bo'yicha tez tanlash uchun (faqat CS2)
      // har qurol yonida — uning eng ommabop (narxlar bo'lsa: ko'p sotiladigan va noyob) skinining rasmi
      const weaponsOf = (l, score) => { if (!ct || g !== "cs2") return undefined; const mm = new Map();
        l.forEach((G, i) => { const e = mm.get(G.w) || { n: 0, img: "", best: -Infinity }; e.n++;
          const sc = score ? score(i) : 7 - (RARITY_RANK[G.r] ?? 6); if (G.i && sc > e.best) { e.best = sc; e.img = G.i; } mm.set(G.w, e); });
        return [...mm.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, 30).map(([w, e]) => ({ w, n: e.n, img: e.img })); };
      if (ready(g) && pricesFresh(g)) {
        // Narxlar ro'yxati bor: faqat sotuvdagilari (filtrlarga mos variant bilan), kerakli tartibda
        const priced = inCat.map(G => ({ G, f: fromOf(G, flt, g) })).filter(x => x.f.usd);
        let rows = wpn ? priced.filter(x => x.G.w === wpn) : priced;
        if (sort === "rare") rows.sort((a, b) => (RARITY_RANK[a.G.r] ?? 9) - (RARITY_RANK[b.G.r] ?? 9) || b.f.usd - a.f.usd);
        else if (sort === "cheap") rows.sort((a, b) => a.f.usd - b.f.usd);
        else if (sort === "expensive") rows.sort((a, b) => b.f.usd - a.f.usd);
        // Ommabop: bozorda ko'p sotiladigan (taklif soni) va noyobroq skinlar oldinda
        else rows.sort((a, b) => b.f.cnt * (7 - (RARITY_RANK[b.G.r] ?? 6)) - a.f.cnt * (7 - (RARITY_RANK[a.G.r] ?? 6)) || a.G.b.localeCompare(b.G.b));
        const slice = rows.slice(page * PER, page * PER + PER);
        send(res, 200, { items: slice.map(x => out(x.G, x.f)), total: rows.length, page, more: rows.length > (page + 1) * PER, priced: true,
          weapons: page ? undefined : weaponsOf(priced.map(x => x.G), i => (priced[i].f.cnt || 1) * (7 - (RARITY_RANK[priced[i].G.r] ?? 6))) });
        return true;
      }
      const slice = all.slice(page * PER, page * PER + PER);
      if (!ready(g) || !slice.length) { send(res, 200, { items: slice.map(G => out(G)), total: all.length, page, more: all.length > (page + 1) * PER, weapons: page ? undefined : weaponsOf(inCat) }); return true; }
      // Narxlar ro'yxati yo'q: shu sahifadagi skinlarning oddiy variantlari bo'yicha bitta qidiruv
      const names = slice.reduce((a, G) => a.concat(G.v.filter(n => !/StatTrak™|^Souvenir /.test(n))), []).slice(0, 100);
      const uc = ctx.auth(req);
      cached("c|" + g + "|" + names.join("|"), 10 * 60e3, () => search({ names, sort_by: "lowest_price" }, g).catch(() => ({ items: [] })), uc ? uc.id : "-")
        .catch(() => ({ items: [] }))
        .then(r => {
          const min = new Map();
          for (const o of r.items) { const b = baseOf(o.name, g); if (!min.has(b) || o.usd < min.get(b)) min.set(b, o.usd); }
          send(res, 200, { items: slice.map(G => out(G, min.has(G.b) ? { usd: min.get(G.b), cnt: null } : null)), total: all.length, page, more: all.length > (page + 1) * PER, weapons: page ? undefined : weaponsOf(inCat) });
        });
      return true;
    }
    // Bitta skin: barcha eskirganlik darajalari bo'yicha sotuvdagi takliflar
    if (url === "/api/cs2/item" && m === "GET") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      const g = gameOf(q.get("game")), C = cat(g);
      const b = str(q.get("b"), 200);
      const G = C.G_BY.get(b);
      const nm = G ? G.v : (C.BY_NAME.has(b) ? [b] : []);
      if (!nm.length) { send(res, 404, { error: "not_found" }); return true; }
      const head = G ? { game: g, b: G.b, w: G.w, s: G.s, img: G.i, rc: G.r, rn: G.rn, st: G.st, sv: G.sv, cat: G.c, mn: G.mn, mx: G.mx } : null;
      // Shu skinning bizda so'nggi sotuvlari (kim olgani ko'rsatilmaydi)
      const sales = [], os = DBx().orders;
      for (let i = os.length - 1; i >= 0 && i >= os.length - 5000 && sales.length < 8; i--) {
        const o = os[i];
        if (!o.cs2 || o.status !== "done" || (o.cs2.game || "cs2") !== g || baseOf(o.cs2.name, g) !== (head ? head.b : b)) continue;
        const e = C.BY_NAME.get(o.cs2.name) || {};
        sales.push({ wear: e.wr || "", st: /StatTrak/.test(o.cs2.name), float: o.cs2.float == null ? null : o.cs2.float, price: o.price, ago: Math.max(0, Math.round((Date.now() - (o.doneTs || o.ts)) / 60000)) });
      }
      if (!ready(g)) { send(res, 200, { item: head, offers: [], sales }); return true; }
      cached("i|" + g + "|" + nm.join("|"), 60000, () => search({ names: nm, sort_by: "lowest_price" }, g), u.id)
        .then(r => {
          const per = new Map(), offers = [];
          for (const o of r.items) { if (!OFFERS.has(o.id) || GONE.has(o.id)) continue; const k = per.get(o.name) || 0; if (k >= 10) continue; per.set(o.name, k + 1); offers.push(o); }
          send(res, 200, { item: head, offers: offers.slice(0, 80).map(o => pubOffer(o, g)), sales });
        })
        .catch(e => busy(res, e));
      return true;
    }
    // O'yinda ko'rish: faqat biz ko'rsatgan takliflarning Steam inspect havolasiga yo'naltiradi
    if (url === "/api/cs2/inspect" && m === "GET") {
      const of = OFFERS.get(str(q.get("id"), 40));
      if (!of || !of.insp) { send(res, 404, { error: "not_found" }); return true; }
      res.writeHead(302, { Location: of.insp, "Cache-Control": "no-store" }); res.end();
      return true;
    }
    // Yaqinda yetkazilgan skinlar (ishonch uchun lenta): kim olgani ko'rsatilmaydi
    if (url === "/api/cs2/recent" && m === "GET") {
      const gq = q.get("game") ? gameOf(q.get("game")) : "", k = gq || "*";
      if (!RECENT[k] || Date.now() - RECENT[k].ts > 30000) {
        const list = [];
        const os = DBx().orders;
        for (let i = os.length - 1; i >= 0 && list.length < 12 && i >= os.length - 5000; i--) {
          const o = os[i];
          if (!o.cs2 || o.status !== "done") continue;
          const g = o.cs2.game || "cs2";
          if (gq && g !== gq) continue;
          const e = cat(g).BY_NAME.get(o.cs2.name) || {};
          list.push({ game: g, b: baseOf(o.cs2.name, g), w: e.w || "", s: e.s || o.cs2.name, img: o.cs2.img || e.i || "", rc: e.r || "#b0c3d9", wear: e.wr || "",
            st: /StatTrak/.test(o.cs2.name), price: o.price, ago: Math.max(0, Math.round((Date.now() - (o.doneTs || o.ts)) / 60000)) });
        }
        RECENT[k] = { ts: Date.now(), list };
      }
      send(res, 200, { items: RECENT[k].list });
      return true;
    }
    if (url === "/api/steam/link-start" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      const link = steamLinkUrl(u.id);
      if (!link) { send(res, 503, { error: "no_url", message: "Hozircha ishlamayapti — keyinroq urinib ko'ring" }); return true; }
      send(res, 200, { ok: true, url: link });
      return true;
    }
    if (url === "/api/steam/return" && m === "GET") { steamReturn(res, q).catch(() => steamPage(res, false, "Xatolik", "Qaytadan urinib ko'ring.")); return true; }
    if (url === "/api/steam/unlink" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      const acc = ctx.user(u); delete acc.steam; ctx.save();
      send(res, 200, { ok: true });
      return true;
    }
    // Ulangan akkaunt ma'lumotini yangilash (nomi, rasmi, maxfiylik) — daqiqasiga bir marta
    if (url === "/api/steam/refresh" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      const acc = ctx.user(u);
      if (!acc.steam) { send(res, 404, { error: "not_linked" }); return true; }
      if (Date.now() - (acc.steam.pts || 0) < 60e3) { send(res, 200, { ok: true, steam: steamPub(acc) }); return true; }
      acc.steam.pts = Date.now();
      steamProfile(acc.steam.id).then(pf => { if (pf && acc.steam) { Object.assign(acc.steam, pf); ctx.save(); } send(res, 200, { ok: true, steam: steamPub(acc) }); });
      return true;
    }
    if (url === "/api/cs2/trade-url" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => {
        const raw = str(b.url, 300);
        if (!raw) { const acc = ctx.user(u); acc.cs2Trade = ""; ctx.save(); return send(res, 200, { ok: true, tradeUrl: "" }); }
        const t = parseTrade(raw);
        if (!t) return send(res, 400, { error: "trade_url", message: "Havola noto'g'ri. U shunday ko'rinishda bo'ladi: https://steamcommunity.com/tradeoffer/new/?partner=…&token=…" });
        const acc = ctx.user(u);
        // Steam ulangan bo'lsa — havola aynan shu akkauntniki bo'lishi shart
        if (acc.steam && t.partner !== accountIdOf(acc.steam.id))
          return send(res, 400, { error: "trade_url", message: "Bu trade havola boshqa Steam akkauntiniki. Ulangan akkaunt: " + (acc.steam.name || acc.steam.id) + " — o'sha akkauntning havolasini kiriting." });
        acc.cs2Trade = t.url; ctx.save();
        send(res, 200, { ok: true, tradeUrl: t.url });
        // Trade-lock'dan chiqib, yuborilishini kutayotgan skinlar — yangi havolaga darhol yuboriladi
        for (const o of DBx().orders) if (o.cs2 && o.status === "pending" && String(o.uid) === String(u.id) && o.cs2.state === "withdraw") { o.cs2.wdTs = 0; withdraw(o).catch(() => {}); }
      });
      return true;
    }
    if (url === "/api/cs2/buy" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => buy(u, b && typeof b.offerId !== "object" ? str(b.offerId, 40) : "").then(r => send(res, r.code, r.body)));
      return true;
    }
    // Savat: bir nechta skin ketma-ket (har biri alohida buyurtma, alohida pul hisobi). Balans yoki havola muammosida to'xtaydi.
    if (url === "/api/cs2/buy-many" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, async b => {
        const ids = (b && Array.isArray(b.offerIds) ? b.offerIds : []).filter(x => typeof x === "string" || typeof x === "number").map(x => str(x, 40)).filter((x, i, a) => x && a.indexOf(x) === i);
        if (!ids.length || ids.length > 10) return send(res, 400, { error: "count", message: "Savatda 1 dan 10 tagacha skin bo'lishi kerak" });
        const out = [];
        for (const id of ids) {
          const r = await buy(u, id);
          out.push({ offerId: id, code: r.code, ok: r.code === 200, error: r.body.error || "", message: r.body.message || "", price: r.body.price, order: r.body.order || null });
          if (r.body.error === "balance" || r.body.error === "trade_url" || r.body.error === "off" || r.body.error === "steam") break;
        }
        const acc = ctx.user(u);
        send(res, 200, { ok: out.some(x => x.ok), results: out, balance: acc.balance, steamOffers: STEAM_OFFERS });
      });
      return true;
    }
    // Trade-lock'dagi xaridni bekor qilish (lis-skins 3% komissiya oladi — shuncha ushlab qolinadi)
    if (url === "/api/cs2/order-cancel" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => cancelLocked(u, b && typeof b.id === "string" ? str(b.id, 40) : "").then(r => send(res, r.code, r.body)));
      return true;
    }
    // --- admin ---
    if (url === "/api/admin/cs2" && (m === "GET" || m === "POST")) {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      const view = () => {
        const c = cfg(), P = pr("cs2"), per = {};
        for (const g of GAME_KEYS) { const C = cat(g), Q = pr(g);
          per[g] = { on: !!c.games[g], catalog: C.list.length, skins: C.GROUPS.length, catalogTs: C.TS, loading: !!C.loading, error: C.err || "",
            steam: SC[g] ? SC[g].items.length : 0, steamTs: SC[g] ? SC[g].ts : 0, lisN: C.lisN || 0, warn: C.warn || "", crawl: C.crawl || null,
            prices: Q.map ? Q.map.size : 0, pricesTs: Q.ts, pricesUrl: c.pricesUrls[g] || (g === "cs2" ? c.pricesUrl || "" : ""),
            pricesDiag: Q.diag.map(d => d.url.replace(/^https?:\/\//, "") + " → " + (d.error || d.rows + " ta nom, " + d.kb + " KB")) }; }
        return { enabled: c.enabled, rate: c.rate, markup: c.markup, minUsd: c.minUsd, maxUsd: c.maxUsd, onlyUnlocked: c.onlyUnlocked, apiKeySet: !!c.apiKey, games: per,
          lisUserId: c.lisUserId || "", ws: { on: c.ws !== false, state: WS.state, since: WS.since, err: WS.err, pub: WS.pub, priv: WS.priv, privOk: WS.privOk, live: Object.keys(LIVE).reduce((a, k) => a + LIVE[k].length, 0) },
          cool: coolUntil > Date.now() ? Math.ceil((coolUntil - Date.now()) / 1000) : 0,
          // Steam orqali kirishda mijoz ko'radigan sayt (verionshop.uz tekshiruvi)
          site: ctx.siteInfo ? Object.assign(ctx.siteInfo(), { steam: appOrigin() }) : null,
          // eski maydonlar (CS2) — mavjud admin oynalari uchun
          catalog: cat("cs2").list.length, skins: cat("cs2").GROUPS.length, catalogTs: cat("cs2").TS, prices: P.map ? P.map.size : 0, pricesTs: P.ts,
          pricesUrl: per.cs2.pricesUrl, pricesSrc: P.src, pricesDiag: per.cs2.pricesDiag };
      };
      // ?site=1 — brend domenini (verionshop.uz) hozir qayta tekshirib, natija bilan javob beradi
      if (m === "GET" && q.get("site") === "1" && ctx.siteRecheck) { ctx.siteRecheck().catch(() => {}).then(() => send(res, 200, view())); return true; }
      if (m === "GET") { send(res, 200, view()); return true; }
      ctx.readBody(req, res, b => {
        const c = cfg(), num = (x, lo, hi) => { const n = Number(x); return n >= lo && n <= hi ? n : null; };
        const okUrl = u => !u || /^https:\/\/[\w.-]+\/\S*$/.test(u);
        if ("enabled" in b) c.enabled = !!b.enabled;
        if ("onlyUnlocked" in b) c.onlyUnlocked = !!b.onlyUnlocked;
        const r = num(b.rate, 1000, 100000); if (r) c.rate = r;
        const mk = num(b.markup, 0, 300); if (mk !== null && b.markup !== undefined && b.markup !== "") c.markup = mk;
        const mn = num(b.minUsd, 0.01, 1000); if (mn) c.minUsd = mn;
        const mx = num(b.maxUsd, 1, 100000); if (mx) c.maxUsd = mx;
        if (b.apiKey) c.apiKey = str(b.apiKey, 500);
        if ("lisUserId" in b) { const v = str(b.lisUserId, 20); if (v && !/^\d{1,20}$/.test(v)) return send(res, 400, { error: "lis-skins User ID faqat raqam bo'ladi" }); c.lisUserId = v; }
        if ("ws" in b) c.ws = !!b.ws;
        if ("pricesUrl" in b) {
          const pu = str(b.pricesUrl, 300);
          if (!okUrl(pu)) return send(res, 400, { error: "Narxlar havolasi https:// bilan boshlanishi kerak" });
          c.pricesUrl = pu; c.pricesUrls.cs2 = pu;
        }
        if (b.pricesUrls && typeof b.pricesUrls === "object") for (const g of GAME_KEYS) if (g in b.pricesUrls) {
          const pu = str(b.pricesUrls[g], 300);
          if (!okUrl(pu)) return send(res, 400, { error: "Narxlar havolasi https:// bilan boshlanishi kerak" });
          c.pricesUrls[g] = pu; if (g === "cs2") c.pricesUrl = pu;
        }
        const turnedOn = [];
        if (b.games && typeof b.games === "object") for (const g of GAME_KEYS) if (g in b.games) { if (b.games[g] && !c.games[g]) turnedOn.push(g); c.games[g] = !!b.games[g]; }
        // Yangi yoqilgan o'yinning katalogi bo'lmasa — darhol yuklab olinadi
        for (const g of turnedOn) if (!cat(g).list.length) downloadCatalog(g);
        setTimeout(() => loadPrices(undefined, true).catch(() => {}), 300);
        // Sozlama o'zgardi (kalit, User ID, yoqish) — WebSocket qayta ulanadi
        wsClose("off"); setTimeout(() => wsConnect().catch(() => {}), 200);
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
        const list = listOf(r.json), parsed = list.map(normOffer);
        const okN = parsed.filter(Boolean).length, iFirst = parsed.findIndex(Boolean), norm = parsed[iFirst];
        const first = iFirst >= 0 ? list[iFirst] : list[0];
        send(res, 200, { ok: bal.ok && !!norm, balance: bal.message, search: r.status, sample: first ? JSON.stringify(first).slice(0, 600) : str(r.text, 300),
          parsed: norm ? (list.length + " ta taklifdan " + okN + " tasi o'qildi. " + norm.name + " — $" + norm.usd + (norm.float != null ? ", float " + norm.float.toFixed(4) : "")
            + (norm.insp ? ", o'yinda ko'rish bor" : "") + " → " + money(uzs(norm.usd))) : "Javobni o'qib bo'lmadi — namunani dasturchiga yuboring",
          catalog: cat("cs2").list.length });
      })().catch(e => send(res, 200, { ok: false, message: e.message }));
      return true;
    }
    // lis-skins xaridlar tarixi (market/history) — bizning buyurtma raqami bilan
    if (url === "/api/admin/cs2/history" && m === "GET") {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      const page = Math.max(1, Math.min(1000, Math.floor(Number(q.get("page")) || 1)));
      call("GET", "market/history", { params: { page }, timeout: 20000 }).then(r => {
        if (!r.json || r.status >= 400) return send(res, 502, { error: errOf(r.json) || r.error || ("HTTP " + r.status) });
        const byId = new Map(); const os = DBx().orders; for (let i = os.length - 1; i >= 0 && i >= os.length - 20000; i--) if (os[i].cs2) byId.set(os[i].id, os[i]);
        const items = listOf(r.json).slice(0, 200).map(x => { const o = byId.get(String(x.custom_id || "")); return {
          purchaseId: x.purchase_id, ts: Date.parse(x.created_at || "") || null, order: o ? { id: o.id, seq: o.seq, status: o.status, price: o.price } : null,
          skins: (Array.isArray(x.skins) ? x.skins : []).slice(0, 20).map(k => ({ name: str(k.name, 120), usd: Number(k.price) || 0, status: str(k.status, 30), rr: str(k.return_reason || "", 40),
            err: str(k.error || "", 40), fee: Number(k.return_charged_commission) || 0, trade: /^\d{1,20}$/.test(String(k.steam_trade_offer_id || "")) ? String(k.steam_trade_offer_id) : "" })) }; });
        const mt = r.json.meta || {};
        send(res, 200, { items, page: Number(mt.current_page) || page, last: Number(mt.last_page) || page, total: Number(mt.total) || items.length });
      });
      return true;
    }
    // Trade-lock'dan chiqqan barcha skinlarni yuborish (market/withdraw-all) — avtomatik yuborish ishlamay qolsa
    if (url === "/api/admin/cs2/withdraw-all" && m === "POST") {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      call("POST", "market/withdraw-all", { json: {}, timeout: 30000 }).then(r => {
        if (!r.json || r.status >= 400) return send(res, 200, { ok: false, error: errCode(r.json) || r.error || ("HTTP " + r.status) });
        let n = 0; const byId = new Map(DBx().orders.filter(o => o.cs2 && o.status === "pending").map(o => [o.id, o]));
        for (const x of listOf(r.json)) { const o = byId.get(String(x.custom_id || "")); const sk = x && Array.isArray(x.skins) ? x.skins[0] : null; if (o && sk) { applySkin(o, sk); settle(o, sk.status); } n += Array.isArray(x.skins) ? x.skins.length : 0; }
        send(res, 200, { ok: true, count: n });
      });
      return true;
    }
    if (url === "/api/admin/cs2/catalog-refresh" && m === "POST") {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      ctx.readBody(req, res, b => {
        const g = gameOf(b.game);
        // Dota 2 / Rust Steam'dan sekin yuklanadi — javobni kutmaymiz, holati admin oynasida ko'rinadi
        if (g !== "cs2") { downloadCatalog(g); return send(res, 200, { ok: true, started: true, game: g }); }
        downloadCatalog(g).then(r => send(res, 200, r));
      });
      return true;
    }
    return false;
  }
  return { handle, ready, games: gamesPublic, balance, cfg, poll, parseTrade, _internal: { normOffer, stateWord, stateOf, index, OFFERS, GONE, LIVE, WS, dotaMeta, rustMeta, streamList } };
};
