/* ================= Steam hamyon va Virtual raqamlar =================
   1) Steam: mijoz login va dollar summasini kiritadi. Narx = summa × admin kursi.
      Ludovex liniyasi yoqilgan bo'lsa — avtomatik (POST /order, game_key steam-topup,
      expected_price_usdt bilan narx himoyasi); aks holda buyurtma adminga qo'lda bajarish uchun.
   2) Virtual raqam (5sim.net): Telegram uchun SMS qabul qiladigan raqam. Mijoz davlatni
      tanlaydi → raqam beriladi → kod kelguncha kutiladi (20 daqiqa). Kod kelmasa yoki mijoz
      bekor qilsa — saytda bekor qilinadi va pul qaytadi.
   Pul har doim avval band qilinadi (reserve), keyin saytga so'rov ketadi. Sayt aniq rad etsa —
   pul qaytadi; javob noaniq bo'lsa — pul band qoladi va admin tekshiradi (ikki marta to'lanmaydi). */
"use strict";
const https = require("https");

module.exports = function (ctx) {
  const DBx = () => ctx.getDB();
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const send = ctx.send;

  /* ---------- HTTP (https, JSON) ---------- */
  function call(base, path, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      let u; try { u = new URL(base + path); } catch (e) { return resolve({ sent: false, error: "BAD_URL" }); }
      const body = opts.json ? JSON.stringify(opts.json) : null;
      const h = Object.assign({ Accept: "application/json" }, opts.headers || {});
      if (body) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(body); }
      let done = false; const fin = r => { if (!done) { done = true; resolve(r); } };
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: opts.method || "GET",
        headers: h, timeout: opts.timeout || 25000 }, res => {
        const ch = []; let n = 0; res.on("data", c => { if (n < 2e6) { const x = Buffer.isBuffer(c) ? c : Buffer.from(String(c)); ch.push(x); n += x.length; } });
        res.on("end", () => { const b = Buffer.concat(ch).toString("utf8"); let j = null; try { j = JSON.parse(b); } catch (e) {} fin({ sent: true, status: res.statusCode, json: j, text: b.slice(0, 300) }); });
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
      req.on("error", e => fin({ sent: ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].indexOf(e.code) === -1, error: e.code || e.message }));
      if (body) req.write(body);
      req.end();
    });
  }

  /* ---------- umumiy: buyurtma, pul qaytarish, ogohlantirish ---------- */
  const ALERT = {};
  function alertOnce(key, text) {
    const now = Date.now();
    if (ALERT[key] && now - ALERT[key] < 10 * 60 * 1000) return;
    ALERT[key] = now; ctx.notifyAdmins(text);
  }
  function refund(o, why) {
    if (o.status !== "pending") return;
    o.status = "cancelled"; o.cancelReason = why || "";
    const acc = DBx().users[String(o.uid)] || (DBx().users[String(o.uid)] = { balance: 0 });
    acc.balance += o.price;
    ctx.save();
    ctx.tgSend(o.uid, "❌ " + o.item + " — bekor qilindi, " + o.price.toLocaleString("ru-RU").replace(/,/g, " ") + " so'm balansingizga qaytarildi." + (why ? "\n" + why : ""));
  }
  function markDone(o, delivered) {
    if (o.status !== "pending") return;
    o.status = "done"; o.doneTs = Date.now(); o.delivered = delivered;
    ctx.save();
    try { ctx.creditReferralOnOrder(o); ctx.creditLoyaltyOnOrder(o); } catch (e) {}
    ctx.tgSend(o.uid, "✅ " + o.item + "\n" + delivered);
    ctx.notifyOrderChannel(o);
  }
  function newOrder(u, item, price, extra) {
    const o = Object.assign({ id: ctx.genId("VN"), seq: ctx.nextOrderSeq(), uid: u.id, uname: u.username || null,
      item, price, status: "pending", ts: Date.now(), delivered: null, doneTs: null }, extra);
    DBx().orders.push(o); ctx.save(); ctx.notifyOrder(o);
    return o;
  }
  const money = n => Math.round(n).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";

  /* ======================= STEAM ======================= */
  function steamCfg() {
    const s = DBx().settings;
    const c = s.steam || (s.steam = {});
    if (c.enabled === undefined) c.enabled = true;
    if (!(c.rate > 0)) c.rate = 13500;
    if (!(c.min > 0)) c.min = 1;
    if (!(c.max > 0)) c.max = 250;
    if (!Array.isArray(c.presets) || !c.presets.length) c.presets = [5, 10, 20, 50, 100];
    if (!c.mode) c.mode = "auto";       // auto — Ludovex yoqilgan bo'lsa avtomatik; manual — doim admin
    return c;
  }
  const LVX = () => process.env.LUDOVEX_BASE || "https://api.ludovex.org/api/v2/";
  function lvxLine() {
    try { return ctx.gameLines().find(l => l.type === "ludovex" && l.enabled && l.config && l.config.apiKey); } catch (e) { return null; }
  }
  const lvxH = l => ({ "X-API-Key": String(l.config.apiKey) });
  function steamPrice(usd) { return Math.ceil(usd * steamCfg().rate / 100) * 100; }

  function steamPublic() {
    const c = steamCfg();
    return { enabled: !!c.enabled, rate: c.rate, min: c.min, max: c.max, presets: c.presets, auto: c.mode !== "manual" && !!lvxLine() };
  }
  // Ludovex holat so'zi → bizning holat
  function lvxState(d) {
    const st = String((d && (d.status || d.state)) || "").toUpperCase();
    if (d && d.refunded === true || st === "REFUNDED") return "failed";
    if (/^(COMPLETED|SUCCESS|DELIVERED|DONE)$/.test(st)) return "done";
    if (st === "FAILED") return "unknown";
    return "pending";
  }
  async function steamFulfill(o) {
    const l = lvxLine(), c = steamCfg();
    if (c.mode === "manual" || !l) {
      ctx.notifyAdmins("🎮 #" + o.seq + " Steam: $" + o.steam.usd + " → login «" + o.steam.login + "» (" + money(o.price) + ")\nQo'lda to'ldiring va «Bajarildi» bosing.", { order: o });
      return;
    }
    const amt = o.steam.usd.toFixed(2);
    // 1) Narx so'rovi — tannarx bizning narxdan oshib ketmasin (zarar himoyasi).
    const q = await call(LVX(), "catalog/steam-topup?amount_usd=" + amt, { headers: lvxH(l) });
    const quote = q.json && q.json.ok && Array.isArray(q.json.data) && q.json.data[0];
    if (!quote || !quote.price_usdt) {
      const why = (q.json && q.json.error && (q.json.error.code + " " + (q.json.error.message || ""))) || q.error || ("HTTP " + q.status);
      alertOnce("steam-q", "🚨 Steam (Ludovex) narxini olib bo'lmadi: " + str(why, 200) + "\nMijozlarga «keyinroq urinib ko'ring» chiqmoqda.");
      return refund(o, "Steam xizmati hozircha ishlamayapti, keyinroq urinib ko'ring.");
    }
    const costUzs = Number(quote.price_usdt) * (Number(l.config.rate) || 12500);
    if (costUzs > o.price) {
      alertOnce("steam-loss", "⚠️ Steam: tannarx (" + money(costUzs) + ") sotuv narxidan (" + money(o.price) + ") katta! Admin → Steam kursini oshiring. Buyurtma bekor qilindi.");
      return refund(o, "Steam xizmati hozircha ishlamayapti, keyinroq urinib ko'ring.");
    }
    // 2) Buyurtma — idempotency kaliti bilan (qayta yuborilsa ham bir marta yechiladi).
    const key = "vs-steam-" + o.id;
    const r = await call(LVX(), "order", { method: "POST", headers: Object.assign(lvxH(l), { "Idempotency-Key": key }),
      json: { game_key: "steam-topup", amount_usd: amt, player_id: o.steam.login, expected_price_usdt: String(quote.price_usdt), idempotency_key: key }, timeout: 40000 });
    const j = r.json;
    if (j && j.ok && j.data) {
      o.steam.ref = String(j.data.id || ""); o.steam.cost = costUzs; o.costUzs = Math.round(costUzs); ctx.save();
      const s = lvxState(j.data);
      if (s === "done") return markDone(o, "💳 Steam hamyoniga $" + amt + " tushirildi (login: " + o.steam.login + ")");
      if (s === "failed") return refund(o, "Steam to'ldirilmadi.");
      if (s === "unknown") return ctx.notifyAdmins("❓ #" + o.seq + " Steam: Ludovex FAILED qaytardi, pul qaytgani aniq emas. Ludovex kabinetidan tekshiring.", { order: o });
      return; // PROCESSING — poll
    }
    if (j && [400, 402, 409, 422, 429].indexOf(r.status) !== -1) {
      const code = j.error && j.error.code;
      if (code === "INSUFFICIENT_BALANCE") alertOnce("steam-bal", "🚨 Steam ishlamayapti — Ludovex hamyonida coin yetarli emas. Hamyonni to'ldiring.");
      else alertOnce("steam-" + code, "🚨 Steam buyurtmasi rad etildi: " + str((code || "") + " " + ((j.error && j.error.message) || ""), 200));
      const userMsg = /player|login|account|INVALID_ORDER/i.test(JSON.stringify(j.error || {})) && code !== "INSUFFICIENT_BALANCE"
        ? "Steam login noto'g'ri yoki bu akkauntga to'ldirib bo'lmaydi. Loginni tekshiring." : "Steam xizmati hozircha ishlamayapti, keyinroq urinib ko'ring.";
      return refund(o, userMsg);
    }
    if (r.status === 401 || r.status === 403) {
      alertOnce("steam-auth", "⛔ Steam (Ludovex): kalit yoki ruxsat xatosi (HTTP " + r.status + "). Liniya sozlamasini tekshiring.");
      return refund(o, "Steam xizmati hozircha ishlamayapti, keyinroq urinib ko'ring.");
    }
    if (!r.sent) return refund(o, "Steam xizmati hozircha ishlamayapti, keyinroq urinib ko'ring.");
    // Javob noaniq — pul band, admin tekshiradi (ikkinchi marta yuborilmaydi).
    ctx.notifyAdmins("❓ #" + o.seq + " Steam $" + amt + " → " + o.steam.login + ": Ludovex javobi noaniq (" + str(r.error || r.text, 120) + "). Kabinetdan tekshirib «Bajarildi» yoki «Bekor qilish» bosing.", { order: o });
  }
  async function steamPoll() {
    const l = lvxLine(); if (!l) return;
    for (const o of DBx().orders) {
      if (o.status !== "pending" || !o.steam || !o.steam.ref) continue;
      const r = await call(LVX(), "order/" + encodeURIComponent(o.steam.ref), { headers: lvxH(l) });
      const d = r.json && r.json.ok && r.json.data; if (!d) continue;
      const s = lvxState(d);
      if (s === "done") markDone(o, "💳 Steam hamyoniga $" + o.steam.usd.toFixed(2) + " tushirildi (login: " + o.steam.login + ")");
      else if (s === "failed") refund(o, "Steam to'ldirilmadi.");
    }
  }

  /* ======================= VIRTUAL RAQAM (5sim) ======================= */
  function vnCfg() {
    const s = DBx().settings;
    const c = s.vnum || (s.vnum = {});
    if (c.enabled === undefined) c.enabled = false;
    if (!(c.rate > 0)) c.rate = 140;          // 5sim narxi (RUB) → so'm
    if (!(c.markup >= 0)) c.markup = 30;      // ustama, %
    if (!c.product) c.product = "telegram";
    if (!(c.ttlMin > 0)) c.ttlMin = 20;
    return c;
  }
  const FIVE = () => process.env.FIVESIM_BASE || "https://5sim.net/v1/";
  const fiveH = () => ({ Authorization: "Bearer " + String(vnCfg().apiKey || "") });
  const vnPrice = cost => Math.ceil(cost * vnCfg().rate * (1 + vnCfg().markup / 100) / 500) * 500;
  let PRICES = { at: 0, list: [] };
  async function vnCountries(force) {
    const c = vnCfg();
    if (!force && PRICES.list.length && Date.now() - PRICES.at < 5 * 60 * 1000) return PRICES.list;
    const r = await call(FIVE(), "guest/prices?product=" + encodeURIComponent(c.product));
    const data = r.json && (r.json[c.product] || r.json);
    if (!data || typeof data !== "object") throw new Error("Sayt narxlarni bermadi (" + (r.error || r.status) + ")");
    const list = [];
    for (const country of Object.keys(data)) {
      const ops = data[country] || {};
      let cost = 0, count = 0;
      for (const op of Object.keys(ops)) {
        const x = ops[op] || {};
        if (!(x.count > 0) || !(x.cost > 0)) continue;
        count += x.count;
        if (!cost || x.cost < cost) cost = x.cost;
      }
      if (count > 0 && cost > 0) list.push({ key: country, cost, count, price: vnPrice(cost) });
    }
    PRICES = { at: Date.now(), list };
    return list;
  }
  async function vnBuy(u, country) {
    const c = vnCfg();
    if (!c.enabled || !c.apiKey) return { code: 503, body: { error: "off", message: "Virtual raqam xizmati hozircha o'chiq" } };
    let list; try { list = await vnCountries(); } catch (e) { return { code: 503, body: { error: "off", message: "Hozircha ishlamayapti, keyinroq urinib ko'ring" } }; }
    const it = list.find(x => x.key === country);
    if (!it) return { code: 404, body: { error: "no_country", message: "Bu davlatda bo'sh raqam yo'q" } };
    const acc = ctx.user(u);
    if (!(acc.balance >= it.price)) return { code: 402, body: { error: "balance", need: it.price - acc.balance } };
    acc.balance -= it.price; ctx.save();
    const o = newOrder(u, "📱 Virtual raqam (" + countryName(country) + ")", it.price, { vnum: { country, phone: "", ext: "", code: "", until: 0 } });
    const r = await call(FIVE(), "user/buy/activation/" + encodeURIComponent(country) + "/any/" + encodeURIComponent(c.product), { headers: fiveH() });
    const j = r.json;
    if (j && j.id && j.phone) {
      o.vnum.ext = String(j.id); o.vnum.phone = String(j.phone); o.vnum.until = Date.now() + c.ttlMin * 60 * 1000;
      o.costUzs = Math.round((Number(j.price) || it.cost) * c.rate); ctx.save();
      return { code: 200, body: { ok: true, order: ctx.pubOrder(o), balance: acc.balance } };
    }
    const t = (r.text || "").toLowerCase();
    const known = /no free phones|not enough|bad country|bad operator|no product|server offline/.test(t);
    if (/not enough|balance/.test(t)) alertOnce("vn-bal", "🚨 Virtual raqam ishlamayapti — 5sim hamyonida coin yetarli emas. Hamyonni to'ldiring.");
    else if (r.status === 401) alertOnce("vn-auth", "⛔ Virtual raqam: 5sim API kaliti noto'g'ri (401). Admin → Steam va raqamlar.");
    else if (!/no free phones/.test(t)) alertOnce("vn-err", "⚠️ Virtual raqam olishda xato: " + str(r.text || r.error, 200));
    // So'rov yetmagan, yoki sayt aniq rad etgan (4xx / ma'lum xato matni) — raqam berilmagan, pul qaytadi.
    if (!r.sent || known || (r.status >= 400 && r.status < 500)) {
      refund(o, "");
      return { code: 503, body: { error: "fail", message: /no free phones/.test(t) ? "Bu davlatda bo'sh raqam qolmadi, boshqasini tanlang" : "Hozircha ishlamayapti, keyinroq urinib ko'ring", balance: acc.balance } };
    }
    ctx.notifyAdmins("❓ #" + o.seq + " Virtual raqam: 5sim javobi noaniq (" + str(r.text || r.error, 120) + "). Tekshirib, kerak bo'lsa «Bekor qilish» bosing.", { order: o });
    return { code: 200, body: { ok: true, order: ctx.pubOrder(o), balance: acc.balance, pending: true } };
  }
  async function vnCheck(o) {
    if (!o.vnum || !o.vnum.ext || o.status !== "pending") return o;
    const r = await call(FIVE(), "user/check/" + encodeURIComponent(o.vnum.ext), { headers: fiveH() });
    const j = r.json; if (!j) return o;
    const sms = Array.isArray(j.sms) ? j.sms : [];
    const code = sms.length ? String(sms[sms.length - 1].code || sms[sms.length - 1].text || "") : "";
    if (code) {
      o.vnum.code = code; ctx.save();
      call(FIVE(), "user/finish/" + encodeURIComponent(o.vnum.ext), { headers: fiveH() }).catch(() => {});
      markDone(o, "📱 Raqam: +" + o.vnum.phone.replace(/^\+/, "") + "\n🔑 Kod: " + code);
    } else if (/CANCELED|TIMEOUT|BANNED/.test(String(j.status || ""))) {
      refund(o, "Kod kelmadi — pul qaytarildi.");
    } else if (Date.now() > o.vnum.until) {
      await call(FIVE(), "user/cancel/" + encodeURIComponent(o.vnum.ext), { headers: fiveH() });
      refund(o, "Kod " + vnCfg().ttlMin + " daqiqada kelmadi — pul qaytarildi.");
    }
    return o;
  }
  async function vnCancel(o) {
    if (o.status !== "pending" || !o.vnum) return { ok: false, error: "state" };
    if (o.vnum.code) return { ok: false, error: "code_received" };
    if (o.vnum.ext) {
      const r = await call(FIVE(), "user/cancel/" + encodeURIComponent(o.vnum.ext), { headers: fiveH() });
      // Sayt bekor qilmasa (masalan SMS allaqachon keldi) — tekshiramiz.
      if (!(r.json && (r.json.status === "CANCELED" || r.json.id)) && r.status !== 200) { await vnCheck(o); if (o.status !== "pending") return { ok: o.status === "cancelled" }; return { ok: false, error: "cancel_failed" }; }
    }
    refund(o, "");
    return { ok: true };
  }
  async function vnPoll() {
    for (const o of DBx().orders) if (o.status === "pending" && o.vnum && o.vnum.ext) { try { await vnCheck(o); } catch (e) {} }
  }
  // Davlat nomi va bayroq (5sim kalitlari bo'yicha)
  const C = { russia: ["Rossiya", "RU"], ukraine: ["Ukraina", "UA"], kazakhstan: ["Qozog'iston", "KZ"], uzbekistan: ["O'zbekiston", "UZ"], kyrgyzstan: ["Qirg'iziston", "KG"],
    tajikistan: ["Tojikiston", "TJ"], usa: ["AQSh", "US"], england: ["Angliya", "GB"], germany: ["Germaniya", "DE"], france: ["Fransiya", "FR"], netherlands: ["Niderlandiya", "NL"],
    poland: ["Polsha", "PL"], indonesia: ["Indoneziya", "ID"], philippines: ["Filippin", "PH"], vietnam: ["Vyetnam", "VN"], india: ["Hindiston", "IN"], turkey: ["Turkiya", "TR"],
    brazil: ["Braziliya", "BR"], canada: ["Kanada", "CA"], georgia: ["Gruziya", "GE"], azerbaijan: ["Ozarbayjon", "AZ"], armenia: ["Armaniston", "AM"], belarus: ["Belarus", "BY"],
    moldova: ["Moldova", "MD"], estonia: ["Estoniya", "EE"], latvia: ["Latviya", "LV"], lithuania: ["Litva", "LT"], finland: ["Finlandiya", "FI"], sweden: ["Shvetsiya", "SE"],
    spain: ["Ispaniya", "ES"], italy: ["Italiya", "IT"], portugal: ["Portugaliya", "PT"], romania: ["Ruminiya", "RO"], bulgaria: ["Bolgariya", "BG"], czech: ["Chexiya", "CZ"],
    egypt: ["Misr", "EG"], nigeria: ["Nigeriya", "NG"], kenya: ["Keniya", "KE"], southafrica: ["JAR", "ZA"], china: ["Xitoy", "CN"], hongkong: ["Gonkong", "HK"], japan: ["Yaponiya", "JP"],
    korea: ["Koreya", "KR"], thailand: ["Tailand", "TH"], malaysia: ["Malayziya", "MY"], cambodia: ["Kambodja", "KH"], laos: ["Laos", "LA"], myanmar: ["Myanma", "MM"],
    bangladesh: ["Bangladesh", "BD"], pakistan: ["Pokiston", "PK"], afghanistan: ["Afg'oniston", "AF"], israel: ["Isroil", "IL"], saudiarabia: ["Saudiya Arabistoni", "SA"],
    mexico: ["Meksika", "MX"], argentina: ["Argentina", "AR"], colombia: ["Kolumbiya", "CO"], chile: ["Chili", "CL"], peru: ["Peru", "PE"], australia: ["Avstraliya", "AU"] };
  function countryName(k) { return (C[k] && C[k][0]) || (k.charAt(0).toUpperCase() + k.slice(1)); }
  function countryIso(k) { return (C[k] && C[k][1]) || ""; }

  // Oldingi tekshiruv tugamaguncha yangisi boshlanmaydi (sayt sekin bo'lsa so'rovlar ustma-ust yig'ilmasin).
  const running = { steam: false, vn: false };
  const guard = (k, fn) => { if (running[k]) return; running[k] = true; fn().catch(() => {}).then(() => { running[k] = false; }); };
  const timer = setInterval(() => { guard("steam", steamPoll); guard("vn", vnPoll); }, Number(process.env.EXTRA_POLL_MS) || 20000);
  if (timer.unref) timer.unref();

  /* ======================= HTTP ======================= */
  function handle(req, res, url, m, q) {
    if (url === "/api/steam" && m === "GET") { send(res, 200, steamPublic()); return true; }
    if (url === "/api/steam/buy" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => {
        const c = steamCfg();
        if (!c.enabled) return send(res, 503, { error: "off", message: "Steam to'ldirish hozircha o'chiq" });
        const login = str(b.login, 64);
        if (!/^[A-Za-z0-9_.-]{2,64}$/.test(login)) return send(res, 400, { error: "login", message: "Steam loginni to'g'ri kiriting (faqat lotin harflari, raqam, _ . -)" });
        const usd = Math.round(Number(b.usd) * 100) / 100;
        if (!(usd >= c.min && usd <= c.max)) return send(res, 400, { error: "amount", message: "Summa $" + c.min + " dan $" + c.max + " gacha" });
        const price = steamPrice(usd), acc = ctx.user(u);
        if (!(acc.balance >= price)) return send(res, 402, { error: "balance", need: price - acc.balance });
        acc.balance -= price; ctx.save();
        const o = newOrder(u, "💳 Steam hamyon $" + usd.toFixed(2) + " (" + login + ")", price, { steam: { login, usd } });
        steamFulfill(o).catch(e => ctx.notifyAdmins("❓ #" + o.seq + " Steam xato: " + e.message, { order: o })).then(() => {
          send(res, 200, { ok: true, order: ctx.pubOrder(o), balance: acc.balance });
        });
      });
      return true;
    }
    if (url === "/api/vnum/countries" && m === "GET") {
      const c = vnCfg();
      if (!c.enabled || !c.apiKey) { send(res, 200, { enabled: false, list: [] }); return true; }
      vnCountries().then(list => send(res, 200, { enabled: true, ttlMin: c.ttlMin,
        list: list.map(x => ({ key: x.key, name: countryName(x.key), iso: countryIso(x.key), count: x.count, price: x.price })) }))
        .catch(() => send(res, 200, { enabled: true, list: [], error: "Hozircha ishlamayapti" }));
      return true;
    }
    if (url === "/api/vnum/buy" && m === "POST") {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      ctx.readBody(req, res, b => { vnBuy(u, str(b.country, 40)).then(r => send(res, r.code, r.body)).catch(e => send(res, 500, { error: e.message })); });
      return true;
    }
    if ((url === "/api/vnum/check" && m === "GET") || (url === "/api/vnum/cancel" && m === "POST")) {
      const u = ctx.auth(req); if (!u) { send(res, 401, { error: "auth" }); return true; }
      const go = id => {
        const o = DBx().orders.find(x => x.id === id && x.uid === u.id && x.vnum);
        if (!o) return send(res, 404, { error: "not found" });
        const p = url.endsWith("cancel") ? vnCancel(o).then(r => send(res, r.ok ? 200 : 409, Object.assign(r, { order: ctx.pubOrder(o), balance: (DBx().users[String(u.id)] || {}).balance })))
          : vnCheck(o).then(() => send(res, 200, { order: ctx.pubOrder(o) }));
        p.catch(e => send(res, 500, { error: e.message }));
      };
      if (m === "GET") go(str(q.get("id"), 40)); else ctx.readBody(req, res, b => go(str(b.id, 40)));
      return true;
    }
    // --- admin ---
    if (url === "/api/admin/extra" && (m === "GET" || m === "POST")) {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      const view = () => { const v = vnCfg(); return { steam: steamCfg(), ludovex: !!lvxLine(),
        vnum: { enabled: v.enabled, rate: v.rate, markup: v.markup, ttlMin: v.ttlMin, product: v.product, apiKeySet: !!v.apiKey } }; };
      if (m === "GET") { send(res, 200, view()); return true; }
      ctx.readBody(req, res, b => {
        const s = steamCfg(), v = vnCfg(), num = (x, lo, hi) => { const n = Number(x); return n >= lo && n <= hi ? n : null; };
        if (b.steam) {
          if ("enabled" in b.steam) s.enabled = !!b.steam.enabled;
          const r = num(b.steam.rate, 1000, 100000); if (r) s.rate = r;
          const mn = num(b.steam.min, 0.5, 100); if (mn) s.min = mn;
          const mx = num(b.steam.max, 1, 500); if (mx) s.max = mx;
          if (b.steam.mode === "manual" || b.steam.mode === "auto") s.mode = b.steam.mode;
          if (Array.isArray(b.steam.presets)) { const p = b.steam.presets.map(Number).filter(x => x > 0 && x <= 500).slice(0, 6); if (p.length) s.presets = p; }
        }
        if (b.vnum) {
          if ("enabled" in b.vnum) v.enabled = !!b.vnum.enabled;
          const r = num(b.vnum.rate, 1, 100000); if (r) v.rate = r;
          const mk = num(b.vnum.markup, 0, 500); if (mk !== null) v.markup = mk;
          const t = num(b.vnum.ttlMin, 5, 60); if (t) v.ttlMin = t;
          if (b.vnum.apiKey) v.apiKey = str(b.vnum.apiKey, 2000);
          PRICES = { at: 0, list: [] };
        }
        ctx.save();
        send(res, 200, Object.assign({ ok: true }, view()));
      });
      return true;
    }
    if (url === "/api/admin/vnum/test" && m === "POST") {
      if (!ctx.isAdm(ctx.auth(req))) { send(res, 403, { error: "not admin" }); return true; }
      call(FIVE(), "user/profile", { headers: fiveH() }).then(r => {
        if (r.json && r.json.balance != null) send(res, 200, { ok: true, message: "Ulandi. Balans: " + r.json.balance + " coin" });
        else send(res, 200, { ok: false, message: r.status === 401 ? "API kalit noto'g'ri" : "Javob: " + (r.error || r.status) });
      });
      return true;
    }
    return false;
  }
  return { handle, steamCfg, vnCfg, vnCountries, vnCheck };
};
