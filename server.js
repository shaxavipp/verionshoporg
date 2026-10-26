// Verion Shop server v3 — static app + catalog + balances/payments/orders. No dependencies.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const sdb = require("./db.js");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "5606872249,8684274899")
  .split(",").map(s => Number(s.trim())).filter(Boolean);
/* Deploy belgisi — Railway rostdan yangi kodni ko'tardimi yoki eski build turibdimi,
   shuni ko'rish uchun. Profil ekranida ID ostida ko'rinadi (server/ilova alohida).
   Kod o'zgarganda shu satrni yangilab qo'yiladi. */
const BUILD = "2026-10-27.1";
// Har ishga tushishda yangi tasodifiy belgi — /api/health orqali "bu manzil aynan
// SHU serverga olib keladimi" tekshiruvi uchun (maxfiy emas).
const INSTANCE_ID = crypto.randomBytes(8).toString("hex");
// Alohida admin bot (adminbot.js). var — ishga tushishdan oldin chaqirilsa ham xato bermasin.
var ADMINBOT = null;
const MAX_BODY = 10 * 1024 * 1024;
const HTML_FILE = path.join(__dirname, "verion-shop.html");
/* ---------- Xabar yuboriladigan kanallar (buyurtma / to'lov / yetkazilgan) ----------
   Uch xil xabar — uch xil kanal. Ilgari faqat Railway "Variables"dan o'qilardi va
   birini o'zgartirish uchun har safar qayta deploy kerak bo'lardi; bundan tashqari
   bo'sh qolgan o'zgaruvchi jimgina buyurtma kanaliga tushib, buyurtmalar bilan
   to'lovlar bitta kanalda aralashib ketardi.

   Endi manba ikkita: quyidagi env qiymatlari faqat STANDART (birinchi ishga tushish)
   qiymati bo'lib qoladi, ustidan admin panel → "Kanallar (chat_id)" bo'limida
   kiritilgan qiymat ishlaydi (DB.settings.channels). Ya'ni buyurtmani boshqa kanalga
   ko'chirish uchun deploy ham, Railway ham kerak emas. */
const ENV_ORDER_CHAT_ID = process.env.ORDER_NOTIFY_CHAT_ID || "";
const ENV_TOPUP_CHAT_ID = process.env.TOPUP_NOTIFY_CHAT_ID || "";
const ENV_DELIVERY_CHAT_ID = process.env.DELIVERY_LOG_CHAT_ID || "";
// Ilovaning tashqi manzili (https://...). Railway o'zi RAILWAY_PUBLIC_DOMAIN beradi,
// shu sabab odatda hech narsa sozlash shart emas — bot webhook'i ham, "Ilovani ochish"
// tugmasi ham shu manzildan quriladi.
const PUBLIC_URL = String(
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "")
).trim().replace(/\/+$/, "");
const BANNER_FILE = path.join(__dirname, "assets", "start-banner.png");
// Yordam (support) akkaunti — /start xabaridagi "Yordam" tugmasi uchun.
// Ilovadagi SUPPORT_USERNAME bilan bir xil bo'lishi kerak.
const SUPPORT_USERNAME = String(process.env.SUPPORT_USERNAME || "verionshop_support").replace(/^@/, "");
const TOPUP_TTL = 7 * 60 * 1000;           // payment window: 7 minutes
const PAYMENT_REMINDER_DELAY = 4 * 60 * 1000; // 4 daqiqadan keyin ham to'lanmagan bo'lsa eslatma yuboriladi
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
// Premium (Telegram) emoji fayllari (video/rasm/lottie-json) endi base64 sifatida katalogga
// emas, shu papkaga diskka saqlanadi — katalog faqat qisqa URL saqlaydi, ilova tezroq yuklanadi.
const PREMIUM_EMOJI_DIR = path.join(DATA_DIR, "premium-emoji");
try { fs.mkdirSync(PREMIUM_EMOJI_DIR, { recursive: true }); } catch (e) {}
// Har kunlik avtomatik zaxira nusxalar (.tar.gz) shu yerga yoziladi va admin botga yuboriladi.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
const BACKUP_KEEP = 7; // oxirgi N kunlik zaxira saqlanadi, qolgani avtomatik o'chiriladi

/* ---------- SQLite (data/shop.db) — TZ band 1 ----------
   Barcha doimiy ma'lumot (mahsulotlar, buyurtmalar, to'lovlar, foydalanuvchilar,
   sozlamalar, stock, sharhlar) endi tranzaksion SQLite jadvallarida saqlanadi — oddiy
   JSON fayllarni to'liq qayta yozish (va shu bilan bog'liq ma'lumot yo'qolish xavfi)
   endi yo'q. Eski data/*.json fayllar topilsa, birinchi ishga tushishda avtomatik
   (bir martalik) SQLite'ga ko'chiriladi — xuddi shu narsani `node migrate.js` orqali
   qo'lda ham bajarish mumkin. */
const SQLITE_DB = sdb.openDb(DATA_DIR);
sdb.migrateFromJsonIfNeeded(SQLITE_DB, DATA_DIR);

/* ---------- tiny db ----------
   Ilova hamon xotiradagi bitta DB obyekti bilan ishlaydi (tezlik va mavjud kodga
   ishlov berish qulayligi uchun) — save() endi shu obyektni SQLite jadvallariga
   BEGIN/COMMIT tranzaksiyasi ichida to'liq yozadi. */
let DB = { users: {}, payments: [], orders: [], smsLog: [], stock: {}, reviews: [], orderSeq: 0,
  notifState: {}, settings: { referral: { enabled: true, percent: 1, shareText: "" } } };
try { DB = Object.assign(DB, sdb.loadState(SQLITE_DB)); } catch (e) { console.log("[db] loadState xato: " + e.message); }
// Ketma-ket buyurtma raqami (#56, #57, #58...) — birinchi ishga tushishda mavjud
// buyurtmalar sonidan davom etadi, keyin har doim shundan +1 bo'lib boradi (hech qachon orqaga qaytmaydi).
if (!DB.orderSeq) DB.orderSeq = DB.orders.length;
if (!DB.settings) DB.settings = {};
if (!DB.settings.referral) DB.settings.referral = { enabled: true, percent: 1, shareText: "" };
if (DB.settings.referral.percent === undefined) {
  // eski (bir martalik bonus) sozlamadan yangi (har xariddan foiz) sozlamaga o'tish
  DB.settings.referral = { enabled: DB.settings.referral.enabled !== false, percent: 1, shareText: DB.settings.referral.shareText || "" };
}
if (DB.settings.referral.shareText === undefined) DB.settings.referral.shareText = "";
// Nakrutka (SMM/JAP) sozlamalari: kurs va ustama admin panelidan boshqariladi,
// yashirilgan xizmatlar ro'yxati ham shu yerda saqlanadi.
if (!DB.settings.nakrutka) DB.settings.nakrutka = { usdRate: null, markupPercent: 0, hiddenServices: [] };
if (!Array.isArray(DB.settings.nakrutka.hiddenServices)) DB.settings.nakrutka.hiddenServices = [];
// Kanal chat_id'lari (buyurtma / to'lov / yetkazilgan nusxasi). Birinchi ishga tushishda
// env qiymatlaridan olinadi, keyin admin panelidan o'zgartiriladi — env endi tegmaydi.
// Ko'chirish paytida avvalgi xatti-harakat aynan saqlanadi: ilgari TOPUP_NOTIFY_CHAT_ID
// bo'sh bo'lsa to'lovlar buyurtma kanaliga tushardi, shu sabab shu bir marta o'sha
// qiymat ko'chiriladi — aks holda yangilanishdan keyin to'lovlar kanali "yo'qolib"
// qolgandek bo'lardi. Keyin admin ularni bemalol ajratadi.
if (!DB.settings.channels) DB.settings.channels = {
  order: ENV_ORDER_CHAT_ID,
  topup: ENV_TOPUP_CHAT_ID || ENV_ORDER_CHAT_ID,
  delivery: ENV_DELIVERY_CHAT_ID
};
// Bot /start xabari va "start bosmagan ilovaga kirmasin" to'sig'i.
// greeting — bo'sh bo'lsa standart matn ishlatiladi; {name}/{username}/{id} o'rniga
// qiymat qo'yiladi. bannerFileId — Telegram qaytargan file_id keshi: banner rasm
// serverdan faqat BIR marta yuklanadi, keyingi barcha /start larda file_id yuboriladi.
if (!DB.settings.bot) DB.settings.bot = {
  greeting: "", channelUrl: "", guideUrl: "", gate: true, bannerFileId: "", hookSecret: "", publicUrl: "", appUrl: "", menuUrl: ""
};
if (!DB.notifState) DB.notifState = {}; // TZ band 6: sevimli mahsulot stock/narx bildirishnomalari holati
// Promo-kodlar: code -> {code,type("percent"|"fixed"),value,maxUses,usedCount,perUserLimit,
// usedBy:{uid:son},minOrder,expiresAt,active,createdAt,note}
if (!DB.promoCodes) DB.promoCodes = {};
// Sodiqlik dasturi: umumiy xarid summasiga qarab avtomatik status (Bronze/Silver/Gold...) —
// har bosqich shu bosqichdan boshlab beriladigan qo'shimcha keshbek foizini bildiradi
// (mijoz xarid qilganda balansiga avtomatik qo'shiladi, referral bonusi kabi).
if (!DB.settings.loyalty) DB.settings.loyalty = {
  enabled: true,
  tiers: [
    { name: "Bronze", minSpent: 0, percent: 0 },
    { name: "Silver", minSpent: 300000, percent: 2 },
    { name: "Gold", minSpent: 1000000, percent: 5 }
  ]
};
// Avtomatlashtirish sozlamalari: stock tugaganda adminga ogohlantirish (doim yoqilgan) va
// uzoq vaqt xarid qilmagan mijozlarga "sizni sog'indik" xabar + bonus (avtomatik, davriy).
if (!DB.automation) DB.automation = {
  winbackEnabled: false,
  winbackDays: 14,          // shuncha kun xarid qilmasa "sog'indik" xabari boradi
  winbackBonus: 0,          // shu summa balansga avtomatik qo'shiladi (0 — faqat xabar, bonussiz)
  winbackMessage: "",       // bo'sh bo'lsa standart matn ishlatiladi
  winbackCooldownDays: 30,  // bir mijozga qayta "sog'indik" xabari yuborilmaydigan minimal oraliq
  lastRunTs: 0,
  stockAlertEnabled: true   // zaxira (stock) tugaganda adminga xabar
};
if (DB.automation.winbackEnabled === undefined) DB.automation.winbackEnabled = false;
if (DB.automation.stockAlertEnabled === undefined) DB.automation.stockAlertEnabled = true;
// Moderatsiya joriy etilishidan oldingi sharhlar — allaqachon ochiq bo'lgani uchun "approved" deb belgilanadi.
if (Array.isArray(DB.reviews)) for (const r of DB.reviews) if (!r.status) r.status = "approved";
// Saqlash: ko'p chaqiruvlar bitta yozuvga birlashtiriladi (eng ko'pi 250 ms kechikadi). Avvalgi
// "har chaqiruvda taymerni qayta boshlash" doimiy yuklamada saqlashni umuman kechiktirib yuborardi.
// saveState faqat o'zgargan qatorlarni yozadi; eski yopilgan buyurtmalar har daqiqada to'liq
// tekshiriladi, server o'chayotganda esa oxirgi holat albatta yoziladi.
let saveT = null, lastFull = Date.now();
function flushSave(full) {
  clearTimeout(saveT); saveT = null;
  try {
    const t0 = Date.now();
    sdb.saveState(SQLITE_DB, DB, { full: !!full });
    if (full) lastFull = Date.now();
    const ms = Date.now() - t0;
    if (ms > 300) console.log("[db] sekin saqlash: " + ms + " ms" + (full ? " (to'liq)" : ""));
  } catch (e) { console.log("[db] saveState xato: " + e.message); }
}
function save() { if (!saveT) saveT = setTimeout(() => flushSave(Date.now() - lastFull > 60000), 250); }
setInterval(() => { if (!saveT) flushSave(true); }, 5 * 60 * 1000).unref();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { flushSave(true); process.exit(0); });
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
// Davr chegarasini Toshkent vaqti (UTC+5) bo'yicha hisoblaydi — server qaysi
// timezone'da ishlashidan qat'i nazar, "Bugun" doim Toshkentdagi yarim tundan boshlanadi.
// Eslatma: avval bu funksiya har doim 0 qaytarardi — shuning uchun "Bugun/Hafta/Oy"
// tugmalari amalda hech narsani filtrlamas, har doim "Hammasi" bilan bir xil natija
// ko'rsatardi. Reyting "ishlamayapti" degan shikoyatning asosiy sababi shu edi.
function periodStart(period) {
  if (period !== "today" && period !== "week" && period !== "month") return 0;
  const OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5
  const local = new Date(Date.now() + OFFSET_MS);
  let startLocalUTC;
  if (period === "today") {
    startLocalUTC = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  } else if (period === "week") {
    const day = local.getUTCDay(); // 0=Yak..6=Shan
    const diffToMonday = day === 0 ? 6 : day - 1;
    startLocalUTC = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - diffToMonday);
  } else {
    startLocalUTC = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  }
  return startLocalUTC - OFFSET_MS;
}

/* ---------- referal dasturi ---------- */
// Mini-App'ning BotFather'da belgilangan "short name"i (masalan "app" yoki "shop") —
// bu botga tegishli mini-ilovani TO'G'RIDAN-TO'G'RI ochadigan havola qurish uchun kerak:
// https://t.me/<bot_username>/<MINIAPP_NAME>?startapp=... — shu format orqaligina
// start_param mini-ilova ichiga to'g'ri yetib boradi (oddiy ?start= chatni ochadi, ilovani emas).
// Railway Variables'da MINIAPP_NAME o'rnatilmagan bo'lsa, pastdagi standart qiymat ishlatiladi —
// buni BotFather > Bot Settings > Menu Button / Mini Apps bo'limidagi haqiqiy nomga moslang.
const MINIAPP_NAME = process.env.MINIAPP_NAME || "shop";
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
/* ---------- promo-kodlar ---------- */
function normPromo(code) { return String(code || "").trim().toUpperCase().replace(/\s+/g, ""); }
// Kodni tekshiradi (sarflamasdan) — checkout'da "Qo'llash" bosilganda yoki xarid tasdiqlanishidan
// oldin chaqiriladi. subtotal — chegirmagacha bo'lgan umumiy summa.
function validatePromo(code, uid, subtotal) {
  const c = normPromo(code);
  if (!c) return { ok: false, reason: "empty" };
  const p = DB.promoCodes[c];
  if (!p) return { ok: false, reason: "not_found" };
  if (!p.active) return { ok: false, reason: "inactive" };
  if (p.expiresAt && Date.now() > p.expiresAt) return { ok: false, reason: "expired" };
  if (p.maxUses && (p.usedCount || 0) >= p.maxUses) return { ok: false, reason: "limit" };
  const usedByThis = (p.usedBy && p.usedBy[String(uid)]) || 0;
  if (p.perUserLimit && usedByThis >= p.perUserLimit) return { ok: false, reason: "already_used" };
  if (p.minOrder && subtotal < p.minOrder) return { ok: false, reason: "min_order", minOrder: p.minOrder };
  const discount = p.type === "fixed"
    ? Math.min(Math.round(Number(p.value) || 0), subtotal)
    : Math.round(subtotal * (Math.min(100, Math.max(0, Number(p.value) || 0)) / 100));
  return { ok: true, promo: p, discount: Math.max(0, discount) };
}
function consumePromo(promo, uid) {
  promo.usedCount = (promo.usedCount || 0) + 1;
  if (!promo.usedBy) promo.usedBy = {};
  promo.usedBy[String(uid)] = (promo.usedBy[String(uid)] || 0) + 1;
}

/* ---------- sodiqlik dasturi (loyalty) ---------- */
// Foydalanuvchining hozirgacha "done" bo'lgan buyurtmalari bo'yicha umumiy xarid summasi.
function userTotalSpent(uid) {
  let sum = 0;
  for (const o of DB.orders) if (o.status === "done" && String(o.uid) === String(uid)) sum += Number(o.price) || 0;
  return sum;
}
// Xarid summasiga qarab eng yuqori mos bosqichni qaytaradi (tiers minSpent bo'yicha o'sish tartibida
// saqlanadi deb hisoblanmaydi — shu yerda o'zimiz saralaymiz).
function loyaltyTierFor(spent) {
  const tiers = (DB.settings.loyalty && DB.settings.loyalty.tiers) || [];
  const sorted = tiers.slice().sort((a, b) => (Number(a.minSpent) || 0) - (Number(b.minSpent) || 0));
  let cur = sorted[0] || { name: "—", minSpent: 0, percent: 0 };
  let next = null;
  for (let i = 0; i < sorted.length; i++) {
    if (spent >= (Number(sorted[i].minSpent) || 0)) { cur = sorted[i]; next = sorted[i + 1] || null; }
  }
  return { tier: cur, next };
}
// Xarid "done" bo'lganda chaqiriladi — mijoz joriy bosqichi bo'yicha keshbek foizini
// balansiga avtomatik qo'shadi (referral bonusi bilan bir xil naqd usulda, bir buyurtma
// uchun faqat bir marta).
function creditLoyaltyOnOrder(order) {
  try {
    if (!order || order.status !== "done") return;
    const ls = DB.settings.loyalty || {};
    if (!ls.enabled) return;
    const acc = DB.users[String(order.uid)];
    if (!acc) return;
    const already = acc.loyaltyCreditedOrders || (acc.loyaltyCreditedOrders = []);
    if (already.indexOf(order.id) !== -1) return;
    const spent = userTotalSpent(order.uid); // shu buyurtma bilan birga hisoblangan umumiy summa
    const { tier } = loyaltyTierFor(spent);
    const pct = Number(tier.percent) || 0;
    if (pct <= 0) { already.push(order.id); return; }
    const bonus = Math.floor((Number(order.price) || 0) * pct / 100);
    if (bonus <= 0) { already.push(order.id); return; }
    acc.balance = (acc.balance || 0) + bonus;
    acc.loyaltyEarnedTotal = (acc.loyaltyEarnedTotal || 0) + bonus;
    acc.loyaltyTier = tier.name;
    already.push(order.id);
    save();
    tgSend(order.uid, "🏅 " + tier.name + " status bonusi: balansingizga " +
      bonus.toLocaleString("ru-RU") + " so'm keshbek qo'shildi.");
  } catch (e) {}
}

/* ---------- avtomatlashtirish ---------- */
// Zaxira (stock) tugab qolganda — barcha adminlarga (ADMIN_IDS) darhol xabar. Buy va admin
// stock/remove nuqtalarida chaqiriladi. Bir mahsulot uchun ketma-ket ko'p marta yubormaslik
// uchun DB.automation.stockAlertSent[itemId] bilan belgilanadi, zaxira qayta to'ldirilganda
// (stock/add) tozalanadi.
function checkStockAlert(itemId, title) {
  try {
    if (!DB.automation || !DB.automation.stockAlertEnabled) return;
    const list = DB.stock[itemId];
    if (!Array.isArray(list) || list.length > 0) return;
    if (!DB.automation.stockAlertSent) DB.automation.stockAlertSent = {};
    if (DB.automation.stockAlertSent[itemId]) return; // allaqachon xabar berilgan
    DB.automation.stockAlertSent[itemId] = Date.now();
    save();
    const text = "⚠️ Zaxira tugadi\n\n▪️ Mahsulot: " + (title || itemId) +
      "\n\nIltimos admin panel orqali yangi zaxira qo'shing.";
    notifyAdmins(text);
  } catch (e) {}
}
// "Sizni sog'indik" — winback: DB.automation.winbackDays kun davomida hech narsa xarid
// qilmagan (lekin avval kamida bitta "done" buyurtmasi bo'lgan) mijozlarga avtomatik xabar
// (va agar sozlangan bo'lsa — bonus) yuboradi. Har bir mijozga winbackCooldownDays dan
// tez-tez yuborilmaydi. setInterval orqali davriy chaqiriladi (pastda).
function runWinbackCheck() {
  try {
    const A = DB.automation || {};
    if (!A.winbackEnabled) return;
    const now = Date.now();
    const inactiveMs = (Number(A.winbackDays) || 14) * 24 * 60 * 60 * 1000;
    const cooldownMs = (Number(A.winbackCooldownDays) || 30) * 24 * 60 * 60 * 1000;
    const lastOrderByUid = {};
    for (const o of DB.orders) {
      if (o.status !== "done") continue;
      const k = String(o.uid);
      if (!lastOrderByUid[k] || o.ts > lastOrderByUid[k]) lastOrderByUid[k] = o.ts;
    }
    let sentCount = 0;
    for (const uid of Object.keys(lastOrderByUid)) {
      const lastTs = lastOrderByUid[uid];
      if (now - lastTs < inactiveMs) continue; // hali "uzoq vaqt" hisoblanmaydi
      const acc = DB.users[uid];
      if (!acc) continue;
      if (acc.winbackSentTs && now - acc.winbackSentTs < cooldownMs) continue; // yaqinda yuborilgan
      acc.winbackSentTs = now;
      if (A.winbackBonus > 0) acc.balance = (acc.balance || 0) + Number(A.winbackBonus);
      sentCount++;
      const msg = (A.winbackMessage && A.winbackMessage.trim()) ||
        "😔 Sizni sog'indik! Ancha bo'ldi xarid qilmagansiz.";
      const bonusLine = A.winbackBonus > 0
        ? ("\n\n🎁 Sizga " + Number(A.winbackBonus).toLocaleString("ru-RU") + " so'm bonus balansingizga qo'shildi — foydalaning!")
        : "";
      tgSend(uid, msg + bonusLine);
    }
    DB.automation.lastRunTs = now;
    if (sentCount > 0) save(); else save();
    return sentCount;
  } catch (e) { return 0; }
}
// Har 12 soatda avtomatik tekshiradi (server doim ishlab turgan taqdirda). Birinchi tekshiruv
// 2 daqiqadan keyin (server to'liq ishga tushgach) boshlanadi.
setTimeout(() => { try { runWinbackCheck(); } catch (e) {} }, 2 * 60 * 1000);
setInterval(() => { try { runWinbackCheck(); } catch (e) {} }, 12 * 60 * 60 * 1000);

function expireOld() {
  const now = Date.now();
  // Vaqt tugagach to'lov TO'LIQ bekor bo'lishi kerak — foydalanuvchi "To'lov qildim"
  // tugmasini bosib "checking" holatiga o'tgan bo'lsa ham, agar admin uni tasdiqlamasa,
  // vaqt oynasi (TOPUP_TTL) tugagandan keyin baribir "cancelled" bo'lib qoladi —
  // shu bilan admin panelida abadiy osilib qolmaydi.
  let changed = false;
  for (const p of DB.payments) {
    if ((p.status === "waiting" || p.status === "checking") && now - p.ts > TOPUP_TTL) {
      p.status = "cancelled";
      p.cancelledBy = "timeout";
      changed = true;
      // Mijozga ham xabar boradi (ID ko'rsatilmaydi — faqat buyurtma va summa).
      tgSend(p.uid,
        "❌ To'lov bekor qilindi\n\n" +
        "▪️ Buyurtma: Balansni to'ldirish\n" +
        "▪️ Summa: " + (Number(p.amount) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm\n\n" +
        "Vaqt tugagani sababli to'lov avtomatik bekor qilindi. Qayta urinish uchun \"To'ldirish\" bo'limiga o'ting."
      );
      notifyTopupChannel(p);
    }
  }
  if (changed) save();
}
// To'lovni tasdiqlash (admin qo'lda ✅ bossa ham, SMS avtomat topsa ham shu funksiya ishlaydi)
/* ---------- Admin bot tokeni ----------
   Railway'dagi ADMIN_BOT_TOKEN yoki admin paneldan kiritilgan token (bazada). Do'kon
   boti tokeni bilan bir xil bo'lishi mumkin emas — ikkita alohida bot kerak. */
function adminBotToken() {
  const t = String(process.env.ADMIN_BOT_TOKEN || (DB.settings && DB.settings.adminBot && DB.settings.adminBot.token) || "").trim();
  return t && t !== BOT_TOKEN ? t : "";
}
// Admin bot tokenini saqlash (admin panel va do'kon botidagi /adminbot buyrug'i). Xato bo'lsa matn qaytaradi.
function setAdminBotToken(raw) {
  if (process.env.ADMIN_BOT_TOKEN) return "Token Railway'dagi ADMIN_BOT_TOKEN orqali berilgan — o'sha yerda o'zgartiring.";
  const t = String(raw || "").trim();
  if (t && !/^\d{5,}:[\w-]{30,}$/.test(t)) return "Token ko'rinishi noto'g'ri (masalan 1234567890:AA...)";
  if (t && t === BOT_TOKEN) return "Bu do'kon botining tokeni. Admin uchun BotFather'da ALOHIDA bot oching.";
  const c = DB.settings.adminBot || (DB.settings.adminBot = {});
  c.token = t; save();
  return "";
}
// Adminlarga xabar: admin bot ishlayotgan bo'lsa — o'sha orqali, aks holda do'kon boti orqali.
function notifyAdmins(text, opts) {
  try { if (ADMINBOT && ADMINBOT.notify(text, opts)) return; } catch (e) {}
  for (const aid of ADMIN_IDS) tgSend(aid, text);
}

/* ---------- Moliya hisoboti (admin bot "📊 Moliya" va mini-ilova "Moliya") ----------
   Kirim — mijozlar to'ldirgan pul (qo'lda o'zgartirishlar alohida). Sotuv — bajarilgan
   buyurtmalar. Tannarx — faqat yetkazib beruvchi saytdan bajarilgan o'yin buyurtmalari
   uchun ma'lum (tannarx × kurs), shuning uchun foyda shu buyurtmalar bo'yicha hisoblanadi.
   Mijozlar balansi — ular hali sarflamagan pul (bizning "qarzimiz"). */
function computeFinance(period) {
  const from = periodStart(period);
  const inP = x => (Number(x.ts) || 0) >= from;
  const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  const pays = DB.payments.filter(inP);
  const topups = pays.filter(p => p.status === "done" && p.type !== "manual");
  const manual = pays.filter(p => p.status === "done" && p.type === "manual");
  const orders = DB.orders.filter(inP);
  const done = orders.filter(o => o.status === "done");
  const cancelled = orders.filter(o => o.status === "cancelled");
  const pendingO = DB.orders.filter(o => o.status === "pending" || o.status === "processing");
  const pendingP = DB.payments.filter(p => p.status === "waiting" || p.status === "checking");
  const withCost = done.filter(o => Number(o.costUzs) > 0);
  const byMethod = {};
  for (const p of topups) { const k = String(p.method || "boshqa"); byMethod[k] = (byMethod[k] || 0) + (Number(p.amount) || 0); }
  const srcOf = o => o.game ? "games" : (o.japOrderId || String(o.itemId || "").indexOf("nk_") === 0) ? "nakrutka" : (o.fragment !== undefined || o.giftRecipient) ? "telegram" : "shop";
  const bySource = {};
  for (const o of done) { const k = srcOf(o); const b = bySource[k] || (bySource[k] = { count: 0, sum: 0 }); b.count++; b.sum += Number(o.price) || 0; }
  const byLine = {};
  for (const o of done) if (o.game && o.line && o.line.id) {
    const b = byLine[o.line.id] || (byLine[o.line.id] = { name: o.line.name || o.line.id, count: 0, sum: 0, cost: 0 });
    b.count++; b.sum += Number(o.price) || 0; b.cost += Number(o.costUzs) || 0;
  }
  const users = Object.values(DB.users);
  return {
    period, from,
    topups: { count: topups.length, sum: sum(topups, p => p.amount), byMethod },
    manual: { count: manual.length, plus: sum(manual.filter(p => p.amount > 0), p => p.amount), minus: -sum(manual.filter(p => p.amount < 0), p => p.amount) },
    sales: { count: done.length, sum: sum(done, o => o.price) },
    refunds: { count: cancelled.length, sum: sum(cancelled, o => o.price) },
    cost: { count: withCost.length, sum: sum(withCost, o => o.costUzs), revenue: sum(withCost, o => o.price) },
    profit: sum(withCost, o => o.price - o.costUzs),
    pendingOrders: { count: pendingO.length, sum: sum(pendingO, o => o.price) },
    pendingPayments: { count: pendingP.length, sum: sum(pendingP, p => p.pay) },
    liabilities: sum(users, u => u.balance),
    users: { total: users.length, new: users.filter(u => (Number(u.ts) || 0) >= from).length },
    bySource, byLine, daily: dailySeries(period === "month" ? 30 : period === "all" ? 60 : 14)
  };
}
// Grafik uchun: oxirgi n kun (Toshkent vaqti) bo'yicha kirim va sotuv.
function dailySeries(n) {
  const OFF = 5 * 3600 * 1000, DAY = 86400000;
  const today = Math.floor((Date.now() + OFF) / DAY);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ d: new Date((today - i) * DAY).toISOString().slice(0, 10), topup: 0, sales: 0 });
  const idx = ts => { const k = Math.floor(((Number(ts) || 0) + OFF) / DAY) - (today - n + 1); return k >= 0 && k < n ? k : -1; };
  for (const p of DB.payments) if (p.status === "done" && p.type !== "manual") { const k = idx(p.ts); if (k >= 0) out[k].topup += Number(p.amount) || 0; }
  for (const o of DB.orders) if (o.status === "done") { const k = idx(o.ts); if (k >= 0) out[k].sales += Number(o.price) || 0; }
  return out;
}

/* ---------- Admin amallari (mini-ilova admin paneli VA admin bot ishlatadi) ---------- */
function adminPaymentAction(id, action, by) {
  const p = DB.payments.find(x => x.id === id);
  if (!p) return { ok: false, code: 404, error: "not found" };
  if (p.status === "done") return { ok: false, code: 409, error: "already done" };
  if (p.status === "cancelled" && action !== "confirm") return { ok: false, code: 409, error: "already cancelled" };
  if (action === "confirm") return { ok: true, balance: confirmPayment(p, by || "admin"), p };
  p.status = "cancelled"; p.cancelledBy = by || "admin"; save(); notifyTopupChannel(p);
  return { ok: true, p };
}
function adminOrderAction(id, action) {
  const o = DB.orders.find(x => x.id === id);
  if (!o) return { ok: false, code: 404, error: "not found" };
  if (o.status !== "pending") return { ok: false, code: 409, error: "state" };
  if (action === "done") {
    o.status = "done"; o.doneTs = Date.now();
    save();
    creditReferralOnOrder(o);
    creditLoyaltyOnOrder(o);
    tgSend(o.uid, "✅ Buyurtmangiz bajarildi: " + o.item);
    notifyOrderChannel(o);
  } else {
    o.status = "cancelled"; // refund
    const acc = DB.users[String(o.uid)] || (DB.users[String(o.uid)] = { balance: 0 });
    acc.balance += o.price;
    // Promo-kod ishlatilgan bo'lsa — bekor qilinganda foydalanish limitini bo'shatamiz.
    if (o.promoCode && DB.promoCodes[o.promoCode]) {
      const p = DB.promoCodes[o.promoCode];
      p.usedCount = Math.max(0, (p.usedCount || 0) - 1);
      if (p.usedBy && p.usedBy[String(o.uid)]) p.usedBy[String(o.uid)] = Math.max(0, p.usedBy[String(o.uid)] - 1);
    }
    save();
    tgSend(o.uid, "❌ Buyurtmangiz bekor qilindi, mablag' balansingizga qaytarildi: " + o.item);
    notifyOrderChannel(o);
  }
  return { ok: true, o };
}
// Qo'lda balans o'zgartirish (admin panel va admin bot). delta > 0 — qo'shish, < 0 — yechish.
function adminBalanceChange(uid, delta, by, note) {
  const k = String(Number(uid) || 0);
  if (!DB.users[k]) return { ok: false, code: 404, error: "no user" };
  delta = Math.round(Number(delta) || 0);
  if (!delta) return { ok: false, code: 400, error: "delta" };
  const before = DB.users[k].balance;
  DB.users[k].balance += delta;
  if (DB.users[k].balance < 0) DB.users[k].balance = 0;
  const applied = DB.users[k].balance - before;
  DB.payments.push({ id: genId("MN"), uid: Number(k), uname: DB.users[k].uname, type: "manual",
    amount: applied, pay: applied, method: "admin", status: "done", ts: Date.now(), by, note: String(note || "").slice(0, 120) });
  save();
  try { if (ADMINBOT && applied) ADMINBOT.onBalance({ uid: Number(k), applied, balance: DB.users[k].balance, by, note }); } catch (e) {}
  return { ok: true, balance: DB.users[k].balance, applied };
}
function confirmPayment(p, source) {
  p.status = "done"; p.doneTs = Date.now(); p.confirmedBy = source || "admin";
  const acc = DB.users[String(p.uid)] || (DB.users[String(p.uid)] = { balance: 0 });
  acc.balance += p.amount;
  save();
  notifyTopupChannel(p);
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

/* ---------- Ommaviy xabar (broadcast) — TZ: "barcha foydalanuvchilarga habar yuborish,
   matn/rasm/video/premium emojilar ishlashi kerak" ----------
   - Matn ichida premium (custom) emoji "[emoji:CUSTOM_EMOJI_ID:🙂]" ko'rinishidagi token
     bilan kiritiladi (admin panel buni o'zi qo'shadi) — jo'natishda Telegram HTML
     parse_mode'dagi <tg-emoji emoji-id="..."> tegiga aylantiriladi, shu sababli
     yuborilgan xabarda haqiqiy animatsion/premium emoji ko'rinadi.
   - Oddiy **qalin** va __qiya__ belgilash ham qo'llab-quvvatlanadi (ixtiyoriy).
   - Rasm/video bo'lsa: birinchi qabul qiluvchiga multipart orqali fayl yuboriladi va
     javobdan file_id olinadi, keyingi barcha qabul qiluvchilarga esa endi shu file_id
     (juda tez, faylni qayta yuklamasdan) orqali yuboriladi — Telegram’ning tavsiya
     etilgan usuli shu.
   - Bir vaqtda faqat bitta ommaviy yuborish ishlaydi (BROADCAST_JOB), holati
     /api/admin/broadcast-status orqali (polling bilan) admin panelda kuzatiladi. */
const BROADCAST_MAX_TEXT = 4096;      // Telegram sendMessage matn limiti
const BROADCAST_MAX_CAPTION = 1024;   // Telegram photo/video caption limiti
const BROADCAST_HISTORY_MAX = 15;
let BROADCAST_JOB = null;

function escapeTgHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// "matn [emoji:123456:🙂] davomi **qalin** __qiya__" -> xavfsiz Telegram HTML.
// Avval butun matn HTML-escape qilinadi, SHUNDAN KEYIN emoji token va **/__ belgilar
// qidiriladi — shu sababli foydalanuvchi matnidagi < > & hech qachon teg sifatida talqin qilinmaydi.
function buildBroadcastHTML(rawText) {
  const text = String(rawText || "");
  const EMOJI_RE = /\[emoji:(\d{1,20}):([^\]\n]{1,24})\]/g;
  let out = "", last = 0, m;
  while ((m = EMOJI_RE.exec(text))) {
    out += escapeTgHtml(text.slice(last, m.index));
    out += '<tg-emoji emoji-id="' + m[1] + '">' + escapeTgHtml(m[2]) + '</tg-emoji>';
    last = m.index + m[0].length;
  }
  out += escapeTgHtml(text.slice(last));
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<i>$1</i>");
  return out;
}
function tgApiPost(method, payload) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) return reject(new Error("BOT_TOKEN not set"));
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.telegram.org", path: "/bot" + BOT_TOKEN + "/" + method, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, r => {
      let body = ""; r.on("data", c => body += c);
      r.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}
// Umumiy multipart yuboruvchi (sendPhoto / sendVideo) — tgSendDocument bilan bir xil naqsh,
// faqat maydon nomi (photo/video) va caption HTML sifatida beriladi.
function tgSendMediaMultipart(chatId, field, buffer, filename, mimeType, captionHtml) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN || !chatId) return reject(new Error("no bot/chat"));
    const boundary = "----VerionBroadcast" + crypto.randomBytes(10).toString("hex");
    const parts = [];
    const field_ = (name, val) => parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, "utf8"));
    field_("chat_id", chatId);
    if (captionHtml) { field_("caption", captionHtml); field_("parse_mode", "HTML"); }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf8"));
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([...parts, buffer, post]);
    const method = field === "video" ? "sendVideo" : "sendPhoto";
    const req = https.request({
      hostname: "api.telegram.org", path: "/bot" + BOT_TOKEN + "/" + method, method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length }
    }, r => {
      let out = ""; r.on("data", c => out += c);
      r.on("end", () => {
        try { const j = JSON.parse(out); j.ok ? resolve(j) : reject(new Error(j.description || "telegram_error")); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}
function classifyTgError(msg) {
  const s = String(msg || "").toLowerCase();
  if (s.indexOf("blocked") !== -1 || s.indexOf("deactivated") !== -1 || s.indexOf("chat not found") !== -1
    || s.indexOf("user is deactivated") !== -1 || s.indexOf("bot was kicked") !== -1) return "blocked";
  return "failed";
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
// Ommaviy yuborishni fonda bajaradi (so'rovni ushlab turmaydi) — BROADCAST_JOB orqali
// progressni admin panelga polling bilan ko'rsatish mumkin.
async function runBroadcast(job, text, mediaType, mediaBuffer, mediaMime, ids) {
  const captionHtml = buildBroadcastHTML(text);
  const BATCH = 20, GAP_MS = 1000; // Telegramning "sekundiga ~30 xabar (turli chatlarga)" limitiga mos, ehtiyot zaxira bilan
  let fileId = null;
  let i = 0;
  // Rasm/video bo'lsa — birinchi MUVAFFAQIYATLI yuborishdan file_id olinadi (fayl faqat bir marta yuklanadi).
  if (mediaType === "photo" || mediaType === "video") {
    const ext = mediaType === "video" ? ".mp4" : ".jpg";
    const field = mediaType === "video" ? "video" : "photo";
    while (i < ids.length && !fileId) {
      try {
        const r = await tgSendMediaMultipart(ids[i], field, mediaBuffer, "broadcast" + ext, mediaMime, captionHtml);
        fileId = mediaType === "video" ? (r.result.video && r.result.video.file_id)
          : (r.result.photo && r.result.photo[r.result.photo.length - 1].file_id);
        job.sent++;
      } catch (e) {
        job[classifyTgError(e.message)]++;
      }
      i++;
      job.processed = i;
      await sleep(60);
    }
    if (!fileId) { job.done = true; job.finishedTs = Date.now(); return; } // hech kimga yubora olmadi (masalan token/fayl xato)
  }
  while (i < ids.length) {
    const batch = ids.slice(i, i + BATCH);
    await Promise.all(batch.map(async id => {
      try {
        if (mediaType === "photo" || mediaType === "video") {
          const payload = { chat_id: id, caption: captionHtml, parse_mode: "HTML" };
          payload[mediaType] = fileId;
          const r = await tgApiPost(mediaType === "video" ? "sendVideo" : "sendPhoto", payload);
          if (!r.ok) throw new Error(r.description || "telegram_error");
        } else {
          const r = await tgApiPost("sendMessage", { chat_id: id, text: captionHtml, parse_mode: "HTML" });
          if (!r.ok) throw new Error(r.description || "telegram_error");
        }
        job.sent++;
      } catch (e) {
        job[classifyTgError(e.message)]++;
      }
    }));
    i += BATCH;
    job.processed = i;
    if (i < ids.length) await sleep(GAP_MS);
  }
  job.done = true;
  job.finishedTs = Date.now();
  try {
    const hist = sdb.kvGet(SQLITE_DB, "broadcastLog", []);
    hist.push({ ts: job.startedTs, total: job.total, sent: job.sent, blocked: job.blocked, failed: job.failed,
      mediaType: job.mediaType, preview: text.slice(0, 80) });
    if (hist.length > BROADCAST_HISTORY_MAX) hist.splice(0, hist.length - BROADCAST_HISTORY_MAX);
    sdb.kvSet(SQLITE_DB, "broadcastLog", hist);
  } catch (e) {}
}
// Umumiy readBody'dan farqli — rasm/video uchun MAX_BODY (10MB) yetarli bo'lmasligi mumkin,
// shu sababli shu bitta yo'nalish uchun kattaroq (20MB) limit bilan alohida o'qiladi.
const MAX_BROADCAST_BODY = 20 * 1024 * 1024;
function readBroadcastBody(req, res, cb) {
  let body = "", size = 0, dead = false;
  req.on("data", c => {
    size += c.length;
    if (size > MAX_BROADCAST_BODY) { dead = true; send(res, 413, { error: "too large" }); req.destroy(); }
    else body += c;
  });
  req.on("end", () => {
    if (dead) return;
    try { cb(JSON.parse(body || "{}")); } catch (e) { send(res, 400, { error: "invalid json" }); }
  });
}
// Mini-ilovani to'g'ridan-to'g'ri ochadigan havola (t.me/<bot>/<app>?startapp=...) — BOT_USERNAME
// hali Telegram'dan olinmagan bo'lsa (server hozirgina ishga tushgan bo'lsa) bo'sh qaytaradi.
function miniAppLink(startParam) {
  if (!BOT_USERNAME) return "";
  const appPart = MINIAPP_NAME ? ("/" + MINIAPP_NAME) : "";
  const query = startParam ? ("?startapp=" + encodeURIComponent(startParam)) : "";
  return "https://t.me/" + BOT_USERNAME + appPart + query;
}
// tgSend bilan bir xil, faqat pastida "ilovani ochish" tugmasi (inline button) biriktirilgan holda —
// rasmdagi "To'lovni yakunlash" tugmasi kabi, mijoz bosganda to'g'ridan-to'g'ri mini-ilova ochiladi.
function tgSendButton(chatId, text, btnText, url) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const payload = { chat_id: chatId, text: text };
    if (url) payload.reply_markup = { inline_keyboard: [[{ text: btnText, url: url }]] };
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.telegram.org", path: "/bot" + BOT_TOKEN + "/sendMessage", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, r => { r.on("data", () => {}); });
    req.on("error", () => {});
    req.write(data); req.end();
  } catch (e) {}
}
/* ================= BOT: /start salomlashuvi va "start bosilmagan bo'lsa kirmasin" =================
   Ilgari bot faqat xabar YUBORARDI, kelgan xabarlarni umuman o'qimasdi — shu sabab
   foydalanuvchi /start bosganda hech narsa chiqmasdi. Endi Telegram update'lari
   /api/tg-webhook ga keladi va /start ga banner rasm + tugmalar bilan javob beriladi.
   Bu ayni paytda Telegram'ning "N oylik foydalanuvchi" hisobiga ham kiradi. */

function botCfg() {
  if (!DB.settings) DB.settings = {};
  if (!DB.settings.bot) DB.settings.bot = { greeting: "", channelUrl: "", guideUrl: "", gate: true, bannerFileId: "", hookSecret: "", publicUrl: "", appUrl: "", menuUrl: "" };
  return DB.settings.bot;
}
// Webhook maxfiy kaliti — hech qanday sozlama talab qilmaydi, birinchi marta o'zi
// yaratiladi va bazada saqlanadi. Telegram uni har so'rovda sarlavhada qaytaradi,
// shuning uchun tashqaridan kimdir soxta "update" yubora olmaydi.
function botHookSecret() {
  const c = botCfg();
  if (!c.hookSecret) { c.hookSecret = crypto.randomBytes(16).toString("hex"); save(); }
  return c.hookSecret;
}
/* Ilovaning tashqi manzili. Manbalar, shu tartibda:
   1) admin panelda qo'lda kiritilgan va server tekshirgan manzil (appUrl);
   2) chat pastidagi ko'k «Ilova» tugmasining manzili (BotFather → Menu Button) —
      mijozlar aynan shu tugma orqali muvaffaqiyatli kiryapti, server uni
      Telegram'dan o'zi o'qiydi va SHU serverga olib borishini tekshiradi (menuUrl);
   3) PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN o'zgaruvchisi;
   4) admin ilovani ochganda so'rovning Host sarlavhasidan o'rganilgan manzil.
   Nega shuncha: verionshop.uz ba'zi tarmoqlardan (Telegram serverlari,
   kompyuterdagi Telegram) ochilmay qoldi. Ko'k tugma ishlardi, /start'dagi
   "Ilovani ochish" esa Host'dan o'rganilgan aynan shu domenga olib borardi.
   4-manba faqat ADMIN imzosi bilan kelgan so'rovdan olinadi — aks holda kimdir
   soxta Host sarlavhasi yuborib webhook'ni o'z domeniga burib yuborishi mumkin edi. */
function publicBase() {
  const c = botCfg();
  if (c.appUrl) return c.appUrl;                // admin panelda qo'lda tasdiqlangan manzil — eng ustun
  const menu = normalizeAppUrl(c.menuUrl);
  if (menu) return menu;
  if (PUBLIC_URL) return PUBLIC_URL;
  return String(c.publicUrl || "");
}
// Ilovani OCHISH uchun to'liq manzil (web_app tugmalari). Ko'k tugma manzilida
// yo'l yoki parametr bo'lsa — aynan o'zini ishlatamiz, ishlayotgani shu.
function appOpenUrl() {
  const c = botCfg();
  if (c.appUrl) return c.appUrl;
  if (c.menuUrl) return c.menuUrl;
  return publicBase();
}
/* Ko'k «Ilova» tugmasi manzilini Telegram'dan o'qib, tasdiqlangan bo'lsa saqlaydi.
   Faqat manzil rostdan SHU serverga olib borsa qabul qilinadi (statik nusxa yoki
   begona sayt bo'lsa — yo'q). { changed: true } — ulanishni qayta qurish kerak. */
let menuProbeFail = { url: "", ts: 0 };
async function refreshMenuUrl() {
  if (!BOT_TOKEN) return { changed: false };
  let mb = null;
  try { const j = await tgApiPost("getChatMenuButton", {}); mb = j && j.ok ? j.result : null; }
  catch (e) { return { changed: false }; }
  if (!mb) return { changed: false };
  const c = botCfg();
  const full = mb.type === "web_app" && mb.web_app && mb.web_app.url ? String(mb.web_app.url) : "";
  if (!normalizeAppUrl(full)) {
    if (c.menuUrl) { c.menuUrl = ""; save(); return { changed: true }; }
    return { changed: false };
  }
  if (full === c.menuUrl) return { changed: false };
  // Yaqinda tekshirilib o'tmagan bo'lsa — har safar 10 soniya kutmaymiz.
  if (menuProbeFail.url === full && Date.now() - menuProbeFail.ts < 15 * 60 * 1000) return { changed: false };
  const probe = await probeAppUrl(normalizeAppUrl(full));
  if (!probe.ok) {
    menuProbeFail = { url: full, ts: Date.now() };
    console.log("[bot] ko'k tugma manzili (" + full + ") bu serverga olib bormadi: " + probe.error);
    if (c.menuUrl) { c.menuUrl = ""; save(); return { changed: true }; }
    return { changed: false };
  }
  c.menuUrl = full; save();
  console.log("[bot] ko'k «Ilova» tugmasi manzili qabul qilindi: " + full);
  return { changed: true };
}
function rememberPublicBase(req) {
  const cfg = botCfg();
  if (PUBLIC_URL || cfg.appUrl || cfg.menuUrl) return;   // aniqroq manba bor — Host'dan o'rganmaymiz
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?$/i.test(host)) return;  // domen bo'lsin (IP/localhost emas)
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto && proto !== "https") return;       // Telegram webhook faqat https
  const base = "https://" + host.replace(/:443$/, "");
  const c = botCfg();
  if (c.publicUrl === base) return;
  c.publicUrl = base; save();
  console.log("[bot] ilova manzili aniqlandi: " + base);
  // Yangi ma'lumot — ulanishni qaytadan baholaymiz (polling'da turgan bo'lsa ham
  // endi webhook'ni sinab ko'ramiz).
  ensureBotConnection(true).then(r => reportWebhook(r, true)).catch(() => {});
}
function miniAppUrl() {
  const base = appOpenUrl();
  if (base) return base;
  if (BOT_USERNAME) return "https://t.me/" + BOT_USERNAME + "/" + MINIAPP_NAME;
  return "";
}
// Foydalanuvchi kiritgan manzilni "https://domen" ko'rinishiga keltiradi (yo'l, so'rov
// qatori, oxirgi "/" tashlanadi). Yaroqsiz bo'lsa "" qaytaradi.
function normalizeAppUrl(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch (e) { return ""; }
  if (u.protocol !== "https:") return "";      // Telegram mini-ilova va webhook faqat https
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(u.hostname)) return "";
  return "https://" + u.hostname.toLowerCase() + (u.port && u.port !== "443" ? ":" + u.port : "");
}
/* Manzil rostdan SHU serverga olib keladimi — /api/health ni tashqi manzil orqali
   so'rab tekshiramiz. Xato yozilgan yoki boshqa saytga qarab turgan manzilni
   saqlab qo'yib, botni butunlay buzib qo'ymaslik uchun. */
function probeAppUrl(base) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(Object.assign({ ms: Date.now() - t0 }, r)); } };
    try {
      const req = https.get(base + "/api/health", { timeout: 10000 }, r => {
        let b = ""; r.on("data", c => { if (b.length < 4096) b += c; });
        r.on("end", () => {
          let j = null; try { j = JSON.parse(b); } catch (e) {}
          if (r.statusCode === 200 && j && j.app === "verion-shop") finish({ ok: true, build: j.build, same: j.instance === INSTANCE_ID });
          else finish({ ok: false, error: "bu manzilda Verion Shop serveri javob bermadi (HTTP " + r.statusCode + ")" });
        });
      });
      req.on("timeout", () => { req.destroy(); finish({ ok: false, error: "javob kelmadi (10 soniya) — domen ochilmayapti" }); });
      req.on("error", e => finish({ ok: false, error: e.code === "ENOTFOUND" ? "domen topilmadi (DNS)" : (e.code || e.message) }));
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}
/* Chat pastidagi "Ilova" menyu tugmasini shu manzilga yo'naltiradi (BotFather'dagi
   Menu Button bilan bir xil narsa — chat_id'siz chaqirilsa barcha foydalanuvchilar
   uchun standart tugma o'zgaradi). Tugma matni avvalgisi bo'lsa saqlanadi. */
async function syncMenuButton(base) {
  if (!BOT_TOKEN || !base) return { ok: false, error: "manzil yo'q" };
  let text = "Ilova";
  try {
    const cur = await tgApiPost("getChatMenuButton", {});
    const mb = cur && cur.ok && cur.result;
    if (mb && mb.type === "web_app" && mb.text) text = mb.text;
  } catch (e) {}
  try {
    const r = await tgApiPost("setChatMenuButton", { menu_button: { type: "web_app", text, web_app: { url: base } } });
    return r && r.ok ? { ok: true, text } : { ok: false, error: (r && r.description) || "Telegram rad etdi" };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Ilovaga "start bosish" uchun havola: foydalanuvchi bosganda bot chati ochiladi va
// Telegram /start ni o'zi yuboradi (avval boshlagan bo'lsa ham).
function botStartLink(payload) {
  if (!BOT_USERNAME) return "";
  return "https://t.me/" + BOT_USERNAME + (payload ? "?start=" + encodeURIComponent(payload) : "");
}
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const DEFAULT_GREETING = "👋 Xush kelibsiz, {name} ✌️\n\n"
  + "Verion Shop — o'yin donatlari, obunalar va raqamli xizmatlar bitta joyda.\n"
  + "Buyurtma bir daqiqada, yetkazish avtomatik.\n\n"
  + "⚡️ Tez, arzon va ishonchli.\n\n"
  + "🙏 Bizni tanlaganingiz uchun rahmat!";
function greetingHtml(from) {
  const c = botCfg();
  const name = ((from.first_name || "") + " " + (from.last_name || "")).trim() || from.username || "do'stim";
  const raw = (c.greeting && c.greeting.trim()) ? c.greeting : DEFAULT_GREETING;
  // Matnni admin yozadi — HTML sifatida emas, oddiy matn sifatida qaraymiz; faqat
  // {name} kabi o'rin egallovchilar almashtiriladi va <b> bilan qalinlashtiriladi.
  return escHtml(raw)
    .replace(/\{name\}/g, "<b>" + escHtml(name) + "</b>")
    .replace(/\{username\}/g, escHtml(from.username ? "@" + from.username : ""))
    .replace(/\{id\}/g, String(from.id));
}
/* Tugmalar joylashuvi: tepada bitta keng "Ilovani ochish", ostida qolganlari
   ikkitadan yonma-yon. Qo'llanma havolasi bo'sh bo'lsa — o'sha tugma umuman
   chiqmaydi va pastki qator "Kanal + Yordam" bo'lib qoladi (jami 3 ta tugma). */
function startKeyboard() {
  const c = botCfg();
  const base = appOpenUrl();
  const rows = [];
  const app = miniAppUrl();
  if (app) {
    // web_app tugmasi ilovani to'g'ridan-to'g'ri Telegram ichida ochadi (imzo bilan).
    rows.push([base
      ? { text: "📱 Ilovani ochish", web_app: { url: base } }
      : { text: "📱 Ilovani ochish", url: app }]);
  }
  const extra = [];
  if (c.channelUrl) extra.push({ text: "Kanal", url: c.channelUrl });
  if (c.guideUrl) extra.push({ text: "Qo'llanma", url: c.guideUrl });
  if (SUPPORT_USERNAME) extra.push({ text: "🎧 Yordam", url: "https://t.me/" + String(SUPPORT_USERNAME).replace(/^@/, "") });
  for (let i = 0; i < extra.length; i += 2) rows.push(extra.slice(i, i + 2));
  return rows.length ? { inline_keyboard: rows } : undefined;
}
// Banner rasmni yuboradi. Birinchi safar fayl yuklanadi, Telegram bergan file_id
// saqlanadi va keyingi safar faqat o'sha satr yuboriladi (tez va trafiksiz).
// Banner faylining "imzosi" (hajm + o'zgartirilgan vaqti). Rasmni almashtirib
// deploy qilinganda file_id keshi o'z-o'zidan bekor bo'ladi — aks holda Telegram
// eski rasmni ko'rsatib turaverardi.
function bannerSig() {
  try { const st = fs.statSync(BANNER_FILE); return st.size + "-" + Math.floor(st.mtimeMs); }
  catch (e) { return ""; }
}
async function sendStartCard(chatId, captionHtml) {
  const c = botCfg();
  const kb = startKeyboard();
  const sig = bannerSig();
  if (c.bannerFileId && c.bannerSig !== sig) { c.bannerFileId = ""; save(); }
  if (c.bannerFileId) {
    const r = await tgApiPost("sendPhoto", {
      chat_id: chatId, photo: c.bannerFileId, caption: captionHtml,
      parse_mode: "HTML", reply_markup: kb
    });
    if (r && r.ok) return r;
    c.bannerFileId = ""; // file_id eskirgan bo'lsa — qaytadan yuklaymiz
  }
  let buf = null;
  try { buf = fs.readFileSync(BANNER_FILE); } catch (e) {}
  if (buf) {
    try {
      const r = await tgSendMediaMultipartKb(chatId, buf, captionHtml, kb);
      const ph = r && r.result && r.result.photo;
      if (ph && ph.length) { c.bannerFileId = ph[ph.length - 1].file_id; c.bannerSig = sig; save(); }
      return r;
    } catch (e) { /* rasm ketmasa — pastda oddiy matn yuboriladi */ }
  }
  return tgApiPost("sendMessage", { chat_id: chatId, text: captionHtml, parse_mode: "HTML", reply_markup: kb });
}
// tgSendMediaMultipart bilan bir xil, faqat inline tugmalar ham biriktiriladi.
function tgSendMediaMultipartKb(chatId, buffer, captionHtml, keyboard) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN || !chatId) return reject(new Error("no bot/chat"));
    const boundary = "----VerionStart" + crypto.randomBytes(10).toString("hex");
    const parts = [];
    const field_ = (name, val) => parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, "utf8"));
    field_("chat_id", chatId);
    if (captionHtml) { field_("caption", captionHtml); field_("parse_mode", "HTML"); }
    if (keyboard) field_("reply_markup", JSON.stringify(keyboard));
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="start.png"\r\nContent-Type: image/png\r\n\r\n`, "utf8"));
    const body = Buffer.concat([...parts, buffer, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
    const req = https.request({
      hostname: "api.telegram.org", path: "/bot" + BOT_TOKEN + "/sendPhoto", method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length }
    }, r => {
      let out = ""; r.on("data", c => out += c);
      r.on("end", () => {
        try { const j = JSON.parse(out); j.ok ? resolve(j) : reject(new Error(j.description || "telegram_error")); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}
// Foydalanuvchini "botni ishga tushirgan" deb belgilaydi (ilova to'sig'i shunga qaraydi).
function markStarted(from) {
  const acc = user(from);
  const first = acc.started !== true;
  acc.started = true;
  if (first) acc.startedTs = Date.now();
  save();
  return acc;
}
async function handleBotUpdate(upd) {
  // AI yordamchining «✅ Tasdiqlash» tugmalari
  if (upd && upd.callback_query) {
    try { if (AI && await AI.onCustomerCallback(upd.callback_query)) return; } catch (e) { console.log("[ai] callback xato: " + e.message); }
    tgApiPost("answerCallbackQuery", { callback_query_id: upd.callback_query.id }).catch(() => {});
    return;
  }
  const msg = upd && (upd.message || upd.edited_message);
  if (!msg || !msg.from || msg.from.is_bot) return;
  if (!msg.chat || msg.chat.type !== "private") return;   // guruh/kanal xabarlariga aralashmaymiz
  const from = msg.from;
  const acc = markStarted(from);
  const text = String(msg.text || "").trim();

  if (/^\/start(\s|$)/i.test(text)) {
    const payload = text.slice(6).trim();
    // Referal havolasi (t.me/bot?start=ref_123) — faqat YANGI foydalanuvchi uchun.
    const mref = /^ref_(\d+)$/.exec(payload);
    if (mref && !acc.referredBy) {
      const refUid = Number(mref[1]);
      if (refUid && refUid !== from.id) { acc.referredBy = refUid; save(); }
    }
    await sendStartCard(from.id, greetingHtml(from));
    return;
  }
  // Adminlar uchun: /admin — admin panel tugmasi; /adminbot TOKEN — admin botni ulash.
  // Ilova eski (keshdagi) versiyada qolib ketsa ham shu yerdan kirish mumkin.
  if (ADMIN_IDS.indexOf(from.id) !== -1 && /^\/(admin|adminbot)(@\w+)?(\s|$)/i.test(text)) {
    const isTokenCmd = /^\/adminbot/i.test(text);
    const arg = text.replace(/^\/\w+(@\w+)?\s*/, "").trim();
    if (isTokenCmd && arg) {
      // Token yozilgan xabarni chatdan o'chiramiz — ekranda ochiq qolmasin.
      tgApiPost("deleteMessage", { chat_id: from.id, message_id: msg.message_id }).catch(() => {});
      const err = setAdminBotToken(arg);
      if (err) { await tgApiPost("sendMessage", { chat_id: from.id, text: "⚠️ " + err }); return; }
      const st = await ADMINBOT.start();
      await tgApiPost("sendMessage", { chat_id: from.id, text: st.active
        ? "✅ Admin bot ulandi: @" + st.username + "\nEndi o'sha botga kirib /start bosing. (Token yozilgan xabaringiz o'chirildi.)"
        : "⚠️ Admin bot ishga tushmadi: " + (st.error || "noma'lum xato") });
      return;
    }
    const ab = ADMINBOT.status();
    const base = publicBase();
    const kb = /^https:\/\//.test(base) ? { inline_keyboard: [[{ text: "🛠 Admin panelni ochish", web_app: { url: base + "/?admin=1" } }]].concat(
      ab.active && ab.username ? [[{ text: "🛡 Admin botni ochish", url: "https://t.me/" + ab.username }]] : []) } : undefined;
    await tgApiPost("sendMessage", { chat_id: from.id, reply_markup: kb, text:
      "🛠 Admin · versiya " + BUILD + "\n\n"
      + (ab.active ? "🛡 Admin bot ishlayapti: @" + ab.username
        : "🛡 Admin bot ulanmagan.\nUlash: @BotFather → /newbot → yangi bot oching, keyin shu yerga yuboring:\n/adminbot TOKEN\n(token yozilgan xabar avtomatik o'chiriladi)")
      + (kb ? "" : "\n\n⚠️ Ilova manzili hali aniqlanmagan — admin panel tugmasi chiqmadi.") });
    return;
  }
  // AI yordamchi yoqilgan bo'lsa — u javob beradi (yoki operator rejimida adminga uzatiladi).
  try { if (AI && !upd.edited_message && AI.onCustomerMessage(from, text)) return; } catch (e) { console.log("[ai] xato: " + e.message); }
  // Boshqa har qanday xabar — qisqa javob va ilovaga tugma (bot hech qachon jim qolmaydi).
  await tgApiPost("sendMessage", {
    chat_id: from.id,
    text: "Buyurtma berish uchun ilovani oching 👇",
    reply_markup: startKeyboard()
  });
}
/* Webhook'ni Telegram'da o'rnatish. Odatda hech narsa qilish shart emas: server
   ko'tarilganda o'zi tekshiradi va kerak bo'lsa o'rnatadi. Agar botga ALLAQACHON
   boshqa manzil ulangan bo'lsa — jimgina bosib olmaymiz, faqat ogohlantiramiz
   (admin panelidagi "Webhookni ulash" tugmasi majburan qayta ulaydi). */
const DELIVERY_ERR_WINDOW = 30 * 60 * 1000;   // shuncha vaqt ichidagi xato "hozirgi muammo" hisoblanadi
// Webhook o'rnatilgandan keyin shuncha vaqtdan so'ng "Telegram rostdan yetib
// keldimi?" deb tekshiriladi. Yangi o'rnatilgan webhook'da xato tarixi hali
// bo'lmaydi, shuning uchun darhol emas — bir daqiqacha kutiladi.
const HOOK_VERIFY_MS = Number(process.env.BOT_HOOK_VERIFY_MS || 75000);
async function ensureBotWebhook(force) {
  if (!BOT_TOKEN) return { ok: false, reason: "no_token" };
  const base = publicBase();
  if (!base) return { ok: false, reason: "no_url" };
  const want = base + "/api/tg-webhook";
  let cur = "", info = null;
  try {
    const j = await tgApiPost("getWebhookInfo", {});
    info = (j && j.ok && j.result) || {};
    cur = info.url || "";
  } catch (e) { return { ok: false, reason: "api_error", error: e.message }; }
  // Telegram bizga yetib kelolmayaptimi? (masalan domen tashqaridan ochilmasa —
  // "Connection timed out"). Shu holat polling rejimiga o'tish uchun signal.
  const errAge = info.last_error_date ? (Date.now() - info.last_error_date * 1000) : Infinity;
  const deliveryError = (cur === want && info.last_error_message && errAge < DELIVERY_ERR_WINDOW)
    ? info.last_error_message : "";
  // AI yordamchining "✅ Tasdiqlash" tugmalari uchun callback_query ham kerak — eski
  // (faqat "message") webhook bo'lsa qayta o'rnatamiz.
  const hasCb = Array.isArray(info.allowed_updates) && info.allowed_updates.indexOf("callback_query") !== -1;
  if (cur === want && !force && hasCb) return { ok: true, already: true, url: cur, deliveryError, pending: info.pending_update_count || 0 };
  if (cur && cur !== want && !force) return { ok: false, reason: "foreign", url: cur };
  try {
    const r = await tgApiPost("setWebhook", {
      url: want, secret_token: botHookSecret(),
      allowed_updates: ["message", "callback_query"], drop_pending_updates: false
    });
    if (r && r.ok) return { ok: true, url: want, replaced: cur || undefined, deliveryError: force ? "" : deliveryError };
    return { ok: false, reason: "set_failed", error: (r && r.description) || "" };
  } catch (e) { return { ok: false, reason: "api_error", error: e.message }; }
}

/* ---------- Polling (getUpdates) — webhook ishlamaganda zaxira yo'l ----------
   Webhook Telegram BIZGA murojaat qilishini talab qiladi. Agar domen tashqaridan
   ochilmasa (Telegram "Connection timed out" deydi), bot butunlay jim qoladi.
   Polling teskari yo'nalishda ishlaydi: server O'ZI Telegram'dan xabarlarni
   so'rab turadi. Xabar yuborish allaqachon ishlayotgan bo'lsa, polling ham
   ishlaydi — ya'ni bu holatda bot har doim javob beradi. */
let POLLING = false, POLL_OFFSET = 0, POLL_REASON = "";
async function pollLoop() {
  while (POLLING) {
    let r = null;
    try {
      r = await tgApiPost("getUpdates", { offset: POLL_OFFSET, timeout: 25, allowed_updates: ["message", "callback_query"] });
    } catch (e) { await sleep(5000); continue; }
    if (r && r.ok && Array.isArray(r.result)) {
      for (const u of r.result) {
        POLL_OFFSET = (u.update_id || 0) + 1;
        try { await handleBotUpdate(u); } catch (e) { console.log("[bot] update xato: " + e.message); }
      }
      continue;                                   // darhol keyingi so'rov (long polling)
    }
    // 409 = webhook hali o'chmagan yoki boshqa nusxa ham so'rab turibdi
    if (r && r.error_code === 409) { try { await tgApiPost("deleteWebhook", {}); } catch (e) {} await sleep(5000); }
    else await sleep(3000);
  }
}
async function startPolling(reason) {
  if (POLLING) return;
  POLLING = true; POLL_REASON = reason || "";
  console.log("[bot] polling rejimi yoqildi" + (reason ? " (" + reason + ")" : ""));
  try { await tgApiPost("deleteWebhook", { drop_pending_updates: false }); } catch (e) {}
  pollLoop();
}
function stopPolling() { POLLING = false; POLL_REASON = ""; }

let hookVerifyT = null;
function scheduleHookVerify() {
  clearTimeout(hookVerifyT);
  hookVerifyT = setTimeout(() => {
    ensureBotConnection(false).then(x => reportWebhook(x, true)).catch(() => {});
  }, HOOK_VERIFY_MS);
  if (hookVerifyT.unref) hookVerifyT.unref();
}
/* Ulanishni ta'minlaydi: avval webhook, u ishlamasa — polling.
   c.mode: "auto" (standart) | "webhook" | "polling". */
async function ensureBotConnection(force) {
  if (!BOT_TOKEN) return { ok: false, reason: "no_token" };
  const c = botCfg();
  const mode = c.mode || "auto";
  if (force) { c.autoPolling = false; save(); stopPolling(); }
  if (mode === "polling") { await startPolling("qo'lda tanlandi"); return { ok: true, mode: "polling" }; }
  if (mode === "auto" && c.autoPolling && !force) { await startPolling(c.autoPollingWhy || "avto"); return { ok: true, mode: "polling", auto: true, why: c.autoPollingWhy || "" }; }

  const r = await ensureBotWebhook(force);
  if (r.ok && !r.deliveryError) {
    stopPolling();
    // Endigina o'rnatildi — bir daqiqadan keyin Telegram yetib kela oldimi, tekshiramiz.
    if (!r.already) scheduleHookVerify();
    return Object.assign({ mode: "webhook" }, r);
  }
  if (mode === "webhook") return Object.assign({ mode: "webhook" }, r);   // majburiy webhook — pollingga o'tmaymiz

  // "auto": webhook ulanmadi yoki Telegram yetib kelolmayapti → polling
  const WHY_UZ = { no_url: "ilova manzili noma'lum", set_failed: "webhook o'rnatilmadi", api_error: "Telegram javob bermadi" };
  const why = r.deliveryError || r.error || WHY_UZ[r.reason] || r.reason || "";
  if (r.reason === "foreign") return Object.assign({ mode: "webhook" }, r); // begona webhook — admin hal qilsin
  c.autoPolling = true; c.autoPollingWhy = why; save();
  await startPolling(why);
  return { ok: true, mode: "polling", auto: true, why, switchedFrom: r };
}
/* Foydalanuvchi botni ilgari ishga tushirganmi — jimgina tekshirish.
   "typing" ko'rsatkichi yuboriladi: hech qanday xabar chiqmaydi, lekin bot chatni
   ocholmasa Telegram xato qaytaradi. Shu tufayli ESKI mijozlar (allaqachon start
   bosganlar) to'siqni umuman ko'rmaydi. */
/* Webhook holatini davriy tekshirib turadi va o'zi tuzatadi. Boot paytidagi
   bitta urinish yetarli emas edi: o'sha payt tarmoq uzilsa yoki ilova manzili
   hali noma'lum bo'lsa, bot butunlay jim qolib ketardi va buni hech kim
   bilmasdi. Endi holat o'zgarganda log yoziladi va muammo bo'lsa adminga
   Telegram orqali BIR marta xabar boradi (har qayta ishga tushishda emas). */
let lastHookState = "";
function reportWebhook(r, quiet) {
  const state = (r.mode || "") + "|" + (r.ok ? "ok:" + (r.url || r.why || "") : (r.reason + ":" + (r.url || r.error || "")));
  if (state === lastHookState) return;
  lastHookState = state;
  if (r.mode === "polling") console.log("[bot] ulanish: POLLING" + (r.why ? " (webhook ishlamadi: " + r.why + ")" : ""));
  else if (r.ok) console.log("[bot] webhook " + (r.already ? "allaqachon ulangan" : "ulandi") + ": " + r.url);
  else if (r.reason === "no_url") console.log("[bot] ilova manzili hali noma'lum — admin panelni bir marta oching yoki PUBLIC_URL qo'shing");
  else if (r.reason === "foreign") console.log("[bot] webhook BOSHQA manzilga ulangan: " + r.url);
  else console.log("[bot] webhook xatosi: " + (r.error || r.reason));
  // Adminga xabar faqat bot ROSTDAN javob bera olmayotgan holatda (polling ham
  // ishlayotgan bo'lsa muammo yo'q — jimgina o'zi hal qilingan).
  if (quiet || r.ok || r.reason === "no_url" || r.reason === "no_token") return;
  const c = botCfg();
  if (c.hookAlert === state) return;            // bitta muammo haqida qayta-qayta yozmaymiz
  c.hookAlert = state; save();
  const msg = r.reason === "foreign"
    ? "⚠️ Bot /start ga javob bermayapti: webhook boshqa manzilga ulangan (" + r.url + ").\n"
      + "Admin panel → Bot va /start → «Webhookni qayta ulash»."
    : "⚠️ Botni Telegram'ga ulab bo'lmadi: " + (r.error || r.reason) + "\nAdmin panel → Bot va /start.";
  notifyAdmins(msg);
}
const probing = new Set();
function probeStarted(uid) {
  if (probing.has(uid)) return;
  probing.add(uid);
  tgApiPost("sendChatAction", { chat_id: uid, action: "typing" })
    .then(r => {
      const acc = DB.users[String(uid)];
      if (acc) { acc.started = !!(r && r.ok); save(); }
    })
    .catch(() => {})
    .then(() => probing.delete(uid));
}

// Har bir yangi buyurtmaga ketma-ket raqam beradi: 56, 57, 58... — hech qachon
// qaytarilmaydi va hech qachon orqaga siljimaydi (DB.orderSeq faylda saqlanadi).
function nextOrderSeq() { DB.orderSeq = (DB.orderSeq || 0) + 1; return DB.orderSeq; }
// Rasmdagi kabi formatda buyurtma xabarini tuzadi (mahsulot, mijoz, narx, sana, # raqam, holat).
function orderMessageText(o) {
  const dt = new Date(o.ts || Date.now());
  const dateStr = dt.toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent" }) + " " +
    dt.toLocaleTimeString("ru-RU", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });
  const who = o.uname ? ("@" + o.uname) : ("ID: " + o.uid);
  const priceStr = (Number(o.price) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
  // "Holat" (order status) — mijoz o'zbek va yer bo'lsa ham tushunishi uchun ikki tilda:
  const statusLine = o.status === "done" ? "✅ Muvaffaqiyatli / Successful"
    : o.status === "processing" ? "⏳ Bajarilmoqda / Processing"
    : o.status === "cancelled" ? "❌ Bekor qilindi / Cancelled"
    : "🕓 Kutilmoqda / Pending";
  // Bekor qilingan buyurtmada pul balansga qaytarilgan, shu sabab "to'landi" emas, "qaytarildi" deyiladi.
  const paidLine = o.status === "cancelled" ? "↩️ Qaytarildi / Refunded" : "✅ To'landi / Paid";
  const lines = [
    "🛍 " + o.item,
    "👤 " + who,
    // O'yin buyurtmasi: admin to'ldirishi uchun eng kerakli ma'lumot — o'yinchi ID'si.
    ...(o.game && o.game.accountText ? [(/@/.test(o.game.accountText) ? "📧 " : "🎮 ") + (o.game.fields || []).map(f => f.label).join(" / ") + ": " + o.game.accountText] : []),
    "💰 " + priceStr,
    "🕐 " + dateStr,
    "#️⃣ #" + o.seq,
    statusLine,
    paidLine
  ];
  return lines.join("\n");
}
/* ---------- Qaysi xabar qaysi kanalga ketishi ----------
   Har uchala kanal bir-biridan mustaqil: bo'sh qoldirilgani jimgina boshqasiga
   tushmaydi (ilgari shunday bo'lgani uchun to'lov so'rovlari buyurtma kanaliga
   aralashib ketgan edi). Yagona istisno — "yetkazilgan nusxasi": u tarixan
   buyurtma kanaliga yozilgan, shu sabab bo'sh bo'lsa o'sha yerda qoladi. */
function channelCfg() {
  if (!DB.settings) DB.settings = {};
  if (!DB.settings.channels) DB.settings.channels = { order: ENV_ORDER_CHAT_ID, topup: ENV_TOPUP_CHAT_ID, delivery: ENV_DELIVERY_CHAT_ID };
  return DB.settings.channels;
}
function chatIdOf(kind) { return String(channelCfg()[kind] || "").trim(); }
function orderChatId() { return chatIdOf("order"); }
function topupChatId() { return chatIdOf("topup"); }
function deliveryChatId() { return chatIdOf("delivery") || orderChatId(); }
// Faqat guruh/kanalga (mijozga qayta yubormasdan) — buyurtma holati keyinroq
// o'zgarganda (masalan admin "bajarildi" qilib qo'lda yetkazganda) kanaldagi
// yozuvni yangilab qo'yish uchun ishlatiladi, mijozga ikkinchi marta xabar bormasin.
function notifyOrderChannel(o) {
  try { if (ADMINBOT) ADMINBOT.onOrder(o, "update"); } catch (e) {}
  try { const cid = orderChatId(); if (cid) tgSend(cid, orderMessageText(o)); } catch (e) {}
}

/* ---------- Balansni to'ldirish so'rovlari — kanalga yuborish ----------
   TZ: "barcha to'ldirish so'rovlari kanalga yuborilib turishi kerak, o'z vaqti bilan,
   holati (kutilmoqda/tekshirilmoqda/tasdiqlangan/bekor qilingan) qanday bo'lsa shunday
   ko'rinsin". Har bir to'lov uchun bitta xabar yuboriladi va keyinchalik holat
   o'zgarganda (mijoz "to'ladim" bosganda, admin/SMS tasdiqlaganda yoki bekor
   qilinganda) O'SHA XABARNING O'ZI tahrirlanadi — kanal keraksiz xabarlar bilan
   to'lib ketmasligi uchun. Agar biror sabab bilan tahrirlab bo'lmasa (masalan xabar
   admin tomonidan qo'lda o'chirib yuborilgan bo'lsa), avtomatik yangi xabar yuboriladi.
   Har bir yozuvda p.chanMsgId (kanal xabari ID) saqlanadi. */
const CANCEL_REASON_LABEL = {
  timeout: "vaqt tugashi bilan avtomatik",
  user: "mijozning o'zi bekor qildi",
  admin: "admin tomonidan bekor qilindi",
  replaced: "mijoz yangi to'lov yaratgani uchun avtomatik bekor qilindi"
};
function topupStatusBlock(p) {
  if (p.status === "waiting") return ["🕓 Holat: Kutilmoqda / Pending", null];
  if (p.status === "checking") return ["🔎 Holat: Tekshirilmoqda / Checking", "Mijoz \"To'lov qildim\" tugmasini bosdi."];
  if (p.status === "done") {
    const who = p.confirmedBy === "sms" ? "avtomatik (SMS orqali)" : "admin tomonidan qo'lda";
    const timeStr = p.doneTs ? new Date(p.doneTs).toLocaleTimeString("ru-RU", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" }) : "";
    return ["✅ Holat: Tasdiqlandi / Confirmed", "Tasdiqlandi: " + who + (timeStr ? " — " + timeStr : "")];
  }
  if (p.status === "cancelled") {
    return ["❌ Holat: Bekor qilindi / Cancelled", "Sabab: " + (CANCEL_REASON_LABEL[p.cancelledBy] || "noma'lum")];
  }
  return ["Holat: " + p.status, null];
}
function topupMessageText(p) {
  const dt = new Date(p.ts || Date.now());
  const dateStr = dt.toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent" }) + " " +
    dt.toLocaleTimeString("ru-RU", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });
  const who = p.uname ? ("@" + p.uname) : ("ID: " + p.uid);
  const sumStr = (Number(p.amount) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
  const payStr = (Number(p.pay) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
  const [statusLine, extraLine] = topupStatusBlock(p);
  const lines = [
    "💳 Balansni to'ldirish so'rovi",
    "👤 " + who + " (ID: " + p.uid + ")",
    "💰 Summa: " + sumStr + (p.pay !== p.amount ? " (to'lash kerak: " + payStr + ")" : ""),
    p.method ? ("🏦 Usul: " + p.method) : null,
    "🕐 Yaratildi: " + dateStr,
    "#️⃣ " + p.id,
    statusLine,
    extraLine
  ].filter(Boolean);
  return lines.join("\n");
}
// Kanaldagi xabarni tahrirlaydi; agar mumkin bo'lmasa (masalan xabar topilmasa),
// yangi xabar yuborib, uning ID sini saqlaydi.
function notifyTopupChannel(p) {
  try { if (ADMINBOT) ADMINBOT.onPayment(p); } catch (e) {}
  try {
    const cid = topupChatId();
    if (!cid || !BOT_TOKEN) return;
    const text = topupMessageText(p);
    // Kanal almashtirilgan bo'lsa eski xabar ID'si yangi kanalda mavjud emas —
    // tahrirlash o'rniga yangi kanalga yangi xabar yuboriladi.
    if (p.chanMsgId && p.chanChatId && String(p.chanChatId) !== cid) { p.chanMsgId = 0; p.chanChatId = ""; }
    if (p.chanMsgId) {
      tgApiPost("editMessageText", { chat_id: cid, message_id: p.chanMsgId, text: text })
        .then(j => {
          if (j && j.ok) return;
          // "message is not modified" — e'tibor bermasa ham bo'ladi; boshqa xato bo'lsa yangi xabar yuboramiz.
          const desc = String((j && j.description) || "").toLowerCase();
          if (desc.indexOf("not modified") !== -1) return;
          return tgApiPost("sendMessage", { chat_id: cid, text: text }).then(j2 => {
            if (j2 && j2.ok && j2.result) { p.chanMsgId = j2.result.message_id; p.chanChatId = cid; save(); }
          });
        }).catch(() => {});
    } else {
      tgApiPost("sendMessage", { chat_id: cid, text: text }).then(j => {
        if (j && j.ok && j.result) { p.chanMsgId = j.result.message_id; p.chanChatId = cid; save(); }
      }).catch(() => {});
    }
  } catch (e) {}
}
// Yetkazilgan (delivered) mahsulot matnini (login/parol/link va h.k.) "yetkazilganlar"
// kanaliga yozib qo'yadi — o.delivered bo'sh bo'lsa hech narsa qilmaydi. Juda uzun bo'lsa
// (masalan bir nechta dona birga sotilgan bo'lsa) — xabar o'rniga .txt fayl qilib yuboriladi
// (deliverStockToCustomer'dagi bilan bir xil chegara/mantiq).
function deliveryLogText(o) {
  const dt = new Date(o.ts || Date.now());
  const dateStr = dt.toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent" }) + " " +
    dt.toLocaleTimeString("ru-RU", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });
  const who = o.uname ? ("@" + o.uname) : ("ID: " + o.uid);
  const priceStr = (Number(o.price) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
  return "🧾 Buyurtma #" + o.seq + "\n" +
    "👤 " + who + " (ID: " + o.uid + ")\n" +
    "🛍 " + o.item + "\n" +
    "💰 " + priceStr + "\n" +
    "🕐 " + dateStr + "\n\n" +
    "📦 Yetkazilgan:\n" + (o.delivered || "—");
}
function logDeliveryToChannel(o) {
  try {
    const cid = deliveryChatId();
    if (!cid || !o || !o.delivered) return;
    const text = deliveryLogText(o);
    if (text.length <= TG_TEXT_SAFE_LIMIT) { tgSend(cid, text); return; }
    const buf = Buffer.from(text, "utf8");
    tgSendDocument(cid, buf, "buyurtma-" + o.seq + ".txt", "🧾 Buyurtma #" + o.seq + " — yetkazilgan mahsulot")
      .catch(() => tgSend(cid, text.slice(0, TG_TEXT_SAFE_LIMIT - 60) + "\n\n… (qisqartirildi, to'liqi admin panelda)"));
  } catch (e) {}
}
// Buyurtma birinchi marta yaratilganda shu xabarni: 1) buyurtmalar kanaliga,
// 2) mijozning o'ziga (o.uid) yuboradi — ikkalasi bir xil, rasmdagi kabi formatda.
function notifyOrder(o) {
  try { if (ADMINBOT) ADMINBOT.onOrder(o, "new"); } catch (e) {}
  try {
    const text = orderMessageText(o);
    const cid = orderChatId();
    if (cid) tgSend(cid, text);
    tgSend(o.uid, text);
  } catch (e) {}
}
// Zaxiradan (stock) yetkazilgan mahsulot(lar)ni (login/parol, kod va h.k.) mijozga
// bot orqali ham yuboradi. Bir nechta dona (max 10) birgalikda sotib olinsa,
// hammasi BITTA xabarda (yoki matn juda uzun bo'lsa BITTA .txt faylda) ketadi —
// mijoz alohida-alohida emas, bir joydan hammasini nusxalab/ochib ola oladi.
// Telegram oddiy xabarning belgi chegarasi ~4096 — shu sabab xavfsiz chegara sifatida
// 3500 belgi olinadi, undan oshsa fayl (hujjat) ko'rinishida yuboriladi.
const TG_TEXT_SAFE_LIMIT = 3500;
function deliverStockToCustomer(o, title) {
  try {
    if (!o.delivered || !o.uid) return;
    const header = "🔑 " + title + (o.quantity > 1 ? (" ×" + o.quantity) : "") + "\n\n";
    if ((header.length + o.delivered.length) <= TG_TEXT_SAFE_LIMIT) {
      tgSend(o.uid, header + o.delivered);
      return;
    }
    // Matn juda katta — oddiy xabarga sig'maydi, shu sabab .txt fayl qilib yuboriladi.
    o.deliveredAsFile = true;
    const buf = Buffer.from(o.delivered, "utf8");
    const filename = "buyurtma-" + o.seq + ".txt";
    tgSendDocument(o.uid, buf, filename, header.trim() + " (buyurtma #" + o.seq + ")")
      .catch(() => {
        // fayl yuborish muvaffaqiyatsiz bo'lsa — hech bo'lmasa qisqartirilgan matn ketsin
        tgSend(o.uid, header + o.delivered.slice(0, TG_TEXT_SAFE_LIMIT - 60) + "\n\n… (to'liq nusxasi ilovada, \"Buyurtmalarim\" bo'limida)");
      });
  } catch (e) {}
}

/* ---------- TZ band 6: sevimli mahsulotlar uchun push-bildirishnoma ----------
   Foydalanuvchi "sevimlilar"ga qo'shgan mahsulot (a) stock 0dan 1+ ga o'tsa yoki
   (b) narxi pasaysa — botdan shaxsiy xabar boradi. Bir xil o'zgarish uchun bitta
   foydalanuvchiga faqat bitta xabar (DB.notifState orqali kuzatiladi, keyingi
   o'zgarish sodir bo'lganda yana yuboriladi). Foydalanuvchi profilida
   "Bildirishnomalar"ni o'chirsa (acc.notifEnabled === false), unga umuman yuborilmaydi. */
function itemTitleOf(it) {
  if (!it) return "";
  return typeof it.title === "string" ? it.title : ((it.title && (it.title.uz || it.title.en)) || it.id || "");
}
function usersFavoriting(itemId) {
  return Object.keys(DB.users).filter(k => {
    const acc = DB.users[k];
    return acc && Array.isArray(acc.favorites) && acc.favorites.indexOf(itemId) !== -1 && acc.notifEnabled !== false;
  });
}
function notifyFavoriteEvent(itemId, kind, it, extra) {
  const title = itemTitleOf(it) || itemId;
  const link = miniAppLink("");
  const text = kind === "restock"
    ? "🔔 Sevimlilaringizdagi \"" + title + "\" mahsuloti qayta sotuvga chiqdi!"
    : "🔻 Sevimlilaringizdagi \"" + title + "\" mahsuloti narxi tushdi: " +
      (Number(extra) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
  const uids = usersFavoriting(itemId);
  for (const k of uids) tgSendButton(Number(k), text, "Ilovani ochish", link || undefined);
}
// Mahsulotning joriy (haqiqiy) zaxira soni: agar DB.stock orqali aniq inventar
// yuritilayotgan bo'lsa o'shani, aks holda katalogdagi "stock" maydonini oladi.
function effectiveStockOf(it) {
  if (!it) return 0;
  return DB.stock.hasOwnProperty(it.id) ? (DB.stock[it.id] || []).length : (Number(it.stock) || 0);
}
// Bitta mahsulot uchun stock/narx holatini joriy qiymat bilan solishtirib, kerak
// bo'lsa bildirishnoma yuboradi va DB.notifState'ni yangilaydi.
function checkFavoriteItemState(it) {
  if (!it || !it.id) return;
  const st = DB.notifState[it.id] || (DB.notifState[it.id] = {});
  const newStock = effectiveStockOf(it);
  const newPrice = Number(it.price) || 0;
  if (newStock > 0 && st.lastStockPositive === false) notifyFavoriteEvent(it.id, "restock", it);
  st.lastStockPositive = newStock > 0;
  if (st.lastPrice !== undefined && newPrice > 0 && newPrice < st.lastPrice) notifyFavoriteEvent(it.id, "price", it, newPrice);
  st.lastPrice = newPrice;
}
// Admin butun katalogni qayta saqlaganda (POST /api/catalog) — eski va yangi
// ro'yxatlarni solishtirib, narx/stock o'zgargan har bir mahsulot uchun tekshiradi.
function checkFavoriteChanges(prevArr, newArr) {
  try {
    for (const it of (newArr || [])) checkFavoriteItemState(it);
    save();
  } catch (e) {}
}
// DB.stock to'g'ridan-to'g'ri o'zgarganda (admin/stock/add va h.k.) — mos katalog
// yozuvini topib, xuddi shu tekshiruvni bajaradi.
function checkFavoriteStock(itemId) {
  try {
    const cat = catalogArr() || [];
    const it = cat.find(x => x.id === itemId);
    if (it) checkFavoriteItemState(it);
  } catch (e) {}
}
// fragment-api.uz bilan ishlash: Telegram Stars va Premium'ni istalgan @username'ga avtomatik sotib olish.
// ---------- Premium (custom) Telegram emoji — Bot API orqali fayl olib berish ----------
// Admin panelidan custom_emoji_id kiritilganda shu emojining video (webm) faylini
// Telegram serverlaridan yuklab olib, base64 data-url sifatida qaytaradi. Shu data-url
// mahsulot/guruh kartochkasining "video" maydoniga tushadi va butun ilova bo'ylab
// (mavjud video-render logikasi orqali) qayerda emoji ko'rsatilsa o'sha yerda ishlaydi.
function tgApiGet(method, params) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) return reject(new Error("BOT_TOKEN not set"));
    const qs = new URLSearchParams(params || {}).toString();
    https.get("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method + (qs ? "?" + qs : ""), r => {
      let body = "";
      r.on("data", c => body += c);
      r.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
function tgFileDownload(filePath) {
  return new Promise((resolve, reject) => {
    https.get("https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + filePath, r => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error("fetch_failed_" + r.statusCode)); }
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}
// Bir xil custom_emoji_id uchun fayl allaqachon diskda bormi — bo'lsa, Telegramga
// murojaat qilmasdan mos kind+URL qaytaramiz (video/image/lottie tartibida tekshiriladi).
function findCachedPremiumEmoji(emojiId) {
  const candidates = [
    { ext: ".webm", kind: "video" },
    { ext: ".webp", kind: "image" },
    { ext: ".json", kind: "lottie" }
  ];
  for (const c of candidates) {
    const file = emojiId + c.ext;
    if (fs.existsSync(path.join(PREMIUM_EMOJI_DIR, file))) return { kind: c.kind, url: "/premium-emoji/" + file };
  }
  return null;
}

// FRAGMENT_API_KEY Railway "Variables" orqali beriladi, kodga yozilmaydi (xavfsizlik uchun).
const FRAGMENT_API_KEY = process.env.FRAGMENT_API_KEY || "";
const FRAGMENT_HOST = "fragment-api.uz";
function fragmentCall(path, body) {
  return new Promise((resolve, reject) => {
    if (!FRAGMENT_API_KEY) return reject(Object.assign(new Error("FRAGMENT_API_KEY sozlanmagan"), { notSent: true }));
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
// Telegram Gift bot (Railway'dagi alohida Python xizmati) bilan bog'lanish.
// GIFT_BOT_URL va GIFT_BOT_SECRET Railway "Variables" orqali beriladi.
const GIFT_BOT_URL = process.env.GIFT_BOT_URL || "";
const GIFT_BOT_SECRET = process.env.GIFT_BOT_SECRET || "";
function giftBotCall(path, body) {
  return new Promise((resolve, reject) => {
    if (!GIFT_BOT_URL || !GIFT_BOT_SECRET) return reject(Object.assign(new Error("GIFT_BOT_URL/GIFT_BOT_SECRET sozlanmagan"), { notSent: true }));
    const data = JSON.stringify(body || {});
    const u = new URL(GIFT_BOT_URL + path);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "X-Secret": GIFT_BOT_SECRET,
        "Content-Length": Buffer.byteLength(data) },
      timeout: 30000
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
// ---------- SMM "Nakrutka" — JustAnotherPanel (JAP) API integratsiyasi ----------
// JAP_API_KEY Railway "Variables" orqali beriladi (hisobingiz sahifasida mavjud), kodga yozilmaydi.
// JAP hujjatiga ko'ra so'rov POST, x-www-form-urlencoded formatida yuboriladi, javob JSON qaytadi.
const JAP_API_KEY = process.env.JAP_API_KEY || "";
// JAP narxlari USD'da beriladi — so'mga shu kursda o'giramiz. VAQTINCHALIK qiymat —
// frontenddagi NAKRUTKA_USD_RATE bilan bir xil bo'lishi shart (keyinroq admin panelidan
// yoki avtomatik API'dan (masalan CBU.uz) boshqariladigan qilib almashtiriladi).
const NAKRUTKA_USD_RATE = Number(process.env.NAKRUTKA_USD_RATE) || 12700;
// ---------- Nakrutka: kurs, ustama (markup) va yashirilgan xizmatlar ----------
function nkSettings() { return DB.settings.nakrutka || (DB.settings.nakrutka = { usdRate: null, markupPercent: 0, hiddenServices: [] }); }
// Admin panelidan o'rnatilgan kurs bo'lsa o'shani, bo'lmasa ENV/standart qiymatni ishlatadi.
function nkUsdRate() { const v = Number(nkSettings().usdRate); return v > 0 ? v : NAKRUTKA_USD_RATE; }
function nkMarkupPct() { const v = Number(nkSettings().markupPercent); return v > 0 ? Math.min(v, 500) : 0; }
function nkIsHidden(serviceId) { const k = String(serviceId); return (nkSettings().hiddenServices || []).some(h => String(h) === k); }
// Faqat 4 ta asosiy ijtimoiy tarmoq mijozlarga ko'rsatiladi: Telegram, Instagram, TikTok, YouTube.
// Boshqa barcha tarmoqlar (Facebook, Twitter, Spotify va h.k.) "other" deb belgilanadi va
// /api/nakrutka/services javobidan to'liq chiqarib tashlanadi (faqat admin panelida ko'rinadi).
const NK_APPS = ["tg", "insta", "tiktok", "yt"];
function nkAppOf(svc) {
  const s = ((svc.category || "") + " " + (svc.name || "")).toLowerCase();
  if (s.indexOf("telegram") !== -1 || s.indexOf(" tg ") !== -1) return "tg";
  if (s.indexOf("instagram") !== -1 || s.indexOf("insta") !== -1) return "insta";
  if (s.indexOf("tiktok") !== -1 || s.indexOf("tik tok") !== -1) return "tiktok";
  if (s.indexOf("youtube") !== -1 || s.indexOf(" yt ") !== -1) return "yt";
  return "other";
}
// JAP xom narxiga (USD/1000) ustama qo'shadi — frontendga shu tayyor narx yuboriladi.
function nkAdjustedRate(rawRate) { return (Number(rawRate) || 0) * (1 + nkMarkupPct() / 100); }
// Miqdor va JAP xom narxidan yakuniy so'm narxini hisoblaydi (ustama + joriy kurs bilan).
function nkPriceUZS(rawRate, quantity) { return Math.round(quantity * nkAdjustedRate(rawRate) / 1000 * nkUsdRate()); }
// JAP'dan kelgan holat obyektini (masalan {status,remains,charge}) buyurtmaga qo'llaydi.
// "Completed" bo'lsa — referal bonusi beriladi va mijozga xabar yuboriladi;
// "Canceled/Refunded" bo'lsa — pul balansga bir martagina qaytariladi.
// Qaytish qiymati: holat "yakunlovchi" (done/cancelled) tomon o'zgargan bo'lsa true.
function applyJapStatusToOrder(o, j) {
  o.japStatus = j.status || null;
  o.japRemains = j.remains != null ? Number(j.remains) : null;
  o.japCharge = j.charge != null ? j.charge : null;
  const st = String(j.status || "").toLowerCase();
  if (st === "completed" && o.status !== "done") {
    o.status = "done"; o.doneTs = Date.now();
    creditReferralOnOrder(o);
    tgSend(o.uid, "✅ Nakrutka buyurtmangiz bajarildi: " + o.item);
    return true;
  }
  if ((st === "canceled" || st === "cancelled" || st === "refunded") && o.status !== "cancelled") {
    o.status = "cancelled";
    if (!o.refunded) {
      const acc = DB.users[String(o.uid)] || (DB.users[String(o.uid)] = { balance: 0 });
      acc.balance += o.price; o.refunded = true;
      tgSend(o.uid, "❌ Nakrutka buyurtmangiz bekor qilindi, mablag' balansingizga qaytarildi: " + o.item);
    }
    return true;
  }
  return false;
}
// Har bir foydalanuvchi "Holatni yangilash" tugmasini bosishini kutmasdan,
// serverning o'zi davriy ravishda barcha "processing" nakrutka buyurtmalarini
// JAP'dan tekshirib, holatini avtomatik yangilab turadi (JAP ko'p buyurtmani
// bitta so'rovda ham qaytara oladi — action:"status", orders:"id1,id2,...").
const NAKRUTKA_AUTO_REFRESH_MS = 7 * 60 * 1000; // har 7 daqiqada
function autoRefreshNakrutkaOrders() {
  // Har bir SMM panel (liniya) bo'yicha guruhlab, 100 tadan so'raladi.
  SMM.refreshAll(applyJapStatusToOrder).then(ch => { if (ch) save(); })
    .catch(e => console.log("[nakrutka-cron] xato: " + String((e && e.message) || e)));
}
setInterval(autoRefreshNakrutkaOrders, NAKRUTKA_AUTO_REFRESH_MS);
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
  try { if (ADMINBOT) ADMINBOT.onSms(entry); } catch (e) {}
  DB.smsLog.push(entry);
  if (DB.smsLog.length > SMS_LOG_MAX) DB.smsLog.splice(0, DB.smsLog.length - SMS_LOG_MAX);
  save();
}

/* ---------- telegram auth ---------- */
// initData imzosi to'g'ri chiqishi mumkin, lekin AUTH_DATE juda eski bo'lsa (masalan kimdir
// eski initData qiymatini ushlab qolib qayta-qayta yuborsa — "replay attack"), so'rov endi
// rad etiladi. Sabab (reason) req._authReason'ga yoziladi, shunda chaqiruvchi joy oddiy
// "auth" (imzo yo'q/noto'g'ri) bilan "expired" (imzo to'g'ri, lekin muddati o'tgan) ni
// bir-biridan ajratib, frontendga to'g'ri xabar qaytara oladi.
const INITDATA_MAX_AGE = 24 * 60 * 60; // 24 soat
/* Mini-ilova ikki botdan ochilishi mumkin: do'kon boti va admin bot ("Panelda ochish").
   Imzo qaysi bot tokeni bilan to'g'ri chiqsa — u._via shu ("main" | "admin"). */
function checkInitData(initData) {
  try {
    if (!initData || !BOT_TOKEN) return { reason: "auth", user: null };
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { reason: "auth", user: null };
    params.delete("hash");
    const dcs = [...params.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const sigOf = tok => crypto.createHmac("sha256", crypto.createHmac("sha256", "WebAppData").update(tok).digest()).update(dcs).digest("hex");
    let via = "";
    if (sigOf(BOT_TOKEN) === hash) via = "main";
    else { const at = adminBotToken(); if (at && sigOf(at) === hash) via = "admin"; }
    if (!via) return { reason: "auth", user: null };
    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate) return { reason: "auth", user: null };
    if ((Date.now() / 1000 - authDate) > INITDATA_MAX_AGE) return { reason: "expired", user: null };
    const u = JSON.parse(params.get("user") || "null");
    if (u) { u._startParam = params.get("start_param") || ""; u._via = via; }
    // Admin bot orqali ochilgan ilova — faqat adminlar uchun.
    if (via === "admin" && !(u && ADMIN_IDS.indexOf(Number(u.id)) !== -1)) return { reason: "auth", user: null };
    return { reason: "ok", user: u };
  } catch (e) { return { reason: "auth", user: null }; }
}
function auth(req) {
  const r = checkInitData(req.headers["x-init-data"] || "");
  req._authReason = r.reason;
  return r.user;
}
function isAdm(u) { return !!u && ADMIN_IDS.indexOf(u.id) !== -1; }

function send(res, code, obj, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}
// Rasm (base64) saqlangan katta javoblar uchun: ma'lumot o'zgarmagan bo'lsa
// to'liq payload'ni qayta yubormay, faqat "304 Not Modified" qaytaradi (deyarli 0 bayt).
// Ma'lumot yangilanган zahoti (admin yangi rasm yuklagandan keyin) ETag ham
// o'zgaradi, shuning uchun brauzer avtomatik eng so'nggi versiyani oladi —
// hech qanday eski/kesh rasm qolib ketmaydi.
function sendCached(req, res, obj) {
  const body = JSON.stringify(obj);
  const etag = '"' + crypto.createHash("sha1").update(body).digest("hex") + '"';
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { "ETag": etag, "Cache-Control": "no-cache" });
    return res.end();
  }
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache", // har doim serverdan so'raladi, lekin o'zgarmagan bo'lsa 304 keladi
    "ETag": etag
  });
  res.end(body);
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
/* Tashqi API orqali yetkaziladigan xaridlar (Fragment, Gift) uchun pul OLDINDAN band
   qilinadi: tekshiruv va yechish bitta sinxron qadamda. Ilgari pul API javobidan keyin
   yechilardi — bir vaqtda yuborilgan bir nechta so'rov hammasi tekshiruvdan o'tib,
   Stars/Premium bir necha marta yuborilar, balans esa minusga tushardi. */
function reserveBalance(acc, price) {
  if (!(price >= 0) || acc.balance < price) return false;
  acc.balance -= price; save();
  return true;
}
// So'rov yetkazib beruvchiga umuman yetib bormagan (sozlanmagan, DNS, ulanish rad etildi) — pulni qaytarish xavfsiz.
const NOT_SENT_CODES = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
function requestNotSent(e) { return !!(e && (e.notSent || NOT_SENT_CODES.indexOf(e.code) !== -1)); }
// API aloqasi uzildi — yetkazilgan-yetkazilmagani noma'lum. Pul band qolgan holda buyurtma
// "kutilmoqda" bo'ladi va adminga xabar ketadi: admin tekshirib "Bajarildi" yoki "Bekor
// qilish" (pul qaytadi) bosadi. Mijozdan pul ham, mahsulot ham yo'qolmaydi.
function unknownDeliveryOrder(u, it, item, price, errMsg, extra) {
  const o = Object.assign({ id: genId("VN"), seq: nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: it.id,
    item, price, status: "pending", ts: Date.now(), delivered: null, doneTs: null, deliveryUnknown: true }, extra || {});
  DB.orders.push(o); save(); notifyOrder(o);
  notifyAdmins("❓ #" + o.seq + " " + item + " — yetkazib beruvchi javob bermadi (" + String(errMsg || "").slice(0, 120) + ").\n"
    + "Yuborilgan bo'lishi mumkin: tekshirib «Bajarildi» yoki «Bekor qilish» (pul qaytadi) bosing.", { order: o });
  return o;
}
function catalogArr() {
  try { return sdb.loadCatalog(SQLITE_DB); } catch (e) { return null; }
}
// Kategoriya kartochkalari (Obuna/Promokod/Telegram/O'yinlar) uchun admin belgilagan
// nom va rasm — { obuna: {label:{uz,ru,en}, img:"data:..."}, telegram: {...}, ... }
function catMetaObj() {
  try { return sdb.kvGet(SQLITE_DB, "catmeta", {}); } catch (e) { return {}; }
}
// To'lov usuli ikonkalari / profil tugmalari uchun admin biriktirgan premium emoji'lar.
function uiEmojiObj() {
  try { return sdb.kvGet(SQLITE_DB, "uiemoji", {}); } catch (e) { return {}; }
}
// Nakrutka guruh rasmlari — kalit "app::xom_kategoriya" (masalan "tg::Telegram - Members"),
// til-mustaqil (JAP'dan doim inglizcha keladi), shu sababli barcha tillar uchun bir xil ishlaydi.
function nkCatMetaObj() {
  try { return sdb.kvGet(SQLITE_DB, "nkcatmeta", {}); } catch (e) { return {}; }
}
/* Foydalanuvchi bo'yicha indeks: /api/me har ochilishda 50 ming buyurtmani aylanib chiqmasligi
   uchun. Massivga faqat oxiridan qo'shiladi; massiv almashtirilsa (filter bilan o'chirish)
   yoki qisqarsa — indeks qaytadan quriladi. Kalit — x.uid ning o'zi (avvalgi x.uid === uid bilan bir xil). */
const UIDX = {};
function byUid(name, uid) {
  const arr = DB[name] || [];
  let ix = UIDX[name];
  if (!ix || ix.arr !== arr || arr.length < ix.len) ix = UIDX[name] = { arr, len: 0, map: new Map() };
  for (; ix.len < arr.length; ix.len++) {
    const x = arr[ix.len];
    let l = ix.map.get(x.uid); if (!l) ix.map.set(x.uid, l = []);
    l.push(x);
  }
  return ix.map.get(uid) || [];
}
let expireAt = 0;
const LB_CACHE = {};
function myView(uid) {
  if (Date.now() - expireAt > 10000) { expireAt = Date.now(); expireOld(); }
  const reviewedIds = new Set(byUid("reviews", uid).map(r => r.orderId));
  const acc = DB.users[String(uid)] || { balance: 0 };
  return {
    /* Admin ekanini SERVER hal qiladi. Ilgari HTML ichidagi ADMIN_IDS ro'yxati
       o'zi qaror qilardi — server bilan ro'yxat bir-biriga to'g'ri kelmay qolsa
       yoki Telegram eski HTML'ni keshdan bersa, admin panel ochilmay qolardi. */
    isAdmin: ADMIN_IDS.indexOf(Number(uid)) !== -1,
    build: BUILD,
    /* Botni ishga tushirganmi: true — bosgan, false — bosmagan, null — hali aniqlanmadi
       (bunday holatda ilova to'siq ko'rsatmaydi, bir-ikki soniyadan keyin qayta so'raydi). */
    started: acc.started === undefined ? null : acc.started === true,
    bot: {
      gate: !!(DB.settings.bot && DB.settings.bot.gate),
      username: BOT_USERNAME,
      startLink: botStartLink("app")
    },
    balance: acc.balance,
    favorites: Array.isArray(acc.favorites) ? acc.favorites : [],
    notifEnabled: acc.notifEnabled !== false, // TZ band 6: standart holatda yoqilgan
    payments: byUid("payments", uid).slice(-50).reverse(),
    orders: byUid("orders", uid).slice(-50).reverse()
      .map(o => Object.assign({}, o, { reviewed: reviewedIds.has(o.id) }))
  };
}

/* ---------- server ---------- */
/* O'yinlar do'koni (o'yinlar, paketlar, liniyalar) — alohida modulda: games.js */
const GAMES = require("./games.js")({
  getDB: () => DB, save, auth, isAdm, send, readBody, user, genId, nextOrderSeq,
  notifyOrder, notifyOrderChannel, tgSend, notifyAdmins, validatePromo, consumePromo,
  creditReferralOnOrder, creditLoyaltyOnOrder, ADMIN_IDS, DATA_DIR,
  publicBase: () => publicBase()   // G2Bulk callback_url uchun
});

// Nakrutka liniyalari (smm.js): JAP + boshqa SMM panellar.
const SMM = require("./smm.js")({
  getDB: () => DB, save, envKey: () => JAP_API_KEY, usdRate: () => nkUsdRate(), markup: () => nkMarkupPct()
});
// Moliya hisobotidagi "saytlardagi balans": o'yin liniyalari + SMM panellar.
function allLineBalances(force) {
  return Promise.all([GAMES.lineBalances(force).catch(() => []), SMM.balances().catch(() => [])]).then(([a, b]) => a.concat(b));
}
// Alohida admin bot (adminbot.js) — token bo'lsa ishga tushadi, bo'lmasa jim turadi.
ADMINBOT = require("./adminbot.js")({
  getDB: () => DB, save, ADMIN_IDS, token: adminBotToken,
  appUrl: () => publicBase(), shopUsername: () => BOT_USERNAME,
  finance: computeFinance, lineBalances: force => allLineBalances(force),
  paymentAction: adminPaymentAction, orderAction: adminOrderAction, balanceChange: adminBalanceChange,
  shopSend: tgSend, fallbackSend: tgSend, paymentText: topupMessageText, orderText: orderMessageText,
  aiAdmin: (id, text) => (AI ? AI.onAdminText(id, text) : Promise.resolve(null)),
  aiAdminOp: (tok, id) => (AI ? AI.runAdminOp(tok, id) : "AI ulanmagan"),
  aiRelease: uid => { if (AI) AI.release(uid); },
  // Operator javobi: Telegram'da ham, ilovadagi chat oynasida ham ko'rinadi.
  operatorReply: (uid, text) => { tgSend(uid, "👨‍💼 Operator: " + text); if (AI) { AI.log(uid, "admin", text); AI.dequeue(uid); } },
  aiOp: () => (AI ? AI.opPublic() : null),
  aiOpSet: b => (AI ? AI.opSet(b) : "AI yo'q"),
  aiOn: () => !!(AI && AI.ready()),
  statusInfo: () => ({
    build: BUILD,
    shopBot: (BOT_USERNAME ? "@" + BOT_USERNAME + " · " : "") + (POLLING ? "so'rov (polling) rejimida" : "webhook rejimida"),
    shopBotError: POLLING ? POLL_REASON : "",
    pendingPayments: DB.payments.filter(p => p.status === "waiting" || p.status === "checking").length,
    pendingOrders: DB.orders.filter(o => o.status === "pending" || o.status === "processing").length,
    lastSmsTs: DB.smsLog.length ? DB.smsLog[DB.smsLog.length - 1].ts : 0,
    lines: GAMES.store().lines.filter(l => l.type !== "manual").map(l => ({ name: l.name, enabled: !!l.enabled }))
  })
});
// AI yordamchi (ai.js) — Claude; kalit admin paneldan yoki ANTHROPIC_API_KEY.
var AI = require("./ai.js")({
  getDB: () => DB, save, games: GAMES, catalogArr, appUrl: () => publicBase(),
  shopApi: (method, payload) => tgApiPost(method, payload).catch(e => ({ ok: false, description: e.message })),
  supportUsername: () => SUPPORT_USERNAME,
  notifyHandoff: (from, reason, last) => ADMINBOT.customerEvent(from, "🙋 Mijoz operatorni so'radi" + (reason ? ": " + reason : ""), last, true),
  notifyQueued: (from, reason, last, st) => ADMINBOT.customerEvent(from, "⏳ Navbatga qo'shildi (operator " + (st.reason === "busy" ? "band" : "faol emas") + ")" + (reason ? ": " + reason : ""), last, true),
  knowledge: () => {
    const r = DB.settings.referral || {}, l = DB.settings.loyalty || {};
    return { minTopup: MIN_TOPUP, maxTopup: MAX_TOPUP, ttlMin: Math.round(TOPUP_TTL / 60000),
      referral: r.enabled !== false && Number(r.percent) > 0 ? Number(r.percent) : 0,
      loyalty: l.enabled && Array.isArray(l.tiers) ? l.tiers.map(t => t.name + " — " + Number(t.minSpent).toLocaleString("ru-RU").replace(/,/g, " ") + " so'mdan, " + (Number(t.percent) || 0) + "%").join("; ") : "" };
  },
  forwardToAdmins: (from, text) => ADMINBOT.customerEvent(from, "💬 Mijoz support'ga yozdi", text, false),
  finance: p => computeFinance(["today", "week", "month", "all"].indexOf(p) !== -1 ? p : "today"),
  findCustomer: q => ADMINBOT.findCustomerText(q),
  lineBalances: f => allLineBalances(f),
  setPackagePrice: (id, price) => {
    const p = GAMES.pkgById(id); if (!p) return { ok: false, error: "Paket topilmadi" };
    p.price = Math.round(price); save();
    const g = GAMES.gameById(p.gameId);
    return { ok: true, name: (g ? g.name + " — " : "") + p.name };
  },
  balanceChange: adminBalanceChange
});
setTimeout(() => {
  ADMINBOT.start().catch(e => console.log("[adminbot] " + e.message));
  if (BOT_TOKEN) for (const aid of ADMIN_IDS) tgApiPost("setMyCommands", { scope: { type: "chat", chat_id: aid }, commands: [
    { command: "start", description: "Boshlash" }, { command: "admin", description: "🛠 Admin panel" },
    { command: "adminbot", description: "🛡 Admin botni ulash (TOKEN bilan)" }] }).catch(() => {});
}, 1500).unref();

/* So'rovlar soniga cheklov: bitta IP'dan 10 soniyada 40 tadan ortiq POST bo'lsa — 429.
   Oddiy foydalanuvchi bunga yetmaydi; bot/skript bilan xarid, to'lov yoki SMS
   endpointlarini "bombardimon" qilishni to'xtatadi. Telegram webhook bundan mustasno. */
const RL = new Map(), RL_WINDOW = 10000, RL_MAX = Number(process.env.RATE_LIMIT_POST || 40);
function rateLimited(req) {
  // Kalit — imzosi to'g'ri Telegram foydalanuvchisi (mobil operatorlarda ko'p mijoz bitta IP'da
  // bo'ladi, IP bo'yicha cheklash ularni bir-biriga to'sib qo'yardi). Imzosiz so'rovlar — IP bo'yicha;
  // oxirgi qiymat Railway proksisi qo'shgani, birinchisini mijozning o'zi soxtalashtirishi mumkin.
  let key = "";
  if (req.headers["x-init-data"]) { const r = checkInitData(req.headers["x-init-data"]); if (r.user && r.user.id) key = "u" + r.user.id; }
  if (!key) key = "ip" + (String(req.headers["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean).pop() || (req.socket && req.socket.remoteAddress) || "?");
  const now = Date.now();
  let e = RL.get(key);
  if (!e || now - e.ts > RL_WINDOW) { e = { ts: now, n: 0 }; RL.set(key, e); }
  return ++e.n > RL_MAX;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of RL) if (now - e.ts > RL_WINDOW) RL.delete(k); }, 60000).unref();
// Maxfiy kalitlarni vaqtga bog'liq bo'lmagan usulda solishtirish.
function safeEq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const q = new URLSearchParams((req.url || "").split("?")[1] || "");
  const m = req.method;
  if (m === "POST" && url !== "/api/tg-webhook" && url.indexOf("/api/admin/") !== 0 && rateLimited(req)) return send(res, 429, { error: "too_many" });

  /* Ochiq holat tekshiruvi: domen ishlayaptimi va qaysi build turibdi — brauzerda
     https://<domen>/api/health ni ochib ko'rish mumkin. Admin manzilni saqlaganda
     server ham shu orqali o'zini tekshiradi. */
  if (url === "/api/health" && m === "GET") {
    return send(res, 200, { app: "verion-shop", ok: true, build: BUILD, instance: INSTANCE_ID, time: Date.now() });
  }

  // O'yinlar: /api/games*, /api/admin/games*, /gimg/* — modul o'zi javob beradi.
  if (GAMES.handle(req, res, url, m)) return;

  /* catalog (public read / admin write) */
  if (url === "/api/catalog" && m === "GET") {
    const c = catalogArr();
    return c ? sendCached(req, res, c) : send(res, 404, { error: "no catalog yet" });
  }
  if (url === "/api/catalog" && m === "POST") {
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set" });
    const u = auth(req);
    if (!isAdm(u)) return send(res, 403, { error: "not admin" });
    return readBody(req, res, arr => {
      if (!Array.isArray(arr) || !arr.length) return send(res, 400, { error: "invalid json" });
      const prevArr = catalogArr() || [];
      try {
        sdb.saveCatalog(SQLITE_DB, arr);
        checkFavoriteChanges(prevArr, arr); // TZ band 6: narx tushishi / qayta sotuvga chiqishi haqida xabar
        send(res, 200, { ok: true, items: arr.length });
      } catch (e) { send(res, 500, { error: "write failed" }); }
    });
  }

  if (url === "/api/category-meta" && m === "GET") {
    return sendCached(req, res, catMetaObj());
  }
  if (url === "/api/admin/category-meta" && m === "POST") {
    const u = auth(req);
    if (!isAdm(u)) return send(res, 403, { error: "not admin" });
    return readBody(req, res, obj => {
      if (!obj || typeof obj !== "object") return send(res, 400, { error: "invalid json" });
      try { sdb.kvSet(SQLITE_DB, "catmeta", obj); send(res, 200, { ok: true }); }
      catch (e) { send(res, 500, { error: "write failed" }); }
    });
  }

  // To'lov usullari (karta/bank ikonkalari) va profil bo'limi tugmalariga admin
  // biriktirgan premium emoji'lar ro'yxati — hammaga (mijozlarga ham) ochiq o'qish uchun.
  if (url === "/api/ui-emoji" && m === "GET") {
    return sendCached(req, res, uiEmojiObj());
  }
  // Butun obyekt bir yo'la almashtiriladi (frontend joriy holatni GET orqali olib,
  // kerakli slot(lar)ni o'zgartirib, to'liq obyektni qayta yuboradi — category-meta bilan bir xil naqsh).
  if (url === "/api/admin/ui-emoji" && m === "POST") {
    const u = auth(req);
    if (!isAdm(u)) return send(res, 403, { error: "not admin" });
    return readBody(req, res, obj => {
      if (!obj || typeof obj !== "object") return send(res, 400, { error: "invalid json" });
      try { sdb.kvSet(SQLITE_DB, "uiemoji", obj); send(res, 200, { ok: true }); }
      catch (e) { send(res, 500, { error: "write failed" }); }
    });
  }

  // Admin panelidan premium emoji ID kiritilganda chaqiriladi: Telegram Bot API orqali
  // shu custom emoji faylini topib qaytaradi. UCHTA format ham qo'llab-quvvatlanadi:
  //  - video (webm, animatsion)
  //  - statik (webp, oddiy rasm sifatida ko'rsatiladi)
  //  - eski Lottie (.tgs, gzip qilingan JSON animatsiya) — bu fayl serverda gunzip
  //    qilinib, xom JSON holida diskka (.json) saqlanadi; brauzerda lottie-web kutubxonasi
  //    orqali (URL'dan o'zi fetch qilib) render qilinadi.
  // Fayl base64 sifatida javobda QAYTARILMAYDI — diskka saqlanadi, javobda faqat qisqa URL
  // beriladi (katalog hajmi shishib ketmasligi uchun). Bir xil ID qayta so'ralsa, fayl
  // allaqachon diskda bo'lsa, Telegramga umuman murojaat qilinmaydi (tezroq javob).
  if (url === "/api/admin/premium-emoji" && m === "GET") {
    const u = auth(req);
    if (!isAdm(u)) return send(res, 403, { error: "not admin" });
    const emojiId = (q.get("id") || "").trim();
    if (!/^\d+$/.test(emojiId)) return send(res, 400, { error: "invalid_id" });
    const cached = findCachedPremiumEmoji(emojiId);
    if (cached) return send(res, 200, { ok: true, kind: cached.kind, url: cached.url, cached: true });
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set" });
    tgApiGet("getCustomEmojiStickers", { custom_emoji_ids: JSON.stringify([emojiId]) })
      .then(j => {
        if (!j.ok || !j.result || !j.result.length) { send(res, 404, { error: "emoji_not_found" }); return null; }
        const sticker = j.result[0];
        const isLottie = !!(sticker.is_animated && !sticker.is_video);
        return tgApiGet("getFile", { file_id: sticker.file_id }).then(fj => {
          if (!fj.ok || !fj.result || !fj.result.file_path) { send(res, 502, { error: "file_lookup_failed" }); return; }
          return tgFileDownload(fj.result.file_path).then(buf => {
            if (isLottie) {
              // .tgs = gzip qilingan Lottie JSON — shuni ochib, xom JSON matnini diskka yozamiz
              return zlib.gunzip(buf, (err, out) => {
                if (err) return send(res, 500, { error: "tgs_decode_failed" });
                const file = emojiId + ".json";
                fs.writeFile(path.join(PREMIUM_EMOJI_DIR, file), out, err2 => {
                  if (err2) return send(res, 500, { error: "write failed" });
                  send(res, 200, { ok: true, kind: "lottie", url: "/premium-emoji/" + file });
                });
              });
            }
            const kind = sticker.is_video ? "video" : "image";
            const ext = sticker.is_video ? ".webm" : ".webp";
            const file = emojiId + ext;
            fs.writeFile(path.join(PREMIUM_EMOJI_DIR, file), buf, err2 => {
              if (err2) return send(res, 500, { error: "write failed" });
              send(res, 200, { ok: true, kind, url: "/premium-emoji/" + file });
            });
          });
        });
      })
      .catch(e => send(res, 500, { error: e.message }));
    return;
  }
  // Diskdagi premium emoji fayllarini to'g'ridan-to'g'ri uzatadi. Fayl nomi ID asosida
  // qat'iy shakllangani va o'zgarmasligi sababli (bir xil ID = bir xil fayl, hech qachon
  // qayta yozilmaydi) — bir yillik "immutable" kesh sarlavhasi xavfsiz.
  if (url.indexOf("/premium-emoji/") === 0 && m === "GET") {
    const file = url.slice("/premium-emoji/".length);
    if (!/^[a-zA-Z0-9_-]+\.(webm|webp|json)$/.test(file)) return send(res, 400, { error: "bad file" });
    const full = path.join(PREMIUM_EMOJI_DIR, file);
    return fs.readFile(full, (err, buf) => {
      if (err) return send(res, 404, { error: "not found" });
      const ext = path.extname(file);
      const mime = ext === ".webm" ? "video/webm" : ext === ".webp" ? "image/webp" : "application/json; charset=utf-8";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
      res.end(buf);
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
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    const isNew = !DB.users[String(u.id)];
    const before = isNew ? "" : JSON.stringify(DB.users[String(u.id)]);
    const acc = user(u);
    if (isNew && u._startParam && /^ref_\d+$/.test(u._startParam)) {
      const refUid = Number(u._startParam.slice(4));
      if (refUid && refUid !== u.id) acc.referredBy = refUid;
    }
    // Botni ishga tushirgan-tushirmagani hali noma'lum bo'lsa — fonda jimgina
    // tekshiramiz. Javob shu so'rovni kutib turmaydi: started null qaytadi va
    // ilova bir-ikki soniyadan keyin qayta so'raganda aniq qiymatni oladi.
    if (acc.started === undefined) probeStarted(u.id);
    if (JSON.stringify(acc) !== before) save();
    const view = myView(u.id);
    view.via = u._via || "main";
    if (view.isAdmin) { const ab = ADMINBOT ? ADMINBOT.status() : {}; view.adminBot = { active: !!ab.active, username: ab.username || "" }; }
    return send(res, 200, view);
  }

  // Foydalanuvchining Telegram profil rasmini server orqali olib beradi,
  // shunda brauzer uni bir marta o'zida (localStorage) saqlab qo'yishi mumkin —
  // Telegram'ning vaqtinchalik photo_url havolasi keyinchalik ishlamay qolsa ham muammo bo'lmaydi.
  if (url === "/api/avatar" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
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
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
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
      shareText: settings.shareText || "",
      link: BOT_USERNAME ? ("https://t.me/" + BOT_USERNAME + appPart + "?startapp=ref_" + u.id) : "",
      invitedCount: invitedKeys.length,
      totalEarned: Number(myAcc.referralEarnedTotal) || 0,
      friends
    });
  }

  /* ===== promo-kod tekshirish (checkout, hali sarflamasdan) ===== */
  if (url === "/api/promo/check" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const cat = catalogArr();
      const it = cat && cat.find(x => x.id === b.itemId && x.active !== false);
      if (!it) return send(res, 404, { error: "no item" });
      const price = Math.round(Number(it.price) || 0);
      const quantity = Math.max(1, Math.min(10, Math.round(Number(b.quantity) || 1)));
      const subtotal = price * quantity;
      const r = validatePromo(b.code, u.id, subtotal);
      if (!r.ok) return send(res, 409, { error: "promo_invalid", reason: r.reason, minOrder: r.minOrder });
      return send(res, 200, { ok: true, code: r.promo.code, discount: r.discount, total: subtotal - r.discount });
    });
  }

  /* ===== sodiqlik dasturi — mening statusim ===== */
  if (url === "/api/loyalty" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    const ls = DB.settings.loyalty || {};
    const spent = userTotalSpent(u.id);
    const { tier, next } = loyaltyTierFor(spent);
    return send(res, 200, {
      enabled: !!ls.enabled, spent, tier: tier.name, percent: Number(tier.percent) || 0,
      next: next ? { name: next.name, minSpent: next.minSpent, remaining: Math.max(0, next.minSpent - spent) } : null,
      earnedTotal: Number((DB.users[String(u.id)] || {}).loyaltyEarnedTotal) || 0
    });
  }

  /* ===== Nakrutka (SMM) — xizmatlar ro'yxati + buyurtma berish ===== */
  // Yashirilgan xizmatlar chiqarib tashlanadi, narxga admin belgilagan ustama (markup)
  // qo'shiladi — frontendga tayyor (ustama bilan) narx va joriy kurs birga yuboriladi.
  if (url === "/api/nakrutka/services" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    SMM.allServices(true)
      .then(r => {
        if (!r.configured) return send(res, 503, { error: "jap_not_configured" });
        if (!r.list.length && r.errors.length) return send(res, 502, { error: "jap_failed", message: r.errors[0].error });
        // Faqat Telegram/Instagram/TikTok/YouTube xizmatlari mijozga chiqadi — qolgan
        // barcha tarmoqlar (masalan Facebook, Twitter, Spotify) bu yerda kesib tashlanadi.
        const visible = r.list.filter(s => !nkIsHidden(s.key))
          .map(s => Object.assign({ app: nkAppOf(s) }, s))
          .filter(s => NK_APPS.indexOf(s.app) !== -1)
          .map(s => ({ service: s.key, name: s.name, category: s.category, app: s.app,
            min: s.min, max: s.max, rate: SMM.clientRate(SMM.lineById(s.lineId), s) }));
        send(res, 200, { services: visible, usdRate: nkUsdRate(), catMeta: nkCatMetaObj() });
      })
      .catch(e => send(res, 502, { error: "jap_failed", message: String(e.message || e) }));
    return;
  }
  // Buyurtma berish: narx serverda qayta hisoblanadi (frontenddan kelgan narxga ishonilmaydi),
  // balans yetarli bo'lsagina JAP'ga haqiqiy buyurtma yuboriladi, shundan keyingina balansdan yechiladi.
  if (url === "/api/nakrutka/buy" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const key = b.service;
      const link = String(b.link || "").trim().slice(0, 500);
      const quantity = Math.round(Number(b.quantity) || 0);
      if (!SMM.parseKey(key) || !link || !quantity) return send(res, 400, { error: "invalid_input" });
      SMM.findService(key).then(found => {
        if (!found || nkIsHidden(found.key)) return send(res, 404, { error: "no_service" });
        const svc = found.svc;
        if (quantity < svc.min || quantity > svc.max)
          return send(res, 400, { error: "qty_range", min: svc.min, max: svc.max });
        const price = SMM.priceUZS(found.line, svc, quantity);
        const acc = user(u);
        if (acc.balance < price) return send(res, 402, { error: "balance", need: price - acc.balance });
        // Pul panelga yuborishdan OLDIN yechiladi (tekshiruv va yechish bitta sinxron qadamda).
        acc.balance -= price;
        const o = { id: genId("VN"), seq: nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: "nk_" + found.key,
          item: svc.name, price, status: "processing", ts: Date.now(),
          delivered: null, doneTs: null, japOrderId: null, japService: svc.service, smmLine: found.line.id, link, quantity };
        DB.orders.push(o); save();
        SMM.placeOrder(found, link, quantity).then(r => {
          if (r.state === "failed") {
            // Hech bir panel qabul qilmadi — buyurtma yaratilmagan: pulni qaytaramiz.
            DB.orders = DB.orders.filter(x => x !== o);
            acc.balance += price; save();
            return send(res, 502, { error: "jap_failed", message: r.message });
          }
          o.smmLine = r.lineId; o.japService = r.service;
          if (r.state === "accepted") {
            o.japOrderId = r.ref;
            if (r.backup) o.smmBackup = true;
            save(); notifyOrder(o); logDeliveryToChannel(o);
            if (r.backup) notifyAdmins("↪️ Nakrutka #" + o.seq + " zaxira liniyaga ketdi: " + r.lineName + "\nAsosiy rad etdi: " + (r.tried || []).join("; "));
            return send(res, 200, { ok: true, order: o, balance: acc.balance });
          }
          // Noaniq — panel buyurtmani yaratgan bo'lishi mumkin: qayta yubormaymiz, admin hal qiladi.
          o.smmUnknown = true; o.smmMessage = r.message; save();
          notifyOrder(o);
          notifyAdmins("❓ Nakrutka #" + o.seq + " " + o.item + " — " + r.lineName + " javobi tushunarsiz: " + r.message
            + "\nPanelda buyurtma yaratilgan bo'lishi mumkin. Panelda tekshiring; yaratilmagan bo'lsa Admin panel → Nakrutka → «Bekor qilish» (pul qaytadi). Ikkinchi marta yuborilmadi.");
          send(res, 200, { ok: true, order: o, balance: acc.balance });
        }).catch(e => {
          o.smmUnknown = true; o.smmMessage = String(e.message || e); save();
          notifyAdmins("❓ Nakrutka #" + o.seq + " — kutilmagan xato: " + o.smmMessage + ". Panelda tekshiring.");
          send(res, 200, { ok: true, order: o, balance: acc.balance });
        });
      }).catch(e => send(res, 502, { error: "jap_failed", message: String(e.message || e) }));
    });
  }

  // Bitta nakrutka buyurtmasining joriy holatini JAP'dan so'rab, mahalliy DB'ni yangilaydi.
  // "Completed" bo'lsa — referal bonusi beriladi; "Canceled/Refunded" bo'lsa — pul balansga qaytariladi (bir marta).
  if (url === "/api/nakrutka/order-status" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    const o = DB.orders.find(x => x.id === q.get("id") && x.uid === u.id);
    if (!o || !o.japOrderId) return send(res, 404, { error: "no_order" });
    SMM.status(o).then(j => {
      if (!j || j.error) return send(res, 502, { error: "jap_failed", message: (j && j.error) || "Panel javob bermadi" });
      applyJapStatusToOrder(o, j);
      save();
      const acc = user(u);
      send(res, 200, { ok: true, order: o, balance: acc.balance });
    }).catch(e => send(res, 502, { error: "jap_failed", message: String(e.message || e) }));
    return;
  }

  /* ===== Ilovadagi support chat (AI + operator, bot bilan bitta suhbat) ===== */
  if (url === "/api/support/history" && m === "GET") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return send(res, 200, Object.assign({ messages: AI.history(u.id, q.get("after")) }, AI.supportState(u.id)));
  }
  if (url === "/api/support/send" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const text = String((b && b.text) || "").trim();
      if (!text) return send(res, 400, { error: "empty" });
      user(u);
      // Javobni kutmaymiz — ilova /history orqali so'rab turadi ("yozmoqda…" ko'rsatadi).
      AI.reply(u, text, "app").catch(() => {});
      send(res, 200, { ok: true });
    });
  }
  if (url === "/api/support/confirm" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const r = AI.confirm(u, b && b.token);
      send(res, r.ok ? 200 : (r.code || 400), r.ok ? { ok: true, order: r.order, balance: r.balance, message: r.message } : { error: r.code === 402 ? "balance" : "failed", message: r.message, need: r.need });
    });
  }

  /* ===== Sevimlilar (wishlist) ===== */
  if (url === "/api/favorite" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
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

  // TZ band 6: foydalanuvchi profilidagi "Bildirishnomalar" yoqish/o'chirish tugmasi.
  if (url === "/api/notif-settings" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const acc = user(u);
      acc.notifEnabled = b.enabled !== false;
      save();
      send(res, 200, { ok: true, notifEnabled: acc.notifEnabled });
    });
  }


  // Xarid "done" bo'lgan buyurtmaga mijoz 1 marta sharh qoldirishi mumkin.
  if (url === "/api/review" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const stars = Math.max(1, Math.min(5, Math.round(Number(b.stars) || 0)));
      const text = String(b.text || "").trim().slice(0, 200);
      const o = DB.orders.find(x => x.id === b.orderId && x.uid === u.id);
      if (!o) return send(res, 404, { error: "no_order" });
      if (o.status !== "done") return send(res, 409, { error: "order_not_done" });
      if (DB.reviews.some(r => r.orderId === o.id)) return send(res, 409, { error: "already_reviewed" });
      const acc = user(u);
      // Sharh avval "pending" holatida saqlanadi — admin tasdiqlagandan keyingina
      // /api/reviews orqali sahifada ko'rinadi (moderatsiya qayta yoqildi).
      const rv = { id: genId("RV"), uid: u.id, name: (acc.name || u.first_name || "Mijoz").split(" ")[0],
        orderId: o.id, itemTitle: o.item, stars, text, ts: Date.now(), status: "pending" };
      DB.reviews.push(rv); save();
      send(res, 200, { ok: true, review: rv });
    });
  }
  // Bosh sahifadagi "Mijozlar fikri" uchun ochiq (auth shart emas) — faqat admin tasdiqlagan sharhlar.
  // Reyting (o'rtacha baho + soni) BARCHA tasdiqlangan sharhlar (matnli yoki faqat yulduzli) bo'yicha
  // hisoblanadi, lekin aylanadigan panelda faqat matni bor sharhlar ko'rsatiladi.
  if (url === "/api/reviews" && m === "GET") {
    const approved = DB.reviews.filter(r => r.status === "approved");
    const count = approved.length;
    const avg = count ? approved.reduce((s, r) => s + (r.stars || 0), 0) / count : 0;
    const list = approved.filter(r => r.text && r.text.trim()).slice(-40).reverse()
      .map(r => ({ name: r.name, itemTitle: r.itemTitle, stars: r.stars, text: r.text, ts: r.ts }));
    return send(res, 200, { reviews: list, stats: { count, avg } });
  }

  /* ===== Top donaterlar (reyting) ===== */
  // Faqat "done" buyurtmalar summasi bo'yicha, ochiq (auth shart emas).
  // Ism faqat "Ism F." formatida ko'rsatiladi, username hech qachon chiqmaydi.
  // Adminlar (ADMIN_IDS) reytingda hech qachon ko'rinmaydi.
  if (url === "/api/leaderboard" && m === "GET") {
    const period = q.get("period") || "all"; // today | week | month | all
    // Hamma buyurtmalarni aylanib chiqadi — natija 60 soniya keshlanadi (minglab ochiq ilova bir xil ro'yxatni so'raydi).
    const lbHit = LB_CACHE[period];
    if (lbHit && Date.now() - lbHit.at < 60000) return send(res, 200, lbHit.body);
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
    LB_CACHE[period] = { at: Date.now(), body: { period, leaderboard: rows } };
    return send(res, 200, LB_CACHE[period].body);
  }

  if (url === "/api/topup" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const amount = Math.round(Number(b.amount) || 0);
      const method = String(b.method || "");
      if (amount < MIN_TOPUP || amount > MAX_TOPUP) return send(res, 400, { error: "amount" });
      expireOld();
      // one active top-up per user
      for (const p of DB.payments)
        if (p.uid === u.id && (p.status === "waiting")) {
          p.status = "cancelled"; p.cancelledBy = "replaced"; notifyTopupChannel(p);
        }
      // unique payable amount: add smallest free delta (0..499 so'm)
      const active = new Set(DB.payments
        .filter(p => p.status === "waiting" || p.status === "checking").map(p => p.pay));
      let delta = 0; while (active.has(amount + delta) && delta < 500) delta++;
      const rec = { id: genId("TP"), uid: u.id, uname: u.username || null, type: "topup",
        amount, pay: amount + delta, method, status: "waiting", ts: Date.now() };
      user(u); DB.payments.push(rec); save();
      notifyTopupChannel(rec);
      // 4 daqiqadan keyin ham to'lov hali "waiting" bo'lib qolsa (ya'ni mijoz hali to'lamagan/
      // "To'lov qildim" bosmagan bo'lsa) — rasmdagi Sara Stars boti kabi eslatma yuboriladi,
      // pastida ilovani qayta ochadigan tugma bilan (ID ko'rsatilmaydi).
      setTimeout(() => {
        const p = DB.payments.find(x => x.id === rec.id);
        if (p && p.status === "waiting") {
          tgSendButton(p.uid,
            "⏳ To'lovingiz kutilmoqda\n\n" +
            "▪️ Buyurtma: Balansni to'ldirish\n" +
            "▪️ Summa: " + (Number(p.amount) || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm\n\n" +
            "Buyurtmangiz hali to'lanmadi. Yakunlash uchun quyidagi tugmani bosing 👇",
            "💳 To'lovni yakunlash", miniAppLink("pay_" + rec.id)
          );
        }
      }, PAYMENT_REMINDER_DELAY);
      send(res, 200, { ok: true, payment: rec, expiresAt: rec.ts + TOPUP_TTL });
    });
  }

  if (url === "/api/paid" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      expireOld();
      const p = DB.payments.find(x => x.id === b.id && x.uid === u.id);
      if (!p) return send(res, 404, { error: "not found" });
      if (p.status !== "waiting") return send(res, 409, { error: "state", status: p.status });
      p.status = "checking"; p.paidTs = Date.now(); save();
      notifyTopupChannel(p);
      send(res, 200, { ok: true });
    });
  }

  // Mijoz to'lov oynasidagi "To'lovni bekor qilish" tugmasini bosganda —
  // avvalgi holatda faqat mahalliy ekran tozalanardi, serverdagi yozuv "kutilmoqda"
  // bo'lib qolaverardi va Buyurtmalar > To'ldirishlar bo'limida shunday ko'rinardi.
  // Endi shu chaqiruv bilan yozuv darhol "bekor qilindi" statusiga o'tkaziladi.
  if (url === "/api/topup-cancel" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      expireOld();
      const p = DB.payments.find(x => x.id === b.id && x.uid === u.id);
      if (!p) return send(res, 404, { error: "not found" });
      if (p.status === "waiting") { p.status = "cancelled"; p.cancelledBy = "user"; save(); notifyTopupChannel(p); }
      send(res, 200, { ok: true, status: p.status });
    });
  }

  if (url === "/api/fragment/check-user" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
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
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
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
      if (!reserveBalance(acc, price)) return send(res, 402, { error: "balance", need: price - acc.balance });
      fragmentCall("/stars/buy", { amount, username: uname }).then(r => {
        const j = r.json;
        if (!j || j.ok !== true) {
          acc.balance += price; save();                       // aniq rad etildi — pul qaytadi
          const msg = (j && j.message) || "Fragment xatosi";
          return send(res, 502, { error: "fragment_failed", message: msg });
        }
        const summary = "⭐ " + amount + " Stars @" + uname + " ga yuborildi";
        const o = { id: genId("VN"), seq: nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: it.id,
          item: "Telegram Stars (" + amount + ")", price, status: "done", ts: Date.now(),
          delivered: summary, doneTs: Date.now(), fragment: j.result || null };
        DB.orders.push(o); save(); notifyOrder(o); logDeliveryToChannel(o);
        creditReferralOnOrder(o);
        send(res, 200, { ok: true, order: o, balance: acc.balance });
      }).catch(e => {
        if (requestNotSent(e)) { acc.balance += price; save(); return send(res, 502, { error: "fragment_failed", message: String(e.message || e) }); }
        const o = unknownDeliveryOrder(u, it, "Telegram Stars (" + amount + ") @" + uname, price, e.message);
        send(res, 200, { ok: true, order: o, balance: acc.balance, pending: true });
      });
    });
  }
  if (url === "/api/buy" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
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
        if (!reserveBalance(acc, price)) return send(res, 402, { error: "balance", need: price - acc.balance });
        const isStars = it.fulfill === "fragment_stars";
        const path = isStars ? "/stars/buy" : "/premium/buy";
        const body = isStars ? { amount: Number(it.starsAmount) || 0, username: u.username }
                              : { duration: Number(it.premiumMonths) || 3, username: u.username };
        fragmentCall(path, body).then(r => {
          const j = r.json;
          if (!j || j.ok !== true) {
            acc.balance += price; save();                     // aniq rad etildi — pul qaytadi
            const msg = (j && j.message) || "Fragment xatosi";
            return send(res, 502, { error: "fragment_failed", message: msg });
          }
          const summary = isStars
            ? "⭐ " + body.amount + " Stars @" + u.username + " ga yuborildi"
            : "💎 Premium " + body.duration + " oy @" + u.username + " ga yuborildi";
          const o = { id: genId("VN"), seq: nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: it.id,
            item: title, price, status: "done", ts: Date.now(),
            delivered: summary, doneTs: Date.now(), fragment: j.result || null };
          DB.orders.push(o); save(); notifyOrder(o); logDeliveryToChannel(o);
          creditReferralOnOrder(o);
          send(res, 200, { ok: true, order: o, balance: acc.balance });
        }).catch(e => {
          if (requestNotSent(e)) { acc.balance += price; save(); return send(res, 502, { error: "fragment_failed", message: String(e.message || e) }); }
          const o = unknownDeliveryOrder(u, it, title + " @" + u.username, price, e.message);
          send(res, 200, { ok: true, order: o, balance: acc.balance, pending: true });
        });
        return;
      }

      // Bitta xariddagi maksimal dona soni — mijoz 1 tadan 10 tagacha birga sotib olishi mumkin.
      const MAX_BUY_QTY = 10;
      const listCheck = DB.stock[it.id];
      const isStockItem = Array.isArray(listCheck);
      const quantity = Math.max(1, Math.min(MAX_BUY_QTY, Math.round(Number(b.quantity) || 1)));
      // Agar bu mahsulot uchun inventar (aniq zaxira ro'yxati) yuritilayotgan bo'lsa va u tugagan
      // yoki so'ralgan miqdorga yetmasa — sotib bo'lmaydi (mavjud sonini ham qaytaramiz).
      if (isStockItem && listCheck.length === 0)
        return send(res, 409, { error: "out_of_stock" });
      if (isStockItem && quantity > listCheck.length)
        return send(res, 409, { error: "out_of_stock", available: listCheck.length });
      let totalPrice = price * quantity;
      let promoApplied = null;
      if (b.promoCode) {
        const pv = validatePromo(b.promoCode, u.id, totalPrice);
        if (!pv.ok) return send(res, 409, { error: "promo_invalid", reason: pv.reason, minOrder: pv.minOrder });
        totalPrice = Math.max(0, totalPrice - pv.discount);
        promoApplied = { code: pv.promo.code, discount: pv.discount };
      }
      if (acc.balance < totalPrice) return send(res, 402, { error: "balance", need: totalPrice - acc.balance });
      // Zaxirada (stock) tayyor mahsulot bo'lsa — so'ralgan miqdorni olib, shu mijozga qat'iy
      // biriktiramiz (boshqa hech kimga qayta berilmaydi), balansdan yechamiz va darhol
      // "bajarildi" deb belgilaymiz. Bir nechta dona sotib olinsa — hammasi bitta buyurtmada,
      // bitta (nusxalanadigan) matn blokida birlashtiriladi.
      const list = DB.stock[it.id];
      let delivered = null;
      if (Array.isArray(list) && list.length) {
        const n = Math.min(quantity, list.length);
        const items = list.splice(0, n);
        delivered = items.length > 1 ? items.map((v, i) => "#" + (i + 1) + ") " + v).join("\n\n") : items[0];
      }
      acc.balance -= totalPrice;
      const o = { id: genId("VN"), seq: nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: it.id,
        item: title + (quantity > 1 ? (" ×" + quantity) : ""), price: totalPrice,
        status: delivered ? "done" : "pending", ts: Date.now(), quantity,
        delivered: delivered || null, doneTs: delivered ? Date.now() : null,
        promoCode: promoApplied ? promoApplied.code : null, promoDiscount: promoApplied ? promoApplied.discount : 0 };
      DB.orders.push(o); save();
      if (promoApplied) consumePromo(DB.promoCodes[promoApplied.code], u.id);
      notifyOrder(o); logDeliveryToChannel(o);
      if (Array.isArray(list)) checkStockAlert(it.id, title);
      if (delivered) { creditReferralOnOrder(o); creditLoyaltyOnOrder(o); deliverStockToCustomer(o, title); }
      send(res, 200, { ok: true, order: o, balance: acc.balance });
    });
  }
  if (url === "/api/buy-gift" && m === "POST") {
    const u = auth(req);
    if (!u) return send(res, 401, { error: req._authReason === "expired" ? "expired" : "auth" });
    return readBody(req, res, b => {
      const cat = catalogArr();
      if (!cat) return send(res, 409, { error: "catalog not published" });
      const it = cat.find(x => x.id === b.itemId && x.active !== false && x.fulfill === "telegram_gift");
      if (!it) return send(res, 404, { error: "no item" });
      const uname = String(b.username || "").trim().replace(/^@/, "");
      const message = String(b.message || "").slice(0, 200);
      const anonymous = !!b.anonymous;
      if (!uname) return send(res, 400, { error: "username" });
      const price = Math.round(Number(it.price) || 0);
      const acc = user(u);
      if (!reserveBalance(acc, price)) return send(res, 402, { error: "balance", need: price - acc.balance });
      const title = typeof it.title === "string" ? it.title : ((it.title && (it.title.uz || it.title.en)) || "");
      giftBotCall("/order", { gift_id: it.telegramGiftId, username: uname, message, anonymous }).then(r => {
        const j = r.json;
        if (!j || j.ok !== true) {
          acc.balance += price; save();                       // aniq rad etildi — pul qaytadi
          const msg = (j && j.error) || "Gift yuborishda xatolik";
          return send(res, 502, { error: "gift_failed", message: msg });
        }
        const summary = "🎁 " + title + " @" + uname + " ga yuborildi" + (anonymous ? " (anonim)" : "");
        const o = { id: genId("VN"), seq: nextOrderSeq(), uid: u.id, uname: u.username || null, itemId: it.id,
          item: title, price, status: "done", ts: Date.now(),
          delivered: summary, doneTs: Date.now(),
          giftRecipient: uname, giftMessage: message, giftAnonymous: anonymous };
        DB.orders.push(o); save(); notifyOrder(o); logDeliveryToChannel(o);
        creditReferralOnOrder(o);
        send(res, 200, { ok: true, order: o, balance: acc.balance });
      }).catch(e => {
        if (requestNotSent(e)) { acc.balance += price; save(); return send(res, 502, { error: "gift_failed", message: String(e.message || e) }); }
        const o = unknownDeliveryOrder(u, it, title + " → @" + uname, price, e.message, { giftRecipient: uname, giftMessage: message, giftAnonymous: anonymous });
        send(res, 200, { ok: true, order: o, balance: acc.balance, pending: true });
      });
    });
  }

  /* ----- admin endpoints ----- */
  if (url.indexOf("/api/admin/") === 0) {
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set" });
    const a = auth(req);
    if (!isAdm(a)) return send(res, 403, { error: "not admin" });
    // Admin ilovani ochdi — demak so'rovdagi Host ilovaning haqiqiy tashqi
    // manzili. Shu bilan bot webhook'i hech qanday sozlamasiz ulanadi.
    rememberPublicBase(req);

    if (url === "/api/admin/list" && m === "GET") {
      expireOld();
      return send(res, 200, {
        payments: DB.payments.filter(p => p.status === "checking" || p.status === "waiting").reverse(),
        orders: DB.orders.filter(o => o.status === "pending" || o.status === "processing").reverse()
      });
    }
    // Sotib olingan/yetkazilgan HAMMA narsa bo'yicha qidiruv — login/parol/link/gmail va
    // h.k. qaysi buyurtmada kimga yuborilganini topish uchun (mijoz "olmadim" desa yoki
    // noto'g'ri narsa berilgan bo'lsa — shu yerdan tekshiriladi). q bo'sh bo'lsa eng
    // so'nggi yetkazilgan buyurtmalar (max 60) qaytariladi; q berilsa mahsulot nomi,
    // yetkazilgan matn (login/parol/link ichida ham), xaridor ID/username, buyurtma
    // raqami (#seq yoki VN-xxxxxx) bo'yicha (katta-kichik harf farqlanmaydi) qidiriladi.
    if (url === "/api/admin/deliveries" && m === "GET") {
      const qry = (q.get("q") || "").trim().toLowerCase();
      let list = DB.orders.filter(o => !!o.delivered);
      if (qry) {
        list = list.filter(o =>
          (o.delivered || "").toLowerCase().indexOf(qry) !== -1 ||
          (o.item || "").toLowerCase().indexOf(qry) !== -1 ||
          (o.uname || "").toLowerCase().indexOf(qry) !== -1 ||
          String(o.uid || "").indexOf(qry) !== -1 ||
          String(o.seq || "").indexOf(qry) !== -1 ||
          (o.id || "").toLowerCase().indexOf(qry.replace(/^#/, "")) !== -1
        );
      }
      list = list.slice().sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 60);
      return send(res, 200, { orders: list, total: list.length });
    }
    // Barcha to'ldirishlar (istalgan holatda) — mini-app admin panelidagi
    // "Barcha to'ldirishlar" ro'yxati uchun. /api/admin/list faqat kutilayotgan/tekshirilayotganlarni
    // qaytaradi, bu esa tasdiqlangan va bekor qilinganlarni ham (filtr va qidiruv bilan) beradi.
    if (url === "/api/admin/topups" && m === "GET") {
      expireOld();
      const status = String(q.get("status") || "all");
      const qry = (q.get("q") || "").trim().toLowerCase();
      let list = DB.payments.slice();
      if (status !== "all") list = list.filter(p => p.status === status);
      if (qry) {
        list = list.filter(p =>
          (p.uname || "").toLowerCase().indexOf(qry) !== -1 ||
          String(p.uid || "").indexOf(qry) !== -1 ||
          (p.id || "").toLowerCase().indexOf(qry.replace(/^#/, "")) !== -1
        );
      }
      list = list.slice().sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 200);
      return send(res, 200, { payments: list, total: list.length });
    }
    if (url === "/api/admin/payment" && m === "POST") {
      return readBody(req, res, b => {
        const r = adminPaymentAction(b.id, b.action, "admin");
        if (!r.ok) return send(res, r.code, { error: r.error });
        return send(res, 200, r.balance != null ? { ok: true, balance: r.balance } : { ok: true });
      });
    }
    if (url === "/api/admin/order" && m === "POST") {
      return readBody(req, res, b => {
        const r = adminOrderAction(b.id, b.action);
        if (!r.ok) return send(res, r.code, { error: r.error });
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
        if (DB.automation && DB.automation.stockAlertSent) delete DB.automation.stockAlertSent[itemId]; // qayta to'ldirildi — keyingi tugashda yana ogohlantiradi
        save();
        checkFavoriteStock(itemId); // TZ band 6: 0dan 1+ ga o'tsa sevimli belgilaganlarga xabar
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
        checkFavoriteStock(itemId);
        checkStockAlert(itemId, itemId);
        return send(res, 200, { ok: true, count: DB.stock[itemId].length });
      });
    }
    if (url === "/api/admin/stock/clear" && m === "POST") {
      return readBody(req, res, b => {
        const itemId = String(b.itemId || "");
        DB.stock[itemId] = [];
        save();
        checkFavoriteStock(itemId);
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
    // TZ band 5: Admin statistika paneli — bugungi/haftalik/oylik savdo, oxirgi 30 kunlik
    // kunlik grafik, eng ko'p sotilgan 5 mahsulot, yangi va faol foydalanuvchilar soni.
    // Barchasi mavjud DB.orders/DB.payments/DB.users'dan hisoblanadi, alohida jadval kerak emas.
    if (url === "/api/admin/dashboard" && m === "GET") {
      const now = Date.now();
      const doneOrders = DB.orders.filter(o => o.status === "done");

      function sumRevenue(cutoff) {
        return doneOrders.filter(o => o.ts >= cutoff).reduce((s, o) => s + (Number(o.price) || 0), 0);
      }
      const sales = {
        today: sumRevenue(periodStart("today")),
        week: sumRevenue(periodStart("week")),
        month: sumRevenue(periodStart("month"))
      };

      // Toshkent (UTC+5) bo'yicha kun boshlanishi — kunlik grafik shu chegaralarga tushadi.
      const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
      function tashkentDayStart(ts) {
        const local = new Date(ts + TZ_OFFSET_MS);
        return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TZ_OFFSET_MS;
      }
      function tashkentDateStr(dayStartMs) {
        const local = new Date(dayStartMs + TZ_OFFSET_MS);
        const y = local.getUTCFullYear(), mo = local.getUTCMonth() + 1, d = local.getUTCDate();
        return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      }
      // Oxirgi 30 kun (bugungi kun bilan birga) — bo'sh kunlar 0 sifatida to'ldiriladi.
      const todayStart = tashkentDayStart(now);
      const dayMs = 24 * 60 * 60 * 1000;
      const dailyMap = {};
      for (let i = 0; i < 30; i++) dailyMap[todayStart - i * dayMs] = 0;
      for (const o of doneOrders) {
        const ds = tashkentDayStart(o.ts || 0);
        if (ds in dailyMap) dailyMap[ds] += Number(o.price) || 0;
      }
      const dailySales = Object.keys(dailyMap).map(Number).sort((a, b) => a - b)
        .map(ts => ({ date: tashkentDateStr(ts), total: dailyMap[ts] }));

      // Eng ko'p sotilgan 5 mahsulot (nomi bo'yicha guruhlab, sotilgan soni).
      const productCounts = {};
      for (const o of doneOrders) {
        const name = o.item || "Noma'lum";
        productCounts[name] = (productCounts[name] || 0) + 1;
      }
      const topProducts = Object.keys(productCounts)
        .map(name => ({ name, count: productCounts[name] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // Yangi ro'yxatdan o'tgan foydalanuvchilar (DB.users[].ts — birinchi marta ko'rilgan vaqt).
      const userList = Object.values(DB.users);
      const newUsers = {
        daily: userList.filter(u => (u.ts || 0) >= periodStart("today")).length,
        weekly: userList.filter(u => (u.ts || 0) >= periodStart("week")).length
      };

      // Faol foydalanuvchilar — oxirgi 7 kunda xarid qilganlar (uid bo'yicha unikal).
      const sevenDaysAgo = now - 7 * dayMs;
      const activeUidSet = {};
      for (const o of doneOrders) if ((o.ts || 0) >= sevenDaysAgo) activeUidSet[o.uid] = true;
      const activeUsers = Object.keys(activeUidSet).length;

      // "Qaytmagan" mijozlar — avval kamida bitta xarid qilgan, lekin oxirgi 30 kunda
      // hech narsa olmagan foydalanuvchilar (eng ko'p sarflaganlar birinchi), top 20.
      const lastOrderByUid = {}, spentByUid = {};
      for (const o of doneOrders) {
        const k = String(o.uid);
        if (!lastOrderByUid[k] || o.ts > lastOrderByUid[k]) lastOrderByUid[k] = o.ts;
        spentByUid[k] = (spentByUid[k] || 0) + (Number(o.price) || 0);
      }
      const thirtyDaysAgo = now - 30 * dayMs;
      const churnUsers = Object.keys(lastOrderByUid)
        .filter(k => lastOrderByUid[k] < thirtyDaysAgo)
        .map(k => ({
          uid: k, uname: (DB.users[k] && DB.users[k].uname) || null,
          name: (DB.users[k] && DB.users[k].name) || "",
          lastOrderTs: lastOrderByUid[k], totalSpent: spentByUid[k] || 0
        }))
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, 20);

      return send(res, 200, { sales, dailySales, topProducts, newUsers, activeUsers, churnUsers, churnCount: churnUsers.length });
    }
    if (url === "/api/admin/referral-settings" && m === "GET") {
      return send(res, 200, DB.settings.referral || {});
    }
    if (url === "/api/admin/referral-settings" && m === "POST") {
      return readBody(req, res, b => {
        DB.settings.referral = {
          enabled: !!b.enabled,
          percent: Math.max(0, Math.min(100, Number(b.percent) || 0)),
          shareText: String(b.shareText || "").slice(0, 500)
        };
        save();
        send(res, 200, { ok: true, referral: DB.settings.referral });
      });
    }
    /* ----- promo-kodlar (admin) ----- */
    if (url === "/api/admin/promo/list" && m === "GET") {
      const list = Object.values(DB.promoCodes).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(res, 200, { promoCodes: list });
    }
    if (url === "/api/admin/promo/create" && m === "POST") {
      return readBody(req, res, b => {
        const code = normPromo(b.code);
        if (!code) return send(res, 400, { error: "no_code" });
        const type = b.type === "fixed" ? "fixed" : "percent";
        const value = Math.max(0, Number(b.value) || 0);
        if (!value) return send(res, 400, { error: "no_value" });
        DB.promoCodes[code] = {
          code, type, value,
          maxUses: Math.max(0, Number(b.maxUses) || 0),        // 0 = cheksiz
          perUserLimit: Math.max(0, Number(b.perUserLimit) || 1),
          minOrder: Math.max(0, Number(b.minOrder) || 0),
          expiresAt: b.expiresAt ? Number(b.expiresAt) : null,
          active: true, usedCount: 0, usedBy: {},
          note: String(b.note || "").slice(0, 200),
          createdAt: Date.now()
        };
        save();
        send(res, 200, { ok: true, promo: DB.promoCodes[code] });
      });
    }
    if (url === "/api/admin/promo/toggle" && m === "POST") {
      return readBody(req, res, b => {
        const p = DB.promoCodes[normPromo(b.code)];
        if (!p) return send(res, 404, { error: "not found" });
        p.active = !p.active;
        save();
        send(res, 200, { ok: true, active: p.active });
      });
    }
    if (url === "/api/admin/promo/delete" && m === "POST") {
      return readBody(req, res, b => {
        const code = normPromo(b.code);
        if (!DB.promoCodes[code]) return send(res, 404, { error: "not found" });
        delete DB.promoCodes[code];
        save();
        send(res, 200, { ok: true });
      });
    }

    /* ----- sodiqlik dasturi sozlamalari (admin) ----- */
    if (url === "/api/admin/loyalty-settings" && m === "GET") {
      return send(res, 200, DB.settings.loyalty || {});
    }
    if (url === "/api/admin/loyalty-settings" && m === "POST") {
      return readBody(req, res, b => {
        const tiers = Array.isArray(b.tiers) ? b.tiers.map(t => ({
          name: String(t.name || "").slice(0, 30) || "Tier",
          minSpent: Math.max(0, Number(t.minSpent) || 0),
          percent: Math.max(0, Math.min(100, Number(t.percent) || 0))
        })) : (DB.settings.loyalty && DB.settings.loyalty.tiers) || [];
        DB.settings.loyalty = { enabled: !!b.enabled, tiers };
        save();
        send(res, 200, { ok: true, loyalty: DB.settings.loyalty });
      });
    }

    /* ----- kanal sozlamalari: qaysi xabar qaysi chat_id'ga ketadi (admin) ----- */
    if (url === "/api/admin/channel-settings" && m === "GET") {
      const c = channelCfg();
      return send(res, 200, {
        order: String(c.order || ""),
        topup: String(c.topup || ""),
        delivery: String(c.delivery || ""),
        // Amalda ishlatilayotgan qiymat (delivery bo'sh bo'lsa buyurtma kanaliga tushadi)
        effective: { order: orderChatId(), topup: topupChatId(), delivery: deliveryChatId() },
        env: { order: ENV_ORDER_CHAT_ID, topup: ENV_TOPUP_CHAT_ID, delivery: ENV_DELIVERY_CHAT_ID },
        botToken: !!BOT_TOKEN
      });
    }
    if (url === "/api/admin/channel-settings" && m === "POST") {
      return readBody(req, res, b => {
        // chat_id — "-1001234567890" ko'rinishidagi son (kanal uchun manfiy). Foydalanuvchi
        // xato qilib @username yoki havola qo'yib yubormasligi uchun shaklini tekshiramiz.
        const clean = v => String(v === undefined ? "" : v).trim();
        const bad = [];
        const out = {};
        [["order", "Buyurtmalar"], ["topup", "To'lovlar"], ["delivery", "Yetkazilganlar"]].forEach(([k, label]) => {
          const v = clean(b[k]);
          if (v && !/^-?\d{5,20}$/.test(v)) bad.push(label);
          out[k] = v;
        });
        if (bad.length) return send(res, 400, { error: "chat_id faqat raqam bo'lishi kerak (masalan -1001234567890): " + bad.join(", ") });
        DB.settings.channels = out;
        save();
        send(res, 200, { ok: true, channels: out, effective: { order: orderChatId(), topup: topupChatId(), delivery: deliveryChatId() } });
      });
    }
    // Saqlashdan oldin/keyin tekshirish: tanlangan kanalga sinov xabari yuboradi va
    // Telegram javobini (xato bo'lsa sababini) qaytaradi — "bot kanalda admin emas",
    // "chat not found" kabi xatolarni darhol ko'rish uchun.
    if (url === "/api/admin/channel-test" && m === "POST") {
      return readBody(req, res, b => {
        if (!BOT_TOKEN) return send(res, 400, { error: "BOT_TOKEN o'rnatilmagan" });
        const kind = String(b.kind || "order");
        const LABEL = { order: "buyurtmalar", topup: "to'lovlar", delivery: "yetkazilganlar" };
        const cid = String(b.chatId || "").trim() ||
          (kind === "topup" ? topupChatId() : kind === "delivery" ? deliveryChatId() : orderChatId());
        if (!cid) return send(res, 400, { error: "chat_id bo'sh" });
        tgApiPost("sendMessage", { chat_id: cid, text: "✅ Verion Shop — sinov xabari (" + (LABEL[kind] || kind) + " kanali)" })
          .then(j => {
            if (j && j.ok) return send(res, 200, { ok: true, chatId: cid, title: (j.result && j.result.chat && j.result.chat.title) || "" });
            send(res, 400, { error: (j && j.description) || "Telegram javob bermadi" });
          })
          .catch(() => send(res, 400, { error: "Telegram'ga ulanib bo'lmadi" }));
      });
    }

    /* ----- bot /start sozlamalari (admin) ----- */
    if (url === "/api/admin/bot-settings" && m === "GET") {
      // Admin panelni ochdi — ko'k tugma manzili yangilangan bo'lsa, 15 daqiqani
      // kutmay fonda qabul qilamiz (keyingi ochilishda ko'rinadi).
      refreshMenuUrl().then(mm => { if (mm.changed) return ensureBotConnection(true).then(x => reportWebhook(x, true)); }).catch(() => {});
      const c = botCfg();
      const started = Object.keys(DB.users).filter(k => DB.users[k].started === true).length;
      const safe = p => p.then(j => (j && j.ok ? j.result : null)).catch(() => null);
      Promise.all([safe(tgApiPost("getWebhookInfo", {})), safe(tgApiPost("getChatMenuButton", {}))]).then(([wh, mb]) => {
        const r = wh || {};
        const base = publicBase();
        const railway = process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + String(process.env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
        send(res, 200, {
          greeting: c.greeting || "", defaultGreeting: DEFAULT_GREETING,
          channelUrl: c.channelUrl || "", guideUrl: c.guideUrl || "", gate: !!c.gate,
          publicUrl: base, botUsername: BOT_USERNAME, startLink: botStartLink("app"),
          // Manzil qayerdan olingani — "nega bot tugmasi shu domenga olib boryapti?" savoliga javob
          urlSource: c.appUrl ? "admin" : (c.menuUrl ? "menu" : (process.env.PUBLIC_URL ? "env" : (railway ? "railway" : (c.publicUrl ? "host" : "")))),
          openUrl: appOpenUrl(), menuUrl: c.menuUrl || "",
          appUrl: c.appUrl || "", envUrl: String(process.env.PUBLIC_URL || ""), railwayUrl: railway, learnedUrl: c.publicUrl || "",
          menuButton: mb ? { type: mb.type || "", text: mb.text || "", url: (mb.web_app && mb.web_app.url) || "" } : null,
          bannerCached: !!c.bannerFileId, startedUsers: started, totalUsers: Object.keys(DB.users).length,
          mode: c.mode || "auto", polling: POLLING, pollingWhy: POLL_REASON,
          webhook: wh ? {
            url: r.url || "", ours: !!(base && r.url === base + "/api/tg-webhook"),
            pending: r.pending_update_count || 0, lastError: r.last_error_message || ""
          } : { url: "", ours: false, pending: 0, lastError: "Telegram javob bermadi" }
        });
      });
      return;
    }
    /* Ilova manzilini qo'lda belgilash. Avval server o'zini shu manzil orqali
       tekshiradi (/api/health), keyin: bot tugmalari, chat pastidagi "Ilova"
       menyu tugmasi va webhook hammasi shu manzilga o'tadi. Bo'sh yuborilsa —
       avtomatik aniqlashga qaytadi. */
    if (url === "/api/admin/app-url" && m === "POST") {
      return readBody(req, res, async b => {
        const c = botCfg();
        const raw = String((b && b.url) || "").trim();
        if (!raw) {
          c.appUrl = ""; save();
          const conn = await ensureBotConnection(true).catch(e => ({ ok: false, error: e.message }));
          return send(res, 200, { ok: true, appUrl: "", publicUrl: publicBase(), connection: conn });
        }
        const base = normalizeAppUrl(raw);
        if (!base) return send(res, 400, { error: "Manzil noto'g'ri. Masalan: https://verionshop-production.up.railway.app" });
        const probe = await probeAppUrl(base);
        if (!probe.ok) return send(res, 400, { error: base + " — " + probe.error, probe });
        c.appUrl = base; save();
        console.log("[bot] ilova manzili admin tomonidan belgilandi: " + base);
        const [menu, conn] = await Promise.all([
          syncMenuButton(base),
          ensureBotConnection(true).catch(e => ({ ok: false, error: e.message }))
        ]);
        send(res, 200, { ok: true, appUrl: base, probe, menuButton: menu, connection: conn });
      });
    }
    if (url === "/api/admin/bot-settings" && m === "POST") {
      return readBody(req, res, b => {
        const c = botCfg();
        const link = v => {
          const s = String(v === undefined ? "" : v).trim();
          if (!s) return "";
          return /^https?:\/\//i.test(s) ? s : (/^@/.test(s) ? "https://t.me/" + s.slice(1) : "https://" + s);
        };
        if (b.greeting !== undefined) c.greeting = String(b.greeting).slice(0, 900);
        if (b.channelUrl !== undefined) c.channelUrl = link(b.channelUrl);
        if (b.guideUrl !== undefined) c.guideUrl = link(b.guideUrl);
        if (b.gate !== undefined) c.gate = !!b.gate;
        // Ulanish usuli: auto (webhook, ishlamasa polling) | webhook | polling
        if (b.mode !== undefined && ["auto", "webhook", "polling"].indexOf(String(b.mode)) !== -1) {
          c.mode = String(b.mode); c.autoPolling = false; c.autoPollingWhy = "";
          save();
          ensureBotConnection(true).catch(() => {});
        }
        // Salom matni yoki tugmalar o'zgarsa banner o'zi o'zgarmaydi — file_id keshi qoladi.
        save();
        send(res, 200, { ok: true, bot: { greeting: c.greeting, channelUrl: c.channelUrl, guideUrl: c.guideUrl, gate: c.gate, mode: c.mode || "auto" } });
      });
    }
    // Ulanishni majburan qayta qurish (webhook'ni qayta o'rnatadi, polling'dan qaytaradi).
    if (url === "/api/admin/bot-webhook" && m === "POST") {
      return readBody(req, res, () => {
        ensureBotConnection(true).then(r => {
          if (r.ok) return send(res, 200, { ok: true, mode: r.mode, url: r.url || "", replaced: r.replaced || "" });
          send(res, 400, { error: r.reason === "no_url"
            ? "Ilova manzili noma'lum: admin panelni ilova ichida oching yoki PUBLIC_URL qo'shing"
            : (r.error || r.reason) });
        }).catch(e => send(res, 400, { error: e.message }));
      });
    }
    // "/start" xabarini o'ziga sinov uchun yuborish.
    if (url === "/api/admin/bot-start-test" && m === "POST") {
      return readBody(req, res, () => {
        sendStartCard(a.id, greetingHtml({ id: a.id, first_name: a.first_name || "Admin", username: a.username }))
          .then(r => (r && r.ok !== false)
            ? send(res, 200, { ok: true })
            : send(res, 400, { error: (r && r.description) || "yuborilmadi" }))
          .catch(e => send(res, 400, { error: e.message }));
      });
    }

    /* ----- avtomatlashtirish sozlamalari (admin) ----- */
    if (url === "/api/admin/automation-settings" && m === "GET") {
      return send(res, 200, DB.automation || {});
    }
    if (url === "/api/admin/automation-settings" && m === "POST") {
      return readBody(req, res, b => {
        DB.automation = {
          winbackEnabled: !!b.winbackEnabled,
          winbackDays: Math.max(1, Number(b.winbackDays) || 14),
          winbackBonus: Math.max(0, Number(b.winbackBonus) || 0),
          winbackMessage: String(b.winbackMessage || "").slice(0, 500),
          winbackCooldownDays: Math.max(1, Number(b.winbackCooldownDays) || 30),
          lastRunTs: (DB.automation && DB.automation.lastRunTs) || 0,
          stockAlertEnabled: !!b.stockAlertEnabled,
          stockAlertSent: (DB.automation && DB.automation.stockAlertSent) || {}
        };
        save();
        send(res, 200, { ok: true, automation: DB.automation });
      });
    }
    // Admin qo'lda ham "sog'indik" tekshiruvini darhol ishga tushira oladi (kutmasdan).
    if (url === "/api/admin/automation/run-winback" && m === "POST") {
      const sent = runWinbackCheck();
      return send(res, 200, { ok: true, sent: sent || 0 });
    }
    // Bitta mahsulot uchun stock-alert belgisini tozalash (zaxira yangi qo'shilganda chaqiriladi).
    if (url === "/api/admin/automation/clear-stock-alert" && m === "POST") {
      return readBody(req, res, b => {
        if (DB.automation && DB.automation.stockAlertSent) delete DB.automation.stockAlertSent[b.itemId];
        save();
        send(res, 200, { ok: true });
      });
    }

    /* ----- CSV eksport (admin) ----- */
    if (url === "/api/admin/export-csv" && m === "GET") {
      const type = q.get("type") || "orders";
      function csvEsc(v) {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      let rows = [];
      if (type === "orders") {
        rows.push(["id", "seq", "uid", "uname", "item", "price", "status", "promoCode", "promoDiscount", "date"]);
        for (const o of DB.orders) rows.push([o.id, o.seq, o.uid, o.uname || "", o.item, o.price, o.status,
          o.promoCode || "", o.promoDiscount || 0, new Date(o.ts).toISOString()]);
      } else if (type === "payments") {
        rows.push(["id", "uid", "amount", "status", "date"]);
        for (const p of DB.payments) rows.push([p.id, p.uid, p.amount, p.status, new Date(p.ts).toISOString()]);
      } else if (type === "users") {
        rows.push(["uid", "uname", "name", "balance", "totalSpent", "loyaltyTier", "registered"]);
        for (const k of Object.keys(DB.users)) {
          const uu = DB.users[k];
          rows.push([k, uu.uname || "", uu.name || "", uu.balance || 0, userTotalSpent(k),
            uu.loyaltyTier || "", new Date(uu.ts || 0).toISOString()]);
        }
      } else return send(res, 400, { error: "bad type" });
      const csv = rows.map(r => r.map(csvEsc).join(",")).join("\n");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="' + type + "-" + Date.now() + '.csv"'
      });
      res.end("\uFEFF" + csv); // BOM — Excel'da kirill/lotin harflari to'g'ri ochilishi uchun
      return;
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
    // Admin sharh matnini, mijoz ismini, mahsulot nomini va yulduzlar sonini to'liq tahrirlaydi.
    if (url === "/api/admin/review-edit" && m === "POST") {
      return readBody(req, res, b => {
        const rv = DB.reviews.find(r => r.id === b.id);
        if (!rv) return send(res, 404, { error: "not_found" });
        if (b.name !== undefined) rv.name = String(b.name).slice(0, 80);
        if (b.itemTitle !== undefined) rv.itemTitle = String(b.itemTitle).slice(0, 120);
        if (b.text !== undefined) rv.text = String(b.text).slice(0, 1000);
        if (b.stars !== undefined) rv.stars = Math.max(1, Math.min(5, Math.round(Number(b.stars)) || 5));
        save();
        send(res, 200, { ok: true, review: rv });
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
    /* ----- Moliya hisoboti ----- */
    if (url === "/api/admin/finance" && m === "GET") {
      const period = q.get("period") || "today";
      const f = computeFinance(["today", "week", "month", "all"].indexOf(period) !== -1 ? period : "today");
      const withBal = q.get("balances") === "1";
      if (!withBal) return send(res, 200, f);
      return allLineBalances(q.get("force") === "1").then(b => send(res, 200, Object.assign(f, { lineBalances: b })))
        .catch(() => send(res, 200, f));
    }
    /* ----- Admin bot sozlamasi (token faqat yoziladi, hech qachon qaytarilmaydi) ----- */
    if (url === "/api/admin/adminbot" && m === "GET") {
      const c = (DB.settings.adminBot || {});
      return send(res, 200, Object.assign({ tokenSet: !!adminBotToken(), fromEnv: !!process.env.ADMIN_BOT_TOKEN,
        notify: Object.assign({ orders: true, payments: true, sms: true }, c.notify || {}) }, ADMINBOT.status()));
    }
    if (url === "/api/admin/adminbot" && m === "POST") {
      return readBody(req, res, b => {
        const c = DB.settings.adminBot || (DB.settings.adminBot = {});
        if (b.token !== undefined && !process.env.ADMIN_BOT_TOKEN) {
          const err = setAdminBotToken(b.token);
          if (err) return send(res, 400, { error: err });
        }
        if (b.notify && typeof b.notify === "object") {
          c.notify = Object.assign({}, c.notify);
          for (const k of ["orders", "payments", "sms"]) if (typeof b.notify[k] === "boolean") c.notify[k] = b.notify[k];
        }
        save();
        ADMINBOT.start().then(st => send(res, 200, Object.assign({ ok: true, tokenSet: !!adminBotToken() }, st)))
          .catch(e => send(res, 200, { ok: false, error: String(e.message || e) }));
      });
    }
    /* ----- AI yordamchi sozlamasi (kalit faqat yoziladi, qaytarilmaydi) ----- */
    if (url === "/api/admin/ai" && m === "GET") return send(res, 200, AI.publicCfg());
    if (url === "/api/admin/ai" && m === "POST") {
      return readBody(req, res, b => {
        const err = AI.saveCfg(b || {});
        if (err) return send(res, 400, { error: err });
        send(res, 200, Object.assign({ ok: true }, AI.publicCfg()));
      });
    }
    if (url === "/api/admin/ai-test" && m === "POST") return AI.testKey().then(r => send(res, 200, r));
    if (url === "/api/admin/adminbot-test" && m === "POST") {
      return ADMINBOT.testMessage(a.id).then(r => send(res, 200, r));
    }
    if (url === "/api/admin/balance" && m === "POST") {
      return readBody(req, res, b => {
        const r = adminBalanceChange(b.uid, b.delta, a.id, b.note);
        if (!r.ok) return send(res, r.code, { error: r.error });
        return send(res, 200, { ok: true, balance: r.balance });
      });
    }
    /* ----- Nakrutka (SMM/JAP) admin ----- */
    if (url === "/api/admin/nakrutka/orders" && m === "GET") {
      const status = q.get("status") || "processing"; // processing | done | cancelled | all
      let list = DB.orders.filter(o => String(o.itemId || "").indexOf("nk_") === 0);
      if (status !== "all") list = list.filter(o => o.status === status);
      list.sort((x, y) => y.ts - x.ts);
      return send(res, 200, { orders: list.slice(0, 200) });
    }
    if (url === "/api/admin/nakrutka/balance" && m === "GET") {
      // Hamma panellar balansi; "balance" — eski ko'rinish uchun birinchi ishlayotgan panelniki.
      return SMM.balances().then(lines => {
        const first = lines.find(x => x.ok);
        send(res, 200, { balance: first ? first.balance : null, currency: first ? first.currency : "USD", lines });
      }).catch(e => send(res, 502, { error: "jap_failed", message: String(e.message || e) }));
    }
    if (SMM.handle(req, res, url, m, send, readBody)) return;
    // Bitta buyurtmani qo'lda JAP'dan yangilash yoki bekor qilib pulni qaytarish.
    if (url === "/api/admin/nakrutka/order" && m === "POST") {
      return readBody(req, res, b => {
        const o = DB.orders.find(x => x.id === b.id && String(x.itemId || "").indexOf("nk_") === 0);
        if (!o) return send(res, 404, { error: "not_found" });
        if (b.action === "refresh") {
          if (!o.japOrderId) return send(res, 400, { error: "no_jap_order" });
          return SMM.status(o).then(j => {
            if (!j || j.error) return send(res, 502, { error: "jap_failed", message: (j && j.error) || "Panel javob bermadi" });
            applyJapStatusToOrder(o, j); save();
            send(res, 200, { ok: true, order: o });
          }).catch(e => send(res, 502, { error: "jap_failed", message: String(e.message || e) }));
        }
        if (b.action === "cancel_refund") {
          if (o.status === "done" || o.status === "cancelled") return send(res, 409, { error: "state" });
          o.status = "cancelled";
          if (!o.refunded) {
            const acc = DB.users[String(o.uid)] || (DB.users[String(o.uid)] = { balance: 0 });
            acc.balance += o.price; o.refunded = true;
            tgSend(o.uid, "❌ Nakrutka buyurtmangiz admin tomonidan bekor qilindi, mablag' qaytarildi: " + o.item);
          }
          save();
          return send(res, 200, { ok: true, order: o });
        }
        return send(res, 400, { error: "action" });
      });
    }
    // Kurs (USD->so'm) va foyda ustamasi (%) — bo'sh/0 qiymat berilsa standart (ENV) qiymatga qaytadi.
    if (url === "/api/admin/nakrutka/settings" && m === "GET") {
      const s = nkSettings();
      return send(res, 200, { usdRate: nkUsdRate(), usdRateOverride: s.usdRate || null,
        defaultUsdRate: NAKRUTKA_USD_RATE, markupPercent: nkMarkupPct() });
    }
    if (url === "/api/admin/nakrutka/settings" && m === "POST") {
      return readBody(req, res, b => {
        const s = nkSettings();
        if (b.usdRate !== undefined) { const v = Number(b.usdRate); s.usdRate = v > 0 ? v : null; }
        if (b.markupPercent !== undefined) s.markupPercent = Math.max(0, Math.min(500, Number(b.markupPercent) || 0));
        save();
        send(res, 200, { ok: true, usdRate: nkUsdRate(), markupPercent: nkMarkupPct() });
      });
    }
    // Xizmatlarni ko'rish/yashirish: admin JAP'dan kelgan HAMMA xizmatni ko'radi, ba'zilarini
    // mijozlardan yashirishi mumkin (masalan sifatsiz/keraksiz deb topganlarini).
    if (url === "/api/admin/nakrutka/services" && m === "GET") {
      return SMM.allServices(false)
        .then(r => {
          if (!r.configured) return send(res, 503, { error: "jap_not_configured" });
          send(res, 200, { services: r.list.map(x => Object.assign({}, x, { service: x.key })), hidden: nkSettings().hiddenServices || [],
            errors: r.errors, backups: SMM.store().backups });
        })
        .catch(e => send(res, 502, { error: "jap_failed", message: String(e.message || e) }));
    }
    if (url === "/api/admin/nakrutka/toggle-service" && m === "POST") {
      return readBody(req, res, b => {
        const pk = SMM.parseKey(b.service);
        if (!pk) return send(res, 400, { error: "service" });
        const id = SMM.keyOf(pk.lineId, pk.id);
        const s = nkSettings();
        const idx = s.hiddenServices.findIndex(h => String(h) === String(id));
        if (idx === -1) s.hiddenServices.push(id); else s.hiddenServices.splice(idx, 1);
        save();
        send(res, 200, { ok: true, hidden: s.hiddenServices });
      });
    }
    // Nakrutka guruh rasmlari (masalan Telegram -> Members): admin ro'yxatini o'qiydi/yozadi.
    // Butun obyekt bir yo'la almashtiriladi (frontend joriy holatni GET orqali olib, kerakli
    // kalitlarnigina o'zgartirib, to'liq obyektni qayta yuboradi — category-meta bilan bir xil naqsh).
    if (url === "/api/admin/nakrutka/catmeta" && m === "GET") {
      return send(res, 200, nkCatMetaObj());
    }
    if (url === "/api/admin/nakrutka/catmeta" && m === "POST") {
      return readBody(req, res, obj => {
        if (!obj || typeof obj !== "object") return send(res, 400, { error: "invalid json" });
        try { sdb.kvSet(SQLITE_DB, "nkcatmeta", obj); send(res, 200, { ok: true }); }
        catch (e) { send(res, 500, { error: "write failed" }); }
      });
    }

    // Admin panelidagi "Zaxira nusxa olish" tugmasi — istalgan vaqtda qo'lda zaxira
    // (barcha data/ fayllari .tar.gz qilib) tayyorlab, admin botga hujjat sifatida yuboradi.
    if (url === "/api/admin/backup-now" && m === "POST") {
      runBackup()
        .then(r => send(res, 200, r))
        .catch(e => send(res, 500, { error: String(e.message || e) }));
      return;
    }

    // Ommaviy xabar (broadcast): matn + ixtiyoriy rasm/video + premium emoji.
    // body: { text, mediaType: "none"|"photo"|"video", mediaData: "data:...;base64,..."|null, test: bool }
    // test=true bo'lsa — faqat shu admin(a.id)ga yuboradi va natijani darhol qaytaradi (fon ishi emas).
    if (url === "/api/admin/broadcast" && m === "POST") {
      return readBroadcastBody(req, res, b => {
        const text = String(b.text || "").trim();
        const mediaType = ["photo", "video"].indexOf(b.mediaType) !== -1 ? b.mediaType : "none";
        const limit = mediaType === "none" ? BROADCAST_MAX_TEXT : BROADCAST_MAX_CAPTION;
        if (!text && mediaType === "none") return send(res, 400, { error: "empty_text" });
        if (text.length > limit) return send(res, 400, { error: "text_too_long", limit });

        let mediaBuffer = null, mediaMime = "";
        if (mediaType !== "none") {
          const mm = /^data:([^;]+);base64,(.+)$/.exec(String(b.mediaData || ""));
          if (!mm) return send(res, 400, { error: "invalid_media" });
          mediaMime = mm[1];
          try { mediaBuffer = Buffer.from(mm[2], "base64"); } catch (e) { return send(res, 400, { error: "invalid_media" }); }
          if (!mediaBuffer.length) return send(res, 400, { error: "invalid_media" });
        }

        if (b.test) {
          const chatId = a.id;
          const captionHtml = buildBroadcastHTML(text);
          const p = mediaType !== "none"
            ? tgSendMediaMultipart(chatId, mediaType, mediaBuffer, "test." + (mediaType === "video" ? "mp4" : "jpg"), mediaMime, captionHtml)
            : tgApiPost("sendMessage", { chat_id: chatId, text: captionHtml, parse_mode: "HTML" })
                .then(r => { if (!r.ok) throw new Error(r.description || "telegram_error"); return r; });
          return p.then(() => send(res, 200, { ok: true }))
            .catch(e => send(res, 200, { ok: false, error: String(e.message || e) }));
        }

        if (BROADCAST_JOB && !BROADCAST_JOB.done) return send(res, 409, { error: "already_running" });
        const ids = Object.keys(DB.users).map(Number).filter(n => !isNaN(n));
        if (!ids.length) return send(res, 400, { error: "no_users" });
        BROADCAST_JOB = { total: ids.length, processed: 0, sent: 0, blocked: 0, failed: 0,
          mediaType, done: false, startedTs: Date.now(), finishedTs: null };
        const job = BROADCAST_JOB;
        runBroadcast(job, text, mediaType, mediaBuffer, mediaMime, ids)
          .catch(e => { job.done = true; job.finishedTs = Date.now(); job.error = String(e.message || e); });
        return send(res, 200, { ok: true, total: ids.length });
      });
    }
    if (url === "/api/admin/broadcast-status" && m === "GET") {
      const hist = (() => { try { return sdb.kvGet(SQLITE_DB, "broadcastLog", []); } catch (e) { return []; } })();
      return send(res, 200, { job: BROADCAST_JOB, history: hist.slice().reverse() });
    }

    return send(res, 404, { error: "unknown admin route" });
  }

  /* ----- Telegram bot webhook: /start va boshqa xabarlar shu yerga keladi ----- */
  if (url === "/api/tg-webhook" && m === "POST") {
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set" });
    // Maxfiy kalit setWebhook paytida berilgan; Telegram uni har so'rovda qaytaradi.
    if (req.headers["x-telegram-bot-api-secret-token"] !== botHookSecret())
      return send(res, 401, { error: "bad secret" });
    return readBody(req, res, b => {
      send(res, 200, { ok: true });   // Telegram javobni kutib turmasin
      Promise.resolve().then(() => handleBotUpdate(b))
        .catch(e => console.log("[tg-webhook] xato: " + e.message));
    });
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
    if (!TG_WEBHOOK_SECRET || !safeEq(req.headers["x-sms-secret"], TG_WEBHOOK_SECRET))
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
    // "no-cache" ba'zi WebView'larda (xususan Telegram ilovasi ichidagi) hali ham eski
    // nusxani ko'rsatib qo'yishi mumkin edi — shu sabab qat'iyroq no-store + eski
    // brauzerlar uchun Pragma/Expires ham qo'shildi, xar safar server'dan yangi HTML
    // majburiy yuklansin.
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    res.end(data);
  });
});

/* ---------- avtomatik zaxira nusxa (backup) ---------- */
// Tashqi kutubxonasiz (faqat fs/zlib) minimal tar+gzip arxivlovchi — data/ papkasidagi
// barcha fayllarni (backups/ papkasining o'zidan tashqari) bitta .tar.gz ga yig'adi.
function tarOctal(num, width) {
  let s = Math.max(0, Math.floor(num)).toString(8);
  while (s.length < width - 1) s = "0" + s;
  return s + "\0";
}
function tarHeader(name, size, mtimeSec) {
  const buf = Buffer.alloc(512, 0);
  buf.write(String(name).slice(0, 100), 0, 100, "utf8");
  buf.write(tarOctal(0o644, 8), 100, 8, "utf8");
  buf.write(tarOctal(0, 8), 108, 8, "utf8");
  buf.write(tarOctal(0, 8), 116, 8, "utf8");
  buf.write(tarOctal(size, 12), 124, 12, "utf8");
  buf.write(tarOctal(mtimeSec, 12), 136, 12, "utf8");
  buf.write("        ", 148, 8, "utf8"); // chksum — vaqtincha bo'sh joy
  buf.write("0", 156, 1, "utf8");        // typeflag: oddiy fayl
  buf.write("ustar", 257, 6, "utf8");
  buf.write("00", 263, 2, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(tarOctal(sum, 7) + " ", 148, 8, "utf8");
  return buf;
}
function walkDataFiles(dir, base) {
  base = base || dir;
  let out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    if (abs === BACKUP_DIR) continue; // arxiv o'z-o'zini arxivlab yubormasin
    if (it.isDirectory()) out = out.concat(walkDataFiles(abs, base));
    else out.push({ name: path.relative(base, abs).split(path.sep).join("/"), absPath: abs });
  }
  return out;
}
function buildTarGz(entries) {
  const blocks = [];
  const mtimeSec = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    let data;
    try { data = fs.readFileSync(e.absPath); } catch (err) { continue; }
    blocks.push(tarHeader(e.name, data.length, mtimeSec));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // arxiv oxiri belgisi (ikkita bo'sh blok)
  const tarBuf = Buffer.concat(blocks);
  return new Promise((resolve, reject) => {
    zlib.gzip(tarBuf, (err, out) => err ? reject(err) : resolve(out));
  });
}
// Telegram Bot API'ga fayl (hujjat) yuborish — tashqi "form-data" kutubxonasisiz,
// multipart/form-data tanasi qo'lda yig'iladi.
function tgSendDocument(chatId, buffer, filename, caption) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN || !chatId) return reject(new Error("no bot/chat"));
    const boundary = "----VerionBackup" + crypto.randomBytes(10).toString("hex");
    const pre = [];
    pre.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`, "utf8"));
    if (caption) pre.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`, "utf8"));
    pre.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/gzip\r\n\r\n`, "utf8"));
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([...pre, buffer, post]);
    const reqOpts = {
      hostname: "api.telegram.org", path: "/bot" + BOT_TOKEN + "/sendDocument", method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length }
    };
    const r = https.request(reqOpts, resp => {
      let out = ""; resp.on("data", c => out += c);
      resp.on("end", () => {
        try { const j = JSON.parse(out); j.ok ? resolve(j) : reject(new Error(j.description || "telegram_error")); }
        catch (e) { reject(e); }
      });
    });
    r.on("error", reject);
    r.write(body); r.end();
  });
}
function pruneOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".tar.gz")).sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) {}
    }
  } catch (e) {}
}
// Zaxira nusxa yasab, diskka yozadi, admin(lar)ga botdan hujjat qilib yuboradi va
// 7 kundan eskisini o'chiradi. Ham kunlik jadval, ham "Zaxira nusxa olish" tugmasi shuni chaqiradi.
function runBackup() {
  // WAL rejimida yozilgan so'nggi o'zgarishlar asosiy shop.db fayliga ko'chirilishi
  // kerak — aks holda arxivdagi shop.db yolg'iz o'zi to'liq bo'lmasligi mumkin.
  try { SQLITE_DB.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}
  const entries = walkDataFiles(DATA_DIR);
  return buildTarGz(entries).then(gz => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = "backup-" + stamp + ".tar.gz";
    fs.writeFileSync(path.join(BACKUP_DIR, filename), gz);
    pruneOldBackups();
    const caption = "🗄 Verion Shop — zaxira nusxa\n" +
      new Date().toLocaleString("ru-RU", { timeZone: "Asia/Tashkent" }) + "\n" +
      "Fayllar: " + entries.length + " | Hajm: " + (gz.length / 1024).toFixed(1) + " KB";
    const sends = ADMIN_IDS.map(id => tgSendDocument(id, gz, filename, caption).catch(() => {}));
    return Promise.all(sends).then(() => ({ ok: true, filename, files: entries.length, size: gz.length }));
  });
}
// Har kuni Toshkent vaqti bilan soat 04:00da avtomatik ishga tushadi.
function msUntilNextBackup() {
  const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // Asia/Tashkent = UTC+5, DST yo'q
  const now = Date.now();
  const local = new Date(now + TZ_OFFSET_MS);
  let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 4, 0, 0) - TZ_OFFSET_MS;
  if (target <= now) target += 24 * 60 * 60 * 1000;
  return target - now;
}
function scheduleBackup() {
  setTimeout(function tick() {
    runBackup().catch(e => console.log("[backup] xato: " + (e && e.message)));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilNextBackup());
}
if (BOT_TOKEN) scheduleBackup();

server.listen(PORT, "0.0.0.0", () => {
  console.log("Verion Shop v3 on " + PORT + " | data: " + DATA_DIR + " | BOT_TOKEN " + (BOT_TOKEN ? "set" : "MISSING"));
  // Bot webhook'ini o'zi ulaydi — Railway'da qo'lda hech narsa sozlash shart emas.
  // getMe javobini (BOT_USERNAME) kutib, bir necha soniyadan keyin bajariladi.
  if (BOT_TOKEN) {
    // Birinchi urinish getMe javobidan (BOT_USERNAME) keyin.
    // Avval ko'k tugma manzilini o'qiymiz (eng ishonchli manba), keyin ulanamiz.
    setTimeout(() => {
      refreshMenuUrl().catch(() => ({ changed: false }))
        .then(m => ensureBotConnection(!!m.changed)).then(r => reportWebhook(r, true)).catch(() => {});
    }, 4000);
    // Keyin har 15 daqiqada tekshirib turadi — tarmoq uzilishi, Telegram
    // tomonidan webhook o'chirilishi yoki manzil o'zgarishi o'zi tuzatiladi.
    setInterval(() => {
      refreshMenuUrl().catch(() => ({ changed: false }))
        .then(m => ensureBotConnection(!!m.changed)).then(reportWebhook).catch(() => {});
    }, 15 * 60 * 1000);
  }
});
