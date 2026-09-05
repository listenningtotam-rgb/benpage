-- 015_add_app_qr.sql
-- App QR codes (dynamic QR → same-site short link).
--
-- Each row maps one app key (e.g. "rechub", "vinyl") to the short-link
-- code whose /s/<code> redirect opens that app's page in a phone browser
-- (WeChat scan → short link → app).  The code is a row in share_links too,
-- so the /s/ redirect + hit counting just reuse the existing feature.
--
-- "Dynamic" QR: the image always encodes the same short code, but the
-- code's target URL lives in the DB, so repointing an app (e.g. after a
-- path change) never invalidates codes that are already printed/shared.
--
-- ADDITIVE ONLY — creates one new table, existing data untouched.

CREATE TABLE IF NOT EXISTS app_qr (
  key        TEXT PRIMARY KEY,               -- app id, e.g. 'rechub', 'vinyl'
  code       TEXT NOT NULL UNIQUE,           -- short-link code (share_links.code)
  url        TEXT NOT NULL,                  -- same-site target path, e.g. '/vinyl'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
