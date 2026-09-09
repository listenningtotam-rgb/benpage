-- 016_add_recording_share_public.sql
-- Opt-in public sharing for band recordings (REC HUB).
--
-- Migration 014 made banded recordings private to their band: recording_repos
-- rows with band_id set are visible/editable only by that band's members or
-- the admin, and their /recording/:id share page + raw audio files return 403
-- to everyone else (the share button in the hub was hidden for them too).
--
-- This column is the band's opt-in "publish": a member pressing ↗ on the
-- record header sets share_public = 1, after which the /recording/:id page is
-- a normal public web page (QR / copy / short-link) and plays the repo's
-- latest TAGGED version — exactly like the legacy public recordings.
--
--   share_public = 0 (default) → private to the band, as before
--   share_public = 1           → public share page + publicly streamable audio
--
-- ADDITIVE ONLY — one new nullable-default column, existing rows untouched.
-- Legacy repos (band_id NULL) stay public regardless of this flag.

ALTER TABLE recording_repos ADD COLUMN share_public INTEGER NOT NULL DEFAULT 0;
