-- 012_add_vinyl_records.sql
-- 黑胶档案 (Vinyl Archive): seeded album records that are recognized from
-- photographed covers via perceptual hash (aHash + dHash).  Additive only.
CREATE TABLE IF NOT EXISTS vinyl_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mbid           TEXT NOT NULL UNIQUE,
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  artist         TEXT NOT NULL,
  release_date   TEXT,
  country        TEXT,
  label          TEXT,
  catalog_number TEXT,
  cover_path     TEXT NOT NULL,
  ahash          TEXT NOT NULL,
  dhash          TEXT NOT NULL,
  tracks_json    TEXT NOT NULL DEFAULT '[]',
  play_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vinyl_records_slug ON vinyl_records(slug);
CREATE INDEX IF NOT EXISTS idx_vinyl_records_mbid ON vinyl_records(mbid);
