// Verion Shop server — static app + shared catalog API. No dependencies.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";           // set in Railway → Variables
const ADMIN_IDS = (process.env.ADMIN_IDS || "5606872249,8684274899")
  .split(",").map(s => Number(s.trim())).filter(Boolean);
const MAX_BODY = 10 * 1024 * 1024;                        // 10 MB (images are base64)
const HTML_FILE = path.join(__dirname, "verion-shop.html");

// Data dir: use /data if a Railway Volume is mounted there, else ./data
let DATA_DIR = process.env.DATA_DIR || "/data";
try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) { DATA_DIR = path.join(__dirname, "data"); fs.mkdirSync(DATA_DIR, { recursive: true }); }
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");

/* Validate Telegram WebApp initData (official HMAC scheme). Returns user object or null. */
function checkInitData(initData) {
  try {
    if (!initData || !BOT_TOKEN) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => k + "=" + v).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
    if (calc !== hash) return null;
    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate || (Date.now() / 1000 - authDate) > 259200) return null; // 3 days
    return JSON.parse(params.get("user") || "null");
  } catch (e) { return null; }
}

function send(res, code, obj, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/api/catalog" && req.method === "GET") {
    fs.readFile(CATALOG_FILE, (err, data) => {
      if (err) return send(res, 404, { error: "no catalog yet" });
      send(res, 200, data.toString());
    });
    return;
  }

  if (url === "/api/catalog" && req.method === "POST") {
    if (!BOT_TOKEN) return send(res, 503, { error: "BOT_TOKEN not set on server" });
    const user = checkInitData(req.headers["x-init-data"] || "");
    if (!user || ADMIN_IDS.indexOf(user.id) === -1) return send(res, 403, { error: "not admin" });
    let body = "", size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { send(res, 413, { error: "too large" }); req.destroy(); return; }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const arr = JSON.parse(body);
        if (!Array.isArray(arr) || !arr.length) throw new Error("not array");
        fs.writeFile(CATALOG_FILE, JSON.stringify(arr), err => {
          if (err) return send(res, 500, { error: "write failed" });
          send(res, 200, { ok: true, items: arr.length, by: user.id });
        });
      } catch (e) { send(res, 400, { error: "invalid json" }); }
    });
    return;
  }

  // everything else → the app
  fs.readFile(HTML_FILE, (err, data) => {
    if (err) return send(res, 500, "verion-shop.html not found", "text/plain");
    send(res, 200, data.toString(), "text/html; charset=utf-8");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Verion Shop on port " + PORT + " | data: " + DATA_DIR + " | BOT_TOKEN " + (BOT_TOKEN ? "set" : "MISSING"));
});
