-- 017_add_busking.sql
-- 路演 — a street-gig board (Apps → 路演).
--
-- One busking activity is one busking_events row.  It is created by the
-- admin (in the app's admin view or in the admin console) and published;
-- from then on it is public:
--   · anyone can read a published event and 喜欢 (like) it — likes are
--     anonymous, deduped per browser (busking_likes.visitor)
--   · 我要加入 (join) needs a member account that was created from a
--     busking_invite_codes code, and is capped by the event's capacity
--   · the participant list (nickname + the instrument they are responsible
--     for) and the post-event highlight photos are public
--
-- This migration adds:
--   1. busking_events       — one busking activity (主题/风格/人数/时间段/地点)
--   2. busking_joins        — members who joined an event + their instrument
--   3. busking_likes        — anonymous 喜欢, one row per visitor per event
--   4. busking_photos       — 精彩回顾 images added after the event
--   5. busking_invite_codes — invite codes (this app only); first use creates
--                             the member account, later uses log it back in
--   6. users                + instrument  → 擅长的乐器 (member profile)
--
-- Kept separate from the REC HUB bands/invite_codes tables (migration 014):
-- a busking invite is an app-scoped code, and a busking member needs no band.
--
-- ADDITIVE ONLY — CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN /
-- CREATE INDEX. Nothing is dropped or rewritten.

CREATE TABLE IF NOT EXISTS busking_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,                   -- 主题
  style        TEXT NOT NULL DEFAULT '',        -- 风格
  capacity     INTEGER NOT NULL DEFAULT 1,      -- 人数 (max participants)
  time_slot    TEXT NOT NULL DEFAULT '',        -- 时间段
  location     TEXT NOT NULL DEFAULT '',        -- 地点
  status       TEXT NOT NULL DEFAULT 'draft',   -- draft | published | finished
  created_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS busking_joins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES busking_events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument TEXT NOT NULL DEFAULT '',          -- 负责的乐器
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS busking_likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES busking_events(id) ON DELETE CASCADE,
  visitor    TEXT NOT NULL,                     -- 'u<id>' when signed in, else a per-browser id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, visitor)
);

CREATE TABLE IF NOT EXISTS busking_photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES busking_events(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,                     -- same-site /photo/… upload
  caption    TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS busking_invite_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT UNIQUE NOT NULL,
  created_by INTEGER,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE users ADD COLUMN instrument TEXT;

CREATE INDEX IF NOT EXISTS idx_busking_events_status ON busking_events(status);
CREATE INDEX IF NOT EXISTS idx_busking_joins_event ON busking_joins(event_id);
CREATE INDEX IF NOT EXISTS idx_busking_joins_user ON busking_joins(user_id);
CREATE INDEX IF NOT EXISTS idx_busking_likes_event ON busking_likes(event_id);
CREATE INDEX IF NOT EXISTS idx_busking_photos_event ON busking_photos(event_id);
CREATE INDEX IF NOT EXISTS idx_busking_invites_used_by ON busking_invite_codes(used_by);
