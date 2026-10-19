"use strict";
/* ============================================================================
   Verion Shop — ALOHIDA ADMIN BOT
   Do'kon botidan butunlay ajratilgan ikkinchi bot (o'z tokeni bilan). Faqat
   ADMIN_IDS ro'yxatidagilar ishlata oladi. Imkoniyatlari:
     • 🔍 Mijoz kartasi: ID, balans, buyurtmalar soni, xarid/to'ldirish summasi,
       oxirgi orderlar, to'lov slotlari + ➕ Balans / ➖ Yechish / 🛒 Orderlar /
       🎟 Slotlar / 🔄 Yangilash / 🔍 Boshqa / 🌐 Panelda ochish tugmalari.
     • 📊 Moliya: kirim, sotuv, qaytarilgan, tannarx, foyda, qo'lda o'zgartirishlar,
       mijozlar balansi, kutilayotgan pullar, saytlardagi balans (bugun/hafta/oy/hammasi).
     • 🧾 To'lovlar va 🛒 Buyurtmalar: kutilayotganlar ro'yxati, ✅/❌ tugmalari.
     • 📩 SMS kuzatuv, ⚙️ Holat (do'kon boti, liniyalar, bildirishnomalar).
     • Voqealar: yangi to'lov / buyurtma / mos kelmagan SMS — hamma adminlarga xabar,
       holat o'zgarganda o'sha xabarlarning o'zi tahrirlanadi.
   Pul bilan bog'liq har bir amal ikki bosqichli (✅ → "Ha") — tasodifiy bosilmasin.
   Webhook emas, long polling (getUpdates): do'kon botining webhook sozlamasiga
   tegmaydi va server manzili o'zgarsa ham ishlayveradi.
   ============================================================================ */
const https = require("https");

module.exports = function createAdminBot(ctx) {
  const st = { gen: 0, token: "", active: false, username: "", id: 0, error: "", startedAt: 0, lastPoll: 0 };
  const waiting = new Map();   // adminId -> { kind: "find" | "+" | "-", uid, ts }
  const ops = new Map();       // tasdiqlash kutilayotgan balans amallari: opId -> {...}
  const DB = () => ctx.getDB();
  const admins = () => ctx.ADMIN_IDS;
  const isAdmin = id => admins().indexOf(Number(id)) !== -1;
  const cfg = () => { const D = DB(); if (!D.settings) D.settings = {}; return D.settings.adminBot || (D.settings.adminBot = {}); };
  const notifyOn = k => (cfg().notify || {})[k] !== false;
  const NOTIFY_LABEL = { orders: "Buyurtmalar", payments: "To'lovlar", sms: "SMS" };

  /* ---------- Telegram API (admin bot tokeni bilan) ---------- */
  function api(method, payload, tok) {
    tok = tok || st.token;
    return new Promise(resolve => {
      if (!tok) return resolve({ ok: false, description: "no token" });
      const data = JSON.stringify(payload || {});
      let req;
      try {
        req = https.request({
          hostname: "api.telegram.org", path: "/bot" + tok + "/" + method, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          timeout: method === "getUpdates" ? 40000 : 15000
        }, r => {
          let b = ""; r.on("data", c => b += c);
          r.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error_code: r.statusCode, description: "bad json" }); } });
        });
      } catch (e) { return resolve({ ok: false, description: String(e.message || e), network: true }); }
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", e => resolve({ ok: false, description: String((e && e.message) || e), network: true }));
      req.write(data); req.end();
    });
  }
  const cut = t => { t = String(t || ""); return t.length > 4000 ? t.slice(0, 3990) + "\n…" : t; };
  const send = (chat, text, kb) => api("sendMessage", { chat_id: chat, text: cut(text), disable_web_page_preview: true, reply_markup: kb });
  const edit = (chat, mid, text, kb) => api("editMessageText", { chat_id: chat, message_id: mid, text: cut(text), disable_web_page_preview: true, reply_markup: kb || { inline_keyboard: [] } });

  /* ---------- Formatlash ---------- */
  const money = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so'm";
  const num = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const dt = ts => ts ? new Date(ts).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  const day = ts => ts ? new Date(ts).toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent" }) : "—";
  const ago = ts => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? "hozirgina" : m < 60 ? m + " daqiqa oldin" : m < 1440 ? Math.round(m / 60) + " soat oldin" : Math.round(m / 1440) + " kun oldin"; };
  const userOf = uid => DB().users[String(uid)];
  const who = (uid, uname) => { const u = userOf(uid) || {}; const n = uname || u.uname; return (u.name || "Mijoz") + (n ? " (@" + n + ")" : "") + " · ID " + uid; };
  const short = (uid, uname) => { const u = userOf(uid) || {}; const n = uname || u.uname; return n ? "@" + n : (u.name || "ID " + uid); };
  const O_ICO = { done: "✅", pending: "🕓", processing: "⏳", cancelled: "❌" };
  const P_ICO = { done: "✅", waiting: "🕓", checking: "🔎", cancelled: "❌" };
  const LINE_STATE = { accepted: "sayt qabul qildi, natija kutilmoqda", unknown: "❓ sayt javobi tushunarsiz — saytdan tekshiring",
    manual: "qo'lda bajarish kerak", failed: "sayt bajarmadi", done: "bajarildi" };
  const btn = (text, data) => ({ text, callback_data: data });
  function webApp(text, view) {
    const base = String(ctx.appUrl() || "");
    if (!/^https:\/\//.test(base)) return null;
    return { text, web_app: { url: base.replace(/\/+$/, "") + "/?admin=" + encodeURIComponent(view || "1") } };
  }
  const kbd = rows => ({ inline_keyboard: rows.map(r => r.filter(Boolean)).filter(r => r.length) });
  const MENU = { keyboard: [[{ text: "🛠 Admin panel" }], [{ text: "📊 Moliya" }, { text: "🧾 To'lovlar" }], [{ text: "🛒 Buyurtmalar" }, { text: "🔍 Mijoz" }], [{ text: "📩 SMS" }, { text: "⚙️ Holat" }]],
    resize_keyboard: true, is_persistent: true };
  const errText = e => ({ "already done": "Bu to'lov allaqachon tasdiqlangan.", "already cancelled": "Bu to'lov allaqachon bekor qilingan.",
    "not found": "Topilmadi.", state: "Buyurtma holati o'zgargan (allaqachon bajarilgan yoki bekor qilingan).", "no user": "Mijoz topilmadi." }[e] || ("Xato: " + e));

  /* ---------- Mijoz kartasi ---------- */
  function cardText(uid) {
    const u = userOf(uid); if (!u) return null;
    const id = Number(uid), D = DB();
    const orders = D.orders.filter(o => o.uid === id);
    const pays = D.payments.filter(p => p.uid === id);
    const bought = orders.filter(o => o.status === "done").reduce((t, o) => t + (Number(o.price) || 0), 0);
    const topped = pays.filter(p => p.status === "done" && p.type !== "manual").reduce((t, p) => t + (Number(p.amount) || 0), 0);
    const man = pays.filter(p => p.status === "done" && p.type === "manual");
    const manPlus = man.filter(p => p.amount > 0).reduce((t, p) => t + p.amount, 0), manMinus = -man.filter(p => p.amount < 0).reduce((t, p) => t + p.amount, 0);
    const slots = pays.filter(p => p.status === "waiting" || p.status === "checking");
    const last = orders.slice(-5).reverse();
    const L = [
      "👤 " + (u.name || "Mijoz") + (u.uname ? " (@" + u.uname + ")" : ""),
      "🆔 ID: " + id,
      "💰 Balans: " + money(u.balance),
      "🛒 " + orders.length + " order · " + money(bought) + " xarid · " + money(topped) + " to'ldirilgan"
    ];
    if (manPlus || manMinus) L.push("✍️ Qo'lda: +" + num(manPlus) + " / −" + num(manMinus));
    if (u.ts) L.push("📅 Birinchi kirgan: " + day(u.ts));
    L.push("", "🧾 Oxirgi orderlar:");
    if (!last.length) L.push("— hali yo'q");
    for (const o of last) L.push((O_ICO[o.status] || "•") + " #" + o.seq + " " + o.item + " · " + money(o.price) + " · " + dt(o.ts));
    L.push("", "🎟 To'lov slotlari: " + (slots.length ? slots.length + " ta" : "bo'sh"));
    for (const p of slots) L.push((P_ICO[p.status] || "•") + " " + money(p.pay || p.amount) + (p.method ? " · " + p.method : "") + " · " + dt(p.ts));
    return L.join("\n");
  }
  const cardKb = uid => kbd([
    [btn("➕ Balans", "ub+:" + uid), btn("➖ Yechish", "ub-:" + uid)],
    [btn("🛒 Orderlar", "uo:" + uid), btn("🎟 Slotlar", "us:" + uid)],
    [btn("🔄 Yangilash", "ur:" + uid), btn("🔍 Boshqa", "uf")],
    [webApp("🌐 Panelda ochish", "u-" + uid)]
  ]);
  function showCard(chat, uid, mid) {
    const t = cardText(uid);
    if (!t) return send(chat, "🔍 Mijoz topilmadi: " + uid + "\nU hali do'kon botini ochmagan bo'lishi mumkin.");
    return mid ? edit(chat, mid, t, cardKb(uid)) : send(chat, t, cardKb(uid));
  }
  function userOrdersView(uid) {
    const list = DB().orders.filter(o => o.uid === Number(uid)).slice(-12).reverse();
    const L = ["🛒 Orderlar — " + who(uid), ""], rows = [];
    if (!list.length) L.push("— buyurtma yo'q");
    list.forEach((o, i) => {
      L.push((i + 1) + ") " + (O_ICO[o.status] || "•") + " #" + o.seq + " " + o.item + " · " + money(o.price) + " · " + dt(o.ts));
      if (o.game && o.game.accountText) L.push("    🎮 " + o.game.accountText + (o.line && o.line.state && o.status === "pending" ? " · " + (LINE_STATE[o.line.state] || o.line.state) : ""));
      if (o.status === "pending") rows.push([btn("✅ " + (i + 1) + ") #" + o.seq, "od:" + o.id), btn("❌ Bekor", "ox:" + o.id)]);
    });
    rows.push([btn("⬅️ Kartaga", "ur:" + uid)]);
    return [L.join("\n"), kbd(rows)];
  }
  function userSlotsView(uid) {
    const list = DB().payments.filter(p => p.uid === Number(uid)).slice(-12).reverse();
    const L = ["🎟 To'lovlar va slotlar — " + who(uid), ""], rows = [];
    if (!list.length) L.push("— to'lov yo'q");
    list.forEach((p, i) => {
      L.push((i + 1) + ") " + (P_ICO[p.status] || "•") + " " + (p.type === "manual" ? (p.amount > 0 ? "+" : "") + money(p.amount) + " qo'lda" + (p.note ? " (" + p.note + ")" : "")
        : money(p.amount) + (p.method ? " · " + p.method : "")) + " · " + dt(p.ts));
      if (p.status === "waiting" || p.status === "checking") rows.push([btn("✅ " + (i + 1) + ") " + num(p.pay || p.amount), "pd:" + p.id), btn("❌ Bekor", "px:" + p.id)]);
    });
    rows.push([btn("⬅️ Kartaga", "ur:" + uid)]);
    return [L.join("\n"), kbd(rows)];
  }
  function findUsers(q) {
    const s = String(q || "").trim().toLowerCase().replace(/^@/, "");
    if (!s) return [];
    const D = DB();
    if (/^\d+$/.test(s) && D.users[s]) return [Number(s)];
    const out = [];
    for (const k in D.users) {
      const v = D.users[k];
      if (k.indexOf(s) !== -1 || (v.uname && v.uname.toLowerCase().indexOf(s) !== -1) || (v.name && v.name.toLowerCase().indexOf(s) !== -1)) out.push(Number(k));
      if (out.length >= 10) break;
    }
    return out;
  }
  function doFind(chat, q) {
    const list = findUsers(q);
    if (!list.length) return send(chat, "🔍 \"" + String(q).slice(0, 40) + "\" bo'yicha mijoz topilmadi.", kbd([[btn("🔍 Qayta qidirish", "uf")]]));
    if (list.length === 1) return showCard(chat, list[0]);
    return send(chat, "🔍 Topildi: " + list.length + " ta. Kerakligini tanlang:",
      kbd(list.map(id => [btn(short(id) + " · " + money((userOf(id) || {}).balance), "uc:" + id)])));
  }

  /* ---------- Ro'yxatlar ---------- */
  function paymentsView() {
    const list = DB().payments.filter(p => p.status === "waiting" || p.status === "checking")
      .sort((a, b) => (a.status === "checking" ? 0 : 1) - (b.status === "checking" ? 0 : 1) || b.ts - a.ts);
    if (!list.length) return ["🧾 Kutilayotgan to'lov yo'q ✅", kbd([[btn("🔄 Yangilash", "lp")]])];
    const sum = list.reduce((t, p) => t + (Number(p.pay) || 0), 0);
    const L = ["🧾 Kutilayotgan to'lovlar: " + list.length + " ta · " + money(sum), "🔎 — mijoz \"to'ladim\" bosgan, 🕓 — hali bosmagan", ""], rows = [];
    list.slice(0, 12).forEach((p, i) => {
      L.push((i + 1) + ") " + P_ICO[p.status] + " " + money(p.pay) + " · " + short(p.uid, p.uname) + (p.method ? " · " + p.method : "") + " · " + dt(p.ts));
      rows.push([btn("✅ " + (i + 1) + ") " + num(p.pay), "pd:" + p.id), btn("❌", "px:" + p.id), btn("👤", "uc:" + p.uid)]);
    });
    if (list.length > 12) L.push("… yana " + (list.length - 12) + " ta (panelda)");
    rows.push([btn("🔄 Yangilash", "lp"), webApp("🌐 Panel", "money")]);
    return [L.join("\n"), kbd(rows)];
  }
  function ordersView() {
    const list = DB().orders.filter(o => o.status === "pending" || o.status === "processing").slice().reverse();
    if (!list.length) return ["🛒 Bajarilmagan buyurtma yo'q ✅", kbd([[btn("🔄 Yangilash", "lo")]])];
    const sum = list.reduce((t, o) => t + (Number(o.price) || 0), 0);
    const L = ["🛒 Bajarilmagan buyurtmalar: " + list.length + " ta · " + money(sum), ""], rows = [];
    list.slice(0, 12).forEach((o, i) => {
      L.push((i + 1) + ") " + (O_ICO[o.status] || "•") + " #" + o.seq + " " + o.item + " · " + money(o.price) + " · " + short(o.uid, o.uname) + " · " + dt(o.ts));
      if (o.game && o.game.accountText) L.push("    🎮 " + o.game.accountText + (o.line && o.line.state ? " · " + (o.line.name ? o.line.name + ": " : "") + (LINE_STATE[o.line.state] || o.line.state) : ""));
      if (o.status === "processing") L.push(o.smmUnknown ? "    ❓ Panel javobi tushunarsiz — panelda tekshiring" : "    ⏳ Nakrutka paneli bajarmoqda");
      rows.push(o.status === "pending"
        ? [btn("✅ " + (i + 1) + ") #" + o.seq, "od:" + o.id), btn("❌", "ox:" + o.id), btn("👤", "uc:" + o.uid)]
        : [btn("👤 " + (i + 1) + ") #" + o.seq, "uc:" + o.uid)]);
    });
    if (list.length > 12) L.push("… yana " + (list.length - 12) + " ta (panelda)");
    rows.push([btn("🔄 Yangilash", "lo"), webApp("🌐 Panel", "money")]);
    return [L.join("\n"), kbd(rows)];
  }
  function smsView() {
    const log = (DB().smsLog || []).slice(-10).reverse();
    const L = ["📩 SMS kuzatuv (to'lovlarni avtomatik tasdiqlash)"];
    if (!log.length) L.push("", "Hali SMS kelmagan. Userbot (userbot_sms.py) ishga tushirilganini tekshiring.");
    else {
      L.push("Oxirgi SMS: " + ago(log[0].ts) + (Date.now() - log[0].ts > 24 * 3600 * 1000 ? "\n⚠️ 24 soatdan beri SMS kelmadi — userbot ishlayotganini tekshiring." : ""), "");
      log.forEach((e, i) => {
        const res = e.matched ? "✅ " + money(e.parsedAmount) + " → to'lov " + e.paymentId
          : e.rejected ? "⛔ ruxsat etilmagan jo'natuvchi" : e.parsedAmount ? "⚠️ " + money(e.parsedAmount) + " — mos to'lov topilmadi" : "ℹ️ summa topilmadi";
        L.push((i + 1) + ") " + dt(e.ts) + " · " + (e.from || "?") + "\n    " + res + "\n    \"" + String(e.text || "").replace(/\s+/g, " ").slice(0, 90) + "\"");
      });
    }
    return [L.join("\n"), kbd([[btn("🔄 Yangilash", "sm"), btn("🧾 To'lovlar", "lp")]])];
  }
  function statusView() {
    const s = ctx.statusInfo ? ctx.statusInfo() : {};
    const L = ["⚙️ Holat", ""];
    L.push("🤖 Do'kon boti: " + (s.shopBot || "—"));
    if (s.shopBotError) L.push("   Oxirgi xato: " + s.shopBotError);
    L.push("🛡 Admin bot: @" + st.username + " · " + ago(st.startedAt).replace("oldin", "dan beri ishlayapti"));
    L.push("🌐 Ilova manzili: " + (ctx.appUrl() || "aniqlanmagan"));
    L.push("🧾 Kutilayotgan to'lovlar: " + (s.pendingPayments || 0) + " · 🛒 buyurtmalar: " + (s.pendingOrders || 0));
    if (s.lastSmsTs) L.push("📩 Oxirgi SMS: " + ago(s.lastSmsTs));
    if (Array.isArray(s.lines) && s.lines.length) {
      L.push("", "🎮 Liniyalar:");
      for (const l of s.lines) L.push("   " + (l.enabled ? "🟢" : "⚪️") + " " + l.name);
    }
    if (s.build) L.push("", "Versiya: " + s.build);
    L.push("", "🔔 Bildirishnomalar (bosib yoqing/o'chiring):");
    const rows = [Object.keys(NOTIFY_LABEL).map(k => btn((notifyOn(k) ? "🔔 " : "🔕 ") + NOTIFY_LABEL[k], "nt:" + k))];
    rows.push([btn("🔄 Yangilash", "st"), webApp("🌐 Admin panel", "1")]);
    return [L.join("\n"), kbd(rows)];
  }

  /* ---------- Moliya ---------- */
  const PERIODS = { today: "Bugun", week: "Shu hafta", month: "Shu oy", all: "Hammasi" };
  const SRC = { games: "🎮 O'yinlar", telegram: "⭐ Telegram (Stars/Premium/Gift)", nakrutka: "📈 Nakrutka", shop: "🛍 Do'kon" };
  async function financeView(period, forceBal) {
    period = PERIODS[period] ? period : "today";
    const f = ctx.finance(period);
    const L = ["📊 Moliya — " + PERIODS[period] + (period !== "all" ? " (" + day(f.from) + " dan)" : ""), "━━━━━━━━━━━━━━"];
    L.push("💰 Kirim: " + money(f.topups.sum) + " · " + f.topups.count + " ta to'lov");
    const meth = Object.keys(f.topups.byMethod || {});
    if (meth.length) L.push("    " + meth.map(k => k + ": " + num(f.topups.byMethod[k])).join(" · "));
    L.push("🛒 Sotuv: " + money(f.sales.sum) + " · " + f.sales.count + " ta buyurtma");
    for (const k of Object.keys(f.bySource || {})) L.push("    " + (SRC[k] || k) + ": " + f.bySource[k].count + " ta · " + num(f.bySource[k].sum));
    L.push("↩️ Qaytarilgan: " + f.refunds.count + " ta · " + money(f.refunds.sum));
    if (f.cost.count) {
      L.push("📦 Tannarx (sayt): " + money(f.cost.sum) + " · " + f.cost.count + " ta buyurtma");
      L.push("💵 Foyda: " + money(f.profit) + " (shu " + f.cost.count + " ta bo'yicha, sotuv " + num(f.cost.revenue) + ")");
    }
    const lines = Object.keys(f.byLine || {});
    if (lines.length) for (const k of lines) { const b = f.byLine[k]; L.push("    🔌 " + b.name + ": " + b.count + " ta · " + num(b.sum) + (b.cost ? " (tannarx " + num(b.cost) + ")" : "")); }
    if (f.manual.count) L.push("✍️ Qo'lda: +" + num(f.manual.plus) + " / −" + num(f.manual.minus) + " (" + f.manual.count + " ta)");
    L.push("━━━━━━━━━━━━━━");
    L.push("👥 Mijozlar: " + num(f.users.total) + (period !== "all" ? " (yangi: " + f.users.new + ")" : ""));
    L.push("💼 Mijozlar balansida: " + money(f.liabilities));
    L.push("⏳ Kutilayotgan to'lovlar: " + f.pendingPayments.count + " ta · " + money(f.pendingPayments.sum));
    L.push("⏳ Bajarilmagan buyurtmalar: " + f.pendingOrders.count + " ta · " + money(f.pendingOrders.sum));
    if (ctx.lineBalances) {
      let bals = null;
      try { bals = await Promise.race([ctx.lineBalances(forceBal), new Promise(r => setTimeout(() => r(null), 6000))]); } catch (e) {}
      if (bals === null) L.push("🏦 Saytlar balansi: tekshirilmoqda… (🏦 tugmasini bosing)");
      else if (bals.length) { L.push("🏦 Saytlardagi balans:"); for (const b of bals) L.push("    " + (b.ok ? "🟢 " : "🔴 ") + b.name + ": " + b.message); }
    }
    L.push("", "🕐 " + dt(Date.now()));
    const rows = [Object.keys(PERIODS).map(k => btn((k === period ? "• " : "") + PERIODS[k], "f:" + k)),
      [btn("🏦 Sayt balanslari", "fb:" + period), btn("🔄 Yangilash", "f:" + period)],
      [webApp("🌐 Batafsil (panel)", "finance")]];
    return [L.join("\n"), kbd(rows)];
  }

  /* ---------- Tasdiqlash xabarlari ---------- */
  function confirmView(kind, id) {
    const D = DB();
    if (kind === "pd" || kind === "px") {
      const p = D.payments.find(x => x.id === id);
      if (!p) return ["Topilmadi.", null];
      if (p.status !== "waiting" && p.status !== "checking") return ["ℹ️ Bu to'lov allaqachon " + (p.status === "done" ? "tasdiqlangan ✅" : "bekor qilingan ❌") + ".", null];
      const head = kind === "pd" ? "❓ To'lovni TASDIQLAYSIZMI?" : "❓ To'lovni BEKOR QILASIZMI?";
      const t = [head, "", "👤 " + who(p.uid, p.uname), "💰 " + money(p.amount) + (p.pay !== p.amount ? " (to'lanishi kerak: " + money(p.pay) + ")" : ""),
        p.method ? "🏦 " + p.method : null, "🕐 " + dt(p.ts) + " · " + (p.status === "checking" ? "mijoz \"to'ladim\" bosgan" : "mijoz hali \"to'ladim\" bosmagan"), "#️⃣ " + p.id, "",
        kind === "pd" ? "Tasdiqlansa mijoz balansiga " + money(p.amount) + " qo'shiladi. Avval kartaga pul tushganini tekshiring!" : "Mijoz balansiga hech narsa qo'shilmaydi."]
        .filter(x => x !== null).join("\n");
      return [t, kbd([[btn(kind === "pd" ? "✅ Ha, tasdiqlash" : "❌ Ha, bekor qilish", (kind === "pd" ? "PD:" : "PX:") + id), btn("↩️ Yo'q", "no")]])];
    }
    const o = D.orders.find(x => x.id === id);
    if (!o) return ["Topilmadi.", null];
    if (o.status !== "pending") return ["ℹ️ Bu buyurtma allaqachon " + (o.status === "done" ? "bajarilgan ✅" : o.status === "cancelled" ? "bekor qilingan ❌" : o.status) + ".", null];
    const L = [kind === "od" ? "❓ Buyurtma BAJARILDIMI?" : "❓ Buyurtmani BEKOR QILASIZMI?", "", "🛍 #" + o.seq + " " + o.item, "👤 " + who(o.uid, o.uname), "💰 " + money(o.price)];
    if (o.game && o.game.accountText) L.push("🎮 " + o.game.accountText);
    if (o.line && o.line.state) L.push("🔌 " + (o.line.name ? o.line.name + ": " : "") + (LINE_STATE[o.line.state] || o.line.state));
    L.push("");
    if (kind === "od") L.push("Mijozga \"bajarildi\" xabari boradi.");
    else {
      L.push("Mijoz balansiga " + money(o.price) + " qaytariladi.");
      if (o.line && (o.line.state === "accepted" || o.line.state === "unknown"))
        L.push("⚠️ Buyurtma saytga yuborilgan! Bekor qilishdan oldin saytda bajarilmaganini tekshiring — aks holda pul ikki marta ketadi.");
    }
    return [L.join("\n"), kbd([[btn(kind === "od" ? "✅ Ha, bajarildi" : "❌ Ha, bekor qilish (pul qaytadi)", (kind === "od" ? "OD:" : "OX:") + id), btn("↩️ Yo'q", "no")]])];
  }
  function execute(kind, id, by) {
    if (kind === "PD" || kind === "PX") {
      const r = ctx.paymentAction(id, kind === "PD" ? "confirm" : "cancel", "admin");
      if (!r.ok) return "⚠️ " + errText(r.error);
      r.p.byAdmin = by; ctx.save();
      if (kind === "PX") return "❌ Bekor qilindi: " + money(r.p.amount) + " · " + who(r.p.uid, r.p.uname);
      ctx.shopSend(r.p.uid, "✅ To'lovingiz tasdiqlandi!\n+" + money(r.p.amount) + " balansingizga qo'shildi.\nJoriy balans: " + money(r.balance));
      return "✅ Tasdiqlandi: +" + money(r.p.amount) + " · " + who(r.p.uid, r.p.uname) + "\n💰 Mijoz balansi: " + money(r.balance);
    }
    const r = ctx.orderAction(id, kind === "OD" ? "done" : "cancel");
    if (!r.ok) return "⚠️ " + errText(r.error);
    r.o.byAdmin = by; ctx.save();
    return kind === "OD" ? "✅ Bajarildi: #" + r.o.seq + " " + r.o.item
      : "❌ Bekor qilindi: #" + r.o.seq + " " + r.o.item + "\n↩️ " + money(r.o.price) + " mijoz balansiga qaytarildi.";
  }

  /* ---------- Balans: ➕ / ➖ ---------- */
  function parseAmount(text) {
    // "1.5 mln", "2,5k" — kasr faqat ko'paytiruvchi bilan; aks holda nuqta/vergul — minglik ajratgich.
    const m = String(text || "").trim().match(/^(\d{1,3}(?:[\s.,']\d{3})+(?![.,]\d)|\d+[.,]\d{1,2}(?=\s*(?:k|ming|m|mln)\b)|\d+)\s*(k|ming|m|mln)?\b\s*(.*)$/i);
    if (!m) return null;
    let n = /^\d+[.,]\d{1,2}$/.test(m[1]) && m[2] ? Number(m[1].replace(",", ".")) : Number(m[1].replace(/[\s.,']/g, ""));
    const suf = (m[2] || "").toLowerCase();
    if (suf === "k" || suf === "ming") n *= 1000; else if (suf === "m" || suf === "mln") n *= 1000000;
    if (!(n > 0) || n > 100000000) return null;
    return { amount: Math.round(n), note: m[3].trim().slice(0, 120) };
  }
  function askBalance(chat, from, sign, uid) {
    const u = userOf(uid); if (!u) return send(chat, "Mijoz topilmadi.");
    waiting.set(from, { kind: sign, uid: Number(uid), ts: Date.now() });
    return send(chat, (sign === "+" ? "➕ Balansga QO'SHISH" : "➖ Balansdan YECHISH") + "\n👤 " + who(uid) + "\n💰 Hozir: " + money(u.balance) +
      "\n\nSumma va izoh yozing, masalan:\n50000 bonus\n25k qaytarish", { force_reply: true, input_field_placeholder: "50000 izoh" });
  }
  function proposeBalance(chat, from, w, text) {
    const a = parseAmount(text);
    if (!a) return send(chat, "⚠️ Summani tushunmadim. Masalan: 50000 bonus\nYoki bekor qilish uchun menyudan boshqa bo'limni tanlang.", { force_reply: true });
    waiting.delete(from);
    const u = userOf(w.uid); if (!u) return send(chat, "Mijoz topilmadi.");
    const delta = w.kind === "+" ? a.amount : -a.amount;
    const after = Math.max(0, u.balance + delta);
    const opId = Math.random().toString(36).slice(2, 10);
    ops.set(opId, { uid: w.uid, delta, note: a.note, by: from, ts: Date.now() });
    const t = ["❓ Tasdiqlaysizmi?", "", "👤 " + who(w.uid), (delta > 0 ? "➕ " : "➖ ") + money(Math.abs(delta)) + (a.note ? "\n📝 Izoh: " + a.note : ""),
      "💰 " + money(u.balance) + " → " + money(after)];
    if (delta < 0 && u.balance + delta < 0) t.push("⚠️ Balansda yetarli emas — 0 gacha yechiladi.");
    if (delta > 0) t.push("", "Mijozga do'kon boti orqali xabar boradi.");
    return send(chat, t.join("\n"), kbd([[btn("✅ Ha", "B:" + opId), btn("↩️ Yo'q", "no")]]));
  }
  function runBalance(opId, from) {
    const op = ops.get(opId); ops.delete(opId);
    if (!op || Date.now() - op.ts > 10 * 60 * 1000) return ["⌛ Muddati o'tdi, qaytadan bajaring.", null];
    const r = ctx.balanceChange(op.uid, op.delta, from, op.note);
    if (!r.ok) return ["⚠️ " + errText(r.error), null];
    if (r.applied > 0) ctx.shopSend(op.uid, "💰 Balansingizga +" + money(r.applied) + " qo'shildi" + (op.note ? "\n📝 " + op.note : "") + "\nJoriy balans: " + money(r.balance));
    return ["✅ Bajarildi: " + (r.applied >= 0 ? "+" : "−") + money(Math.abs(r.applied)) + " · " + who(op.uid) + "\n💰 Yangi balans: " + money(r.balance), op.uid];
  }

  /* ---------- Xabarlarni qayta ishlash ---------- */
  async function welcome(chat) {
    const base = String(ctx.appUrl() || "");
    if (/^https:\/\//.test(base)) api("setChatMenuButton", { chat_id: chat, menu_button: { type: "web_app", text: "Admin panel", web_app: { url: base.replace(/\/+$/, "") + "/?admin=1" } } });
    const w = webApp("🛠 ADMIN PANELNI OCHISH", "1");
    if (w) await send(chat, "🛠 To'liq admin panel 👇", kbd([[w]]));
    return send(chat, "🛡 Verion Shop — admin bot\n\nBu yerda hamma narsani kuzatasiz va boshqarasiz:\n📊 Moliya — kirim, sotuv, foyda, balanslar\n🧾 To'lovlar — tasdiqlash / bekor qilish\n🛒 Buyurtmalar — bajarish / pulni qaytarish\n🔍 Mijoz — ID yoki @username yuboring (yoki uning xabarini forward qiling)\n📩 SMS — avtomatik tasdiqlash kuzatuvi\n⚙️ Holat — botlar, liniyalar, bildirishnomalar\n\nYangi to'lov va buyurtmalar shu yerga keladi. To'liq admin panel — pastdagi \"Admin panel\" tugmasida.", MENU);
  }
  async function sendView(chat, view) { const [t, k] = await view; return send(chat, t, k); }
  async function onMessage(msg) {
    const chat = msg.chat && msg.chat.id, from = msg.from && msg.from.id;
    if (!chat || !from || msg.chat.type !== "private") return;
    if (!isAdmin(from)) return send(chat, "⛔ Bu bot faqat Verion Shop adminlari uchun.\nDo'kon: " + (ctx.shopUsername() ? "@" + ctx.shopUsername() : "Verion Shop"), { remove_keyboard: true });
    const fwd = (msg.forward_origin && msg.forward_origin.sender_user && msg.forward_origin.sender_user.id) || (msg.forward_from && msg.forward_from.id);
    if (fwd) { waiting.delete(from); return showCard(chat, fwd); }
    const text = String(msg.text || "").trim();
    if (!text) return;
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, ""), arg = rest.join(" ");
    const MAP = { "📊 moliya": "/moliya", "🧾 to'lovlar": "/tolovlar", "🛒 buyurtmalar": "/buyurtmalar", "🔍 mijoz": "/mijoz", "📩 sms": "/sms", "⚙️ holat": "/holat", "🛠 admin panel": "/panel" };
    const menuCmd = MAP[text.toLowerCase()];
    const c = menuCmd || (cmd[0] === "/" ? cmd : "");
    if (c) waiting.delete(from);
    switch (c) {
      case "/start": case "/menu": case "/help": return welcome(chat);
      case "/moliya": return sendView(chat, financeView(menuCmd ? "today" : ({ bugun: "today", hafta: "week", oy: "month", hammasi: "all" })[arg.toLowerCase()] || arg || "today"));
      case "/tolovlar": return sendView(chat, paymentsView());
      case "/buyurtmalar": return sendView(chat, ordersView());
      case "/sms": return sendView(chat, smsView());
      case "/holat": return sendView(chat, statusView());
      case "/panel": {
        const w = webApp("🛠 ADMIN PANELNI OCHISH", "1");
        return send(chat, w ? "🛠 Admin panel — hamma bo'limlar bitta joyda. Pastdagi tugmani bosing 👇"
          : "⚠️ Ilova manzili hali aniqlanmagan. Do'kon ilovasini bir marta admin sifatida oching yoki Admin panel → Bot va /start → Ilova manzili.",
          w ? kbd([[w]]) : undefined);
      }
      case "/mijoz": case "/u":
        if (!menuCmd && arg) return doFind(chat, arg);
        waiting.set(from, { kind: "find", ts: Date.now() });
        return send(chat, "🔍 Mijozning ID, @username yoki ismini yuboring.\nYoki uning biror xabarini shu yerga forward qiling.", { force_reply: true, input_field_placeholder: "ID yoki @username" });
    }
    if (c) return send(chat, "Noma'lum buyruq. /menu", MENU);
    const w = waiting.get(from);
    if (w && Date.now() - w.ts < 15 * 60 * 1000) {
      if (w.kind === "find") { waiting.delete(from); return doFind(chat, text); }
      return proposeBalance(chat, from, w, text);
    }
    if (/^@?[A-Za-z][\w]{3,}$/.test(text) || /^\d{4,}$/.test(text)) return doFind(chat, text);
    return send(chat, "Menyudan bo'lim tanlang yoki mijoz ID / @username yuboring.", MENU);
  }
  async function onCallback(cq) {
    const from = cq.from && cq.from.id, msg = cq.message || {}, chat = msg.chat && msg.chat.id, mid = msg.message_id;
    const ans = (text, alert) => api("answerCallbackQuery", { callback_query_id: cq.id, text: text || undefined, show_alert: !!alert });
    if (!isAdmin(from)) return ans("⛔ Faqat adminlar uchun", true);
    const data = String(cq.data || ""), i = data.indexOf(":");
    const k = i === -1 ? data : data.slice(0, i), arg = i === -1 ? "" : data.slice(i + 1);
    try {
      if (k === "uc") { await showCard(chat, arg); return ans(); }
      if (k === "ur") { await showCard(chat, arg, mid); return ans("Yangilandi"); }
      if (k === "uo" || k === "us") { const [t, kb] = k === "uo" ? userOrdersView(arg) : userSlotsView(arg); await edit(chat, mid, t, kb); return ans(); }
      if (k === "ub+" || k === "ub-") { await askBalance(chat, from, k === "ub+" ? "+" : "-", arg); return ans(); }
      if (k === "uf") { waiting.set(from, { kind: "find", ts: Date.now() }); await send(chat, "🔍 Mijozning ID, @username yoki ismini yuboring.", { force_reply: true, input_field_placeholder: "ID yoki @username" }); return ans(); }
      if (k === "pd" || k === "px" || k === "od" || k === "ox") { const [t, kb] = confirmView(k, arg); await send(chat, t, kb || undefined); return ans(); }
      if (k === "PD" || k === "PX" || k === "OD" || k === "OX") { const t = execute(k, arg, from); await edit(chat, mid, t); return ans(t.slice(0, 190)); }
      if (k === "B") { const [t, uid] = runBalance(arg, from); await edit(chat, mid, t); if (uid) await showCard(chat, uid); return ans(); }
      if (k === "no") { await edit(chat, mid, "↩️ Bekor qilindi, hech narsa o'zgarmadi."); return ans(); }
      if (k === "f" || k === "fb") { await ans(k === "fb" ? "Saytlardan so'ralmoqda…" : ""); const [t, kb] = await financeView(arg, k === "fb"); return edit(chat, mid, t, kb); }
      if (k === "lp" || k === "lo" || k === "sm" || k === "st") {
        const [t, kb] = k === "lp" ? paymentsView() : k === "lo" ? ordersView() : k === "sm" ? smsView() : statusView();
        await edit(chat, mid, t, kb); return ans("Yangilandi");
      }
      if (k === "nt" && NOTIFY_LABEL[arg]) {
        const c = cfg(); c.notify = Object.assign({}, c.notify); c.notify[arg] = !notifyOn(arg); ctx.save();
        const [t, kb] = statusView(); await edit(chat, mid, t, kb);
        return ans(NOTIFY_LABEL[arg] + ": " + (notifyOn(arg) ? "yoqildi 🔔" : "o'chirildi 🔕"));
      }
      return ans();
    } catch (e) { console.log("[adminbot] callback xato: " + (e && e.message)); return ans("Xato: " + String((e && e.message) || e).slice(0, 150), true); }
  }

  /* ---------- Voqealar (server chaqiradi) ---------- */
  // Bir voqea — har adminga bitta xabar; keyin holat o'zgarsa o'sha xabarlar tahrirlanadi.
  // Xabar hali yuborilayotgan paytda holat o'zgarsa — yuborilgach eng so'nggi holatga tahrirlanadi.
  const lastView = new WeakMap();
  function broadcastEvent(obj, text, kb) {
    const sentText = text;
    lastView.set(obj, { text, kb });
    if (obj.abMsg) {
      for (const cid of Object.keys(obj.abMsg)) edit(cid, obj.abMsg[cid], text, kb);
      return;
    }
    obj.abMsg = {};
    for (const aid of admins()) send(aid, text, kb).then(j => {
      if (!j || !j.ok || !j.result) return;
      obj.abMsg[aid] = j.result.message_id; ctx.save();
      const v = lastView.get(obj);
      if (v && v.text !== sentText) edit(aid, j.result.message_id, v.text, v.kb);
    });
  }
  function onPayment(p) {
    if (!st.active || !p || p.type === "manual") return;
    if (!p.abMsg) {
      if (!notifyOn("payments") || (p.status !== "checking" && p.status !== "done")) return;
    }
    const open = p.status === "waiting" || p.status === "checking";
    const u = userOf(p.uid);
    const text = ctx.paymentText(p) + (u ? "\n💼 Mijoz balansi: " + money(u.balance) : "") + (p.byAdmin ? "\n🛡 Admin: " + p.byAdmin : "");
    broadcastEvent(p, text, kbd(open ? [[btn("✅ Tasdiqlash", "pd:" + p.id), btn("❌ Bekor", "px:" + p.id)], [btn("👤 Mijoz", "uc:" + p.uid)]] : [[btn("👤 Mijoz", "uc:" + p.uid)]]));
  }
  function orderEventText(o) {
    let t = ctx.orderText(o);
    if (o.line && o.line.state && o.status === "pending") t += "\n🔌 " + (o.line.name ? o.line.name + ": " : "") + (LINE_STATE[o.line.state] || o.line.state);
    if (o.byAdmin) t += "\n🛡 Admin: " + o.byAdmin;
    return t;
  }
  const orderKb = o => kbd(o.status === "pending"
    ? [[btn("✅ Bajarildi", "od:" + o.id), btn("❌ Bekor (pul qaytadi)", "ox:" + o.id)], [btn("👤 Mijoz", "uc:" + o.uid)]]
    : [[btn("👤 Mijoz", "uc:" + o.uid)]]);
  function onOrder(o, kind) {
    if (!st.active || !o) return;
    if (!o.abMsg && (kind !== "new" || !notifyOn("orders"))) return;
    broadcastEvent(o, orderEventText(o), orderKb(o));
  }
  function onSms(e) {
    if (!st.active || !e || e.matched || e.rejected || !e.parsedAmount || !notifyOn("sms")) return;
    const text = "📩 SMS keldi, lekin mos to'lov topilmadi\n💰 " + money(e.parsedAmount) + " · " + (e.from || "?") + "\n\"" + String(e.text || "").slice(0, 300) +
      "\"\n\nKartaga pul tushgan bo'lishi mumkin — kutilayotgan to'lovlarni tekshiring.";
    for (const aid of admins()) send(aid, text, kbd([[btn("🧾 Kutilayotgan to'lovlar", "lp"), btn("📩 SMS", "sm")]]));
  }
  function onBalance(ev) {
    if (!st.active || !notifyOn("payments")) return;
    const text = "✍️ Qo'lda balans: " + (ev.applied >= 0 ? "+" : "−") + money(Math.abs(ev.applied)) + "\n👤 " + who(ev.uid) +
      "\n💰 Yangi balans: " + money(ev.balance) + (ev.note ? "\n📝 " + ev.note : "") + "\n🛡 Admin: " + (ev.by || "?");
    for (const aid of admins()) if (Number(aid) !== Number(ev.by)) send(aid, text, kbd([[btn("👤 Mijoz", "uc:" + ev.uid)]]));
  }
  // Umumiy ogohlantirish (zaxira tugadi, liniya xatosi...). Admin botni hali ochmagan
  // adminga do'kon boti orqali ketadi — muhim xabar yo'qolmasin.
  function notify(text, opts) {
    if (!st.active) return false;
    const kb = opts && opts.order ? orderKb(opts.order) : undefined;
    for (const aid of admins()) send(aid, text, kb).then(j => { if (!j || !j.ok) ctx.fallbackSend(aid, text); });
    return true;
  }

  /* ---------- Ishga tushirish / to'xtatish ---------- */
  async function loop(gen) {
    let offset = 0;
    while (gen === st.gen) {
      const j = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      if (gen !== st.gen) return;
      st.lastPoll = Date.now();
      if (!j || !j.ok) {
        if (j && (j.error_code === 401 || j.error_code === 404)) { st.active = false; st.error = "Telegram tokenni rad etdi (401). BotFather'dan yangi token oling."; return; }
        st.error = j && j.error_code === 409 ? "Shu token boshqa joyda ham ishlatilmoqda (409) — u yerda o'chiring." : "Telegram bilan aloqa: " + ((j && j.description) || "javob yo'q");
        await new Promise(r => setTimeout(r, j && j.error_code === 409 ? 10000 : 5000));
        continue;
      }
      st.error = "";
      for (const up of j.result || []) {
        offset = up.update_id + 1;
        try { if (up.callback_query) await onCallback(up.callback_query); else if (up.message) await onMessage(up.message); }
        catch (e) { console.log("[adminbot] xato: " + (e && e.message)); }
      }
    }
  }
  let retryTimer = null;
  async function start() {
    const tok = ctx.token();
    if (tok === st.token && st.active) return status();
    clearTimeout(retryTimer);
    const gen = ++st.gen;
    Object.assign(st, { token: tok, active: false, username: "", id: 0, error: "" });
    if (!tok) return status();
    const me = await api("getMe", {}, tok);
    if (gen !== st.gen) return status();
    if (!me || !me.ok || !me.result) {
      if (me && me.error_code === 401) st.error = "Token noto'g'ri — Telegram rad etdi.";
      else {
        st.error = "Telegram bilan aloqa yo'q: " + ((me && me.description) || "javob yo'q") + ". 30 soniyadan keyin qayta uriniladi.";
        retryTimer = setTimeout(() => { if (gen === st.gen) { st.token = ""; start(); } }, 30000);
        if (retryTimer.unref) retryTimer.unref();
      }
      return status();
    }
    st.username = me.result.username || ""; st.id = me.result.id;
    await api("deleteWebhook", { drop_pending_updates: false });
    await api("setMyCommands", { commands: [
      { command: "moliya", description: "📊 Moliya hisoboti" }, { command: "tolovlar", description: "🧾 Kutilayotgan to'lovlar" },
      { command: "buyurtmalar", description: "🛒 Bajarilmagan buyurtmalar" }, { command: "mijoz", description: "🔍 Mijoz kartasi" },
      { command: "sms", description: "📩 SMS kuzatuv" }, { command: "holat", description: "⚙️ Holat va sozlamalar" },
      { command: "panel", description: "🌐 Admin panel" }, { command: "menu", description: "Menyu" }] });
    if (gen !== st.gen) return status();
    st.active = true; st.startedAt = Date.now();
    console.log("[adminbot] @" + st.username + " ishga tushdi");
    const base = String(ctx.appUrl() || "");
    if (/^https:\/\//.test(base)) for (const aid of admins())
      api("setChatMenuButton", { chat_id: aid, menu_button: { type: "web_app", text: "Admin panel", web_app: { url: base.replace(/\/+$/, "") + "/?admin=1" } } });
    loop(gen);
    return status();
  }
  function stop() { st.gen++; clearTimeout(retryTimer); Object.assign(st, { token: "", active: false }); }
  function status() { return { active: st.active, username: st.username, error: st.error, startedAt: st.startedAt, lastPoll: st.lastPoll }; }
  async function testMessage(aid) {
    if (!st.active) return { ok: false, error: st.error || "Admin bot ishlamayapti" };
    const j = await send(aid, "✅ Admin bot ishlayapti. Yangi to'lov va buyurtmalar shu yerga keladi.", MENU);
    return j && j.ok ? { ok: true } : { ok: false, error: (j && j.error_code === 403) || /chat not found/i.test((j && j.description) || "")
      ? "Avval @" + st.username + " botiga kirib /start bosing." : ((j && j.description) || "yuborilmadi") };
  }

  return { start, stop, status, notify, onPayment, onOrder, onSms, onBalance, testMessage,
    _internal: { parseAmount, cardText, financeView, paymentsView, ordersView, smsView, statusView, findUsers } };
};
