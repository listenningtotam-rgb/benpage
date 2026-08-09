/* ── SQLite Database Layer (better-sqlite3) ────────────── */
const path = require("path");

/* Fail-fast guard: better-sqlite3 is a NATIVE addon.  If the Node
 * runtime is older than the version it was built for, requiring it
 * crashes the process with SIGSEGV (status=11 / core-dump) BEFORE
 * any JS can run or be caught.  Check the version first so we can
 * print a clear message instead of a core dump. */
function assertNodeVersion() {
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  const required = 22; // better-sqlite3 v13 supports node >= 22
  if (nodeMajor < required) {
    console.error(
      "\n==============================================================\n" +
      `  Node.js v${process.versions.node} is TOO OLD for the installed\n` +
      "  better-sqlite3 native addon.\n" +
      "\n" +
      "  The server would crash with SIGSEGV (maybe a core dump).\n" +
      "  This is the exact crash you get when starting via systemd:\n" +
      "    Main process exited, code=dumped, status=11/SEGV\n" +
      "\n" +
      "  FIX:  Install Node v22 or newer, then reinstall deps:\n" +
      `    sudo apt-get install -y nodejs  # must be >= v${required}\n` +
      "    rm -rf node_modules package-lock.json && npm install\n" +
      "  Or use NodeSource LTS v22:\n" +
      "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n" +
      "    sudo apt-get install -y nodejs\n" +
      "==============================================================\n"
    );
    process.exit(1);
  }
}
assertNodeVersion();

const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "data", "benpage.db");

// Ensure data directory exists
require("fs").mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* ── Schema ────────────────────────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    pass_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    must_change_password INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS music (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    url        TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blog_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    tag        TEXT NOT NULL DEFAULT 'Note',
    date       TEXT NOT NULL DEFAULT (date('now')),
    cover      TEXT,
    blocks     TEXT NOT NULL DEFAULT '[]',  -- JSON array of blocks
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/* ── Retrofit: add must_change_password to existing databases ── */
function ensureUsersColumn() {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.some((c) => c.name === "must_change_password")) {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  }
}
ensureUsersColumn();

/* ── Seed default admin (random password, known default rotated) ── */
const ADMIN_USERNAME = "admin";
const KNOWN_DEFAULT_PASSWORD = "admin123"; // old hardcoded default
// Gitignored (data/), mode 0600 — where the generated password is written.
const ADMIN_PASSWORD_FILE = path.join(path.dirname(DB_PATH), "admin-password.txt");

function writeAdminPasswordFile(pw) {
  try {
    require("fs").writeFileSync(
      ADMIN_PASSWORD_FILE,
      `BEN 言 admin credentials (generated ${new Date().toISOString()})\n` +
      `--------------------------------------------------------\n` +
      `URL     : /admin.html\n` +
      `Username: ${ADMIN_USERNAME}\n` +
      `Password: ${pw}\n` +
      `\nYou will be asked to set a new password on your first login.\n`,
      { mode: 0o600 }
    );
  } catch (e) {
    console.warn("[db] Could not write admin password file:", e.message);
  }
}

function randomPassword() {
  return crypto.randomBytes(18).toString("base64url"); // ~24 chars, letters + digits
}

function ensureAdmin() {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(ADMIN_USERNAME);

  // New install — create the admin with a random, non-guessable password.
  if (!row) {
    const pw = randomPassword();
    db.prepare(
      "INSERT INTO users (username, pass_hash, must_change_password) VALUES (?, ?, 1)"
    ).run(ADMIN_USERNAME, hashPassword(pw));
    writeAdminPasswordFile(pw);
    console.log(`[db] Created default admin user '${ADMIN_USERNAME}'.`);
    console.log(`[db] Initial password saved to ${ADMIN_PASSWORD_FILE} (data/ is gitignored).`);
    console.log(`[db] Log in at /admin.html and change it — it MUST be changed on first login.`);
    return;
  }

  // Existing install still on the old known default (admin123) → rotate
  // it to a random password so the known credential stops working.
  if (verifyPassword(KNOWN_DEFAULT_PASSWORD, row.pass_hash)) {
    const pw = randomPassword();
    db.prepare(
      "UPDATE users SET pass_hash = ?, must_change_password = 1 WHERE id = ?"
    ).run(hashPassword(pw), row.id);
    writeAdminPasswordFile(pw);
    console.log(`[db] Detected the old default admin password — it was ROTATED to a random one.`);
    console.log(`[db] New password saved to ${ADMIN_PASSWORD_FILE}. Change it on first login.`);
  }
}

/* ── Password hashing (PBKDF2, no extra deps) ──────────── */
const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

/* ── Auth ──────────────────────────────────────────────── */
function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function authUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.pass_hash)) return null;
  return { id: user.id, username: user.username, must_change_password: !!user.must_change_password };
}

function getUserAuth(id) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return null;
  return { id: user.id, username: user.username, must_change_password: !!user.must_change_password };
}

function verifyUserPassword(id, password) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return false;
  return verifyPassword(password, user.pass_hash);
}

function changePassword(id, newPassword) {
  db.prepare("UPDATE users SET pass_hash = ?, must_change_password = 0 WHERE id = ?").run(
    hashPassword(newPassword),
    id
  );
}

/* ── Music ─────────────────────────────────────────────── */
function listMusic() {
  return db.prepare("SELECT * FROM music ORDER BY sort_order ASC, id DESC").all();
}

function getMusic(id) {
  return db.prepare("SELECT * FROM music WHERE id = ?").get(id);
}

function createMusic({ title, url, sort_order }) {
  const order = Number.isInteger(sort_order) ? sort_order : 0;
  const info = db
    .prepare("INSERT INTO music (title, url, sort_order) VALUES (?, ?, ?)")
    .run(title, url, order);
  return getMusic(info.lastInsertRowid);
}

function updateMusic(id, { title, url, sort_order }) {
  db.prepare("UPDATE music SET title = ?, url = ?, sort_order = ? WHERE id = ?").run(
    title,
    url,
    Number.isInteger(sort_order) ? sort_order : 0,
    id
  );
  return getMusic(id);
}

function deleteMusic(id) {
  db.prepare("DELETE FROM music WHERE id = ?").run(id);
}

/* ── Blog ──────────────────────────────────────────────── */
function listBlogPosts() {
  return db.prepare("SELECT * FROM blog_posts ORDER BY date DESC, id DESC").all();
}

function getBlogPost(id) {
  return db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(id);
}

function createBlogPost({ title, tag, date, cover, blocks }) {
  const info = db
    .prepare(
      "INSERT INTO blog_posts (title, tag, date, cover, blocks) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      title,
      tag || "Note",
      date || new Date().toISOString().slice(0, 10),
      cover || null,
      JSON.stringify(blocks || [])
    );
  return getBlogPost(info.lastInsertRowid);
}

function updateBlogPost(id, { title, tag, date, cover, blocks }) {
  db.prepare(
    `UPDATE blog_posts
        SET title = ?, tag = ?, date = ?, cover = ?, blocks = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    title,
    tag || "Note",
    date || new Date().toISOString().slice(0, 10),
    cover || null,
    JSON.stringify(blocks || []),
    id
  );
  return getBlogPost(id);
}

function deleteBlogPost(id) {
  db.prepare("DELETE FROM blog_posts WHERE id = ?").run(id);
}

/* ── Init ──────────────────────────────────────────────── */
ensureAdmin();

module.exports = {
  db,
  authUser,
  getUserAuth,
  verifyUserPassword,
  changePassword,
  listMusic,
  getMusic,
  createMusic,
  updateMusic,
  deleteMusic,
  listBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
};