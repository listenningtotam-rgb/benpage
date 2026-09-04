"use strict";
/* ── MusicBrainz + Cover Art Archive client for 黑胶档案 ─────────────────
 * Fallback live source when the Discogs text search returns nothing (or when
 * no Discogs token is configured): text search + release detail come from
 * MusicBrainz, cover art from the Cover Art Archive.
 *
 * Both APIs are public (no token) but ask for at most one request per second,
 * so every outbound call is serialized through a single paced queue.  The
 * User-Agent must identify the app per MusicBrainz policy.  Server-side only.
 * ---------------------------------------------------------------------- */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const vinylHash = require("./vinyl-hash");

const MB_API = "https://musicbrainz.org/ws/2";
const CAA_API = "https://coverartarchive.org";
const RELEASE_INC = "artists recordings release-groups labels";

function isMbUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(s || "").trim()
  );
}

function isJpeg(buf) {
  return !!buf && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

module.exports = function makeMusicBrainzClient(publicUrl) {
  const UA = `BenPage-VinylArchive/1.0 (${publicUrl || "http://localhost"})`;

  /* Paced queue — MusicBrainz AND the Cover Art Archive both want ≤1 req/s.
     All JSON fetches and cover downloads go through `paced`, so API + cover
     traffic never exceed one combined request per gap. */
  const MB_MIN_GAP_MS = 1200;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let tail = Promise.resolve();
  let lastAt = 0;
  function paced(fn) {
    const run = tail.then(async () => {
      const wait = Math.max(0, MB_MIN_GAP_MS - (Date.now() - lastAt));
      if (wait) await sleep(wait);
      lastAt = Date.now();
      return fn();
    });
    // Keep the chain alive even when one request rejects.
    tail = run.catch(() => {});
    return run;
  }

  async function mbGet(apiPath, params = {}) {
    const url = new URL(MB_API + apiPath);
    url.searchParams.set("fmt", "json");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return paced(async () => {
      let res;
      try {
        res = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "application/json" },
        });
      } catch (e) {
        throw new Error("MusicBrainz 网络请求失败：" + e.message);
      }
      if (res.status === 429)
        throw new Error("MusicBrainz 请求过于频繁（429）— 请稍后再试");
      if (res.status === 503)
        throw new Error("MusicBrainz 暂时不可用（503）— 请稍后再试");
      if (!res.ok) {
        let detail = "";
        try {
          detail = String(await res.text()).slice(0, 200);
        } catch (e) {
          /* keep default message */
        }
        throw new Error(`MusicBrainz 请求失败 HTTP ${res.status} ${detail}`.trim());
      }
      return res.json();
    });
  }

  /* Escape the characters that have meaning in MusicBrainz' Lucene query
     syntax so a plain user query is matched literally (ANDed words), not
     parsed as operators. */
  function escapeQuery(q) {
    return String(q || "").replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
  }

  /* GET /ws/2/release/{mbid}?inc=… */
  function getRelease(mbid) {
    return mbGet(`/release/${mbid}`, { inc: RELEASE_INC });
  }

  /* fetch() first; on failure (e.g. a local HTTP proxy undici ignores) fall
     back to spawning curl -sL — mirrors discogs.js / seed-vinyl.js. */
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

  /* Download one binary URL → Buffer (curl fallback via a temp file). */
  async function downloadBuffer(url) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      const tmpPath = path.join(
        os.tmpdir(),
        `mb-cover-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.img`
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

  /* Try each candidate cover URL (release front first, release-group front as
     the fallback for releases whose art lives on the group — the same pair of
     endpoints seed-vinyl.js uses).  Returns a Buffer or throws. */
  async function fetchFirstCover(urls) {
    let lastErr = "";
    for (const url of urls) {
      try {
        const buf = await paced(() => downloadBuffer(url));
        if (buf && buf.length) return buf;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    const err = new Error("Cover Art Archive 里没有这张唱片的封面");
    if (lastErr) err.message += `（${lastErr}）`;
    throw err;
  }

  function releaseGroupIdOf(rel) {
    return (rel["release-group"] && rel["release-group"].id) || null;
  }

  function hasArtworkCandidates(rel) {
    const cca = rel["cover-art-archive"] || {};
    return cca.front === true || cca.artwork === true || !!releaseGroupIdOf(rel);
  }

  /* ── Normalizers (shapes mirror the Discogs client where the two sources
        overlap, so 黑胶档案 can render a Discogs and a MusicBrainz record
        with the same card code) ───────────────────────────────────────── */

  function artistCreditName(rel) {
    return (rel["artist-credit"] || [])
      .map((c) => String((c && c.name) || "") + String((c && c.joinphrase) || ""))
      .join("")
      .trim();
  }

  function firstReleaseYear(rel) {
    const events = rel["release-events"] || [];
    const raw =
      (events[0] && events[0].date) ||
      rel.date ||
      (rel["release-group"] && rel["release-group"]["first-release-date"]) ||
      "";
    const n = parseInt(String(raw).slice(0, 4), 10);
    return n > 0 && isFinite(n) ? n : null;
  }

  /* Flatten media[].tracks[].  Storage (vinyl_records.tracks_json) keeps
     `length` in ms — the same convention seed-vinyl.js and the Discogs import
     use (publicVinylRow aliases length → length_ms for the frontend). */
  function flattenTracks(rel, forImport) {
    const tracks = [];
    for (const media of rel.media || []) {
      for (const t of media.tracks || []) {
        if (!t || !t.title) continue;
        const lengthMs =
          t.length != null
            ? Number(t.length)
            : t.recording && t.recording.length != null
            ? Number(t.recording.length)
            : null;
        const track = {
          position: t.position != null ? String(t.position) : null,
          title: String(t.title),
        };
        track[forImport ? "length" : "length_ms"] =
          lengthMs && isFinite(lengthMs) ? lengthMs : null;
        tracks.push(track);
      }
    }
    return tracks;
  }

  /* Compact search result → the item shape search cards render. */
  function normalizeSearchResult(r) {
    if (!r || !r.id || !r.title) return null;
    const cca = r["cover-art-archive"] || {};
    return {
      source: "musicbrainz",
      id: r.id,
      mbid: r.id,
      title: String(r.title).trim(),
      artist: artistCreditName(r),
      year: firstReleaseYear(r),
      country: r.country || null,
      label: null,
      catalog_number: null,
      format: null,
      has_cover: cca.front === true,
    };
  }

  /* /release/{mbid} → normalized full detail (mirrors discogs.detail's keys
     where they overlap: title/artist/year/label/catalog_number/formats/
     tracks[… length_ms]/cover_* + source-specific id links). */
  function normalizeReleaseDetail(rel) {
    const labels = (rel.labels || [])
      .map((l) => ({
        name: String((l.label && l.label.name) || "").trim(),
        catno: l["catalog-number"] || null,
      }))
      .filter((l) => l.name);
    const formats = [...new Set((rel.media || []).map((m) => m.format).filter(Boolean))].join(
      " · "
    );
    const events = rel["release-events"] || [];
    const released = (events[0] && events[0].date) || rel.date || null;
    const cca = rel["cover-art-archive"] || {};
    return {
      source: "musicbrainz",
      id: rel.id,
      mbid: rel.id,
      discogs_id: null,
      title: String(rel.title || "").trim(),
      artist: artistCreditName(rel),
      year: firstReleaseYear(rel),
      released,
      country: rel.country || null,
      labels,
      label: labels.length ? labels[0].name : null,
      catalog_number: labels.length ? labels[0].catno : null,
      formats: formats || null,
      genres: [],
      styles: [],
      tracks: flattenTracks(rel, false),
      cover_image: null,
      cover_available: cca.front === true,
      release_group_id: releaseGroupIdOf(rel),
      discogs_url: null,
      musicbrainz_url: `https://musicbrainz.org/release/${rel.id}`,
    };
  }

  /* /release/{mbid} → normalized import entry for vinyl_records. */
  function buildImportEntry(rel) {
    const title = String(rel.title || "").trim();
    if (!title) throw new Error("MusicBrainz 条目缺少标题");
    const labelInfo = (rel.labels || [])[0] || {};
    const events = rel["release-events"] || [];
    const date =
      (events[0] && events[0].date) ||
      rel.date ||
      (rel["release-group"] && rel["release-group"]["first-release-date"]) ||
      String(rel.year || "");
    return {
      mbid: rel.id,
      title,
      artist: artistCreditName(rel),
      release_date: date || null,
      country: rel.country || null,
      label: (labelInfo.label && labelInfo.label.name) || null,
      catalog_number: labelInfo["catalog-number"] || null,
      tracks: flattenTracks(rel, true),
      source: "musicbrainz",
      discogs_id: null,
      release_group_id: releaseGroupIdOf(rel),
    };
  }

  /* ── Public API ─────────────────────────────────────────────────────── */

  /* GET /ws/2/release?query=… → normalized candidate list. */
  async function search(q) {
    const data = await mbGet("/release", {
      query: escapeQuery(q),
      limit: 8,
    });
    return (data.releases || []).map(normalizeSearchResult).filter(Boolean);
  }

  /* Live release detail (used by /api/vinyl/lookup). */
  async function detail(mbid) {
    return normalizeReleaseDetail(await getRelease(mbid));
  }

  /* Cover bytes by MBID.  Tries the release's own Cover Art Archive front
     first (no MusicBrainz call needed on the common path); when the release
     carries no art it learns the release-group id and tries the group's front
     (several archive records only have art on the group — Abbey Road, Legend).
     Returns { buffer } or null when no front art exists anywhere. */
  async function coverImageBytes(mbid) {
    try {
      const direct = await fetchFirstCover([`${CAA_API}/release/${mbid}/front-500`]);
      return { buffer: direct };
    } catch (e) {
      /* release has no art of its own → fall through to the release-group */
    }
    let rel;
    try {
      rel = await getRelease(mbid);
    } catch (e) {
      throw e;
    }
    const rgId = releaseGroupIdOf(rel);
    if (!rgId || !hasArtworkCandidates(rel)) return null;
    try {
      const buf = await fetchFirstCover([`${CAA_API}/release-group/${rgId}/front-500`]);
      return { buffer: buf };
    } catch (e) {
      return null;
    }
  }

  /* Full import pipeline for one MusicBrainz release: fetch → normalize →
     cover download (release front, then release-group front) → JPEG sanity →
     hashes.  Returns { entry, cover: { buffer }, hashes }. */
  async function importRelease(mbid) {
    const rel = await getRelease(mbid);
    const entry = buildImportEntry(rel);
    const urls = [`${CAA_API}/release/${mbid}/front-500`];
    if (entry.release_group_id) {
      urls.push(`${CAA_API}/release-group/${entry.release_group_id}/front-500`);
    }
    const buf = await fetchFirstCover(urls);
    if (!isJpeg(buf)) {
      throw new Error("封面图不是有效 JPEG，无法导入");
    }
    return { entry, cover: { buffer: buf }, hashes: vinylHash.computeHashesFromBuffer(buf) };
  }

  return { search, detail, getRelease, importRelease, coverImageBytes, isMbUuid };
};

