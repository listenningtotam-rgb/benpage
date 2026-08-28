-- 013_add_vinyl_discogs.sql
-- 黑胶档案: Discogs 文字搜索导入支持。 Discogs releases have no MusicBrainz
-- MBID, so imported rows use a synthetic mbid "discogs-<release_id>" (keeps the
-- NOT NULL UNIQUE mbid column untouched).  source records the origin,
-- discogs_id the numeric Discogs release id.  Additive only.
ALTER TABLE vinyl_records ADD COLUMN source TEXT NOT NULL DEFAULT 'musicbrainz';
ALTER TABLE vinyl_records ADD COLUMN discogs_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_vinyl_records_discogs ON vinyl_records(discogs_id);
