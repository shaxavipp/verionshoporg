/* ================= Liniyalar: yetkazib beruvchi saytlar =================
   MooGold, G2Bulk va Smile.one bilan ishlash. Har bir tur games.js'dagi
   registerLineType() orqali ulanadi.

   Har bir turning vazifalari:
     order(line, order, pkg, route)  → { state, ref, message }   (majburiy)
     status(line, ref, order)        → { state, message } | null (kechikib bajaradiganlar)
     check(line, game, account, sku) → { ok, nickname, message } (nikni tekshirish)
     test(line)                      → { ok, message }           (kalit/balans tekshiruvi)
     games(line)                     → [{ code, name, img }]     (saytdagi o'yinlar)
     packages(line, code)            → { name, img, fields, items:[{ sku, name, cost, img }] }

   state qiymatlari:
     "done"     — sayt bajardi;
     "accepted" — qabul qildi, keyin bajaradi (status() so'rab turiladi);
     "failed"   — sayt ANIQ rad etdi (pul yechilmagan) → keyingi liniyaga o'tish xavfsiz;
     "unknown"  — javob tushunarsiz yoki so'rov yuborilgandan keyin uzildi. Sayt buyurtmani
                  bajargan bo'lishi mumkin, shuning uchun keyingi liniyaga O'TILMAYDI — aks
                  holda bitta buyurtma ikki joydan ikki marta to'ldirilib ketardi.

   Manbalar: MooGold — rasmiy namuna kod (doc.moogold.com) va pyMooGoldApi; Smile.one —
   aungmyokyaw97/Smile-One kutubxonasi; G2Bulk — api.g2bulk.com/docs (qisman). */
"use strict";
const https = require("https");
const crypto = require("crypto");
const qs = require("querystring");

/* ---------- HTTP ---------- */
// Ulanishdan OLDIN yuz beradigan xatolar — so'rov saytga yetib bormagan, demak
// buyurtma albatta yaratilmagan va boshqa liniyani sinash xavfsiz.
const PRE_CONNECT = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "BAD_URL"];
function httpReq(o) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(o.url); } catch (e) { return resolve({ sent: false, error: "BAD_URL" }); }
    const body = o.json !== undefined ? (typeof o.json === "string" ? o.json : JSON.stringify(o.json))
      : (o.form ? qs.stringify(o.form) : null);
    const h = Object.assign({ Accept: "application/json", "User-Agent": "VerionShop/1.0" }, o.headers || {});
    if (body != null) {
      h["Content-Type"] = h["Content-Type"] || (o.form ? "application/x-www-form-urlencoded" : "application/json");
      h["Content-Length"] = Buffer.byteLength(body);
    }
    let done = false;
    const fin = r => { if (!done) { done = true; resolve(r); } };
    let req;
    try {
      req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        method: o.method || "GET", headers: h, timeout: o.timeout || 20000 }, res => {
        let b = "";
        res.on("data", c => { if (b.length < 3e6) b += c; });
        res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) {} fin({ sent: true, status: res.statusCode, json: j, text: b.slice(0, 300) }); });
        res.on("error", e => fin({ sent: true, error: e.code || e.message }));
      });
    } catch (e) { return fin({ sent: false, error: e.code || e.message }); }
    req.on("timeout", () => { const e = new Error("timeout"); e.code = "TIMEOUT"; req.destroy(e); });
    req.on("error", e => fin({ sent: PRE_CONNECT.indexOf(e.code) === -1, error: e.code || e.message }));
    if (body != null) req.write(body);
    req.end();
  });
}
// Javob kelmagan yoki tushunarsiz bo'lganda umumiy xulosa.
function transportVerdict(r) {
  if (!r.sent) return { state: "failed", message: "saytga ulanib bo'lmadi (" + r.error + ")" };
  if (r.error) return { state: "unknown", message: "so'rov yuborildi, lekin javob kelmadi (" + r.error + ")" };
  if (r.status === 401 || r.status === 403) return { state: "failed", disableLine: true, message: "kalit noto'g'ri yoki ruxsat yo'q (HTTP " + r.status + ")" };
  if (r.status >= 400 && r.status < 500) return { state: "failed", message: "sayt rad etdi (HTTP " + r.status + ")" };
  return { state: "unknown", message: "tushunarsiz javob (HTTP " + r.status + ")" };
}
const S = (v, n) => String(v == null ? "" : v).slice(0, n || 200);
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const arr = v => Array.isArray(v) ? v : [];
// Buyurtmadagi o'yinchi ma'lumotlari: o'yin sozlamasidagi 1-maydon — o'yinchi ID,
// 2-maydon — server/zona (MLBB Server ID kabi).
function playerOf(o) {
  const g = o.game || {}, f = g.fields || [], a = g.account || {};
  return { player: f[0] ? S(a[f[0].key], 40) : "", server: f[1] ? S(a[f[1].key], 40) : "" };
}
// Import paytida narx hisoblash uchun umumiy maydonlar (har bir API turida bor).
const PRICE_FIELDS = [
  { key: "rate", label: "Kurs: saytdagi 1 birlik = necha so'm", ph: "12800" },
  { key: "markup", label: "Ustama, %", ph: "12" }
];

/* ======================= MooGold ======================= */
const MOO = "https://moogold.com/wp-json/v1/api/";
function mooCall(line, path, data, nestData, extraTop) {
  const c = line.config || {};
  // Rasmiy namunada buyurtma maydonlari "data" ichida, qolgan so'rovlarda yuqori darajada.
  const payload = nestData ? Object.assign({ path, data }, extraTop || {}) : Object.assign({ path }, data || {});
  const js = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const auth = crypto.createHmac("sha256", String(c.secret || "")).update(js + ts + path).digest("hex");
  return httpReq({ url: MOO + path, method: "POST", json: js, headers: {
    timestamp: ts, auth, Authorization: "Basic " + Buffer.from(S(c.partnerId) + ":" + S(c.secret)).toString("base64") } });
}
const mooErr = j => j && (j.err_code || j.status === false) ? S(j.err_message || j.message || j.err_code || "rad etildi", 200) : "";
function mooStatusWord(s) {
  s = String(s || "").toLowerCase();
  if (/complet/.test(s)) return "done";
  if (/refund|fail|cancel|reject/.test(s)) return "failed";
  return null;
}
const moogold = {
  label: "MooGold",
  fields: [
    { key: "partnerId", label: "Partner ID", required: true },
    { key: "secret", label: "Secret key", secret: true, required: true },
    { key: "orderCategory", label: "Buyurtma kategoriyasi (odatda 1 — to'g'ridan-to'g'ri to'ldirish)", ph: "1" },
    { key: "listCategory", label: "Mahsulotlar ro'yxati kategoriyasi (odatda 50)", ph: "50" }
  ].concat(PRICE_FIELDS),
  async order(line, o, pkg, route) {
    const p = playerOf(o);
    const names = arr(route.meta && route.meta.fields).filter(Boolean);
    const fn = names.length ? names : ["User ID", "Server"];
    const data = { category: S(line.config.orderCategory || "1", 10), "product-id": S(route.sku, 80), quantity: 1 };
    if (p.player) data[fn[0]] = p.player;
    if (p.server && fn[1]) data[fn[1]] = p.server;
    const r = await mooCall(line, "order/create_order", data, true, { partnerOrderId: S(o.id, 60) });
    if (!r.json) return transportVerdict(r);
    const err = mooErr(r.json);
    if (err) return { state: "failed", message: err };
    if (r.json.status === true || r.json.account_details) {
      const ref = S((r.json.account_details || {}).order_id || r.json.order_id, 80);
      return { state: "accepted", ref, message: S(r.json.message, 200) };
    }
    return { state: "unknown", message: "tushunarsiz javob: " + S(r.text, 120) };
  },
  async status(line, ref, o) {
    let r = await mooCall(line, "order/order_detail_partner_id", { partner_order_id: S(o.id, 60) });
    let j = r.json;
    if ((!j || !j.order_status) && ref) { r = await mooCall(line, "order/order_detail", { order_id: ref }); j = r.json; }
    if (!j || !j.order_status) return null;
    const w = mooStatusWord(j.order_status);
    return w ? { state: w, message: w === "done" ? "" : "MooGold: " + S(j.order_status, 40) } : null;
  },
  async test(line) {
    const r = await mooCall(line, "user/balance", {});
    if (r.json && r.json.balance != null) return { ok: true, message: "Balans: " + r.json.balance + " " + S(r.json.currency || "", 6) };
    return { ok: false, message: mooErr(r.json) || transportVerdict(r).message };
  },
  async games(line) {
    const r = await mooCall(line, "product/list_product", { category_id: Number(line.config.listCategory || 50) });
    if (!Array.isArray(r.json)) throw new Error(mooErr(r.json) || transportVerdict(r).message);
    return r.json.filter(x => x && x.ID).map(x => ({ code: S(x.ID, 30), name: S(x.post_title, 80), img: "" }));
  },
  async packages(line, code) {
    const r = await mooCall(line, "product/product_detail", { product_id: S(code, 30) });
    const j = r.json;
    if (!j || !Array.isArray(j.Variation)) throw new Error(mooErr(j) || transportVerdict(r).message);
    return {
      name: S(j.Product_Name, 80), img: S(j.Image_URL, 500),
      fields: arr(j.fields).map(f => typeof f === "string" ? f : (f && (f.field || f.name)) || "").filter(Boolean).slice(0, 3),
      items: j.Variation.map(v => ({ sku: S(v.variation_id, 80), name: S(v.variation_name, 80), cost: num(v.variation_price), img: "" }))
        .filter(x => x.sku)
    };
  }
};

/* ======================= G2Bulk ======================= */
const G2 = "https://api.g2bulk.com/v1/";
const g2Headers = line => ({ "X-API-Key": S((line.config || {}).apiKey, 200) });
function g2List(j, keys) {
  if (Array.isArray(j)) return j;
  for (const k of keys) { if (j && Array.isArray(j[k])) return j[k]; if (j && j.data && Array.isArray(j.data[k])) return j.data[k]; }
  if (j && Array.isArray(j.data)) return j.data;
  return [];
}
const g2Img = x => S(x && (x.image_url || x.imageUrl || x.image || x.logo || x.icon || x.thumbnail || x.cover), 500);
const g2bulk = {
  label: "G2Bulk",
  fields: [
    { key: "apiKey", label: "API key (G2Bulk Telegram botidan)", secret: true, required: true }
  ].concat(PRICE_FIELDS),
  async order(line, o, pkg, route, env) {
    const p = playerOf(o);
    const game = S(route.meta && route.meta.game, 60);
    if (!game) return { state: "failed", message: "paketga G2Bulk o'yin kodi biriktirilmagan (katalogdan import qiling)" };
    const body = { catalogue_name: S(route.sku, 120), player_id: p.player, remark: S(o.id, 60) };
    if (p.server) body.server_id = p.server;
    if (env && env.callbackUrl) body.callback_url = env.callbackUrl;
    const r = await httpReq({ url: G2 + "games/" + encodeURIComponent(game) + "/order", method: "POST", json: body, headers: g2Headers(line) });
    if (r.status === 401 || (r.status === 403 && !r.json)) return transportVerdict(r);
    if (r.json && r.status >= 200 && r.status < 300) {
      const j = r.json;
      if (j.success === false || j.status === false || j.error) return { state: "failed", message: S(j.message || j.error || "rad etildi", 200) };
      const ord = (j.order && typeof j.order === "object") ? j.order : ((j.data && typeof j.data === "object" && !Array.isArray(j.data)) ? j.data : j);
      const ref = S(ord.id || ord.order_id || ord.orderId || j.order_id || "", 80);
      const w = g2StatusWord(ord.status || ord.order_status || j.status);
      if (w === "done") return { state: "done", ref, message: S(j.message, 200) };
      if (w === "failed") return { state: "failed", ref, message: S(j.message || ord.status, 200) };
      return { state: "accepted", ref, message: S(j.message, 200) };
    }
    if (r.json && r.status >= 400 && r.status < 500)
      return { state: "failed", disableLine: r.status === 401, message: S(r.json.message || r.json.error || ("HTTP " + r.status), 200) };
    return transportVerdict(r);
  },
  async test(line) {
    const r = await httpReq({ url: G2 + "games", headers: g2Headers(line) });
    const list = g2List(r.json, ["games"]);
    if (r.status === 200 && list.length) return { ok: true, message: "Sayt ochildi: " + list.length + " ta o'yin. Kalit birinchi buyurtmada tekshiriladi." };
    return { ok: false, message: transportVerdict(r).message };
  },
  async games(line) {
    const r = await httpReq({ url: G2 + "games", headers: g2Headers(line) });
    const list = g2List(r.json, ["games"]);
    if (!list.length) throw new Error(transportVerdict(r).message);
    return list.map(x => ({ code: S(x.code || x.slug || x.id, 60), name: S(x.name || x.title, 80), img: g2Img(x) })).filter(x => x.code);
  },
  async packages(line, code) {
    const r = await httpReq({ url: G2 + "games/" + encodeURIComponent(code) + "/catalogue", headers: g2Headers(line) });
    const list = g2List(r.json, ["catalogues", "catalogue", "items", "packages"]);
    if (!list.length) throw new Error(transportVerdict(r).message);
    const gm = (r.json && (r.json.game || (r.json.data && r.json.data.game))) || {};
    return {
      name: S(gm.name, 80), img: g2Img(gm), fields: [], meta: { game: S(code, 60) },
      items: list.map(x => ({ sku: S(x.name || x.catalogue_name || x.title, 120), name: S(x.name || x.title, 80),
        cost: num(x.amount != null ? x.amount : (x.price != null ? x.price : x.cost)), img: g2Img(x) })).filter(x => x.sku)
    };
  }
};
function g2StatusWord(s) {
  s = String(s == null ? "" : s).toLowerCase();
  if (/complet|success|deliver|done|finish/.test(s)) return "done";
  if (/fail|reject|cancel|refund|error/.test(s)) return "failed";
  return null;
}

/* ======================= Smile.one ======================= */
function smileBase(c) {
  const reg = String(c.region || "br").trim().toLowerCase().replace(/[^a-z]/g, "");
  return "https://www.smile.one/" + (reg ? reg + "/" : "") + "smilecoin/api/";
}
// Imzo: kalitlar alfavit bo'yicha, "k=v&" ketma-ket + oxiriga maxfiy kalit, so'ng md5(md5()).
function smileSign(params, key) {
  let s = "";
  for (const k of Object.keys(params).sort()) s += k + "=" + params[k] + "&";
  s += key;
  const md5 = x => crypto.createHash("md5").update(x).digest("hex");
  return md5(md5(s));
}
function smileCall(line, endpoint, params) {
  const c = line.config || {};
  const p = Object.assign({}, params, { uid: S(c.uid, 60), email: S(c.email, 120), time: String(Math.floor(Date.now() / 1000)) });
  p.sign = smileSign(p, S(c.key, 200));
  return httpReq({ url: smileBase(c) + endpoint, method: "POST", form: p });
}
const smileOk = j => j && Number(j.status) === 200;
const SMILE_REJECT = /insufficient|not enough|balance|saldo|not ?found|invalid|incorrect|wrong|sign|error|fail|n[aã]o encontrado|inv[aá]lid|exist|disabled|unavailable|limit/i;
const smileone = {
  label: "Smile.one",
  fields: [
    { key: "uid", label: "UID", required: true },
    { key: "email", label: "Email (Smile.one akkaunti)", required: true },
    { key: "key", label: "Merchant key", secret: true, required: true },
    { key: "region", label: "Region (br, ph, ru…)", ph: "br" },
    { key: "products", label: "Mahsulot kodlari (vergul bilan)", ph: "mobilelegends" }
  ].concat(PRICE_FIELDS),
  async order(line, o, pkg, route) {
    const p = playerOf(o);
    const product = S((route.meta && route.meta.product) || "mobilelegends", 60);
    const r = await smileCall(line, "createorder", { product, productid: S(route.sku, 60), userid: p.player, zoneid: p.server });
    if (!r.json) return transportVerdict(r);
    if (smileOk(r.json)) return { state: "done", ref: S(r.json.order_id || r.json.orderid, 80), message: "" };
    // 200 dan boshqa kodlarning to'liq ro'yxati ochiq hujjatda yo'q. Xabar matnidan rad
    // etilgani ANIQ ko'rinsa — "failed" (keyingi liniya), aks holda "unknown" (admin ko'radi).
    const msg = S(r.json.message || ("status " + r.json.status), 200);
    if (SMILE_REJECT.test(msg)) return { state: "failed", message: msg };
    return { state: "unknown", message: "Smile.one: " + msg };
  },
  async check(line, game, acc, ctxPkg) {
    if (!ctxPkg) return null;
    const product = S((ctxPkg.meta && ctxPkg.meta.product) || "mobilelegends", 60);
    const f = game.fields || [];
    const r = await smileCall(line, "getrole", { product, productid: S(ctxPkg.sku, 60),
      userid: f[0] ? S(acc[f[0].key], 40) : "", zoneid: f[1] ? S(acc[f[1].key], 40) : "" });
    if (smileOk(r.json)) return { ok: true, nickname: S(r.json.username || r.json.nickname || r.json.name, 60) };
    if (r.json && r.json.status != null) return { ok: false, message: S(r.json.message || "Akkaunt topilmadi", 160) };
    return null;   // tekshirib bo'lmadi — xaridga to'sqinlik qilmaymiz
  },
  async test(line) {
    const prod = S(String(line.config.products || "mobilelegends").split(",")[0].trim(), 60);
    const r = await smileCall(line, "querypoints", { product: prod });
    if (smileOk(r.json)) return { ok: true, message: "Balans: " + (r.json.smile_points != null ? r.json.smile_points : "?") + " smile coin" };
    return { ok: false, message: (r.json && S(r.json.message, 160)) || transportVerdict(r).message };
  },
  async games(line) {
    return String(line.config.products || "mobilelegends").split(",").map(s => s.trim()).filter(Boolean)
      .map(code => ({ code: S(code, 60), name: code === "mobilelegends" ? "Mobile Legends" : code, img: "" }));
  },
  async packages(line, code) {
    const r = await smileCall(line, "productlist", { product: S(code, 60) });
    const list = r.json && r.json.data && Array.isArray(r.json.data.product) ? r.json.data.product : null;
    if (!smileOk(r.json) || !list) throw new Error((r.json && S(r.json.message, 160)) || transportVerdict(r).message);
    return {
      name: code === "mobilelegends" ? "Mobile Legends" : S(code, 60), img: "", fields: [], meta: { product: S(code, 60) },
      items: list.map(x => ({ sku: S(x.id, 60), name: S(x.spu || x.name, 100), cost: num(x.cost_price != null ? x.cost_price : x.price), img: "" }))
        .filter(x => x.sku)
    };
  }
};

/* ======================= Ludovex (api.ludovex.org/api/v2, OpenAPI 3.1) =======================
   Javob: { ok, data | error:{code,message} }. Narxlar USDT. Buyurtmada idempotency_key — bir xil kalit
   bilan qayta yuborilsa sayt yangi pul yechmaydi, o'sha buyurtmani qaytaradi. 201 + PROCESSING —
   hali bajarilmagan, GET /order/{id} bilan kuzatiladi. 402/422/429 — buyurtma yaratilmagan. */
const LVX = "https://api.ludovex.org/api/v2/";
const lvxH = line => ({ "X-API-Key": S((line.config || {}).apiKey, 300) });
const lvxErr = j => j && j.error ? S((j.error.code || "") + (j.error.message ? ": " + j.error.message : ""), 220) : "";
const lvxImg = x => S(x && (x.image || x.image_url || x.img || x.icon || x.logo || x.cover || x.thumbnail || x.picture), 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function lvxWord(d) {
  const st = String((d && (d.status || d.state)) || "").toUpperCase();
  if (d && d.refunded === true) return "failed";
  if (/^(COMPLETED|SUCCESS|DELIVERED|DONE|PAID_DELIVERED)$/.test(st)) return "done";
  if (st === "REFUNDED") return "failed";
  if (st === "FAILED") return "failed_maybe";   // pul qaytgani aniq emas
  return "pending";
}
function lvxVerdict(d, ref) {
  const w = lvxWord(d), msg = S(d && (d.message || d.status_message || d.error), 200);
  if (w === "done") {
    const code = S(d.code || d.voucher || d.pin || (Array.isArray(d.codes) ? d.codes.join(", ") : ""), 300);
    return { state: "done", ref, message: code ? "✅ Kod: " + code : msg };
  }
  if (w === "failed") return { state: "failed", ref, message: "Ludovex: bekor qilindi, pul qaytarildi " + msg };
  if (w === "failed_maybe") return { state: "unknown", ref, message: "Ludovex FAILED (pul qaytgani tasdiqlanmagan) " + msg };
  return { state: "accepted", ref, message: msg };
}
const ludovex = {
  label: "Ludovex",
  fields: [
    { key: "apiKey", label: "API key (pp_live_… — Kabinet → API-ключи; read + order + balance)", secret: true, required: true }
  ].concat(PRICE_FIELDS),
  async order(line, o, pkg, route) {
    const p = playerOf(o), m = route.meta || {};
    const game = S(m.game, 191);
    if (!game) return { state: "failed", message: "paketga Ludovex game_key biriktirilmagan (katalogdan import qiling)" };
    const body = { game_key: game, variation_id: S(route.sku, 512), player_id: p.player || null, idempotency_key: "vs-" + S(o.id, 120) };
    if (p.server) body.zone_id = p.server;
    const r = await httpReq({ url: LVX + "order", method: "POST", json: body, headers: lvxH(line), timeout: 30000 });
    const j = r.json;
    if (r.status === 401) return { state: "failed", disableLine: true, message: "Ludovex: kalit noto'g'ri yoki bekor qilingan (401)" };
    if (r.status === 403 && j) {
      const c = j.error && j.error.code;
      return { state: "failed", disableLine: c === "FORBIDDEN_SCOPE" || c === "IP_NOT_ALLOWED" || c === "FORBIDDEN",
        message: "Ludovex: " + lvxErr(j) + (c === "IP_NOT_ALLOWED" ? " — kalit sozlamasida IP ro'yxatini bo'shating" : c === "FORBIDDEN_SCOPE" ? " — kalitga order ruxsatini bering" : "") };
    }
    if (j && (r.status === 402 || r.status === 422 || r.status === 429)) return { state: "failed", message: "Ludovex: " + lvxErr(j) };
    if (j && j.ok && j.data && r.status >= 200 && r.status < 300) {
      const ref = S(j.data.id || j.data.order_id, 40);
      return lvxVerdict(j.data, ref);
    }
    return transportVerdict(r);
  },
  async status(line, ref) {
    if (!/^\d+$/.test(String(ref || ""))) return null;
    const r = await httpReq({ url: LVX + "order/" + ref, headers: lvxH(line) });
    if (!(r.json && r.json.ok && r.json.data)) return null;
    const v = lvxVerdict(r.json.data, ref);
    return v.state === "accepted" ? null : v;
  },
  async test(line) {
    const r = await httpReq({ url: LVX + "balance", headers: lvxH(line) });
    if (r.json && r.json.ok && r.json.data) return { ok: true, message: "Ulandi. Balans: " + S(r.json.data.balance, 30) + " " + S(r.json.data.currency || "USDT", 10) };
    if (r.json && r.json.error) return { ok: false, message: lvxErr(r.json) + (r.json.error.code === "FORBIDDEN_SCOPE" ? " — kalitga balance ruxsatini bering" : "") };
    return { ok: false, message: transportVerdict(r).message };
  },
  async games(line) {
    const r = await httpReq({ url: LVX + "catalog", headers: lvxH(line) });
    if (!(r.json && r.json.ok && Array.isArray(r.json.data))) throw new Error(lvxErr(r.json) || transportVerdict(r).message);
    return r.json.data.map(x => ({ code: S(x.game_key || x.key || x.id, 191), name: S(x.name || x.title, 80), img: lvxImg(x) }))
      .filter(x => x.code && !/steam-topup|telegram-stars/.test(x.code));
  },
  async packages(line, code) {
    await sleep(1100);   // 60 so'rov/daqiqa chegarasi — hammasini yuklashda oshib ketmasin
    const r = await httpReq({ url: LVX + "catalog/" + encodeURIComponent(code), headers: lvxH(line) });
    if (!(r.json && r.json.ok && Array.isArray(r.json.data))) throw new Error(lvxErr(r.json) || transportVerdict(r).message);
    return {
      name: "", img: "", fields: [], meta: { game: S(code, 191) },
      items: r.json.data.map(x => ({ sku: S(x.variation_id || x.id, 512), name: S(x.name || x.title, 100),
        cost: num(x.price_usdt != null ? x.price_usdt : x.price), img: lvxImg(x) })).filter(x => x.sku && x.cost > 0)
    };
  }
};

/* ---------- Universal API: istalgan sayt (hujjatiga qarab sozlanadi) ----------
   Shablonlarda: {sku} {player} {server} {ref} {key} — buyurtma ma'lumotlari bilan almashtiriladi.
   Javob: muvaffaqiyat maydoni (masalan "status") qiymati ro'yxatdagilardan biri bo'lsa — bajarildi;
   xato maydoni bo'lsa yoki 4xx — rad etildi (keyingi liniyaga); boshqa hammasi — "unknown". */
function pick(j, p) { return String(p || "").split(".").filter(Boolean).reduce((a, k) => a == null ? a : a[k], j); }
function fillTpl(t, v, enc) { return String(t || "").replace(/\{(sku|player|server|ref|key)\}/g, (_, k) => enc ? encodeURIComponent(S(v[k], 200)) : S(v[k], 200).replace(/["\\]/g, "")); }
function customHeaders(c, v) {
  const h = {};
  for (const ln of String(c.headers || "").split(/\n|;;/)) {
    const i = ln.indexOf(":"); if (i < 1) continue;
    const k = ln.slice(0, i).trim(), val = fillTpl(ln.slice(i + 1).trim(), v);
    if (/^[A-Za-z0-9-]{1,60}$/.test(k)) h[k] = val;
  }
  return h;
}
async function customCall(c, urlT, v, bodyT, method) {
  const url = fillTpl(urlT, v, true);
  if (!/^https:\/\//i.test(url)) return { sent: false, error: "BAD_URL" };
  const m = String(method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
  const o = { url, method: m, headers: customHeaders(c, v) };
  if (m === "POST" && bodyT) {
    const b = fillTpl(bodyT, v);
    if (/^\s*[{[]/.test(b)) o.json = b; else { o.form = qs.parse(b); }
  }
  return httpReq(o);
}
const custom = {
  label: "Universal API (istalgan sayt)",
  fields: [
    { key: "key", label: "API kalit (shablonlarda {key})", secret: true },
    { key: "orderUrl", label: "Buyurtma URL (https://…/order?product={sku})", required: true },
    { key: "method", label: "Usul: POST yoki GET", ph: "POST" },
    { key: "headers", label: "Sarlavhalar (har biri ;; bilan): Authorization: Bearer {key}", ph: "Authorization: Bearer {key}" },
    { key: "body", label: "So'rov tanasi: {\"product\":\"{sku}\",\"user_id\":\"{player}\",\"zone\":\"{server}\"}", ph: "{\"product\":\"{sku}\",\"user_id\":\"{player}\",\"zone_id\":\"{server}\",\"ref\":\"{ref}\"}" },
    { key: "okPath", label: "Muvaffaqiyat maydoni (masalan status yoki data.status)", ph: "status" },
    { key: "okValues", label: "Muvaffaqiyat qiymatlari (vergul bilan)", ph: "success,true,1,200,completed" },
    { key: "errPath", label: "Xato maydoni (bo'lsa — rad etildi)", ph: "error" },
    { key: "refPath", label: "Buyurtma raqami maydoni", ph: "order_id" },
    { key: "balanceUrl", label: "Balans URL («Sinash» uchun, ixtiyoriy)", ph: "" },
    { key: "balancePath", label: "Balans maydoni", ph: "balance" }
  ].concat(PRICE_FIELDS),
  async order(line, o, pkg, route) {
    const c = line.config || {}, pl = playerOf(o);
    const v = { sku: route.sku, player: pl.player, server: pl.server, ref: "VS" + S(o.seq || o.id, 40), key: c.key };
    const r = await customCall(c, c.orderUrl, v, c.body, c.method || "POST");
    if (!r.sent || r.error || !r.json || r.status >= 400) return transportVerdict(r.json && r.status < 400 ? Object.assign({}, r, { status: 500 }) : r);
    const okv = String(c.okValues || "success,true,1,200,completed,ok").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    const val = String(pick(r.json, c.okPath || "status")).toLowerCase();
    const ref = S(pick(r.json, c.refPath || "order_id"), 120);
    if (okv.includes(val)) return { state: "done", ref, message: "" };
    const err = c.errPath ? pick(r.json, c.errPath) : null;
    if (err) return { state: "failed", message: "sayt rad etdi: " + S(typeof err === "string" ? err : JSON.stringify(err), 200) };
    return { state: "unknown", ref, message: "tushunarsiz javob: " + S(r.text, 200) };
  },
  async test(line) {
    const c = line.config || {};
    if (!c.balanceUrl) return { ok: !!c.orderUrl, message: c.orderUrl ? "Sozlamalar saqlangan. Balans URL kiritilmagan — haqiqiy tekshiruv uchun uni qo'shing." : "Buyurtma URL kerak" };
    const r = await customCall(c, c.balanceUrl, { key: c.key }, "", "GET");
    if (!r.sent || r.status >= 400 || !r.json) return { ok: false, message: "Javob: " + (r.error || ("HTTP " + r.status + " " + S(r.text, 120))) };
    const b = pick(r.json, c.balancePath || "balance");
    return { ok: b != null, message: b != null ? "Ulandi. Balans: " + S(b, 40) : "Ulandi, lekin balans maydoni topilmadi: " + S(r.text, 150) };
  }
};

module.exports = { register(registerLineType) {
  registerLineType("moogold", moogold);
  registerLineType("g2bulk", g2bulk);
  registerLineType("smileone", smileone);
  registerLineType("ludovex", ludovex);
  registerLineType("custom", custom);
}, httpReq, smileSign, _internal: { playerOf, transportVerdict, g2StatusWord, mooStatusWord } };
