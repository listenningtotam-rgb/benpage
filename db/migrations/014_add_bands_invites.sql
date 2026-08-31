-- 014_add_bands_invites.sql
-- Band-based collaboration for REC HUB (乐队成员制录音).
--
-- Before this migration the REC HUB is owned by a single admin account:
--   · users have no profile fields and no role flag
--   · every recording_repos row is public to everyone
--   · inviting collaborators is impossible
--
-- This migration adds:
--   1. bands            — a band (乐队); recordings belong to a band
--   2. band_members     — a user can join many bands (join table)
--   3. invite_codes     — admin-generated codes bound to a band; logging in
--                         with a code creates/looks up the member account
--   4. users            + nickname / email / is_admin / profile_complete
--   5. recording_repos  + band_id    → the recording is private to that band
--   6. recording_commits + recorded_by → which user recorded the take
--
-- Existing rows are untouched: legacy recordings keep band_id NULL (= public),
-- and the existing admin account is flagged is_admin from db.js (ensureAdmin).
--
-- ADDITIVE ONLY — CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN /
-- CREATE INDEX. Nothing is dropped or rewritten.

CREATE TABLE IF NOT EXISTS bands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS band_members (
  band_id    INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (band_id, user_id)
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT UNIQUE NOT NULL,
  band_id    INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  created_by INTEGER,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE users ADD COLUMN nickname TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN profile_complete INTEGER NOT NULL DEFAULT 0;

ALTER TABLE recording_repos ADD COLUMN band_id INTEGER REFERENCES bands(id) ON DELETE SET NULL;

ALTER TABLE recording_commits ADD COLUMN recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_recording_repos_band ON recording_repos(band_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_band ON invite_codes(band_id);
CREATE INDEX IF NOT EXISTS idx_band_members_user ON band_members(user_id);
