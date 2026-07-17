// Verion Shop server v3 — static app + catalog + balances/payments/orders. No dependencies.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "5606872249,8684274899")
  .split(",").map(s => Number(s.trim())).filter(Boolean);
const MAX_BODY = 10 * 1024 * 1024;
const HTML_FILE = path.join(__dirname, "verion-shop.html");
const TOPUP_TTL = 10 * 60 * 1000;          // payment window: 10 minutes
const MIN_TOPUP = 1000, MAX_TOPUP = 5000000;

/* ---------- SMS auto-confirm (humocard / cardxabar orqali) ---------- */
// Telegram guruhida humocard/cardxabar botlari yozgan SMS-xabarlarni ushlab,
// summani o'qib, mos to'lovni avtomatik tasdiqlash uchun sozlamalar.
const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || "";      // Telegram setWebhook secret_token bilan bir xil bo'lishi shart
const SMS_SOURCE_CHAT_ID = process.env.SMS_SOURCE_CHAT_ID || "";    // humocard/cardxabar yozadigan guruh chat_id (masalan -1001234567890)
const SMS_BOT_USERNAMES = (process.env.SMS_BOT_USERNAMES || "")     // bo'sh bo'lsa - guruhdagi barcha xabarlar tekshiriladi
  .split(",").map(s => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
const SMS_LOG_MAX = 200;

let DATA_DIR = process.env.DATA_DIR || "/data";
try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) { DATA_DIR = path.join(__dirname, "data"); fs.mkdirSync(DATA_DIR, { recursive: true }); }
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");
const CATMETA_FILE = path.join(DATA_DIR, "catmeta.json");
const DB_FILE = path.join(DATA_DIR, "db.json");

/* ---------- tiny db ---------- */
let DB = { users: {}, payments: [], orders: [], smsLog: [], stock: {}, reviews: [],
  settings: { referral: { enabled: true, percent: 1 } } };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) {}
if (!DB.settings) DB.settings = {};
if (!DB.settings.referral) DB.settings.referral = { enabled: true, percent: 1 };
if (DB.settings.referral.percent === undefined) {
  // eski (bir martalik bonus) sozlamadan yangi (har xariddan foiz) sozlamaga o'tish
  DB.settings.referral = { enabled: DB.settings.referral.enabled !== false, percent: 1 };
}
// Moderatsiya joriy etilishidan oldingi sharhlar — allaqachon ochiq bo'lgani uchun "approved" deb belgilanadi.
if (Array.isArray(DB.reviews)) for (const r of DB.reviews) if (!r.status) r.status = "approved";
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => {
  fs.writeFile(DB_FILE, JSON.stringify(DB), () => {}); }, 100); }
function user(u) {
  const k = String(u.id);
  if (!DB.users[k]) DB.users[k] = { balance: 0, ts: Date.now() };
  DB.users[k].uname = u.username || DB.users[k].uname || null;
  DB.users[k].name = ((u.first_name || "") + " " + (u.last_name || "")).trim() || DB.users[k].name;
  if (u.photo_url) DB.users[k].photo = u.photo_url;
  return DB.users[k];
}
function genId(p) {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return p + "-" + s;
}
// "today" | "week" | "month" | "all" -> shu davr boshlanishining vaqt belgisi (ms).
// "week" — joriy hafta dushanbadan, "month" — joriy oyning 1-sanasidan.
// Foydalanuvchi aniq tasdiqladi: "kun"/"hafta"/"oy"/"hammasi" — barchasi bot
// ochilgandan hozirgacha bo'lgan TO'LIQ (cheksiz) ma'lumot bo'yicha hisoblanadi,
// hech biri sanaga cheklanmaydi. Shu sabab period parametridan qat'iy nazar 0 qaytariladi.
function periodStart(period) {
  return 0;
}

/* ---------- referal dasturi ---------- */
// Mini-App'ning BotFather'da belgilangan "short name"i (masalan "app" yoki "shop") —
// bu botga tegishli mini-ilovani TO'G'RIDAN-TO'G'RI ochadigan havola qurish uchun kerak:
// https://t.me/<bot_username>/<MINIAPP_NAME>?startapp=... — shu format orqaligina
// start_param mini-ilova ichiga to'g'ri yetib boradi (oddiy ?start= chatni ochadi, ilovani emas).
// Railway Variables'da MINIAPP_NAME o'rnatilmagan bo'lsa, pastdagi standart qiymat ishlatiladi —
// buni BotFather > Bot Settings > Menu Button / Mini Apps bo'limidagi haqiqiy nomga moslang.
const MINIAPP_NAME = process.env.MINIAPP_NAME || "app";
// Bot username'ni Telegram'dan bir marta so'rab olamiz (referal havolasi t.me/<username>?start=ref_<uid>
// qurish uchun kerak) — alohida ENV o'zgaruvchi talab qilmaslik uchun.
let BOT_USERNAME = "";
(function fetchBotUsername() {
  if (!BOT_TOKEN) return;
  try {
    https.get("https://api.telegram.org/bot" + BOT_TOKEN + "/getMe", r => {
      let body = ""; r.on("data", c => body += c);
      r.on("end", () => { try { const j = JSON.parse(body); if (j.ok) BOT_USERNAME = j.result.username; } catch (e) {} });
    }).on("error", () => {});
  } catch (e) {}
})();

// Taklif qilingan foydalanuvchi HAR safar xaridni yakunlaganda (status "done" bo'lganda),
// uni taklif qilgan foydalanuvchiga shu xariddan foiz (masalan 1%) bonus beriladi — bir martalik emas, doimiy.
function creditReferralOnOrder(order) {
  try {
    if (!order || order.status !== "done") return;
    const settings = DB.settings.referral || {};
    if (!settings.enabled) return;
    const acc = DB.users[String(order.uid)];
    if (!acc || !acc.referredBy) return;
    const refAcc = DB.users[String(acc.referredBy)];
    if (!refAcc) return;
    const pct = Number(settings.percent) || 0;
    if (pct <= 0) return;
    const already = acc.referralCreditedOrders || (acc.referralCreditedOrders = []);
    if (already.indexOf(order.id) !== -1) return; // shu buyurtma uchun bonus allaqachon berilgan
    const bonus = Math.floor((Number(order.price) || 0) * pct / 100);
    if (bonus <= 0) return;
    refAcc.balance = (refAcc.balance || 0) + bonus;
    refAcc.referralEarnedTotal = (refAcc.referralEarnedTotal || 0) + bonus;
    already.push(order.id);
    save();
    tgSend(acc.referredBy, "🎉 Taklif qilgan do'stingiz xarid qildi! Balansingizga " +
      bonus.toLocaleString("ru-RU") + " so'm bonus qo'shildi.");
  } catch (e) {}
}
function expireOld() {
  const now = Date.now();
  for (const p of DB.payments)
    if (p.status === "waiting" && now - p.ts > TOPUP_TTL) p.status = "cancelled";
}
// To'lovni tasdiqlash (admin qo'lda ✅ bossa ham, SMS avtomat topsa ham shu funksiya ishlaydi)
function confirmPayment(p, source) {
  p.status = "done"; p.doneTs = Date.now(); p.confirmedBy = source || "admin";
  const acc = DB.users[String(p.uid)] || (DB.users[String(p.uid)] = { balance: 0 });
  acc.balance += p.amount;
  save();
  return acc.balance;
}
function tgSend(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const data = JSON.stringify({ chat_id: chatId, text: text });
    const req = https.request({
      hostname: "api.telegram.org", path: "/bot" + BOT_TOKEN + "/sendMessage", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, r => { r.on("data", () => {}); });
    req.on("error", () => {});
    req.write(data); req.end();
  } catch (e) {}
}
// fragment-api.uz bilan ishlash: Telegram Stars va Premium'ni istalgan @username'ga avtomatik sotib olish.
// FRAGMENT_API_KEY Railway "Variables" orqali beriladi, kodga yozilmaydi (xavfsizlik uchun).
const FRAGMENT_API_KEY = process.env.FRAGMENT_API_KEY || "";
const FRAGMENT_HOST = "fragment-api.uz";
function fragmentCall(path, body) {
  return new Promise((resolve, reject) => {
    if (!FRAGMENT_API_KEY) return reject(new Error("FRAGMENT_API_KEY sozlanmagan"));
    const data = JSON.stringify(body || {});
    const req = https.request({
      hostname: FRAGMENT_HOST, path: "/api/v1" + path, method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": FRAGMENT_API_KEY,
        "Content-Length": Buffer.byteLength(data) },
      timeout: 25000
    }, r => {
      let buf = "";
      r.on("data", c => buf += c);
      r.on("end", () => {
        try { resolve({ status: r.statusCode, json: JSON.parse(buf || "{}") }); }
        catch (e) { resolve({ status: r.statusCode, json: null, raw: buf }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(data); req.end();
  });
}
// SMS/xabar matnidan pul summasini o'qib olish (Humo/Uzcard bildirishnomalari uchun)
// Masalan: "Kartangizga 50 038 so'm tushdi" yoki "+50,038 UZS" kabi matnlardan 50038 ni topadi.
function parseAmount(text) {
  if (!text) return null;
  const t = String(text).replace(/\u00A0/g, " ");
  let re = /(\d[\d\s.,]{2,})\s*(so'?m|сум|sum|uzs)/gi, m;
  while ((m = re.exec(t)) !== null) {
    const n = extractInt(m[1]);
    if (n > 0) return n;
  }
  m = /[+]\s*(\d[\d\s.,]{3,})/.exec(t);
  if (m) { const n = extractInt(m[1]); if (n > 0) return n; }
  return null;
}
// "2.000,00" yoki "1,002.50" kabi formatlarda oxirgi 2 xonali qism tiyin/kopeck
// (kasr) hisoblanadi va tashlab yuboriladi; qolgan minglik ajratkichlari olib tashlanadi.
function extractInt(raw) {
  let s = String(raw).trim();
  const dec = s.match(/^(.*)[.,](\d{2})$/);
  if (dec) s = dec[1];
  const n = parseInt(s.replace(/[^\d]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}
function logSms(entry) {
  DB.smsLog.push(entry);
  if (DB.smsLog.length > SMS_LOG_MAX) DB.smsLog.splice(0, DB.smsLog.length - SMS_LOG_MAX);
  save();
}

/* ---------- telegram auth ---------- */
function checkInitData(initData) {
  try {
    if (!initData || !BOT_TOKEN) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dcs = [...params.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    if (crypto.createHmac("sha256", secret).update(dcs).digest("hex") !== hash) return null;
    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate || (Date.now() / 1000 - authDate) > 259200) return null;
    const u = JSON.parse(params.get("user") || "null");
    if (u) u._startParam = params.get("start_param") || "";
    return u;
  } catch (e) { return null; }
}
function auth(req) { return checkInitData(req.headers["x-init-data"] || ""); }
function isAdm(u) { return !!u && ADMIN_IDS.indexOf(u.id) !== -1; }

function send(res, code, obj, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}
function readBody(req, res, cb) {
  let body = "", size = 0, dead = false;
  req.on("data", c => {
    size += c.length;
    if (size > MAX_BODY) { dead = true; send(res, 413, { error: "too large" }); req.destroy(); }
    else body += c;
  });
  req.on("end", () => {
    if (dead) return;
    try { cb(JSON.parse(body || "{}")); } catch (e) { send(res, 400, { error: "invalid json" }); }
  });
}
function catalogArr() {
  try { return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")); } catch (e) { return null; }
}
// Kategoriya kartochkalari (Obuna/Promokod/Telegram/O'yinlar) uchun admin belgilagan
// nom va rasm — { obuna: {label:{uz,ru,en}, img:"data:..."}, telegram: {...}, ... }
function catMetaObj() {
  try { return JSON.parse(fs.readFileSync(CATMETA_FILE, "utf8")); } catch (e) { return {}; }
}
function myView(uid) {
  expireOld();
  const mine = x => x.uid === uid;
  const reviewedIds = new Set(DB.reviews.filter(mine).map(r => r.orderId));
  const acc = DB.users[String(uid)] || { balance: 0 };
  return {
    balance: acc.balance,
    favorites: Array.isArray(acc.favorites) ? acc.favorites : [],
    payments: DB.payments.filter(mine).slice(-50).reverse(),
    orders: DB.orders.filter(mine).slice(-50).reverse()
      .map(o => Object.assign({}, o, { reviewed: reviewedIds.has(o.id) }))
  };
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const q = new URLSearchParams((req.url || "").split("?")[1] || "");
  const m = req.method;

  /* catalog (public read / admin write) */
  if (url === "/api/catalog" && m === "GET") {
    const c = catalogArr();
    return c ? send(res, 200, c) : send(res, 404, { error: "no catalog yet" });
  }
  if (url === "/api/catalog" && m === "POST") {
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set" });
    const u = auth(req);
    if (!isAdm(u)) return send(res, 403, { error: "not admin" });
    return readBody(req, res, arr => {
      if (!Array.isArray(arr) || !arr.length) return send(res, 400, { error: "invalid json" });
      fs.writeFile(CATALOG_FILE, JSON.stringify(arr), err =>
        err ? send(res, 500, { error: "write failed" }) : send(res, 200, { ok: true, items: arr.length }));
    });
  }

  if (url === "/api/category-meta" && m === "GET") {
    return send(res, 200, catMetaObj());
  }
  if (url === "/api/admin/category-meta" && m === "POST") {
    const u = auth(req);
    if (!isAdm(u)) return send(res, 403, { error: "not admin" });
    return readBody(req, res, obj => {
      if (!obj || typeof obj !== "object") return send(res, 400, { error: "invalid json" });
      fs.writeFile(CATMETA_FILE, JSON.stringify(obj), err =>
        err ? send(res, 500, { error: "write failed" }) : send(res, 200, { ok: true }));
    });
  }

  /* ----- user endpoints (need valid Telegram signature) ----- */
  if (url === "/api/stock-counts" && m === "GET") {
    const out = {};
    for (const k in DB.stock) out[k] = (DB.stock[k] || []).length;
    return send(res, 200, out);
  }
  if (url === "/api/me" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    const isNew = !DB.users[String(u.id)];
    const acc = user(u);
    if (isNew && u._startParam && /^ref_\d+$/.test(u._startParam)) {
      const refUid = Number(u._startParam.slice(4));
      if (refUid && refUid !== u.id) acc.referredBy = refUid;
    }
    save();
    return send(res, 200, myView(u.id));
  }

  // Foydalanuvchining Telegram profil rasmini server orqali olib beradi,
  // shunda brauzer uni bir marta o'zida (localStorage) saqlab qo'yishi mumkin —
  // Telegram'ning vaqtinchalik photo_url havolasi keyinchalik ishlamay qolsa ham muammo bo'lmaydi.
  if (url === "/api/avatar" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    if (!u.photo_url) return send(res, 404, { error: "no_photo" });
    try {
      https.get(u.photo_url, r => {
        if (r.statusCode !== 200) { r.resume(); return send(res, 502, { error: "fetch_failed" }); }
        const chunks = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => {
          const buf = Buffer.concat(chunks);
          const ctype = r.headers["content-type"] || "image/jpeg";
          send(res, 200, { ok: true, dataUrl: "data:" + ctype + ";base64," + buf.toString("base64") });
        });
      }).on("error", e => send(res, 502, { error: e.message }));
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  /* ===== Referal dasturi ===== */
  if (url === "/api/referral" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    const settings = DB.settings.referral || {};
    const invitedKeys = Object.keys(DB.users).filter(k => DB.users[k].referredBy === u.id);
    const friends = invitedKeys
      .map(k => ({ name: DB.users[k].name || "", uname: DB.users[k].uname || null, ts: DB.users[k].ts || 0 }))
      .sort((a, b) => b.ts - a.ts);
    const myAcc = DB.users[String(u.id)] || {};
    const appPart = MINIAPP_NAME ? ("/" + MINIAPP_NAME) : "";
    return send(res, 200, {
      enabled: !!settings.enabled,
      percent: Number(settings.percent) || 0,
      link: BOT_USERNAME ? ("https://t.me/" + BOT_USERNAME + appPart + "?startapp=ref_" + u.id) : "",
      invitedCount: invitedKeys.length,
      totalEarned: Number(myAcc.referralEarnedTotal) || 0,
      friends
    });
  }

  /* ===== Sevimlilar (wishlist) ===== */
  if (url === "/api/favorite" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    return readBody(req, res, b => {
      const acc = user(u);
      if (!Array.isArray(acc.favorites)) acc.favorites = [];
      const id = String(b.itemId || "");
      if (!id) return send(res, 400, { error: "itemId" });
      const i = acc.favorites.indexOf(id);
      if (i === -1) acc.favorites.push(id); else acc.favorites.splice(i, 1);
      save();
      send(res, 200, { ok: true, favorites: acc.favorites });
    });
  }


  // Xarid "done" bo'lgan buyurtmaga mijoz 1 marta sharh qoldirishi mumkin.
  if (url === "/api/review" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    return readBody(req, res, b => {
      const stars = Math.max(1, Math.min(5, Math.round(Number(b.stars) || 0)));
      const text = String(b.text || "").trim().slice(0, 200);
      const o = DB.orders.find(x => x.id === b.orderId && x.uid === u.id);
      if (!o) return send(res, 404, { error: "no_order" });
      if (o.status !== "done") return send(res, 409, { error: "order_not_done" });
      if (DB.reviews.some(r => r.orderId === o.id)) return send(res, 409, { error: "already_reviewed" });
      const acc = user(u);
      const rv = { id: genId("RV"), uid: u.id, name: (acc.name || u.first_name || "Mijoz").split(" ")[0],
        orderId: o.id, itemTitle: o.item, stars, text, ts: Date.now(), status: "pending" };
      DB.reviews.push(rv); save();
      send(res, 200, { ok: true, review: rv });
    });
  }
  // Bosh sahifadagi "Mijozlar fikri" uchun ochiq (auth shart emas) — faqat admin tasdiqlagan sharhlar.
  if (url === "/api/reviews" && m === "GET") {
    const list = DB.reviews.filter(r => r.status === "approved").slice(-40).reverse()
      .map(r => ({ name: r.name, itemTitle: r.itemTitle, stars: r.stars, text: r.text, ts: r.ts }));
    return send(res, 200, { reviews: list });
  }

  /* ===== Top donaterlar (reyting) ===== */
  // Faqat "done" buyurtmalar summasi bo'yicha, ochiq (auth shart emas).
  // Ism faqat "Ism F." formatida ko'rsatiladi, username hech qachon chiqmaydi.
  // Adminlar (ADMIN_IDS) reytingda hech qachon ko'rinmaydi.
  if (url === "/api/leaderboard" && m === "GET") {
    const period = q.get("period") || "all"; // today | week | month | all
    const cutoff = periodStart(period);
    const totals = {}, counts = {};
    for (const o of DB.orders) {
      if (o.status !== "done") continue;
      if (o.ts < cutoff) continue;
      if (ADMIN_IDS.indexOf(Number(o.uid)) !== -1) continue;
      totals[o.uid] = (totals[o.uid] || 0) + (Number(o.price) || 0);
      counts[o.uid] = (counts[o.uid] || 0) + 1;
    }
    const rows = Object.keys(totals).map(uid => {
      const acc = DB.users[uid] || {};
      const full = (acc.name || "").trim();
      const parts = full.split(/\s+/).filter(Boolean);
      const shown = parts.length > 1 ? (parts[0] + " " + parts[1][0] + ".") : (parts[0] || "Mijoz");
      return { name: shown, total: totals[uid], count: counts[uid] || 0, photo: acc.photo || null };
    }).filter(r => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 20)
      .map((r, i) => Object.assign({ rank: i + 1 }, r));
    return send(res, 200, { period, leaderboard: rows });
  }

  if (url === "/api/topup" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    return readBody(req, res, b => {
      const amount = Math.round(Number(b.amount) || 0);
      const method = String(b.method || "");
      if (amount < MIN_TOPUP || amount > MAX_TOPUP) return send(res, 400, { error: "amount" });
      expireOld();
      // one active top-up per user
      for (const p of DB.payments)
        if (p.uid === u.id && (p.status === "waiting")) p.status = "cancelled";
      // unique payable amount: add smallest free delta (0..499 so'm)
      const active = new Set(DB.payments
        .filter(p => p.status === "waiting" || p.status === "checking").map(p => p.pay));
      let delta = 0; while (active.has(amount + delta) && delta < 500) delta++;
      const rec = { id: genId("TP"), uid: u.id, uname: u.username || null, type: "topup",
        amount, pay: amount + delta, method, status: "waiting", ts: Date.now() };
      user(u); DB.payments.push(rec); save();
      send(res, 200, { ok: true, payment: rec, expiresAt: rec.ts + TOPUP_TTL });
    });
  }

  if (url === "/api/paid" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    return readBody(req, res, b => {
      expireOld();
      const p = DB.payments.find(x => x.id === b.id && x.uid === u.id);
      if (!p) return send(res, 404, { error: "not found" });
      if (p.status !== "waiting") return send(res, 409, { error: "state", status: p.status });
      p.status = "checking"; p.paidTs = Date.now(); save();
      send(res, 200, { ok: true });
    });
  }

  if (url === "/api/fragment/check-user" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    return readBody(req, res, b => {
      const uname = String(b.username || "").trim().replace(/^@/, "");
      if (!uname) return send(res, 400, { error: "username" });
      fragmentCall("/getInfo", { username: uname }).then(r => {
        const j = r.json;
        if (!j || j.ok !== true) return send(res, 404, { ok: false, message: (j && j.message) || "Topilmadi" });
        send(res, 200, { ok: true, result: j.result });
      }).catch(e => send(res, 502, { ok: false, message: String(e.message || e) }));
    });
  }
  if (url === "/api/buy-stars-custom" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    return readBody(req, res, b => {
      const cat = catalogArr();
      if (!cat) return send(res, 409, { error: "catalog not published" });
      const it = cat.find(x => x.id === b.itemId && x.active !== false && x.fulfill === "fragment_stars_custom");
      if (!it) return send(res, 404, { error: "no item" });
      const uname = String(b.username || "").trim().replace(/^@/, "");
      const amount = Math.round(Number(b.amount) || 0);
      const minS = Number(it.minStars) || 50;
      if (!uname) return send(res, 400, { error: "username" });
      if (amount < minS) return send(res, 400, { error: "min_amount", min: minS });
      const price = Math.round(amount * (Number(it.pricePerStar) || 0));
      const acc = user(u);
      if (acc.balance < price) return send(res, 402, { error: "balance", need: price - acc.balance });
      fragmentCall("/stars/buy", { amount, username: uname }).then(r => {
        const j = r.json;
        if (!j || j.ok !== true) {
          const msg = (j && j.message) || "Fragment xatosi";
          return send(res, 502, { error: "fragment_failed", message: msg });
        }
        acc.balance -= price;
        const summary = "⭐ " + amount + " Stars @" + uname + " ga yuborildi";
        const o = { id: genId("VN"), uid: u.id, uname: u.username || null, itemId: it.id,
          item: "Telegram Stars (" + amount + ")", price, status: "done", ts: Date.now(),
          delivered: summary, doneTs: Date.now(), fragment: j.result || null };
        DB.orders.push(o); save();
        creditReferralOnOrder(o);
        send(res, 200, { ok: true, order: o, balance: acc.balance });
      }).catch(e => send(res, 502, { error: "fragment_failed", message: String(e.message || e) }));
    });
  }
  if (url === "/api/buy" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    return readBody(req, res, b => {
      const cat = catalogArr();
      if (!cat) return send(res, 409, { error: "catalog not published" });
      const it = cat.find(x => x.id === b.itemId && x.active !== false);
      if (!it) return send(res, 404, { error: "no item" });
      const price = Math.round(Number(it.price) || 0);
      const acc = user(u);
      const title = typeof it.title === "string" ? it.title : ((it.title && (it.title.uz || it.title.en)) || "");

      /* ----- Fragment orqali avtomatik Stars/Premium yetkazish (istalgan @username'ga) ----- */
      if (it.fulfill === "fragment_stars" || it.fulfill === "fragment_premium") {
        if (!u.username) return send(res, 409, { error: "no_username" });
        if (acc.balance < price) return send(res, 402, { error: "balance", need: price - acc.balance });
        const isStars = it.fulfill === "fragment_stars";
        const path = isStars ? "/stars/buy" : "/premium/buy";
        const body = isStars ? { amount: Number(it.starsAmount) || 0, username: u.username }
                              : { duration: Number(it.premiumMonths) || 3, username: u.username };
        fragmentCall(path, body).then(r => {
          const j = r.json;
          if (!j || j.ok !== true) {
            const msg = (j && j.message) || "Fragment xatosi";
            return send(res, 502, { error: "fragment_failed", message: msg });
          }
          acc.balance -= price;
          const summary = isStars
            ? "⭐ " + body.amount + " Stars @" + u.username + " ga yuborildi"
            : "💎 Premium " + body.duration + " oy @" + u.username + " ga yuborildi";
          const o = { id: genId("VN"), uid: u.id, uname: u.username || null, itemId: it.id,
            item: title, price, status: "done", ts: Date.now(),
            delivered: summary, doneTs: Date.now(), fragment: j.result || null };
          DB.orders.push(o); save();
          creditReferralOnOrder(o);
          send(res, 200, { ok: true, order: o, balance: acc.balance });
        }).catch(e => send(res, 502, { error: "fragment_failed", message: String(e.message || e) }));
        return;
      }

      // Agar bu mahsulot uchun inventar (aniq zaxira ro'yxati) yuritilayotgan bo'lsa va u tugagan bo'lsa — sotib bo'lmaydi
      const listCheck = DB.stock[it.id];
      if (Array.isArray(listCheck) && listCheck.length === 0)
        return send(res, 409, { error: "out_of_stock" });
      if (acc.balance < price) return send(res, 402, { error: "balance", need: price - acc.balance });
      // Zaxirada (stock) tayyor mahsulot bo'lsa — bittasini olib, shu mijozga qat'iy biriktiramiz
      // (boshqa hech kimga qayta berilmaydi), balansdan yechamiz va darhol "bajarildi" deb belgilaymiz.
      const list = DB.stock[it.id];
      const delivered = (Array.isArray(list) && list.length) ? list.shift() : null;
      acc.balance -= price;
      const o = { id: genId("VN"), uid: u.id, uname: u.username || null, itemId: it.id,
        item: title, price, status: delivered ? "done" : "pending", ts: Date.now(),
        delivered: delivered || null, doneTs: delivered ? Date.now() : null };
      DB.orders.push(o); save();
      if (delivered) creditReferralOnOrder(o);
      send(res, 200, { ok: true, order: o, balance: acc.balance });
    });
  }

  /* ----- admin endpoints ----- */
  if (url.indexOf("/api/admin/") === 0) {
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set" });
    const a = auth(req);
    if (!isAdm(a)) return send(res, 403, { error: "not admin" });

    if (url === "/api/admin/list" && m === "GET") {
      expireOld();
      return send(res, 200, {
        payments: DB.payments.filter(p => p.status === "checking" || p.status === "waiting").reverse(),
        orders: DB.orders.filter(o => o.status === "pending" || o.status === "processing").reverse()
      });
    }
    if (url === "/api/admin/payment" && m === "POST") {
      return readBody(req, res, b => {
        const p = DB.payments.find(x => x.id === b.id);
        if (!p) return send(res, 404, { error: "not found" });
        if (p.status === "done") return send(res, 409, { error: "already done" });
        if (b.action === "confirm") {
          const balance = confirmPayment(p, "admin");
          return send(res, 200, { ok: true, balance: balance });
        }
        p.status = "cancelled"; save(); return send(res, 200, { ok: true });
      });
    }
    if (url === "/api/admin/order" && m === "POST") {
      return readBody(req, res, b => {
        const o = DB.orders.find(x => x.id === b.id);
        if (!o) return send(res, 404, { error: "not found" });
        if (o.status !== "pending") return send(res, 409, { error: "state" });
        if (b.action === "done") {
          o.status = "done"; o.doneTs = Date.now();
          save();
          creditReferralOnOrder(o);
          tgSend(o.uid, "✅ Buyurtmangiz bajarildi: " + o.item);
        }
        else { o.status = "cancelled"; // refund
          const acc = DB.users[String(o.uid)] || (DB.users[String(o.uid)] = { balance: 0 });
          acc.balance += o.price;
          save();
          tgSend(o.uid, "❌ Buyurtmangiz bekor qilindi, mablag' balansingizga qaytarildi: " + o.item);
        }
        return send(res, 200, { ok: true });
      });
    }
    if (url === "/api/admin/history" && m === "GET") {
      const uid = Number(q.get("uid") || 0);
      if (!uid) return send(res, 400, { error: "uid" });
      const acc = DB.users[String(uid)] || { balance: 0 };
      const payments = DB.payments.filter(p => p.uid === uid).sort((x, y) => y.ts - x.ts);
      const orders = DB.orders.filter(o => o.uid === uid).sort((x, y) => y.ts - x.ts);
      return send(res, 200, {
        uid, uname: acc.uname || null, name: acc.name || null, balance: acc.balance || 0,
        payments, orders
      });
    }
    if (url === "/api/admin/user" && m === "GET") {
      const s = (q.get("q") || "").trim().toLowerCase().replace(/^@/, "");
      if (!s) return send(res, 400, { error: "q" });
      const out = [];
      for (const k in DB.users) {
        const v = DB.users[k];
        if (k === s || k.indexOf(s) !== -1 ||
            (v.uname && v.uname.toLowerCase().indexOf(s) !== -1) ||
            (v.name && v.name.toLowerCase().indexOf(s) !== -1))
          out.push({ uid: Number(k), uname: v.uname, name: v.name, balance: v.balance });
        if (out.length >= 10) break;
      }
      return send(res, 200, out);
    }
    if (url === "/api/admin/fragment-balance" && m === "GET") {
      return fragmentCall("/wallet/balance", {}).then(r => {
        send(res, 200, r.json || { ok: false });
      }).catch(e => send(res, 200, { ok: false, message: String(e.message || e) }));
    }
    if (url === "/api/admin/fragment-pricing" && m === "GET") {
      const kind = q.get("kind") || "stars";
      const p = kind === "premium" ? fragmentCall("/premium/pricing", {}) :
        fragmentCall("/stars/pricing", { amount: Number(q.get("amount")) || 50 });
      return p.then(r => send(res, 200, r.json || { ok: false }))
        .catch(e => send(res, 200, { ok: false, message: String(e.message || e) }));
    }
    if (url === "/api/admin/stock" && m === "GET") {
      const itemId = q.get("itemId") || "";
      const list = DB.stock[itemId] || [];
      return send(res, 200, { itemId, count: list.length, items: list });
    }
    if (url === "/api/admin/stock/add" && m === "POST") {
      return readBody(req, res, b => {
        const itemId = String(b.itemId || "");
        if (!itemId) return send(res, 400, { error: "itemId" });
        const lines = String(b.text || "").split("\n").map(s => s.trim()).filter(Boolean);
        if (!lines.length) return send(res, 400, { error: "empty" });
        if (!DB.stock[itemId]) DB.stock[itemId] = [];
        DB.stock[itemId] = DB.stock[itemId].concat(lines);
        save();
        return send(res, 200, { ok: true, count: DB.stock[itemId].length });
      });
    }
    if (url === "/api/admin/stock/remove" && m === "POST") {
      return readBody(req, res, b => {
        const itemId = String(b.itemId || "");
        const idx = Number(b.index);
        if (!DB.stock[itemId] || !(idx >= 0) || idx >= DB.stock[itemId].length)
          return send(res, 404, { error: "not found" });
        DB.stock[itemId].splice(idx, 1);
        save();
        return send(res, 200, { ok: true, count: DB.stock[itemId].length });
      });
    }
    if (url === "/api/admin/stock/clear" && m === "POST") {
      return readBody(req, res, b => {
        const itemId = String(b.itemId || "");
        DB.stock[itemId] = [];
        save();
        return send(res, 200, { ok: true, count: 0 });
      });
    }
    if (url === "/api/admin/stats" && m === "GET") {
      const period = q.get("period") || "all"; // today | week | month | all
      const cutoff = periodStart(period);
      const users = Object.keys(DB.users).length;
      const totalBalance = Object.values(DB.users).reduce((s, v) => s + (v.balance || 0), 0);
      const doneOrders = DB.orders.filter(o => o.status === "done" && o.ts >= cutoff);
      const revenue = doneOrders.reduce((s, o) => s + (o.price || 0), 0);
      const donePays = DB.payments.filter(p => p.status === "done" && p.ts >= cutoff);
      const topupSum = donePays.reduce((s, p) => s + (p.amount || 0), 0);
      return send(res, 200, {
        period, users, totalBalance, ordersCount: doneOrders.length, revenue, topupSum,
        pendingPayments: DB.payments.filter(p => p.status === "waiting" || p.status === "checking").length
      });
    }
    if (url === "/api/admin/referral-settings" && m === "GET") {
      return send(res, 200, DB.settings.referral || {});
    }
    if (url === "/api/admin/referral-settings" && m === "POST") {
      return readBody(req, res, b => {
        DB.settings.referral = {
          enabled: !!b.enabled,
          percent: Math.max(0, Math.min(100, Number(b.percent) || 0))
        };
        save();
        send(res, 200, { ok: true, referral: DB.settings.referral });
      });
    }
    if (url === "/api/admin/users" && m === "GET") {
      const sortBy = q.get("sort") || "recent"; // recent | balance
      let list = Object.keys(DB.users).map(k => ({ uid: Number(k), uname: DB.users[k].uname,
        name: DB.users[k].name, balance: DB.users[k].balance || 0, ts: DB.users[k].ts || 0 }));
      list.sort((a, b) => sortBy === "balance" ? b.balance - a.balance : b.ts - a.ts);
      return send(res, 200, list.slice(0, 60));
    }
    if (url === "/api/admin/reviews" && m === "GET") {
      return send(res, 200, { reviews: DB.reviews.slice().reverse() });
    }
    if (url === "/api/admin/review-approve" && m === "POST") {
      return readBody(req, res, b => {
        const rv = DB.reviews.find(r => r.id === b.id);
        if (!rv) return send(res, 404, { error: "not_found" });
        rv.status = "approved"; save();
        send(res, 200, { ok: true });
      });
    }
    // Rad etish ham, tasdiqlangandan keyin o'chirish ham shu bitta endpoint orqali.
    if (url === "/api/admin/review-delete" && m === "POST") {
      return readBody(req, res, b => {
        const before = DB.reviews.length;
        DB.reviews = DB.reviews.filter(r => r.id !== b.id);
        save();
        send(res, 200, { ok: true, removed: before - DB.reviews.length });
      });
    }
    if (url === "/api/admin/balance" && m === "POST") {
      return readBody(req, res, b => {
        const k = String(Number(b.uid) || 0);
        if (!DB.users[k]) return send(res, 404, { error: "no user" });
        const delta = Math.round(Number(b.delta) || 0);
        if (!delta) return send(res, 400, { error: "delta" });
        DB.users[k].balance += delta;
        if (DB.users[k].balance < 0) DB.users[k].balance = 0;
        DB.payments.push({ id: genId("MN"), uid: Number(k), uname: DB.users[k].uname, type: "manual",
          amount: delta, pay: delta, method: "admin", status: "done", ts: Date.now(), by: a.id });
        save(); return send(res, 200, { ok: true, balance: DB.users[k].balance });
      });
    }
    return send(res, 404, { error: "unknown admin route" });
  }

  /* ----- Userbot webhook: Telethon skripti to'g'ridan-to'g'ri shu yerga SMS matnini yuboradi ----- */
  if (url === "/api/debug/status" && m === "GET") {
    if (!TG_WEBHOOK_SECRET || q.get("secret") !== TG_WEBHOOK_SECRET)
      return send(res, 401, { error: "bad secret" });
    expireOld();
    return send(res, 200, {
      faolTolovlar: DB.payments.filter(p => p.status === "waiting" || p.status === "checking")
        .map(p => ({ id: p.id, uid: p.uid, kutilgan_summa: p.amount, tolash_kerak: p.pay, holat: p.status,
          yaratilgan: new Date(p.ts).toLocaleString("ru-RU") })),
      oxirgiSmsLog: DB.smsLog.slice(-20).reverse(),
      jamiTolovlar: DB.payments.length,
    });
  }

  if (url === "/api/sms-webhook" && m === "POST") {
    if (!TG_WEBHOOK_SECRET || req.headers["x-sms-secret"] !== TG_WEBHOOK_SECRET)
      return send(res, 401, { error: "bad secret" });
    return readBody(req, res, b => {
      send(res, 200, { ok: true });
      try {
        const text = String((b && b.text) || "").slice(0, 500);
        const fromUser = String((b && b.from) || "").toLowerCase().replace(/^@/, "");
        console.log("[sms-webhook] from=" + fromUser + " text=" + JSON.stringify(text));
        if (!text) return console.log("[sms-webhook] bo'sh matn, chiqildi");
        if (SMS_BOT_USERNAMES.length && SMS_BOT_USERNAMES.indexOf(fromUser) === -1) {
          console.log("[sms-webhook] '" + fromUser + "' SMS_BOT_USERNAMES ro'yxatida yo'q, chiqildi");
          return logSms({ ts: Date.now(), from: fromUser || null, text, parsedAmount: null,
            matched: false, paymentId: null, rejected: "username_not_allowed" });
        }

        const amount = parseAmount(text);
        console.log("[sms-webhook] o'qilgan summa = " + amount);
        expireOld();
        const candidates = amount == null ? [] :
          DB.payments.filter(p => (p.status === "waiting" || p.status === "checking") && p.pay === amount);
        console.log("[sms-webhook] mos to'lovlar soni = " + candidates.length +
          " | barcha faol to'lovlar: " + JSON.stringify(DB.payments
            .filter(p => p.status === "waiting" || p.status === "checking")
            .map(p => ({ id: p.id, pay: p.pay, status: p.status }))));

        const entry = { ts: Date.now(), from: fromUser || null, text, parsedAmount: amount,
          matched: false, paymentId: null };

        if (candidates.length === 1) {
          const p = candidates[0];
          const balance = confirmPayment(p, "sms");
          entry.matched = true; entry.paymentId = p.id;
          console.log("[sms-webhook] TASDIQLANDI, to'lov id=" + p.id);
          tgSend(p.uid, "✅ To'lovingiz tasdiqlandi!\n+" + p.amount.toLocaleString("ru-RU").replace(/,/g, " ") +
            " so'm balansingizga qo'shildi.\nJoriy balans: " + balance.toLocaleString("ru-RU").replace(/,/g, " ") + " so'm");
        }
        logSms(entry);
      } catch (e) {}
    });
  }

  if (url === "/api/admin/sms-log" && m === "GET") {
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set" });
    const a = auth(req);
    if (!isAdm(a)) return send(res, 403, { error: "not admin" });
    return send(res, 200, DB.smsLog.slice().reverse());
  }

  /* everything else → app */
  fs.readFile(HTML_FILE, (err, data) => {
    if (err) return send(res, 500, "verion-shop.html not found", "text/plain");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Verion Shop v3 on " + PORT + " | data: " + DATA_DIR + " | BOT_TOKEN " + (BOT_TOKEN ? "set" : "MISSING"));
});
