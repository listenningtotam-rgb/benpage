-- 010_add_recording_source_type.sql
-- Every recording is either an original composition (原创) or a cover of
-- someone else's song. The owner picks this once in the New Recording form;
-- the badge then shows on the recording hub (repo HEAD line + first commit)
-- and on the public share page (/music/:id).
--
--   · 'original' → 原创 — the owner's own song
--   · 'cover'    → Cover — performing someone else's song
--
-- DEFAULT 'original' backfills every existing recording (they predate the
-- choice). ADDITIVE ONLY — one new column with a constant default; ADD
-- COLUMN fills existing rows with the default automatically, and the CHECK
-- only ever applies to newly inserted/updated rows.
ALTER TABLE music ADD COLUMN source_type TEXT NOT NULL DEFAULT 'original'
  CHECK (source_type IN ('original', 'cover'));
