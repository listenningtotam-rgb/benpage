-- 005_add_recording_commits.sql
-- Recording hub: turns the site into a git-like hub for recording takes.
--
-- Each existing `music` row becomes a "repo" (a recording project) and
-- every take is stored as a commit in `recording_commits`:
--   · repo_id     → which recording project (music.id)
--   · parent_id   → the commit that was checked out and played underneath
--                   when this take was recorded (NULL for the initial commit)
--   · message     → the commit message
--   · url         → the sound file for this take (served from /recordings/...)
--   · start_time  → seconds into the parent's playback where this take begins
--                   (0 for the initial commit = from 00:00)
--   · end_time    → seconds into the parent's playback where the take ends
--                   (NULL = auto = the take's own natural duration)
--   · mode        → 'single'  = standalone sound (plays alone, no parent)
--                   'overlay' = this take is layered on the parent's sound
--
-- ADDITIVE ONLY — one new table + index; existing rows get an initial
-- commit so every repo always has at least one commit.

CREATE TABLE IF NOT EXISTS recording_commits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL,
  parent_id  INTEGER,
  message    TEXT NOT NULL,
  url        TEXT NOT NULL,
  start_time REAL NOT NULL DEFAULT 0,
  end_time   REAL,
  mode       TEXT NOT NULL DEFAULT 'single'
             CHECK (mode IN ('single', 'overlay')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (repo_id) REFERENCES music(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES recording_commits(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_recording_commits_repo ON recording_commits(repo_id, id);

-- Backfill an initial commit for every existing recording (repo).
INSERT INTO recording_commits (repo_id, message, url, start_time, end_time, mode)
SELECT id, 'Initial recording', url, 0, NULL, 'single'
FROM music
WHERE id NOT IN (SELECT repo_id FROM recording_commits);
