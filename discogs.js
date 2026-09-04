"use strict";
/* ── Discogs API client for 黑胶档案 text search + import ──────────────
 * Server-side only (never exposes the token to the browser).  Requires a
 * Discogs personal access token (https://www.discogs.com/settings/developers)
 * for /database/search; the token is sent via the Authorization header and a
 * custom User-Agent identifies the app per Discogs API policy.
 * ---------------------------------------------------------------------- */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const vinylHash = require("./vinyl-hash");

const API_BASE = process.env.DISCOGS_API_BASE || "https://api.discogs.com";

/* "4:20" → 260000 ms, "1:04:20" → 3860000 ms, ""/garbage → null. */
function parseDiscogsDuration(d) {
  const s = String(d || "").trim();
  if (!s) return null;
  const parts = s.split(":").map((p) => Number(p.trim()));
  if (parts.some((p) => !isFinite(p)) || parts.length < 2 || parts.length > 3) return null;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

/* Search results pack title as "Artist - Title" — split it back out. */
function normalizeSearchResult(r) {
  if (!r || !r.id || !r.title) return null;
  const parts = String(r.title).split(" - ");
  const title = parts.length > 1 ? parts.slice(1).join(" - ").trim() : String(r.title).trim();
  const artist = parts.length > 1 ? parts.shift().trim() : "";
  return {
    source: "discogs",
    discogs_id: r.id,
    title,
    artist,
    year: r.year != null ? Number(r.year) : null,
    country: r.country || null,
    label: (Array.isArray(r.label) ? r.label[0] : r.label) || null,
    catalog_number: r.catno || null,
    format: (Array.isArray(r.format) ? r.format.join(" · ") : r.format) || null,
    thumb: r.thumb || null,
    cover_image: r.cover_image || null,
  };
}

/* /releases/{id} → full normalized detail for live browsing / sharing.
 * Unlike buildImportEntry this never requires a cover image and keeps all
 * labels / formats / genres, so the detail card and the share page can show
 * year, artist, label, catalog number, format and the tracklist. */
function normalizeReleaseDetail(rel) {
  const title = String(rel.title || "").trim();
  const artist = (rel.artists || [])
    .map((a) => String(a.name || "").trim())
    .filter(Boolean)
    .join(" / ");
  const labels = (rel.labels || [])
    .map((l) => ({ name: String(l.name || "").trim(), catno: l.catno || null }))
    .filter((l) => l.name);
  const image =
    (rel.images || []).find((i) => i.type === "primary") || (rel.images || [])[0];
  const formats = (rel.formats || [])
    .map(
      (f) =>
        [String(f.name || ""), ...(f.descriptions || [])]
          .filter(Boolean)
          .join(" ") || null
    )
    .filter(Boolean)
    .join(" · ");
  const tracks = (rel.tracklist || [])
    .filter((t) => t && t.title)
    .map((t) => ({
      position: t.position != null ? String(t.position) : null,
      title: String(t.title),
      length_ms: parseDiscogsDuration(t.duration),
    }));
  return {
    discogs_id: rel.id,
    title,
    artist,
    year: rel.year != null ? Number(rel.year) : null,
    released: rel.released || null,
    country: rel.country || null,
    labels,
    label: labels.length ? labels[0].name : null,
    catalog_number: labels.length ? labels[0].catno : null,
    formats: formats || null,
    genres: rel.genres || [],
    styles: rel.styles || [],
    tracks,
    cover_image: image && image.uri ? image.uri : null,
    discogs_url: `https://www.discogs.com/release/${rel.id}`,
  };
}

/* /releases/{id} → normalized import entry (hashes/cover handled later). */
function buildImportEntry(rel) {
  const title = String(rel.title || "").trim();
  if (!title) throw new Error("Discogs 条目缺少标题");
  const artist = (rel.artists || [])
    .map((a) => String(a.name || "").trim())
    .filter(Boolean)
    .join(" / ");
  const labelInfo = (rel.labels || [])[0] || {};
  const tracks = (rel.tracklist || [])
    .filter((t) => t && t.title)
    .map((t) => ({
      position: t.position != null ? String(t.position) : null,
      title: String(t.title),
      length: parseDiscogsDuration(t.duration),
    }));
  const image =
    (rel.images || []).find((i) => i.type === "primary") || (rel.images || [])[0];
  if (!image || !image.uri) throw new Error("该 Discogs 条目没有封面图，无法导入");
  return {
    mbid: `discogs-${rel.id}`,
    title,
    artist,
    release_date: rel.released || String(rel.year || ""),
    country: rel.country || null,
    label: labelInfo.name || null,
    catalog_number: labelInfo.catno || null,
    tracks,
    cover_url: image.uri,
    source: "discogs",
    discogs_id: rel.id,
  };
}

module.exports = function makeDiscogsClient(token, publicUrl) {
  const userAgent = `BenPage-VinylArchive/1.0 (${publicUrl || "http://localhost"})`;


  async function discogsGet(apiPath, params = {}) {
    const url = new URL(API_BASE + apiPath);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Discogs token=${token}`,
          "User-Agent": userAgent,
          Accept: "application/json",
        },
      });
    } catch (e) {
      throw new Error("Discogs 网络请求失败：" + e.message);
    }
    if (res.status === 401)
      throw new Error("Discogs token 无效（401）—— 请检查 DISCOGS_TOKEN / data/.discogs-token");
    if (res.status === 429)
      throw new Error("Discogs 请求过于频繁（429）—— 请稍后再试");
    if (!res.ok) {
      let detail = "";
      try {
        detail = String(await res.text()).slice(0, 200);
      } catch (e) {
        /* keep default message */
      }
      throw new Error(`Discogs 请求失败 HTTP ${res.status} ${detail}`.trim());
    }
    return res.json();
  }

  /* GET /database/search?q=... → normalized candidate list. */
  async function search(q) {
    const data = await discogsGet("/database/search", {
      q,
      type: "release",
      per_page: 8,
    });
    return (data.results || []).map(normalizeSearchResult).filter(Boolean);
  }

  /* GET /releases/{id}. */
  function getRelease(id) {
    return discogsGet(`/releases/${id}`);
  }

  /* fetch() first; on failure (e.g. a local HTTP proxy undici ignores)
     fall back to spawning curl -sL — mirrors seed-vinyl.js's fetchToFile. */
  function fetchToFile(url, outPath) {
    return new Promise((resolve, reject) => {
      const child = spawn("curl", ["-fsSL", "-o", outPath, url], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(outPath)
          : reject(new Error(`curl exited ${code}: ${err.trim().slice(0, 200)}`))
      );
    });
  }

  /* Best-effort binary download of one URL (cover art).  fetch() is tried
     first; on failure (e.g. a local HTTP proxy that undici ignores) it falls
     back to spawning curl -sL — mirrors seed-vinyl.js's fetchToFile, but
     returns an in-memory Buffer instead of writing a file. */
  async function downloadBuffer(url) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": userAgent },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      const tmpPath = path.join(
        os.tmpdir(),
        `vinyl-cover-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.img`
      );
      try {
        await fetchToFile(url, tmpPath);
        return fs.readFileSync(tmpPath);
      } catch (e2) {
        throw new Error(`封面下载失败：${e.message} / ${e2.message}`);
      } finally {
        fs.rmSync(tmpPath, { force: true });
      }
    }
  }

  function isJpeg(buf) {
    return !!buf && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }

  /* Full import pipeline for one Discogs release:
   *   fetch release → pick cover → download → JPEG sanity → hashes.
   * Returns { entry, cover: { buffer }, hashes } — the caller (server.js)
   * generates the final slug (needs the DB for uniqueness), writes the cover
   * and upserts, so photo recognition can find the new record too. */
  async function importRelease(discogsId) {
    const rel = await getRelease(discogsId);
    const entry = buildImportEntry(rel);
    const buf = await downloadBuffer(entry.cover_url);
    if (!isJpeg(buf)) {
      throw new Error("封面图不是有效 JPEG，无法导入");
    }
    return { entry, cover: { buffer: buf }, hashes: vinylHash.computeHashesFromBuffer(buf) };
  }

  /* GET /releases/{id} → normalized full detail (no storage, no cover
     download — used by the live detail card and the Discogs share page). */
  async function detail(id) {
    return normalizeReleaseDetail(await getRelease(id));
  }

  return { search, getRelease, detail, importRelease, downloadBuffer, isJpeg, parseDiscogsDuration };
};
