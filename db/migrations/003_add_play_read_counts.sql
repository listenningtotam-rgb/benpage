-- 003_add_play_read_counts.sql
-- Retrofit: add play/read counters so the site can show how often a track
-- was played and a blog post was opened.
-- Additive only — never touches existing rows/columns.
--
--   music.play_count      INTEGER NOT NULL DEFAULT 0  → 已播放数
--   blog_posts.read_count INTEGER NOT NULL DEFAULT 0  → 阅读数

ALTER TABLE music ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blog_posts ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0;
