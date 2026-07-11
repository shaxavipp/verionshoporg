// Verion Shop server v3 — static app + catalog + balances/payments/orders. No dependencies.
const http = require("http");
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

let DATA_DIR = process.env.DATA_DIR || "/data";
try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) { DATA_DIR = path.join(__dirname, "data"); fs.mkdirSync(DATA_DIR, { recursive: true }); }
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");
const DB_FILE = path.join(DATA_DIR, "db.json");

/* ---------- tiny db ---------- */
let DB = { users: {}, payments: [], orders: [] };
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
          p.status = "done"; p.doneTs = Date.now();
          const acc = DB.users[String(p.uid)] || (DB.users[String(p.uid)] = { balance: 0 });
          acc.balance += p.amount;
          save(); return send(res, 200, { ok: true, balance: acc.balance });
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
