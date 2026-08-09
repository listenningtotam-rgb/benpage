#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────
 * migrate.js — apply pending schema migrations to an EXISTING
 * database, in place.
 *
 * This is the ONLY way a running server's database file gets its
 * schema updated. It never deletes or rebuilds the DB file — every
 * migration is ADDITIVE (CREATE TABLE IF NOT EXISTS / ALTER TABLE
 * ADD COLUMN), so existing rows and data are preserved.
 *
 * Usage:
 *   npm run migrate           apply pending migrations in place
 *   npm run migrate:dry       preview what would run (no changes)
 *
 * Typical server flow after a code update:
 *   cd /path/to/deploy
 *   git pull
 *   npm install               (if deps changed)
 *   npm run migrate           ← schema update on the live DB
 *   systemctl restart benpage
 * ───────────────────────────────────────────────────────────── */
"use strict";

const path = require("path");
const fs = require("fs");

const Database = require("better-sqlite3");
const schema = require("./db/schema");

const DB_PATH = path.join(__dirname, "data", "benpage.db");
const DRY_RUN = process.argv.includes("--dry") || process.env.NODE_ENV === "dry";

/* Only one process may migrate at a time (server could be running). */
if (fs.existsSync(DB_PATH)) {
  try {
    const lock = fs.openSync(DB_PATH + ".migrate.lock", "wx");
    fs.closeSync(lock);
  } catch (e) {
    console.error(
      `[migrate] Lock file ${DB_PATH}.migrate.lock exists — another migration ` +
      "may be running. Remove it if that is not the case."
    );
    process.exit(1);
  }
}

console.log(`[migrate] Database : ${DB_PATH}`);
console.log(`[migrate] Mode     : ${DRY_RUN ? "DRY RUN (no changes)" : "apply"}`);

if (!fs.existsSync(DB_PATH)) {
  console.error("[migrate] No database file found yet. Start the server once to create it.");
  cleanup();
  process.exit(1);
}

/* ── safety backup (cheap for SQLite, gitignored later) ── */
const backupPath = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (!DRY_RUN) {
  try {
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`[migrate] Backup    : ${backupPath}`);
  } catch (e) {
    console.error("[migrate] Failed to create backup:", e.message);
    cleanup();
    process.exit(1);
  }
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const status = schema.check(db);
console.log(`[migrate] Current schema version : ${status.currentVersion}`);
console.log(`[migrate] Latest schema version  : ${schema.LATEST_VERSION}`);

if (status.pending.length === 0) {
  console.log("[migrate] Database is already up to date — nothing to do.");
  console.log("[migrate] Schema and data are untouched.");
  db.close();
  cleanup();
  process.exit(0);
}

console.log(`[migrate] Pending migration(s):`);
for (const m of status.pending) console.log(`  - ${m.file}`);

if (DRY_RUN) {
  console.log("\n[migrate] DRY RUN — no changes were made.");
  db.close();
  cleanup();
  process.exit(0);
}

/* Newly created schema_migrations bookkeeping for a legacy DB
 * (baseline) is done automatically by prepareForMigration(). */
schema.prepareForMigration(db);
const applied = schema.applyPending(db);

console.log(`\n[migrate] Applied ${applied.length} migration(s):`);
for (const m of applied) console.log(`  + ${m.file}`);

console.log("\n[migrate] Done. Schema updated in place; all existing data preserved.");
console.log("[migrate] Restart the server if it was running.");

db.close();
cleanup();

function cleanup() {
  try {
    fs.unlinkSync(DB_PATH + ".migrate.lock");
  } catch (_) {
    /* noop */
  }
}