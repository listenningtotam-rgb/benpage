#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────
 * convert-recordings.js — one-time batch conversion of legacy
 * (non-WAV) recordings to 22050 Hz mono 16-bit PCM WAV, so the
 * whole recording library plays through decodeAudioData on every
 * browser (including iOS Safari) with NO runtime transcode path.
 *
 * Every /recordings/... audio URL referenced by the DB (music.url
 * + each recording_commits.url) whose file is NOT already .wav or
 * .mp3 (webm / m4a / aac / ogg / flac …) is decoded and re-encoded
 * into RECORDING_DIR/conv/<sha1(rel:size:mtime)>.wav — the same
 * location/scheme the old lazy runtime converter used, so files
 * converted before the switch are reused. DB rows are then pointed
 * at the WAV, and original files that no row references anymore
 * are deleted (unless --keep). MP3 files are never touched.
 *
 * Usage:
 *   npm run convert-recordings           convert + delete originals
 *   npm run convert-recordings -- --dry  preview only (no changes)
 *   node convert-recordings.js --keep    convert but keep originals
 *
 * Idempotent: rows already pointing at .wav/.mp3 are skipped; the
 * conv-file cache key includes size+mtime, so re-runs are no-ops.
 * ───────────────────────────────────────────────────────────── */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const db = require("./db");

const DRY_RUN = process.argv.includes("--dry") || process.env.NODE_ENV === "dry";
const KEEP_FILES = process.argv.includes("--keep");

const DB_PATH = path.join(__dirname, "data", "benpage.db");
const RECORDING_URL_PREFIX = "/recordings/";
const CONV_RATE = 22050; // matches the take WAVs; fine for voice

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
const RECORDING_DIR =
  process.env.RECORDING_DIR ||
  (isWritableDir("/home/www/static/recordings")
    ? "/home/www/static/recordings"
    : path.join(__dirname, "data", "recordings"));
const convDir = path.join(RECORDING_DIR, "conv");

let decodeModule = null;
async function loadDecoder() {
  // @audio/decode is ESM while this script is CommonJS — import lazily.
  if (!decodeModule) decodeModule = await import("@audio/decode");
  return decodeModule.default;
}

/* Downmix → resample → 16-bit PCM WAV (same output as the browser's
   encodeWav in public/music.js). Returns a Buffer of the complete file. */
function encodePcmWav(channelData, sampleRate, rate) {
  let mono = channelData[0];
  if (channelData.length > 1) {
    const n = Math.min(channelData[0].length, channelData[1].length);
    mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (channelData[0][i] + channelData[1][i]) / 2;
  }
  let src = mono;
  if (rate !== sampleRate) {
    const ratio = sampleRate / rate;
    const n = Math.max(1, Math.floor(mono.length / ratio));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio;
      const i0 = Math.floor(p);
      const i1 = Math.min(mono.length - 1, i0 + 1);
      const f = p - i0;
      out[i] = mono[i0] * (1 - f) + mono[i1] * f;
    }
    src = out;
  }
  const dataLen = src.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  return buf;
}

/* Cache key of a source recording — same scheme the old lazy runtime
   converter used, so a file converted before the switch is reused. */
function cacheKey(rel, stat) {
  return crypto
    .createHash("sha1")
    .update(rel + ":" + stat.size + ":" + stat.mtimeMs)
    .digest("hex")
    .slice(0, 20);
}

function isLocalRecordingUrl(url) {
  return typeof url === "string" && url.startsWith(RECORDING_URL_PREFIX);
}
function needsConversion(url) {
  const lower = url.toLowerCase();
  return !lower.endsWith(".wav") && !lower.endsWith(".mp3");
}

/* Decode rel → conv/<key>.wav (reusing an existing conv file when its key
   matches). Returns the public URL of the WAV. */
async function convertFile(rel) {
  const srcPath = path.join(RECORDING_DIR, rel);
  if (!srcPath.startsWith(path.resolve(RECORDING_DIR) + path.sep)) {
    throw new Error("path escapes RECORDING_DIR: " + rel);
  }
  const stat = await fs.promises.stat(srcPath); // throws when missing
  if (!stat.isFile()) throw new Error("not a regular file: " + rel);
  const key = cacheKey(rel, stat);
  const convPath = path.join(convDir, key + ".wav");
  const outUrl = RECORDING_URL_PREFIX + "conv/" + key + ".wav";
  try {
    await fs.promises.access(convPath);
    return outUrl; // already converted
  } catch (_) {
    /* fall through and convert */
  }
  if (DRY_RUN) return outUrl; // preview only: this is what we'd produce
  const raw = await fs.promises.readFile(srcPath);
  const decode = await loadDecoder();
  const { channelData, sampleRate } = await decode(raw);
  const wav = encodePcmWav(channelData, sampleRate, CONV_RATE);
  await fs.promises.mkdir(convDir, { recursive: true });
  const tmp = convPath + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  await fs.promises.writeFile(tmp, wav);
  await fs.promises.rename(tmp, convPath); // atomic — no half-written WAVs
  return outUrl;
}

async function main() {
  console.log(`[convert-recordings] DB            : ${DB_PATH}`);
  console.log(`[convert-recordings] RECORDING_DIR : ${RECORDING_DIR}`);
  console.log(
    `[convert-recordings] Mode          : ${
      DRY_RUN ? "DRY RUN (no changes)" : KEEP_FILES ? "apply (keep originals)" : "apply (delete unreferenced originals)"
    }`
  );
  console.log("");

  // Collect every /recordings/ URL the DB references.
  const rows = [];
  for (const m of db.listMusic()) {
    if (isLocalRecordingUrl(m.url)) rows.push({ table: "music", id: m.id, url: m.url });
  }
  for (const repo of db.listRecordingRepos()) {
    for (const c of db.listRecordingCommits(repo.id)) {
      if (isLocalRecordingUrl(c.url)) rows.push({ table: "commit", id: c.id, url: c.url });
    }
  }

  const todo = rows.filter((r) => needsConversion(r.url));
  if (!todo.length) {
    console.log("Nothing to convert — every recording is already WAV or MP3.");
    return;
  }
  console.log(`Found ${todo.length} DB row(s) pointing at a non-WAV/MP3 file:`);
  for (const r of todo) console.log(`  - ${r.table} #${r.id}  ${r.url}`);
  console.log("");

  // Safety: back up the DB before touching rows (cheap for SQLite).
  if (!DRY_RUN) {
    const backupPath = `${DB_PATH}.conv-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.copyFileSync(DB_PATH, backupPath);
      console.log(`[convert-recordings] Backup        : ${backupPath}`);
    } catch (e) {
      console.error("[convert-recordings] Failed to create DB backup:", e.message);
      process.exit(1);
    }
  }

  const changed = [];
  let failed = 0;
  for (const row of todo) {
    const rel = path.normalize(row.url.slice(RECORDING_URL_PREFIX.length));
    try {
      const outUrl = await convertFile(rel);
      changed.push({ table: row.table, id: row.id, url: row.url, rel, outUrl });
      console.log(`  ✓ ${row.table.padEnd(6)} #${row.id}  ${row.url}  →  ${outUrl}`);
    } catch (err) {
      failed++;
      console.warn(`  ✗ ${row.table.padEnd(6)} #${row.id}  ${row.url}  — ${err.message}`);
    }
  }

  if (DRY_RUN) {
    console.log("\n[convert-recordings] DRY RUN — no rows updated, nothing converted or deleted.");
    if (failed) console.log(`[convert-recordings] ${failed} file(s) failed to read/decode — fix those and re-run.`);
    return;
  }
  if (!changed.length) {
    console.log("\nNothing was converted — fix the failures above and re-run.");
    process.exit(1);
  }

  // Point every converted row at its WAV.
  for (const row of changed) {
    if (row.table === "music") {
      const cur = db.getMusic(row.id);
      db.updateMusic(row.id, { title: cur.title, url: row.outUrl, sort_order: cur.sort_order });
    } else {
      db.updateRecordingCommitUrl(row.id, row.outUrl);
    }
  }
  console.log(`\n[convert-recordings] Updated ${changed.length} DB row(s) to point at the WAV files.`);

  // Delete originals that no row references anymore.
  if (KEEP_FILES) {
    console.log("[convert-recordings] --keep: original files were left in place.");
    return;
  }
  const seen = new Set();
  let deleted = 0;
  for (const row of changed) {
    if (seen.has(row.rel)) continue; // the same file referenced by several rows
    seen.add(row.rel);
    if (db.isRecordingUrlReferenced(row.url)) continue; // some row still uses it
    const p = path.join(RECORDING_DIR, row.rel);
    if (!p.startsWith(path.resolve(RECORDING_DIR) + path.sep)) continue;
    try {
      await fs.promises.unlink(p);
      deleted++;
      console.log(`  removed ${row.url}`);
    } catch (err) {
      console.warn(`  ! could not delete ${row.url}: ${err.message}`);
    }
  }
  console.log(
    deleted
      ? `\n[convert-recordings] Deleted ${deleted} unreferenced original file(s).`
      : "\nNo unreferenced originals to delete."
  );

  console.log("\n[convert-recordings] Done. Restart the server if it was running.");
}

main().catch((err) => {
  console.error("[convert-recordings] FAILED:", err.message);
  process.exit(1);
});

