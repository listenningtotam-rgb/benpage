-- 007_add_commit_contributor.sql
-- Contributor/author name shown on each commit. Only one account exists today
-- (the site admin), so the default — and the backfill for every existing
-- commit — is 'admin'. The owner can still attribute a take to someone else
-- by sending a contributor name at commit time.
--
-- ADDITIVE ONLY — one new column with a constant default; ADD COLUMN fills
-- existing rows with the default automatically.
ALTER TABLE recording_commits ADD COLUMN contributor TEXT NOT NULL DEFAULT 'admin';
