-- 004_add_share_links.sql
-- Short-link table for the share feature (WeChat friends / Moments).
--
-- Each row maps a short code (e.g. "aB3dEfG") to a same-site URL
-- (e.g. "/post/7" or "/music/3").  Only links that point back to this
-- site are ever stored (see server.js isSameSiteUrl), which keeps the
-- /s/<code> redirect from ever becoming an open redirect.
--
-- ADDITIVE ONLY — creates one new table, existing data untouched.

CREATE TABLE IF NOT EXISTS share_links (
  code       TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_share_links_created_at ON share_links(created_at);
