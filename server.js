const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// ─── API Proxies (CORS-free server-side fetch) ─────────────────────────
// gitee.com — live open-source commit history. Gitee API is reliably
//             reachable (verified 200 on every repo below), even on
//             network-restricted connections (e.g. CN network).
const API_PROXIES = {
  // GET /api/gitee/repos/... -> proxy to gitee.com/api/v5/repos/...
  "/api/gitee": {
    host: "gitee.com",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; benpage-live/1.0)" },
    prefix: "/api/v5",
  },
};

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function proxyRequest(req, res, target, hops = 0) {
  const raw = new URL(req.url, "http://localhost");
  const pathAndQuery =
    (target.prefix || "") +
    raw.pathname.replace(/^\/api\/[a-z]+\/?/, "/") +
    raw.search;
  const url = `https://${target.host}${pathAndQuery}`;

  const outbound = https.request(
    url,
    {
      method: req.method || "GET",
      headers: {
        ...target.headers,
        Accept: "application/json",
      },
      timeout: 15000,
    },
    (upstream) => {
      const status = upstream.statusCode || 502;

      // Follow 3xx redirects (Gitee API sometimes 301/302s)
      if (status >= 300 && status < 400 && upstream.headers.location && hops < 3) {
        upstream.resume();
        let next = req.url;
        try {
          next = new URL(upstream.headers.location, url).pathname + new URL(upstream.headers.location, url).search;
        } catch (e) { /* keep original */ }
        return proxyRequest({ ...req, url: next }, res, target, hops + 1);
      }

      const body = [];
      upstream.on("data", (c) => body.push(c));
      upstream.on("end", () => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(Buffer.concat(body));
      });
    }
  );

  outbound.on("timeout", () => {
    outbound.destroy(new Error("upstream timeout"));
  });
  outbound.on("error", (err) => {
    console.error(`proxy error → ${url}:`, err.message);
    json(res, 502, { error: "proxy error", message: err.message });
  });
  outbound.end();
}

const server = http.createServer((req, res) => {
  // CORS not needed (same-origin), but harmless for local dev tools
  res.setHeader("Access-Control-Allow-Origin", "*");

  // API proxy routes
  for (const prefix of Object.keys(API_PROXIES)) {
    if (req.url.startsWith(prefix + "/") || req.url === prefix) {
      return proxyRequest(req, res, API_PROXIES[prefix]);
    }
  }

  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(publicDir, path.normalize(urlPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});