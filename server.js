const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");

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
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "connect-src 'self' https://open.er-api.com",
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

function readBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const headerLen = parseInt(req.headers["content-length"] || "0", 10);
    if (headerLen > maxBytes) {
      req.destroy();
      reject(new Error("Request body too large"));
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
        req.destroy();
        reject(new Error("Request body too large"));
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
    return json(res, 201, db.createMusic({ title, url, sort_order: body.sort_order }));
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

  // Read-count increment — public (visitors bump it), host-gated + rate-limited.
  const blogReadMatch = urlPath.match(/^\/api\/blog\/(\d+)\/read$/);
  if (blogReadMatch && req.method === "POST") {
    if (!checkCountRate(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const post = db.incrementBlogRead(Number(blogReadMatch[1]));
    if (!post) return json(res, 404, { error: "Post not found" });
    return json(res, 200, { ok: true, read_count: post.read_count });
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
      json(res, 400, { error: err.message });
    });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
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
});