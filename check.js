#!/usr/bin/env node
"use strict";
/*
 * benpage preflight check
 * -------------------------
 * Diagnoses the "status=11/SEGV" / core-dump crash that can happen when
 * the server starts.  A SIGSEGV at startup with better-sqlite3 is a native
 * addon crash (ABI / glibc mismatch) and CANNOT be caught by JS try/catch,
 * so this script probes the native addon in a separate child process and
 * reports exactly what is wrong + how to fix it.
 *
 * Usage:  npm run check      (or:  node check.js)
 */
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ok = (s) => console.log(`${GREEN}ok  ${RESET}${s}`);
const warn = (s) => console.log(`${YELLOW}!   ${RESET}${s}`);
const fail = (s) => console.log(`${RED}x   ${RESET}${s}`);

function system(command) {
  try {
    return execFileSync("sh", ["-c", command], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/* ── 1. Environment ─────────────────────────────────────────────── */
console.log(`${BOLD}benpage preflight check${RESET}`);
console.log("──────────────────────────────────────────────");
console.log(`Node version : ${process.version}`);
console.log(`Node ABI     : ${process.versions.modules} (N-API v${process.versions.napi || "?"})`);
console.log(`Platform     : ${os.platform()} / ${os.arch()}`);
console.log(`Hostname     : ${os.hostname()}`);
console.log(`CWD          : ${process.cwd()}`);

let libc = "unknown";
try {
  const header = process.report.getReport().header || {};
  libc = header.glibcVersionRuntime ? "glibc " + header.glibcVersionRuntime : "musl";
} catch {
  /* no report available */
}
console.log(`C library    : ${libc}\n`);

/* ── 2. Node version vs required engines ────────────────────────── */
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
} catch (e) {
  fail("cannot read package.json (" + e.message + ")");
  process.exit(1);
}

const nodeMajor = parseInt(process.version.slice(1), 10);
const engineRange = (pkg.engines && pkg.engines.node) || "";
const m = />=?\s*(\d+)/.exec(engineRange);
if (m && nodeMajor < parseInt(m[1], 10)) {
  console.log(`${RED}${BOLD}✖ Node ${process.version} is TOO OLD — package.json requires ${engineRange}${RESET}`);
  console.log(`
  The server will crash with SIGSEGV (status=11/SEGV, core-dump) when
  starting via systemd, because the better-sqlite3 native addon cannot
  load on this Node version.

  Fix: install Node v${m[1]} or newer (recommended: Node LTS v22+):
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  Then reinstall dependencies:
    rm -rf node_modules package-lock.json && npm install
`);
  process.exit(1);
} else {
  ok(`Node ${process.version} satisfies engines ${engineRange || "(none)"}`);
}

/* ── 3. better-sqlite3 install state ────────────────────────────── */
const bsqliteDir = path.join(__dirname, "node_modules", "better-sqlite3");
const bsqlitePkgPath = path.join(bsqliteDir, "package.json");

if (!fs.existsSync(bsqlitePkgPath)) {
  fail("better-sqlite3 is NOT installed — run  npm install");
  process.exit(1);
}

const bsqlitePkg = JSON.parse(fs.readFileSync(bsqlitePkgPath, "utf8"));
console.log(`better-sqlite3 : v${bsqlitePkg.version} installed (required: ${pkg.dependencies["better-sqlite3"]})`);

const bsqliteRange = (bsqlitePkg.engines && bsqlitePkg.engines.node) || "";
const bm = />=?\s*(\d+)/.exec(bsqliteRange);
if (bm && nodeMajor < parseInt(bm[1], 10)) {
  fail(`${BOLD}better-sqlite3 v${bsqlitePkg.version} requires Node ${bsqliteRange}, you have ${process.version}${RESET}`);
  console.log("     Loading it on this Node will likely crash with SIGSEGV.\n");
} else {
  ok(`better-sqlite3 v${bsqlitePkg.version} supports Node ${process.version}`);
}

const prebuild = path.join(bsqliteDir, "prebuilds", `${os.platform()}-${os.arch()}.node`);
console.log(`prebuilt bin  : ${fs.existsSync(prebuild) ? path.basename(prebuild) + " (present)" : "(none — will need source build)"}`);

/* ── 4. Probe the native addon in a child process ───────────────── */
console.log("\n── probing better-sqlite3 (child process) ──");

const probeSrc = `
  const path = require("path");
  const Database = require(${JSON.stringify(bsqliteDir)});
  console.log("    better-sqlite3 loaded OK");
  const dbPath = path.join(${JSON.stringify(__dirname)}, "data", "benpage.db");
  require("fs").mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const row = db.prepare("SELECT sqlite_version() AS v").get();
  console.log("    bundled SQLite: " + row.v);
  db.close();
  console.log("    database opened OK (WAL)");
`;

let probeOk = false;
try {
  execFileSync(process.execPath, ["-e", probeSrc], {
    cwd: __dirname,
    stdio: "inherit",
    encoding: "utf8",
    timeout: 15000,
  });
  probeOk = true;
} catch (err) {
  const signal = err.signal || (err.status === null ? "SIGSEGV?" : null);
  const status = err.status;

  if (signal || (typeof status === "number" && status > 128)) {
    console.log(`\n${RED}${BOLD}✖ CRASH DETECTED — process terminated by signal: ${signal || "SIG" + (status - 128)}${RESET}`);
    console.log(`
This is a NATIVE ADDON crash (better-sqlite3). It kills Node before any
JavaScript can run, which is exactly the "status=11/SEGV / core-dump"
you see in systemd. The bundled prebuilt binary is incompatible with
this server. Fix it ON THE SERVER, in this directory:

  # Option A — rebuild the native addon from source on the server
  # (needs: gcc/g++/make + python3):
  npm rebuild better-sqlite3 --build-from-source

  # Option B — clean reinstall from scratch:
  rm -rf node_modules package-lock.json && npm install

  # Option C — install a compatible Node LTS (v22+ for better-sqlite3 v13):
  #   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  #   sudo apt-get install -y nodejs
  #   rm -rf node_modules && npm install
`);
  } else {
    /* Normal JS-level error, e.g. EACCES / SQLITE_CORRUPT */
    console.log(`\n${RED}✖ better-sqlite3 failed with a JS-level error:${RESET}`);
    console.log(err.stderr || err.message);
  }
}

if (!probeOk) {
  console.log(`${RED}${BOLD}Preflight FAILED — fix the issues above, then re-run:  npm run check${RESET}`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}${BOLD}All checks passed — start the server with:  npm start${RESET}`);
}