/* ── SQLite Database Layer (better-sqlite3) ────────────── */
const path = require("path");
const fs = require("fs");

/* Fail-fast guard: better-sqlite3 is a NATIVE addon.  If the Node
 * runtime is older than the version it was built for, requiring it
 * crashes the process with SIGSEGV (status=11 / core-dump) BEFORE
 * any JS can run or be caught.  Check the version first so we can
 * print a clear message instead of a core dump. */
function assertNodeVersion() {
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  const required = 22; // better-sqlite3 v13 supports node >= 22
  if (nodeMajor < required) {
    console.error(
      "\n==============================================================\n" +
      `  Node.js v${process.versions.node} is TOO OLD for the installed\n` +
      "  better-sqlite3 native addon.\n" +
      "\n" +
      "  The server would crash with SIGSEGV (maybe a core dump).\n" +
      "  This is the exact crash you get when starting via systemd:\n" +
      "    Main process exited, code=dumped, status=11/SEGV\n" +
      "\n" +
      "  FIX:  Install Node v22 or newer, then reinstall deps:\n" +
      `    sudo apt-get install -y nodejs  # must be >= v${required}\n` +
      "    rm -rf node_modules package-lock.json && npm install\n" +
      "  Or use NodeSource LTS v22:\n" +
      "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n" +
      "    sudo apt-get install -y nodejs\n" +
      "==============================================================\n"
    );
    process.exit(1);
  }
}
assertNodeVersion();

const Database = require("better-sqlite3");
const schema = require("./db/schema");

const DB_PATH = path.join(__dirname, "data", "benpage.db");

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* ── Schema ──────────────────────────────────────────────
 * The schema is NOT defined here anymore. It lives in
 * db/migrations/NNN_*.sql and is applied by:
 *   - db.js       → automatically, but ONLY for a brand-new database
 *   - migrate.js  → explicitly on EXISTING databases (e.g. the server)
 *
 * If an existing database has pending migrations the server REFUSES to
 * start: run `npm run migrate` inside the deployment directory (the
 * server) first. This guarantees a schema update never silently replaces
 * or drops the live data file. */
const schemaStatus = schema.check(db);

if (schemaStatus.pending.length > 0) {
  if (schemaStatus.fresh) {
    // Brand-new install → safe to create the full schema now.
    schema.prepareForMigration(db);
    schema.applyPending(db);
    console.log(`[db] Created schema (migrations up to version ${schema.LATEST_VERSION}).`);
  } else {
    // Existing database needs a schema update → do NOT touch it here.
    // Close cleanly and tell the operator to run the migration script.
    db.close();
    console.error(
      "\n==============================================================\n" +
      `  The database at ${DB_PATH} is at schema version ` +
      `${schemaStatus.currentVersion}, but this code needs version ` +
      `${schema.LATEST_VERSION}.\n` +
      "\n" +
      `  Pending migration(s):\n` +
      schemaStatus.pending.map((m) => `    ${m.file}`).join("\n") +
      "\n" +
      "\n" +
      "  Schema updates are applied explicitly on the server — the DB\n" +
      "  file is NEVER overwritten. Run, inside the deployment dir:\n" +
      "\n" +
      "    npm run migrate\n" +
      "\n" +
      "  then start the server again.\n" +
      "==============================================================\n"
    );
    process.exit(1);
  }
} else if (!schemaStatus.fresh) {
  // Existing database, already at the latest schema. Only bookkeeping:
  // record the baseline in schema_migrations so future `npm run migrate`
  // runs are clean. No data or schema is modified.
  schema.prepareForMigration(db);
}

/* ── Seed default admin (random password, known default rotated) ── */
const ADMIN_USERNAME = "admin";
const KNOWN_DEFAULT_PASSWORD = "admin123"; // old hardcoded default
// Gitignored (data/), mode 0600 — where the generated password is written.
const ADMIN_PASSWORD_FILE = path.join(path.dirname(DB_PATH), "admin-password.txt");

function writeAdminPasswordFile(pw) {
  try {
    fs.writeFileSync(
      ADMIN_PASSWORD_FILE,
      `BEN 言 admin credentials (generated ${new Date().toISOString()})\n` +
      `--------------------------------------------------------\n` +
      `URL     : /admin.html\n` +
      `Username: ${ADMIN_USERNAME}\n` +
      `Password: ${pw}\n` +
      `\nYou will be asked to set a new password on your first login.\n`,
      { mode: 0o600 }
    );
  } catch (e) {
    console.warn("[db] Could not write admin password file:", e.message);
  }
}

function randomPassword() {
  return crypto.randomBytes(18).toString("base64url"); // ~24 chars, letters + digits
}

function ensureAdmin() {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(ADMIN_USERNAME);

  // New install — create the admin with a random, non-guessable password.
  if (!row) {
    const pw = randomPassword();
    db.prepare(
      "INSERT INTO users (username, pass_hash, must_change_password) VALUES (?, ?, 1)"
    ).run(ADMIN_USERNAME, hashPassword(pw));
    writeAdminPasswordFile(pw);
    console.log(`[db] Created default admin user '${ADMIN_USERNAME}'.`);
    console.log(`[db] Initial password saved to ${ADMIN_PASSWORD_FILE} (data/ is gitignored).`);
    console.log(`[db] Log in at /admin.html and change it — it MUST be changed on first login.`);
    return;
  }

  // Existing install still on the old known default (admin123) → rotate
  // it to a random password so the known credential stops working.
  if (verifyPassword(KNOWN_DEFAULT_PASSWORD, row.pass_hash)) {
    const pw = randomPassword();
    db.prepare(
      "UPDATE users SET pass_hash = ?, must_change_password = 1 WHERE id = ?"
    ).run(hashPassword(pw), row.id);
    writeAdminPasswordFile(pw);
    console.log(`[db] Detected the old default admin password — it was ROTATED to a random one.`);
    console.log(`[db] New password saved to ${ADMIN_PASSWORD_FILE}. Change it on first login.`);
  }
}

/* ── Password hashing (PBKDF2, no extra deps) ──────────── */
const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

/* ── Auth ──────────────────────────────────────────────── */
function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function authUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.pass_hash)) return null;
  return { id: user.id, username: user.username, must_change_password: !!user.must_change_password };
}

function getUserAuth(id) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return null;
  return { id: user.id, username: user.username, must_change_password: !!user.must_change_password };
}

function verifyUserPassword(id, password) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return false;
  return verifyPassword(password, user.pass_hash);
}

function changePassword(id, newPassword) {
  db.prepare("UPDATE users SET pass_hash = ?, must_change_password = 0 WHERE id = ?").run(
    hashPassword(newPassword),
    id
  );
}

/* ── Music ─────────────────────────────────────────────── */
function listMusic() {
  return db
    .prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM recording_commits c WHERE c.repo_id = m.id) AS commit_count
         FROM music m
        ORDER BY m.sort_order ASC, m.id DESC`
    )
    .all();
}

function getMusic(id) {
  return db.prepare("SELECT * FROM music WHERE id = ?").get(id);
}

function createMusic({ title, url, sort_order }) {
  const order = Number.isInteger(sort_order) ? sort_order : 0;
  const info = db
    .prepare("INSERT INTO music (title, url, sort_order) VALUES (?, ?, ?)")
    .run(title, url, order);
  return getMusic(info.lastInsertRowid);
}

function updateMusic(id, { title, url, sort_order }) {
  db.prepare("UPDATE music SET title = ?, url = ?, sort_order = ? WHERE id = ?").run(
    title,
    url,
    Number.isInteger(sort_order) ? sort_order : 0,
    id
  );
  return getMusic(id);
}

function deleteMusic(id) {
  // Remove its recording commits too (additive-safe: table exists post-005).
  db.prepare("DELETE FROM recording_commits WHERE repo_id = ?").run(id);
  db.prepare("DELETE FROM music WHERE id = ?").run(id);
}

/* ── Recording commits (recording hub) ─────────────────── */
/* Git-like layer on top of music: each music row is a "repo" (a recording
   project) and every take is a commit. A commit stores the sound file,
   where the take sits inside the parent's playback timeline (start/end in
   seconds), and whether the take is standalone ('single') or layered on
   the parent ('overlay'). */

function listRecordingRepos() {
  return db
    .prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM recording_commits c WHERE c.repo_id = m.id) AS commit_count,
              (SELECT c.id         FROM recording_commits c WHERE c.repo_id = m.id ORDER BY c.id DESC LIMIT 1) AS head_commit_id,
              (SELECT c.message    FROM recording_commits c WHERE c.repo_id = m.id ORDER BY c.id DESC LIMIT 1) AS head_message,
              (SELECT c.url        FROM recording_commits c WHERE c.repo_id = m.id ORDER BY c.id DESC LIMIT 1) AS head_url,
              (SELECT c.created_at FROM recording_commits c WHERE c.repo_id = m.id ORDER BY c.id DESC LIMIT 1) AS head_created_at
         FROM music m
        ORDER BY m.sort_order ASC, m.id DESC`
    )
    .all();
}

function listRecordingCommits(repoId) {
  return db
    .prepare(
      `SELECT c.*,
              p.message AS parent_message,
              p.url     AS parent_url
         FROM recording_commits c
         LEFT JOIN recording_commits p ON p.id = c.parent_id
        WHERE c.repo_id = ?
        ORDER BY c.id ASC`
    )
    .all(repoId);
}

function getRecordingCommit(id) {
  return db.prepare("SELECT * FROM recording_commits WHERE id = ?").get(id) || null;
}

function clampCommitVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(3, Math.max(0, n));
}

/* Count-in pre-roll (seconds) between the backing chain start and the take
   blob's zero point. Only the first few seconds are ever meaningful — the
   browser's DSP converges that quickly — so clamp rather than trust the
   client. 0 = no pre-roll (every pre-existing commit). */
function clampCommitLead(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(5, n);
}

/* Contributor name stored on the commit: trimmed, single-spaced, ≤ 60 chars.
   Blank/absent falls back to the site admin — the only account today. */
function cleanContributor(v) {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  return s || ADMIN_USERNAME;
}

function createRecordingCommit({ repo_id, parent_id, message, url, start_time, end_time, mode, volume, lead, contributor, version }) {
  const info = db
    .prepare(
      `INSERT INTO recording_commits (repo_id, parent_id, message, url, start_time, end_time, mode, volume, lead, contributor, "version")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      repo_id,
      parent_id || null,
      message,
      url,
      Number.isFinite(start_time) && start_time >= 0 ? start_time : 0,
      Number.isFinite(end_time) && end_time > 0 ? end_time : null,
      mode === "overlay" ? "overlay" : "single",
      clampCommitVolume(volume),
      clampCommitLead(lead),
      cleanContributor(contributor),
      Number.isInteger(version) && version > 0 ? version : null
    );
  return getRecordingCommit(info.lastInsertRowid);
}

/* Tag a commit as the repo's next version (MAX(version)+1). Only the owner
   tags, and a commit can only be tagged once. Returns the updated commit, or
   null when the id doesn't exist. The transaction makes the MAX+1 read and
   the UPDATE atomic, so two rapid taps can never assign the same number. */
function tagRecordingCommit(id) {
  return db.transaction(() => {
    const commit = getRecordingCommit(id);
    if (!commit) return null;
    if (commit.version != null) return commit; // already tagged → no-op
    const next =
      db
        .prepare('SELECT COALESCE(MAX("version"), 0) + 1 AS next FROM recording_commits WHERE repo_id = ?')
        .get(commit.repo_id).next;
    db.prepare('UPDATE recording_commits SET "version" = ? WHERE id = ?').run(next, id);
    return getRecordingCommit(id);
  })();
}

/* The commit that is CURRENTLY the recording's public version: the highest
   version number in the repo (server-assigned, monotonically increasing).
   NULL when nothing is tagged (impossible in practice — every repo's root
   commit is tagged v1.0 at creation / migration time). */
function getLatestTaggedCommit(repoId) {
  return (
    db
      .prepare('SELECT * FROM recording_commits WHERE repo_id = ? AND "version" IS NOT NULL ORDER BY "version" DESC, id DESC LIMIT 1')
      .get(repoId) || null
  );
}

/* Ordered root → commit for one commit (server-side twin of the client's
   buildChain in public/music.js): the chain its mix is rendered from. */
function getCommitChainFrom(commit) {
  const chain = [];
  let cur = commit;
  let guard = 0;
  while (cur && guard++ < 1000) {
    chain.unshift(cur);
    cur = cur.parent_id != null ? getRecordingCommit(cur.parent_id) : null;
  }
  return chain;
}

function updateRecordingCommitVolume(id, volume) {
  db.prepare("UPDATE recording_commits SET volume = ? WHERE id = ?").run(clampCommitVolume(volume), id);
  return getRecordingCommit(id);
}

function updateRecordingCommitUrl(id, url) {
  db.prepare("UPDATE recording_commits SET url = ? WHERE id = ?").run(url, id);
  return getRecordingCommit(id);
}

function deleteRecordingCommit(id) {
  // Orphan any children so the chain still plays: same behaviour as the
  // FK's ON DELETE SET NULL, but explicit so it works even without
  // PRAGMA foreign_keys enabled.
  db.prepare("UPDATE recording_commits SET parent_id = NULL WHERE parent_id = ?").run(id);
  db.prepare("DELETE FROM recording_commits WHERE id = ?").run(id);
}

/* True when any row still points at this audio URL — either another commit
   (any repo) or the music row itself (the repo's initial commit shares its
   URL with music.url). The caller deletes the file only when this is false. */
function isRecordingUrlReferenced(url) {
  if (!url) return false;
  if (db.prepare("SELECT 1 FROM recording_commits WHERE url = ? LIMIT 1").get(url)) return true;
  if (db.prepare("SELECT 1 FROM music WHERE url = ? LIMIT 1").get(url)) return true;
  return false;
}

function deleteRecordingCommits(repoId) {
  db.prepare("DELETE FROM recording_commits WHERE repo_id = ?").run(repoId);
}

/* ── Blog ──────────────────────────────────────────────── */
function listBlogPosts() {
  return db.prepare("SELECT * FROM blog_posts ORDER BY date DESC, id DESC").all();
}

function getBlogPost(id) {
  return db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(id);
}

function createBlogPost({ title, tag, date, cover, blocks }) {
  const info = db
    .prepare(
      "INSERT INTO blog_posts (title, tag, date, cover, blocks) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      title,
      tag || "Note",
      date || new Date().toISOString().slice(0, 10),
      cover || null,
      JSON.stringify(blocks || [])
    );
  return getBlogPost(info.lastInsertRowid);
}

function updateBlogPost(id, { title, tag, date, cover, blocks }) {
  db.prepare(
    `UPDATE blog_posts
        SET title = ?, tag = ?, date = ?, cover = ?, blocks = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    title,
    tag || "Note",
    date || new Date().toISOString().slice(0, 10),
    cover || null,
    JSON.stringify(blocks || []),
    id
  );
  return getBlogPost(id);
}

function deleteBlogPost(id) {
  db.prepare("DELETE FROM blog_posts WHERE id = ?").run(id);
}

/* ── Play / read counters ─────────────────────────────── */
function incrementMusicPlay(id) {
  const info = db
    .prepare("UPDATE music SET play_count = play_count + 1 WHERE id = ?")
    .run(id);
  if (info.changes === 0) return null; // unknown id
  return getMusic(id);
}

function incrementBlogRead(id) {
  const info = db
    .prepare("UPDATE blog_posts SET read_count = read_count + 1 WHERE id = ?")
    .run(id);
  if (info.changes === 0) return null; // unknown id
  return getBlogPost(id);
}

/* ── Short links (share feature) ──────────────────────── */
/* Unambiguous alphabet: no 0/O/1/I/l so codes are easy to read and type. */
const SHARE_ALPHABET =
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SHARE_CODE_LEN = 7;

function getShareLink(code) {
  if (typeof code !== "string" || !code) return null;
  return db.prepare("SELECT * FROM share_links WHERE code = ?").get(code) || null;
}

function createShareLink(url) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < SHARE_CODE_LEN; i++) {
      code += SHARE_ALPHABET[crypto.randomInt(SHARE_ALPHABET.length)];
    }
    try {
      db.prepare("INSERT INTO share_links (code, url) VALUES (?, ?)").run(code, url);
      return getShareLink(code);
    } catch (e) {
      if (!String(e.message || "").includes("UNIQUE")) throw e;
      /* collision — try a different random code */
    }
  }
  throw new Error("Could not generate a unique short link code");
}

function incrementShareLinkHit(code) {
  db.prepare("UPDATE share_links SET hits = hits + 1 WHERE code = ?").run(code);
}

/* ── Init ──────────────────────────────────────────────── */
ensureAdmin();

module.exports = {
  db,
  authUser,
  getUserAuth,
  verifyUserPassword,
  changePassword,
  listMusic,
  getMusic,
  createMusic,
  updateMusic,
  deleteMusic,
  listRecordingRepos,
  listRecordingCommits,
  getRecordingCommit,
  createRecordingCommit,
  updateRecordingCommitVolume,
  updateRecordingCommitUrl,
  deleteRecordingCommit,
  tagRecordingCommit,
  getLatestTaggedCommit,
  getCommitChainFrom,
  isRecordingUrlReferenced,
  deleteRecordingCommits,
  listBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
  incrementMusicPlay,
  incrementBlogRead,
  createShareLink,
  getShareLink,
  incrementShareLinkHit,
};