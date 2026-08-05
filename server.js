const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
// Where uploaded blog photos are stored.
// Production: /var/www/static/photo/ (served at https://<host>/photo/...)
// Local dev:  ./data/photos/        (served at http://localhost:3000/photo/...)
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
const PHOTO_DIR =
  process.env.PHOTO_DIR ||
  (isWritableDir("/var/www/static/photo")
    ? "/var/www/static/photo"
    : path.join(__dirname, "data", "photos"));
const PHOTO_URL_PREFIX = "/photo/";
// Where uploaded recordings (music tracks) are stored.
// Production: /home/www/static/recordings (served at https://<host>/recordings/...)
// Local dev:  ./data/recordings           (served at http://localhost:3000/recordings/...)
const RECORDING_DIR =
  process.env.RECORDING_DIR ||
  (isWritableDir("/home/www/static/recordings")
    ? "/home/www/static/recordings"
    : path.join(__dirname, "data", "recordings"));
const RECORDING_URL_PREFIX = "/recordings/";
const JWT_SECRET = process.env.JWT_SECRET || "benpage-dev-secret-change-me";

const db = require("./db");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
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

function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new Error(`File too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

// ─── Image upload (raw binary body) ─────────────────────────────────────
const ALLOWED_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return ".gif";
  // WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return ".webp";
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  return null;
}

// ─── Audio upload (raw binary body) ────────────────────────────────────
const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

function sniffAudioExt(buf) {
  if (!buf || buf.length < 12) return null;
  // MP3 — ID3 tag, or MPEG audio frame sync (0xFFEx)
  if (
    (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) return ".mp3";
  // WAV — "RIFF" .... "WAVE"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) return ".wav";
  // OGG / Opus — "OggS"
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return ".ogg";
  // FLAC — "fLaC"
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return ".flac";
  // M4A / AAC — MP4 container "....ftyp"
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return ".m4a";
  // WebM / Opus — EBML magic
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return ".webm";
  return null;
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

  // ── Photo upload (raw binary image body) ─────────────
  if (urlPath === "/api/upload" && req.method === "POST") {
    if (!requireAuth()) return;
    const buf = await readBuffer(req, MAX_UPLOAD_BYTES);
    if (!buf.length) {
      return json(res, 400, { error: "Empty file" });
    }
    const ext = sniffImageExt(buf);
    if (!ext) {
      return json(res, 400, { error: "Unsupported image type. Send PNG, JPG, GIF, WEBP or BMP bytes." });
    }

    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const rand = Math.random().toString(36).slice(2, 7);
    const filename = `benpage_${stamp}_${rand}${ext}`;
    const fullPath = path.join(PHOTO_DIR, filename);

    // Safety: ensure resolved path stays inside PHOTO_DIR
    if (!fullPath.startsWith(path.resolve(PHOTO_DIR) + path.sep)) {
      return json(res, 400, { error: "Invalid path" });
    }

    fs.writeFile(fullPath, buf, (err) => {
      if (err) {
        console.error("upload write error:", err.message);
        return json(res, 500, { error: "Failed to save image" });
      }
      return json(res, 201, {
        url: PHOTO_URL_PREFIX + filename,
        size: buf.length,
      });
    });
    return;
  }

  // ── Music audio upload (raw binary audio body) ───────
  if (urlPath === "/api/music/upload" && req.method === "POST") {
    if (!requireAuth()) return;
    const buf = await readBuffer(req, MAX_AUDIO_UPLOAD_BYTES);
    if (!buf.length) {
      return json(res, 400, { error: "Empty file" });
    }
    const ext = sniffAudioExt(buf);
    if (!ext) {
      return json(res, 400, {
        error: "Unsupported audio type. Send MP3, WAV, OGG, FLAC, M4A, AAC or WebM bytes.",
      });
    }

    fs.mkdirSync(RECORDING_DIR, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const rand = Math.random().toString(36).slice(2, 7);
    const filename = `music_${stamp}_${rand}${ext}`;
    const fullPath = path.join(RECORDING_DIR, filename);

    // Safety: ensure resolved path stays inside RECORDING_DIR
    if (!fullPath.startsWith(path.resolve(RECORDING_DIR) + path.sep)) {
      return json(res, 400, { error: "Invalid path" });
    }

    fs.writeFile(fullPath, buf, (err) => {
      if (err) {
        console.error("recording upload write error:", err.message);
        return json(res, 500, { error: "Failed to save recording" });
      }
      return json(res, 201, {
        url: RECORDING_URL_PREFIX + filename,
        size: buf.length,
      });
    });
    return;
  }

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

  // Uploaded photos (served from PHOTO_DIR, outside publicDir)
  if (urlPath.startsWith(PHOTO_URL_PREFIX)) {
    const photoPath = path.join(PHOTO_DIR, path.normalize(urlPath.slice(PHOTO_URL_PREFIX.length)));
    if (!photoPath.startsWith(path.resolve(PHOTO_DIR) + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(photoPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(photoPath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  // Uploaded recordings (served from RECORDING_DIR, outside publicDir).
  // Streamed with HTTP Range support so <audio> can seek on larger files.
  if (urlPath.startsWith(RECORDING_URL_PREFIX)) {
    const recPath = path.join(RECORDING_DIR, path.normalize(urlPath.slice(RECORDING_URL_PREFIX.length)));
    if (!recPath.startsWith(path.resolve(RECORDING_DIR) + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.stat(recPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(recPath).toLowerCase();
      const mime = mimeTypes[ext] || "application/octet-stream";

      const range = req.headers.range;
      const rng = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (rng) {
        const start = rng[1] ? parseInt(rng[1], 10) : 0;
        const end = rng[2] ? parseInt(rng[2], 10) : stat.size - 1;
        const endClamped = Math.min(end, stat.size - 1);
        if (start >= 0 && start <= endClamped && start < stat.size) {
          res.writeHead(206, {
            "Content-Type": mime,
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${endClamped}/${stat.size}`,
            "Content-Length": endClamped - start + 1,
          });
          fs.createReadStream(recPath, { start, end: endClamped }).pipe(res);
          return;
        }
      }

      res.writeHead(200, {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Content-Length": stat.size,
      });
      fs.createReadStream(recPath).pipe(res);
    });
    return;
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