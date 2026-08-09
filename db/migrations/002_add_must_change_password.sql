-- 002_add_must_change_password.sql
-- Retrofit: add must_change_password to existing databases.
-- Additive only — never touches existing rows/columns.
--
-- This ALTER is guaranteed to run only when the column is missing:
--   · fresh DBs   → 001 created users WITHOUT the column → 002 adds it
--   · legacy DBs  → baselined at 001 (no column detected) → 002 adds it
--   · legacy DBs  → baselined at 002 (column already present) → 002 skipped
-- (see db/schema.js for the baseline logic)

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;