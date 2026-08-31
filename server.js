const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const jpeg = require("jpeg-js");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");

// App direct-access paths — every app in the Apps gallery gets a clean
// /{path} route (https://<domain>/<path>) based on its name. All apps live
// in the single-page index.html shell; public/apps.js (APP_PATHS) opens the
// matching panel for the current pathname. /admin serves the same standalone
// console as /admin.html, just at a cleaner URL.
const APP_PATHS = {
  "/calendar": "index.html", // FX Holiday Calendar
  "/fx": "index.html",       // FX Market Watch
  "/rec-hub": "index.html",  // REC HUB
  "/vinyl": "index.html",    // Vinyl Archive — exact path only; /vinyl/:slug stays a share page
  "/admin": "admin.html",    // Admin console
};

// Hosts/domain that are allowed to call the API.
// - localhost / 127.0.0.1 / ::1 are always allowed (local dev, curl on the box).
// - ALLOWED_HOSTS: comma-separated hostnames, e.g. "example.com,www.example.com"
// - PUBLIC_URL:    e.g. "https://example.com" (its hostname is added to the allowlist)
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
function hostnameOfHost(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split(":")[0];
}
const PUBLIC_HOST = PUBLIC_URL ? hostnameOfHost(new URL(PUBLIC_URL).host) : "";

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
// Uploaded photos are content-addressed (each upload gets a unique
// benpage_<stamp>_<rand>.jpg name and is never overwritten), so browsers can
// cache them for a year without ever revalidating.
const PHOTO_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Where uploaded recordings (music tracks) are stored.
// Production: /home/www/static/recordings (served at https://<host>/recordings/...)
// Local dev:  ./data/recordings           (served at http://localhost:3000/recordings/...)
const RECORDING_DIR =
  process.env.RECORDING_DIR ||
  (isWritableDir("/home/www/static/recordings")
    ? "/home/www/static/recordings"
    : path.join(__dirname, "data", "recordings"));
const RECORDING_URL_PREFIX = "/recordings/";

// ─── JWT secret ─────────────────────────────────────────────────────
// The secret comes from (priority order):
//   1. JWT_SECRET env var (>= 32 chars) — explicit, systemd/CI friendly
//   2. a deployed data/.jwt-secret file (>= 32 chars) — valid in production
//      too, so provisioning the key as a file on the server is supported
// In production at least one of the two MUST provide a real secret — the
// server fails closed instead of forging tokens with a known fallback.
// In dev, a random secret is generated once and persisted to data/.jwt-secret
// so tokens survive restarts without logging the admin out.
const dataDir = path.join(__dirname, "data");
const JWT_SECRET_FILE = path.join(dataDir, ".jwt-secret");
function loadJwtSecret() {
  // 1) Explicit env var wins.
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  // 2) A deployed, explicit secret file is accepted in every environment,
  //    including production.
  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      const fromFile = fs.readFileSync(JWT_SECRET_FILE, "utf8").trim();
      if (fromFile && fromFile.length >= 32) return fromFile;
      if (process.env.NODE_ENV === "production") {
        console.error(
          `[security] FATAL: ${JWT_SECRET_FILE} exists but is shorter than 32 chars.`
        );
        process.exit(1);
      }
    }
  } catch (e) {
    // Unreadable file — fall through to dev generation / production fatal.
  }

  // 3) Production fails closed: no usable secret → refuse to start.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[security] FATAL: JWT_SECRET env var (>= 32 chars) is required in production " +
        `(or deploy a secret file at ${JWT_SECRET_FILE}).`
    );
    process.exit(1);
  }

  // 4) Dev convenience only: generate once and persist for token continuity.
  try {
    const secret = crypto.randomBytes(48).toString("hex");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  } catch (e) {
    console.warn("[security] Could not persist JWT secret:", e.message);
    return crypto.randomBytes(48).toString("hex"); // ephemeral last resort (dev only)
  }
}
const JWT_SECRET = loadJwtSecret();

const db = require("./db");

// ─── Discogs token (黑胶档案文字搜索) ────────────────────────────────
// Discogs 的 /database/search 要求"任何用户"级别的认证。个人访问令牌在
// https://www.discogs.com/settings/developers 免费生成(绑定你的账户,生成后
// 只显示一次)。读取优先级: DISCOGS_TOKEN 环境变量 → data/.discogs-token 文件
// (data/ 已被 gitignore)。未配置时服务照常启动,文字搜索自动退化为仅搜本地档案。
const DISCOGS_TOKEN =
  process.env.DISCOGS_TOKEN ||
  (() => {
    try {
      return fs.readFileSync(path.join(dataDir, ".discogs-token"), "utf8").trim();
    } catch (e) {
      return "";
    }
  })();
const discogs = require("./discogs")(DISCOGS_TOKEN, PUBLIC_URL);

// ─── 网易云音乐 sidecar client ─────────────────────────────────────────
// 通过本机 NeteaseCloudMusicApi (默认 127.0.0.1:3001) 解析歌曲 CDN 直链。
// 音频字节由浏览器直接从网易云 CDN 拉取(本站只回 302), 不耗本站流量。
// 未安装 sidecar 时服务照常启动, 仅"网易云导入 / 网易云播放源"不可用。
const netease = require("./netease");

// ─── 网易云 CDN 直链内存缓存 ─────────────────────────────────────────
// /song/url/v1 返回的 CDN 直链通常有效 20-40 分钟(expi 字段)。缓存一段时间,
// 避免每次播放都打 sidecar。键 = 网易云歌曲 id, TTL 10 分钟。
const NETEASE_CACHE_TTL_MS = 10 * 60 * 1000;
const neteaseUrlCache = new Map();

function cacheNeteaseUrl(songId, url) {
  neteaseUrlCache.set(songId, { url, expiresAt: Date.now() + NETEASE_CACHE_TTL_MS });
  // 简单防膨胀: 超过 200 条时顺手清掉已过期项。
  if (neteaseUrlCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of neteaseUrlCache) {
      if (now > v.expiresAt) neteaseUrlCache.delete(k);
    }
  }
}

function getCachedNeteaseUrl(songId) {
  const rec = neteaseUrlCache.get(songId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    neteaseUrlCache.delete(songId);
    return null;
  }
  return rec.url;
}

// 启动时异步探测一次网易云 sidecar, 把"远程部署后网易云不可用"在启动日志里
// 立刻暴露出来(而不是等到后台"从网易云导入"时才报 502)。探测只打本机 127.0.0.1,
// 3 秒超时, 不阻塞启动。
async function checkNeteaseSidecar() {
  try {
    await netease.ping();
    console.log(`  → NetEase sidecar OK at ${netease.API_BASE}`);
  } catch (err) {
    console.log(`  → NetEase sidecar NOT reachable at ${netease.API_BASE}: ${err.message}`);
    console.log(
      "    (网易云导入/播放源不可用。在服务器上安装并启动: " +
        "npm i -g NeteaseCloudMusicApi && PORT=3001 NeteaseCloudMusicApi — 详见 deploy/netease-setup.md)"
    );
  }
}

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

// ─── Security headers ─────────────────────────────────────────────────
// Website JS is all external (no inline script/style), so a strict CSP works.
// The FX app fetches https://open.er-api.com directly from the browser.
// frame-ancestors 'none' + X-Frame-Options: DENY blocks clickjacking of the
// admin login page.
// img-src needs blob: — the admin blog editor previews a picked/pasted image
// via URL.createObjectURL() (a blob: URL) before resizing/uploading. Without
// blob: the CSP blocks that preview and every upload fails with
// "Could not read image". Old photos keep working because they are served
// from /photo/... (same-origin 'self').
// media-src/connect-src also need blob: — the recording hub plays and decodes
// in-browser WAV takes that only ever exist as blob: URLs until they are
// uploaded and committed.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https: blob:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https://open.er-api.com blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
}

function json(res, code, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}

// ─── Request body helpers ─────────────────────────────────────────────
const MAX_JSON_BYTES = 1024 * 1024; // 1 MB

// An error that carries an explicit HTTP status code so the API error
// handler can respond with the right status (e.g. 413 for oversized bodies).
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function readBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const headerLen = parseInt(req.headers["content-length"] || "0", 10);
    if (headerLen > maxBytes) {
      // Reject without destroying the socket: the catch handler responds
      // with a proper JSON 413 first, then closes the connection.
      req.pause();
      reject(new HttpError(413, `Request body too large (max ${Math.round(maxBytes / 1024)}KB)`));
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        req.pause();
        reject(new HttpError(413, `Request body too large (max ${Math.round(maxBytes / 1024)}KB)`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
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
        // Same as readBody: reject with a clean 413 so the client gets a
        // JSON error instead of a torn-down connection.
        req.pause();
        reject(new HttpError(413, `File too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)`));
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
// 5 MB — keep in sync with nginx client_max_body_size (deploy/nginx-upload.conf)
// and the client-side check in public/admin.js.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Card-size thumbnail for blog grid covers. Covers render 170px tall, so a
// 640px-long-edge JPEG is plenty (even on 2x displays) at a fraction of the
// full 1920px upload size. Quality is jpeg-js's 0-100 scale.
const CARD_THUMB_MAX_DIM = 640;
const CARD_THUMB_QUALITY = 80;

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

/* ─── Card-size photo thumbnails ────────────────────────────────────────
   Blog grid covers are tiny (170px tall) but uploads are resized to 1920px,
   so the full original is wasted bandwidth. A *_card.jpg sibling is produced
   at upload time and lazily for older photos (see the /photo/ handler). */
function boxResizeRgba(rgba, sw, sh, ow, oh) {
  const out = Buffer.alloc(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    const ys = Math.floor((oy * sh) / oh);
    const ye = Math.max(ys + 1, Math.floor(((oy + 1) * sh) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const xs = Math.floor((ox * sw) / ow);
      const xe = Math.max(xs + 1, Math.floor(((ox + 1) * sw) / ow));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          const i = (y * sw + x) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
          n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* Card-size JPEG thumbnail from a full-size JPEG buffer, or null when the
   source isn't a decodable JPEG or is already small enough. Best-effort:
   every call site treats null as "no thumbnail available". */
function makeCardThumb(buf) {
  let img;
  try {
    img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  } catch (e) {
    return null;
  }
  const scale = Math.min(1, CARD_THUMB_MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  if (w === img.width && h === img.height) return null; // already small enough
  try {
    const rgba = boxResizeRgba(img.data, img.width, img.height, w, h);
    const out = jpeg.encode({ data: rgba, width: w, height: h }, CARD_THUMB_QUALITY);
    return Buffer.from(out.data);
  } catch (e) {
    return null;
  }
}

/* ─── Static serving helpers (cache headers + revalidation) ──────────── */
/* ETag from (size, mtimeMs): cheap, stable per file revision, and lets
   browsers 304-revalidate instead of re-downloading the whole file. */
function etagForStat(stat) {
  return `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
}

function isNotModified(req, etag) {
  const inm = req.headers["if-none-match"];
  if (!inm || !etag) return false;
  return inm.split(",").map((s) => s.trim()).includes(etag);
}

function serveFileWithCache(req, res, filePath, cacheControl) {
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const etag = etagForStat(stat);
    if (isNotModified(req, etag)) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const headers = { "Content-Type": mimeTypes[ext] || "application/octet-stream", ETag: etag };
      if (cacheControl) headers["Cache-Control"] = cacheControl;
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

// ─── Audio upload (raw binary body) ────────────────────────────────────
// 16 MB — WAV takes at 22050 Hz mono 16-bit ≈ 2.65 MB/min, so this allows
// ~6 min takes. Keep in sync with nginx client_max_body_size
// (deploy/nginx-upload.conf) and the client-side checks (public/admin.js,
// public/music.js).
const MAX_AUDIO_UPLOAD_BYTES = 16 * 1024 * 1024;

function sniffAudioExt(buf) {
  if (!buf || buf.length < 12) return null;
  // WAV and MP3 only — the two formats every browser's Web Audio
  // decodeAudioData accepts (including iOS Safari). Recorded takes are always
  // WAV; backing tracks may be MP3. M4A uploads are converted to WAV in the
  // browser before they reach this endpoint (uploadBlob in public/music.js and
  // public/admin.js), so raw m4a/webm/ogg/flac… bytes hitting the server are
  // still rejected — no future iOS-unplayable recording can sneak in.
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
  return null;
}

/* Name a rejected buffer's container for diagnostics. Used so a stale client
   (old MusicRecorder-era page still uploading WebM) produces an error message
   that says exactly what was received. */
function audioMagicName(buf) {
  if (!buf || buf.length < 12) return "unknown";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "WebM/Matroska";
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return "Ogg";
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return "FLAC";
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return "MP4/M4A";
  return "unknown";
}

// ─── Login brute-force limiter (in-memory) ─────────────────────────────
const LOGIN_MAX_ATTEMPTS = 10; // per username+IP per 15 min
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // key "ip:username" -> { count, resetAt }

function loginKey(req, username) {
  return `${req.socket.remoteAddress || "?"}:${String(username).toLowerCase()}`;
}

function checkLoginRate(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now - rec.resetAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, resetAt: now });
    return { ok: true };
  }
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((rec.resetAt + LOGIN_WINDOW_MS - now) / 1000);
    return { ok: false, retryAfter };
  }
  rec.count += 1;
  return { ok: true };
}

function recordLoginFailure(key) {
  const rec = loginAttempts.get(key);
  if (rec) rec.count += 1;
}

// Keep the map bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) {
    if (now - v.resetAt > LOGIN_WINDOW_MS) loginAttempts.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ─── Proxy rate limiter ───────────────────────────────────────────────
const PROXY_MAX_REQ = 30; // per IP per minute
const PROXY_WINDOW_MS = 60 * 1000;
const proxyHits = new Map();

function checkProxyRate(req) {
  const key = req.socket.remoteAddress || "?";
  const now = Date.now();
  const rec = proxyHits.get(key);
  if (!rec || now - rec.resetAt > PROXY_WINDOW_MS) {
    proxyHits.set(key, { count: 1, resetAt: now });
    return true;
  }
  if (rec.count >= PROXY_MAX_REQ) return false;
  rec.count += 1;
  return true;
}

// ─── Play / read counter limiter ──────────────────────────────────────
// Incrementing a play/read count is a public write (no JWT — visitors
// must be able to bump it), so it is host-gated by apiGate AND limited
// per IP to keep it from being hammered into fake popularity numbers.
const COUNT_MAX_REQ = 30; // per IP per minute
const COUNT_WINDOW_MS = 60 * 1000;
const countHits = new Map();

function checkCountRate(req) {
  const key = req.socket.remoteAddress || "?";
  const now = Date.now();
  const rec = countHits.get(key);
  if (!rec || now - rec.resetAt > COUNT_WINDOW_MS) {
    countHits.set(key, { count: 1, resetAt: now });
    return true;
  }
  if (rec.count >= COUNT_MAX_REQ) return false;
  rec.count += 1;
  return true;
}

// Keep the map bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of countHits) {
    if (now - v.resetAt > COUNT_WINDOW_MS) countHits.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ─── Short-link creation limiter ──────────────────────────────────────
// Creating a short link is a public write (any visitor may shorten the
// current page so it fits a WeChat message).  It is host-gated by apiGate,
// restricted to same-site URLs, and rate limited per IP.
const SHARE_MAX_REQ = 60; // per IP per minute
const SHARE_WINDOW_MS = 60 * 1000;
const shareHits = new Map();

function checkShareRate(req) {
  const key = req.socket.remoteAddress || "?";
  const now = Date.now();
  const rec = shareHits.get(key);
  if (!rec || now - rec.resetAt > SHARE_WINDOW_MS) {
    shareHits.set(key, { count: 1, resetAt: now });
    return true;
  }
  if (rec.count >= SHARE_MAX_REQ) return false;
  rec.count += 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of shareHits) {
    if (now - v.resetAt > SHARE_WINDOW_MS) shareHits.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ─── Blog content sanitizer (defense-in-depth against stored XSS) ──────
function cleanText(v, max = 500) {
  return String(v || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

function safeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return s;
  if (/^(https?:|mailto:|#|\/)/i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s;
  return "#";
}

const ALLOWED_BLOG_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "h3", "h4",
  "ul", "ol", "li", "blockquote", "a", "span", "div",
  "figure", "figcaption", "img", "video", "source",
]);

function sanitizeHtmlFragment(html) {
  let out = String(html || "");
  // Fully remove dangerous elements (including their content).
  out = out.replace(/<(script|style|iframe|object|embed|form|input|textarea|select|button)[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  // Rewrite every tag: drop tags not in the allowlist, drop event handler /
  // style / srcdoc attrs, and validate URL-valued attrs (href/src/poster).
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)\/?>/g, (m, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    if (!ALLOWED_BLOG_TAGS.has(tag)) return "";
    const closing = m.startsWith("</");
    if (closing) return "</" + tag + ">";

    const safeAttrs = [];
    const attrRe = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let am;
    while ((am = attrRe.exec(attrs))) {
      const name = am[1].toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") continue;
      let value = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : (am[4] || "");
      if (name === "href" || name === "src" || name === "poster") {
        const u = safeUrl(value);
        if (u === "#") continue; // drop javascript:/data:/vbscript: URLs
        value = u;
      }
      safeAttrs.push(name + '="' + value.replace(/"/g, "&" + "quot;") + '"');
    }
    const attrsStr = safeAttrs.length ? " " + safeAttrs.join(" ") : "";
    return "<" + tag + attrsStr + ">";
  });
  return out;
}

function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks) {
    const block = b || {};
    if (block.type === "image") {
      const src = safeUrl(block.src);
      if (src === "#" || !src) continue;
      out.push({
        type: "image",
        src,
        alt: cleanText(block.alt, 300),
        caption: cleanText(block.caption, 300),
      });
      continue;
    }
    if (block.type === "video") {
      const src = safeUrl(block.src);
      if (src === "#" || !src) continue;
      out.push({
        type: "video",
        src,
        poster: safeUrl(block.poster),
        caption: cleanText(block.caption, 300),
      });
      continue;
    }
    // text
    const html = sanitizeHtmlFragment(block.html);
    const text = String(block.html || "").replace(/<[^>]*>/g, "").trim();
    if (html && text) {
      out.push({ type: "text", html });
    }
  }
  return out;
}

// ─── Share pages (WeChat-friendly, server-rendered) ────────────────────
// Every blog post / music track / recording repo gets a real HTML page at
// /post/:id, /music/:id and /recording/:id.  WeChat's crawler builds the
// forwarded preview card from the og: meta tags below, and the page body
// renders fully without JavaScript, so it reads perfectly inside WeChat's
// in-app browser.
const SITE_NAME = "BEN 言";

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Absolute (scheme + host) URL builder for og: tags and short links.
   PUBLIC_URL wins; otherwise fall back to the request's Host header. */
function siteBase(req) {
  const base = PUBLIC_URL || `http://${req.headers.host || "localhost"}`;
  return base.replace(/\/+$/, "");
}

/* Host shown in the "from <host>" branding on share pages (e.g. benyan.ink).
   PUBLIC_URL's host wins so the brand stays canonical even when the page is
   reached via an IP or a staging host. */
function siteHost(req) {
  try {
    return new URL(siteBase(req)).host;
  } catch (e) {
    return String(req.headers.host || "").split(":")[0];
  }
}

function absUrl(req, p) {
  const s = String(p || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  return siteBase(req) + (s.startsWith("/") ? s : "/" + s);
}

/* A short link may only ever point back at this site — never to a foreign
   host.  Accepts a same-origin absolute URL or a plain "/..." path. */
function isSameSiteUrl(u, req) {
  const s = String(u || "").trim();
  if (!s || s.length > 600) return false;
  if (s.startsWith("/") && !s.startsWith("//")) return true;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const h = hostnameOfHost(parsed.host);
    const reqHost = hostnameOfHost(req.headers.host || "");
    return h === reqHost || (!!PUBLIC_HOST && h === PUBLIC_HOST);
  } catch (e) {
    return false;
  }
}

function postBlocks(post) {
  try {
    return JSON.parse(post.blocks || "[]");
  } catch (e) {
    return [];
  }
}

function postSnippet(post) {
  let text = "";
  for (const b of postBlocks(post)) {
    if (b.type === "text") {
      text += " " + String(b.html || "").replace(/<[^>]*>/g, " ");
      if (text.length > 220) break;
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function postCover(post) {
  if (post.cover) return post.cover;
  for (const b of postBlocks(post)) {
    if (b.type === "image") return b.src;
  }
  return "";
}

function renderSharePageHead(opts) {
  const { req, kind, id, title, description, image, type, url } = opts;
  const absolute = absUrl(req, url);
  const img = image ? absUrl(req, image) : "";
  return (
    "<!DOCTYPE html>\n" +
    `<html lang="zh-CN">\n` +
    "<head>\n" +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    `  <title>${escHtml(title)} · ${SITE_NAME}</title>\n` +
    `  <meta property="og:title" content="${escHtml(title)}" />\n` +
    `  <meta property="og:type" content="${escHtml(type || "website")}" />\n` +
    `  <meta property="og:url" content="${escHtml(absolute)}" />\n` +
    `  <meta property="og:description" content="${escHtml(description || SITE_NAME)}" />\n` +
    (img ? `  <meta property="og:image" content="${escHtml(img)}" />\n` : "") +
    '  <meta name="twitter:card" content="summary_large_image" />\n' +
    '  <link rel="stylesheet" href="/share.css" />\n' +
    "</head>\n" +
    `<body data-kind="${escHtml(kind)}" data-id="${escHtml(id)}">\n`
  );
}


function renderBlogSharePage(req, post) {
  const blocks = postBlocks(post);
  const description = postSnippet(post);
  const cover = postCover(post);
  const urlPath = "/post/" + post.id;
  const head = renderSharePageHead({
    req,
    kind: "blog",
    id: post.id,
    title: post.title,
    description,
    image: cover,
    type: "article",
    url: urlPath,
  });

  const body = blocks
    .map((b) => {
      if (b.type === "image") {
        return (
          `<figure class="share-figure">` +
          `<img src="${escHtml(b.src)}" alt="${escHtml(b.alt || b.caption || "")}" loading="lazy" />` +
          (b.caption ? `<figcaption>${escHtml(b.caption)}</figcaption>` : "") +
          "</figure>"
        );
      }
      if (b.type === "video") {
        return (
          `<figure class="share-figure">` +
          `<video controls preload="metadata"${b.poster ? ` poster="${escHtml(b.poster)}"` : ""}>` +
          `<source src="${escHtml(b.src)}" type="video/mp4" />` +
          "Your browser does not support video playback." +
          "</video>" +
          (b.caption ? `<figcaption>${escHtml(b.caption)}</figcaption>` : "") +
          "</figure>"
        );
      }
      return `<div class="share-text">${sanitizeHtmlFragment(b.html || "")}</div>`;
    })
    .join("\n");

  return (
    head +
    '  <div class="share-page">\n' +
    "    <header class=\"share-head\">\n" +
    `      <a class="share-brand" href="/">${SITE_NAME}</a>\n` +
    `      <span class="share-meta">${escHtml(post.tag || "Note")} · ${escHtml(post.date || "")}</span>\n` +
    "    </header>\n" +
    '    <article class="share-article">\n' +
    `      <h1 class="share-title">${escHtml(post.title)}</h1>\n` +
    `      ${body}\n` +
    "    </article>\n" +
    "    <footer class=\"share-foot\">\n" +
    `      <span class="share-stat">👁 ${Number(post.read_count) || 0} reads</span>\n` +
    `      <span class="share-from">from <a href="/">${escHtml(siteHost(req))}</a></span>\n` +
    `      <a href="/">返回 ${SITE_NAME} →</a>\n` +
    "    </footer>\n" +
    "  </div>\n" +
    '  <script src="/share-count.js"></script>\n' +
    "</body>\n</html>\n"
  );
}

/* One shared renderer for the track-style share pages. `kind` is "music"
   (Recordings tab, /music/:id) or "recording" (REC HUB, /recording/:id);
   `track` is the matching music row or recording_repos row — both carry the
   same fields this page reads (id/title/url/source_type/play_count). */
function renderTrackSharePage(req, kind, track, latest, urlPath) {
  // `latest` = the repo's highest tagged version (see db.getLatestTaggedCommit).
  // NULL when nothing is tagged (plain music tracks never have commits) →
  // fall back to the track's own file, exactly as the page has always behaved.
  const version = latest && latest.version != null ? latest.version : null;
  const versionLabel = version != null ? `v${version}.0` : "";
  // 原创 (original) vs Cover — set once when the recording was created.
  const sourceLabel = track.source_type === "cover" ? "Cover" : "原创";
  const head = renderSharePageHead({
    req,
    kind,
    id: track.id,
    title: `${track.title} · ${sourceLabel}${versionLabel ? ` · ${versionLabel}` : ""}`,
    description: `${track.title} (${sourceLabel}) — a recording from ${SITE_NAME}.`,
    image: "",
    type: "music.song",
    url: urlPath,
  });

  // Overlay versions play their RENDERED chain mix (take over its backing).
  // The chain layers are embedded as JSON so /share-music.js can render them
  // with the exact offline Web Audio path the hub page already uses on iOS.
  // Without JS the <audio> src falls back to the version's own take file.
  let audioHtml;
  let mixJson = "";
  let mixScript = "";
  if (version != null && latest.mode === "overlay") {
    const layers = db.getCommitChainFrom(latest).map((c, i) => {
      const start = Number(c.start_time) || 0;
      const end = Number(c.end_time);
      const d = isFinite(end) && end > 0 ? end - start : NaN;
      const vol = Number(c.volume);
      return {
        url: c.url,
        offset: i === 0 ? 0 : start, // root sits at 0; takes at their start_time
        readOff: Math.max(0, start - (Number(c.lead) || 0)), // blob read point
        dur: d > 0 ? d : null, // null = play the take's natural length
        gain: isFinite(vol) && vol >= 0 ? Math.min(3, vol) : 1,
      };
    });
    // Escape "<" so the JSON can never close the enclosing script tag.
    mixJson = `\n  <script type="application/json" id="share-mix-chain">${JSON.stringify(layers).replace(/</g, "\\u003c")}</script>`;
    mixScript = '\n  <script src="/share-music.js"></script>';
    audioHtml =
      `      <audio id="share-audio" class="share-audio" controls preload="metadata" src="${escHtml(latest.url)}" data-render="overlay"></audio>\n` +
      `      <p class="share-mix-status" id="share-mix-status" hidden>⏳ rendering the layered mix…</p>`;
  } else {
    audioHtml = `      <audio class="share-audio" controls preload="metadata" src="${escHtml(version != null ? latest.url : track.url)}"></audio>`;
  }

  return (
    head +
    '  <div class="share-page share-page-track">\n' +
    "    <header class=\"share-head\">\n" +
    `      <a class="share-brand" href="/">${SITE_NAME}</a>\n` +
    `      <span class="share-meta">Recording · ▶ ${Number(track.play_count) || 0} plays</span>\n` +
    "    </header>\n" +
    '    <section class="share-track">\n' +
    `      <h1 class="share-title">${escHtml(track.title)} <span class="share-source${track.source_type === "cover" ? " share-source-cover" : ""}">${sourceLabel}</span>${versionLabel ? ` <span class="share-version">${versionLabel}</span>` : ""}</h1>\n` +
    audioHtml +
    "    </section>\n" +
    "    <footer class=\"share-foot\">\n" +
    `      <span class="share-from">from <a href="/">${escHtml(siteHost(req))}</a></span>\n` +
    `      <a href="/">返回 ${SITE_NAME} →</a>\n` +
    "    </footer>\n" +
    "  </div>\n" +
    mixJson +
    '  <script src="/share-count.js"></script>' +
    mixScript +
    "\n</body>\n</html>\n"
  );
}

function renderMusicSharePage(req, track, latest) {
  return renderTrackSharePage(req, "music", track, latest, "/music/" + track.id);
}

function renderRecordingSharePage(req, repo, latest) {
  return renderTrackSharePage(req, "recording", repo, latest, "/recording/" + repo.id);
}

// ─── Vinyl Archive (黑胶档案) ─────────────────────────────────────────
/* Normalized public shape for a vinyl_records row (parses tracks_json). */
function publicVinylRow(row) {
  if (!row) return null;
  let tracks = [];
  try {
    tracks = JSON.parse(row.tracks_json || "[]");
  } catch (e) {
    tracks = [];
  }
  // Canonical duration field in storage is `length` (ms); expose `length_ms`
  // as an alias so both the frontend result card and the share page agree.
  tracks = tracks.map((t) => ({
    ...t,
    length_ms: t.length_ms != null ? t.length_ms : t.length != null ? t.length : null,
  }));
  return {
    id: row.id,
    slug: row.slug,
    mbid: row.mbid,
    title: row.title,
    artist: row.artist,
    release_date: row.release_date,
    country: row.country,
    label: row.label,
    catalog_number: row.catalog_number,
    cover_path: row.cover_path,
    source: row.source || "musicbrainz",
    discogs_id: row.discogs_id != null ? Number(row.discogs_id) : null,
    tracks,
    play_count: Number(row.play_count) || 0,
    created_at: row.created_at,
  };
}

function vinylFmtMs(ms) {
  if (!ms || !isFinite(Number(ms))) return "";
  const total = Math.round(Number(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m + ":" + s;
}

function renderVinylSharePage(req, rec) {
  const pub = publicVinylRow(rec);
  const tracks = pub.tracks || [];
  const year = String(rec.release_date || "").slice(0, 4);
  const facts = [year, rec.country, rec.label, rec.catalog_number].filter(Boolean).join(" · ");
  const description = [rec.artist, year, rec.label].filter(Boolean).join(" · ");
  const head = renderSharePageHead({
    req,
    kind: "vinyl",
    id: rec.id,
    title: `${rec.title} — ${rec.artist}`,
    description,
    image: rec.cover_path,
    type: "music.album",
    url: "/vinyl/" + rec.slug,
  });

  const trackRows = tracks
    .map(
      (t, i) =>
        `      <li class="vinyl-track"><span class="vinyl-track-num">${String(t.position || i + 1).padStart(2, "0")}</span><span class="vinyl-track-title">${escHtml(t.title)}</span>${t.length ? ` <span class="vinyl-track-len">${vinylFmtMs(t.length)}</span>` : ""}</li>`
    )
    .join("\n");

  return (
    head +
    '  <div class="share-page share-page-vinyl">\n' +
    "    <header class=\"share-head\">\n" +
    `      <a class="share-brand" href="/">${SITE_NAME}</a>\n` +
    `      <span class="share-meta">黑胶档案 · Vinyl Archive · <span class="vinyl-plays" data-play-count>${Number(rec.play_count) || 0} plays</span></span>\n` +
    "    </header>\n" +
    '    <section class="vinyl-record">\n' +
    `      <div class="vinyl-cover-wrap"><img class="vinyl-cover" src="${escHtml(rec.cover_path)}" alt="${escHtml(rec.title)} cover" /></div>\n` +
    '      <div class="vinyl-info">\n' +
    `        <h1 class="share-title vinyl-title">${escHtml(rec.title)}</h1>\n` +
    `        <p class="vinyl-artist">${escHtml(rec.artist)}</p>\n` +
    (facts ? `        <p class="vinyl-facts">${escHtml(facts)}</p>\n` : "") +
    (tracks.length
      ? `        <ol class="vinyl-tracklist">\n${trackRows}\n        </ol>\n`
      : "") +
    "      </div>\n" +
    "    </section>\n" +
    "    <footer class=\"share-foot\">\n" +
    `      <span class="share-from">from <a href="/">${escHtml(siteHost(req))}</a></span>\n` +
    `      <a href="/">返回 ${SITE_NAME} →</a>\n` +
    '      <span class="share-stat">黑胶档案 · Vinyl Archive</span>\n' +
    "    </footer>\n" +
    "  </div>\n" +
    '  <script src="/share-count.js"></script>\n' +
    "\n</body>\n</html>\n"
  );
}

/* Discogs reference share page — same vintage record-card layout as a
   stored vinyl share, but rendered live from the Discogs API (no DB row,
   no cover stored on this server).  WeChat scrapers still get real
   og:title / og:description / og:image via the server-side fetch. */
function renderVinylDiscogsSharePage(req, detail) {
  const year = detail.year != null ? String(detail.year) : "";
  const facts = [year, detail.country, detail.label, detail.catalog_number]
    .filter(Boolean)
    .join(" · ");
  const description =
    [detail.artist, year, detail.label].filter(Boolean).join(" · ") ||
    "Discogs 唱片";
  const head = renderSharePageHead({
    req,
    kind: "none",
    id: "",
    title: `${detail.title} — ${detail.artist}`,
    description,
    image: detail.cover_image, // absolute https URL — absUrl passes it through
    type: "music.album",
    url: "/vinyl/discogs/" + detail.discogs_id,
  });

  const trackRows = detail.tracks
    .map(
      (t, i) =>
        `      <li class="vinyl-track"><span class="vinyl-track-num">${String(
          t.position || i + 1
        ).padStart(2, "0")}</span><span class="vinyl-track-title">${escHtml(
          t.title
        )}</span>${t.length_ms ? ` <span class="vinyl-track-len">${vinylFmtMs(t.length_ms)}</span>` : ""}</li>`
    )
    .join("\n");
  const styleLine = [...(detail.genres || []), ...(detail.styles || [])]
    .slice(0, 6)
    .join(" · ");

  return (
    head +
    '  <div class="share-page share-page-vinyl">\n' +
    "    <header class=\"share-head\">\n" +
    `      <a class="share-brand" href="/">${SITE_NAME}</a>\n` +
    '      <span class="share-meta">Discogs · Vinyl Archive</span>\n' +
    "    </header>\n" +
    '    <section class="vinyl-record">\n' +
    (detail.cover_image
      ? `      <div class="vinyl-cover-wrap"><img class="vinyl-cover" src="${escHtml(
          detail.cover_image
        )}" alt="${escHtml(detail.title)} cover" /></div>\n`
      : "") +
    '      <div class="vinyl-info">\n' +
    `        <h1 class="share-title vinyl-title">${escHtml(detail.title)}</h1>\n` +
    `        <p class="vinyl-artist">${escHtml(detail.artist)}</p>\n` +
    (facts ? `        <p class="vinyl-facts">${escHtml(facts)}</p>\n` : "") +
    (styleLine ? `        <p class="vinyl-facts">${escHtml(styleLine)}</p>\n` : "") +
    (detail.tracks.length
      ? `        <ol class="vinyl-tracklist">\n${trackRows}\n        </ol>\n`
      : "") +
    "      </div>\n" +
    "    </section>\n" +
    "    <footer class=\"share-foot\">\n" +
    `      <span class="share-from">from <a href="/">${escHtml(siteHost(req))}</a></span>\n` +
    `      <a href="/">返回 ${SITE_NAME} →</a>\n` +
    '      <span class="share-stat">Discogs · Vinyl Archive</span>\n' +
    "    </footer>\n" +
    "  </div>\n" +
    "\n</body>\n</html>\n"
  );
}

function renderVinylDiscogsErrorPage(req, message) {
  const head = renderSharePageHead({
    req,
    kind: "none",
    id: "",
    title: "Discogs 唱片暂时无法打开",
    description: message,
    image: "",
    type: "website",
    url: req.url,
  });
  return (
    head +
    '  <div class="share-page share-page-vinyl">\n' +
    "    <header class=\"share-head\">\n" +
    `      <a class="share-brand" href="/">${SITE_NAME}</a>\n` +
    '      <span class="share-meta">Discogs · Vinyl Archive</span>\n' +
    "    </header>\n" +
    '    <section class="vinyl-record">\n' +
    '      <div class="vinyl-info">\n' +
    '        <h1 class="share-title vinyl-title">Discogs 唱片暂时无法打开</h1>\n' +
    `        <p class="vinyl-artist">${escHtml(message)}</p>\n` +
    "      </div>\n" +
    "    </section>\n" +
    "    <footer class=\"share-foot\">\n" +
    `      <span class="share-from">from <a href="/">${escHtml(siteHost(req))}</a></span>\n` +
    `      <a href="/">返回 ${SITE_NAME} →</a>\n` +
    '      <span class="share-stat">Discogs · Vinyl Archive</span>\n' +
    "    </footer>\n" +
    "  </div>\n" +
    "\n</body>\n</html>\n"
  );
}

// ─── Password policy ───────────────────────────────────────────────────
function validateNewPassword(pw, username) {
  if (typeof pw !== "string" || pw.length < 10) {
    return "Password must be at least 10 characters";
  }
  if (pw.length > 128) return "Password is too long";
  if (pw.toLowerCase().includes(String(username || "").toLowerCase())) {
    return "Password must not contain the username";
  }
  if (pw === "admin123" || pw === "password" || pw === "1234567890") {
    return "That password is too weak";
  }
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    return "Password must contain both letters and numbers";
  }
  return null;
}

// ─── API origin gate ───────────────────────────────────────────────────
// Restricts every /api/* call to the site itself (blocks CSRF, cross-site
// browsers, and DNS-rebinding):
//   - localhost / 127.0.0.1 / ::1 (the box itself, local dev, curl on server)
//   - the explicitly configured public host(s) via PUBLIC_URL / ALLOWED_HOSTS
//     ("strict mode" — full DNS-rebinding protection),
//   - in "relaxed mode" (no PUBLIC_URL / ALLOWED_HOSTS configured), any
//     genuine same-origin browser request — Host must match Origin — so a
//     fresh deployment works out of the box via http://<server-ip>:3000 or
//     any unconfigured domain, while cross-site requests stay blocked.
const SAFE_SEC_FETCH_SITE = new Set(["same-origin", "same-site", "none"]);

function isAllowedHostname(h) {
  const host = hostnameOfHost(h);
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
    return true;
  }
  if (ALLOWED_HOSTS.has(host)) return true;
  if (PUBLIC_HOST && host === PUBLIC_HOST) return true;
  return false;
}

function hostMatchesOrigin(host, origin) {
  if (!origin) return false;
  try {
    return hostnameOfHost(host) === hostnameOfHost(new URL(origin).host);
  } catch (e) {
    return false;
  }
}

function isStrictHostAllowlist() {
  return Boolean(PUBLIC_HOST) || ALLOWED_HOSTS.size > 0;
}

function apiGate(req, res) {
  const host = req.headers.host || "";
  const origin = req.headers.origin;
  const strict = isStrictHostAllowlist();
  const sf = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const ua = req.headers["user-agent"] || "";
  // Browsers tag every request with Sec-Fetch-Site (same-origin / same-site /
  // none for navigations). Crucially, they OMIT the Origin header on
  // same-origin GET/HEAD requests — only state-changing and cross-origin
  // requests carry it. Some browser builds (e.g. headless Chrome) omit even
  // the Sec-Fetch-* headers, so we also accept a browser User-Agent as a
  // "genuine browser page" signal. The UA check is spoofable, but in relaxed
  // mode it only extends the trust already granted to any same-origin browser
  // page — public reads are public and writes still require a valid JWT.
  const isBrowserRequest =
    (sf && SAFE_SEC_FETCH_SITE.has(sf)) || isBrowserUserAgent(ua);

  // 1) The Host header must be acceptable.
  if (!isAllowedHostname(host)) {
    // Relaxed mode only: a genuine browser request from the site's own page
    // (Origin matches Host, or the browser tagged the request same-origin via
    // Sec-Fetch-Site, or it carries a browser User-Agent) is enough — this is
    // how a fresh deployment served from a raw IP or an unconfigured domain
    // can log in AND read public content.
    const sameOriginBrowser =
      !strict && (hostMatchesOrigin(host, origin) || isBrowserRequest);
    if (!sameOriginBrowser) {
      json(res, 403, {
        error: "Host not allowed",
        hint: strict
          ? `Allowed hosts: ${[...ALLOWED_HOSTS, PUBLIC_HOST].filter(Boolean).join(", ")} (or localhost). Make sure PUBLIC_URL/ALLOWED_HOSTS matches the domain you are accessing.`
          : "Set PUBLIC_URL or ALLOWED_HOSTS to the domain you access the site on.",
      });
      return false;
    }
  }

  // 2) Origin (if the browser sent one) must match what we allow.
  if (origin) {
    let originHost = "";
    try {
      originHost = hostnameOfHost(new URL(origin).host);
    } catch (e) {
      json(res, 403, { error: "Origin not allowed" });
      return false;
    }
    if (strict) {
      if (!isAllowedHostname(originHost)) {
        json(res, 403, { error: "Origin not allowed" });
        return false;
      }
    } else if (originHost !== hostnameOfHost(host)) {
      // Relaxed mode: only true same-origin browser requests are allowed.
      json(res, 403, { error: "Origin not allowed" });
      return false;
    }
  }

  // 3) Sec-Fetch-Site must never be cross-site.
  if (sf && !SAFE_SEC_FETCH_SITE.has(sf)) {
    json(res, 403, { error: "Request origin not allowed" });
    return false;
  }

  // 4) Non-browser clients (no Origin / Sec-Fetch-Site headers, no browser UA)
  //    must come from localhost or an explicitly allowed host.
  if (!origin && !sf && !isBrowserUserAgent(ua) && !isAllowedHostname(host)) {
    json(res, 403, { error: "Host not allowed" });
    return false;
  }

  return true;
}

// Weak-but-useful signal for relaxed mode: real browsers identify themselves
// with a Mozilla/ + (AppleWebKit|Gecko|Blink/Safari/Firefox|…) UA string.
// Plain scripts (curl, axios, bots) don't look like that. Kept intentionally
// conservative so a browser page is never blocked while raw HTTP clients still
// need an allowlisted host.
function isBrowserUserAgent(ua) {
  if (typeof ua !== "string" || !ua) return false;
  return (
    /Mozilla\/[\d.]+/.test(ua) &&
    /(?:AppleWebKit|Gecko|Chrome|Safari|Firefox|Edg|OPR)\/[\d.]+/.test(ua)
  );
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
  if (!payload || !payload.sub) return null;
  return db.getUserAuth(payload.sub);
}

/* Unambiguous invite-code alphabet (same rules as share codes: no 0/O/1/I/l)
   so codes are easy to read aloud and type on a phone. */
const INVITE_ALPHABET =
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function makeInviteCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
    }
    if (!db.getInviteByCode(code)) return code;
  }
  throw new Error("Could not generate a unique invite code");
}

// ─── API Router ────────────────────────────────────────────────────────
async function handleApi(req, res, urlPath) {
  // Auth
  if (urlPath === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const username = cleanText(body.username, 100);
    const password = String(body.password || "");
    if (!username || !password) {
      return json(res, 400, { error: "Username and password are required" });
    }
    const key = loginKey(req, username);
    const lim = checkLoginRate(key);
    if (!lim.ok) {
      const minutes = Math.ceil(lim.retryAfter / 60) || 1;
      return json(res, 429, {
        error: `Too many login attempts. Try again in ${minutes} minute(s).`,
      });
    }
    const user = db.authUser(username, password);
    if (!user) {
      recordLoginFailure(key);
      return json(res, 401, { error: "Invalid credentials" });
    }
    return json(res, 200, {
      token: signToken(user),
      user,
      must_change_password: !!user.must_change_password,
    });
  }

  // Invite-code login — the code itself is the credential for band members
  // (no password). First use creates the account and binds the code + its
  // band; later uses log the same account straight back in.
  if (urlPath === "/api/auth/invite-login" && req.method === "POST") {
    const body = await readBody(req);
    const code = cleanText(body.code, 64);
    if (!code) {
      return json(res, 400, { error: "Invite code is required" });
    }
    const key = loginKey(req, "invite:" + code);
    const lim = checkLoginRate(key);
    if (!lim.ok) {
      const minutes = Math.ceil(lim.retryAfter / 60) || 1;
      return json(res, 429, {
        error: `Too many attempts. Try again in ${minutes} minute(s).`,
      });
    }
    const invite = db.getInviteByCode(code);
    if (!invite) {
      recordLoginFailure(key);
      return json(res, 401, { error: "Invalid invite code" });
    }
    let user;
    let firstLogin = false;
    if (invite.used_by) {
      user = db.getUserAuth(invite.used_by);
      if (!user) {
        recordLoginFailure(key);
        return json(res, 401, { error: "Invite code is no longer valid" });
      }
    } else {
      // First claim — create the account, mark the code used and auto-join
      // its band. The profile is completed by the follow-up profile form.
      firstLogin = true;
      user = db.getUserAuth(db.createUserFromInvite(code).id);
      db.claimInviteForUser(invite.id, user.id);
      user = db.getUserAuth(user.id); // membership (bands) changed above
    }
    return json(res, 200, {
      token: signToken(user),
      user,
      first_login: firstLogin,
    });
  }

  if (urlPath === "/api/auth/me" && req.method === "GET") {
    const user = getAuthUser(req);
    if (!user) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { user });
  }

  if (urlPath === "/api/auth/password" && req.method === "POST") {
    const authUser = getAuthUser(req);
    if (!authUser) return json(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    const current = String(body.current_password || "");
    const next = String(body.new_password || "");
    if (!db.verifyUserPassword(authUser.id, current)) {
      return json(res, 400, { error: "Current password is incorrect" });
    }
    const err = validateNewPassword(next, authUser.username);
    if (err) return json(res, 400, { error: err });
    db.changePassword(authUser.id, next);
    return json(res, 200, { ok: true });
  }

  // Protected routes below — require valid JWT
  const authUser = getAuthUser(req);

  const requireAuth = (opts = {}) => {
    if (!authUser) {
      json(res, 401, { error: "Unauthorized" });
      return false;
    }
    if (authUser.must_change_password && !opts.allowPasswordChange) {
      json(res, 403, { error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" });
      return false;
    }
    return true;
  };

  const requireAdmin = (opts = {}) => {
    if (!requireAuth(opts)) return false;
    if (!authUser.is_admin) {
      json(res, 403, { error: "Admin access required" });
      return false;
    }
    return true;
  };

  // Band members must complete their profile (nickname/email/bands) before
  // they can create or edit recordings.
  const requireProfile = (opts = {}) => {
    if (!requireAuth(opts)) return false;
    if (!authUser.profile_complete) {
      json(res, 403, { error: "Profile setup required", code: "PROFILE_SETUP_REQUIRED" });
      return false;
    }
    return true;
  };

  // ── Profile & bands (REC HUB membership) ───────────────
  // First-login profile: display name, email, and which bands to join.
  if (urlPath === "/api/auth/profile" && req.method === "POST") {
    if (!requireAuth()) return;
    const body = await readBody(req);
    const nickname = cleanText(body.nickname, 60);
    const email = String(body.email || "").trim().toLowerCase();
    if (!nickname) return json(res, 400, { error: "Nickname is required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return json(res, 400, { error: "A valid email address is required" });
    }
    const rawBandIds = Array.isArray(body.band_ids) ? body.band_ids : [];
    const bandIds = [];
    for (const bid of rawBandIds) {
      const id = Number(bid);
      if (Number.isInteger(id) && id > 0 && db.getBand(id)) bandIds.push(id);
    }
    if (!bandIds.length) return json(res, 400, { error: "Choose at least one band" });
    const user = db.setUserProfile(authUser.id, { nickname, email, bandIds });
    return json(res, 200, { user });
  }

  // Every band a signed-in user may browse/join.
  if (urlPath === "/api/bands" && req.method === "GET") {
    if (!requireAuth()) return;
    return json(res, 200, { bands: db.listBands() });
  }

  // ── Bands & invites management (admin only) ────────────
  if (urlPath === "/api/admin/bands" && req.method === "GET") {
    if (!requireAdmin()) return;
    const bands = db.listBands().map((b) => ({ ...b, members: db.listBandMembers(b.id) }));
    return json(res, 200, { bands });
  }

  if (urlPath === "/api/admin/bands" && req.method === "POST") {
    if (!requireAdmin()) return;
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    const description = cleanText(body.description, 500);
    if (!name) return json(res, 400, { error: "Band name is required" });
    if (db.getBandByName(name)) {
      return json(res, 400, { error: "A band with that name already exists" });
    }
    const band = db.createBand({ name, description, created_by: authUser.id });
    return json(res, 201, { band });
  }

  const adminBandDeleteMatch = urlPath.match(/^\/api\/admin\/bands\/(\d+)$/);
  if (adminBandDeleteMatch && req.method === "DELETE") {
    if (!requireAdmin()) return;
    const band = db.getBand(Number(adminBandDeleteMatch[1]));
    if (!band) return json(res, 404, { error: "Band not found" });
    db.deleteBand(band.id);
    return json(res, 200, { ok: true });
  }

  if (adminBandDeleteMatch && (req.method === "PUT" || req.method === "PATCH")) {
    if (!requireAdmin()) return;
    const band = db.getBand(Number(adminBandDeleteMatch[1]));
    if (!band) return json(res, 404, { error: "Band not found" });
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    if (!name) return json(res, 400, { error: "Band name is required" });
    const dup = db.getBandByName(name);
    if (dup && dup.id !== band.id) {
      return json(res, 400, { error: "A band with that name already exists" });
    }
    const updated = db.updateBand(band.id, {
      name,
      description: cleanText(body.description, 500),
    });
    return json(res, 200, { band: updated });
  }

  if (urlPath === "/api/admin/invites" && req.method === "GET") {
    if (!requireAdmin()) return;
    return json(res, 200, { invites: db.listInviteCodes() });
  }

  if (urlPath === "/api/admin/invites" && req.method === "POST") {
    if (!requireAdmin()) return;
    const body = await readBody(req);
    const band = db.getBand(Number(body.band_id));
    if (!band) return json(res, 400, { error: "Pick a valid band" });
    const invite = db.createInviteCode({
      code: makeInviteCode(),
      band_id: band.id,
      created_by: authUser.id,
    });
    return json(res, 201, { invite });
  }

  const adminInviteDeleteMatch = urlPath.match(/^\/api\/admin\/invites\/(\d+)$/);
  if (adminInviteDeleteMatch && req.method === "DELETE") {
    if (!requireAdmin()) return;
    const invite = db.getInviteCode(Number(adminInviteDeleteMatch[1]));
    if (!invite) return json(res, 404, { error: "Invite not found" });
    db.deleteInviteCode(invite.id);
    return json(res, 200, { ok: true });
  }

  // Member accounts + the bands each belongs to (useful for auditing).
  if (urlPath === "/api/admin/users" && req.method === "GET") {
    if (!requireAdmin()) return;
    const users = db.listUsers().map((u) => ({ ...u, bands: db.listUserBands(u.id) }));
    return json(res, 200, { users });
  }

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
      // Card-size thumbnail (best-effort) so the blog grid downloads a small
      // JPEG instead of the full 1920px original. Only JPEG uploads get one.
      let cardUrl = null;
      if (ext === ".jpg") {
        const thumb = makeCardThumb(buf);
        if (thumb) {
          const thumbName = filename.replace(/\.jpg$/i, "_card.jpg");
          try {
            fs.writeFileSync(path.join(PHOTO_DIR, thumbName), thumb);
            cardUrl = PHOTO_URL_PREFIX + thumbName;
          } catch (e) {
            console.error("thumb write error:", e.message);
          }
        }
      }
      return json(res, 201, {
        url: PHOTO_URL_PREFIX + filename,
        ...(cardUrl ? { card_url: cardUrl } : {}),
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
      const name = audioMagicName(buf);
      const hex = [...buf.slice(0, 12)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const hint =
        name === "WebM/Matroska"
          ? " A WebM upload usually means an outdated recorder is still saving the old format — hard-refresh the page (Cmd/Ctrl+Shift+R) to load the WAV update."
          : "";
      return json(res, 400, {
        error:
          `Unsupported audio type (${name}, ${buf.length} bytes, magic: ${hex}). ` +
          `Send WAV (recordings) or MP3 (backing tracks) bytes.${hint}`,
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

  // ── NetEase Cloud Music (网易云播放源) ─────────────────────────
  // GET /api/netease/audio/<songId> → 302 到网易云 CDN 音频直链。
  // 音频字节由浏览器直接从网易云 CDN 拉取 —— 本站服务器只负责用 sidecar
  // 解析 CDN 地址再回一个重定向, 全程零音频流量。CDN 直链支持 Range
  // (206), 因此 Recordings 波形图的 seek 不受影响。
  const neteaseAudio = urlPath.match(/^\/api\/netease\/audio\/(\d+)$/);
  if (neteaseAudio && req.method === "GET") {
    if (!checkProxyRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const songId = Number(neteaseAudio[1]);
    let cdnUrl = getCachedNeteaseUrl(songId);
    if (!cdnUrl) {
      try {
        cdnUrl = await netease.getSongUrl(songId);
      } catch (err) {
        console.error(`netease resolve error → song ${songId}:`, err.message);
        return json(res, 502, { error: "无法解析网易云歌曲地址" });
      }
      if (cdnUrl) cacheNeteaseUrl(songId, cdnUrl);
    }
    if (!cdnUrl) {
      return json(res, 404, {
        error: "该歌曲暂不可播放（可能需要 VIP 登录，或在管理后台配置 sidecar 账号）",
      });
    }
    // 302 到 CDN。Cache-Control 不设长缓存: CDN 链接有时效(expi 20-40 分钟),
    // 每次播放重新解析成本几乎为零(sidecar 是本机请求), 宁可不缓存。
    res.writeHead(302, {
      Location: cdnUrl,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  // GET /api/netease/search?keywords=… (仅登录后台) — 管理后台"从网易云导入"。
  if (urlPath === "/api/netease/search" && req.method === "GET") {
    if (!requireAuth()) return;
    const raw = new URL(req.url, "http://localhost");
    const keywords = cleanText(raw.searchParams.get("keywords"), 100);
    if (!keywords) return json(res, 400, { error: "keywords is required" });
    try {
      const results = await netease.search(keywords);
      return json(res, 200, { results });
    } catch (err) {
      console.error("netease search error:", err.message);
      return json(res, 502, { error: err.message });
    }
  }

  // ── Music API ─────────────────────────────────────────
  if (urlPath === "/api/music" && req.method === "GET") {
    return json(res, 200, { tracks: db.listMusic() });
  }

  // Play-count increment — public (visitors bump it), host-gated + rate-limited.
  const musicPlayMatch = urlPath.match(/^\/api\/music\/(\d+)\/play$/);
  if (musicPlayMatch && req.method === "POST") {
    if (!checkCountRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const track = db.incrementMusicPlay(Number(musicPlayMatch[1]));
    if (!track) return json(res, 404, { error: "Track not found" });
    return json(res, 200, { ok: true, play_count: track.play_count });
  }

  if (urlPath === "/api/music" && req.method === "POST") {
    if (!requireAuth()) return;
    const body = await readBody(req);
    const title = cleanText(body.title, 300);
    const url = cleanText(body.url, 1000);
    if (!title || !url) {
      return json(res, 400, { error: "Title and URL are required" });
    }
    const track = db.createMusic({ title, url, sort_order: body.sort_order, source_type: body.source_type });
    return json(res, 201, track);
  }

  const musicMatch = urlPath.match(/^\/api\/music\/(\d+)$/);
  if (musicMatch) {
    const id = Number(musicMatch[1]);

    if (req.method === "PUT") {
      if (!requireAuth()) return;
      const body = await readBody(req);
      const title = cleanText(body.title, 300);
      const url = cleanText(body.url, 1000);
      if (!title || !url) {
        return json(res, 400, { error: "Title and URL are required" });
      }
      const existing = db.getMusic(id);
      if (!existing) return json(res, 404, { error: "Track not found" });
      return json(res, 200, db.updateMusic(id, { title, url, sort_order: body.sort_order, source_type: body.source_type }));
    }

    if (req.method === "DELETE") {
      if (!requireAuth()) return;
      const existing = db.getMusic(id);
      if (!existing) return json(res, 404, { error: "Track not found" });
      db.deleteMusic(id);
      return json(res, 200, { ok: true });
    }
  }

  // ── Recording hub API ─────────────────────────────────
  // `recording_repos` are the hub's OWN projects — a separate library from
  // the Recordings `music` table (split in migration 011). Every take is a
  // recording_commits row on the repo.
  //   GET  /api/recordings                  → public, repos the viewer can see
  //   POST /api/recordings                  → member, init a new recording
  //   POST /api/recordings/:id/play         → public, bump a repo's play count
  //   GET/POST /api/recordings/:id/commits  → public list / member add commit
  //   PATCH /api/recordings/:id/commits/:cid → member, update commit volume
  //   POST /api/recordings/:id/commits/:cid/tag → member, tag as next version
  //   DELETE /api/recordings/:id/commits/:cid → member, delete a commit
  //   DELETE /api/recordings/:id            → member, remove repo + commits
  // Banded repos (band_id set) are visible + editable only by their members /
  // admin; legacy repos (band_id NULL) stay public but admin-only to edit.
  if (urlPath === "/api/recordings" && req.method === "GET") {
    const repos = db.listRecordingReposForUser(
      authUser ? authUser.id : null,
      authUser ? authUser.is_admin : false
    );
    for (const repo of repos) {
      repo.commits = db.listRecordingCommits(repo.id);
      repo.can_edit = db.canEditRepo(authUser, repo);
    }
    return json(res, 200, { repos });
  }

  if (urlPath === "/api/recordings" && req.method === "POST") {
    if (!requireProfile()) return;
    const body = await readBody(req);
    const title = cleanText(body.title, 300);
    const message = cleanText(body.message, 500) || "Initial recording";
    const url = cleanText(body.url, 1000);
    const band = db.getBand(Number(body.band_id));
    if (!band) return json(res, 400, { error: "A valid band is required" });
    if (!authUser.is_admin && !db.isUserInBand(authUser.id, band.id)) {
      return json(res, 403, { error: "You are not a member of this band" });
    }
    if (!title || !url) {
      return json(res, 400, { error: "Title and audio URL are required" });
    }
    const repo = db.createRecordingRepo({
      title,
      url,
      sort_order: body.sort_order,
      // 原创 (original) vs Cover — the owner picks this once in the New
      // Recording form; only those two values are ever stored.
      source_type: body.source_type === "cover" ? "cover" : "original",
      band_id: band.id,
    });
    const commit = db.createRecordingCommit({
      repo_id: repo.id,
      parent_id: null,
      message,
      url,
      start_time: parseFloat(body.start_time),
      end_time: parseFloat(body.end_time),
      mode: "single",
      volume: parseFloat(body.volume),
      contributor: cleanText(body.contributor, 60) || authUser.nickname || authUser.username,
      version: 1, // the initial commit is always the recording's first version
      recorded_by: authUser.id,
    });
    return json(res, 201, { repo: db.getRecordingRepo(repo.id), commit });
  }

  // Play-count increment — public (visitors bump it), host-gated + rate-limited.
  // Banded repos are private: only their members / admin may bump them.
  const recordingPlayMatch = urlPath.match(/^\/api\/recordings\/(\d+)\/play$/);
  if (recordingPlayMatch && req.method === "POST") {
    if (!checkCountRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const repo = db.getRecordingRepo(Number(recordingPlayMatch[1]));
    if (!repo) return json(res, 404, { error: "Recording not found" });
    if (repo.band_id != null && !db.canEditRepo(authUser, repo)) {
      return json(res, 403, { error: "This recording is private to its band" });
    }
    const updated = db.incrementRecordingRepoPlay(repo.id);
    return json(res, 200, { ok: true, play_count: updated.play_count });
  }

  const repoCommitsMatch = urlPath.match(/^\/api\/recordings\/(\d+)\/commits$/);
  if (repoCommitsMatch) {
    const repoId = Number(repoCommitsMatch[1]);
    const repo = db.getRecordingRepo(repoId);
    if (!repo) return json(res, 404, { error: "Recording not found" });

    if (req.method === "GET") {
      if (repo.band_id != null && !db.canEditRepo(authUser, repo)) {
        return json(res, 403, { error: "This recording is private to its band" });
      }
      return json(res, 200, { repo, commits: db.listRecordingCommits(repoId) });
    }

    if (req.method === "POST") {
      if (!requireProfile()) return;
      if (!db.canEditRepo(authUser, repo)) {
        return json(res, 403, { error: "You are not a member of this recording's band" });
      }
      const body = await readBody(req);
      const message = cleanText(body.message, 500);
      const url = cleanText(body.url, 1000);
      if (!message || !url) {
        return json(res, 400, { error: "Commit message and audio URL are required" });
      }
      const parentId = body.parent_id ? Number(body.parent_id) : null;
      if (parentId) {
        const parent = db.getRecordingCommit(parentId);
        if (!parent || parent.repo_id !== repoId) {
          return json(res, 400, { error: "Parent commit not found in this recording" });
        }
      }
      const commit = db.createRecordingCommit({
        repo_id: repoId,
        parent_id: parentId,
        message,
        url,
        start_time: parseFloat(body.start_time),
        end_time: parseFloat(body.end_time),
        mode: body.mode === "single" ? "single" : "overlay",
        volume: parseFloat(body.volume),
        lead: parseFloat(body.lead),
        contributor: cleanText(body.contributor, 60) || authUser.nickname || authUser.username,
        recorded_by: authUser.id,
      });
      return json(res, 201, { commit });
    }
  }

  const commitPatchMatch = urlPath.match(/^\/api\/recordings\/(\d+)\/commits\/(\d+)$/);
  if (commitPatchMatch && req.method === "PATCH") {
    if (!requireProfile()) return;
    const repoId = Number(commitPatchMatch[1]);
    const commitId = Number(commitPatchMatch[2]);
    const repo = db.getRecordingRepo(repoId);
    if (!repo) return json(res, 404, { error: "Recording not found" });
    if (!db.canEditRepo(authUser, repo)) {
      return json(res, 403, { error: "You are not a member of this recording's band" });
    }
    const existing = db.getRecordingCommit(commitId);
    if (!existing || existing.repo_id !== repoId) {
      return json(res, 404, { error: "Commit not found in this recording" });
    }
    const body = await readBody(req);
    const volume = parseFloat(body.volume);
    if (!Number.isFinite(volume)) {
      return json(res, 400, { error: "volume must be a number" });
    }
    const commit = db.updateRecordingCommitVolume(commitId, volume);
    return json(res, 200, { commit });
  }

  if (commitPatchMatch && req.method === "DELETE") {
    if (!requireProfile()) return;
    const repoId = Number(commitPatchMatch[1]);
    const commitId = Number(commitPatchMatch[2]);
    const repo = db.getRecordingRepo(repoId);
    if (!repo) return json(res, 404, { error: "Recording not found" });
    if (!db.canEditRepo(authUser, repo)) {
      return json(res, 403, { error: "You are not a member of this recording's band" });
    }
    const existing = db.getRecordingCommit(commitId);
    if (!existing || existing.repo_id !== repoId) {
      return json(res, 404, { error: "Commit not found in this recording" });
    }
    const fileUrl = existing.url;
    db.deleteRecordingCommit(commitId);
    // Remove the underlying audio file, but only when nothing else still
    // references it (the repo's initial commit shares its URL with
    // recording_repos.url, and the same file could be reused by another
    // commit or a Recordings track).
    if (fileUrl && fileUrl.startsWith(RECORDING_URL_PREFIX) && !db.isRecordingUrlReferenced(fileUrl)) {
      const filePath = path.join(RECORDING_DIR, path.normalize(fileUrl.slice(RECORDING_URL_PREFIX.length)));
      if (filePath.startsWith(path.resolve(RECORDING_DIR) + path.sep)) {
        fs.unlink(filePath, () => {}); // best-effort: missing files are fine
      }
    }
    return json(res, 200, { ok: true });
  }

  const commitTagMatch = urlPath.match(/^\/api\/recordings\/(\d+)\/commits\/(\d+)\/tag$/);
  if (commitTagMatch && req.method === "POST") {
    if (!requireProfile()) return;
    const repoId = Number(commitTagMatch[1]);
    const commitId = Number(commitTagMatch[2]);
    const repo = db.getRecordingRepo(repoId);
    if (!repo) return json(res, 404, { error: "Recording not found" });
    if (!db.canEditRepo(authUser, repo)) {
      return json(res, 403, { error: "You are not a member of this recording's band" });
    }
    const existing = db.getRecordingCommit(commitId);
    if (!existing || existing.repo_id !== repoId) {
      return json(res, 404, { error: "Commit not found in this recording" });
    }
    const commit = db.tagRecordingCommit(commitId);
    if (!commit) return json(res, 404, { error: "Commit not found" });
    return json(res, 200, { commit });
  }

  const repoDeleteMatch = urlPath.match(/^\/api\/recordings\/(\d+)$/);
  if (repoDeleteMatch && req.method === "DELETE") {
    if (!requireProfile()) return;
    const repoId = Number(repoDeleteMatch[1]);
    const repo = db.getRecordingRepo(repoId);
    if (!repo) return json(res, 404, { error: "Recording not found" });
    if (!db.canEditRepo(authUser, repo)) {
      return json(res, 403, { error: "You are not a member of this recording's band" });
    }
    // Collect the audio files this recording owns (the repo's own file plus
    // every commit's) so the files can be removed once nothing else references
    // them — mirroring the per-commit delete. Shared URLs are left alone.
    const urls = new Set([repo.url]);
    for (const c of db.listRecordingCommits(repoId)) urls.add(c.url);
    db.deleteRecordingRepo(repoId); // deletes its commits too
    for (const url of urls) {
      if (url && url.startsWith(RECORDING_URL_PREFIX) && !db.isRecordingUrlReferenced(url)) {
        const filePath = path.join(RECORDING_DIR, path.normalize(url.slice(RECORDING_URL_PREFIX.length)));
        if (filePath.startsWith(path.resolve(RECORDING_DIR) + path.sep)) {
          fs.unlink(filePath, () => {}); // best-effort: missing files are fine
        }
      }
    }
    return json(res, 200, { ok: true });
  }

  // ── Blog API ──────────────────────────────────────────
  if (urlPath === "/api/blog" && req.method === "GET") {
    const posts = db.listBlogPosts().map((p) => ({
      ...p,
      blocks: JSON.parse(p.blocks || "[]"),
    }));
    return json(res, 200, { posts });
  }

  // Read-count increment — public (visitors bump it), host-gated + rate-limited.
  const blogReadMatch = urlPath.match(/^\/api\/blog\/(\d+)\/read$/);
  if (blogReadMatch && req.method === "POST") {
    if (!checkCountRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const post = db.incrementBlogRead(Number(blogReadMatch[1]));
    if (!post) return json(res, 404, { error: "Post not found" });
    return json(res, 200, { ok: true, read_count: post.read_count });
  }

  // Short-link creation — public (visitors shorten the current page so it
  // fits a WeChat message), host-gated by apiGate + rate limited + only
  // ever shortened to same-site URLs (no open-redirect surface).
  if (urlPath === "/api/share" && req.method === "POST") {
    if (!checkShareRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const body = await readBody(req);
    const url = cleanText(body.url, 600);
    if (!url) return json(res, 400, { error: "url is required" });
    if (!isSameSiteUrl(url, req)) {
      return json(res, 400, { error: "Only links on this site can be shortened" });
    }
    const link = db.createShareLink(url);
    return json(res, 201, {
      code: link.code,
      url: link.url,
      short_url: `${siteBase(req)}/s/${link.code}`,
    });
  }

  // ── Vinyl Archive (黑胶档案) API ──────────────────────
  //   GET  /api/vinyl               → public, list archive albums
  //   GET  /api/vinyl/:slug         → public, archive album detail
  //   POST /api/vinyl/:id/play      → public, bump a vinyl share-page play
  //   GET  /api/vinyl/lookup        → public, live Discogs release detail
  //                                   (fetched on demand, nothing is stored)
  if (urlPath === "/api/vinyl" && req.method === "GET") {
    return json(res, 200, { records: db.listVinylRecords().map(publicVinylRow) });
  }

  // Live Discogs release detail — proxies /releases/{id} on demand.  This is
  // a pure lookup: nothing is written to the DB and no cover is downloaded,
  // so the server never stores Discogs data.  (Must sit before the
  // /api/vinyl/:slug matcher below so "lookup" isn't treated as a slug.)
  if (urlPath === "/api/vinyl/lookup" && req.method === "GET") {
    if (!checkShareRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const raw = new URL(req.url, "http://localhost");
    const discogsId = Number(raw.searchParams.get("discogs_id"));
    if (!Number.isInteger(discogsId) || discogsId <= 0) {
      return json(res, 400, { error: "无效的 discogs_id" });
    }
    if (!DISCOGS_TOKEN) {
      return json(res, 400, { error: "Discogs token 未配置 — 请设置 DISCOGS_TOKEN 或 data/.discogs-token" });
    }
    try {
      const detail = await discogs.detail(discogsId);
      return json(res, 200, { detail });
    } catch (e) {
      return json(res, 502, { error: e.message || "Discogs 详情获取失败" });
    }
  }

  const vinylDetail = urlPath.match(/^\/api\/vinyl\/([a-z0-9-]+)$/);
  if (vinylDetail && req.method === "GET") {
    const rec = db.getVinylRecord(vinylDetail[1]);
    if (!rec) return json(res, 404, { error: "Album not found" });
    return json(res, 200, { record: publicVinylRow(rec) });
  }

  const vinylPlay = urlPath.match(/^\/api\/vinyl\/(\d+)\/play$/);
  if (vinylPlay && req.method === "POST") {
    if (!checkCountRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const rec = db.incrementVinylPlay(Number(vinylPlay[1]));
    if (!rec) return json(res, 404, { error: "Album not found" });
    return json(res, 200, { ok: true, play_count: rec.play_count });
  }

  //   POST /api/vinyl/search     → public, text search: local archive first,
  //                                then Discogs (when a token is configured).
  //                                Results are live; nothing is imported/stored.
  if (urlPath === "/api/vinyl/search" && req.method === "POST") {
    if (!checkShareRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const body = await readBody(req);
    const q = cleanText(body.q, 200).trim();
    if (!q) return json(res, 400, { error: "搜索词不能为空" });
    const local = db.searchVinylRecordsLocal(q).map(publicVinylRow);
    let external = [];
    let externalError = null;
    if (DISCOGS_TOKEN) {
      try {
        external = await discogs.search(q);
      } catch (e) {
        externalError = e.message; // local matches still returned
      }
    }
    return json(res, 200, { local, external, externalEnabled: !!DISCOGS_TOKEN, externalError });
  }

  if (urlPath === "/api/blog" && req.method === "POST") {
    if (!requireAuth()) return;
    const body = await readBody(req);
    const title = cleanText(body.title, 300);
    if (!title) {
      return json(res, 400, { error: "Title is required" });
    }
    const post = db.createBlogPost({
      title,
      tag: cleanText(body.tag, 100),
      date: cleanText(body.date, 20),
      cover: safeUrl(body.cover),
      blocks: sanitizeBlocks(body.blocks),
    });
    return json(res, 201, { post: { ...post, blocks: JSON.parse(post.blocks) } });
  }

  const blogMatch = urlPath.match(/^\/api\/blog\/(\d+)$/);
  if (blogMatch) {
    const id = Number(blogMatch[1]);

    if (req.method === "PUT") {
      if (!requireAuth()) return;
      const body = await readBody(req);
      const title = cleanText(body.title, 300);
      if (!title) {
        return json(res, 400, { error: "Title is required" });
      }
      const existing = db.getBlogPost(id);
      if (!existing) return json(res, 404, { error: "Post not found" });
      const post = db.updateBlogPost(id, {
        title,
        tag: cleanText(body.tag, 100),
        date: cleanText(body.date, 20),
        cover: safeUrl(body.cover),
        blocks: sanitizeBlocks(body.blocks),
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
      method: "GET", // proxies are GET-only (open-proxy abuse prevention)
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
const defaultHost = process.env.PUBLIC_URL || ALLOWED_HOSTS.size ? "0.0.0.0" : "127.0.0.1";
const HOST = process.env.HOST || defaultHost;

const server = http.createServer((req, res) => {
  setSecurityHeaders(res);

  const raw = new URL(req.url, "http://localhost");
  const urlPath = raw.pathname;

  // All /api/* paths (including the gitee proxy) are gated: only localhost
  // and the site's own host/domain may call them.
  //
  // Exception: a request bearing a VALID admin JWT (Authorization: Bearer)
  // is allowed regardless of Host/Origin. The token is presented in an
  // Authorization header from localStorage — browsers never attach it to
  // cross-site requests automatically (unlike cookies), so this cannot be
  // abused by CSRF/DNS-rebinding attackers. An attacker would need to know
  // a valid session token, which is exactly the same requirement as for an
  // authenticated request. Unauth'd traffic (login, public reads, proxies)
  // still goes through the full host gate.
  if (urlPath.startsWith("/api/")) {
    const authHeader = req.headers.authorization || "";
    const hasValidJwt =
      authHeader.startsWith("Bearer ") && verifyToken(authHeader.slice(7)) !== null;
    if (!hasValidJwt) {
      if (!apiGate(req, res)) return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API proxies
    for (const prefix of Object.keys(API_PROXIES)) {
      if (urlPath.startsWith(prefix + "/") || urlPath === prefix) {
        if (req.method !== "GET") {
          return json(res, 405, { error: "Method not allowed" });
        }
        if (!checkProxyRate(req)) {
          return json(res, 429, { error: "Rate limit exceeded" });
        }
        return proxyRequest(req, res, API_PROXIES[prefix]);
      }
    }

    handleApi(req, res, urlPath).catch((err) => {
      console.error("API error:", err.message);
      const status = typeof err.status === "number" ? err.status : 400;
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, status, { error: err.message });
      // When a request body was rejected mid-stream (413), the connection
      // can no longer be reused — close it once the response has flushed.
      if (status === 413 && !req.readableEnded) {
        res.on("finish", () => req.socket.destroy());
      }
    });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Uploaded photos (served from PHOTO_DIR, outside publicDir). Photo URLs are
  // unique per upload (benpage_<stamp>_<rand>.jpg), i.e. immutable — served
  // with a one-year immutable cache so the browser never re-downloads them.
  if (urlPath.startsWith(PHOTO_URL_PREFIX)) {
    const photoPath = path.join(PHOTO_DIR, path.normalize(urlPath.slice(PHOTO_URL_PREFIX.length)));
    if (!photoPath.startsWith(path.resolve(PHOTO_DIR) + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    // Lazy *_card.jpg: blog grid covers request a card-size thumbnail. When it
    // hasn't been generated yet (photos uploaded before thumbnails existed),
    // derive it once from the full-size source and cache it on disk.
    const baseName = path.basename(photoPath);
    const cardMatch = /^(.+)_card\.jpg$/i.exec(baseName);
    if (cardMatch && /^benpage_[a-z0-9_-]+\.jpg$/i.test(cardMatch[1] + ".jpg")) {
      const srcPath = path.join(PHOTO_DIR, cardMatch[1] + ".jpg");
      fs.stat(photoPath, (statErr) => {
        if (!statErr) {
          serveFileWithCache(req, res, photoPath, PHOTO_CACHE_CONTROL);
          return;
        }
        fs.readFile(srcPath, (srcErr, srcBuf) => {
          if (srcErr) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
          }
          const thumb = makeCardThumb(srcBuf);
          if (!thumb) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
          }
          fs.writeFile(photoPath, thumb, (writeErr) => {
            if (writeErr) {
              res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
              res.end("Not Found");
              return;
            }
            serveFileWithCache(req, res, photoPath, PHOTO_CACHE_CONTROL);
          });
        });
      });
      return;
    }
    serveFileWithCache(req, res, photoPath, PHOTO_CACHE_CONTROL);
    return;
  }

  // Uploaded recordings (served from RECORDING_DIR, outside publicDir).
  // Streamed with HTTP Range support so <audio> can seek on larger files.
  if (urlPath.startsWith(RECORDING_URL_PREFIX)) {
    // Banded recordings are private: their raw audio files are only served to
    // band members / admin. The native <audio> element can't send the
    // Authorization header, so the hub appends ?token=<JWT> when playing a
    // banded file (playNativeTrack / decodeLayer). Legacy public files are
    // unaffected. token= is accepted for <audio> playback only — it is the
    // user's own short-lived JWT, never shared with other pages.
    const fileRepo = db.findRepoForAudioUrl(urlPath);
    if (fileRepo && fileRepo.band_id != null) {
      let viewer = getAuthUser(req);
      if (!viewer) {
        const q = new URL(req.url, "http://localhost");
        const token = q.searchParams.get("token");
        const payload = token ? verifyToken(token) : null;
        if (payload && payload.sub) viewer = db.getUserAuth(payload.sub);
      }
      if (!viewer || !db.canEditRepo(viewer, fileRepo)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
    }
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

  // ── Share pages (server-rendered, WeChat-friendly) ─────────────────
  // Every blog post / music track is shareable as a real web page at
  // /post/:id and /music/:id (og: meta tags included, no JS required).
  const postShare = urlPath.match(/^\/post\/(\d+)$/);
  if (postShare && req.method === "GET") {
    const post = db.getBlogPost(Number(postShare[1]));
    if (!post) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderBlogSharePage(req, post));
    return;
  }

  const musicShare = urlPath.match(/^\/music\/(\d+)$/);
  if (musicShare && req.method === "GET") {
    const track = db.getMusic(Number(musicShare[1]));
    if (!track) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    // Recordings are plain admin-uploaded tracks (they live in `music` and
    // never have recording commits), so the share page plays the track's own
    // file — no tagged-version logic.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderMusicSharePage(req, track, null));
    return;
  }

  // REC HUB share page — reads recording_repos (not music) and plays the
  // repo's latest TAGGED version (single = the version's own file; overlay =
  // its rendered chain mix), never the initial commit's file.
  const recordingShare = urlPath.match(/^\/recording\/(\d+)$/);
  if (recordingShare && req.method === "GET") {
    const repo = db.getRecordingRepo(Number(recordingShare[1]));
    if (!repo) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    // Banded recordings are private to their band — no public share page.
    if (repo.band_id != null) {
      const viewer = getAuthUser(req);
      const allowed = viewer && db.canEditRepo(viewer, repo);
      if (!allowed) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("This recording is private to its band. Log in on the REC HUB to listen.");
        return;
      }
    }
    const latest = db.getLatestTaggedCommit(repo.id);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderRecordingSharePage(req, repo, latest));
    return;
  }

  // Discogs reference share page — live-rendered from the Discogs API on
  // every open (no DB record, nothing stored on this server).  Sharing a
  // search result points here, so WeChat/QR link previews carry real title,
  // year, artist, label and cover art.
  const vinylDiscogsShare = urlPath.match(/^\/vinyl\/discogs\/(\d+)$/);
  if (vinylDiscogsShare && req.method === "GET") {
    const discogsId = Number(vinylDiscogsShare[1]);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (!DISCOGS_TOKEN) {
      res.end(renderVinylDiscogsErrorPage(req, "Discogs token 未配置 — 请设置 DISCOGS_TOKEN 或 data/.discogs-token。"));
      return;
    }
    discogs
      .detail(discogsId)
      .then((detail) => res.end(renderVinylDiscogsSharePage(req, detail)))
      .catch((e) =>
        res.end(renderVinylDiscogsErrorPage(req, e.message || "Discogs 详情获取失败，请稍后再试。"))
      );
    return;
  }

  // 黑胶档案 (Vinyl Archive) share page — a stored album from the archive.
  // Reads vinyl_records (not music), renders the vintage record-card layout
  // server-side (og:image = the cover art).
  const vinylShare = urlPath.match(/^\/vinyl\/([a-z0-9-]+)$/);
  if (vinylShare && req.method === "GET") {
    const rec = db.getVinylRecord(vinylShare[1]);
    if (!rec) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderVinylSharePage(req, rec));
    return;
  }

  // ── Short-link redirects (share feature) ────────────────────────────
  // Codes are 7 chars of an unambiguous alphabet (see db.js).  Stored URLs
  // are always same-site, so this can never be an open redirect.
  const shortLink = urlPath.match(/^\/s\/([A-Za-z0-9_-]{4,32})$/);
  if (shortLink && req.method === "GET") {
    const link = db.getShareLink(shortLink[1]);
    if (!link) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    db.incrementShareLinkHit(link.code);
    res.writeHead(302, { Location: link.url, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  // Public site config (tiny JS) — exposes the canonical origin to the
  // frontend so share links are always built on the PUBLIC_URL domain. The
  // QR / copy / short-link share URL derives from it, which is what WeChat
  // Moments shows under the card as "via <domain>". no-store: must never
  // serve a stale origin.
  if (urlPath === "/site-config.js" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(`window.SITE_URL=${JSON.stringify(siteBase(req)).replace(/</g, "\\u003c")};`);
    return;
  }

  // App direct-access pages — https://<domain>/{path} opens the app directly
  // (same single-page index.html shell; apps.js auto-opens the right panel).
  if ((req.method === "GET" || req.method === "HEAD") && APP_PATHS[urlPath]) {
    serveFileWithCache(req, res, path.join(publicDir, APP_PATHS[urlPath]), "no-cache");
    return;
  }

  // Static files
  const filePath = urlPath === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, path.normalize(urlPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  // HTML/JS/CSS: revalidate every load so a deploy is picked up immediately
  // instead of browsers keeping the old recorder code (which caused WebM
  // uploads to be rejected after the WAV migration). The ETag still turns
  // those revalidations into cheap 304s. Images/fonts/audio: cache for a day
  // and revalidate on expiry.
  const cacheControl = [".html", ".js", ".css", ".mjs"].includes(ext)
    ? "no-cache"
    : "public, max-age=86400";
  serveFileWithCache(req, res, filePath, cacheControl);
});

// Auto-cleanup of generated recording files (conversion cache, stale
// *.tmp, uploaded-but-never-committed takes) that no DB row references
// anymore. Playback itself never writes to disk, so these are the only
// files that can pile up. Cheap (one directory scan) and safe: only
// app-scheme names are candidates and every file is reference-checked.
const gcRemoved = db.gcOrphanedRecordingFiles(RECORDING_DIR, RECORDING_URL_PREFIX);
if (gcRemoved.length) {
  console.log(`[gc] Removed ${gcRemoved.length} orphaned recording file(s):`);
  for (const f of gcRemoved) console.log(`[gc]   - ${f}`);
}

server.listen(PORT, HOST, () => {
  const allowed =
    "localhost" +
    (PUBLIC_HOST ? ", " + PUBLIC_HOST : "") +
    ([...ALLOWED_HOSTS].length ? ", " + [...ALLOWED_HOSTS].join(", ") : "");
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`API restricted to: ${allowed}`);
  if (!process.env.PUBLIC_URL && !ALLOWED_HOSTS.size) {
    console.log(
      "  → Relaxed mode: same-origin browser requests (any host/IP) + localhost may call /api/*."
    );
    console.log(
      "  → For full DNS-rebinding protection, set PUBLIC_URL=https://your.domain (or ALLOWED_HOSTS=your.domain)."
    );
    console.log("  → The server currently binds 127.0.0.1 only (localhost).");
  } else {
    console.log("  → Strict mode: only the hosts above may call the API.");
  }
  if (!process.env.JWT_SECRET && process.env.NODE_ENV !== "production") {
    console.log(`  → Dev JWT secret persisted at ${JWT_SECRET_FILE}`);
  } else if (!process.env.JWT_SECRET) {
    console.log(`  → JWT secret loaded from ${JWT_SECRET_FILE} (set JWT_SECRET env var to override)`);
  }
  checkNeteaseSidecar();
});