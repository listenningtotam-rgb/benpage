#!/usr/bin/env node
"use strict";
/*
 * 黑胶档案 (Vinyl Archive) — seed script
 * ----------------------------------------
 *  1. Loads the normalized seed list from data/vinyl-seed.json.  When that
 *     file is missing it rebuilds it from the MusicBrainz release dump at
 *     /tmp/mb_releases.json (top-level keys are album slugs, see recon).
 *  2. Downloads each album's cover art into public/vinyl-art/{slug}.jpg
 *     (skips files that already exist).
 *  3. Decodes each cover with jpeg-js and computes a 64-bit aHash + dHash
 *     (the exact same algorithm public/vinyl.js uses on the client, so a
 *     photographed cover hashes close to its seed entry).
 *  4. Upserts everything into the vinyl_records table.
 *
 * Usage:  node seed-vinyl.js
 */
const fs = require("fs");
const path = require("path");
const jpeg = require("jpeg-js");
const db = require("./db");

const ROOT = __dirname;
const MB_DUMP = "/tmp/mb_releases.json";
const SEED_JSON = path.join(ROOT, "data", "vinyl-seed.json");
const ART_DIR = path.join(ROOT, "public", "vinyl-art");

/* Abbey Road + Legend: the release-MBID cover-art endpoint serves no image
   for these two releases, but the release-group endpoint does (verified). */
const RG_COVERS = {
  "abbey-road":
    "https://coverartarchive.org/release-group/9162580e-5df4-32de-80cc-f45a8d8a9b1d/front-500",
  legend:
    "https://coverartarchive.org/release-group/1a4c52cd-483a-347c-93f9-4d512767c7ba/front-500",
};

/* ── Seed building (MB release dump → normalized entries) ──────────── */
function buildSeedFromMb(dump) {
  const entries = [];
  for (const [slug, rel] of Object.entries(dump)) {
    const artist = (rel["artist-credit"] || [])
      .map((c) => String(c.name || "") + String(c.joinphrase || ""))
      .join("")
      .trim();
    const labelInfo = (rel["label-info"] || [])[0] || {};
    const tracks = [];
    for (const media of rel.media || []) {
      for (const t of media.tracks || []) {
        tracks.push({
          position: t.position,
          title: t.title,
          length: t.length || null, // ms
        });
      }
    }
    entries.push({
      slug,
      mbid: rel.id,
      title: rel.title,
      artist,
      release_date: rel.date || null,
      country: rel.country || null,
      label: (labelInfo.label || {}).name || null,
      catalog_number: labelInfo["catalog-number"] || null,
      tracks,
      cover_url:
        RG_COVERS[slug] ||
        `https://coverartarchive.org/release/${rel.id}/front-500`,
    });
  }
  return entries;
}

function loadSeedEntries() {
  if (fs.existsSync(SEED_JSON)) {
    const raw = JSON.parse(fs.readFileSync(SEED_JSON, "utf8"));
    return Array.isArray(raw) ? raw : raw.records || [];
  }
  if (!fs.existsSync(MB_DUMP)) {
    throw new Error(
      `Neither ${SEED_JSON} nor ${MB_DUMP} exists — nothing to seed.`
    );
  }
  const dump = JSON.parse(fs.readFileSync(MB_DUMP, "utf8"));
  const entries = buildSeedFromMb(dump);
  fs.mkdirSync(path.dirname(SEED_JSON), { recursive: true });
  fs.writeFileSync(SEED_JSON, JSON.stringify(entries, null, 2) + "\n");
  console.log(`[seed] wrote normalized seed → ${SEED_JSON}`);
  return entries;
}

/* ── Cover art download ────────────────────────────────────────────── */
/* fetch() is tried first; on failure (e.g. a local HTTP proxy that
   undici does not honour) falls back to spawning curl -sL. */
function fetchToFile(url, outPath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const child = spawn("curl", ["-fsSL", "-o", outPath, url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(outPath) : reject(new Error(`curl exited ${code}: ${err.trim().slice(0, 200)}`))
    );
  });
}

async function ensureCover(entry) {
  const outPath = path.join(ART_DIR, `${entry.slug}.jpg`);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return `/vinyl-art/${entry.slug}.jpg`; // already downloaded
  }
  fs.mkdirSync(ART_DIR, { recursive: true });
  let buf = null;
  try {
    const res = await fetch(entry.cover_url, { redirect: "follow" });
    if (!res.ok) throw new Error(`cover HTTP ${res.status} for ${entry.slug}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    try {
      await fetchToFile(entry.cover_url, outPath);
      buf = fs.readFileSync(outPath);
    } catch (e2) {
      throw new Error(`cover download failed for ${entry.slug}: ${e.message} / ${e2.message}`);
    }
  }
  // Sanity check: must actually be a JPEG (FF D8).
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error(`cover for ${entry.slug} is not a JPEG`);
  }
  fs.writeFileSync(outPath, buf);
  return `/vinyl-art/${entry.slug}.jpg`;
}

/* ── Perceptual hashing (shared with public/vinyl.js) ─────────────── */
/* Box-averaged downscale to a grayscale luma grid (canvas-smoothing
   approximation).  ow×oh output, luma = 0.299R + 0.587G + 0.114B. */
function boxGray(rgba, sw, sh, ow, oh) {
  const out = new Float64Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const ys = Math.floor((oy * sh) / oh);
    const ye = Math.max(ys + 1, Math.floor(((oy + 1) * sh) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const xs = Math.floor((ox * sw) / ow);
      const xe = Math.max(xs + 1, Math.floor(((ox + 1) * sw) / ow));
      let sum = 0;
      let n = 0;
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          const i = (y * sw + x) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      out[oy * ow + ox] = sum / n;
    }
  }
  return out;
}

/* 64-bit bit-string → 16 hex chars (matches the client exactly). */
function hexFromBits(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function aHashHex(gray8) {
  let avg = 0;
  for (const v of gray8) avg += v;
  avg /= gray8.length;
  let bits = "";
  for (let i = 0; i < 64; i++) bits += gray8[i] >= avg ? "1" : "0";
  return hexFromBits(bits);
}

function dHashHex(gray9) {
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += gray9[y * 9 + x] >= gray9[y * 9 + x + 1] ? "1" : "0";
    }
  }
  return hexFromBits(bits);
}

function computeHashes(filePath) {
  const buf = fs.readFileSync(filePath);
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const gray8 = boxGray(img.data, img.width, img.height, 8, 8);
  const gray9 = boxGray(img.data, img.width, img.height, 9, 8);
  return { ahash: aHashHex(gray8), dhash: dHashHex(gray9) };
}


/* ── Main ─────────────────────────────────────────────────────────── */
async function main() {
  const entries = loadSeedEntries();
  console.log(`[seed] ${entries.length} album(s) to seed`);

  let changed = 0;
  for (const entry of entries) {
    const coverPath = await ensureCover(entry);
    const hashes = computeHashes(path.join(ROOT, "public", coverPath));
    const row = db.upsertVinylRecord({
      slug: entry.slug,
      mbid: entry.mbid,
      title: entry.title,
      artist: entry.artist,
      release_date: entry.release_date,
      country: entry.country,
      label: entry.label,
      catalog_number: entry.catalog_number,
      tracks: entry.tracks,
      cover_path: coverPath,
      ...hashes,
    });
    changed++;
    const tracks = (JSON.parse(row.tracks_json) || []).length;
    console.log(
      `  ✓ ${entry.slug.padEnd(24)} ${entry.title} — ${entry.artist} ` +
        `(${entry.release_date || "?"}) · ${tracks} tracks · ${coverPath}`
    );
  }
  console.log(`[seed] done — ${changed} record(s) upserted.`);
}

main().catch((e) => {
  console.error("[seed] FAILED:", e.message);
  process.exit(1);
});
