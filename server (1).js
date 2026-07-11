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
let DB = { users: {}, payments: [], orders: [], smsLog: [] };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) {}
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => {
  fs.writeFile(DB_FILE, JSON.stringify(DB), () => {}); }, 100); }
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
      if (acc.balance < price) return send(res, 402, { error: "balance", need: price - acc.balance });
      acc.balance -= price;
      const title = typeof it.title === "string" ? it.title : (it.title.uz || it.title.en || "");
      const o = { id: genId("VN"), uid: u.id, uname: u.username || null, itemId: it.id,
        item: title, price, status: "pending", ts: Date.now() };
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
        orders: DB.orders.filter(o => o.status === "pending").reverse()
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
    if (url === "/api/admin/user" && m === "GET") {
      const s = (q.get("q") || "").trim().toLowerCase().replace(/^@/, "");
      if (!s) return send(res, 400, { error: "q" });
      const out = [];
      for (const k in DB.users) {
        const v = DB.users[k];
        if (k === s || (v.uname && v.uname.toLowerCase().indexOf(s) !== -1) ||
            (v.name && v.name.toLowerCase().indexOf(s) !== -1))
          out.push({ uid: Number(k), uname: v.uname, name: v.name, balance: v.balance });
        if (out.length >= 10) break;
      }
      return send(res, 200, out);
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
  if (url === "/api/sms-webhook" && m === "POST") {
    if (!TG_WEBHOOK_SECRET || req.headers["x-sms-secret"] !== TG_WEBHOOK_SECRET)
      return send(res, 401, { error: "bad secret" });
    return readBody(req, res, b => {
      send(res, 200, { ok: true });
      try {
        const text = String((b && b.text) || "").slice(0, 500);
        const fromUser = String((b && b.from) || "").toLowerCase().replace(/^@/, "");
        if (!text) return;
        if (SMS_BOT_USERNAMES.length && SMS_BOT_USERNAMES.indexOf(fromUser) === -1) return;

        const amount = parseAmount(text);
        expireOld();
        const candidates = amount == null ? [] :
          DB.payments.filter(p => (p.status === "waiting" || p.status === "checking") && p.pay === amount);

        const entry = { ts: Date.now(), from: fromUser || null, text, parsedAmount: amount,
          matched: false, paymentId: null };

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

  /* ----- Telegram webhook: humocard/cardxabar guruhidagi SMS xabarlarni tinglash ----- */
  if (url === "/api/tg-webhook" && m === "POST") {
    // Telegram setWebhook'da berilgan secret_token shu yerga header sifatida keladi — soxta so'rovlarni blok qiladi
    if (TG_WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== TG_WEBHOOK_SECRET)
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
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Verion Shop v3 on " + PORT + " | data: " + DATA_DIR + " | BOT_TOKEN " + (BOT_TOKEN ? "set" : "MISSING"));
});
