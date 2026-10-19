"use strict";
/* ============================================================================
   Nakrutka liniyalari — bir nechta SMM panel (JustAnotherPanel, Peakerr, SMMKings
   va 2 ta bo'sh joy). Deyarli barcha SMM panellar bir xil "API v2" ishlatadi:
     POST <url>  key=..&action=services|add|status|balance  → JSON
   Shuning uchun yangi panel ulash uchun faqat URL va API kalit kifoya.

   Xizmat kaliti: JAP xizmatlari eski raqamli ID bilan qoladi (yashirilganlar ro'yxati,
   mijoz ilovasi va eski buyurtmalar o'zgarmasin), boshqa panellarniki — "liniya:ID".

   Pul xavfsizligi (o'yin liniyalari bilan bir xil qoidalar):
     - pul buyurtma panelga yuborilishidan OLDIN yechiladi (bir vaqtda bosilgan ikki
       xarid balansdan ortiq sarflay olmaydi);
     - panel ANIQ rad etsa ({"error": ...}) yoki so'rov panelga yetib bormasa — zaxira
       xizmat (bo'lsa) sinab ko'riladi, hech biri qabul qilmasa pul qaytariladi;
     - javob tushunarsiz bo'lsa yoki so'rov yuborilgandan keyin aloqa uzilsa —
       zaxiraga O'TILMAYDI (panel buyurtmani yaratgan bo'lishi mumkin), buyurtma
       "noaniq" bo'lib qoladi va adminga xabar boradi.
   ============================================================================ */
const { httpReq } = require("./lines.js");

const PRESETS = [
  { id: "jap", name: "JustAnotherPanel", url: "https://justanotherpanel.com/api/v2", priority: 10 },
  { id: "peakerr", name: "Peakerr", url: "https://peakerr.com/api/v2", priority: 20 },
  { id: "smmkings", name: "SMMKings", url: "https://smmkings.com/api/v2", priority: 30 },
  { id: "smm4", name: "Bo'sh joy 4", url: "", priority: 40 },
  { id: "smm5", name: "Bo'sh joy 5", url: "", priority: 50 }
];
const S = (v, n) => String(v == null ? "" : v).slice(0, n || 200);

module.exports = function createSmm(ctx) {
  const DB = () => ctx.getDB();
  function store() {
    const D = DB(); if (!D.settings) D.settings = {};
    let st = D.settings.smm;
    if (!st || !Array.isArray(st.lines)) {
      st = D.settings.smm = { lines: [], backups: {} };
      for (const p of PRESETS) st.lines.push({ id: p.id, name: p.name, url: p.url, key: "", enabled: p.id === "jap" && !!ctx.envKey(),
        priority: p.priority, usdRate: 0, markup: "", show: true });
      ctx.save();
    }
    if (!st.backups || typeof st.backups !== "object") st.backups = {};
    // Admin hali tegmagan JAP liniyasi Railway'dagi JAP_API_KEY bo'lsa o'zi yoqiladi (avvalgidek ishlasin).
    const jap = st.lines.find(l => l.id === "jap");
    if (jap && !jap.touched) jap.enabled = !!(jap.key || ctx.envKey());
    return st;
  }
  const lineById = id => store().lines.find(l => l.id === id);
  const lineKey = l => String((l && l.key) || (l && l.id === "jap" ? ctx.envKey() : "") || "");
  const ready = l => !!(l && l.enabled && l.url && lineKey(l));
  const ordered = () => store().lines.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0));
  // Mijozga ko'rinadigan kalit: JAP — raqam (eskicha), boshqalar — "liniya:ID".
  const keyOf = (lineId, id) => lineId === "jap" ? Number(id) : lineId + ":" + id;
  function parseKey(k) {
    const s = String(k == null ? "" : k).trim();
    if (/^\d+$/.test(s)) return { lineId: "jap", id: Number(s) };
    const m = /^([a-z0-9_-]{1,30}):(\d+)$/i.exec(s);
    return m ? { lineId: m[1], id: Number(m[2]) } : null;
  }

  function call(line, params, timeout) {
    return httpReq({ url: line.url, method: "POST", form: Object.assign({ key: lineKey(line) }, params), timeout: timeout || 25000 });
  }

  /* ---------- Xizmatlar ro'yxati (har panel uchun 10 daqiqalik kesh) ---------- */
  const cache = {};   // lineId -> { ts, list, error }
  async function services(line, force) {
    const c = cache[line.id];
    if (!force && c && c.list && Date.now() - c.ts < 10 * 60 * 1000) return c.list;
    const r = await call(line, { action: "services" }, 30000);
    if (!Array.isArray(r.json)) {
      const msg = (r.json && r.json.error) || r.error || ("HTTP " + (r.status || "?"));
      cache[line.id] = { ts: Date.now(), list: c && c.list, error: S(msg, 160) };
      if (c && c.list) return c.list;              // eski ro'yxat bo'lsa — o'shani beramiz
      throw new Error(S(msg, 160));
    }
    const list = r.json.filter(x => x && x.service != null).map(x => ({
      service: Number(x.service), name: S(x.name, 200), category: S(x.category, 120),
      rate: Number(x.rate) || 0, min: Number(x.min) || 0, max: Number(x.max) || 0
    })).filter(x => x.service > 0);
    cache[line.id] = { ts: Date.now(), list, error: "" };
    return list;
  }
  // Barcha tayyor panellarning xizmatlari bitta ro'yxatda (key, lineId, lineName bilan).
  // forClients=true — faqat "mijozlarga ko'rsatish" yoqilgan panellar.
  async function allServices(forClients) {
    const lines = ordered().filter(l => ready(l) && (!forClients || l.show !== false));
    const out = [], errors = [];
    await Promise.all(lines.map(async l => {
      try { for (const s of await services(l)) out.push(Object.assign({ key: keyOf(l.id, s.service), lineId: l.id, lineName: l.name }, s)); }
      catch (e) { errors.push({ lineId: l.id, name: l.name, error: S(e.message, 160) }); }
    }));
    const pr = id => (lineById(id) || {}).priority || 0;
    out.sort((a, b) => pr(a.lineId) - pr(b.lineId));
    return { list: out, errors, configured: lines.length > 0 };
  }
  async function findService(k) {
    const p = parseKey(k); if (!p) return null;
    const line = lineById(p.lineId); if (!ready(line)) return null;
    const svc = (await services(line)).find(s => s.service === p.id);
    return svc ? { key: keyOf(line.id, svc.service), line, svc } : null;
  }

  /* ---------- Narx ---------- */
  function lineUsd(line) { const v = Number(line && line.usdRate); return v > 0 ? v : ctx.usdRate(); }
  function lineMarkup(line) {
    const v = line && line.markup;
    return v === "" || v == null || isNaN(Number(v)) ? ctx.markup() : Math.max(0, Math.min(500, Number(v)));
  }
  function priceUZS(line, svc, qty) { return Math.round(qty * svc.rate * (1 + lineMarkup(line) / 100) / 1000 * lineUsd(line)); }
  // Mijoz ilovasi narxni "qty × rate / 1000 × umumiy kurs" deb hisoblaydi — liniyaning o'z
  // kursi/ustamasi bo'lsa ham bir xil chiqishi uchun rate shu umumiy kursga keltiriladi.
  function clientRate(line, svc) { return Number((svc.rate * (1 + lineMarkup(line) / 100) * lineUsd(line) / ctx.usdRate()).toFixed(4)); }

  /* ---------- Buyurtma ---------- */
  function addVerdict(r) {
    if (r.json && r.json.order != null && r.json.order !== "") return { state: "accepted", ref: S(r.json.order, 60) };
    if (r.json && r.json.error) return { state: "failed", message: S(r.json.error, 200) };
    if (!r.sent) return { state: "failed", message: "Panelga ulanib bo'lmadi (" + (r.error || "?") + ")" };
    return { state: "unknown", message: r.error ? "Aloqa uzildi: " + r.error : "Tushunarsiz javob (HTTP " + (r.status || "?") + "): " + S(r.text, 120) };
  }
  // Asosiy xizmat, keyin zaxira (admin belgilagan bo'lsa). Natija: { state, lineId, service, ref, message, tried }
  async function placeOrder(found, link, quantity) {
    const chain = [{ line: found.line, service: found.svc.service, svc: found.svc }];
    const b = store().backups[String(found.key)];
    const bp = b && parseKey(b);
    if (bp) {
      const bl = lineById(bp.lineId);
      if (ready(bl) && !(bl.id === found.line.id && bp.id === found.svc.service)) {
        try { const bs = (await services(bl)).find(s => s.service === bp.id); if (bs) chain.push({ line: bl, service: bs.service, svc: bs }); } catch (e) {}
      }
    }
    const tried = [];
    for (const c of chain) {
      if (quantity < c.svc.min || quantity > c.svc.max) { tried.push(c.line.name + ": miqdor chegarasi " + c.svc.min + "–" + c.svc.max); continue; }
      let v;
      try { v = addVerdict(await call(c.line, { action: "add", service: c.service, link, quantity })); }
      catch (e) { v = { state: "unknown", message: S(e.message, 160) }; }
      if (v.state === "accepted") return { state: "accepted", lineId: c.line.id, lineName: c.line.name, service: c.service, ref: v.ref, tried, backup: c !== chain[0] };
      if (v.state === "unknown") return { state: "unknown", lineId: c.line.id, lineName: c.line.name, service: c.service, message: v.message, tried };
      tried.push(c.line.name + ": " + v.message);
    }
    return { state: "failed", message: tried.join("; ") || "Panel rad etdi", tried };
  }
  // Holat: bitta buyurtma
  async function status(o) {
    const line = lineById(o.smmLine || "jap");
    if (!ready(line) || !o.japOrderId) return null;
    const r = await call(line, { action: "status", order: o.japOrderId });
    return r.json && typeof r.json === "object" ? r.json : null;
  }
  // Holat: hamma "processing" buyurtmalar, panel bo'yicha guruhlab (100 tadan).
  async function refreshAll(apply) {
    const pending = DB().orders.filter(o => o.status === "processing" && o.japOrderId);
    const byLine = {};
    for (const o of pending) (byLine[o.smmLine || "jap"] = byLine[o.smmLine || "jap"] || []).push(o);
    let changed = false;
    for (const lid of Object.keys(byLine)) {
      const line = lineById(lid); if (!ready(line)) continue;
      const list = byLine[lid];
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100), map = {};
        for (const o of chunk) map[String(o.japOrderId)] = o;
        const r = await call(line, { action: "status", orders: Object.keys(map).join(",") });
        if (!r.json || typeof r.json !== "object") continue;
        for (const id of Object.keys(map)) { const j = r.json[id]; if (j && !j.error && apply(map[id], j)) changed = true; }
      }
    }
    return changed;
  }
  async function balance(line) {
    const r = await call(line, { action: "balance" }, 15000);
    if (r.json && r.json.balance != null) return { ok: true, balance: Number(r.json.balance), currency: S(r.json.currency || "USD", 6),
      message: "Balans: " + r.json.balance + " " + S(r.json.currency || "USD", 6) };
    return { ok: false, message: S((r.json && r.json.error) || r.error || ("HTTP " + (r.status || "?")), 160) };
  }
  async function balances() {
    const lines = ordered().filter(ready);
    return Promise.all(lines.map(async l => {
      try { const b = await Promise.race([balance(l), new Promise((_, j) => setTimeout(() => j(new Error("javob kelmadi")), 15000))]);
        return Object.assign({ id: l.id, name: "📈 " + l.name }, b); }
      catch (e) { return { id: l.id, name: "📈 " + l.name, ok: false, message: S(e.message, 120) }; }
    }));
  }

  /* ---------- Admin API ---------- */
  function mask(l) {
    return { id: l.id, name: l.name, url: l.url, enabled: !!l.enabled, priority: l.priority || 0, usdRate: Number(l.usdRate) || 0,
      markup: l.markup === "" || l.markup == null ? "" : Number(l.markup), show: l.show !== false,
      keySet: !!lineKey(l), keyFromEnv: !l.key && l.id === "jap" && !!ctx.envKey(), ready: ready(l),
      error: (cache[l.id] && cache[l.id].error) || "", count: cache[l.id] && cache[l.id].list ? cache[l.id].list.length : null };
  }
  function handle(req, res, url, m, send, readBody) {
    if (url === "/api/admin/smm/lines" && m === "GET") {
      const st = store();
      send(res, 200, { lines: ordered().map(mask), backups: st.backups, usdRate: ctx.usdRate(), markup: ctx.markup() });
      return true;
    }
    if (url === "/api/admin/smm/line" && m === "POST") {
      readBody(req, res, b => {
        const st = store(), id = S(b.id, 30);
        let l = st.lines.find(x => x.id === id);
        if (!l) {
          if (st.lines.length >= 12) return send(res, 400, { error: "Liniyalar soni chegarasi (12)" });
          l = { id: "smm" + Date.now().toString(36), name: "Yangi panel", url: "", key: "", enabled: false, priority: 60, usdRate: 0, markup: "", show: true };
          st.lines.push(l);
        }
        if (b.name !== undefined) l.name = S(b.name, 40).trim() || l.name;
        if (b.url !== undefined) {
          const u = S(b.url, 200).trim();
          if (u && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(u)) return send(res, 400, { error: "URL https:// bilan boshlanishi kerak (masalan https://panel.com/api/v2)" });
          l.url = u;
        }
        if (b.key) l.key = S(b.key, 200).trim();             // bo'sh kelsa — eski kalit qoladi
        if (b.clearKey === true) l.key = "";
        if (b.priority !== undefined) l.priority = Math.max(0, Math.min(999, Number(b.priority) || 0));
        if (b.usdRate !== undefined) l.usdRate = Math.max(0, Number(b.usdRate) || 0);
        if (b.markup !== undefined) l.markup = b.markup === "" || b.markup == null ? "" : Math.max(0, Math.min(500, Number(b.markup) || 0));
        if (b.show !== undefined) l.show = !!b.show;
        if (b.enabled !== undefined) l.enabled = !!b.enabled;
        l.touched = true;
        if (l.enabled && (!l.url || !lineKey(l))) l.enabled = false;
        delete cache[l.id];
        ctx.save();
        send(res, 200, { ok: true, line: mask(l), note: b.enabled && !l.enabled ? "URL va API kalit kiritilmaguncha yoqib bo'lmaydi" : "" });
      });
      return true;
    }
    if (url === "/api/admin/smm/line-test" && m === "POST") {
      readBody(req, res, async b => {
        const l = lineById(S(b.id, 30));
        if (!l) return send(res, 404, { error: "Liniya topilmadi" });
        if (!l.url || !lineKey(l)) return send(res, 200, { ok: false, message: "URL va API kalit kiriting" });
        const bal = await balance(l);
        let extra = "";
        if (bal.ok) { try { extra = " · " + (await services(l, true)).length + " ta xizmat"; } catch (e) { extra = " · xizmatlar: " + S(e.message, 80); } }
        send(res, 200, { ok: bal.ok, message: bal.message + extra });
      });
      return true;
    }
    if (url === "/api/admin/smm/line-delete" && m === "POST") {
      readBody(req, res, b => {
        const st = store(), id = S(b.id, 30);
        if (PRESETS.some(p => p.id === id)) return send(res, 400, { error: "Asosiy liniyani o'chirib bo'lmaydi — o'chirib (yoqmay) qo'ying" });
        if (DB().orders.some(o => o.smmLine === id && o.status === "processing")) return send(res, 409, { error: "Bu liniyada bajarilayotgan buyurtmalar bor" });
        st.lines = st.lines.filter(l => l.id !== id); ctx.save();
        send(res, 200, { ok: true });
      });
      return true;
    }
    // Zaxira xizmat: asosiy xizmat rad etilsa (balans tugagan, xizmat o'chgan...) shu ishlatiladi.
    if (url === "/api/admin/smm/backup" && m === "POST") {
      readBody(req, res, b => {
        const st = store(), k = parseKey(b.key);
        if (!k) return send(res, 400, { error: "key" });
        const key = String(keyOf(k.lineId, k.id));
        if (!b.backup) { delete st.backups[key]; ctx.save(); return send(res, 200, { ok: true, backups: st.backups }); }
        const bk = parseKey(b.backup);
        if (!bk) return send(res, 400, { error: "Zaxira xizmat ko'rinishi: liniya:ID (masalan peakerr:1234) yoki JAP ID" });
        st.backups[key] = String(keyOf(bk.lineId, bk.id)); ctx.save();
        send(res, 200, { ok: true, backups: st.backups });
      });
      return true;
    }
    return false;
  }

  return { store, parseKey, keyOf, allServices, findService, priceUZS, clientRate, placeOrder, status, refreshAll, balances, handle, lineById, ready, _internal: { addVerdict } };
};
