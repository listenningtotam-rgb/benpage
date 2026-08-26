-- 006_add_commit_volume.sql
-- Per-commit playback gain so a take can be balanced against the parent.
--   · volume → linear gain multiplier for this commit's own audio when the
--              ancestor chain plays (0.00–2.00+, default 1.00 = unchanged).
--              Root/initial commits stay 1.00 so the original track is never
--              altered unless the owner changes it.
--
-- ADDITIVE ONLY — one new column with a constant default. Existing rows
-- get 1.0 (play at natural volume), so old commits sound exactly as before.
ALTER TABLE recording_commits ADD COLUMN volume REAL NOT NULL DEFAULT 1.0;
