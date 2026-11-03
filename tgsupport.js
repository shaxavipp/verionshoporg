"use strict";
/* ============================================================================
   Support akkaunt (oddiy Telegram akkaunt, masalan @verionshop_support) — MTProto sessiya orqali.

   Admin panel → Support → «Support akkaunt»:
     1) api_id va api_hash (my.telegram.org → API development tools) — bir marta;
     2) telefon raqam → Telegram kod yuboradi;
     3) kod → (ikki bosqichli himoya yoqilgan bo'lsa) 2FA parol;
     4) sessiya saqlanadi, server qayta ishga tushsa ham avtomatik ulanadi.

   Ulangandan keyin: akkauntga shaxsiy chatda yozgan har bir mijoz xabari umumiy support suhbatiga
   (admin inbox) tushadi, AI (yoqilgan bo'lsa) shu akkaunt nomidan javob beradi, admin inbox'dan
   istalgan payt javob yoza oladi. Egasi telefondan o'zi yozsa — u ham suhbatga «admin» bo'lib tushadi
   va shu mijoz uchun AI to'xtaydi.

   Xavfsizlik: sessiya satri va api_hash mijozga ham, admin panelga ham qaytarilmaydi; 2FA parol
   saqlanmaydi; kod va parol logga yozilmaydi. Guruh, kanal, bot va Telegram xizmat xabarlari
   (777000 — kirish kodlari shu yerdan keladi) e'tiborga olinmaydi.
   ============================================================================ */
const S = (v, n) => String(v == null ? "" : v).slice(0, n || 300);
const TG_SERVICE_ID = "777000";

function loadLib() {
  // Sinov uchun soxta kutubxona (faqat TGS_TEST=1 bo'lganda) — haqiqiy Telegram'ga ulanmasdan.
  if (process.env.TGS_TEST === "1" && process.env.TGS_FAKE_LIB) return require(process.env.TGS_FAKE_LIB);
  try {
    const t = require("teleproto");
    return { TelegramClient: t.TelegramClient, Api: t.Api, Logger: t.Logger, StringSession: require("teleproto/sessions").StringSession,
      NewMessage: require("teleproto/events").NewMessage, computeCheck: require("teleproto/Password").computeCheck, bigInt: t.helpers.returnBigInt };
  } catch (e) { return null; }
}

module.exports = function createTgSupport(ctx) {
  const lib = loadLib();
  const DB = () => ctx.getDB();
  function cfg() {
    const s = DB().settings || (DB().settings = {});
    const c = s.tgSupport || (s.tgSupport = {});
    if (c.ai === undefined) c.ai = true;
    return c;
  }
  // Mijozga keyin yozish uchun accessHash kerak (sessiya qayta ochilganda kesh bo'sh bo'ladi).
  function peers() { const s = DB().settings; return s.tgSupportPeers || (s.tgSupportPeers = {}); }
  const apiId = () => Number(process.env.TG_API_ID || cfg().apiId) || 0;
  const apiHash = () => String(process.env.TG_API_HASH || cfg().apiHash || "").trim();
  const session = () => String(process.env.TG_SUPPORT_SESSION || cfg().session || "").trim();

  const st = { client: null, connected: false, connecting: false, error: "", login: null, lastIn: 0, lastOut: 0, startedAt: 0, gen: 0 };
  const sentIds = new Set();          // o'zimiz yuborgan xabarlar (chiquvchi hodisani admin xabari deb qayta yozmaslik)

  function makeClient(sess) {
    const opts = { connectionRetries: 5, autoReconnect: true };
    try { if (lib.Logger) opts.baseLogger = new lib.Logger("error"); } catch (e) {}
    return new lib.TelegramClient(new lib.StringSession(sess || ""), apiId(), apiHash(), opts);
  }
  const errText = e => {
    const m = String((e && (e.errorMessage || e.message)) || e || "");
    if (/PHONE_NUMBER_INVALID/.test(m)) return "Telefon raqam noto'g'ri (masalan +998901234567)";
    if (/PHONE_NUMBER_BANNED/.test(m)) return "Bu raqam Telegram'da bloklangan";
    if (/PHONE_CODE_INVALID/.test(m)) return "Kod noto'g'ri";
    if (/PHONE_CODE_EXPIRED/.test(m)) return "Kod eskirgan — qaytadan kod so'rang";
    if (/PASSWORD_HASH_INVALID/.test(m)) return "2FA parol noto'g'ri";
    if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(m)) return "api_id / api_hash noto'g'ri (my.telegram.org dan qayta oling)";
    if (/FLOOD_WAIT_?(\d+)?/.test(m) || (e && e.seconds)) return "Telegram juda ko'p urinish deb to'xtatdi — " + (Number(e && e.seconds) || Number((/(\d+)/.exec(m) || [])[1]) || 60) + " soniyadan keyin urinib ko'ring";
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(m)) return "Sessiya bekor qilingan (boshqa qurilmadan chiqarilgan) — qaytadan kiring";
    return S(m, 200) || "Noma'lum xato";
  };
  const maskPhone = p => { const d = String(p || "").replace(/\D/g, ""); return d.length > 6 ? "+" + d.slice(0, 3) + " ••• " + d.slice(-4) : ""; };
  const meOf = u => u ? { id: String(u.id), username: S(u.username || "", 40), name: S(((u.firstName || "") + " " + (u.lastName || "")).trim(), 60), phone: maskPhone(u.phone) } : null;

  function status() {
    const c = cfg();
    return { lib: !!lib, configured: !!(apiId() && apiHash()), credsFromEnv: !!(process.env.TG_API_ID && process.env.TG_API_HASH),
      apiId: apiId() ? String(apiId()) : "", hasSession: !!session(), connected: st.connected, connecting: st.connecting,
      me: c.me || null, error: st.error, step: st.login ? st.login.step : "", hint: st.login ? st.login.hint || "" : "",
      phone: st.login ? maskPhone(st.login.phone) : "", ai: !!c.ai, lastIn: st.lastIn, lastOut: st.lastOut, startedAt: st.startedAt };
  }
  function setCreds(b) {
    if (process.env.TG_API_ID && process.env.TG_API_HASH) return "api_id/api_hash Railway Variables orqali berilgan — o'sha yerda o'zgartiring.";
    const id = String((b && b.apiId) || "").trim(), hash = String((b && b.apiHash) || "").trim();
    if (!/^\d{4,12}$/.test(id)) return "api_id — faqat raqamlar (my.telegram.org → API development tools)";
    if (!/^[a-f0-9]{32}$/i.test(hash)) return "api_hash — 32 belgili kod (harf va raqamlar)";
    const c = cfg();
    if (c.apiId !== id || c.apiHash !== hash) { c.apiId = id; c.apiHash = hash; }
    ctx.save();
    return "";
  }
  function setOptions(b) { const c = cfg(); if (b && b.ai !== undefined) c.ai = !!b.ai; ctx.save(); return ""; }

  /* ---------- Kirish: raqam → kod → (2FA) ---------- */
  async function dropLogin() {
    const l = st.login; st.login = null;
    if (l && l.client && l.client !== st.client) { try { await l.client.disconnect(); } catch (e) {} }
  }
  async function loginStart(phone) {
    if (!lib) return { ok: false, error: "Telegram kutubxonasi (teleproto) o'rnatilmagan — npm install" };
    if (!apiId() || !apiHash()) return { ok: false, error: "Avval api_id va api_hash kiriting" };
    const p = "+" + String(phone || "").replace(/\D/g, "");
    if (!/^\+\d{9,15}$/.test(p)) return { ok: false, error: "Telefon raqam ko'rinishi: +998901234567" };
    await dropLogin();
    const client = makeClient("");
    try {
      await client.connect();
      const r = await client.sendCode({ apiId: apiId(), apiHash: apiHash() }, p);
      if (r && r.emailRequired) { try { await client.disconnect(); } catch (e) {} return { ok: false, error: "Telegram bu akkaunt uchun login email o'rnatishni talab qilyapti. Avval telefoningizdagi Telegram'da Sozlamalar → Maxfiylik → Login email ni o'rnating, keyin qayta urining." }; }
      st.login = { client, phone: p, hash: r.phoneCodeHash, step: "code", ts: Date.now(), viaApp: !!(r && r.isCodeViaApp) };
      st.error = "";
      return { ok: true, step: "code", viaApp: !!(r && r.isCodeViaApp) };
    } catch (e) {
      try { await client.disconnect(); } catch (x) {}
      return { ok: false, error: errText(e) };
    }
  }
  async function loginCode(code) {
    const l = st.login;
    if (!l || l.step !== "code" || Date.now() - l.ts > 15 * 60000) { await dropLogin(); return { ok: false, error: "Avval raqamni kiritib kod so'rang" }; }
    const c = String(code || "").replace(/\D/g, "");
    if (!/^\d{4,8}$/.test(c)) return { ok: false, error: "Kod — 5 xonali raqam" };
    try {
      const r = await l.client.invoke(new lib.Api.auth.SignIn({ phoneNumber: l.phone, phoneCodeHash: l.hash, phoneCode: c }));
      if (lib.Api.auth.AuthorizationSignUpRequired && r instanceof lib.Api.auth.AuthorizationSignUpRequired) { await dropLogin(); return { ok: false, error: "Bu raqamda Telegram akkaunt yo'q" }; }
      return finish(l.client, r && r.user);
    } catch (e) {
      const m = String((e && (e.errorMessage || e.message)) || "");
      if (/SESSION_PASSWORD_NEEDED/.test(m)) {
        let hint = "";
        try { const pw = await l.client.invoke(new lib.Api.account.GetPassword()); hint = S(pw && pw.hint, 60); } catch (x) {}
        l.step = "password"; l.hint = hint; l.ts = Date.now();
        return { ok: true, step: "password", hint };
      }
      if (/PHONE_CODE_EXPIRED/.test(m)) await dropLogin();
      return { ok: false, error: errText(e) };
    }
  }
  async function loginPassword(password) {
    const l = st.login;
    if (!l || l.step !== "password" || Date.now() - l.ts > 15 * 60000) { await dropLogin(); return { ok: false, error: "Avval kodni kiriting" }; }
    const pwd = String(password || "");
    if (!pwd || pwd.length > 256) return { ok: false, error: "Parolni kiriting" };
    try {
      const srp = await l.client.invoke(new lib.Api.account.GetPassword());
      const check = await lib.computeCheck(srp, pwd);
      const r = await l.client.invoke(new lib.Api.auth.CheckPassword({ password: check }));
      return finish(l.client, r && r.user);
    } catch (e) { return { ok: false, error: errText(e) }; }
  }
  async function finish(client, user) {
    const c = cfg();
    let me = user;
    try { if (!me || !me.id) me = await client.getMe(); } catch (e) {}
    c.session = client.session.save();
    c.me = meOf(me);
    ctx.save();
    st.login = null;
    await attach(client);
    ctx.notice && ctx.notice("tgs", "🟢 Support akkaunt ulandi", (c.me && (c.me.username ? "@" + c.me.username : c.me.name)) || "");
    return { ok: true, step: "done", me: c.me };
  }
  async function logout() {
    await dropLogin();
    const cl = st.client; st.gen++;
    st.client = null; st.connected = false;
    if (cl) { try { await cl.invoke(new lib.Api.auth.LogOut()); } catch (e) {} try { await cl.disconnect(); } catch (e) {} }
    const c = cfg(); c.session = ""; c.me = null; ctx.save();
    st.error = "";
    return { ok: true };
  }

  /* ---------- Ulanish va xabarlar ---------- */
  async function attach(client) {
    const prev = st.client;
    st.client = client; st.connected = true; st.error = ""; st.startedAt = Date.now();
    const gen = ++st.gen;
    if (prev && prev !== client) { try { await prev.disconnect(); } catch (e) {} }
    client.addEventHandler(ev => { if (gen === st.gen) onEvent(ev).catch(e => console.log("[tgs] hodisa xatosi: " + S(e && e.message, 160))); }, new lib.NewMessage({}));
    console.log("[tgs] support akkaunt ulandi" + (cfg().me && cfg().me.username ? " @" + cfg().me.username : ""));
  }
  async function start() {
    if (!lib || st.connecting || st.connected || !apiId() || !apiHash() || !session()) return status();
    st.connecting = true;
    const client = makeClient(session());
    try {
      await client.connect();
      const ok = await client.checkAuthorization();
      if (!ok) {
        st.error = "Sessiya bekor qilingan (boshqa qurilmadan chiqarilgan) — qaytadan kiring";
        const c = cfg(); c.session = ""; ctx.save();
        try { await client.disconnect(); } catch (e) {}
        ctx.notice && ctx.notice("tgs", "🔴 Support akkaunt uzildi", st.error);
      } else {
        try { const me = await client.getMe(); if (me) { cfg().me = meOf(me); ctx.save(); } } catch (e) {}
        await attach(client);
      }
    } catch (e) {
      st.error = errText(e);
      try { await client.disconnect(); } catch (x) {}
      // Tarmoq uzilishi — keyinroq qayta urinish.
      const t = setTimeout(() => { start(); }, 60000); if (t.unref) t.unref();
    } finally { st.connecting = false; }
    return status();
  }
  function mediaLabel(msg) {
    if (msg.photo) return "[rasm]";
    if (msg.voice) return "[ovozli xabar]";
    if (msg.sticker) return "[stiker]";
    if (msg.document) return "[fayl]";
    if (msg.media) return "[media]";
    return "";
  }
  async function onEvent(ev) {
    const msg = ev && ev.message;
    if (!msg || !ev.isPrivate) return;
    if (msg.out) {
      // Egasi telefondan o'zi yozdi — suhbatga admin xabari bo'lib tushadi (biz yuborganlar bundan mustasno).
      const key = String(msg.chatId) + ":" + msg.id;
      if (sentIds.has(key)) { sentIds.delete(key); return; }
      const uid = String(msg.chatId || "");
      if (!/^\d+$/.test(uid) || uid === TG_SERVICE_ID) return;
      const text = S(msg.message || mediaLabel(msg), 3500);
      if (text && ctx.onOutgoing) ctx.onOutgoing(Number(uid), text);
      return;
    }
    let sender = null;
    try { sender = await msg.getSender(); } catch (e) {}
    if (!sender || sender.bot || sender.self || String(sender.id) === TG_SERVICE_ID) return;
    const uid = String(sender.id);
    if (!/^\d+$/.test(uid)) return;
    if (sender.accessHash != null) {
      const p = peers();
      if (p[uid] !== String(sender.accessHash)) {
        p[uid] = String(sender.accessHash);
        const keys = Object.keys(p); if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 15000)) delete p[k];
        ctx.save();
      }
    }
    st.lastIn = Date.now();
    const text = S((msg.message || "").trim() || mediaLabel(msg), 2000);
    if (!text) return;
    const from = { id: Number(uid), first_name: S(sender.firstName || "", 60), last_name: S(sender.lastName || "", 60), username: S(sender.username || "", 40) };
    try { await st.client.invoke(new lib.Api.messages.ReadHistory({ peer: await inputPeer(uid), maxId: msg.id })); } catch (e) {}
    ctx.onIncoming(from, text, { media: !msg.message && !!mediaLabel(msg) });
  }
  async function inputPeer(uid) {
    const h = peers()[String(uid)];
    if (h != null) return new lib.Api.InputPeerUser({ userId: lib.bigInt(String(uid)), accessHash: lib.bigInt(h) });
    return st.client.getInputEntity(lib.bigInt(String(uid)));
  }
  async function typing(uid) {
    if (!st.connected) return;
    try { await st.client.invoke(new lib.Api.messages.SetTyping({ peer: await inputPeer(uid), action: new lib.Api.SendMessageTypingAction() })); } catch (e) {}
  }
  async function send(uid, text) {
    if (!st.connected || !st.client) return { ok: false, error: "Support akkaunt ulanmagan" };
    try {
      const m = await st.client.sendMessage(await inputPeer(uid), { message: S(text, 4000), linkPreview: false });
      if (m && m.id != null) { sentIds.add(String(uid) + ":" + m.id); if (sentIds.size > 2000) sentIds.delete(sentIds.values().next().value); }
      st.lastOut = Date.now();
      return { ok: true };
    } catch (e) {
      const err = errText(e);
      if (/Sessiya bekor/.test(err)) { st.connected = false; st.error = err; ctx.notice && ctx.notice("tgs", "🔴 Support akkaunt uzildi", err); }
      return { ok: false, error: err };
    }
  }
  return { status, setCreds, setOptions, loginStart, loginCode, loginPassword, logout, start, send, typing,
    connected: () => st.connected, aiOn: () => !!cfg().ai, _internal: { onEvent, st, peers } };
};
