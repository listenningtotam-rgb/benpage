-- 011_separate_recording_repos.sql
-- Decouple the recording hub (REC HUB) from the music library.
--
-- Before this migration, REC HUB repos and the Recordings playlist were the
-- SAME rows: /api/music and /api/recordings both read the `music` table, and
-- recording_commits.repo_id pointed at music(id). Adding or deleting a track
-- therefore changed the hub (and vice-versa).
--
-- This migration:
--   1. creates a dedicated `recording_repos` table (the same fields music
--      rows carried as repos: title/url/sort_order/source_type/play_count)
--   2. copies every existing music row into it, PRESERVING ids so every
--      recording_commits.repo_id stays attached to the same project
--   3. rebuilds recording_commits so its FK points at recording_repos(id)
--      instead of music(id) — bookkeeping only: every row and column value
--      is copied verbatim (the table is dropped solely to change the FK).
--
-- After this migration the two libraries diverge and each can be managed
-- independently:
--   · `music`           → Recordings tab — plain tracks uploaded by admin
--   · `recording_repos` → REC HUB — git-like recording projects + commits
--
-- DATA-PRESERVING: nothing is deleted or rewritten. Both sides keep the
-- existing library; from now on they evolve separately.

CREATE TABLE IF NOT EXISTS recording_repos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'original'
              CHECK (source_type IN ('original', 'cover')),
  play_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Carry the current library over (same ids → commits stay on the right
-- repo). Idempotent so the migration can never double-insert.
INSERT INTO recording_repos (id, title, url, sort_order, source_type, play_count, created_at)
SELECT id, title, url, sort_order, source_type, play_count, created_at
FROM music
WHERE id NOT IN (SELECT id FROM recording_repos);

-- Rebuild recording_commits with its FK repointed from music → recording_repos.
-- SQLite has no ALTER for FK constraints, so this is the standard
-- create-new → copy → drop-old → rename pattern. The column set matches the
-- post-009 shape exactly (see 005–009) and every value is copied verbatim.
CREATE TABLE recording_commits_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL,
  parent_id   INTEGER,
  message     TEXT NOT NULL,
  url         TEXT NOT NULL,
  start_time  REAL NOT NULL DEFAULT 0,
  end_time    REAL,
  mode        TEXT NOT NULL DEFAULT 'single'
              CHECK (mode IN ('single', 'overlay')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  volume      REAL NOT NULL DEFAULT 1.0,
  contributor TEXT NOT NULL DEFAULT 'admin',
  lead        REAL NOT NULL DEFAULT 0,
  "version"   INTEGER,
  FOREIGN KEY (repo_id) REFERENCES recording_repos(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES recording_commits(id) ON DELETE SET NULL
);

INSERT INTO recording_commits_new (id, repo_id, parent_id, message, url, start_time, end_time, mode, created_at, volume, contributor, lead, "version")
SELECT id, repo_id, parent_id, message, url, start_time, end_time, mode, created_at, volume, contributor, lead, "version"
FROM recording_commits;

DROP TABLE recording_commits;
ALTER TABLE recording_commits_new RENAME TO recording_commits;

CREATE INDEX IF NOT EXISTS idx_recording_commits_repo ON recording_commits(repo_id, id);
