"use strict";
/* ─────────────────────────────────────────────────────────────
 * Shared schema definition + migration runner.
 *
 * The schema lives ONLY in db/migrations/NNN_*.sql — it must
 * never be hard-coded in db.js or anywhere else.
 *
 * Rules for migrations (IMPORTANT):
 *   - ADDITIVE ONLY. New migrations may CREATE TABLE IF NOT EXISTS /
 *     ALTER TABLE ADD COLUMN (with a constant DEFAULT) / CREATE INDEX.
 *   - NEVER drop a table, drop a column, or alter existing columns —
 *     that loses data and breaks older DBs.
 *   - Each migration is a single file, runs in its own transaction.
 *   - Never edit an already-released migration; create a new one with a
 *     higher number.
 *
 * This module is used by:
 *   - db.js      → bootstraps a brand-new DB (fresh installs)
 *   - migrate.js → applies pending migrations on an existing DB (server)
 *   - merge-db.js→ builds the merged DB at the latest schema
 * ───────────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const TRACKING_TABLE = "schema_migrations";
const APP_TABLES = ["users", "music", "blog_posts"];

/* ── migration list (sorted, stable) ───────────────────── */
function loadMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((file) => {
      const version = parseInt(file.split("_")[0], 10);
      return {
        version,
        file,
        sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"),
      };
    });
}

const ALL_MIGRATIONS = loadMigrations();

const LATEST_VERSION = ALL_MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0
);

/* ── low-level helpers ─────────────────────────────────── */
function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

function appliedVersions(db) {
  return db
    .prepare(`SELECT version FROM ${TRACKING_TABLE} ORDER BY version ASC`)
    .all()
    .map((r) => r.version);
}

function markApplied(db, version) {
  db.prepare(
    `INSERT INTO ${TRACKING_TABLE} (version, applied_at) VALUES (?, datetime('now'))`
  ).run(version);
}

function ensureTrackingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** True when the DB has none of the application tables (brand new). */
function isFresh(db) {
  return !APP_TABLES.some((t) => tableExists(db, t));
}

/**
 * Baseline inference for databases that were created BEFORE schema
 * versioning existed (i.e. they have app tables but no schema_migrations
 * table). We inspect the live schema to figure out the highest migration
 * that was already applied, so already-applied changes are never
 * re-applied (re-running an ALTER TABLE ADD COLUMN would fail).
 *
 * Keep this table in sync as new migrations are added, so legacy DBs can
 * be baselined at the correct version.
 */
function detectBaselineVersion(db) {
  let version = 0;
  // 001_init.sql → users / music / blog_posts
  if (APP_TABLES.some((t) => tableExists(db, t))) version = 1;
  // 002_add_must_change_password.sql → users.must_change_password
  if (tableExists(db, "users")) {
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (cols.includes("must_change_password")) version = 2;
  }
  // 003_add_play_read_counts.sql → music.play_count / blog_posts.read_count
  if (tableExists(db, "music")) {
    const cols = db.prepare("PRAGMA table_info(music)").all().map((c) => c.name);
    if (cols.includes("play_count")) version = 3;
  }
  return version;
}

/* ── public API ────────────────────────────────────────── */
/**
 * Read-only status check. Never writes to the DB.
 * Returns { fresh, currentVersion, pending }:
 *   - fresh          : no application tables (brand-new DB)
 *   - currentVersion : highest applied migration version (int), or the
 *                      detected baseline for legacy DBs
 *   - pending        : migrations that still need to run, in order
 */
function check(db) {
  const fresh = isFresh(db);

  if (!tableExists(db, TRACKING_TABLE)) {
    // Never been tracked: either brand new (apply everything) or a legacy
    // DB (baseline it, then apply only what's above the baseline).
    const baseline = fresh ? 0 : detectBaselineVersion(db);
    return {
      fresh,
      currentVersion: baseline,
      pending: ALL_MIGRATIONS.filter((m) => m.version > baseline),
    };
  }

  const applied = new Set(appliedVersions(db));
  const currentVersion = applied.size ? Math.max(...applied) : 0;
  const pending = ALL_MIGRATIONS.filter((m) => !applied.has(m.version));
  return { fresh, currentVersion, pending };
}

/**
 * One-time preparation before applying migrations:
 *   1. creates the schema_migrations tracking table
 *   2. baselines a legacy DB (records already-applied migrations)
 * Idempotent — safe to call repeatedly.
 */
function prepareForMigration(db) {
  ensureTrackingTable(db);
  if (appliedVersions(db).length) return; // already tracked
  if (isFresh(db)) return; // brand new → nothing to baseline
  const baseline = detectBaselineVersion(db);
  if (baseline <= 0) return;
  for (const m of ALL_MIGRATIONS) {
    if (m.version > baseline) break;
    const wrap = db.transaction(() => markApplied(db, m.version));
    wrap();
  }
}

/**
 * Applies every migration that is not yet recorded, each in its own
 * transaction. Idempotent — safe to call repeatedly. Returns the list of
 * migrations that were actually applied.
 */
function applyPending(db) {
  const applied = [];
  for (const m of ALL_MIGRATIONS) {
    const already = db
      .prepare(`SELECT 1 AS x FROM ${TRACKING_TABLE} WHERE version = ?`)
      .get(m.version);
    if (already) continue;
    const wrap = db.transaction(() => {
      db.exec(m.sql);
      markApplied(db, m.version);
    });
    wrap();
    applied.push(m);
  }
  return applied;
}

module.exports = {
  MIGRATIONS_DIR,
  ALL_MIGRATIONS,
  LATEST_VERSION,
  isFresh,
  check,
  prepareForMigration,
  applyPending,
};