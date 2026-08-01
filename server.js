const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const JWT_SECRET = process.env.JWT_SECRET || "benpage-dev-secret-change-me";

const db = require("./db");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// ─── API Proxies (CORS-free server-side fetch) ─────────────────────────
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ─── JWT Auth ──────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function getAuthUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return { id: payload.sub, username: payload.username };
}

// ─── API Router ────────────────────────────────────────────────────────
async function handleApi(req, res, urlPath) {
  // Auth
  if (urlPath === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) {
      return json(res, 400, { error: "Username and password are required" });
    }
    const user = db.authUser(username, password);
    if (!user) {
      return json(res, 401, { error: "Invalid credentials" });
    }
    return json(res, 200, { token: signToken(user), user });
  }

  if (urlPath === "/api/auth/me" && req.method === "GET") {
    const user = getAuthUser(req);
    if (!user) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { user });
  }

  // Protected routes below — require valid JWT
  const authUser = getAuthUser(req);

  const requireAuth = () => {
    if (!authUser) {
      json(res, 401, { error: "Unauthorized" });
      return false;
    }
    return true;
  };

  // ── Music API ─────────────────────────────────────────
  if (urlPath === "/api/music" && req.method === "GET") {
    return json(res, 200, { tracks: db.listMusic() });
  }

  if (urlPath === "/api/music" && req.method === "POST") {
    if (!requireAuth()) return;
    const body = await readBody(req);
    const title = String(body.title || "").trim();
    const url = String(body.url || "").trim();
    if (!title || !url) {
      return json(res, 400, { error: "Title and URL are required" });
    }
    return json(res, 201, db.createMusic({ title, url, sort_order: body.sort_order }));
  }

  const musicMatch = urlPath.match(/^\/api\/music\/(\d+)$/);
  if (musicMatch) {
    const id = Number(musicMatch[1]);

    if (req.method === "PUT") {
      if (!requireAuth()) return;
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      const url = String(body.url || "").trim();
      if (!title || !url) {
        return json(res, 400, { error: "Title and URL are required" });
      }
      const existing = db.getMusic(id);
      if (!existing) return json(res, 404, { error: "Track not found" });
      return json(res, 200, db.updateMusic(id, { title, url, sort_order: body.sort_order }));
    }

    if (req.method === "DELETE") {
      if (!requireAuth()) return;
      const existing = db.getMusic(id);
      if (!existing) return json(res, 404, { error: "Track not found" });
      db.deleteMusic(id);
      return json(res, 200, { ok: true });
    }
  }

  // ── Blog API ──────────────────────────────────────────
  if (urlPath === "/api/blog" && req.method === "GET") {
    const posts = db.listBlogPosts().map((p) => ({
      ...p,
      blocks: JSON.parse(p.blocks || "[]"),
    }));
    return json(res, 200, { posts });
  }

  if (urlPath === "/api/blog" && req.method === "POST") {
    if (!requireAuth()) return;
    const body = await readBody(req);
    const title = String(body.title || "").trim();
    if (!title) {
      return json(res, 400, { error: "Title is required" });
    }
    const post = db.createBlogPost({
      title,
      tag: body.tag,
      date: body.date,
      cover: body.cover,
      blocks: Array.isArray(body.blocks) ? body.blocks : [],
    });
    return json(res, 201, { post: { ...post, blocks: JSON.parse(post.blocks) } });
  }

  const blogMatch = urlPath.match(/^\/api\/blog\/(\d+)$/);
  if (blogMatch) {
    const id = Number(blogMatch[1]);

    if (req.method === "PUT") {
      if (!requireAuth()) return;
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      if (!title) {
        return json(res, 400, { error: "Title is required" });
      }
      const existing = db.getBlogPost(id);
      if (!existing) return json(res, 404, { error: "Post not found" });
      const post = db.updateBlogPost(id, {
        title,
        tag: body.tag,
        date: body.date,
        cover: body.cover,
        blocks: Array.isArray(body.blocks) ? body.blocks : [],
      });
      return json(res, 200, { post: { ...post, blocks: JSON.parse(post.blocks) } });
    }

    if (req.method === "DELETE") {
      if (!requireAuth()) return;
      const existing = db.getBlogPost(id);
      if (!existing) return json(res, 404, { error: "Post not found" });
      db.deleteBlogPost(id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Not found" });
}

// ─── Proxies ───────────────────────────────────────────────────────────
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

      if (status >= 300 && status < 400 && upstream.headers.location && hops < 3) {
        upstream.resume();
        let next = req.url;
        try {
          next =
            new URL(upstream.headers.location, url).pathname +
            new URL(upstream.headers.location, url).search;
        } catch (e) {
          /* keep original */
        }
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

// ─── Main Server ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const raw = new URL(req.url, "http://localhost");
  const urlPath = raw.pathname;

  // API routes
  if (urlPath.startsWith("/api/") && !urlPath.startsWith("/api/gitee")) {
    handleApi(req, res, urlPath).catch((err) => {
      console.error("API error:", err.message);
      json(res, 400, { error: err.message });
    });
    return;
  }

  // API proxies
  for (const prefix of Object.keys(API_PROXIES)) {
    if (urlPath.startsWith(prefix + "/") || urlPath === prefix) {
      return proxyRequest(req, res, API_PROXIES[prefix]);
    }
  }

  // Static files
  const filePath = urlPath === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, path.normalize(urlPath));

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