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

const LIS = () => String(process.env.LIS_BASE || "https://api.lis-skins.com/v1/").replace(/\/?$/, "/");
const DATA_URL = () => process.env.CS2_DATA_URL || "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json";
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
  // Steam bozoridan eng ommabop narsalar (sahifada 100 tadan, sekin — Steam cheklovi uchun)
  async function crawlSteam(g) {
    const appid = GAMES[g].appid, maxPages = Number(process.env["STEAM_PAGES_" + g.toUpperCase()]) || (g === "dota2" ? 40 : 30);
    const delay = Number(process.env.STEAM_DELAY_MS) || 4000, items = [], seen = new Set();
    let fails = 0;
    for (let page = 0; page < maxPages; page++) {
      const url = STEAM_URL() + "?appid=" + appid + "&norender=1&count=100&start=" + page * 100 + "&sort_column=popular&sort_dir=desc&search_descriptions=0";
      const r = await getJson(url, { timeout: 30000, limit: 8e6 });
      const res = r.json && Array.isArray(r.json.results) ? r.json.results : null;
      if (!res) { if (++fails >= 3) break; await sleep(delay * 3); page--; continue; }
      for (const x of res) {
        const d = x.asset_description || {}, n = str(x.hash_name || d.market_hash_name || x.name, 200);
        if (!n || seen.has(n) || !d.icon_url) continue;
        const img = "https://community.cloudflare.steamstatic.com/economy/image/" + String(d.icon_url).replace(/[^\w-]/g, "") + "/360fx360f";
        if (!IMG_OK(img)) continue;
        seen.add(n);
        const meta = g === "dota2" ? dotaMeta(d.type) : rustMeta(n, d.type);
        items.push({ n, s: str(x.name || n, 200), w: meta.w, c: meta.c, r: meta.r, rn: meta.rn, wr: "", st: false, sv: false, i: img, pop: items.length + 1 });
      }
      if (res.length < 100) break;
      await sleep(delay);
    }
    if (items.length < 20) return { ok: false, error: "Steam bozoridan kam ma'lumot keldi (" + items.length + ")" };
    index(items, g); saveCatalog(g, items);
    return { ok: true, count: items.length };
  }
  function downloadCatalog(g) {
    g = gameOf(g);
    const C = cat(g);
    if (C.loading) return C.loading;
    C.loading = (g === "cs2" ? downloadCs2() : crawlSteam(g)).catch(e => ({ ok: false, error: e.message }))
      .then(r => { C.err = r.ok ? "" : r.error; console.log("[skins] " + g + " katalog: " + (r.ok ? r.count + " ta" : r.error)); return r; })
      .finally(() => { C.loading = null; });
    return C.loading;
  }
  // Ishga tushganda: diskdagisi yuklanadi; eski yoki yo'q bo'lsa — yangilanadi (Dota/Rust faqat yoqilgan bo'lsa)
  setTimeout(() => {
    for (const g of GAME_KEYS) {
      const ok = cat(g).list.length > 0, stale = Date.now() - cat(g).TS > 7 * 86400e3;
      if ((!ok || stale) && (g === "cs2" || cfg().games[g])) downloadCatalog(g);
    }
  }, 5000).unref();
  { const t = setInterval(() => { for (const g of GAME_KEYS) if (Date.now() - cat(g).TS > 7 * 86400e3 && (g === "cs2" || cfg().games[g])) downloadCatalog(g); }, 6 * 3600e3); if (t.unref) t.unref(); }
  for (const g of GAME_KEYS) loadCatalogFromDisk(g);

  /* ---------- eng arzon narxlar ro'yxati (ixtiyoriy, har o'yin uchun) ----------
     lis-skins butun bozorning eng arzon narxlarini bitta JSON qilib beradi (nom → narx, soni).
     Bo'lsa — katalogda har skinning "...dan" narxi va "sotuvda bor" belgisi shundan olinadi
     (10 daqiqada yangilanadi). Bo'lmasa yoki o'qib bo'lmasa — narxlar API qidiruvidan olinadi. */
  const PR = {};   // o'yin -> { map, ts, src, diag, busy }
  const pr = g => PR[g] || (PR[g] = { map: null, ts: 0, src: "", diag: [], busy: false });
  // Admin o'zi havola kiritsa — o'sha; aks holda ma'lum manzillar ketma-ket sinaladi (birinchi ishlagani eslab qolinadi).
  const PRICE_URLS = g => {
    const c = cfg(), l = GAMES[g].lis, env = process.env[g === "cs2" ? "LIS_PRICES_URL" : "LIS_PRICES_URL_" + g.toUpperCase()];
    return [c.pricesUrls[g], g === "cs2" ? c.pricesUrl : "", env, "https://lis-skins.com/market_export_json/" + l + ".json",
      "https://lis-skins.com/market_export_json/api_" + l + "_lite.json", "https://lis-skins.com/market_export_json/api_" + l + "_full.json"]
      .filter((u, i, a) => u && a.indexOf(u) === i);
  };
  async function loadPrices(g) {
    if (!g) { for (const k of GAME_KEYS) if (ready(k)) await loadPrices(k); return; }
    const P = pr(g);
    if (P.busy || !ready(g)) return;
    P.busy = true;
    const diag = [];
    try {
      const urls = PRICE_URLS(g);
      if (P.src && urls.indexOf(P.src) > 0) { urls.splice(urls.indexOf(P.src), 1); urls.unshift(P.src); }
      for (const url of urls) {
        const r = await getJson(url);
        if (r.error) { diag.push({ url, error: r.error }); continue; }
        const j = r.json;
        try {
          const arr = listOf(j).length ? listOf(j) : (j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j).map(k => Object.assign({ name: k }, typeof j[k] === "object" ? j[k] : { price: j[k] })) : []);
          const m = new Map();
          for (const x of arr) {
            const name = pick(x, ["name", "market_hash_name"]), usd = Number(pick(x, ["price", "min_price", "price_usd"]));
            if (!name || !(usd > 0)) continue;
            // To'liq ro'yxatda har taklif alohida qator: trade-lock'dagilari (sozlamaga ko'ra) hisobga olinmaydi
            const ul = x.unlock_at; if (ul && cfg().onlyUnlocked && Date.parse(ul) > Date.now()) continue;
            const cnt = Number(pick(x, ["count", "quantity", "amount"])) || 1;
            const h = m.get(name);
            if (!h || usd < h.usd) m.set(name, { usd, cnt: (h ? h.cnt : 0) + cnt }); else h.cnt += cnt;
          }
          diag.push({ url, rows: m.size, kb: Math.round(r.bytes / 1024) });
          if (m.size > (g === "cs2" ? 500 : 50)) { P.map = m; P.ts = Date.now(); P.src = url; break; }
        } catch (e) { diag.push({ url, error: e.message }); }
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
  const OFFERS = new Map();   // id -> { usd, name, float, insp, game, ts }
  function rememberOffer(o, g) {
    OFFERS.set(o.id, { usd: o.usd, name: o.name, float: o.float, insp: o.insp, game: g || "cs2", ts: Date.now() });
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
    // O'yinda ko'rish havolasi (faqat CS2 inspect), stikerlar, nom yorlig'i, pattern
    const link = String(pick(x, ["item_link", "inspect_link", "inspect"]) || "");
    const stk = (Array.isArray(x.stickers) ? x.stickers : []).slice(0, 6)
      .map(t => str(t && typeof t === "object" ? pick(t, ["name", "title", "market_hash_name"]) : t, 80).replace(/^Sticker \| /, "")).filter(Boolean);
    const sr = pick(x, ["item_paint_seed", "paint_seed", "pattern"]), seed = sr == null ? NaN : Number(sr);   // yo'q bo'lsa 0 emas, null
    return { id: String(id), name: String(name), usd, float: fl != null && isFinite(Number(fl)) ? Number(fl) : null,
      locked: !!unlock && Date.parse(unlock) > Date.now(),
      insp: /^steam:\/\/(run|rungame)\/730\/[\w%+\/.-]*$/i.test(link) && link.length < 400 ? link : "",
      stk, nt: str(pick(x, ["name_tag", "nametag"]) || "", 60), seed: Number.isInteger(seed) && seed >= 0 && seed < 100000 ? seed : null };
  }
  function pubOffer(o, g) {
    g = g || "cs2";
    const e = cat(g).BY_NAME.get(o.name) || {};
    return { id: o.id, game: g, name: o.name, b: baseOf(o.name, g), w: e.w || "", s: e.s || "", price: uzs(o.usd), float: o.float, wear: e.wr || "",
      img: e.i || "", rc: e.r || (g === "rust" ? RUST_COLOR : "#b0c3d9"), rn: e.rn || "", cat: e.c || "other", st: /StatTrak/.test(o.name), sv: /^Souvenir /.test(o.name), locked: o.locked,
      insp: !!o.insp, stk: o.stk || [], nt: o.nt || "", seed: o.seed == null ? null : o.seed };
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
  async function search(params, g) {
    g = g || "cs2";
    const c = cfg();
    const r = await call("GET", "market/search", { params: Object.assign({ game: GAMES[g].lis, only_unlocked: c.onlyUnlocked ? 1 : 0 }, params) });
    if (!r.json || r.status >= 400) throw new Error(errOf(r.json) || r.error || ("HTTP " + r.status));
    const items = listOf(r.json).map(normOffer).filter(Boolean)
      .filter(o => o.usd >= c.minUsd && o.usd <= c.maxUsd && (!c.onlyUnlocked || !o.locked));
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
  async function buy(u, offerId) {
    const c = cfg();
    const of = OFFERS.get(String(offerId)), g = of ? of.game : "cs2", G = GAMES[g];
    if (!ready(g)) return { code: 503, body: { error: "off", message: "Skinlar do'koni hozircha yopiq" } };
    const acc = ctx.user(u), tu = parseTrade(acc.cs2Trade);
    if (!tu) return { code: 400, body: { error: "trade_url", message: "Avval Steam trade havolangizni kiriting" } };
    if (!of || Date.now() - of.ts > 15 * 60e3) return { code: 409, body: { error: "stale", message: "Narxlar yangilandi — skinni qaytadan oching" } };
    const price = uzs(of.usd);
    if (!(acc.balance >= price)) return { code: 402, body: { error: "balance", need: price - acc.balance } };
    acc.balance -= price;
    const e = cat(g).BY_NAME.get(of.name) || {};
    const o = { id: ctx.genId("VN"), seq: ctx.nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: (g === "cs2" ? "cs2:" : g + ":") + offerId,
      item: G.icon + " " + G.label + ": " + of.name, price, status: "pending", ts: Date.now(), delivered: null, doneTs: null, quantity: 1,
      cs2: { game: g, name: of.name, offerId: String(offerId), usd: of.usd, float: of.float, img: e.i || "", partner: tu.partner, token: tu.token, state: "buying" },
      costUzs: Math.round(of.usd * c.rate) };
    DBx().orders.push(o); ctx.save(); ctx.notifyOrder(o);
    OFFERS.delete(String(offerId));
    const r = await call("POST", "market/buy", { timeout: Number(process.env.CS2_BUY_TIMEOUT) || 30000, json: { ids: [/^\d+$/.test(String(offerId)) ? Number(offerId) : String(offerId)],
      partner: tu.partner, token: tu.token, max_price: Math.round(of.usd * 100) / 100, custom_id: o.id } });
    const j = r.json, msg = errOf(j);
    if (r.sent && j && r.status >= 200 && r.status < 300 && !(j.error || j.success === false || j.status === false)) {
      o.cs2.purchaseId = str(pick(j, ["data.purchase_id", "purchase_id", "data.id", "id", "data.0.purchase_id"]) || "", 60);
      o.cs2.state = "sent"; ctx.save();
      if (o.status !== "pending") ctx.notifyAdmins("⚠️ #" + o.seq + " " + G.label + ": " + of.name + " — buyurtma admin tomonidan bekor qilingan, lekin lis-skins xaridni bajardi (skin mijozga yuborildi). Tekshiring.", { order: o });
      return { code: 200, body: { ok: true, order: ctx.pubOrder(o), balance: acc.balance, steamOffers: STEAM_OFFERS } };
    }
    if (r.sent && (r.status === 401 || r.status === 403)) {
      alertOnce("cs2-auth", "⛔ Skinlar (lis-skins): kalit noto'g'ri yoki ruxsat yo'q (HTTP " + r.status + "). Admin panel → CS2 skinlar.");
      refund(o, "Skinlar do'koni hozircha ishlamayapti, keyinroq urinib ko'ring.");
      return { code: 503, body: { error: "off", message: "Hozircha ishlamayapti, keyinroq urinib ko'ring", balance: acc.balance } };
    }
    // 4xx — so'rov rad etilgan (xarid bo'lmagan) yoki so'rov umuman yetib bormagan: pul qaytadi
    if (!r.sent || (r.status >= 400 && r.status < 500)) {
      const funds = /balance|fund|insufficient|not enough|недостаточно|баланс/i.test(msg);
      if (funds) alertOnce("cs2-bal", "🚨 Skinlar ishlamayapti — lis-skins hamyonida coin yetarli emas. Hamyonni to'ldiring.");
      else if (r.sent) alertOnce("cs2-rej-" + msg.slice(0, 40), "⚠️ " + G.label + " xaridi rad etildi: " + msg);
      const userMsg = funds || !r.sent ? "Hozircha ishlamayapti, keyinroq urinib ko'ring" : "Bu skin sotilib ketdi yoki narxi o'zgardi — boshqasini tanlang";
      refund(o, userMsg + ".");
      return { code: funds || !r.sent ? 503 : 409, body: { error: funds || !r.sent ? "off" : "gone", message: userMsg, balance: acc.balance } };
    }
    // Javob noaniq — sotib olingan bo'lishi mumkin. Pul band, holat custom_id bo'yicha aniqlanadi.
    o.cs2.state = "unknown"; o.cs2.raw = str(r.error || r.text, 200); ctx.save();
    ctx.notifyAdmins("❓ #" + o.seq + " " + G.label + ": " + of.name + " — lis-skins javobi noaniq (" + o.cs2.raw + "). Holati avtomatik tekshirilmoqda.", { order: o });
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
            ctx.notifyAdmins("ℹ️ Skinlar: lis-skins'dan yangi holat keldi: «" + o.cs2.raw + "» (#" + o.seq + "). Buyurtma kutishda turibdi — bu xabarni dasturchiga yuboring.");
          }
          if (w === "done") markDone(o);
          else if (w === "failed") {
            refund(o, "Trade qabul qilinmadi yoki bekor bo'ldi — pul balansga qaytdi.");
            ctx.notifyAdmins("↩️ #" + o.seq + " " + o.cs2.name + " — lis-skins holati «" + o.cs2.raw + "», mijozga pul qaytarildi. lis-skins balansiga qaytganini tekshiring.");
          } else ctx.save();
        }
        // Javob noaniq bo'lgan xarid lis-skins'da custom_id bo'yicha uzoq vaqt topilmasa — demak sotib olinmagan.
        for (const o of chunk) if (o.status === "pending" && o.cs2.state === "unknown" && !seen.has(o.id) && Date.now() - o.ts > UNKNOWN_MS) {
          refund(o, "Xarid amalga oshmadi — pul balansga qaytdi.");
          ctx.notifyAdmins("↩️ #" + o.seq + " " + o.cs2.name + " — lis-skins'da bu xarid topilmadi, mijozga pul qaytarildi.");
        }
      }
      // Trade 2 soatdan beri qabul qilinmagan bo'lsa — mijozga bir marta eslatma.
      for (const o of list) if (o.status === "pending" && o.cs2.state === "sent" && !o.cs2.reminded && Date.now() - o.ts > 2 * 3600e3) {
        o.cs2.reminded = true; ctx.save();
        ctx.tgSend(o.uid, "⏳ " + o.cs2.name + " — Steam'dagi trade taklifini qabul qiling: " + STEAM_OFFERS);
      }
    } catch (e) { console.log("[skins] holat: " + e.message); }
    finally { polling = false; }
  }
  { const t = setInterval(() => { poll(); }, Number(process.env.CS2_POLL_MS) || 60000); if (t.unref) t.unref(); }
  async function balance() {
    const r = await call("GET", "user/balance", { timeout: 15000 });
    const b = r.json && pick(r.json, ["data.balance", "balance", "data.amount"]);
    if (b != null) return { id: "cs2", name: "Skinlar · lis-skins", ok: true, message: "Balans: " + b + " USD" };
    return { id: "cs2", name: "Skinlar · lis-skins", ok: false, message: errOf(r.json) || r.error || ("HTTP " + r.status) };
  }

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
        delivered: DONE_N() });
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
      const sort = ["lowest_price", "highest_price", "newest"].indexOf(q.get("sort")) !== -1 ? q.get("sort") : "lowest_price";
      const pmin = Math.max(0, Number(q.get("pmin")) || 0), pmax = Math.max(0, Number(q.get("pmax")) || 0), cursor = str(q.get("cursor"), 200);
      const key = "m|" + g + "|" + sort + "|" + pmin + "|" + pmax + "|" + cursor;
      cached(key, 60000, () => search({ sort_by: sort, cursor, price_from: pmin ? Math.floor(usdOf(pmin) * 100) / 100 : undefined, price_to: pmax ? Math.ceil(usdOf(pmax) * 100) / 100 : undefined }, g), u.id)
        .then(r => send(res, 200, { items: r.items.filter(o => (g !== "cs2" || cat(g).BY_NAME.has(o.name)) && OFFERS.has(o.id)).map(o => pubOffer(o, g)), next: r.next }))
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
      const weaponsOf = l => { if (!ct || g !== "cs2") return undefined; const mm = new Map(); for (const G of l) mm.set(G.w, (mm.get(G.w) || 0) + 1);
        return [...mm.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([w, n]) => ({ w, n })); };
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
          weapons: page ? undefined : weaponsOf(priced.map(x => x.G)) });
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
      if (!ready(g)) { send(res, 200, { item: head, offers: [] }); return true; }
      cached("i|" + g + "|" + nm.join("|"), 60000, () => search({ names: nm, sort_by: "lowest_price" }, g), u.id)
        .then(r => {
          const per = new Map(), offers = [];
          for (const o of r.items) { if (!OFFERS.has(o.id)) continue; const k = per.get(o.name) || 0; if (k >= 10) continue; per.set(o.name, k + 1); offers.push(o); }
          send(res, 200, { item: head, offers: offers.slice(0, 80).map(o => pubOffer(o, g)) });
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
      const view = () => {
        const c = cfg(), P = pr("cs2"), per = {};
        for (const g of GAME_KEYS) { const C = cat(g), Q = pr(g);
          per[g] = { on: !!c.games[g], catalog: C.list.length, skins: C.GROUPS.length, catalogTs: C.TS, loading: !!C.loading, error: C.err || "",
            prices: Q.map ? Q.map.size : 0, pricesTs: Q.ts, pricesUrl: c.pricesUrls[g] || (g === "cs2" ? c.pricesUrl || "" : ""),
            pricesDiag: Q.diag.map(d => d.url.replace(/^https?:\/\//, "") + " → " + (d.error || d.rows + " ta nom, " + d.kb + " KB")) }; }
        return { enabled: c.enabled, rate: c.rate, markup: c.markup, minUsd: c.minUsd, maxUsd: c.maxUsd, onlyUnlocked: c.onlyUnlocked, apiKeySet: !!c.apiKey, games: per,
          // eski maydonlar (CS2) — mavjud admin oynalari uchun
          catalog: cat("cs2").list.length, skins: cat("cs2").GROUPS.length, catalogTs: cat("cs2").TS, prices: P.map ? P.map.size : 0, pricesTs: P.ts,
          pricesUrl: per.cs2.pricesUrl, pricesSrc: P.src, pricesDiag: per.cs2.pricesDiag };
      };
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
        setTimeout(() => loadPrices().catch(() => {}), 300);
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
  return { handle, ready, games: gamesPublic, balance, cfg, poll, parseTrade, _internal: { normOffer, stateWord, index, OFFERS, dotaMeta, rustMeta } };
};
