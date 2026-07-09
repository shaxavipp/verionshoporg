// Minimal static server for Railway — no dependencies needed.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, "verion-shop.html");

const server = http.createServer((req, res) => {
  // Every route serves the app (single-page mini app)
  fs.readFile(FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("verion-shop.html not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Verion Shop running on port " + PORT);
});
