/* ================= O'yinlar do'koni =================
   O'yinlar (MLBB, PUBG...), ularning paketlari (86 olmos, 660 UC...) va "liniyalar" —
   paketni haqiqatda kim to'ldirib berishi (yetkazib beruvchi sayt API'si yoki admin).

   Ma'lumotlar DB.settings.games ichida saqlanadi (settings jadvali — qayta deploy'da
   yo'qolmaydi):
     games:    [{ id, name, img, banner, color, fields, regions, tabs, active, sort }]
     packages: [{ id, gameId, region, tab, name, sub, icon, img, badge, price, active, sort, routes }]
     lines:    [{ id, name, type, enabled, priority, config, note }]

   Paket bir nechta liniyaga biriktirilishi mumkin (routes: [{ lineId, sku, cost }]).
   Buyurtma kelganda yoqilgan liniyalar ustuvorlik bo'yicha sinab ko'riladi: biri
   ishlamasa — keyingisi. Hech biri bajarmasa buyurtma "kutilmoqda" holida qoladi va
   admin uni qo'lda bajaradi yoki bekor qiladi (pul o'zi qaytadi).

   Yangi sayt ulash = yangi liniya turi: registerLineType("nom", { label, fields,
   order(line, order, pkg, route), check?(line, game, account), status?(line, ref) }). */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_IMG = 1.5 * 1024 * 1024;

module.exports = function createGames(ctx) {
  const DBx = () => ctx.getDB();
  const IMG_DIR = path.join(ctx.DATA_DIR, "game-img");
  try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch (e) {}

  /* ---------- liniya turlari ---------- */
  const LINE_TYPES = {
    manual: {
      label: "Qo'lda (admin bajaradi)",
      fields: [],
      // Hech narsa qilmaydi: buyurtma kanalga tushadi, admin o'yinchi ID'si bo'yicha
      // to'ldiradi va "Bajarildi" bosadi.
      async order() { return { state: "manual" }; }
    }
  };
  function registerLineType(name, impl) { LINE_TYPES[name] = impl; }
  // MooGold, G2Bulk, Smile.one — lines.js
  try { require("./lines.js").register(registerLineType); } catch (e) { console.log("[games] lines.js yuklanmadi: " + e.message); }

  /* ---------- ombor ---------- */
  function store() {
    const DB = DBx();
    if (!DB.settings) DB.settings = {};
    if (!DB.settings.games) { DB.settings.games = seed(); ctx.save(); }
    const s = DB.settings.games;
    if (!Array.isArray(s.games)) s.games = [];
    if (!Array.isArray(s.packages)) s.packages = [];
    if (!Array.isArray(s.lines)) s.lines = [];
    // 2-versiya: uchta sayt liniyasi va ikkita bo'sh joy. Kalitsiz bo'lgani uchun
    // o'chiq holda qo'shiladi; "Qo'lda" eng oxirgi zaxira bo'lib qoladi.
    if ((s.linesV || 1) < 2) {
      const want = [
        { id: "moogold", name: "1-liniya · MooGold", type: "moogold", priority: 10 },
        { id: "g2bulk", name: "2-liniya · G2Bulk", type: "g2bulk", priority: 20 },
        { id: "smileone", name: "3-liniya · Smile.one", type: "smileone", priority: 30 },
        { id: "slot4", name: "4-liniya · bo'sh joy", type: "manual", priority: 40, note: "Yangi sayt uchun ajratilgan" },
        { id: "slot5", name: "5-liniya · bo'sh joy", type: "manual", priority: 50, note: "Yangi sayt uchun ajratilgan" }
      ];
      for (const w of want) if (!s.lines.some(l => l.id === w.id))
        s.lines.push(Object.assign({ enabled: false, config: { rate: "", markup: "" }, note: "" }, w));
      const man = s.lines.find(l => l.id === "manual");
      if (man) { man.priority = 100; if (/^Qo'lda$/.test(man.name)) man.name = "Qo'lda (zaxira)"; }
      s.linesV = 2;
      ctx.save();
    }
    // 3-versiya: "AI xizmatlar" bo'limi. O'yinlar bilan bir xil mexanizm (paketlar,
    // liniyalar, zaxira), faqat akkaunt sifatida email so'raladi. Narxsiz va o'chiq —
    // admin narx qo'yib yoqmaguncha do'konda ko'rinmaydi.
    if ((s.aiV || 0) < 1) {
      const ai = aiSeed();
      for (const g of ai.games) if (!s.games.some(x => x.id === g.id)) s.games.push(g);
      for (const p of ai.packages) if (!s.packages.some(x => x.id === p.id)) s.packages.push(p);
      s.aiV = 1;
      ctx.save();
    }
    return s;
  }
  const gameById = id => store().games.find(g => g.id === id);
  const pkgById = id => store().packages.find(p => p.id === id);
  const lineById = id => store().lines.find(l => l.id === id);

  /* Boshlang'ich to'plam: eng ko'p sotiladigan uchta o'yin va ularning standart
     paketlari. NARX QO'YILMAGAN va o'chirilgan holda — admin narx yozib yoqmaguncha
     do'konda ko'rinmaydi. "Qo'lda" liniyasi darhol ishlaydi. */
  function seed() {
    const P = (gameId, tab, amount, extra) => Object.assign({
      id: gameId + "-" + tab + "-" + String(amount).replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
      gameId, region: "global", tab, name: String(amount), sub: "", icon: "diamond", img: "", badge: "",
      price: 0, active: false, sort: 0, routes: [{ lineId: "manual", sku: "", cost: 0 }]
    }, extra || {});
    const pk = [];
    [86, 172, 257, 344, 429, 514, 706, 878, 1412, 2195, 3688, 5532, 9288].forEach((a, i) =>
      pk.push(P("mlbb", "diamonds", a, { sub: "olmos", sort: 10 + i })));
    [["50+50", 1], ["150+150", 2], ["250+250", 3], ["500+500", 4]].forEach(([a, i]) =>
      pk.push(P("mlbb", "diamonds", "x2-" + a, { name: a, sub: "olmos", badge: "2x", sort: i })));
    pk.push(P("mlbb", "pass", "weekly", { name: "Haftalik propusk", icon: "pass", sort: 1 }));
    pk.push(P("mlbb", "pass", "twilight", { name: "Twilight propusk", icon: "pass", sort: 2 }));
    [60, 325, 660, 1800, 3850, 8100].forEach((a, i) =>
      pk.push(P("pubg", "uc", a, { sub: "UC", icon: "uc", sort: i })));
    [100, 310, 520, 1060, 2180, 5600].forEach((a, i) =>
      pk.push(P("ff", "diamonds", a, { sub: "olmos", sort: i })));
    const idField = { key: "userId", label: "Player ID", ph: "123456789", re: "^\\d{5,15}$" };
    return {
      v: 1,
      games: [
        { id: "mlbb", name: "Mobile Legends", img: "", banner: "", color: "#3b5bdb", active: true, sort: 1,
          fields: [{ key: "userId", label: "Player ID", ph: "123456789", re: "^\\d{4,15}$" },
                   { key: "zoneId", label: "Server ID", ph: "1234", re: "^\\d{1,6}$" }],
          regions: [{ key: "global", label: "🌐 Global" }, { key: "ph", label: "PH" }, { key: "ru", label: "RU" },
                    { key: "tr", label: "TR" }, { key: "id", label: "ID" }, { key: "sg", label: "SG" }, { key: "my", label: "MY" }],
          tabs: [{ key: "diamonds", label: "Olmoslar" }, { key: "pass", label: "Propusklar" }] },
        { id: "pubg", name: "PUBG Mobile", img: "", banner: "", color: "#c99a2e", active: true, sort: 2,
          fields: [idField], regions: [{ key: "global", label: "🌐 Global" }],
          tabs: [{ key: "uc", label: "UC" }, { key: "bundles", label: "To'plamlar" }] },
        { id: "ff", name: "Free Fire", img: "", banner: "", color: "#e8590c", active: true, sort: 3,
          fields: [idField], regions: [{ key: "global", label: "🌐 Global" }],
          tabs: [{ key: "diamonds", label: "Olmoslar" }] }
      ],
      packages: pk,
      lines: [{ id: "manual", name: "Qo'lda", type: "manual", enabled: true, priority: 100, config: {}, note: "" }]
    };
  }

  const EMAIL_RE = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$";
  function aiSeed() {
    const E = [{ key: "email", label: "Akkaunt email", ph: "siz@gmail.com", re: EMAIL_RE, type: "email" }];
    const G = (id, name, color, sort) => ({ id, name, section: "ai", img: "", banner: "", color, active: true, sort: 100 + sort,
      fields: E, regions: [{ key: "global", label: "🌐 Global" }], tabs: [{ key: "sub", label: "Obunalar" }] });
    const P = (gameId, key, name, sub, sort) => ({ id: gameId + "-" + key, gameId, region: "global", tab: "sub", name, sub, icon: "ai",
      img: "", badge: "", price: 0, active: false, sort, routes: [{ lineId: "manual", sku: "", cost: 0 }] });
    return {
      games: [G("chatgpt", "ChatGPT", "#10a37f", 1), G("claude", "Claude", "#d97757", 2), G("gemini", "Google Gemini", "#4285f4", 3),
        G("midjourney", "Midjourney", "#5b5bd6", 4), G("grok", "Grok", "#444b57", 5), G("perplexity", "Perplexity", "#20b8cd", 6),
        G("cursor", "Cursor", "#3a3f4b", 7)],
      packages: [
        P("chatgpt", "plus-1m", "Plus", "1 oy", 1), P("chatgpt", "plus-3m", "Plus", "3 oy", 2), P("chatgpt", "pro-1m", "Pro", "1 oy", 3),
        P("claude", "pro-1m", "Pro", "1 oy", 1), P("claude", "max5-1m", "Max 5x", "1 oy", 2),
        P("gemini", "pro-1m", "AI Pro", "1 oy", 1), P("gemini", "pro-12m", "AI Pro", "12 oy", 2),
        P("midjourney", "basic-1m", "Basic", "1 oy", 1), P("midjourney", "standard-1m", "Standard", "1 oy", 2),
        P("grok", "super-1m", "SuperGrok", "1 oy", 1),
        P("perplexity", "pro-1m", "Pro", "1 oy", 1), P("perplexity", "pro-12m", "Pro", "12 oy", 2),
        P("cursor", "pro-1m", "Pro", "1 oy", 1)
      ]
    };
  }

  /* ---------- saytdan rasm yuklash ----------
     Rasmlar sayt serveridan bir marta yuklab olinadi va /gimg/ ostida saqlanadi:
     mijoz ilovasi begona saytga murojaat qilmaydi (tez, va sayt rasmni o'chirsa ham qoladi). */
  function fetchImage(url, depth) {
    return new Promise(resolve => {
      let u; try { u = new URL(url); } catch (e) { return resolve(""); }
      if (u.protocol !== "https:" && u.protocol !== "http:") return resolve("");
      const mod = u.protocol === "https:" ? require("https") : require("http");
      let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
      const req = mod.get(u, { timeout: 15000, headers: { "User-Agent": "VerionShop/1.0" } }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (depth || 0) < 3) {
          r.resume(); return fetchImage(new URL(r.headers.location, u).toString(), (depth || 0) + 1).then(fin);
        }
        const ct = String(r.headers["content-type"] || "").toLowerCase();
        const ext = /png/.test(ct) ? "png" : /jpe?g/.test(ct) ? "jpg" : /webp/.test(ct) ? "webp" : "";
        if (r.statusCode !== 200 || !ext) { r.resume(); return fin(""); }
        const chunks = []; let size = 0;
        r.on("data", c => { size += c.length; if (size > MAX_IMG) { req.destroy(); fin(""); } else chunks.push(c); });
        r.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) return fin("");
          const file = crypto.createHash("sha1").update(buf).digest("hex") + "." + ext;
          fs.writeFile(path.join(IMG_DIR, file), buf, err => fin(err ? "" : "/gimg/" + file));
        });
        r.on("error", () => fin(""));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => fin(""));
    });
  }
  /* Saytdagi nomni do'kon ko'rinishiga keltiradi:
     "Mobile Legends (BR) - 86 Diamonds" → { name: "86", sub: "olmos", icon: "diamond" } */
  function smartName(raw, gameName) {
    let t = String(raw || "").replace(/\s+/g, " ").trim();
    if (gameName) t = t.replace(new RegExp("^" + gameName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[-–:|]?\\s*", "i"), "");
    t = t.replace(/^\([^)]*\)\s*[-–:]?\s*/, "");
    const m = /(\d[\d,. ]*(?:\s*\+\s*\d[\d,. ]*)?)\s*(diamonds?|dias?|dm|💎|olmos|uc|unknown cash|coins?|crystals?|gems?)\b/i.exec(t);
    if (m) {
      const unit = m[2].toLowerCase();
      const isUc = /^uc|unknown/.test(unit);
      const isGem = /diamond|dia|dm|💎|olmos|gem|crystal/.test(unit);
      return { name: m[1].replace(/[ ,]/g, "").replace(/\+/g, "+"), sub: isUc ? "UC" : isGem ? "olmos" : unit, icon: isUc ? "uc" : isGem ? "diamond" : "coin" };
    }
    if (/weekly/i.test(t) && /pass/i.test(t)) return { name: "Haftalik propusk", sub: "", icon: "pass" };
    if (/twilight/i.test(t)) return { name: "Twilight propusk", sub: "", icon: "pass" };
    if (/pass|propusk|weekly|prime|membership|card/i.test(t)) return { name: t.slice(0, 40), sub: "", icon: "pass" };
    return { name: t.slice(0, 40) || String(raw || "").slice(0, 40), sub: "", icon: "diamond" };
  }
  function calcPrice(cost, rate, markup) {
    const v = Number(cost) * Number(rate) * (1 + (Number(markup) || 0) / 100);
    return v > 0 ? Math.ceil(v / 100) * 100 : 0;
  }

  /* ---------- tekshiruvchilar ---------- */
  const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  const slug = (v, max) => /^[a-z0-9][a-z0-9_-]*$/.test(String(v || "")) ? String(v).slice(0, max || 40) : "";
  const imgUrl = v => { const s = str(v, 500); return (!s || /^\/gimg\/[a-f0-9]{16,40}\.(png|jpe?g|webp)$/.test(s) || /^https:\/\//.test(s)) ? s : ""; };
  const ICONS = ["diamond", "uc", "pass", "coin", "gift", "ai"];
  function cleanMeta(m) {
    if (!m || typeof m !== "object") return undefined;
    const out = {};
    if (Array.isArray(m.fields)) out.fields = m.fields.slice(0, 3).map(f => str(f, 40)).filter(Boolean);
    if (m.game) out.game = str(m.game, 60);
    if (m.product) out.product = str(m.product, 60);
    return Object.keys(out).length ? out : undefined;
  }
  function safeRe(re) {
    if (!re) return "";
    const s = str(re, 120);
    try { new RegExp(s); return s; } catch (e) { return null; }
  }
  // Mijoz kiritgan o'yinchi ma'lumotlari. Har bir maydon o'yin sozlamasidagi shablon
  // bo'yicha; shablonsiz bo'lsa ham faqat oddiy belgilar (raqam/harf/_-.) ruxsat.
  function cleanAccount(game, raw) {
    const out = {};
    for (const f of game.fields || []) {
      const email = f.type === "email";
      const v = str(raw && raw[f.key], email ? 80 : 32).trim();
      if (!v) return { error: "required", field: f.key, label: f.label };
      if (!(email ? /^[A-Za-z0-9_.+@-]+$/ : /^[A-Za-z0-9_.-]+$/).test(v)) return { error: "format", field: f.key, label: f.label };
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return { error: "format", field: f.key, label: f.label };
      if (f.re) { let ok = false; try { ok = new RegExp(f.re).test(v); } catch (e) { ok = true; } if (!ok) return { error: "format", field: f.key, label: f.label }; }
      out[f.key] = v;
    }
    return { account: out };
  }
  function accountText(game, acc) {
    const fs_ = game.fields || [];
    if (!fs_.length) return "";
    const first = acc[fs_[0].key] || "";
    const rest = fs_.slice(1).map(f => acc[f.key]).filter(Boolean);
    return first + (rest.length ? " (" + rest.join(") (") + ")" : "");
  }

  /* ---------- ommaviy katalog ---------- */
  // Do'konda faqat narxi qo'yilgan va yoqilgan paketlar; paketsiz o'yin ko'rinmaydi.
  // Tannarx, SKU va liniya ma'lumotlari mijozga hech qachon yuborilmaydi.
  let pubCache = { key: "", body: "", etag: "" };
  function publicCatalog() {
    const s = store();
    const pk = s.packages.filter(p => p.active && p.price > 0 && s.games.some(g => g.id === p.gameId && g.active));
    const gids = new Set(pk.map(p => p.gameId));
    const games = s.games.filter(g => g.active && gids.has(g.id)).sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(g => ({ id: g.id, name: g.name, section: g.section === "ai" ? "ai" : "games", img: g.img || "", banner: g.banner || "", color: g.color || "",
        fields: (g.fields || []).map(f => ({ key: f.key, label: f.label, ph: f.ph || "", re: f.re || "", type: f.type === "email" ? "email" : "" })),
        regions: g.regions || [], tabs: g.tabs || [],
        canCheck: !!checkLineFor(g) }));
    const packages = pk.sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(p => ({ id: p.id, gameId: p.gameId, region: p.region || "", tab: p.tab || "", name: p.name, sub: p.sub || "",
        icon: p.icon || "diamond", img: p.img || "", badge: p.badge || "", price: p.price }));
    const body = JSON.stringify({ games, packages });
    if (body !== pubCache.body) pubCache = { body, etag: '"' + crypto.createHash("sha1").update(body).digest("hex") + '"' };
    return pubCache;
  }

  /* ---------- liniyalar ---------- */
  function routesFor(pkg) {
    return (pkg.routes || [])
      .map(r => ({ r, line: lineById(r.lineId) }))
      .filter(x => x.line && x.line.enabled && LINE_TYPES[x.line.type])
      .sort((a, b) => (a.line.priority || 0) - (b.line.priority || 0));
  }
  // Nikni tekshira oladigan liniya + o'sha liniyaga biriktirilgan shu o'yin paketi
  // (Smile.one tekshiruvi uchun mahsulot kodi va productid kerak).
  function checkLineFor(game) {
    const s = store();
    const lines = s.lines.filter(l => l.enabled && LINE_TYPES[l.type] && typeof LINE_TYPES[l.type].check === "function")
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    for (const l of lines) {
      for (const p of s.packages) {
        if (p.gameId !== game.id || !p.active) continue;
        const r = (p.routes || []).find(x => x.lineId === l.id && x.sku);
        if (r) return { line: l, route: r };
      }
    }
    return null;
  }
  function markDone(o, line, res) {
    if (o.status !== "pending") return;
    o.status = "done"; o.doneTs = Date.now();
    o.delivered = res.message || ("✅ " + o.item + " — " + (o.game && o.game.accountText ? "ID " + o.game.accountText : "") + " hisobiga tushirildi");
    o.line = { id: line.id, name: line.name, ref: res.ref || "", state: "done" };
    ctx.save();
    try { ctx.creditReferralOnOrder(o); ctx.creditLoyaltyOnOrder(o); } catch (e) {}
    ctx.tgSend(o.uid, "✅ Buyurtmangiz bajarildi: " + o.item);
    ctx.notifyOrderChannel(o);
  }
  // Admin bot ulangan bo'lsa — o'sha orqali (buyurtma tugmalari bilan), aks holda do'kon boti.
  function alertAdmins(text, o) {
    if (typeof ctx.notifyAdmins === "function") return ctx.notifyAdmins(text, o ? { order: o } : undefined);
    for (const aid of ctx.ADMIN_IDS) ctx.tgSend(aid, text);
  }
  // Tannarx (so'mda) — moliya hisobotidagi foyda uchun: saytdagi narx × liniya kursi.
  function costUzs(r, line) {
    const c = Number(r && r.cost) || 0, rate = Number(line && line.config && line.config.rate) || 0;
    return c > 0 && rate > 0 ? Math.round(c * rate) : 0;
  }
  function lineEnv(line) {
    const base = typeof ctx.publicBase === "function" ? ctx.publicBase() : "";
    if (!base) return {};
    if (!line.cbToken) { line.cbToken = crypto.randomBytes(12).toString("hex"); ctx.save(); }
    return { callbackUrl: base + "/api/lines/cb/" + line.id + "/" + line.cbToken };
  }
  // exclude — oldin sinab ko'rilgan (va "bajarilmadi" degan) liniyalar.
  async function fulfill(o, exclude) {
    const pkg = pkgById(o.game && o.game.packageId);
    if (!pkg || o.status !== "pending") return;
    const list = routesFor(pkg).filter(x => !(exclude && exclude.has(x.line.id)));
    o.attempts = o.attempts || [];
    const failedHere = [];
    for (const { r, line } of list) {
      let res;
      try { res = await LINE_TYPES[line.type].order(line, o, pkg, r, lineEnv(line)); }
      // Istisno — so'rov saytga yetib borgan-bormagani noma'lum. Xavfsiz tomonga: to'xtaymiz.
      catch (e) { res = { state: "unknown", message: String((e && e.message) || e) }; }
      res = res || { state: "unknown", message: "javob yo'q" };
      o.attempts.push({ lineId: line.id, at: Date.now(), state: res.state, message: str(res.message, 300), ref: str(res.ref, 120) });
      if (res.disableLine && line.enabled) {
        // Masalan kalit noto'g'ri (401). Qayta-qayta urinish saytda IP bloklanishiga olib
        // kelishi mumkin (G2Bulk shunday ogohlantiradi) — liniyani o'chirib qo'yamiz.
        line.enabled = false;
        alertAdmins("⛔ " + line.name + " liniyasi o'chirildi: " + str(res.message, 200) + "\nAdmin panel → O'yinlar va liniyalar.");
      }
      if (o.status !== "pending") { ctx.save(); return; }        // shu orada admin bekor qilgan
      if (res.state === "done" || res.state === "accepted") o.costUzs = costUzs(r, line);
      if (res.state === "done") return markDone(o, line, res);
      if (res.state === "accepted") { o.line = { id: line.id, name: line.name, ref: str(res.ref, 120), state: "accepted" }; ctx.save(); return; }
      if (res.state === "unknown") {
        o.line = { id: line.id, name: line.name, ref: str(res.ref, 120), state: "unknown", message: str(res.message, 300) };
        ctx.save();
        alertAdmins("❓ #" + o.seq + " " + o.item + " — " + line.name + " javobi tushunarsiz: " + str(res.message, 200)
          + "\nSaytda buyurtma yaratilgan bo'lishi mumkin. Avval saytdan tekshiring, keyin \"Bajarildi\" yoki \"Bekor qilish\" bosing. Ikkinchi marta yuborilmadi.", o);
        return;
      }
      if (res.state === "manual") {
        o.line = { id: line.id, name: line.name, state: "manual" }; ctx.save();
        if (failedHere.length) alertAdmins("⚠️ #" + o.seq + " " + o.item + " — avtomatik liniyalar bajarmadi, qo'lda bajaring.\n" + failedHere.join("\n"), o);
        return;
      }
      failedHere.push(line.name + ": " + (res.message || res.state));   // "failed" — keyingi liniyaga
    }
    o.line = { state: "manual", failedAll: list.length > 0 };
    ctx.save();
    if (list.length) alertAdmins("⚠️ #" + o.seq + " " + o.item + " — hech bir liniya bajarmadi, qo'lda bajaring.\n" + failedHere.join("\n"), o);
  }
  // "accepted" holatidagi buyurtmalarni sayt API'sidan so'rab turadi (status() bor turlar uchun).
  async function pollAccepted() {
    for (const o of DBx().orders) {
      if (o.status !== "pending" || !o.line || o.line.state !== "accepted") continue;
      const line = lineById(o.line.id), T = line && LINE_TYPES[line.type];
      if (!T || typeof T.status !== "function") continue;
      let res; try { res = await T.status(line, o.line.ref, o); } catch (e) { continue; }
      if (!res) continue;
      if (res.state === "done") markDone(o, line, res);
      else if (res.state === "failed") { o.line.state = "failed"; o.line.message = str(res.message, 300); ctx.save(); fulfillNext(o, line.id); }
    }
  }
  // Bir liniya keyin "bajarilmadi" desa — qolgan liniyalardan davom etamiz.
  function fulfillNext(o, failedLineId) {
    const tried = new Set((o.attempts || []).map(x => x.lineId));
    tried.add(failedLineId);
    fulfill(o, tried).catch(e => console.log("[games] fulfill xato: " + e.message));
  }
  const pollTimer = setInterval(() => { pollAccepted().catch(() => {}); }, Number(process.env.GAMES_POLL_MS) || 60 * 1000);
  if (pollTimer.unref) pollTimer.unref();

  /* ---------- yordamchilar ---------- */
  function sendJSON(res, code, obj) { ctx.send(res, code, obj); }
  function adminOnly(req, res) {
    const a = ctx.auth(req);
    if (!ctx.isAdm(a)) { sendJSON(res, 403, { error: "not admin" }); return null; }
    return a;
  }
  // Har bir mijozga daqiqasiga cheklangan "Tekshirish" — sayt API'sini zo'riqtirmaslik uchun.
  const checkHits = new Map();
  function allowCheck(uid) {
    const now = Date.now(), w = checkHits.get(uid) || [];
    const recent = w.filter(t => now - t < 60000);
    if (recent.length >= 20) { checkHits.set(uid, recent); return false; }
    recent.push(now); checkHits.set(uid, recent); return true;
  }
  function maskLine(l) {
    const T = LINE_TYPES[l.type] || { fields: [] };
    const cfg = {};
    for (const f of T.fields || []) {
      const v = (l.config || {})[f.key];
      // Maxfiy kalit admin panelga ham qaytarilmaydi — faqat "o'rnatilgan" belgisi.
      if (f.secret) { cfg[f.key] = ""; cfg[f.key + "__set"] = !!v; }
      else cfg[f.key] = v == null ? "" : v;
    }
    return { id: l.id, name: l.name, type: l.type, enabled: !!l.enabled, priority: l.priority || 0, note: l.note || "", config: cfg };
  }

  /* ---------- so'rovlar ---------- */
  function handle(req, res, url, m) {
    if (url.indexOf("/gimg/") === 0 && m === "GET") {
      const file = url.slice(6);
      if (!/^[a-f0-9]{16,40}\.(png|jpe?g|webp)$/.test(file)) { sendJSON(res, 400, { error: "bad file" }); return true; }
      fs.readFile(path.join(IMG_DIR, file), (err, buf) => {
        if (err) return sendJSON(res, 404, { error: "not found" });
        const ext = path.extname(file).slice(1);
        res.writeHead(200, { "Content-Type": ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(buf);
      });
      return true;
    }

    if (url === "/api/games" && m === "GET") {
      const c = publicCatalog();
      if (req.headers["if-none-match"] === c.etag) { res.writeHead(304, { ETag: c.etag, "Cache-Control": "no-cache" }); res.end(); return true; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: c.etag });
      res.end(c.body);
      return true;
    }

    if (url === "/api/games/check" && m === "POST") {
      const u = ctx.auth(req);
      if (!u) { sendJSON(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, async b => {
        const g = gameById(str(b.gameId, 40));
        if (!g || !g.active) return sendJSON(res, 404, { error: "no game" });
        const c = cleanAccount(g, b.account);
        if (c.error) return sendJSON(res, 400, { error: c.error, field: c.field, label: c.label });
        const cl = checkLineFor(g);
        if (!cl) return sendJSON(res, 200, { ok: true, checked: false });
        if (!allowCheck(u.id)) return sendJSON(res, 429, { error: "too_many" });
        try {
          const r = await LINE_TYPES[cl.line.type].check(cl.line, g, c.account, cl.route);
          if (!r) return sendJSON(res, 200, { ok: true, checked: false });
          if (r && r.ok) return sendJSON(res, 200, { ok: true, checked: true, nickname: str(r.nickname, 60) });
          return sendJSON(res, 200, { ok: false, checked: true, message: str(r && r.message, 160) || "Akkaunt topilmadi" });
        } catch (e) { return sendJSON(res, 200, { ok: true, checked: false }); }
      });
      return true;
    }

    if (url === "/api/games/promo" && m === "POST") {
      const u = ctx.auth(req);
      if (!u) { sendJSON(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => {
        const p = pkgById(str(b.packageId, 80));
        if (!p || !p.active || !(p.price > 0)) return sendJSON(res, 404, { error: "no item" });
        const r = ctx.validatePromo(b.code, u.id, Math.round(p.price));
        if (!r.ok) return sendJSON(res, 409, { error: "promo_invalid", reason: r.reason, minOrder: r.minOrder });
        sendJSON(res, 200, { ok: true, code: r.promo.code, discount: r.discount, total: Math.round(p.price) - r.discount });
      });
      return true;
    }

    if (url === "/api/games/buy" && m === "POST") {
      const u = ctx.auth(req);
      if (!u) { sendJSON(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" }); return true; }
      ctx.readBody(req, res, b => {
        const p = pkgById(str(b.packageId, 80));
        const g = p && gameById(p.gameId);
        if (!p || !g || !p.active || !g.active || !(p.price > 0)) return sendJSON(res, 404, { error: "no item" });
        const c = cleanAccount(g, b.account);
        if (c.error) return sendJSON(res, 400, { error: c.error, field: c.field, label: c.label });
        let total = Math.round(p.price), promo = null;
        if (b.promoCode) {
          const pv = ctx.validatePromo(b.promoCode, u.id, total);
          if (!pv.ok) return sendJSON(res, 409, { error: "promo_invalid", reason: pv.reason });
          total = Math.max(0, total - pv.discount);
          promo = { code: pv.promo.code, discount: pv.discount, ref: pv.promo };
        }
        const acc = ctx.user(u);
        // Tekshiruv va yechish BIR xil sinxron qadamda — oraliqda await yo'q, shuning
        // uchun bir vaqtda bosilgan ikki xarid balansdan ikki marta o'tib keta olmaydi.
        if (acc.balance < total) return sendJSON(res, 402, { error: "balance", need: total - acc.balance });
        acc.balance -= total;
        const reg = (g.regions || []).find(r => r.key === p.region);
        const item = g.name + " — " + p.name + (p.sub ? " " + p.sub : "") + (reg && (g.regions || []).length > 1 ? " [" + reg.label.replace(/^\S+\s/, "") + "]" : "");
        const o = {
          id: ctx.genId("VN"), seq: ctx.nextOrderSeq(), uid: u.id, uname: u.username || null,
          itemId: "game:" + p.id, item, price: total, status: "pending", ts: Date.now(), quantity: 1,
          delivered: null, doneTs: null,
          promoCode: promo ? promo.code : null, promoDiscount: promo ? promo.discount : 0,
          game: { gameId: g.id, gameName: g.name, packageId: p.id, region: p.region || "", account: c.account,
            accountText: accountText(g, c.account), fields: (g.fields || []).map(f => ({ key: f.key, label: f.label })) },
          line: null
        };
        DBx().orders.push(o);
        if (promo) ctx.consumePromo(promo.ref, u.id);
        ctx.save();
        ctx.notifyOrder(o);
        sendJSON(res, 200, { ok: true, order: o, balance: acc.balance });
        setImmediate(() => fulfill(o).catch(e => console.log("[games] fulfill xato: " + e.message)));
      });
      return true;
    }

    /* Sayt buyurtma holatini o'zi xabar qiladigan manzil (G2Bulk callback_url).
       Manzilda har liniyaning maxfiy tokeni bor — begona odam soxta "bajarildi" yubora olmaydi. */
    const cbm = /^\/api\/lines\/cb\/([a-z0-9_-]{1,40})\/([a-f0-9]{24})$/.exec(url);
    if (cbm && m === "POST") {
      const line = lineById(cbm[1]);
      if (!line || !line.cbToken || line.cbToken !== cbm[2]) { sendJSON(res, 403, { error: "bad token" }); return true; }
      ctx.readBody(req, res, b => {
        sendJSON(res, 200, { ok: true });
        const ordObj = (b && typeof b.order === "object" && b.order) || (b && typeof b.data === "object" && b.data) || b || {};
        const keys = [ordObj.remark, b && b.remark, ordObj.id, ordObj.order_id, b && b.order_id].filter(Boolean).map(String);
        const o = DBx().orders.find(x => x.status === "pending" && x.game && x.line && x.line.id === line.id
          && (keys.indexOf(String(x.id)) !== -1 || (x.line.ref && keys.indexOf(String(x.line.ref)) !== -1)));
        if (!o) return;
        const w = require("./lines.js")._internal.g2StatusWord(ordObj.status || ordObj.order_status || (b && b.status));
        if (w === "done") markDone(o, line, { ref: o.line.ref, message: "" });
        else if (w === "failed") {
          o.line.state = "failed"; o.line.message = str(ordObj.message || (b && b.message) || "sayt bekor qildi", 200); ctx.save();
          alertAdmins("⚠️ #" + o.seq + " " + o.item + " — " + line.name + " bekor qildi: " + o.line.message + "\nQo'lda bajaring yoki bekor qiling.", o);
        }
      });
      return true;
    }

    /* ----- admin ----- */
    if (url.indexOf("/api/admin/games") !== 0) return false;
    if (!adminOnly(req, res)) return true;
    const s = store();

    if (url === "/api/admin/games" && m === "GET") {
      sendJSON(res, 200, {
        games: s.games, packages: s.packages, lines: s.lines.map(maskLine),
        lineTypes: Object.keys(LINE_TYPES).map(k => ({ key: k, label: LINE_TYPES[k].label, fields: LINE_TYPES[k].fields || [],
          canCheck: typeof LINE_TYPES[k].check === "function", canTest: typeof LINE_TYPES[k].test === "function",
          canImport: typeof LINE_TYPES[k].packages === "function" }))
      });
      return true;
    }

    if (url === "/api/admin/games/image" && m === "POST") {
      ctx.readBody(req, res, b => {
        const mm = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ""));
        if (!mm) return sendJSON(res, 400, { error: "Rasm PNG, JPG yoki WEBP bo'lishi kerak" });
        const buf = Buffer.from(mm[2], "base64");
        if (!buf.length || buf.length > MAX_IMG) return sendJSON(res, 400, { error: "Rasm 1.5 MB dan katta" });
        const file = crypto.createHash("sha1").update(buf).digest("hex") + "." + (mm[1] === "jpeg" ? "jpg" : mm[1]);
        fs.writeFile(path.join(IMG_DIR, file), buf, err => err
          ? sendJSON(res, 500, { error: "saqlanmadi" })
          : sendJSON(res, 200, { ok: true, url: "/gimg/" + file }));
      });
      return true;
    }

    if (url === "/api/admin/games/game" && m === "POST") {
      ctx.readBody(req, res, b => {
        const x = b.game || {};
        const id = slug(x.id, 40);
        if (!id) return sendJSON(res, 400, { error: "ID faqat kichik lotin harf, raqam, - va _ (masalan: mlbb)" });
        const name = str(x.name, 60);
        if (!name) return sendJSON(res, 400, { error: "Nomi kerak" });
        const fields = [];
        for (const f of (Array.isArray(x.fields) ? x.fields : []).slice(0, 3)) {
          const key = /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(String(f.key || "")) ? String(f.key) : "";
          const re = safeRe(f.re);
          if (!key || re === null) return sendJSON(res, 400, { error: "Maydon sozlamasi noto'g'ri: " + str(f.label || f.key, 30) });
          fields.push(Object.assign({ key, label: str(f.label, 30) || key, ph: str(f.ph, 30), re }, f.type === "email" ? { type: "email" } : {}));
        }
        const list = (arr, n) => (Array.isArray(arr) ? arr : []).slice(0, n)
          .map(r => ({ key: slug(r.key, 16), label: str(r.label, 24) })).filter(r => r.key && r.label);
        const g = { id, name, section: x.section === "ai" ? "ai" : "games", img: imgUrl(x.img), banner: imgUrl(x.banner),
          color: /^#[0-9a-f]{6}$/i.test(String(x.color || "")) ? x.color : "",
          fields, regions: list(x.regions, 15), tabs: list(x.tabs, 8),
          active: x.active !== false, sort: Number(x.sort) || 0 };
        const i = s.games.findIndex(z => z.id === id);
        if (i >= 0) s.games[i] = g; else s.games.push(g);
        ctx.save();
        sendJSON(res, 200, { ok: true, game: g });
      });
      return true;
    }
    if (url === "/api/admin/games/game-delete" && m === "POST") {
      ctx.readBody(req, res, b => {
        const id = str(b.id, 40);
        s.games = s.games.filter(g => g.id !== id);
        s.packages = s.packages.filter(p => p.gameId !== id);
        ctx.save();
        sendJSON(res, 200, { ok: true });
      });
      return true;
    }

    if (url === "/api/admin/games/package" && m === "POST") {
      ctx.readBody(req, res, b => {
        const x = b.pkg || {};
        const g = gameById(str(x.gameId, 40));
        if (!g) return sendJSON(res, 400, { error: "O'yin topilmadi" });
        const name = str(x.name, 40);
        if (!name) return sendJSON(res, 400, { error: "Paket nomi kerak (masalan: 86)" });
        let id = slug(x.id, 80);
        if (!id) id = g.id + "-" + crypto.randomBytes(4).toString("hex");
        const price = Math.round(Number(x.price) || 0);
        if (price < 0 || price > 100000000) return sendJSON(res, 400, { error: "Narx noto'g'ri" });
        const prevPkg = pkgById(slug(x.id, 80));
        const routes = [];
        for (const r of (Array.isArray(x.routes) ? x.routes : []).slice(0, 6)) {
          if (!lineById(String(r.lineId || ""))) continue;
          const sku = str(r.sku, 120);
          // meta (sayt maydon nomlari, o'yin/mahsulot kodi) importdan keladi — admin formasi
          // uni yubormasa, avvalgisi saqlanadi.
          const old = prevPkg && (prevPkg.routes || []).find(z => z.lineId === r.lineId && z.sku === sku);
          routes.push({ lineId: String(r.lineId), sku, cost: Math.max(0, Number(r.cost) || 0), meta: cleanMeta(r.meta || (old && old.meta)) });
        }
        const p = { id, gameId: g.id, region: slug(x.region, 16), tab: slug(x.tab, 16), name, sub: str(x.sub, 30),
          icon: ICONS.indexOf(x.icon) !== -1 ? x.icon : "diamond", img: imgUrl(x.img), badge: str(x.badge, 10),
          price, active: !!x.active && price > 0, sort: Number(x.sort) || 0,
          routes: routes.length ? routes : [{ lineId: "manual", sku: "", cost: 0 }].filter(r => lineById(r.lineId)) };
        const i = s.packages.findIndex(z => z.id === id);
        if (i >= 0) s.packages[i] = p; else s.packages.push(p);
        ctx.save();
        sendJSON(res, 200, { ok: true, pkg: p });
      });
      return true;
    }
    if (url === "/api/admin/games/package-delete" && m === "POST") {
      ctx.readBody(req, res, b => {
        const id = str(b.id, 80);
        s.packages = s.packages.filter(p => p.id !== id);
        ctx.save();
        sendJSON(res, 200, { ok: true });
      });
      return true;
    }
    // Narxlarni tez tahrirlash: bir o'yinning hamma paketlari bitta ro'yxatda.
    if (url === "/api/admin/games/prices" && m === "POST") {
      ctx.readBody(req, res, b => {
        let n = 0;
        for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 500)) {
          const p = pkgById(String(it.id || ""));
          if (!p) continue;
          const price = Math.round(Number(it.price) || 0);
          if (price < 0 || price > 100000000) continue;
          p.price = price;
          p.active = !!it.active && price > 0;
          n++;
        }
        ctx.save();
        sendJSON(res, 200, { ok: true, updated: n });
      });
      return true;
    }

    if (url === "/api/admin/games/line" && m === "POST") {
      ctx.readBody(req, res, b => {
        const x = b.line || {};
        const T = LINE_TYPES[x.type];
        if (!T) return sendJSON(res, 400, { error: "Liniya turi noma'lum" });
        const name = str(x.name, 40);
        if (!name) return sendJSON(res, 400, { error: "Liniya nomi kerak" });
        let id = slug(x.id, 40);
        const prev = id ? lineById(id) : null;
        if (!id) id = "line-" + crypto.randomBytes(4).toString("hex");
        const config = {};
        for (const f of T.fields || []) {
          const v = x.config ? x.config[f.key] : undefined;
          // Maxfiy maydon bo'sh yuborilsa — eskisi saqlanadi (admin panelga hech qachon qaytarilmaydi).
          if (f.secret && (v === undefined || v === "") && prev && prev.type === x.type) config[f.key] = (prev.config || {})[f.key] || "";
          else config[f.key] = str(v, 500);
          if (f.required && !config[f.key]) return sendJSON(res, 400, { error: (f.label || f.key) + " kerak" });
        }
        const l = { id, name, type: x.type, enabled: x.enabled !== false, priority: Math.round(Number(x.priority) || 0), config, note: str(x.note, 200) };
        const i = s.lines.findIndex(z => z.id === id);
        if (i >= 0) s.lines[i] = l; else s.lines.push(l);
        ctx.save();
        sendJSON(res, 200, { ok: true, line: maskLine(l) });
      });
      return true;
    }
    if (url === "/api/admin/games/line-delete" && m === "POST") {
      ctx.readBody(req, res, b => {
        const id = str(b.id, 40);
        s.lines = s.lines.filter(l => l.id !== id);
        for (const p of s.packages) p.routes = (p.routes || []).filter(r => r.lineId !== id);
        ctx.save();
        sendJSON(res, 200, { ok: true });
      });
      return true;
    }
    // Hech bir liniya bajarmagan buyurtmani qayta yuborish (masalan sayt balansi to'ldirilgach).
    if (url === "/api/admin/games/retry" && m === "POST") {
      ctx.readBody(req, res, b => {
        const o = DBx().orders.find(x => x.id === b.orderId);
        if (!o || !o.game) return sendJSON(res, 404, { error: "not found" });
        if (o.status !== "pending") return sendJSON(res, 409, { error: "state" });
        // Sayt allaqachon qabul qilgan buyurtmani qayta yuborish = ikki marta to'ldirish.
        const st = o.line && o.line.state;
        if (st === "accepted") return sendJSON(res, 409, { error: "Sayt bu buyurtmani allaqachon qabul qilgan — qayta yuborilmaydi" });
        // Noaniq holat: admin saytdan tekshirib, buyurtma YO'QLIGINI tasdiqlasagina.
        if (st === "unknown" && b.confirmNotCreated !== true)
          return sendJSON(res, 409, { error: "Avval saytdan tekshiring: buyurtma yaratilmaganini tasdiqlasangiz qayta yuboriladi", needConfirm: true });
        fulfill(o).then(() => sendJSON(res, 200, { ok: true, status: o.status, line: o.line, attempts: o.attempts }))
          .catch(e => sendJSON(res, 500, { error: e.message }));
      });
      return true;
    }

    // Liniyani sinash: kalit to'g'rimi, balans qancha.
    if (url === "/api/admin/games/line-test" && m === "POST") {
      ctx.readBody(req, res, async b => {
        const l = lineById(str(b.id, 40)), T = l && LINE_TYPES[l.type];
        if (!l || !T) return sendJSON(res, 404, { error: "Liniya topilmadi" });
        if (typeof T.test !== "function") return sendJSON(res, 200, { ok: true, message: "Bu liniya saytga ulanmaydi — sinash shart emas." });
        try { const r = await T.test(l); sendJSON(res, 200, { ok: !!(r && r.ok), message: str(r && r.message, 300) }); }
        catch (e) { sendJSON(res, 200, { ok: false, message: str(e.message, 300) }); }
      });
      return true;
    }
    // Saytdagi katalog: code bo'lmasa — o'yinlar ro'yxati, code bo'lsa — paketlar.
    if (url === "/api/admin/games/catalog" && m === "POST") {
      ctx.readBody(req, res, async b => {
        const l = lineById(str(b.lineId, 40)), T = l && LINE_TYPES[l.type];
        if (!l || !T || typeof T.packages !== "function") return sendJSON(res, 400, { error: "Bu liniyada katalog yo'q" });
        try {
          if (!b.code) return sendJSON(res, 200, { ok: true, games: (await T.games(l)).slice(0, 400) });
          const pk = await T.packages(l, str(b.code, 60));
          const rate = Number(l.config.rate) || 0, markup = Number(l.config.markup) || 0;
          pk.items = pk.items.slice(0, 300).map(x => Object.assign({ raw: x.name }, x, smartName(x.name, pk.name), { price: calcPrice(x.cost, rate, markup) }));
          sendJSON(res, 200, { ok: true, pkg: pk, rate, markup });
        } catch (e) { sendJSON(res, 400, { error: "Sayt: " + str(e.message, 200) }); }
      });
      return true;
    }
    /* Import: tanlangan paketlarni do'konga qo'shadi yoki yangilaydi.
       Tannarx brauzerdan emas — serverning o'zi saytdan qayta oladi. Rasmlar saytdan
       yuklab olinib o'zimizda saqlanadi. Har bir paketga "Qo'lda" zaxira liniyasi ham
       qo'shiladi: sayt rad etsa buyurtma yo'qolmaydi. */
    if (url === "/api/admin/games/import" && m === "POST") {
      ctx.readBody(req, res, async b => {
        const l = lineById(str(b.lineId, 40)), T = l && LINE_TYPES[l.type];
        if (!l || !T || typeof T.packages !== "function") return sendJSON(res, 400, { error: "Bu liniyada katalog yo'q" });
        const code = str(b.code, 60);
        let pk;
        try { pk = await T.packages(l, code); } catch (e) { return sendJSON(res, 400, { error: "Sayt: " + str(e.message, 200) }); }
        let g = gameById(str(b.gameId, 40));
        if (!g) {
          const ng = b.newGame || {};
          const id = slug(String(ng.id || "").toLowerCase(), 40);
          if (!id) return sendJSON(res, 400, { error: "Yangi o'yin uchun ID kiriting (masalan: genshin)" });
          if (gameById(id)) return sendJSON(res, 400, { error: "Bu ID band" });
          const isAi = ng.section === "ai";
          g = { id, name: str(ng.name || pk.name || id, 60), section: isAi ? "ai" : "games", img: "", banner: "", color: "#2f8fff",
            fields: isAi ? [{ key: "email", label: "Akkaunt email", ph: "siz@gmail.com", re: EMAIL_RE, type: "email" }]
              : [{ key: "userId", label: "Player ID", ph: "", re: "" }].concat(pk.fields && pk.fields[1] ? [{ key: "zoneId", label: str(pk.fields[1], 30) || "Server ID", ph: "", re: "" }] : []),
            regions: [{ key: "global", label: "🌐 Global" }], tabs: [{ key: "main", label: "Paketlar" }], active: true, sort: s.games.length + 1 };
          s.games.push(g);
        }
        // O'yin avatari va banneri — saytdagi rasm (o'yinda hali rasm bo'lmasa).
        if (pk.img && (!g.img || !g.banner)) {
          const u = await fetchImage(pk.img);
          if (u) { if (!g.img) g.img = u; if (!g.banner) g.banner = u; }
        }
        const region = slug(b.region, 16) || ((g.regions || [])[0] || {}).key || "";
        const tab = slug(b.tab, 16) || ((g.tabs || [])[0] || {}).key || "";
        const rate = Number(b.rate != null ? b.rate : l.config.rate) || 0;
        const markup = Number(b.markup != null ? b.markup : l.config.markup) || 0;
        const want = new Set((Array.isArray(b.skus) ? b.skus : []).map(x => String(x)));
        const items = pk.items.filter(x => !want.size || want.has(String(x.sku)));
        const meta = cleanMeta(Object.assign({ fields: pk.fields || [] }, pk.meta || {}));
        const manual = lineById("manual");
        let added = 0, updated = 0, imgs = 0, sort = s.packages.filter(p => p.gameId === g.id).length;
        for (const it of items) {
          const nm = smartName(it.name, pk.name || g.name);
          const price = calcPrice(it.cost, rate, markup);
          let p = s.packages.find(z => z.gameId === g.id && (z.routes || []).some(r => r.lineId === l.id && r.sku === String(it.sku)));
          if (p) {
            const r = p.routes.find(z => z.lineId === l.id && z.sku === String(it.sku));
            r.cost = it.cost; r.meta = meta;
            if (b.updatePrices && price > 0) p.price = price;
            updated++;
          } else {
            p = { id: g.id + "-" + crypto.randomBytes(4).toString("hex"), gameId: g.id, region, tab, name: nm.name, sub: nm.sub,
              icon: g.section === "ai" ? "ai" : nm.icon, img: "", badge: "", price, active: !!b.activate && price > 0, sort: ++sort,
              routes: [{ lineId: l.id, sku: String(it.sku), cost: it.cost, meta }].concat(manual ? [{ lineId: "manual", sku: "", cost: 0 }] : []) };
            s.packages.push(p);
            added++;
          }
          if (b.images !== false && it.img && !p.img) { const u = await fetchImage(it.img); if (u) { p.img = u; imgs++; } }
        }
        ctx.save();
        sendJSON(res, 200, { ok: true, gameId: g.id, added, updated, images: imgs, gameImage: !!g.img });
      });
      return true;
    }

    sendJSON(res, 404, { error: "unknown games route" });
    return true;
  }

  // Yoqilgan sayt liniyalarining balansi (moliya hisoboti uchun). Saytlarga tez-tez
  // so'rov ketmasin — natija 5 daqiqa saqlanadi.
  let balCache = { ts: 0, list: [] };
  async function lineBalances(force) {
    if (!force && Date.now() - balCache.ts < 5 * 60 * 1000) return balCache.list;
    const lines = store().lines.filter(l => l.enabled && LINE_TYPES[l.type] && typeof LINE_TYPES[l.type].test === "function");
    const list = await Promise.all(lines.map(async l => {
      try {
        const r = await Promise.race([LINE_TYPES[l.type].test(l), new Promise((_, rej) => setTimeout(() => rej(new Error("javob kelmadi")), 15000))]);
        return { id: l.id, name: l.name, ok: !!(r && r.ok), message: str(r && r.message, 160) };
      } catch (e) { return { id: l.id, name: l.name, ok: false, message: str(e.message, 160) }; }
    }));
    balCache = { ts: Date.now(), list };
    return list;
  }
  return { handle, registerLineType, store, fulfill, pollAccepted, smartName, calcPrice, lineBalances };
};
