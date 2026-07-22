// migrate.js — bir martalik migratsiya: data/*.json fayllarni data/shop.db (SQLite) ga ko'chiradi.
// Ishlatish: node migrate.js
// (Server o'zi ham birinchi marta ishga tushganda shu tekshiruvni avtomatik bajaradi —
// bu skript qo'lda ishga tushirish yoki CI/deploy bosqichida oldindan migratsiya qilish uchun.)
"use strict";
const path = require("path");
const { openDb, migrateFromJsonIfNeeded } = require("./db.js");

let DATA_DIR = process.env.DATA_DIR || "/data";
try {
  require("fs").mkdirSync(DATA_DIR, { recursive: true });
  require("fs").accessSync(DATA_DIR, require("fs").constants.W_OK);
} catch (e) {
  DATA_DIR = path.join(__dirname, "data");
  require("fs").mkdirSync(DATA_DIR, { recursive: true });
}

console.log("[migrate] DATA_DIR = " + DATA_DIR);
const db = openDb(DATA_DIR);
const result = migrateFromJsonIfNeeded(db, DATA_DIR);
if (result.migrated) {
  console.log("[migrate] Muvaffaqiyatli: JSON fayllardan data/shop.db ga ko'chirildi.");
  console.log("[migrate]  - catalog.json ko'chirildi: " + (result.hadCatalog ? "ha" : "yo'q"));
  console.log("[migrate]  - db.json ko'chirildi: " + (result.hadDb ? "ha" : "yo'q"));
} else {
  console.log("[migrate] Hech narsa qilinmadi — data/shop.db allaqachon to'ldirilgan yoki eski JSON fayllar topilmadi.");
}
db.close();
