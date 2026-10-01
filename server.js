"use strict";
// Minimal local server for Jev Go.
// Serves static files and proxies POST /jev -> TypeSafe System One API.
// Usage:  node server.js   then open http://localhost:3000
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
// Loopback by default so the LAN cannot reach the /jev proxy and spend the
// server-side API key. Set HOST=0.0.0.0 to opt into LAN exposure.
const HOST = process.env.HOST || "127.0.0.1";
// Jev requests are tens of KB (state text plus up to ~84 questions); anything
// larger is not a game move, so refuse instead of buffering it.
const MAX_PROXY_BODY = 262144; // 256 KB
const PROXY_TIMEOUT = 15000;
const TS_HOST = "api.typesafe.ai";
const TS_PATH = "/v1/systemone";

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const ROOT = __dirname;

function readDotEnvApiKey() {
  try {
    const lines = fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || (match[1] !== "TYPESAFE_API_KEY" && match[1] !== "TYPESAFEAI_API_KEY")) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      if (value) return value;
    }
  } catch (e) {}
  return "";
}

// Environment variables take precedence over .env; a browser-supplied
// Authorization header still takes precedence over either.
const ENV_KEY = process.env.TYPESAFE_API_KEY || process.env.TYPESAFEAI_API_KEY || readDotEnvApiKey();

function serveStatic(req, res) {
  const url = req.url === "/" ? "/jev-go.html" : req.url.split("?")[0];
  let file;
  try {
    file = path.resolve(ROOT, "." + decodeURIComponent(url));
  } catch (e) {
    file = "";
  }
  const relative = file ? path.relative(ROOT, file) : "";
  const hidden = relative.split(path.sep).some(part => part.startsWith("."));
  if (!file || !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || hidden) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function proxyJev(req, res) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  let upstream = null;
  let timedOut = false;
  const timeout = () => {
    timedOut = true;
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "proxy_timeout" }));
    }
    if (upstream) upstream.destroy();
    else req.destroy();
  };
  req.setTimeout(PROXY_TIMEOUT, timeout);
  req.on("aborted", () => {
    if (upstream) upstream.destroy();
  });
  req.on("data", (c) => {
    if (tooLarge) return; // keep draining, but stop buffering
    size += c.length;
    if (size > MAX_PROXY_BODY) { tooLarge = true; chunks.length = 0; return; }
    chunks.push(c);
  });
  req.on("end", () => {
    req.setTimeout(0);
    if (tooLarge) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large", limitBytes: MAX_PROXY_BODY }));
      return;
    }
    const body = Buffer.concat(chunks);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    // Forward Authorization header from the browser request
    const auth = req.headers["authorization"];
    if (auth) headers["Authorization"] = auth;
    else if (ENV_KEY) headers["Authorization"] = "Bearer " + ENV_KEY;

    upstream = https.request(
      { host: TS_HOST, path: TS_PATH, method: "POST", headers },
      (up) => {
        up.setTimeout(PROXY_TIMEOUT, () => {
          timedOut = true;
          up.destroy(new Error("upstream timeout"));
        });
        res.writeHead(up.statusCode || 502, {
          "Content-Type": up.headers["content-type"] || "application/json",
        });
        up.pipe(res);
      }
    );
    upstream.setTimeout(PROXY_TIMEOUT, () => {
      timedOut = true;
      upstream.destroy(new Error("upstream timeout"));
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(timedOut ? 504 : 502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: timedOut ? "proxy_timeout" : "proxy_error", detail: String(e.message) }));
      }
    });
    upstream.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/jev") return proxyJev(req, res);
  if (req.method === "GET" && req.url === "/jevstatus") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ serverKey: !!ENV_KEY }));
    return;
  }
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log("Jev Go");
  console.log("Open http://localhost:" + PORT);
  console.log("Jev proxy: POST /jev -> https://" + TS_HOST + TS_PATH);
  console.log("Server-side key: " + (ENV_KEY ? "yes (TYPESAFE_API_KEY)" : "no"));
  console.log("Listening on " + HOST + " (set HOST=0.0.0.0 for LAN access)");
});
