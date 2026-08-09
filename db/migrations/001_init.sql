-- 001_init.sql
-- Initial schema. Same DDL that was previously hard-coded in db.js.
-- This migration is applied ONLY to brand-new databases (see db/schema.js).
--
-- NOTE: must_change_password is intentionally NOT here — it is added by
-- 002_add_must_change_password.sql so that migration can run unchanged on
-- both fresh and legacy databases.

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