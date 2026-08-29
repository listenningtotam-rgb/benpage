"use strict";
/* ── 网易云音乐 client（自托管 NeteaseCloudMusicApi sidecar）─────────────
 * 只在服务器本机(127.0.0.1)与 sidecar 通信, 从不暴露给公网。用途:
 *   · 解析歌曲播放地址  GET /song/url/v1 → 网易云 CDN mp3 直链
 *     (server.js 拿到后回 302, 浏览器随后直接从网易云 CDN 拉音频,
 *      本站不转发音频字节 → 不耗本站流量)
 *   · 后台搜索歌曲      GET /search       → 管理后台"从网易云导入"
 * 环境变量: NETEASE_API_BASE (默认 http://127.0.0.1:3001)
 * ---------------------------------------------------------------------- */

const API_BASE = process.env.NETEASE_API_BASE || "http://127.0.0.1:3001";

/* 网易云 CDN 链接有时效, 且 /song/url/v1 返回的通常是 http:// 明文。
 * 统一升级为 https:// —— 既匹配站点 CSP (media-src ... https:),
 * 又避免 http 明文(网易云 CDN 支持 https, 实测可播)。 */
function normalizeCdnUrl(u) {
  if (!u) return "";
  return String(u).replace(/^http:\/\//i, "https://");
}

async function apiGet(apiPath, params = {}) {
  const url = new URL(API_BASE + apiPath);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "benpage/1.0 (netease sidecar client)" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new Error(
      `网易云 API 不可用（${e.message}）—— 请确认 sidecar 已启动：` +
        "npm i -g NeteaseCloudMusicApi && PORT=3001 NeteaseCloudMusicApi"
    );
  }
  if (!res.ok) {
    throw new Error(`网易云 API 请求失败 HTTP ${res.status}`);
  }
  return res.json();
}

/* /song/url/v1?id=&level= → 返回可播放的 CDN 直链(已归一化为 https)。
 * 返回空串表示该歌曲当前不可播放(需要 VIP 登录 / 版权受限 / 已下架)。 */
async function getSongUrl(songId, level = "standard") {
  const data = await apiGet("/song/url/v1", { id: songId, level });
  const first = Array.isArray(data.data) ? data.data[0] : null;
  return normalizeCdnUrl(first && first.url);
}

/* /search?keywords= → 规范化搜索结果:
 *   [{ id, name, artists, album, duration_ms }] */
async function search(keywords, limit = 8) {
  const data = await apiGet("/search", { keywords, limit, type: 1 });
  const songs = (data.result && data.result.songs) || [];
  return songs.map((s) => ({
    id: Number(s.id),
    name: String(s.name || ""),
    artists: (s.artists || s.ar || [])
      .map((a) => String((a && a.name) || ""))
      .filter(Boolean)
      .join(" / "),
    album: s.album
      ? String(s.album.name || "")
      : s.al
        ? String(s.al.name || "")
        : "",
    duration_ms: Number(s.duration || s.dt) || 0,
  }));
}

module.exports = { getSongUrl, search };
