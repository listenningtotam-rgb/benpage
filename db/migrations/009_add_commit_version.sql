-- 009_add_commit_version.sql
-- Version tagging for recording commits. The public share link (/music/:id)
-- plays the latest TAGGED version instead of always the initial commit, so a
-- song can evolve through takes and the owner decides which ones are
-- "versions" by pressing the version-tag button on a commit.
--
--   · "version" NULL   → not a tagged version
--   · "version" 1,2,3… → tagged; displayed as "v1.0", "v2.0", …
-- The next number is always MAX(version)+1 within the repo, assigned by the
-- server (db.tagRecordingCommit) so it can never collide or skip.
--
-- The backfill below tags every existing repo's ROOT commit (the only commit
-- with parent_id NULL) as v1.0 — the same rule new recordings get at creation
-- time. ADDITIVE ONLY: one new nullable column (never drops or rewrites any
-- existing value — only NULL rows are filled) plus an index.
ALTER TABLE recording_commits ADD COLUMN "version" INTEGER;
UPDATE recording_commits SET "version" = 1 WHERE "version" IS NULL AND parent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_recording_commits_version ON recording_commits(repo_id, "version");
