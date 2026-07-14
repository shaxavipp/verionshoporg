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
const DB_FILE = path.join(DATA_DIR, "db.json");

/* ---------- tiny db ---------- */
let DB = { users: {}, payments: [], orders: [], smsLog: [], stock: {} };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) {}
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => {
  fs.writeFile(DB_FILE, JSON.stringify(DB), err => {
    if (err) alertAdmin("db_save", "Ma'lumotlar bazasiga yozib bo'lmadi (balans/buyurtma yo'qolishi mumkin!)\n" + String(err));
  }); }, 100); }
function user(u) {
  const k = String(u.id);
  if (!DB.users[k]) DB.users[k] = { balance: 0, ts: Date.now() };
  DB.users[k].uname = u.username || DB.users[k].uname || null;
  DB.users[k].name = ((u.first_name || "") + " " + (u.last_name || "")).trim() || DB.users[k].name;
  return DB.users[k];
}
function genId(p) {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return p + "-" + s;
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
/* ---------- adminlarga avtomatik xatolik xabari ---------- */
// Har bir "key" uchun kamida 5 daqiqa oralig'ida bittadan yuboriladi — bitta xato ketma-ket
// yuz bergani uchun adminni xabar bilan "bombardimon" qilmaslik uchun (masalan Fragment API vaqtincha ishlamasa).
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
const alertedAt = {};
function alertAdmin(key, text) {
  const now = Date.now();
  if (alertedAt[key] && now - alertedAt[key] < ALERT_THROTTLE_MS) return;
  alertedAt[key] = now;
  console.error("[ALERT:" + key + "] " + text);
  const full = "\u26A0\uFE0F Verion Shop — xatolik\n\n" + text;
  for (const id of ADMIN_IDS) tgSend(id, full);
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
    return JSON.parse(params.get("user") || "null");
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
function myView(uid) {
  expireOld();
  const mine = x => x.uid === uid;
  return {
    balance: (DB.users[String(uid)] || { balance: 0 }).balance,
    payments: DB.payments.filter(mine).slice(-50).reverse(),
    orders: DB.orders.filter(mine).slice(-50).reverse()
  };
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
 try {
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

  /* ----- user endpoints (need valid Telegram signature) ----- */
  if (url === "/api/stock-counts" && m === "GET") {
    const out = {};
    for (const k in DB.stock) out[k] = (DB.stock[k] || []).length;
    return send(res, 200, out);
  }
  if (url === "/api/me" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: "auth" });
    user(u); save();
    return send(res, 200, myView(u.id));
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
          alertAdmin("fragment_api", "Fragment orqali Stars yuborib bo'lmadi (uid " + u.id + ", " + amount + " Stars @" + uname + "):\n" + msg);
          return send(res, 502, { error: "fragment_failed", message: msg });
        }
        acc.balance -= price;
        const summary = "⭐ " + amount + " Stars @" + uname + " ga yuborildi";
        const o = { id: genId("VN"), uid: u.id, uname: u.username || null, itemId: it.id,
          item: "Telegram Stars (" + amount + ")", price, status: "done", ts: Date.now(),
          delivered: summary, doneTs: Date.now(), fragment: j.result || null };
        DB.orders.push(o); save();
        send(res, 200, { ok: true, order: o, balance: acc.balance });
      }).catch(e => {
        alertAdmin("fragment_api", "Fragment API bilan bog'lanib bo'lmadi (Stars, uid " + u.id + "):\n" + String(e.message || e));
        send(res, 502, { error: "fragment_failed", message: String(e.message || e) });
      });
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
            alertAdmin("fragment_api", "Fragment orqali " + (isStars ? "Stars" : "Premium") + " yuborib bo'lmadi (uid " + u.id + ", @" + u.username + "):\n" + msg);
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
          send(res, 200, { ok: true, order: o, balance: acc.balance });
        }).catch(e => {
          alertAdmin("fragment_api", "Fragment API bilan bog'lanib bo'lmadi (" + (isStars ? "Stars" : "Premium") + ", uid " + u.id + "):\n" + String(e.message || e));
          send(res, 502, { error: "fragment_failed", message: String(e.message || e) });
        });
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
        if (b.action === "done") { o.status = "done"; o.doneTs = Date.now(); }
        else { o.status = "cancelled"; // refund
          const acc = DB.users[String(o.uid)] || (DB.users[String(o.uid)] = { balance: 0 });
          acc.balance += o.price; }
        save(); return send(res, 200, { ok: true });
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
      const users = Object.keys(DB.users).length;
      const totalBalance = Object.values(DB.users).reduce((s, v) => s + (v.balance || 0), 0);
      const doneOrders = DB.orders.filter(o => o.status === "done");
      const revenue = doneOrders.reduce((s, o) => s + (o.price || 0), 0);
      const donePays = DB.payments.filter(p => p.status === "done");
      const topupSum = donePays.reduce((s, p) => s + (p.amount || 0), 0);
      const today0 = new Date(); today0.setHours(0, 0, 0, 0);
      const todayOrders = doneOrders.filter(o => o.ts >= today0.getTime()).length;
      const todayTopup = donePays.filter(p => p.ts >= today0.getTime()).reduce((s, p) => s + (p.amount || 0), 0);
      return send(res, 200, {
        users, totalBalance, ordersCount: doneOrders.length, revenue,
        topupSum, pendingPayments: DB.payments.filter(p => p.status === "waiting" || p.status === "checking").length,
        todayOrders, todayTopup
      });
    }
    if (url === "/api/admin/users" && m === "GET") {
      const sortBy = q.get("sort") || "recent"; // recent | balance
      let list = Object.keys(DB.users).map(k => ({ uid: Number(k), uname: DB.users[k].uname,
        name: DB.users[k].name, balance: DB.users[k].balance || 0, ts: DB.users[k].ts || 0 }));
      list.sort((a, b) => sortBy === "balance" ? b.balance - a.balance : b.ts - a.ts);
      return send(res, 200, list.slice(0, 60));
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

  /* ----- Telegram webhook: humocard/cardxabar guruhidagi SMS xabarlarni tinglash ----- */
  if (url === "/api/tg-webhook" && m === "POST") {
    // Telegram setWebhook'da berilgan secret_token shu yerga header sifatida keladi — soxta so'rovlarni blok qiladi
    // MUHIM: agar TG_WEBHOOK_SECRET sozlanmagan bo'lsa ham endpoint YOPIQ turishi kerak (fail-closed),
    // aks holda har kim soxta "to'lov SMS"i yuborib, balansni bepul to'ldirib olishi mumkin edi.
    if (!TG_WEBHOOK_SECRET || req.headers["x-telegram-bot-api-secret-token"] !== TG_WEBHOOK_SECRET)
      return send(res, 401, { error: "bad secret" });
    return readBody(req, res, upd => {
      send(res, 200, { ok: true }); // Telegram'ga darhol javob (u tezkor ACK kutadi)
      try {
        // Guruhdan: upd.message / upd.channel_post. Telegram Business orqali shaxsiy chatdan: upd.business_message
        const msg = upd.message || upd.channel_post || upd.business_message;
        if (!msg || !msg.text) return;
        const isBusiness = !!upd.business_message;
        const uname = ((msg.from && msg.from.username) || "").toLowerCase();

        if (isBusiness) {
          // Business rejimida bitta umumiy guruh yo'q — har bir kontakt alohida chat.
          // Shu sabab chat_id bo'yicha emas, faqat yuboruvchi bot nomi (SMS_BOT_USERNAMES) bo'yicha filtrlaymiz.
          if (!SMS_BOT_USERNAMES.length || SMS_BOT_USERNAMES.indexOf(uname) === -1) return;
        } else {
          const chatId = String(msg.chat && msg.chat.id);
          if (SMS_SOURCE_CHAT_ID && chatId !== String(SMS_SOURCE_CHAT_ID)) return;
          if (SMS_BOT_USERNAMES.length && SMS_BOT_USERNAMES.indexOf(uname) === -1) return;
        }

        const amount = parseAmount(msg.text);
        expireOld();
        const candidates = amount == null ? [] :
          DB.payments.filter(p => (p.status === "waiting" || p.status === "checking") && p.pay === amount);

        const entry = { ts: Date.now(), from: uname || null, text: msg.text.slice(0, 300),
          parsedAmount: amount, matched: false, paymentId: null };

        if (candidates.length === 1) {
          const p = candidates[0];
          const balance = confirmPayment(p, "sms");
          entry.matched = true; entry.paymentId = p.id;
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
 } catch (e) {
  // Kutilmagan xato — mijozga tushunarli javob, adminga darhol Telegram xabari
  alertAdmin("http_" + ((req.url || "").split("?")[0]),
    "So'rovda kutilmagan xato:\n" + req.method + " " + req.url + "\n" + String((e && e.stack) || e));
  try { if (!res.headersSent) send(res, 500, { error: "server" }); } catch (e2) {}
 }
});

process.on("uncaughtException", e => {
  alertAdmin("uncaught_exception", "Serverda kutilmagan (uncaught) xato:\n" + String((e && e.stack) || e));
});
process.on("unhandledRejection", e => {
  alertAdmin("unhandled_rejection", "Serverda ushlanmagan Promise xatosi:\n" + String((e && e.stack) || e));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Verion Shop v3 on " + PORT + " | data: " + DATA_DIR + " | BOT_TOKEN " + (BOT_TOKEN ? "set" : "MISSING"));
});
