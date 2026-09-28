const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 10000;

const VERSION = "3.7.18.11";
const AUTO_TRADE = false;

const BINANCE_DEMO_BASE = "https://demo-fapi.binance.com";

const PUBLIC_FUTURES_BASES = [
  "https://fapi.binance.com",
  "https://data-api.binance.vision"
];

const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(body);
}

function sendText(res, statusCode, text, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(text);
}

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJSON(res, 404, {
        ok: false,
        error: "not found"
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        sendJSON(res, 500, {
          ok: false,
          error: "failed to read file"
        });
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache"
      });

      res.end(data);
    });
  });
}

function safeStaticPath(requestPath) {
  let decoded;

  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  decoded = decoded.split("?")[0];

  if (decoded.includes("..")) {
    return null;
  }

  if (decoded === "/" || decoded === "") {
    return path.join(ROOT, "index.html");
  }

  const cleanPath = decoded.replace(/^\/+/, "");

  return path.join(ROOT, cleanPath);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // =========================
  // Health check
  // =========================

  if (pathname === "/api/health") {
    return sendJSON(res, 200, {
      ok: true,
      version: VERSION,
      status: "online"
    });
  }

  // =========================
  // Quant status
  // =========================

  if (pathname === "/api/status") {
    return sendJSON(res, 200, {
      ok: true,
      version: VERSION,
      autoTrade: AUTO_TRADE,
      base: BINANCE_DEMO_BASE,
      publicFuturesBases: PUBLIC_FUTURES_BASES,
      serverTime: new Date().toISOString()
    });
  }

  // =========================
  // Version
  // =========================

  if (pathname === "/api/version") {
    return sendJSON(res, 200, {
      ok: true,
      version: VERSION
    });
  }

  // =========================
  // Config
  // =========================

  if (pathname === "/api/config") {
    return sendJSON(res, 200, {
      ok: true,
      version: VERSION,
      autoTrade: AUTO_TRADE,
      base: BINANCE_DEMO_BASE,
      publicFuturesBases: PUBLIC_FUTURES_BASES
    });
  }

  // =========================
  // Root
  // =========================
  //
  // IMPORTANT:
  // /
  // 必须返回 index.html，而不是 JSON
  //

  if (pathname === "/") {
    return serveFile(
      res,
      path.join(ROOT, "index.html")
    );
  }

  // =========================
  // Static files
  // =========================

  const filePath = safeStaticPath(pathname);

  if (!filePath) {
    return sendJSON(res, 400, {
      ok: false,
      error: "bad request"
    });
  }

  return serveFile(res, filePath);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("Quant V3.7.18.11");
  console.log("Server started");
  console.log("PORT:", PORT);
  console.log("AUTO TRADE:", AUTO_TRADE);
  console.log("BASE:", BINANCE_DEMO_BASE);
  console.log("========================================");
});
