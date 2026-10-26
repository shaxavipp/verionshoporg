// db.js — SQLite (data/shop.db) asosidagi saqlash qatlami.
// TZ band 1: catalog.json/db.json kabi butun-fayl JSON'lar o'rniga tranzaksion SQLite.
//
// Node.js'ning o'zida mavjud (tashqi kutubxona shart emas — loyihaning "no dependencies"
// tamoyiliga mos) sinxron `node:sqlite` moduli ishlatiladi. Bu TZ'dagi "better-sqlite3
// (yoki shunga o'xshash sinxron kutubxona)" talabini to'liq qondiradi va Railway'da
// native modul qurish (node-gyp) bilan bog'liq muammolarni butunlay oldini oladi.
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

function openDb(dataDir) {
  const file = path.join(dataDir, "shop.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      uid TEXT,
      status TEXT,
      seq INTEGER,
      ts INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_uid ON orders(uid);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      uid TEXT,
      status TEXT,
      ts INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payments_uid ON payments(uid);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock (
      item_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      uid TEXT,
      data TEXT NOT NULL
    );
    -- Kichik/yordamchi ma'lumotlar (katalog metadatasi, ui-emoji, nakrutka rasm meta,
    -- sms jurnali, buyurtma ketma-ket raqami, bildirishnoma holati) — alohida jadval
    -- ochish shart bo'lmagan kalit-qiymat yozuvlar uchun.
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

// ---------- tranzaksion yordamchi ----------
function withTx(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (e2) {}
    throw e;
  }
}

// ---------- katalog (products) ----------
function loadCatalog(db) {
  const rows = db.prepare("SELECT id, data FROM products ORDER BY position ASC").all();
  if (!rows.length) return null;
  return rows.map(r => JSON.parse(r.data));
}
function saveCatalog(db, arr) {
  withTx(db, () => {
    db.exec("DELETE FROM products");
    const stmt = db.prepare("INSERT INTO products (id, position, data) VALUES (?, ?, ?)");
    arr.forEach((item, i) => {
      const id = String(item.id != null ? item.id : i);
      stmt.run(id, i, JSON.stringify(item));
    });
  });
}

// ---------- kv-asoslangan kichik obyektlar (catmeta, uiemoji, nkcatmeta) ----------
function kvGet(db, key, fallback) {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}
function kvSet(db, key, value) {
  withTx(db, () => {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  });
}

// ---------- asosiy DB (users/orders/payments/stock/reviews/settings) ----------
// Butun ilova xotirada bitta DB obyekti bilan ishlashda davom etadi (mavjud kod bazasiga
// tegmaslik uchun) — bu funksiyalar shu obyektni SQLite'dan to'liq o'qiydi / SQLite'ga
// to'liq (tranzaksiya ichida) yozadi. Xotiradagi o'qish/o'zgartirish tezligi o'zgarmaydi,
// faqat diskka yozish endi bitta yarim yozilgan faylni emas, izchil jadvallarni beradi.
function loadState(db) {
  const users = {};
  for (const row of db.prepare("SELECT id, data FROM users").all()) {
    users[row.id] = JSON.parse(row.data);
  }
  const orders = db.prepare("SELECT data FROM orders ORDER BY ts ASC").all().map(r => JSON.parse(r.data));
  const payments = db.prepare("SELECT data FROM payments ORDER BY ts ASC").all().map(r => JSON.parse(r.data));
  const reviews = db.prepare("SELECT data FROM reviews").all().map(r => JSON.parse(r.data));
  const stock = {};
  for (const row of db.prepare("SELECT item_id, data FROM stock").all()) {
    stock[row.item_id] = JSON.parse(row.data);
  }
  const settings = {};
  for (const row of db.prepare("SELECT key, value FROM settings").all()) {
    settings[row.key] = JSON.parse(row.value);
  }
  const orderSeq = kvGet(db, "orderSeq", 0);
  const smsLog = kvGet(db, "smsLog", []);
  const notifState = kvGet(db, "notifState", {});
  // Promo-kodlar va avtomatlashtirish sozlamalari — DB.settings ichida emas, alohida
  // top-level maydonlar bo'lgani uchun (server.js'da shunday ishlatiladi) kv jadvalida
  // o'z kalitlari bilan saqlanadi — xuddi smsLog/notifState kabi.
  const promoCodes = kvGet(db, "promoCodes", {});
  const automation = kvGet(db, "automation", {});
  return { users, orders, payments, reviews, stock, settings, orderSeq, smsLog, notifState, promoCodes, automation };
}

// ---------- generic incremental sync yordamchilari ----------
// To'liq "DELETE FROM X; INSERT INTO X ..." o'rniga: faqat endi mavjud bo'lmagan
// qatorlarni o'chiradi va qolganlarini UPSERT (INSERT ... ON CONFLICT DO UPDATE)
// qiladi. Natija (loadState() qaytaradigan ma'lumot) avvalgidek bir xil,
// faqat har save() chaqirilganda butun jadval qayta yozilmaydi —
// buyurtmalar/to'lovlar soni ko'paygani sari yozish tezligi doimiy (o(o'zgarish),
// avvalgidek o(jami yozuv soni) emas) bo'lib qoladi.
function syncKeyedDelete(db, tableName, idCol, currentIds) {
  const existing = db.prepare(`SELECT ${idCol} AS id FROM ${tableName}`).all();
  if (!existing.length) return;
  const keep = currentIds instanceof Set ? currentIds : new Set(currentIds);
  const del = db.prepare(`DELETE FROM ${tableName} WHERE ${idCol} = ?`);
  for (const row of existing) {
    if (!keep.has(String(row.id))) del.run(row.id);
  }
}

// ---------- asosiy DB'ni yozish: faqat O'ZGARGAN qatorlar ----------
// Har jadval uchun oxirgi yozilgan JSON matni xotirada saqlanadi (db obyektiga bog'langan).
// saveState() har qatorni matnga aylantirib solishtiradi va faqat farq qilganini yozadi,
// yo'qolganini o'chiradi — bazadan "hammasini o'qib solishtirish" ham, hammasini qayta
// yozish ham yo'q. 10k foydalanuvchi / 50k buyurtmada bitta saqlash ~0,6 s dan bir necha
// o'n millisekundga tushadi (o'lchov: scratchpad bench-db.js).
const CACHE = new WeakMap();
function cacheOf(db) {
  let c = CACHE.get(db);
  if (!c) {
    c = { users: new Map(), orders: new Map(), payments: new Map(), reviews: new Map(), stock: new Map(), settings: new Map(), kv: new Map(), primed: false };
    c.orders.st = new Map(); c.payments.st = new Map();   // oxirgi yozilgan status (tez yo'l uchun)
    CACHE.set(db, c);
  }
  return c;
}
// Bazada hozir bor matnlar bilan keshni to'ldiradi (ishga tushgandan keyingi birinchi saqlashda).
function prime(db, c) {
  const fill = (m, sql) => { for (const r of db.prepare(sql).all()) m.set(String(r.k), r.v); };
  fill(c.users, "SELECT id AS k, data AS v FROM users");
  fill(c.orders, "SELECT id AS k, data AS v FROM orders");
  fill(c.payments, "SELECT id AS k, data AS v FROM payments");
  fill(c.reviews, "SELECT id AS k, data AS v FROM reviews");
  fill(c.stock, "SELECT item_id AS k, data AS v FROM stock");
  fill(c.settings, "SELECT key AS k, value AS v FROM settings");
  for (const r of db.prepare("SELECT id, status FROM orders").all()) c.orders.st.set(String(r.id), r.status);
  for (const r of db.prepare("SELECT id, status FROM payments").all()) c.payments.st.set(String(r.id), r.status);
  fill(c.kv, "SELECT key AS k, value AS v FROM kv WHERE key IN ('orderSeq','smsLog','notifState','promoCodes','automation')");
  c.primed = true;
}
// rows: [id, value, argsFn] ro'yxatini beruvchi iterator; skip(v) — "eski, yopilgan" qator:
// keshda bo'lsa matnga aylantirilmaydi (tez yo'l). To'liq tekshiruv (full) hammasini solishtiradi.
function syncTable(db, cache, list, idOf, argsOf, upsert, delSql, skip, full) {
  let ups = null, n = 0, hits = 0;
  const ids = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const v = list[i], id = idOf(v, i);
    ids[i] = id;
    const old = cache.get(id);
    if (old !== undefined) hits++;
    if (old !== undefined && !full && skip && skip(v) && cache.st.get(id) === v.status) continue;
    const txt = JSON.stringify(v);
    if (skip) cache.st.set(id, v && v.status);
    if (old === txt) continue;
    if (!ups) ups = db.prepare(upsert);
    ups.run(...argsOf(id, v, txt));
    cache.set(id, txt); n++;
  }
  // Hamma kesh kalitlari ro'yxatda bo'lsa — o'chirilgan qator yo'q (Set qurish shart emas).
  if (hits !== cache.size) {
    const seen = new Set(ids), del = db.prepare(delSql);
    for (const id of [...cache.keys()]) if (!seen.has(id)) { del.run(id); cache.delete(id); if (cache.st) cache.st.delete(id); n++; }
  }
  return n;
}
const OLD_MS = 60 * 60 * 1000;
const CLOSED = { done: 1, cancelled: 1, canceled: 1, refunded: 1, ok: 1, paid: 1, rejected: 1, failed: 1, expired: 1 };
function saveState(db, DB, opts) {
  const c = cacheOf(db), full = !!(opts && opts.full), now = Date.now();
  const oldClosed = x => x && CLOSED[x.status] === 1 && Number(x.ts) > 0 && now - Number(x.ts) > OLD_MS;
  return withTx(db, () => {
    if (!c.primed) prime(db, c);
    let n = 0;
    const uKeys = Object.keys(DB.users || {});
    n += syncTable(db, c.users, uKeys.map(k => DB.users[k]), (v, i) => uKeys[i], (id, v, t) => [id, t],
      "INSERT INTO users (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", "DELETE FROM users WHERE id = ?", null, full);
    n += syncTable(db, c.orders, DB.orders || [], v => String(v.id),
      (id, o, t) => [id, String(o.uid != null ? o.uid : ""), o.status || null, o.seq || null, o.ts || null, t],
      "INSERT INTO orders (id, uid, status, seq, ts, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET uid = excluded.uid, status = excluded.status, seq = excluded.seq, ts = excluded.ts, data = excluded.data",
      "DELETE FROM orders WHERE id = ?", oldClosed, full);
    n += syncTable(db, c.payments, DB.payments || [], v => String(v.id),
      (id, p, t) => [id, String(p.uid != null ? p.uid : ""), p.status || null, p.ts || null, t],
      "INSERT INTO payments (id, uid, status, ts, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET uid = excluded.uid, status = excluded.status, ts = excluded.ts, data = excluded.data",
      "DELETE FROM payments WHERE id = ?", oldClosed, full);
    n += syncTable(db, c.reviews, DB.reviews || [], v => String(v.id),
      (id, x, t) => [id, x.orderId || null, String(x.uid != null ? x.uid : ""), t],
      "INSERT INTO reviews (id, order_id, uid, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET order_id = excluded.order_id, uid = excluded.uid, data = excluded.data",
      "DELETE FROM reviews WHERE id = ?", null, full);
    const sKeys = Object.keys(DB.stock || {});
    n += syncTable(db, c.stock, sKeys.map(k => DB.stock[k] || []), (v, i) => sKeys[i], (id, v, t) => [id, t],
      "INSERT INTO stock (item_id, data) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET data = excluded.data", "DELETE FROM stock WHERE item_id = ?", null, full);
    const gKeys = Object.keys(DB.settings || {});
    n += syncTable(db, c.settings, gKeys.map(k => DB.settings[k]), (v, i) => gKeys[i], (id, v, t) => [id, t],
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "DELETE FROM settings WHERE key = ?", null, full);
    // kv: bu kalitlar hech qachon o'chirilmaydi.
    const kvVals = { orderSeq: DB.orderSeq || 0, smsLog: DB.smsLog || [], notifState: DB.notifState || {}, promoCodes: DB.promoCodes || {}, automation: DB.automation || {} };
    let kvUp = null;
    for (const k in kvVals) {
      const t = JSON.stringify(kvVals[k]);
      if (c.kv.get(k) !== t) { (kvUp || (kvUp = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"))).run(k, t); c.kv.set(k, t); n++; }
    }
    return n;
  });
}

// ---------- eski JSON fayllardan bir martalik migratsiya ----------
// data/{catalog,catmeta,uiemoji,nkcatmeta,db}.json fayllari mavjud bo'lsa o'qib,
// SQLite jadvallariga ko'chiradi. Fayllar o'zi O'CHIRILMAYDI (xavfsizlik uchun —
// muvaffaqiyatli migratsiyadan keyin ular endi o'qilmaydi, qo'lda arxivlab qo'yish tavsiya etiladi).
function migrateFromJsonIfNeeded(db, dataDir) {
  const already = db.prepare("SELECT COUNT(*) AS c FROM users").get().c
    + db.prepare("SELECT COUNT(*) AS c FROM products").get().c
    + db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
  if (already > 0) return { migrated: false };

  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8")); }
    catch (e) { return null; }
  };
  const catalog = readJson("catalog.json");
  const catmeta = readJson("catmeta.json");
  const uiemoji = readJson("uiemoji.json");
  const nkcatmeta = readJson("nkcatmeta.json");
  const dbJson = readJson("db.json");

  if (!catalog && !dbJson && !catmeta && !uiemoji && !nkcatmeta) return { migrated: false };

  if (Array.isArray(catalog) && catalog.length) saveCatalog(db, catalog);
  if (catmeta) kvSet(db, "catmeta", catmeta);
  if (uiemoji) kvSet(db, "uiemoji", uiemoji);
  if (nkcatmeta) kvSet(db, "nkcatmeta", nkcatmeta);
  if (dbJson) {
    const DB = Object.assign({
      users: {}, payments: [], orders: [], smsLog: [], stock: {}, reviews: [], orderSeq: 0,
      settings: { referral: { enabled: true, percent: 1, shareText: "" } }
    }, dbJson);
    saveState(db, DB);
  }
  return { migrated: true, hadCatalog: !!catalog, hadDb: !!dbJson };
}

module.exports = { openDb, loadCatalog, saveCatalog, kvGet, kvSet, loadState, saveState, migrateFromJsonIfNeeded, withTx };
