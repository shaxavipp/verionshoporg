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
    // Bo'sh joylar (4- va 5-liniya) — "Universal API" turiga: istalgan sayt API'sini kiritish mumkin.
    if ((s.linesV || 1) < 3) {
      for (const l of s.lines) if ((l.id === "slot4" || l.id === "slot5") && l.type === "manual" && LINE_TYPES.custom) {
        l.type = "custom"; l.enabled = false; l.config = { method: "POST", okPath: "status", okValues: "success,true,1,200,completed,ok", rate: "", markup: "" };
        l.name = l.name.replace("bo'sh joy", "Universal API"); l.note = "Istalgan sayt: hujjatidagi URL va maydonlarni kiriting";
      }
      s.linesV = 3; ctx.save();
    }
    // Bir xil o'yinlarni (regionlari bilan) bitta qilish va mashhurlik tartibi — bir marta, deploy'dan keyin.
    if ((s.mergeV || 0) < 1) { s.mergeV = 1; setImmediate(() => { try { mergeDuplicates(); } catch (e) { console.log("[games] merge: " + e.message); } }); }
    // Ludovex liniyasi (o'chiq — admin kalit kiritib yoqadi).
    if ((s.linesV || 1) < 4) {
      if (LINE_TYPES.ludovex && !s.lines.some(l => l.type === "ludovex"))
        s.lines.push({ id: "ludovex", name: "Ludovex", type: "ludovex", enabled: false, priority: 35, config: { apiKey: "", rate: "12500", markup: "20" }, note: "api.ludovex.org — narxlar USDT" });
      s.linesV = 4; ctx.save();
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
    // 4-versiya: AI xizmatlar bo'limi olib tashlandi (egasi kerak emas dedi). Tayyor AI
    // yozuvlari o'chiriladi, ai bo'limiga tushib qolgan boshqa o'yinlar "games"ga o'tadi.
    if ((s.aiV || 0) < 2) {
      const ids = aiSeed().games.map(g => g.id);
      s.games = s.games.filter(g => !(g.section === "ai" && ids.includes(g.id)));
      s.packages = s.packages.filter(p => s.games.some(g => g.id === p.gameId));
      for (const g of s.games) if (g.section === "ai") g.section = "games";
      s.aiV = 2;
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
  // Rasm havolasi tashqi saytdan keladi — server o'zining ichki tarmog'iga (localhost, Railway ichki
  // xizmatlari, bulut metadata manzili) so'rov yubormasin.
  function internalHost(h) {
    h = String(h || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!h || h === "localhost" || /\.(local|internal|localhost)$/.test(h)) return true;
    const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (v4) { const a = +v4[1], b = +v4[2]; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
    return h.indexOf(":") !== -1 && (h === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.indexOf("::ffff:") === 0);
  }
  function fetchImage(url, depth) {
    return new Promise(resolve => {
      let u; try { u = new URL(url); } catch (e) { return resolve(""); }
      if (u.protocol !== "https:" && u.protocol !== "http:") return resolve("");
      if (internalHost(u.hostname)) return resolve("");
      const mod = u.protocol === "https:" ? require("https") : require("http");
      let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
      const req = mod.get(u, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (compatible; VerionShop/1.0)", "Accept": "image/webp,image/png,image/jpeg,*/*" } }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (depth || 0) < 3) {
          r.resume(); return fetchImage(new URL(r.headers.location, u).toString(), (depth || 0) + 1).then(fin);
        }
        const ct = String(r.headers["content-type"] || "").toLowerCase();
        const ue = (u.pathname.match(/\.(png|jpe?g|webp)$/i) || [])[1] || "";
        const ext = /png/.test(ct) ? "png" : /jpe?g/.test(ct) ? "jpg" : /webp/.test(ct) ? "webp"
          : (/octet-stream|binary/.test(ct) || !ct) && ue ? ue.toLowerCase().replace("jpeg", "jpg") : "";
        if (r.statusCode !== 200 || !ext) { r.resume(); return fin(""); }
        const chunks = []; let size = 0;
        r.on("data", c => { size += c.length; if (size > MAX_IMG) { req.destroy(); fin(""); } else chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
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
  /* ---------- bir xil o'yinlarni birlashtirish ----------
     "Mobile Legends (BR)", "Mobile Legends - Philippines", "MLBB Indonesia" → bitta "Mobile Legends",
     regionlari tepada tab bo'lib turadi. Turli liniyalardagi bir xil paket (masalan 86 olmos) —
     bitta paket, ichida bir nechta liniya (biri ishlamasa keyingisi). */
  const REGIONS = [
    ["global", "🌐 Global", /\b(global|worldwide|international|intl|ww|all ?region|garena)\b/i],
    ["cis", "🌍 CIS", /\b(cis|sng|снг)\b/i], ["uz", "🇺🇿 UZ", /\b(uz|uzbekistan|o'?zbekiston)\b/i],
    ["ru", "🇷🇺 RU", /\b(ru|russia|россия|rus)\b/i], ["kz", "🇰🇿 KZ", /\b(kz|kazakhstan)\b/i],
    ["tr", "🇹🇷 TR", /\b(tr|turkey|t[uü]rkiye)\b/i], ["id", "🇮🇩 ID", /\b(id|indonesia|indo)\b/i],
    ["ph", "🇵🇭 PH", /\b(ph|philippines?|pinoy)\b/i], ["my", "🇲🇾 MY", /\b(my|malaysia)\b/i],
    ["sg", "🇸🇬 SG", /\b(sg|singapore)\b/i], ["br", "🇧🇷 BR", /\b(br|brazil|brasil)\b/i],
    ["us", "🇺🇸 US", /\b(us|usa|united states|america|na)\b/i], ["eu", "🇪🇺 EU", /\b(eu|europe)\b/i],
    ["th", "🇹🇭 TH", /\b(th|thailand)\b/i], ["vn", "🇻🇳 VN", /\b(vn|vietnam)\b/i],
    ["in", "🇮🇳 IN", /\b(in|india)\b/i], ["pk", "🇵🇰 PK", /\b(pk|pakistan)\b/i], ["bd", "🇧🇩 BD", /\b(bd|bangladesh)\b/i],
    ["me", "🌙 MENA", /\b(mena|middle ?east|arab)\b/i], ["asia", "🌏 Asia", /\b(asia|sea)\b/i],
    ["mm", "🇲🇲 MM", /\b(mm|myanmar)\b/i], ["kh", "🇰🇭 KH", /\b(kh|cambodia)\b/i], ["la", "🌎 LATAM", /\b(latam|latin)\b/i]
  ];
  const ALIASES = [[/^(mlbb|mobile ?legends?( ?bang ?bang)?)$/, "Mobile Legends"], [/^(pubg ?m|pubg ?mobile)$/, "PUBG Mobile"],
    [/^(ff|free ?fire)$/, "Free Fire"], [/^free ?fire ?max$/, "Free Fire MAX"], [/^(codm|call of duty ?mobile|cod ?mobile)$/, "Call of Duty Mobile"],
    [/^(hok|honor of kings)$/, "Honor of Kings"], [/^genshin( impact)?$/, "Genshin Impact"], [/^(hsr|honkai ?star ?rail)$/, "Honkai: Star Rail"],
    [/^(so2|standoff ?2)$/, "Standoff 2"], [/^(abi|arena breakout( infinite)?)$/, "Arena Breakout"], [/^(wild ?rift|lol wild rift|league of legends wild rift)$/, "Wild Rift"],
    [/^(zzz|zenless zone zero)$/, "Zenless Zone Zero"], [/^(wuwa|wuthering waves)$/, "Wuthering Waves"]];
  function splitRegion(raw) {
    let t = String(raw || "").replace(/\s+/g, " ").trim(), region = "";
    const tryReg = frag => { for (const r of REGIONS) if (r[2].test(frag)) return r[0]; return ""; };
    // (BR) / [PH] / - Indonesia / | Global
    t = t.replace(/[\(\[]([^\)\]]{1,30})[\)\]]/g, (m, x) => { const k = tryReg(x); if (k && !region) region = k; return /^(auto|direct|top ?up|instant|fast|official)$/i.test(x.trim()) || k ? " " : m; });
    t = t.replace(/\s[-–|:]\s*([A-Za-z' ]{2,20})$/, (m, x) => { const k = tryReg(x); if (k && !region) { region = k; return ""; } return m; });
    const w = t.match(/\s(global|indonesia|philippines|malaysia|singapore|brazil|russia|turkey|cis|india|vietnam|thailand|myanmar|usa|europe|asia|mena|latam)$/i) || t.match(/\s([A-Z]{2})$/);
    if (w && !region) { const k = tryReg(w[1]); if (k) { region = k; t = t.slice(0, -w[0].length); } }
    t = t.replace(/\b(top ?up|topup|direct|auto|instant|in[- ]?game|recharge)\b/ig, " ").replace(/\s+/g, " ").replace(/[\s\-–|:]+$/, "").trim();
    const low = t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    for (const a of ALIASES) if (a[0].test(low)) { t = a[1]; break; }
    return { base: t || String(raw || "").trim(), region: region || "global" };
  }
  const gameKey = n => splitRegion(n).base.toLowerCase().replace(/[^a-z0-9]/g, "");
  const regionLabel = k => (REGIONS.find(r => r[0] === k) || [k, k.toUpperCase()])[1];
  function addRegion(g, k) {
    if (!Array.isArray(g.regions)) g.regions = [];
    if (!g.regions.some(r => r.key === k)) {
      g.regions.push({ key: k, label: regionLabel(k) });
      const ord = REGIONS.map(r => r[0]);
      g.regions.sort((a, b) => (ord.indexOf(a.key) + 1 || 99) - (ord.indexOf(b.key) + 1 || 99));
    }
  }
  const pkgKey = p => String((p.name || "") + "|" + (p.sub || "")).toLowerCase().replace(/[^a-z0-9+|]/g, "");
  const sourcesOf = g => Array.isArray(g.sources) ? g.sources : (g.source ? [g.source] : []);
  function addSource(g, lineId, code) {
    const list = sourcesOf(g).slice();
    if (!list.some(x => x.lineId === lineId && String(x.code) === String(code))) list.push({ lineId, code: String(code) });
    g.sources = list; g.source = list[0];
  }
  /* O'zbekistonda eng ko'p o'ynaladigan / sotib olinadigan o'yinlar — shu tartibda tepada. */
  const POPULAR = [/^pubg mobile/i, /^free fire$/i, /^mobile legends/i, /^standoff/i, /^steam/i, /^telegram/i, /^clash royale/i, /^clash of clans/i,
    /^brawl stars/i, /^call of duty/i, /^roblox/i, /^free fire max/i, /^genshin/i, /^arena breakout/i, /^blood strike/i, /^valorant/i,
    /^honor of kings/i, /^honkai/i, /^delta force/i, /^fortnite/i, /^minecraft/i, /^wild rift|league of legends/i, /^tanks blitz|world of tanks/i,
    /^warface/i, /^pubg new state|^new state/i, /^ea (sports )?fc|^fifa/i, /^efootball/i, /^zenless/i, /^wuthering/i, /^marvel rivals/i,
    /^apex/i, /^hay day/i, /^squad busters/i, /^pok[eé]mon/i, /^dota/i, /^cs ?2|counter[- ]?strike/i, /^bigo/i, /^likee/i, /^tiktok/i,
    /^google play/i, /^app ?store|^itunes/i, /^playstation|^psn/i, /^xbox/i, /^discord/i, /^spotify/i, /^netflix/i];
  function popRank(name) { const i = POPULAR.findIndex(r => r.test(String(name || "").trim())); return i === -1 ? 1000 : (i + 1) * 10; }
  // Mavjud dublikatlarni birlashtiradi (admin tugmasi va har import oxirida).
  function mergeDuplicates() {
    const s = store(), groups = new Map();
    for (const g of s.games) { const k = gameKey(g.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(g); }
    const pendingPk = new Set((DBx().orders || []).filter(o => o.status === "pending" && o.game).map(o => o.game.packageId));
    let mergedGames = 0, mergedPkgs = 0;
    for (const list of groups.values()) {
      // Asosiysi: mijozlarga ochiq, rasmi bor, paketi ko'p bo'lgani.
      const score = g => (g.draft ? 0 : 1000) + (g.img ? 100 : 0) + s.packages.filter(p => p.gameId === g.id).length;
      list.sort((a, b) => score(b) - score(a));
      const main = list[0];
      main.name = splitRegion(main.name).base;
      if (list.length === 1) continue;
      for (const g of list.slice(1)) {
        const reg = splitRegion(g.name).region;
        for (const src of sourcesOf(g)) addSource(main, src.lineId, src.code);
        if (!main.img && g.img) main.img = g.img;
        if (!main.banner && g.banner) main.banner = g.banner;
        for (const p of s.packages.filter(x => x.gameId === g.id)) {
          const region = (g.regions || []).length > 1 ? (p.region || reg) : reg;
          addRegion(main, region);
          const tab = ((main.tabs || [])[0] || {}).key || p.tab;
          const twin = s.packages.find(x => x.gameId === main.id && x.region === region && pkgKey(x) === pkgKey(p));
          if (twin && !pendingPk.has(p.id)) {
            for (const r of p.routes || []) if (!twin.routes.some(z => z.lineId === r.lineId && z.sku === r.sku)) twin.routes.push(r);
            if (!twin.img && p.img) twin.img = p.img;
            if (!(twin.price > 0) && p.price > 0) twin.price = p.price;
            s.packages.splice(s.packages.indexOf(p), 1); mergedPkgs++;
          } else { p.gameId = main.id; p.region = region; if (!(main.tabs || []).some(t => t.key === p.tab)) p.tab = tab; }
        }
        s.games.splice(s.games.indexOf(g), 1); mergedGames++;
      }
      // "Qo'lda" zaxira har doim oxirida turadi.
      for (const p of s.packages.filter(x => x.gameId === main.id)) p.routes.sort((a, b) => (a.lineId === "manual") - (b.lineId === "manual"));
    }
    for (const g of s.games) if (!g.sortManual) g.sort = popRank(g.name);
    ctx.save();
    return { mergedGames, mergedPkgs };
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
  const PRESET = [
    [/pubg/i, { "60": 11300, "325": 57000, "660": 113500, "1800": 283000, "3850": 565500, "8100": 1135500 }],
    [/free\s*fire/i, { "110": 10300, "341": 30800, "572": 49000, "1166": 99000, "2398": 199000, "6160": 500000 }],
    [/mobile\s*legends|mlbb/i, { "86": 15500, "172": 29800, "257": 44000, "706": 122000, "2195": 364000, "3688": 605000,
      "5532": 915000, "9288": 1520000, "50+5": 9700, "150+15": 29000, "250+25": 46000, "500+65": 96000, weekly: 19000, twilight: 110000 }],
    [/arena\s*breakout/i, { "100": 13500, "500": 64600, "1000": 125700, "2500": 311700, "5000": 621500, "10000": 1241400 }]
  ];
  // Tayyor narxlar faqat o'yinning asosiy (birinchi) regioniga — boshqa regionlar tannarx × kurs + ustama.
  const mainRegion = (g, p) => !p.region || p.region === ((g.regions || [])[0] || {}).key;
  function presetPrice(gameName, pkgName) {
    const row = PRESET.find(x => x[0].test(gameName));
    if (!row) return 0;
    const t = String(pkgName || "").toLowerCase();
    const key = /haftalik|weekly/.test(t) ? "weekly" : /twilight/.test(t) ? "twilight" : (t.match(/\d[\d\s,]*(?:\+\s*\d+)?/) || [""])[0].replace(/[\s,]/g, "");
    return row[1][key] || 0;
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
  let pubAt = 0;
  // Har saqlashda (narx, paket, o'yin o'zgarganda) katalog keshi darhol yangilanadi.
  { const orig = ctx.save; ctx.save = function () { pubAt = 0; return orig.apply(this, arguments); }; }
  function publicCatalog() {
    // Ko'p ochiq ilova bir vaqtda so'raydi — katalog eng ko'pi 2 soniyada bir qayta yig'iladi.
    if (pubCache.body && Date.now() - pubAt < 2000) return pubCache;
    pubAt = Date.now();
    const s = store();
    const pk = s.packages.filter(p => p.active && p.price > 0 && s.games.some(g => g.id === p.gameId && g.active && !g.draft));
    const gids = new Set(pk.map(p => p.gameId));
    const games = s.games.filter(g => g.active && !g.draft && gids.has(g.id)).sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(g => ({ id: g.id, name: g.name, section: g.section === "ai" ? "ai" : "games", img: g.img || "", banner: g.banner || "", color: g.color || "",
        fields: (g.fields || []).map(f => ({ key: f.key, label: f.label, ph: f.ph || "", re: f.re || "", type: f.type === "email" ? "email" : "" })),
        regions: g.regions || [], tabs: g.tabs || [],
        canCheck: !!checkLineFor(g), status: g.status === "maint" || g.status === "na" ? g.status : "" }));
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
  const pkg0 = o => { const p = pkgById(o.game && o.game.packageId); return p ? p.gameId : ""; };
  function markDone(o, line, res) {
    if (o.status !== "pending") return;
    o.status = "done"; o.doneTs = Date.now();
    { const gm = gameById(pkg0(o)); if (gm && gm.statusAuto) { gm.status = ""; gm.statusAuto = false; } }
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
  // Bitta buyurtma bir vaqtda faqat BIR marta saytga yuboriladi: admin "qayta yuborish",
  // fon tekshiruvi va sayt callback'i bir-biriga to'g'ri kelib qolsa ham — aks holda
  // ikki liniyadan ikki marta to'ldirilib, pul ikki marta to'lanardi.
  const INFLIGHT = new Set();
  async function fulfill(o, exclude) {
    if (!o || INFLIGHT.has(o.id)) return;
    INFLIGHT.add(o.id);
    try { return await fulfillOnce(o, exclude); } finally { INFLIGHT.delete(o.id); }
  }
  // exclude — oldin sinab ko'rilgan (va "bajarilmadi" degan) liniyalar.
  async function fulfillOnce(o, exclude) {
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
      if (o.status !== "pending") {                               // shu orada admin bekor qilgan
        if (res.state === "done" || res.state === "accepted")
          alertAdmins("⚠️ #" + o.seq + " " + o.item + " bekor qilingan (pul qaytarilgan) edi, lekin " + line.name + " uni " + (res.state === "done" ? "bajardi" : "qabul qildi") + ". Saytda tekshiring.");
        ctx.save(); return;
      }
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
    // Hech bir liniya ishlamadi — o'yin "Texnik nosozlik" bo'ladi (mijozlar boshqa buyurtma bermaydi).
    const gm = gameById(pkg.gameId);
    if (list.length && gm && !gm.status) {
      gm.status = "maint"; gm.statusAuto = true;
      alertAdmins("🛠 " + gm.name + " — barcha liniyalar ishlamadi, do'konda «Texnik nosozlik» deb qo'yildi. Liniya tuzalgach, birinchi muvaffaqiyatli buyurtmada yoki 🔧 orqali o'zingiz ochasiz.");
    }
    ctx.save();
    if (list.length) alertAdmins("⚠️ #" + o.seq + " " + o.item + " — hech bir liniya bajarmadi, qo'lda bajaring.\n" + failedHere.join("\n"), o);
  }
  // "accepted" holatidagi buyurtmalarni sayt API'sidan so'rab turadi (status() bor turlar uchun).
  // Oldingi aylanish tugamaguncha yangisi boshlanmaydi (sayt sekin javob bersa ham), va har
  // javobdan keyin holat qayta tekshiriladi — shu orada admin bekor qilgan yoki callback
  // kelgan bo'lishi mumkin. Aks holda bitta "bajarilmadi" ikki marta keyingi liniyaga ketardi.
  let polling = false;
  async function pollAccepted() {
    if (polling) return;
    polling = true;
    try { await pollOnce(); } finally { polling = false; }
  }
  async function pollOnce() {
    const list = DBx().orders.filter(o => o.status === "pending" && o.line && o.line.state === "accepted");
    for (const o of list) {
      if (o.status !== "pending" || !o.line || o.line.state !== "accepted" || INFLIGHT.has(o.id)) continue;
      const lineId = o.line.id, line = lineById(lineId), T = line && LINE_TYPES[line.type];
      if (!T || typeof T.status !== "function") continue;
      let res; try { res = await T.status(line, o.line.ref, o); } catch (e) { continue; }
      if (!res) continue;
      if (o.status !== "pending" || !o.line || o.line.state !== "accepted" || o.line.id !== lineId || INFLIGHT.has(o.id)) continue;
      if (res.state === "done") markDone(o, line, res);
      else if (res.state === "failed") { o.line.state = "failed"; o.line.message = str(res.message, 300); ctx.save(); fulfillNext(o, line.id); }
      else if (res.state === "unknown") {
        o.line.state = "unknown"; o.line.message = str(res.message, 300); ctx.save();
        alertAdmins("❓ #" + o.seq + " " + o.item + " — " + line.name + ": " + str(res.message, 200) + "\nSaytdan tekshirib, \"Bajarildi\" yoki \"Bekor qilish\" bosing.", o);
      }
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
  { const t = setInterval(() => { const now = Date.now(); for (const [k, w] of checkHits) if (!w.length || now - w[w.length - 1] > 60000) checkHits.delete(k); }, 10 * 60 * 1000); if (t.unref) t.unref(); }
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
      const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
      if (gz && !c.gz) c.gz = require("zlib").gzipSync(c.body);
      res.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: c.etag, Vary: "Accept-Encoding" }, gz ? { "Content-Encoding": "gzip" } : {}));
      res.end(gz ? c.gz : c.body);
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
        const r = ctx.validatePromo(b.code, u.id, Math.round(p.price), { game: p.gameId, pkg: p.id });
        if (!r.ok) return sendJSON(res, 409, { error: "promo_invalid", reason: r.reason, minOrder: r.minOrder });
        sendJSON(res, 200, { ok: true, code: r.promo.code, discount: r.discount, total: Math.round(p.price) - r.discount });
      });
      return true;
    }

    if (url === "/api/games/buy" && m === "POST") {
      const u = ctx.auth(req);
      if (!u) { sendJSON(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" }); return true; }
      ctx.readBody(req, res, b => {
        const r = buyPackage(u, b.packageId, b.account, b.promoCode);
        if (!r.ok) return sendJSON(res, r.code, r.body);
        sendJSON(res, 200, { ok: true, order: ctx.pubOrder(r.order), balance: r.balance });
      });
      return true;
    }

    /* Sayt buyurtma holatini o'zi xabar qiladigan manzil (G2Bulk callback_url).
       Manzilda har liniyaning maxfiy tokeni bor — begona odam soxta "bajarildi" yubora olmaydi. */
    const cbm = /^\/api\/lines\/cb\/([a-z0-9_-]{1,40})\/([a-f0-9]{24})$/.exec(url);
    if (cbm && m === "POST") {
      const line = lineById(cbm[1]);
      if (!line || !line.cbToken || line.cbToken.length !== cbm[2].length || !crypto.timingSafeEqual(Buffer.from(line.cbToken), Buffer.from(cbm[2]))) { sendJSON(res, 403, { error: "bad token" }); return true; }
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
        const g = { id, name, section: "games", img: imgUrl(x.img), banner: imgUrl(x.banner),
          color: /^#[0-9a-f]{6}$/i.test(String(x.color || "")) ? x.color : "",
          fields, regions: list(x.regions, 15), tabs: list(x.tabs, 8),
          active: x.active !== false, sort: Number(x.sort) || 0, draft: !!x.draft, status: x.status === "maint" || x.status === "na" ? x.status : "", statusAuto: false };
        const i = s.games.findIndex(z => z.id === id);
        if (i >= 0 && s.games[i].source) g.source = s.games[i].source;
        if (i >= 0 && s.games[i].sources) g.sources = s.games[i].sources;
        if (i >= 0 && Number(x.sort) !== Number(s.games[i].sort)) g.sortManual = true; else if (i >= 0 && s.games[i].sortManual) g.sortManual = true;
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

    // Hamma narxlarni qayta hisoblash: tayyor narx jadvali (mashhur o'yinlar) + qolganlari tannarx × kurs + ustama.
    // Havoladan rasm: bitta rasm o'yinning hamma paketlariga (yoki bitta tabga), avatarka yoki bannerga.
    if (url === "/api/admin/games/bulk-image" && m === "POST") {
      ctx.readBody(req, res, async b => {
        const g = gameById(str(b.gameId, 40));
        if (!g) return sendJSON(res, 404, { error: "O'yin topilmadi" });
        const u = await fetchImage(str(b.url, 1000));
        if (!u) return sendJSON(res, 400, { error: "Rasm yuklanmadi: havola to'g'ridan-to'g'ri PNG/JPG/WEBP rasmga bo'lishi kerak" });
        let n = 0;
        if (b.target === "avatar") { g.img = u; n = 1; }
        else if (b.target === "banner") { g.banner = u; n = 1; }
        else {
          const tab = str(b.tab, 16), ids = Array.isArray(b.pkgIds) ? b.pkgIds.map(String) : null;
          for (const p of store().packages) {
            if (p.gameId !== g.id || (tab && p.tab !== tab) || (ids && !ids.includes(p.id)) || (b.onlyEmpty && p.img)) continue;
            p.img = u; n++;
          }
        }
        ctx.save();
        sendJSON(res, 200, { ok: true, img: u, updated: n });
      });
      return true;
    }
    if (url === "/api/admin/games/merge" && m === "POST") { sendJSON(res, 200, Object.assign({ ok: true }, mergeDuplicates())); return true; }
    if (url === "/api/admin/games/autoprice" && m === "GET") { sendJSON(res, 200, { ok: true, cfg: apCfg() }); return true; }
    if (url === "/api/admin/games/autoprice" && m === "POST") {
      ctx.readBody(req, res, b => {
        const c = apCfg(), rate = Number(b.rate), markup = Number(b.markup), hours = Number(b.hours);
        if (b.rate != null) { if (!(rate > 0 && rate < 1000000)) return sendJSON(res, 400, { error: "Kurs noto'g'ri" }); c.rate = rate; }
        if (b.markup != null) { if (!(markup >= 0 && markup <= 500)) return sendJSON(res, 400, { error: "Ustama noto'g'ri" }); c.markup = markup; }
        if (b.hours != null) c.hours = Math.max(1, Math.min(48, hours || 6));
        if (b.enabled != null) c.enabled = !!b.enabled;
        ctx.save();
        if (b.runNow) runAutoPrice(true).catch(() => {});
        sendJSON(res, 200, { ok: true, cfg: c });
      });
      return true;
    }
    if (url === "/api/admin/games/reprice" && m === "POST") {
      ctx.readBody(req, res, b => {
        const rate = Number(b.rate) || 0, markup = Number(b.markup) || 0;
        if (rate <= 0 || rate > 1000000 || markup < 0 || markup > 500) return sendJSON(res, 400, { error: "Kurs yoki ustama noto'g'ri" });
        for (const l of store().lines) if (l.config && "rate" in l.config) { l.config.rate = String(rate); l.config.markup = String(markup); }
        { const c = apCfg(); c.rate = rate; c.markup = markup; }
        let preset = 0, calc = 0, skipped = 0;
        for (const p of store().packages) {
          const g = gameById(p.gameId);
          const fixed = b.preset !== false && g && mainRegion(g, p) ? presetPrice(g.name, p.name) : 0;
          if (fixed) { p.price = fixed; preset++; continue; }
          const r = (p.routes || []).find(x => Number(x.cost) > 0);
          if (!r) { skipped++; continue; }
          p.price = calcPrice(r.cost, rate, markup); calc++;
        }
        ctx.save();
        sendJSON(res, 200, { ok: true, preset, calc, skipped });
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
        // Callback manzilidagi maxfiy kalit saqlanadi — aks holda saytda kutilayotgan buyurtmalar callback'i rad etilardi.
        if (prev && prev.cbToken && prev.type === x.type) l.cbToken = prev.cbToken;
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
        if (INFLIGHT.has(o.id)) return sendJSON(res, 409, { error: "Buyurtma hozir saytga yuborilmoqda — natijasini kuting" });
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
        const r = await importGame(l, T, str(b.code, 60), b);
        if (r.error) return sendJSON(res, 400, { error: r.error });
        ctx.save();
        sendJSON(res, 200, Object.assign({ ok: true }, r));
      });
      return true;
    }
    /* Saytdagi HAMMA o'yinlarni bir yo'la yuklash (fonda). O'yinlar "qoralama" bo'lib
       tushadi: mijozlar ko'rmaydi, admin esa do'konning o'zida ko'rib, 🔧 bilan tuzatadi. */
    if (url === "/api/admin/games/import-all" && m === "POST") {
      ctx.readBody(req, res, b => {
        const l = lineById(str(b.lineId, 40)), T = l && LINE_TYPES[l.type];
        if (!l || !T || typeof T.games !== "function") return sendJSON(res, 400, { error: "Bu liniyada katalog yo'q" });
        if (importJob && importJob.running) return sendJSON(res, 409, { error: "Yuklash allaqachon ketyapti", job: jobView() });
        startImportAll(l, T, { section: b.section === "ai" ? "ai" : "games", limit: Math.max(1, Math.min(300, Number(b.limit) || 60)),
          query: str(b.query, 60).toLowerCase(), images: b.images !== false });
        sendJSON(res, 200, { ok: true, job: jobView() });
      });
      return true;
    }
    if (url === "/api/admin/games/import-status" && m === "GET") { sendJSON(res, 200, { job: jobView() }); return true; }
    // Admin uchun do'kon ko'rinishi: qoralama, o'chiq va narxsiz narsalar ham (belgilari bilan).
    if (url === "/api/admin/games/preview" && m === "GET") { sendJSON(res, 200, previewCatalog()); return true; }

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
  /* ---------- import (bitta o'yin) — /import va /import-all ishlatadi ---------- */
  async function importGame(l, T, code, b) {
    let pk;
    try { pk = await T.packages(l, code); } catch (e) { return { error: "Sayt: " + str(e.message, 200) }; }
    if (!pk || !Array.isArray(pk.items)) return { error: "Sayt bo'sh javob berdi" };
    const s = store();
    let g = gameById(str(b.gameId, 40));
    if (!g) {
      const ng = b.newGame || {};
      const id = slug(String(ng.id || "").toLowerCase(), 40);
      if (!id) return { error: "Yangi o'yin uchun ID kiriting (masalan: genshin)" };
      if (gameById(id)) return { error: "Bu ID band" };
      const isAi = ng.section === "ai";
      const sr = splitRegion(ng.name || pk.name || id);
      if (!b.region) b.region = sr.region;
      g = s.games.find(z => gameKey(z.name) === gameKey(sr.base)) || null;
    }
    if (!g) {
      const ng = b.newGame || {}, isAi = false, sr = splitRegion(ng.name || pk.name || "");
      const id = slug(String(ng.id || "").toLowerCase(), 40);
      g = { id, name: str(sr.base || ng.name || pk.name || id, 60), section: "games", img: "", banner: "", color: "#2f8fff",
        fields: isAi ? [{ key: "email", label: "Akkaunt email", ph: "siz@gmail.com", re: EMAIL_RE, type: "email" }]
          : [{ key: "userId", label: "Player ID", ph: "", re: "" }].concat(pk.fields && pk.fields[1] ? [{ key: "zoneId", label: str(pk.fields[1], 30) || "Server ID", ph: "", re: "" }] : []),
        regions: [], tabs: [{ key: "main", label: "Paketlar" }], active: true, sort: popRank(sr.base || ng.name),
        draft: !!ng.draft };
      s.games.push(g);
    }
    addSource(g, l.id, code);
    if (b.region) addRegion(g, slug(b.region, 16));
    if (!(g.regions || []).length) addRegion(g, "global");
    // O'yin avatari va banneri — saytdagi rasm (o'yinda hali rasm bo'lmasa).
    if (pk.img && (!g.img || !g.banner || (b.refreshImages && g.imgSrc === "site"))) {
      const u = await fetchImage(pk.img);
      if (u) {
        if (!g.img || (b.refreshImages && g.imgSrc === "site")) { g.img = u; g.imgSrc = "site"; }
        if (!g.banner || (b.refreshImages && g.bannerSrc === "site")) { g.banner = u; g.bannerSrc = "site"; }
      }
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
      let linked = false;
      const nm = smartName(it.name, pk.name || g.name);
      const price = calcPrice(it.cost, rate, markup);
      let p = s.packages.find(z => z.gameId === g.id && (z.routes || []).some(r => r.lineId === l.id && r.sku === String(it.sku)));
      if (!p) {
        // Boshqa liniyadan kelgan xuddi shu paket — unga shu liniyani ham qo'shamiz.
        const twin = s.packages.find(z => z.gameId === g.id && z.region === region && pkgKey(z) === pkgKey(nm) && !(z.routes || []).some(r => r.lineId === l.id));
        if (twin) {
          twin.routes.push({ lineId: l.id, sku: String(it.sku), cost: it.cost, meta });
          twin.routes.sort((a, b2) => (a.lineId === "manual") - (b2.lineId === "manual"));
          if (!(twin.price > 0) && price > 0) { twin.price = price; if (b.activate) twin.active = true; }
          p = twin; added++; linked = true;
        }
      }
      if (p && !p.routes.some(r => r.lineId === l.id && r.sku === String(it.sku))) p = null;
      if (p && linked) { /* yangi liniya ulandi */ }
      else if (p) {
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
      // Rasm saytdan bir marta yuklanib /gimg/ da saqlanadi. Har kuni tunda (refreshImages) faqat saytdan
      // kelgan rasmlar yangilanadi — admin o'zi qo'ygan rasmga tegilmaydi.
      if (b.images !== false && it.img && (!p.img || (b.refreshImages && p.imgSrc === "site"))) {
        const u = await fetchImage(it.img);
        if (u && u !== p.img) { p.img = u; p.imgSrc = "site"; imgs++; }
        else if (u && !p.imgSrc) p.imgSrc = "site";
      }
    }
    return { gameId: g.id, added, updated, images: imgs, gameImage: !!g.img };
  }
  /* ---------- avto-narx: har N soatda saytdan tannarx va rasmlar yangilanadi ----------
     Narx = tannarx × kurs × (1 + ustama%). Tayyor narx jadvalidagi paketlar o'zgarmaydi,
     faqat zararga tushsa (narx < tannarx × kurs × 1.05) ko'tariladi. O'zgarishlar adminga xabar qilinadi. */
  function apCfg() {
    const s = store();
    if (!s.autoPrice) s.autoPrice = { enabled: false, rate: 12500, markup: 20, hours: 6, last: 0, lastReport: "" };
    return s.autoPrice;
  }
  let apRunning = false;
  async function runAutoPrice(force) {
    const c = apCfg();
    if (apRunning || (!force && (!c.enabled || Date.now() - (c.last || 0) < (c.hours || 6) * 3600e3))) return null;
    apRunning = true; c.last = Date.now();
    const s = store(), changes = [], errors = [];
    let imgs = 0;
    try {
      for (const g of s.games.slice()) for (const src of sourcesOf(g)) {
        const l = lineById(src.lineId), T = l && LINE_TYPES[l.type];
        if (!l || !l.enabled || !T || typeof T.packages !== "function") continue;
        const reg = (s.packages.find(p => p.gameId === g.id && (p.routes || []).some(r => r.lineId === l.id)) || {}).region;
        const r = await importGame(l, T, src.code, { gameId: g.id, region: reg, images: true, updatePrices: false }).catch(e => ({ error: e.message }));
        if (r.error) errors.push(g.name + ": " + r.error); else imgs += r.images || 0;
      }
      for (const p of s.packages) {
        const g = gameById(p.gameId), rt = (p.routes || []).find(x => Number(x.cost) > 0);
        if (!g || !rt) continue;
        const calc = calcPrice(rt.cost, c.rate, c.markup), floor = calcPrice(rt.cost, c.rate, 5);
        const fixed = mainRegion(g, p) ? presetPrice(g.name, p.name) : 0;
        let np = fixed ? (fixed < floor ? calc : fixed) : calc;
        if (np > 0 && np !== p.price) { changes.push(g.name + " · " + p.name + ": " + (p.price || 0) + " → " + np); p.price = np; }
      }
      ctx.save();
      const rep = "🤖 Avto-narx: " + changes.length + " ta narx o'zgardi, " + imgs + " ta rasm qo'shildi" + (errors.length ? ", " + errors.length + " ta xato" : "");
      c.lastReport = rep;
      if (changes.length || errors.length) alertAdmins(rep + (changes.length ? "\n" + changes.slice(0, 25).join("\n") + (changes.length > 25 ? "\n…" : "") : "") + (errors.length ? "\n⚠️ " + errors.slice(0, 5).join("\n⚠️ ") : ""));
      return { changes: changes.length, images: imgs, errors };
    } finally { apRunning = false; }
  }
  const apTimer = setInterval(() => { runAutoPrice(false).catch(() => {}); }, 15 * 60 * 1000);
  /* Har kuni Toshkent vaqti bilan 03:30 da — saytdan kelgan rasmlarni yangilash (kunduzi mijozlar
     birinchi kirganda rasmlar tayyor turadi, yuklanish vaqtida "oqarib" qolmaydi). */
  async function refreshSiteImages() {
    const s = store(); let n = 0;
    for (const g of s.games.slice()) for (const src of sourcesOf(g)) {
      const l = lineById(src.lineId), T = l && LINE_TYPES[l.type];
      if (!l || !l.enabled || !T || typeof T.packages !== "function") continue;
      const reg = (s.packages.find(p => p.gameId === g.id && (p.routes || []).some(r => r.lineId === l.id)) || {}).region;
      try { const r = await importGame(l, T, src.code, { gameId: g.id, region: reg, images: true, refreshImages: true, updatePrices: false }); n += (r && r.images) || 0; } catch (e) {}
    }
    s.imgRefreshAt = Date.now(); ctx.save();
    return n;
  }
  const imgTimer = setInterval(() => {
    const t = new Date(Date.now() + 5 * 3600e3);               // Toshkent = UTC+5
    const s = store();
    if (t.getUTCHours() === 3 && t.getUTCMinutes() >= 30 && Date.now() - (s.imgRefreshAt || 0) > 20 * 3600e3)
      refreshSiteImages().then(n => console.log("[games] tungi rasm yangilanishi: " + n)).catch(() => {});
  }, 5 * 60 * 1000);
  if (imgTimer.unref) imgTimer.unref();
  if (apTimer.unref) apTimer.unref();

  let importJob = null;
  const jobView = () => importJob && { running: importJob.running, line: importJob.line, total: importJob.total, done: importJob.done,
    games: importJob.games, packages: importJob.packages, skipped: importJob.skipped, images: importJob.images, merged: importJob.merged || 0, current: importJob.current, errors: importJob.errors.slice(-10), error: importJob.error, finishedAt: importJob.finishedAt };
  function startImportAll(l, T, opt) {
    importJob = { running: true, line: l.name, total: 0, done: 0, games: 0, packages: 0, skipped: 0, images: 0, current: "", errors: [], error: "", startedAt: Date.now() };
    (async () => {
      let list;
      try { list = await T.games(l); } catch (e) { importJob.error = "Sayt: " + str(e.message, 200); return; }
      list = (list || []).filter(x => x && x.code && (!opt.query || String(x.name || "").toLowerCase().indexOf(opt.query) !== -1));
      const s = store();
      const have = new Set();
      for (const g of s.games) for (const src of sourcesOf(g)) if (src.lineId === l.id) have.add(String(src.code));
      const todo = list.filter(x => !have.has(String(x.code)));
      importJob.skipped = list.length - todo.length;
      importJob.total = Math.min(todo.length, opt.limit);
      for (const x of todo.slice(0, opt.limit)) {
        importJob.current = str(x.name || x.code, 60);
        let id = slug(String(x.name || x.code).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), 32) || "g";
        if (gameById(id)) id = slug(id + "-" + String(x.code).toLowerCase(), 40);
        if (gameById(id)) id = slug(id + "-" + crypto.randomBytes(2).toString("hex"), 40);
        try {
          const r = await importGame(l, T, x.code, { newGame: { id, name: x.name, section: "games", draft: true }, activate: false, images: opt.images });
          if (r.error) importJob.errors.push(str(x.name, 40) + ": " + r.error);
          else {
            importJob.games++; importJob.packages += r.added;
            const g = gameById(r.gameId);
            if (g && !g.img && x.img) { const u = await fetchImage(x.img); if (u) { g.img = u; if (!g.banner) g.banner = u; } }
          }
        } catch (e) { importJob.errors.push(str(x.name, 40) + ": " + str(e.message, 120)); }
        importJob.done++;
        ctx.save();
      }
      // Avval yuklangan o'yinlar: rasmi yo'q paketlar va avatarka saytdan to'ldiriladi.
      if (opt.images !== false) for (const x of list.filter(y => have.has(String(y.code)))) {
        const g = s.games.find(z => sourcesOf(z).some(src => src.lineId === l.id && String(src.code) === String(x.code)));
        if (!g || (g.img && !s.packages.some(p => p.gameId === g.id && !p.img))) continue;
        importJob.current = "🖼 " + str(g.name, 56);
        try {
          const reg = (s.packages.find(p => p.gameId === g.id && (p.routes || []).some(r => r.lineId === l.id)) || {}).region;
          const r = await importGame(l, T, x.code, { gameId: g.id, region: reg, images: true, updatePrices: false });
          if (!r.error) importJob.images += r.images || 0;
          if (!g.img && x.img) { const u = await fetchImage(x.img); if (u) { g.img = u; if (!g.banner) g.banner = u; importJob.images++; } }
        } catch (e) {}
        ctx.save();
      }
      const m = mergeDuplicates(); importJob.merged = m.mergedGames;
    })().catch(e => { importJob.error = str(e.message, 200); }).finally(() => { importJob.running = false; importJob.finishedAt = Date.now(); importJob.current = ""; ctx.save(); });
  }
  // Admin ko'rinishi: hamma o'yin va paketlar, mijozga ko'rinmaydiganlari belgilangan.
  function previewCatalog() {
    const s = store();
    const vis = p => { const g = gameById(p.gameId); return !!(g && g.active && !g.draft && p.active && p.price > 0); };
    const games = s.games.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(g => ({ id: g.id, name: g.name, section: g.section === "ai" ? "ai" : "games",
      img: g.img || "", banner: g.banner || "", color: g.color || "",
      fields: (g.fields || []).map(f => ({ key: f.key, label: f.label, ph: f.ph || "", re: f.re || "", type: f.type === "email" ? "email" : "" })),
      regions: g.regions || [], tabs: g.tabs || [], canCheck: !!checkLineFor(g),
      draft: !!g.draft, status: g.status || "", hidden: !g.active || !!g.draft || !s.packages.some(p => p.gameId === g.id && vis(p)) }));
    const packages = s.packages.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(p => ({ id: p.id, gameId: p.gameId, region: p.region || "", tab: p.tab || "",
      name: p.name, sub: p.sub || "", icon: p.icon || "diamond", img: p.img || "", badge: p.badge || "", price: p.price, hidden: !vis(p), noPrice: !(p.price > 0) }));
    return { games, packages, admin: true };
  }

  /* Paket xaridi — mini ilova (/api/games/buy) va AI yordamchi shu bitta funksiyani
     ishlatadi. Tekshiruv va yechish BIR xil sinxron qadamda — oraliqda await yo'q, shuning
     uchun bir vaqtda bosilgan ikki xarid balansdan ikki marta o'tib keta olmaydi. */
  function buyPackage(u, packageId, account, promoCode) {
    const p = pkgById(str(packageId, 80));
    const g = p && gameById(p.gameId);
    if (!p || !g || !p.active || !g.active || g.draft || !(p.price > 0)) return { ok: false, code: 404, body: { error: "no item" } };
    if (g.status) return { ok: false, code: 409, body: { error: g.status === "maint" ? "Texnik nosozlik — keyinroq urinib ko'ring" : "Vaqtincha mavjud emas" } };
    const c = cleanAccount(g, account);
    if (c.error) return { ok: false, code: 400, body: { error: c.error, field: c.field, label: c.label } };
    let total = Math.round(p.price), promo = null;
    if (promoCode) {
      const pv = ctx.validatePromo(promoCode, u.id, total, { game: p.gameId, pkg: p.id });
      if (!pv.ok) return { ok: false, code: 409, body: { error: "promo_invalid", reason: pv.reason } };
      total = Math.max(0, total - pv.discount);
      promo = { code: pv.promo.code, discount: pv.discount, ref: pv.promo };
    }
    const acc = ctx.user(u);
    if (acc.balance < total) return { ok: false, code: 402, body: { error: "balance", need: total - acc.balance } };
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
    setImmediate(() => fulfill(o).catch(e => console.log("[games] fulfill xato: " + e.message)));
    return { ok: true, order: o, balance: acc.balance };
  }
  // AI uchun: buyurtmani yaratmasdan oldin tekshirish (narx, akkaunt formati).
  function quotePackage(packageId, account) {
    const p = pkgById(str(packageId, 80));
    const g = p && gameById(p.gameId);
    if (!p || !g || !p.active || !g.active || g.draft || !(p.price > 0)) return { ok: false, error: "Bunday paket sotuvda yo'q" };
    if (g.status) return { ok: false, error: g.status === "maint" ? "Texnik nosozlik" : "Vaqtincha mavjud emas" };
    const c = cleanAccount(g, account);
    if (c.error) return { ok: false, error: (c.error === "required" ? "Kerak: " : "Noto'g'ri format: ") + c.label, field: c.field };
    return { ok: true, game: g, pkg: p, accountText: accountText(g, c.account), account: c.account, price: Math.round(p.price),
      title: g.name + " — " + p.name + (p.sub ? " " + p.sub : "") };
  }
  // Tashqaridan (masalan AI orqali narx) o'zgartirilganda ochiq katalog darhol yangilansin.
  function touch() { pubAt = 0; }
  return { handle, registerLineType, store, fulfill, pollAccepted, smartName, calcPrice, lineBalances, buyPackage, quotePackage, pkgById, gameById, publicCatalog, touch };
};
