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
  return { users, orders, payments, reviews, stock, settings, orderSeq, smsLog, notifState };
}

function saveState(db, DB) {
  withTx(db, () => {
    db.exec("DELETE FROM users");
    const uStmt = db.prepare("INSERT INTO users (id, data) VALUES (?, ?)");
    for (const k in DB.users) uStmt.run(k, JSON.stringify(DB.users[k]));

    db.exec("DELETE FROM orders");
    const oStmt = db.prepare("INSERT INTO orders (id, uid, status, seq, ts, data) VALUES (?, ?, ?, ?, ?, ?)");
    for (const o of DB.orders) {
      oStmt.run(String(o.id), String(o.uid != null ? o.uid : ""), o.status || null,
        o.seq || null, o.ts || null, JSON.stringify(o));
    }

    db.exec("DELETE FROM payments");
    const pStmt = db.prepare("INSERT INTO payments (id, uid, status, ts, data) VALUES (?, ?, ?, ?, ?)");
    for (const p of DB.payments) {
      pStmt.run(String(p.id), String(p.uid != null ? p.uid : ""), p.status || null, p.ts || null, JSON.stringify(p));
    }

    db.exec("DELETE FROM reviews");
    const rStmt = db.prepare("INSERT INTO reviews (id, order_id, uid, data) VALUES (?, ?, ?, ?)");
    for (const r of DB.reviews) rStmt.run(String(r.id), r.orderId || null, String(r.uid != null ? r.uid : ""), JSON.stringify(r));

    db.exec("DELETE FROM stock");
    const sStmt = db.prepare("INSERT INTO stock (item_id, data) VALUES (?, ?)");
    for (const k in DB.stock) sStmt.run(k, JSON.stringify(DB.stock[k] || []));

    db.exec("DELETE FROM settings");
    const setStmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const k in DB.settings) setStmt.run(k, JSON.stringify(DB.settings[k]));

    db.prepare("INSERT INTO kv (key, value) VALUES ('orderSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(DB.orderSeq || 0));
    db.prepare("INSERT INTO kv (key, value) VALUES ('smsLog', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(DB.smsLog || []));
    db.prepare("INSERT INTO kv (key, value) VALUES ('notifState', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(DB.notifState || {}));
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
