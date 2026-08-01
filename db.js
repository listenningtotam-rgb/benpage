/* ── SQLite Database Layer (better-sqlite3) ────────────── */
const path = require("path");
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

/* ── Seed: default admin (username: admin / password: admin123) ── */
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";

function ensureAdmin() {
  const row = db.prepare("SELECT id FROM users WHERE username = ?").get(ADMIN_USERNAME);
  if (!row) {
    db.prepare("INSERT INTO users (username, pass_hash) VALUES (?, ?)").run(
      ADMIN_USERNAME,
      hashPassword(ADMIN_PASSWORD)
    );
    console.log(`[db] Created default admin user: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
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
  return { id: user.id, username: user.username };
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