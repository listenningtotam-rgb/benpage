/* ── REC HUB (Apps) ──────────────────────────────────── */
/* Git-like recording studio — now an app under the Apps tab.
   Each recording_repos row is a "repo" (a recording project — a separate
   library from the Recordings `music` table); every take is a
   recording_commits commit:
     · message     → commit message
     · url         → sound file for the take
     · contributor → who made the take ("admin" by default — the only account)
     · start_time  → seconds into the parent's playback where the take starts
     · end_time    → seconds into the parent's playback where it ends
     · volume      → linear gain multiplier for this take when the chain plays
                      (1.0 = unchanged; used to balance a take vs the parent)
     · lead        → seconds between the backing start and the take blob's zero
                      point. Takes recorded from the song's start use lead = 0,
                      legacy takes used a 1.5 s count-in pre-roll, and mid-song
                      takes use the chosen “start point in the song”, so the mix
                      reads the blob from start_time − lead and the take stays
                      exactly where it was sung.
     · mode        → 'single' (plays alone) | 'overlay' (layered on parent)
   Visitors browse & listen. The owner (existing admin JWT in localStorage,
   same key as admin.js) can init a recording, check out a commit, record a
   take over its playback, preview it, and commit it.
   Rendered into #rec-hub-root inside the Apps tab's REC HUB panel. */

const hubRootEl = document.getElementById("rec-hub-root");

const TOKEN_KEY = "benpage_admin_token";      // same key as public/admin.js
const HUB_TOKEN_KEY = "benpage_hub_token";    // member invite-code session

// Audio upload cap (WAV takes, MP3/M4A backing tracks) — keep in sync with
// server.js MAX_AUDIO_UPLOAD_BYTES, public/admin.js MAX_AUDIO_UPLOAD_MB and
// nginx client_max_body_size (deploy/nginx-upload.conf). 100 MB ≈ 38 min of
// 22050 Hz mono 16-bit WAV (≈ 2.65 MB/min) — long enough for a full song.
const MAX_AUDIO_UPLOAD_MB = 100;
const MAX_AUDIO_UPLOAD_BYTES = MAX_AUDIO_UPLOAD_MB * 1024 * 1024;

const hub = {
  repos: [],
  commits: new Map(),     // repoId -> [commit...]
  expanded: null,         // repoId of the expanded commit history
  checkedOut: null,       // { repoId, commitId }
  playing: null,          // { repoId, commitId } of the commit currently sounding
  admin: false,           // true when the signed-in user is the site admin
  user: null,             // { id, username, nickname, email, is_admin, profile_complete, bands }
};

function getHubToken() {
  return localStorage.getItem(HUB_TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
}

/* Display name of the signed-in user (their profile nickname when set). */
function displayName(u) {
  if (!u) return "";
  return u.nickname || u.username || "";
}

/* Server audio files for banded recordings require the session JWT — the raw
   URL would otherwise be publicly fetchable. The native <audio> element can't
   send the Authorization header, so the token rides along as ?token=<JWT> for
   those files (harmless for public ones, ignored by the server). blob: URLs
   never take a query param. */
function audioUrl(url) {
  if (!url || url.indexOf("blob:") === 0 || url.indexOf("/recordings/") !== 0) return url;
  const token = getHubToken();
  if (!token) return url;
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
}

/* ── Helpers ───────────────────────────────────────────── */
/* scEscapeHTML is prefixed to avoid clashing with blog.js's escapeHTML */
function scEscapeHTML(str) {
  return String(str)
    .replace(/\u0026/g, "&amp;")
    .replace(/\u003C/g, "&lt;")
    .replace(/\u003E/g, "&gt;")
    .replace(/\u0022/g, "&quot;")
    .replace(/\u0027/g, "&#39;");
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* Deterministic, compact commit id — stable across reloads. */
function commitHash(id) {
  return "#" + String(Number(id).toString(36)).toUpperCase().padStart(6, "0");
}

function fmtStamp(s) {
  if (!s) return "";
  return String(s).replace("T", " ").slice(0, 16);
}

function fmtRange(c) {
  const start = Number(c.start_time) || 0;
  const end = Number(c.end_time);
  if (!isFinite(end) || end <= 0) return `${fmtTime(start)} → end`;
  return `${fmtTime(start)} – ${fmtTime(end)}`;
}

/* ── API / auth ────────────────────────────────────────── */
async function hubApi(path, options = {}) {
  const token = getHubToken();
  const headers = Object.assign({}, options.headers || {});
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshAuth() {
  hub.admin = false;
  hub.user = null;
  const token = getHubToken();
  if (!token) return;
  try {
    const data = await hubApi("/api/auth/me");
    hub.user = data.user;
    hub.admin = !!data.user.is_admin;
  } catch (_) {
    /* token expired/invalid → guest view (stored tokens stay for re-login) */
  }
}

async function loadHub() {
  try {
    const data = await hubApi("/api/recordings");
    hub.repos = data.repos || [];
    hub.commits = new Map(hub.repos.map((r) => [r.id, r.commits || []]));
  } catch (err) {
    if (hubRootEl) {
      hubRootEl.innerHTML = `<p class="empty-note">Failed to load recordings.</p>`;
    }
    return;
  }
  renderHub();
  // First login (invite code used for the first time): profile not complete
  // yet → show the setup form. The invite-bound band is already joined.
  if (hub.user && !hub.user.profile_complete) {
    showProfileSetup().catch((err) => {
      if (hubRootEl) {
        hubRootEl.innerHTML = `<p class="empty-note">⚠ ${scEscapeHTML(err.message)}</p>`;
      }
    });
  }
}

/* ── Rendering ─────────────────────────────────────────── */
function renderHub() {
  if (!hubRootEl) return;
  const loggedIn = !!hub.user;
  const profileDone = loggedIn && !!hub.user.profile_complete;
  const toolbar = `
    <div class="hub-toolbar">
      ${
        loggedIn
          ? `<div class="hub-admin">
               <span class="hub-admin-user">${hub.user.is_admin ? "●" : "👤"} ${scEscapeHTML(displayName(hub.user))}${hub.user.is_admin ? " · admin" : ""}</span>
               <button type="button" class="rc-btn rc-btn-ghost" id="hub-logout-btn">Sign out</button>
               ${profileDone ? `<button type="button" class="rc-btn rc-btn-primary" id="new-recording-btn">+ New Recording</button>` : `<span class="hub-login-note">complete your profile to record</span>`}
             </div>`
          : `<div class="hub-admin">
               <form class="hub-login-form" id="hub-login-form" autocomplete="off">
                 <input type="text" id="hub-invite-input" placeholder="Invite code" maxlength="64" />
                 <button type="submit" class="rc-btn rc-btn-primary">Sign in</button>
               </form>
               <span class="hub-login-note">Sign in with your band's invite code to record takes</span>
               <span class="hub-login-error" id="hub-login-error"></span>
             </div>`
      }
      <div class="studio-bar" id="studio-bar" ${profileDone ? "" : "hidden"}>
        <span class="studio-checkout" id="studio-checkout">Nothing checked out — click a commit to record over it</span>
        <button type="button" class="rc-btn rc-btn-record" id="record-take-btn" disabled>● Record Take</button>
        <select id="studio-device" class="studio-device" title="Microphone used for takes + new recordings — pick the real mic, not a loopback/stereo-mix device. Chosen once here: the take dialog and “Record from mic” both record through this same choice."></select>
        <select id="studio-output" class="studio-device" hidden title="Output for the backing + count-in + 监听 during a take, and for mix/preview playback. Pick your headphones here (Chrome/Edge) so the song you sing along to doesn't blast from the room speakers and bleed into the take; “System default” follows your OS sound output."></select>
        <button type="button" class="rc-btn rc-btn-ghost" id="stop-playback-btn">■ Stop</button>
        <span class="studio-status" id="studio-status"></span>
      </div>
    </div>
    <div id="repo-list" class="repo-list"></div>`;
  hubRootEl.innerHTML = toolbar;
  attachRepoListEvents();

  const loginForm = document.getElementById("hub-login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = document.getElementById("hub-invite-input").value.trim();
      const errEl = document.getElementById("hub-login-error");
      if (!code) {
        errEl.textContent = "Enter your invite code.";
        return;
      }
      errEl.textContent = "";
      try {
        const data = await hubApi("/api/auth/invite-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        localStorage.setItem(HUB_TOKEN_KEY, data.token);
        hub.user = data.user;
        hub.admin = !!data.user.is_admin;
        if (!data.user.profile_complete) {
          renderHub();
          showProfileSetup().catch((err2) => {
            const e2 = document.getElementById("hub-login-error");
            if (e2) e2.textContent = err2.message;
          });
        } else {
          await loadHub();
        }
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  }

  const logoutBtn = document.getElementById("hub-logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem(HUB_TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
      hub.user = null;
      hub.admin = false;
      hub.checkedOut = null;
      closeAudio();
      loadHub();
    });
  }

  const newBtn = document.getElementById("new-recording-btn");
  if (newBtn) newBtn.addEventListener("click", openNewRecording);

  if (profileDone) {
    document.getElementById("record-take-btn").addEventListener("click", openRecordSetup);
    document.getElementById("stop-playback-btn").addEventListener("click", stopPlayback);
    // Note: the L/R channel, 监听 Monitor, Headphones and No-backing controls
    // used to live in this bar; they now live inside the ● Record Take setup
    // dialog (openRecordSetup) and are persisted there on Start.
    populateMicDevices("studio-device");
    populateOutputSelect("studio-output");
  }
  renderRepos();
}

function renderRepos() {
  const list = document.getElementById("repo-list");
  if (!list) return;
  if (!hub.repos.length) {
    list.innerHTML = `<p class="empty-note">No recordings yet${hub.user ? " — start one above." : "."}</p>`;
    updateStudioBar();
    return;
  }
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  hub.repos.forEach((repo) => frag.appendChild(renderRepoCard(repo)));
  list.appendChild(frag);
  updateStudioBar();
  syncPlayState();
}

/* Keep the repo-card play buttons in sync with what is currently sounding:
   the card's orange button swaps to a pause glyph and its label flips. */
function syncPlayState() {
  const p = hub.playing;
  document.querySelectorAll(".rc-repo").forEach((card) => {
    const btn = card.querySelector(".sc-play");
    if (!btn) return;
    const repoId = Number(btn.dataset.repo);
    const active = !!(p && p.repoId === repoId);
    card.classList.toggle("playing", active);
    const title = (card.querySelector(".rc-repo-title") || {}).textContent || "";
    btn.setAttribute("aria-label", (active ? "Pause " : "Play ") + title.trim());
  });
}

/* 原创 (original) vs Cover badge — set once when the recording is created,
   shown on the repo's HEAD line and on its first (root) commit. */
function sourceBadge(sourceType) {
  const isCover = sourceType === "cover";
  return `<span class="rc-badge ${isCover ? "rc-badge-cover" : "rc-badge-original"}">${isCover ? "Cover" : "原创"}</span>`;
}

function renderRepoCard(repo) {
  const commits = hub.commits.get(repo.id) || [];
  const head = commits[commits.length - 1] || null;
  const expanded = hub.expanded === repo.id;
  const canEdit = !!repo.can_edit;
  const isBand = !!repo.band_id;
  const isSharedPublic = !!repo.share_public;
  // The ↗ button opens the /recording/:id page, which plays the latest tagged
  // version. Banded songs are private until a member publishes them
  // (share_public) — for those, pressing ↗ IS the publish step.
  const shareTitle = isBand
    ? isSharedPublic
      ? "Share as a public web page (plays the latest tagged version)"
      : "Share publicly — publish a public web page for this band recording"
    : "Share as a public web page (plays the latest tagged version)";
  // The export button downloads the current public version — the highest tag,
  // exactly the commit the share button's /recording/:id page plays.
  const latest = latestTaggedCommit(repo);
  const exportTitle =
    latest && latest.version != null
      ? `Download the latest version v${latest.version}.0 — what the share link plays`
      : "Download the latest commit";
  const card = document.createElement("div");
  card.className = "rc-repo";
  card.innerHTML = `
    <div class="rc-repo-head">
      <button type="button" class="sc-play rc-play" data-action="play-repo" data-repo="${repo.id}" aria-label="Play ${scEscapeHTML(repo.title)}">
        <svg class="sc-ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <svg class="sc-ico-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
      </button>
      <div class="rc-repo-main">
        <div class="rc-repo-title">${scEscapeHTML(repo.title)}</div>
        <div class="rc-repo-meta">
          ${sourceBadge(repo.source_type)}
          ${repo.band_name ? `<span class="rc-badge rc-badge-band" title="${isSharedPublic ? "This band recording — the public share link is live" : "Private to this band"}">🎸 ${scEscapeHTML(repo.band_name)}</span>` : ""}
          ${isBand && isSharedPublic ? `<span class="rc-badge rc-badge-share" title="Public — anyone with the link can listen (the page plays the latest tagged version)">public ↗</span>` : ""}
          ${commits.length} commit${commits.length === 1 ? "" : "s"}
          ${head ? ` · HEAD ${commitHash(head.id)} ${scEscapeHTML(head.message)}` : ""}
          · ${Number(repo.play_count) || 0} plays
        </div>
      </div>
      <div class="rc-repo-actions">
        ${isBand && !canEdit ? "" : `<button type="button" class="rc-icon-btn" data-action="share-repo" data-repo="${repo.id}" title="${shareTitle}">↗</button>`}
        <button type="button" class="rc-icon-btn" data-action="export-repo" data-repo="${repo.id}" title="${exportTitle}">⬇</button>
        <button type="button" class="rc-icon-btn rc-repo-toggle" data-action="toggle-repo" data-repo="${repo.id}" title="Commit history" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "▾" : "▸"}</button>
        ${
          canEdit
            ? `<button type="button" class="rc-icon-btn rc-repo-delete" data-action="delete-repo" data-repo="${repo.id}" title="Delete this recording and all its commits">🗑</button>`
            : ""
        }
      </div>
    </div>
    ${
      expanded
        ? `<div class="rc-commit-list"><div class="rc-commit-list-inner">${renderCommitRows(repo, commits)}</div></div>`
        : ""
    }
  `;
  return card;
}

/* ── Export (download) the latest public version ───────────────────────
   The header ⬇ button downloads what the share link (/recording/:id) plays:
   the repo's highest-tagged commit. Single takes download their own file;
   an overlay take is rendered offline to a mix WAV first (the same
   renderIOSMixBlob path iOS playback uses), so the exported audio matches
   what listeners actually hear. */

/* Keep a download filename safe on every OS: strip path separators and
   reserved characters, then collapse runs of spaces. */
function safeFileName(name) {
  return (
    String(name || "recording")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .trim() || "recording"
  );
}

/* File extension of a URL (ignoring any ?token= query). */
function fileExt(url) {
  const m = String(url || "").split(/[?#]/)[0].match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "wav";
}

/* The repo's current public version = the highest-tagged commit, or its head
   when nothing is tagged yet (server-side twin: db.getLatestTaggedCommit). */
function latestTaggedCommit(repo) {
  const commits = hub.commits.get(repo.id) || [];
  const tagged = commits.filter((c) => c.version != null).sort((a, b) => Number(b.version) - Number(a.version));
  return tagged[0] || commits[commits.length - 1] || null;
}

/* Trigger a browser download of a same-origin / blob: URL under our own name.
   audioUrl() appends the session token for banded (private) files. */
function downloadFile(url, filename) {
  const a = document.createElement("a");
  a.href = audioUrl(url);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function exportRepo(repo) {
  const c = latestTaggedCommit(repo);
  if (!c || !c.url) {
    alert("No audio to export for this recording yet.");
    return;
  }
  const version = c.version != null ? ` v${c.version}.0` : "";
  const base = safeFileName(repo.title);
  if (c.mode === "overlay") {
    // A lone-commit overlay (repo root exported before any take) IS its own
    // file — rendering it would just re-encode the same audio and could fail
    // for nothing on a phone. Download the file directly like the single case.
    if (buildChain(c).length === 1) {
      downloadFile(c.url, `${base}${version}.${fileExt(c.url)}`);
      setStudioStatus(`✔ exporting ${base}${version}.${fileExt(c.url)}`);
      return;
    }
    setStudioStatus("⏳ rendering the layered mix for export…", false);
    let blob;
    try {
      // Desktop export keeps the full 44.1 kHz quality (lowMemory:false); the
      // deadline aborts a stuck render instead of letting it burn in the
      // background, and the fallback below still hands over the take's file.
      blob = await mixRenderJob(c, null, 0, {
        ms: 60000,
        lowMemory: false,
        onStage: (s) => setStudioStatus("⏳ " + s, false),
      });
    } catch (err) {
      // Render failed — still hand over the take's own file rather than nothing.
      setStudioStatus(`⚠ could not render the mix (${err.message}) — exporting the take file alone.`, true);
      downloadFile(c.url, `${base}${version} (take).${fileExt(c.url)}`);
      return;
    }
    const url = URL.createObjectURL(blob);
    downloadFile(url, `${base}${version} (mix).wav`);
    // Keep the blob alive long enough for the download to finish.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 30000);
    setStudioStatus(`✔ exported ${base}${version} (mix).wav`);
  } else {
    downloadFile(c.url, `${base}${version}.${fileExt(c.url)}`);
    setStudioStatus(`✔ exporting ${base}${version}.${fileExt(c.url)}`);
  }
}

function renderCommitRows(repo, commits) {
  if (!commits.length) return `<p class="empty-note">No commits yet.</p>`;
  const canEdit = !!repo.can_edit;
  return commits
    .map((c) => {
      const checkedOut =
        hub.checkedOut && hub.checkedOut.repoId === repo.id && hub.checkedOut.commitId === c.id;
      const isOverlay = c.mode === "overlay";
      const isPlaying = !!(hub.playing && hub.playing.repoId === repo.id && hub.playing.commitId === c.id);
      // Next version number a tag button would assign (the server is
      // authoritative — this is just for the tooltip).
      const nextVersion = commits.reduce((m, x) => Math.max(m, Number(x.version) || 0), 0) + 1;
      return `
        <div class="rc-commit ${checkedOut ? "checked-out" : ""} ${isPlaying ? "playing" : ""}" data-commit="${c.id}">
          <div class="rc-commit-main" data-action="select-commit" data-repo="${repo.id}" data-commit="${c.id}">
            <div class="rc-commit-line">
              <span class="rc-hash">${commitHash(c.id)}</span>
              <span class="rc-msg">${scEscapeHTML(c.message)}</span>
              <span class="rc-badge ${isOverlay ? "rc-badge-overlay" : "rc-badge-single"}">${isOverlay ? "overlay" : "single"}</span>
              ${c.parent_id == null ? sourceBadge(repo.source_type) : ""}
              ${c.version != null ? `<span class="rc-badge rc-badge-version" title="This commit is public version v${c.version}.0 — the share link plays it">v${c.version}.0</span>` : ""}
            </div>
            <div class="rc-commit-meta">
              <span class="rc-range">⏱ ${fmtRange(c)}</span>
              ${isOverlay && c.parent_id != null ? `<span class="rc-parent">parent ${commitHash(c.parent_id)}</span>` : `<span class="rc-parent rc-parent-root">root</span>`}
              <span class="rc-byline">
                <span class="rc-date">${fmtStamp(c.created_at)}</span>
                <span class="rc-contributor">· 👤 ${scEscapeHTML(c.contributor || "admin")}</span>
              </span>
              ${canEdit
                ? `<label class="rc-vol" title="Balance this take against the parent — 100% is unchanged">
                     <span>vol</span>
                     <input type="range" data-action="set-volume" data-repo="${repo.id}" data-commit="${c.id}" min="0" max="200" step="5" value="${Math.round(commitVolume(c) * 100)}" />
                     <span class="rc-vol-val">${Math.round(commitVolume(c) * 100)}%</span>
                   </label>`
                : `<span class="rc-vol" title="Take volume vs the parent — 100% is unchanged"><span>vol</span><span class="rc-vol-val">${Math.round(commitVolume(c) * 100)}%</span></span>`}
              ${checkedOut ? `<span class="rc-checked">✓ checked out</span>` : ""}
            </div>
          </div>
          <button type="button" class="rc-icon-btn rc-commit-play" data-action="play-commit" data-repo="${repo.id}" data-commit="${c.id}" title="Play this commit"><span class="rc-cp-play">▶</span><span class="rc-cp-pause">⏸</span></button>
          ${
            canEdit && c.version == null
              ? `<button type="button" class="rc-icon-btn rc-commit-tag" data-action="tag-commit" data-repo="${repo.id}" data-commit="${c.id}" title="Tag this commit as the next public version (v${nextVersion}.0) — the share link will play it">🏷</button>`
              : ""
          }
          ${
            canEdit
              ? `<button type="button" class="rc-icon-btn rc-commit-delete" data-action="delete-commit" data-repo="${repo.id}" data-commit="${c.id}" title="Delete this commit">🗑</button>`
              : ""
          }
        </div>`;
    })
    .join("");
}



function attachRepoListEvents() {
  const list = document.getElementById("repo-list");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const repoId = Number(btn.dataset.repo);
    const findCommit = (id) => (hub.commits.get(repoId) || []).find((x) => x.id === id) || null;
    const repo = hub.repos.find((r) => r.id === repoId) || null;
    const canEdit = !!(repo && repo.can_edit);

    if (action === "play-repo") {
      // A repo whose sound is already playing becomes a pause control.
      if (hub.playing && hub.playing.repoId === repoId) {
        stopPlayback();
        return;
      }
      const commits = hub.commits.get(repoId) || [];
      const head = commits[commits.length - 1];
      if (head) playCommit(head);
    } else if (action === "toggle-repo") {
      hub.expanded = hub.expanded === repoId ? null : repoId;
      renderRepos();
    } else if (action === "share-repo") {
      if (!repo || typeof window.openShareDialog !== "function") return;
      const openShare = () => window.openShareDialog({ title: repo.title, path: `/recording/${repoId}` });
      // Public recordings (and band songs that are already shared) open
      // straight into the QR / copy-link / short-link dialog. A private band
      // song publishes on first share — after it, /recording/:id and its audio
      // are public and play the latest tagged version, like the legacy pages.
      if (repo.band_id && !repo.share_public) {
        if (!canEdit) return; // band members (and admin) can publish; others never see one
        const latest = latestTaggedCommit(repo);
        const whatPlays =
          latest && latest.version != null
            ? `the page plays the latest tagged version v${latest.version}.0`
            : "the page plays the latest commit";
        const bandLabel = repo.band_name ? ` — ${repo.band_name}` : "";
        if (
          !window.confirm(
            `"${repo.title}" is private to its band${bandLabel}. Sharing publishes a public web page where anyone with the link can listen (${whatPlays}). Publish and share?`
          )
        )
          return;
        hubApi(`/api/recordings/${repoId}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public: true }),
        })
          .then((data) => {
            if (data && data.repo) Object.assign(repo, data.repo);
            renderRepos();
            openShare();
          })
          .catch((err) => alert(err.message));
        return;
      }
      openShare();
    } else if (action === "export-repo") {
      if (repo) exportRepo(repo);
    } else if (action === "play-commit") {
      const c = findCommit(Number(btn.dataset.commit));
      if (!c) return;
      // The playing commit's own row button becomes a pause control.
      if (hub.playing && hub.playing.commitId === c.id) {
        stopPlayback();
        return;
      }
      playCommit(c);
    } else if (action === "tag-commit") {
      const c = findCommit(Number(btn.dataset.commit));
      if (!c || !canEdit || c.version != null) return;
      const next = (hub.commits.get(repoId) || []).reduce((m, x) => Math.max(m, Number(x.version) || 0), 0) + 1;
      if (!window.confirm(`Tag ${commitHash(c.id)} as the next public version (v${next}.0)? The share link will play this version.`)) return;
      hubApi(`/api/recordings/${repoId}/commits/${c.id}/tag`, { method: "POST" })
        .then(() => loadHub())
        .catch((err) => alert(err.message));
    } else if (action === "delete-commit") {
      const c = findCommit(Number(btn.dataset.commit));
      if (!c || !canEdit) return;
      // Deleting a take re-parents any takes recorded over it onto ITS parent
      // (server-side), so the remaining stack stays one connected chain and the
      // newest take still mixes every survivor. Say so in the prompt.
      const nKids = (hub.commits.get(repoId) || []).filter((x) => x.parent_id === c.id).length;
      if (
        !window.confirm(
          `Delete commit ${commitHash(c.id)} "${c.message}"? This cannot be undone.` +
            (nKids ? ` The ${nKids} take${nKids === 1 ? "" : "s"} recorded over it ${nKids === 1 ? "re-connects" : "re-connect"} to its parent.` : "")
        )
      )
        return;
      const playing = document.querySelector(".rc-commit.playing");
      if (playing && Number(playing.dataset.commit) === c.id) stopPlayback();
      // If the deleted commit was the ✓ record base, move the ✓ onto the repo's
      // surviving head so the next ● Record Take keeps stacking from the top.
      const wasCheckedOut = !!(hub.checkedOut && hub.checkedOut.repoId === repoId && hub.checkedOut.commitId === c.id);
      const newHead = (hub.commits.get(repoId) || [])
        .filter((x) => x.id !== c.id)
        .reduce((m, x) => (!m || x.id > m.id ? x : m), null);
      if (wasCheckedOut) {
        hub.checkedOut = newHead ? { repoId, commitId: newHead.id } : null;
      }
      hubApi(`/api/recordings/${repoId}/commits/${c.id}`, { method: "DELETE" })
        .then(() => loadHub())
        .catch((err) => {
          alert(err.message);
          loadHub(); // restore the pre-delete ✓/highlight state
        });
    } else if (action === "delete-repo") {
      if (!canEdit) return;
      if (!repo) return;
      const commits = hub.commits.get(repoId) || [];
      const plural = commits.length === 1 ? "commit" : "commits";
      if (!window.confirm(`Delete the recording "${repo.title}" and all ${commits.length} ${plural} under it? This cannot be undone.`)) return;
      // Stop playback if the sound playing belongs to this recording.
      const playing = document.querySelector(".rc-commit.playing");
      if (playing && commits.some((x) => x.id === Number(playing.dataset.commit))) stopPlayback();
      hubApi(`/api/recordings/${repoId}`, { method: "DELETE" })
        .then(() => {
          if (hub.checkedOut && hub.checkedOut.repoId === repoId) hub.checkedOut = null;
          if (hub.expanded === repoId) hub.expanded = null;
          return loadHub();
        })
        .catch((err) => alert(err.message));
    } else if (action === "select-commit") {
      const c = findCommit(Number(btn.dataset.commit));
      if (!c) return;
      if (canEdit) {
        hub.checkedOut = { repoId, commitId: c.id };
        updateStudioBar();
        renderRepos(); // refresh the ✓ highlight
      }
      playCommit(c);
    }
  });

  // Volume balance per commit: live % readout while dragging, persist on release.
  list.addEventListener("input", (e) => {
    const input = e.target.closest("[data-action='set-volume']");
    if (!input) return;
    const val = input.closest(".rc-vol").querySelector(".rc-vol-val");
    if (val) val.textContent = input.value + "%";
  });
  list.addEventListener("change", async (e) => {
    const input = e.target.closest("[data-action='set-volume']");
    if (!input) return;
    const repoId = Number(input.dataset.repo);
    const repo = hub.repos.find((r) => r.id === repoId);
    if (!repo || !repo.can_edit) return;
    const commitId = Number(input.dataset.commit);
    try {
      const data = await hubApi(`/api/recordings/${repoId}/commits/${commitId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volume: parseFloat(input.value) / 100 }),
      });
      const commits = hub.commits.get(repoId) || [];
      const c = commits.find((x) => x.id === commitId);
      if (c && data && data.commit) c.volume = data.commit.volume;
      renderRepos();
    } catch (err) {
      alert(err.message);
      renderRepos(); // revert the slider to the stored value
    }
  });
}

function updateStudioBar() {
  const bar = document.getElementById("studio-bar");
  if (!bar) return;
  const loggedIn = !!hub.user && !!hub.user.profile_complete;
  if (!loggedIn) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const label = document.getElementById("studio-checkout");
  const btn = document.getElementById("record-take-btn");
  const repo = hub.checkedOut
    ? hub.repos.find((r) => r.id === hub.checkedOut.repoId) || null
    : null;
  if (!hub.checkedOut) {
    label.textContent = "Nothing checked out — click a commit to record over it";
    btn.disabled = true;
  } else if (!repo || !repo.can_edit) {
    label.textContent = "This recording belongs to another band — you can't record over it";
    btn.disabled = true;
  } else {
    const c = (hub.commits.get(hub.checkedOut.repoId) || []).find(
      (x) => x.id === hub.checkedOut.commitId
    );
    label.textContent = `Checked out: ${repo.title + " "}${c ? commitHash(c.id) + " · " + c.message : ""}`;
    btn.disabled = false;
  }
  if (loggedIn && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
    btn.title = "Mic is blocked — this page must be served over HTTPS";
    setStudioStatus("⚠ Microphone blocked: this page is on plain http — serve it over HTTPS to record takes.", true);
  }
}

/* ── Audio engine ──────────────────────────────────────── */
/* Playback = live Web Audio mixing of the commit's ancestor chain at
   cumulative offsets. The committed take is always the clean/dry mic
   capture; the "with original" preview mixes that take over the chain. */
const audioEngine = {
  ctx: null,
  sources: [],   // active AudioBufferSourceNodes (so we can stop them)
  elements: [],  // plain <audio> elements used for dry preview
};

/* Decoded AudioBuffers are not AudioContext-bound, so cache them by URL: a take
   session re-plays the same backing chain repeatedly, and re-fetching + re-decoding
   it every time (0.5-3 s) used to swallow the count-in's lead time.

   The cache is LRU-bounded by raw-PCM bytes: an AudioBuffer is Float32 at the
   file's own rate (a 5-minute song ≈ 100 MB), and an uncapped cache made phones
   accumulate every layer ever played until the tab ran out of memory and the
   next mix render / playback silently died. Evicted layers just re-decode on
   the next play — a second or two — far cheaper than a crashed tab. */
const bufferCache = new Map(); // url → AudioBuffer (LRU)
const BUFFER_CACHE_BUDGET = 200 * 1024 * 1024; // decoded-PCM ceiling for this page
let bufferCacheBytes = 0;

function audioBufferBytes(b) {
  if (!b) return 0;
  return Math.max(0, (Number(b.duration) || 0) * (Number(b.sampleRate) || 1) * Math.max(1, Number(b.numberOfChannels) || 1) * 4);
}

function cacheBufferPut(url, buffer) {
  const old = bufferCache.get(url); // a racing parallel decode may have stored it first
  if (old) bufferCacheBytes -= audioBufferBytes(old);
  bufferCache.delete(url);
  bufferCache.set(url, buffer);
  bufferCacheBytes += audioBufferBytes(buffer);
  while (bufferCacheBytes > BUFFER_CACHE_BUDGET && bufferCache.size > 1) {
    const oldestUrl = bufferCache.keys().next().value;
    if (oldestUrl == null) break;
    const oldest = bufferCache.get(oldestUrl);
    bufferCache.delete(oldestUrl);
    if (oldest) bufferCacheBytes -= audioBufferBytes(oldest);
  }
}

/* The offline renders carry a deadline (see mixRenderJob): once it passes, the
   job is aborted so a too-slow phone render stops instead of keeping burning
   CPU / WebKit contexts in the background. Decode, mix and encode all surface
   this same message so every caller reports one reason. */
function mixCancelError() {
  return new Error("mixing took too long");
}

/* Promise.allSettled with a tiny fallback for old iOS (< 12.1): without it,
   playCommit silently dies on those devices while recording still works. */
function allSettled(promises) {
  if (typeof Promise.allSettled === "function") return Promise.allSettled(promises);
  return Promise.all(
    promises.map((p) =>
      Promise.resolve(p).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason })
      )
    )
  );
}

/* decodeAudioData has two flavors: promise-based (modern browsers) and
   callback-based (old Safari/iOS < 14.5). Awaiting the callback flavor yields
   `undefined` (a silent "playing" state) instead of throwing, so wrap both
   forms into a real promise that always settles with an AudioBuffer or an
   error. */
function decodeAudioCompat(ctx, ab) {
  return new Promise((resolve, reject) => {
    if (!ctx || typeof ctx.decodeAudioData !== "function") {
      reject(new Error("decodeAudioData is not supported in this browser"));
      return;
    }
    let settled = false;
    const ok = (b) => {
      if (settled) return;
      settled = true;
      if (b && typeof b.duration === "number") resolve(b);
      else reject(new Error("decodeAudioData returned no audio"));
    };
    const bad = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String((err && err.message) || err || "decodeAudioData failed")));
    };
    try {
      const p = ctx.decodeAudioData(ab, ok, bad);
      if (p && typeof p.then === "function") p.then(ok, bad);
    } catch (err) {
      bad(err);
    }
  });
}

/* iOS keeps a freshly created AudioContext suspended until it is resumed from
   a user gesture, and sources started while the context is still suspended can
   be dropped silently. Resume must COMPLETE before scheduling; a timeout keeps
   a never-settling resume from hanging playback (the caller falls back to a
   native <audio> element). Returns true when the context is running. */
async function ensureCtxRunning(ctx) {
  if (!ctx || ctx.state === "closed") return false;
  if (ctx.state !== "running") {
    try {
      await Promise.race([
        ctx.resume(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("audio resume timed out")), 1500)),
      ]);
    } catch (_) { /* stays suspended */ }
  }
  return !!ctx && ctx.state === "running";
}

/* Decode one audio layer for playback → an AudioBuffer (cached by URL with an
   LRU byte budget). Every recording in the library is WAV (and backings are WAV
   or MP3), and decodeAudioData accepts WAV and MP3 on every browser — including
   iOS Safari — so this is the single, deterministic playback path. The optional
   `signal` aborts the network fetch when the offline-mix deadline passes. */
async function decodeLayer(ctx, url, signal) {
  const hit = bufferCache.get(url);
  if (hit) {
    bufferCache.delete(url); // LRU touch — refresh the hit's recency
    bufferCache.set(url, hit);
    return { kind: "buffer", buffer: hit };
  }
  if (signal && signal.aborted) throw mixCancelError();
  // blob: URLs ignore cache mode and Safari rejects the cache option on them.
  // Banded files need the session JWT — appended by audioUrl() (see above).
  const isBlob = url.indexOf("blob:") === 0;
  const init = {};
  if (!isBlob) init.cache = "no-cache";
  if (signal) init.signal = signal;
  const res = await fetch(audioUrl(url), init);
  if (!res.ok) throw new Error("Could not load audio: " + url);
  const ab = await res.arrayBuffer();
  if (signal && signal.aborted) throw mixCancelError(); // don't cache wasted work
  const buffer = await decodeAudioCompat(ctx, ab);
  if (signal && signal.aborted) throw mixCancelError(); // decode finished after the deadline
  cacheBufferPut(url, buffer);
  return { kind: "buffer", buffer };
}

function closeAudio() {
  // A running take owns the live session context (backing + count-in ticks +
  // monitor all hang off audioEngine.ctx). Nothing may tear it down mid-take:
  // showModal → closeModal → stopSetupAudition calls this unconditionally when
  // the session modal replaces the setup dialog, which used to close the
  // brand-new session context the instant it appeared — every take recorded
  // silent. Session audio is closed only by cleanupTakeMedia(), which every
  // complete/cancel/error path reaches with studio.recording already false.
  if (studio.recording) return;
  // A full-chain mix render still decoding/encoding is now superseded by
  // whatever this close is for (a new row play, a take audition, a modal
  // preview) — abort it so a late blob can't mount an <audio> element behind
  // the audio that replaces it.
  if (iosMixActiveJob) {
    try { iosMixActiveJob.abort(); } catch (_) {}
    iosMixActiveJob = null;
  }
  if (audioEngine.ctx) {
    audioEngine.sources.forEach((s) => {
      try { s.stop(); } catch (_) {}
      try { s.disconnect(); } catch (_) {}
    });
    // close() is missing on old iOS (< 14.5) — guard so it can't throw here.
    try {
      if (typeof audioEngine.ctx.close === "function") audioEngine.ctx.close().catch(() => {});
    } catch (_) {}
  }
  audioEngine.elements.forEach((el) => {
    try { el.pause(); el.removeAttribute("src"); el.load(); } catch (_) {}
    if (el._mixUrl) { try { URL.revokeObjectURL(el._mixUrl); } catch (_) {} el._mixUrl = null; }
  });
  audioEngine.ctx = null;
  audioEngine.sources = [];
  audioEngine.elements = [];
  document.querySelectorAll(".rc-commit.playing").forEach((el) => el.classList.remove("playing"));
  hub.playing = null;
  syncPlayState();
}

/* Ordered root → commit, each with the offset where it sits on the parent's
   playback timeline. A commit's own start_time is the ROOT-ABSOLUTE position
   of its audible start (for takes this already includes the count-in lead),
   so it is used directly — summing the ancestors' start_times would push
   deeper takes progressively later (the "take sounds delayed" bug). The
   initial commit always sits at 0. The blob read offset is handled separately:
   a take's blob starts `lead` seconds into the parent, so the mix reads it
   from (start_time − lead). */
function buildChain(commit) {
  const commits = hub.commits.get(commit.repo_id) || [];
  const byId = new Map(commits.map((c) => [c.id, c]));
  const chain = [];
  let cur = commit;
  let guard = 0;
  while (cur && guard++ < 1000) {
    chain.unshift(cur);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }
  return chain.map((c, i) => ({ commit: c, offset: i === 0 ? 0 : Number(c.start_time) || 0 }));
}

/* Seconds this take plays (end − start), or null for natural duration. */
function takeDuration(c) {
  const end = Number(c.end_time);
  if (isFinite(end) && end > 0) {
    const d = end - (Number(c.start_time) || 0);
    if (d > 0) return d;
  }
  return null;
}

/* Linear gain multiplier for a commit's own audio (default 1 = unchanged).
   0 = muted; missing/NaN (older commits) defaults to 1. */
function commitVolume(c) {
  const v = Number(c.volume);
  return isFinite(v) && v >= 0 ? Math.min(3, v) : 1;
}

/* whenOffset = position on the parent timeline to start playback
   bufOffset  = position INSIDE the buffer to start reading (a take's own
                start_time — its blob timeline is aligned with the parent,
                so reading the blob from its start_time places the audible
                take exactly where it belongs on the parent).
   gain       = linear multiplier applied to THIS source only (per-commit
                volume balance vs the parent chain; 1 = unchanged).
   layer      = { kind: "buffer", buffer } from decodeLayer(). Every recording
                is WAV/MP3, which decodeAudioData accepts on every browser, so
                there is no media-element layer anymore. */
function scheduleLayer(ctx, layer, whenOffset, bufOffset, dur, startAt, dest, gain) {
  const out = dest || ctx.destination;
  const off = Math.max(0, bufOffset || 0);
  // A take read past its own buffer's end would throw (RangeError) and drop
  // the layer from the mix; clamp instead so a badly-timed take is silent,
  // never fatal.
  const bufDur = layer.buffer.duration || 0;
  const readOff = off >= bufDur ? Math.max(0, bufDur - 0.001) : off;
  const src = ctx.createBufferSource();
  src.buffer = layer.buffer;
  if (isFinite(gain) && gain >= 0 && Math.abs(gain - 1) > 0.001) {
    const g = ctx.createGain();
    g.gain.value = gain; // 0 = muted
    src.connect(g);
    g.connect(out);
  } else {
    src.connect(out);
  }
  src.start(startAt + whenOffset, readOff, Math.max(0.05, dur || (bufDur - readOff)));
  audioEngine.sources.push(src);
}

/* Read window of one chain layer when the session starts at root position
   `fromRoot` instead of 0 (the record-setup dialog's "start point in the
   song"). A layer's blob zero sits at `lead` on the root timeline, its audible
   content starts at buffer position (start_time − lead), and an end_time cuts
   the content there. From a mid-song start only the content at/after fromRoot
   is read; the same blob read as today when fromRoot = 0.

   Returns { readStart, readDur, whenOffset } (buffer seconds; whenOffset is the
   graph delay from the session zero), or null when the layer has nothing left
   at/after fromRoot. scheduleLayer pads short reads to ≥ 0.05 s — a play that
   would run past the buffer's end would throw (RangeError), so windows within
   0.05 s of the end are dropped (≤ 50 ms of tail — inaudible, never fatal). */
function layerReadWindow(c, bufferDur, fromRoot) {
  const bufDur = Math.max(0, Number(bufferDur) || 0);
  if (!(bufDur > 0)) return null;
  const lead = Math.max(0, Number(c.lead) || 0);
  const startT = Math.max(0, Number(c.start_time) || 0);
  const endT = Number(c.end_time);
  const c0 = Math.max(0, startT - lead); // audible content start, in the buffer
  const c1 = isFinite(endT) && endT > 0 ? Math.min(endT - lead, bufDur) : bufDur;
  if (!(c1 > c0)) return null;
  const F = Math.max(0, Number(fromRoot) || 0);
  const readStart = Math.max(c0, F - lead);
  if (readStart >= c1 || bufDur - readStart < 0.05) return null;
  return {
    readStart,
    readDur: Math.min(c1 - readStart, bufDur - readStart),
    whenOffset: Math.max(0, lead + readStart - F),
  };
}

/* scheduleLayer wrapper for the mid-song session scheduling (take backing,
   play-from-a-point auditions): uses layerReadWindow so the same per-layer
   read windows are shared by the live path and the iOS offline render. */
function scheduleSessionLayer(ctx, layer, c, fromRoot, startAt, dest, gain) {
  const win = layerReadWindow(c, layer.buffer && layer.buffer.duration, fromRoot);
  if (!win) return;
  scheduleLayer(ctx, layer, win.whenOffset, win.readStart, win.readDur, startAt, dest, gain);
}

/* iPadOS 13+ reports a desktop "MacIntel" UA; maxTouchPoints > 1 is the
   reliable tell. iOS Safari's Web Audio clock can run while sources are
   dropped silently, so iOS always plays through a native <audio> element. */
function isIOS() {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/* ── Backing chain length (the record-setup slider's range) ────────────────

   The "start point in the song" slider spans the ROOT-timeline length of the
   checked-out backing chain (the root commit + every later take). Exact
   lengths come from the decoded AudioBuffer when one is already cached;
   otherwise a WAV's length is read straight from its RIFF header with a tiny
   range request (no multi-MB download), and non-WAV files fall back to <audio>
   metadata. Layers with a committed end_time need no file read at all. */

const audioDurCache = new Map(); // url → seconds | null (null = known unreadable)

function wavHeaderDuration(buf) {
  try {
    if (!buf || buf.byteLength < 44) return null;
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46464952) return null; // "RIFF"
    if (dv.getUint32(8, true) !== 0x45564157) return null; // "WAVE"
    const fileBytes = Math.max(0, dv.getUint32(4, true) + 8);
    let fmt = null;
    let dataBytes = null;
    let o = 12;
    while (o + 8 <= buf.byteLength) {
      const id = dv.getUint32(o, true);
      const size = dv.getUint32(o + 4, true);
      if (id === 0x20746d66 && fmt == null) fmt = o + 8; // "fmt "
      if (id === 0x61746164 && dataBytes == null) { dataBytes = size; break; } // "data"
      o += 8 + size + (size & 1);
    }
    if (fmt == null || fmt + 12 > buf.byteLength) return null;
    const byteRate = dv.getUint32(fmt + 8, true); // bytes/second (PCM & float)
    if (!(byteRate > 0)) return null;
    const bytes = dataBytes != null ? dataBytes : Math.max(0, fileBytes - 44);
    const dur = bytes / byteRate;
    return isFinite(dur) && dur > 0 ? dur : null;
  } catch (_) {
    return null;
  }
}

function probeMetaDuration(url) {
  return new Promise((resolve) => {
    const el = new Audio();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { el.removeAttribute("src"); el.load(); } catch (_) {}
      resolve(v);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => finish(isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
    el.src = audioUrl(url);
  });
}

/* Length of one backing file without decoding it: WAVs answer from their RIFF
   header (first 64 KB via a Range request — Express serves 206 partials);
   other legacy kinds (MP3/WebM/OGG…) fall back to <audio> metadata. Returns
   seconds, or null when the length cannot be read cheaply. */
async function audioFileDuration(url) {
  if (audioDurCache.has(url)) return audioDurCache.get(url);
  let dur = null;
  try {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const res = await fetch(audioUrl(url), {
      headers: { Range: "bytes=0-65535" },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (res.ok) {
      const whole = res.status !== 206; // server ignored the Range header
      const cl = Number(res.headers.get("content-length") || 0);
      if (whole && cl > 200000 && ctrl) {
        ctrl.abort(); // a full download just for a header — never
        dur = null;
      } else {
        const ab = await res.arrayBuffer();
        dur = wavHeaderDuration(ab);
        if (dur == null) {
          const kind = sniffAudioKind(new Blob([ab.slice(0, 12)]));
          if (kind !== "wav") dur = await probeMetaDuration(url);
        }
      }
    }
  } catch (_) {
    dur = null;
  }
  audioDurCache.set(url, dur);
  return dur;
}

/* Root-timeline position where one layer's content ends: its committed
   end_time, or (when the file length is known) where playing the file to its
   end lands — start_time + (file − (start_time − lead)). null when unknown. */
function layerRootEnd(c, bufDur) {
  const endT = Number(c.end_time);
  if (isFinite(endT) && endT > 0) return endT;
  const dur = Number(bufDur);
  if (!(dur > 0)) return null;
  const startT = Math.max(0, Number(c.start_time) || 0);
  const lead = Math.max(0, Number(c.lead) || 0);
  return startT + Math.max(0, dur - Math.max(0, startT - lead));
}

/* The longest end across every backing layer, in root seconds — the slider's
   max. null when not even the root commit's length is knowable (rare: an
   unreadable file over a broken network). */
async function backingChainTotal(commit) {
  let total = null;
  for (const { commit: c } of buildChain(commit)) {
    const endT = Number(c.end_time);
    let end = isFinite(endT) && endT > 0 ? endT : null;
    if (end == null) {
      const cached = bufferCache.get(c.url);
      const fileDur = cached ? cached.duration : await audioFileDuration(c.url);
      end = layerRootEnd(c, fileDur);
    }
    if (end != null) total = total == null ? end : Math.max(total, end);
  }
  return total && total > 0 ? total : null;
}

/* ── The record-setup song transport ("Listen from here") ────────────────────

   The dialog plays the checked-out chain from the top on open and the scrubber
   is its progress bar: dragging chooses where the take starts and releasing
   seeks the playback there so the singer keeps hearing from the new point.
   Desktop plays the layers live through Web Audio (instant start, per-commit
   volume balance, the same output routing as a take); iOS renders the mix
   offline and plays it through a native <audio> element (its Web Audio clock
   silently drops live sources). One audition is active at a time; closing the
   dialog, pressing "Start from here", or starting a new audition stops it. */

let setupAudition = null;     // { seq, rootFrom, teardown() } | null
let setupAuditionSeq = 0;     // monotonic — invalidates stale async decodes
let setupChosenStart = 0;     // the slider's settled position (idle readout)
let setupScrubbing = false;   // the user is dragging the slider — playhead UI stands down

/* m:ss.t readout — the record flow times are second-precision everywhere, but
   a tenth helps place a mid-song start exactly on the phrase. */
function fmtStartTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ":" + String(Math.floor(r)).padStart(2, "0") + "." + Math.floor((r - Math.floor(r)) * 10);
}

/* The measured backing length behind the dialog's scrubber — 0 until the async
   length read lands, so the clock shows just the current position before then. */
function setupChainTotal() {
  const els = setupDialogEls();
  return els.bar ? Math.max(0, Number(els.bar.max) || 0) : 0;
}

/* "m:ss.t / m:ss.t" — the current position against the song length once known. */
function fmtSetupClock(secs) {
  const total = setupChainTotal();
  return total > 0 ? fmtStartTime(secs) + " / " + fmtStartTime(total) : fmtStartTime(secs);
}

/* Write the dialog clock (the live playhead while the song plays; the chosen
   take-start when idle). */
function setSetupClock(secs) {
  const els = setupDialogEls();
  if (els.time) els.time.textContent = fmtSetupClock(secs);
}

/* Status line while the song is playing — the setup dialog is a transport now:
   the song autoplays from the top and the singer drags to choose where the take
   starts (releasing keeps playing from there). */
function setupPlayingStatus(F) {
  return (
    (Number(F) > 0.05 ? "Playing from " + fmtStartTime(F) : "Playing the song from the top") +
    " — drag the bar to where this take starts (releasing keeps playing from there), then hit “Start from here →”."
  );
}

function setupDialogEls() {
  return {
    bar: document.getElementById("setup-start-bar"),
    time: document.getElementById("setup-start-time"),
    hint: document.getElementById("setup-start-hint"),
    listen: document.getElementById("setup-listen-btn"),
    reset: document.getElementById("setup-to-top-btn"),
  };
}

/* Idle explanation under the start-point scrubber (no audition running): what
   the chosen point means for the take. Kept in one place because several
   handlers (drag end, stop, reset, natural end, measurement done) restore it. */
function refreshIdleHint() {
  const els = setupDialogEls();
  if (!els.hint) return;
  if (setupChosenStart <= 0) {
    els.hint.textContent =
      "Whole-song take — starts at the song's beginning (0:00) and spans the whole length you record. Hit “Start from here →” to go, or play and drag to choose a mid-song start instead.";
    return;
  }
  // A point inside the opening TAKE_PRE_ROLL can't be rolled into (the session
  // can't begin before the song's top), so the session starts at the top and the
  // singer comes in as the last tick ends — the take then lands at the count-in's
  // end and its start can be fine-tuned in the review step.
  if (setupChosenStart < TAKE_PRE_ROLL) {
    els.hint.textContent =
      "This point sits inside the song's opening " + TAKE_PRE_ROLL.toFixed(1) +
      " s, so the count-in runs from the song's start — you come in as the last tick ends (around " +
      fmtStartTime(TAKE_PRE_ROLL) + ") and the review step places the take exactly where you want it.";
    return;
  }
  const max = els.bar ? Math.max(0, Number(els.bar.max) || 0) : 0;
  if (max > 0 && setupChosenStart >= max - 0.05) {
    els.hint.textContent =
      "Starting at the very end of the song (" + fmtStartTime(setupChosenStart) + ") — the four count-in ticks play over the last seconds and you sing as the song ends.";
    return;
  }
  els.hint.textContent =
    "The count-in starts " + TAKE_PRE_ROLL.toFixed(1) + " s before this point, so the song reaches " +
    fmtStartTime(setupChosenStart) +
    " exactly as the last tick ends — start singing then and the take lands right here. Press “▶ Listen from here” to double-check the spot, or “Start from here →” to go.";
}

/* Reflect an audition state in the record-setup dialog (no-op once the dialog
   is gone — the ids come from the live document). */
function setSetupAuditionUI(playing, statusText) {
  const els = setupDialogEls();
  if (els.listen) els.listen.textContent = playing ? "■ Stop" : "▶ Listen from here";
  if (statusText !== undefined && els.hint) els.hint.textContent = statusText;
}

/* The dialog's clock + bar follow the playhead while an audition plays. While
   the user is dragging the bar they own the readout (no clock/bar writes until
   they release); otherwise the bar is only moved from code here. */
function setSetupTimeReadout(secs) {
  const els = setupDialogEls();
  const pos = Math.max(0, Number(secs) || 0);
  if (setupScrubbing) return;
  setSetupClock(pos);
  if (els.bar && document.activeElement !== els.bar) {
    els.bar.value = String(Math.max(0, Math.min(setupChainTotal(), pos)));
  }
}

/* Stop whatever audition is sounding (called on modal close/cancel/start and
   before a new audition). setupChosenStart is left untouched — the dialog's
   own handlers restore the bar to it when they want. */
function stopSetupAudition() {
  const a = setupAudition;
  setupAudition = null;
  setupScrubbing = false;
  if (a && typeof a.teardown === "function") {
    try { a.teardown(); } catch (_) {}
  }
  closeAudio();
  setSetupAuditionUI(false);
  refreshIdleHint();
}

/* Natural end / failure of the audition whose seq matches — back to the idle
   state, with the clock and bar at the settled chosen start. */
function finishSetupAudition(seq, ok, message) {
  const a = setupAudition;
  if (!a || a.seq !== seq) return;
  setupAudition = null;
  setupScrubbing = false;
  if (typeof a.teardown === "function") {
    try { a.teardown(); } catch (_) {}
  }
  setSetupAuditionUI(false);
  if (ok) {
    const els = setupDialogEls();
    setSetupClock(setupChosenStart);
    if (els.bar) els.bar.value = String(Math.max(0, Math.min(setupChainTotal(), setupChosenStart)));
    refreshIdleHint();
  } else {
    const els = setupDialogEls();
    if (els.hint) els.hint.textContent = message || "stopped listening";
  }
}

function setupBackingCommit() {
  if (!hub.checkedOut) return null;
  const repoId = hub.checkedOut.repoId;
  return (hub.commits.get(repoId) || []).find((c) => c.id === hub.checkedOut.commitId) || null;
}

/* Kick off an audition from rootFrom. Returns true when an audition starts. The
   Listen button doubles as “■ Stop”, so it is always enabled once an audition
   exists — even when the browser held playback back, the next press of it is a
   fresh user gesture and retries the start. */
function startSetupAudition(rootFrom) {
  const commit = setupBackingCommit();
  const F = Math.max(0, Number(rootFrom) || 0);
  if (!commit) return false;
  stopSetupAudition();
  const els = setupDialogEls();
  if (els.listen) els.listen.disabled = false;
  const seq = ++setupAuditionSeq;
  setupAudition = { seq, rootFrom: F };
  if (isIOS()) iosSetupAudition(commit, F, seq);
  else desktopSetupAudition(commit, F, seq);
  return true;
}

/* Desktop audition = the dialog's song transport: each layer is scheduled from
   F on the shared context and the playhead timer steers the clock/bar (both are
   left alone while the user is dragging the bar). The end of the song comes
   from the decoded layers themselves, not the async length read that sizes the
   bar, so playback can start immediately when the dialog opens. */
async function desktopSetupAudition(commit, F, seq) {
  setSetupAuditionUI(true, F > 0.05 ? "loading the song from " + fmtStartTime(F) + "…" : "loading the song…");
  let ctx = null;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; }
  if (!ctx) { finishSetupAudition(seq, false, "Web Audio is unavailable on this device"); return; }
  audioEngine.ctx = ctx;
  // Resume inside the gesture, then route to the chosen output and let the
  // stream settle before anything is scheduled (see preparePlaybackContext).
  const running = await preparePlaybackContext(ctx);
  if (audioEngine.ctx !== ctx) return; // stopped while the output settled
  if (!running) {
    // The browser held the context back (the dialog-open click gesture has
    // expired by the time the decode finished) — surface it as a message; the
    // next press of “▶ Listen from here” IS a fresh gesture and starts it.
    audioEngine.ctx = null;
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    finishSetupAudition(seq, false, "the browser held the playback back — press “▶ Listen from here” to start it");
    return;
  }
  const layers = [];
  for (const { commit: c } of buildChain(commit)) {
    try { layers.push({ c, layer: await decodeLayer(ctx, c.url) }); }
    catch (err) { layers.push({ c, layer: null, err }); }
  }
  // Superseded while decoding (another audition started / dialog closed) → drop.
  if (!setupAudition || setupAudition.seq !== seq || !audioEngine.ctx || audioEngine.ctx !== ctx) {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    return;
  }
  if (!layers[0] || !layers[0].layer) {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    finishSetupAudition(seq, false, "couldn't load the backing to listen to — check the connection and try again");
    return;
  }
  const startAt = ctx.currentTime + 0.15;
  let scheduled = 0;
  for (const { c, layer } of layers) {
    if (!layer) continue;
    try {
      scheduleSessionLayer(ctx, layer, c, F, startAt, undefined, commitVolume(c));
      scheduled++;
    } catch (_) {}
  }
  if (!scheduled) {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    finishSetupAudition(seq, false, "nothing to hear from that point — the song has already ended there");
    return;
  }
  // Song length for the playhead's end detection, from the decoded layers.
  let total = 0;
  for (const { c, layer } of layers) {
    if (!layer || !layer.buffer) continue;
    const end = layerRootEnd(c, layer.buffer.duration);
    if (end != null && end > total) total = end;
  }
  const endAt = total > F ? startAt + (total - F) + 0.2 : null;
  const timer = setInterval(() => {
    if (!audioEngine.ctx || audioEngine.ctx !== ctx || !setupAudition || setupAudition.seq !== seq) {
      clearInterval(timer);
      return;
    }
    const pos = F + Math.max(0, ctx.currentTime - startAt);
    if (endAt == null || ctx.currentTime < endAt) {
      setSetupTimeReadout(Math.min(total || pos, pos));
    } else {
      clearInterval(timer);
      finishSetupAudition(seq, true, "");
    }
  }, 150);
  setupAudition.teardown = () => clearInterval(timer);
  setSetupAuditionUI(true, setupPlayingStatus(F));
}

/* Audition on iOS: render the chain's tail from F through the shared offline
   pipeline, then play it like playIOSMix does (native <audio>, routed to the
   chosen output), reporting the playhead so the dialog readout follows the
   song. Because the render is async, play() happens outside the original tap's
   gesture and iOS blocks it the first time — arm again on the next touch. */
async function iosSetupAudition(commit, F, seq) {
  setSetupAuditionUI(true, F > 0.05 ? "mixing from " + fmtStartTime(F) + "…" : "mixing the song…");
  const fromPref = F > 0.05 ? "Mixing from " + fmtStartTime(F) + "… " : "Mixing the song… ";
  // Register the cancel hook from the very first moment: “■ Stop” can be
  // pressed while the mix is still rendering, and the old code left that render
  // burning the phone's CPU for the whole timeout before the seq guard finally
  // dropped the result. Now Stop aborts the render immediately.
  const job = mixRenderJob(commit, null, F, {
    ms: 40000,
    onStage: (s) => {
      if (setupAudition && setupAudition.seq === seq) setSetupAuditionUI(true, fromPref + s);
    },
  });
  const holder = setupAudition && setupAudition.seq === seq ? setupAudition : null;
  if (holder) holder.teardown = () => { try { job.abort(); } catch (_) {} };
  let blob = null;
  try {
    blob = await job;
  } catch (err) {
    // Stopped or superseded while rendering — nothing to announce.
    if (!setupAudition || setupAudition.seq !== seq) return;
    finishSetupAudition(seq, false, "couldn't audition from that point: " + err.message);
    return;
  }
  if (!setupAudition || setupAudition.seq !== seq) return; // superseded
  const url = URL.createObjectURL(blob);
  const el = new Audio();
  el.preload = "auto";
  routeElToOutput(el); // keep the audition on the chosen output device
  el._mixUrl = url;    // revoked in closeAudio()
  const session = { seq, rootFrom: F, el };
  const bailTimer = setTimeout(() => {
    if (setupAudition === session) finishSetupAudition(seq, false, "playback didn't start — try again");
  }, 25000);
  session.teardown = () => {
    clearTimeout(bailTimer);
    try { if (session.el === el) session.el = null; } catch (_) {}
  };
  setupAudition = session;
  audioEngine.elements.push(el);
  let started = false;
  const live = () => setupAudition === session;
  const playingNote = () => setSetupAuditionUI(true, setupPlayingStatus(F));
  el.addEventListener("timeupdate", () => {
    if (live() && started) setSetupTimeReadout(F + (el.currentTime || 0));
  });
  el.onended = () => { if (live() && started) finishSetupAudition(seq, true, ""); };
  const play = () =>
    el.play()
      .then(() => { started = true; playingNote(); })
      .catch((e) => {
        if (!live()) return;
        if (e && e.name === "NotAllowedError") {
          // iOS needs a fresh user gesture for the play() — this retry IS one.
          setSetupAuditionUI(true, F > 0.05 ? "tap once to play from " + fmtStartTime(F) : "tap once to play the song from the top");
          const retry = () => {
            window.removeEventListener("touchend", retry);
            window.removeEventListener("click", retry);
            if (!live() || started) return;
            el.play().then(() => { started = true; playingNote(); }).catch((e2) => {
              if (e2 && e2.name === "AbortError") return;
              if (live()) finishSetupAudition(seq, false, "the browser blocked playback — press “▶ Listen from here” again");
            });
          };
          window.addEventListener("touchend", retry, { once: true });
          window.addEventListener("click", retry, { once: true });
          return;
        }
        if (e && e.name === "AbortError") return; // stopped by closeAudio()
        finishSetupAudition(seq, false, "couldn't play the mix: " + ((e && e.message) || e));
      });
  el.addEventListener("loadedmetadata", play, { once: true });
  el.addEventListener("canplay", play, { once: true });
  setSetupAuditionUI(true, "mixing done — starting playback…");
}
async function playCommit(commit, extra) {
  closeAudio();
  // On iOS, skip the live Web Audio mix entirely: its clock can report
  // "running" while sources are dropped silently (blue "playing" row, no
  // sound). Instead render the whole chain offline (pure DSP — nothing can
  // drop it) and play the resulting WAV via the native <audio> element the
  // share page uses. Volume balance is identical to the desktop mix.
  if (isIOS()) {
    playIOSMix(commit, extra);
    return;
  }
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_) {
    ctx = null; // iOS can refuse to create one when the 4-context limit is hit
  }
  if (!ctx) {
    playNativeTrack(commit, null, "Web Audio is unavailable on this device");
    return;
  }
  audioEngine.ctx = ctx;
  setStudioStatus("▶ mixing…", false);
  // Resume inside the user gesture, then route to the same output the takes use
  // (headphones, when picked — not the room speakers) and wait for that stream
  // to settle before decoding/scheduling: a source scheduled while the device
  // is still switching is dropped silently even though ctx.state reads
  // "running". See preparePlaybackContext.
  const ready = await preparePlaybackContext(ctx);
  if (audioEngine.ctx !== ctx) return; // stopped while the output settled
  if (!ready) {
    setStudioStatus("");
    playNativeTrack(commit, null, "the audio output wouldn't start");
    return;
  }
  const chain = buildChain(commit);
  const jobs = chain.map(async ({ commit: c, offset }) => ({
    c,
    offset,
    layer: await decodeLayer(ctx, c.url),
  }));
  if (extra && extra.url) {
    jobs.push(
      decodeLayer(ctx, extra.url).then((layer) => ({
        c: { start_time: Number(extra.start_time) || 0, lead: Number(extra.lead) || 0, end_time: null },
        offset: Number(extra.start_time) || 0,
        layer,
        dur: extra.duration,
        gain: extra.volume,
      }))
    );
  }
  const results = await allSettled(jobs);
  if (audioEngine.ctx !== ctx) return; // stopped or superseded while loading
  // The commit clicked is jobs[0]; if its own file won't decode, the mix is
  // pointless — fall back to the same native <audio> path the share page uses.
  if (results[0] && results[0].status === "rejected") {
    setStudioStatus("");
    playNativeTrack(commit, null, (results[0].reason && results[0].reason.message) || "audio would not decode");
    return;
  }
  // Resume again (awaited) so the clock is definitely running before any source
  // is scheduled — decoding may have taken seconds.
  const running = await ensureCtxRunning(ctx);
  if (audioEngine.ctx !== ctx) return; // stopped while resuming
  if (!running) {
    setStudioStatus("");
    playNativeTrack(commit, null, "the audio context would not start");
    return;
  }
  const startAt = ctx.currentTime + 0.05;
  const failed = [];
  for (const r of results) {
    if (r.status === "rejected") {
      failed.push(r.reason);
      continue;
    }
    const { c, offset, layer } = r.value;
    try {
      scheduleLayer(
        ctx,
        layer,
        offset,
        Math.max(0, (Number(c.start_time) || 0) - (Number(c.lead) || 0)),
        r.value.dur !== undefined ? r.value.dur : takeDuration(c),
        startAt,
        undefined,
        r.value.gain !== undefined ? r.value.gain : commitVolume(c)
      );
    } catch (err) {
      failed.push(new Error(commitHash(c.id) + ": " + err.message));
    }
  }
  // The mix is scheduled — but only claim it once the context has actually
  // started (clock past the scheduled start). A browser-held-back context
  // accepts every source and stays silent; the old code marked the row blue and
  // said “▶ playing” anyway, which needed a ■ Stop + second play to recover.
  const mixStarted = await confirmMixStarted(ctx, startAt);
  if (audioEngine.ctx !== ctx) return; // stopped or superseded while verifying
  if (!mixStarted) {
    // Still nothing audible — play the commit's own file through the native
    // <audio> element so this first press makes sound (closeAudio() inside
    // playNativeTrack() tears the silent mix down).
    setStudioStatus("");
    playNativeTrack(commit, null, "the Web Audio mix wouldn't start");
    return;
  }
  const row = document.querySelector(`.rc-commit[data-commit="${commit.id}"]`);
  if (row) row.classList.add("playing");
  hub.playing = { repoId: commit.repo_id, commitId: commit.id };
  syncPlayState();
  if (failed.length) {
    setStudioStatus("⚠ " + failed.length + " layer(s) couldn't be decoded for playback on this browser — " + failed[0].message, true);
  } else {
    setStudioStatus(`▶ playing ${commitHash(commit.id)} (Web Audio mix)`);
  }
  countRepoPlay(commit.repo_id);
}

/* Native <audio>-element playback so a recording ALWAYS makes sound. On iOS
   this is the primary path (identical to the /music/:id share page, which is
   proven to play on the phone); on desktop it's the fallback when Web Audio
   can't start. Plays the commit's own file as a single track. */
function playNativeTrack(commit, extra, reason) {
  closeAudio();
  const url = commit && commit.url;
  if (!url) {
    setStudioStatus("⚠ can't play this recording — no audio file.", true);
    return;
  }
  const row = document.querySelector(`.rc-commit[data-commit="${commit.id}"]`);
  const el = new Audio(audioUrl(url));
  el.preload = "auto";
  routeElToOutput(el); // chosen output device (e.g. headphones), not the OS default speakers
  let started = false;
  const showErr = () => {
    if (started) return;
    started = true;
    setStudioStatus(`⚠ couldn't play this recording here — ${reason ? reason + " — " : ""}open the share link or try a desktop browser.`, true);
  };
  el.onerror = showErr;
  el.onplaying = () => {
    if (started) return;
    started = true; // audio is actually sounding — only now may the row go blue
    if (row) row.classList.add("playing");
    hub.playing = { repoId: commit.repo_id, commitId: commit.id };
    syncPlayState();
    setStudioStatus(`▶ playing ${commitHash(commit.id)} (browser audio)`);
  };
  el.onended = () => { if (started) stopPlayback(); };
  // A take's WAV starts at the backing's beginning, so skip its count-in ticks
  // by starting at (start_time − lead); the root commit sits at 0.
  const start = Math.max(0, (Number(commit.start_time) || 0) - (Number(commit.lead) || 0));
  if (start > 0) el.currentTime = start;
  el.play().catch((e) => {
    if (started) return;
    // iOS blocks play() outside a gesture — retry on the next tap.
    if (e && e.name === "NotAllowedError") {
      const retry = () => {
        if (started) return;
        el.play().catch(showErr);
        window.removeEventListener("touchend", retry);
        window.removeEventListener("click", retry);
      };
      window.addEventListener("touchend", retry, { once: true });
      window.addEventListener("click", retry, { once: true });
      setStudioStatus("▶ tap the play button again", false);
      return;
    }
    showErr();
  });
  audioEngine.elements.push(el);
  if (commit && commit.repo_id) countRepoPlay(commit.repo_id);
}

/* Promise-style startRendering with a callback fallback (old iOS). */
function renderOffline(mix) {
  return new Promise((resolve, reject) => {
    try {
      const p = mix.startRendering();
      if (p && typeof p.then === "function") p.then(resolve, reject);
      else mix.oncomplete = (e) => resolve(e.renderedBuffer);
    } catch (err) {
      reject(err);
    }
  });
}

/* Stereo 16-bit PCM WAV encoder for the rendered mix, written in chunks that
   yield to the UI between passes. A full-length mix can be tens of MB — the old
   single blocking loop of millions of setInt16 calls froze the page for the
   whole encode and could NOT be abandoned when the caller's deadline passed (the
   zombie encode then kept jamming the phone's only JS thread while the fallback
   tried to play). Each chunk now checks the abort signal, yields, and reports
   progress so the UI can say “encoding the mix… 45%”. Returns a WAV Blob. */
async function encodeWavStereo(ch0, ch1, rate, opts) {
  const n = Math.min(ch0.length, ch1.length);
  if (!n) return null;
  const CHUNK = 65536; // samples per pass — a UI yield roughly every 0.3-0.6 s on a phone
  const dataBytes = n * 4; // 2 channels × 2 bytes
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  const pcm = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0);
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);   // PCM
  dv.setUint16(22, 2, true);   // stereo
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  ascii(36, "data");
  dv.setUint32(40, dataBytes, true);
  for (let base = 0; base < n; base += CHUNK) {
    if (opts && opts.signal && opts.signal.aborted) throw mixCancelError();
    const end = Math.min(n, base + CHUNK);
    let o = 44 + base * 4;
    for (let i = base; i < end; i++) {
      dv.setInt16(o, pcm(ch0[i] * 32767), true); o += 2;
      dv.setInt16(o, pcm(ch1[i] * 32767), true); o += 2;
    }
    if (opts && opts.onProgress && end < n) {
      try { opts.onProgress(Math.min(1, end / n)); } catch (_) {}
    }
    if (end < n) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* iOS full-chain playback: render the whole layered mix OFFLINE (an
   OfflineAudioContext does pure DSP with no output, so iOS can't drop it — the
   silent-clock problem only affects live AudioContext sources) and play the
   resulting WAV through the same native <audio> element the share page uses.
   Offsets/gains mirror the desktop mix exactly, so the volume balance matches
   the PC browser. Falls back to the commit's own file if the render fails. */
async function playIOSMix(commit, extra) {
  closeAudio();
  // Any in-flight render is now superseded, whatever path this attempt takes
  // (fast-path native playback included) — stop it instead of letting a late
  // blob mount an <audio> element behind the new playback.
  if (iosMixActiveJob) {
    try { iosMixActiveJob.abort(); } catch (_) {}
    iosMixActiveJob = null;
  }
  if (!commit || !commit.url) {
    playNativeTrack(commit, null, "no audio file");
    return;
  }
  // Fast path: a lone-commit chain (a plain recording, or the repo root) IS its
  // own file — an offline render would re-encode identical audio while costing
  // the phone the mix's full memory and latency. Skip straight to native playback.
  if (!extra && buildChain(commit).length === 1) {
    playNativeTrack(commit, null, null);
    return;
  }
  setStudioStatus("▶ mixing…", false);
  const token = ++iosMixPlaySeq;
  let blob = null;
  let job = null;
  try {
    // mixRenderJob aborts a stuck/superseded render instead of leaving it to
    // burn phone CPU behind the fallback, and reports live encode progress.
    job = mixRenderJob(commit, extra, 0, {
      ms: 45000,
      onStage: (s) => { if (iosMixPlaySeq === token) setStudioStatus("▶ mixing… " + s, false); },
    });
    iosMixActiveJob = job;
    blob = await job;
  } catch (err) {
    if (iosMixActiveJob === job) iosMixActiveJob = null;
    if (token !== iosMixPlaySeq) return; // superseded while rendering
    setStudioStatus(`⚠ couldn't render the layered mix on this phone (${err.message}) — playing the commit alone.`, true);
    playNativeTrack(commit, extra, "mix render failed");
    return;
  }
  if (token !== iosMixPlaySeq) return; // superseded — its own attempt owns the UI now
  if (iosMixActiveJob === job) iosMixActiveJob = null;
  const mixUrl = URL.createObjectURL(blob);
  const row = document.querySelector(`.rc-commit[data-commit="${commit.id}"]`);
  const el = new Audio();
  el.preload = "auto";
  routeElToOutput(el); // keep the rendered mix on the chosen output device
  el._mixUrl = mixUrl; // revoked in closeAudio
  let started = false;   // terminal: gave up / fell back
  let confirmed = false; // playback verified — the playhead actually advanced
  let attempt = 0;       // play() attempts for this blob
  let stallCheck = null; // watchdog for a "playing" element that never advances
  // Still the active attempt? false once playing, or after closeAudio()/giveUp()
  // superseded this element (e.g. the user re-tapped play on another commit).
  const live = () => !started && el._mixUrl === mixUrl;
  const stopWatchdog = () => { if (stallCheck) { clearTimeout(stallCheck); stallCheck = null; } };
  const release = () => {
    stopWatchdog();
    try { URL.revokeObjectURL(mixUrl); } catch (_) {}
    el._mixUrl = null;
  };
  const giveUp = (why) => {
    if (!live()) return;
    started = true;
    release();
    // The commit's own file over a server URL is the proven iOS playback path —
    // better than leaving the user stuck on "mixing…".
    setStudioStatus(`⚠ couldn't play the rendered mix (${why}) — playing the recording alone.`, true);
    playNativeTrack(commit, extra, "rendered mix didn't start");
  };
  /* The row may only go blue once the element is demonstrably advancing. iOS
     fires "playing" even when nothing actually comes out (a previous element
     still holding the audio focus, or a media session stalled right after a
     recording), which is exactly the "shows playing, no sound" report that then
     needed ■ Stop + a second play to release it. */
  const markPlaying = () => {
    if (confirmed || el._mixUrl !== mixUrl) return;
    confirmed = true;
    started = true; // this element's lifecycle is settled
    stopWatchdog(); // keep _mixUrl — closeAudio() revokes it with the element
    if (row) row.classList.add("playing");
    hub.playing = { repoId: commit.repo_id, commitId: commit.id };
    syncPlayState();
    setStudioStatus(`▶ playing ${commitHash(commit.id)} (rendered mix)`);
    if (commit.repo_id) countRepoPlay(commit.repo_id);
  };
  const tryPlay = () => {
    if (!live()) return;
    attempt++;
    el.play().catch((e) => {
      if (!live()) return;
      // The render is async, so by the time play() runs the original tap's
      // gesture is long gone and iOS blocks it (NotAllowedError) — even though
      // the same mix plays fine on the next tap. Retry on the next touch,
      // exactly like playNativeTrack does for single-track playback.
      if (e && e.name === "NotAllowedError") {
        const retry = () => {
          if (!live()) return;
          el.play().catch(() => { if (live()) giveUp("tap retry failed"); });
          window.removeEventListener("touchend", retry);
          window.removeEventListener("click", retry);
        };
        window.addEventListener("touchend", retry, { once: true });
        window.addEventListener("click", retry, { once: true });
        setStudioStatus("▶ tap to play the rendered mix", false);
        return;
      }
      // One automatic retry covers a spurious first-attempt error (iOS can
      // error before a blob URL is fully loaded); only then give up.
      if (attempt < 2) {
        setTimeout(tryPlay, 400);
        return;
      }
      giveUp((e && e.message) || e || "play failed");
    });
  };
  el.onerror = () => { if (live()) giveUp("load failed"); };
  el.onplaying = () => {
    if (!live()) return;
    started = true; // the element reports playback — but that alone isn't proof
    if (stallCheck) clearTimeout(stallCheck);
    // A fresh element that "plays" silently would otherwise leave a blue row
    // over nothing. Give the playhead a moment to move; when it never does, fall
    // back to the commit's own file (closeAudio() inside playNativeTrack()
    // unloads this element and starts a new one — the same release the user
    // used to get by hand).
    stallCheck = setTimeout(() => {
      if (confirmed || el._mixUrl !== mixUrl) return;
      confirmed = true; // a late timeupdate must not claim it now
      release();
      setStudioStatus("⚠ the rendered mix started silently — playing the recording alone.", true);
      playNativeTrack(commit, extra, "rendered mix was silent");
    }, 1500);
    if ((el.currentTime || 0) > 0) markPlaying(); // some engines jump straight past 0
  };
  el.ontimeupdate = () => {
    if ((el.currentTime || 0) > 0) markPlaying();
  };
  el.onended = () => { if (started) stopPlayback(); };
  // Don't call play() until the blob URL is actually loadable — on iOS, play()
  // too early (or after the async render, outside the tap's gesture) fires a
  // spurious error even though the same mix plays fine on a retry.
  el.src = mixUrl;
  let armed = false;
  const arm = () => {
    if (armed || !live()) return;
    armed = true;
    tryPlay();
  };
  el.addEventListener("loadedmetadata", arm, { once: true });
  el.addEventListener("canplay", arm, { once: true });
  // Readiness never arrived (huge mix / slow blob) — try anyway, then bail out
  // so the UI is never left stuck on "mixing…".
  const bail = setTimeout(() => {
    if (!live()) return;
    arm();
    setTimeout(() => { if (live()) giveUp("timed out"); }, 4000);
  }, 8000);
  audioEngine.elements.push(el);
  // The play is counted by markPlaying() — only once the mix is really sounding.
}

/* One OfflineAudioContext reused for decode-only work across every iOS render.
   decodeAudioData is stateless, so a single decoder serves all renders. iOS
   caps WebAudio contexts (~4/page) and an OfflineAudioContext that stays
   referenced is never released by the runtime, so the old per-play `dec` +
   `mix` pair leaked TWO contexts per playback. After a record session (root
   play → take analysis → "with original" preview) the FIRST play of the
   freshly-committed overlay created two more and blew the cap — the render
   threw and playback fell back to the commit's own file (the solo take only).
   The second play worked because iOS had meanwhile collected the completed
   render contexts. Reusing the decoder keeps every play at ONE new context
   (the mix), which is transient: it drops out of scope once rendered and is
   collected by the engine (OAC has no close() on spec-compliant engines; see
   the finally below). */
let iosMixDecoder = null;

/* Cancellation bookkeeping for playIOSMix: an iOS full-chain render can be in
   flight while the user re-taps another commit (or the same one) — the new
   attempt aborts the old job (see mixRenderJob) and the seq guard drops a blob
   that arrives for a superseded attempt, so no stale <audio> element is ever
   mounted behind the current playback. */
let iosMixPlaySeq = 0;      // incremented by every playIOSMix attempt
let iosMixActiveJob = null; // the in-flight mixRenderJob, if any

/* Decode every chain layer, render the mix offline, and return a WAV Blob.
   fromRoot (> 0) renders only the tail from that root position — used by the
   record-setup "Listen from here" audition so the singer hears the same
   mid-song backing the take will start with. opts: { signal (aborts decode /
   render / encode at the next safe stage), onStage(msg), lowMemory (adaptive
   mix rate for phone previews), rate (explicit sample rate override) }. Called
   through mixRenderJob — every caller runs under its deadline. */
async function renderIOSMixBlob(commit, extra, fromRoot, opts) {
  opts = opts || {};
  const signal = opts.signal || null;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const dec = iosMixDecoder || (iosMixDecoder = new OAC(2, 1, 44100)); // decoder only — its length is irrelevant
  const F = Math.max(0, Number(fromRoot) || 0);
  const stage = (msg) => { if (opts.onStage) { try { opts.onStage(msg); } catch (_) {} } };
  const aborted = () => !!(signal && signal.aborted);
  const abortCheck = () => { if (aborted()) throw mixCancelError(); };
  const layers = [];
  // Decode the chain layers in PARALLEL (the old serial fetch + decode added the
  // phone's full network latency for every layer) and cancel the whole job the
  // moment the caller's deadline passes (see mixRenderJob) so a slow render stops
  // instead of keeping burning CPU / WebKit contexts behind the fallback.
  const chain = buildChain(commit);
  const chainRes = await allSettled(
    chain.map(({ commit: c }) => decodeLayer(dec, c.url, signal).then((layer) => ({ c, layer })))
  );
  abortCheck();
  // The requested commit (the last entry — buildChain walks it up to the root)
  // must itself decode; without it there is nothing new to hear and the caller
  // falls back to that commit's own file. Ancestors that won't decode are
  // skipped, mirroring the desktop mix.
  const head = chain[chain.length - 1];
  for (let i = 0; i < chainRes.length; i++) {
    const r = chainRes[i];
    const c = chain[i].commit;
    if (r.status === "rejected") {
      if (c.id === head.id || chain.length === 1) throw r.reason instanceof Error ? r.reason : mixCancelError();
      continue;
    }
    const layer = r.value.layer;
    const win = layerReadWindow(c, layer.buffer.duration, F);
    if (!win) continue; // this layer finished before fromRoot
    layers.push({
      buffer: layer.buffer,
      offset: win.whenOffset,
      readOff: win.readStart,
      dur: win.readDur,
      gain: commitVolume(c),
    });
  }
  if (extra && extra.url) {
    // The "with original" preview overlay is just another chain layer to read:
    // its take content spans [start_time, start_time + duration] on the root
    // timeline (a finite duration; without one it plays the buffer's tail).
    let layer;
    try {
      layer = await decodeLayer(dec, extra.url, signal);
    } catch (err) {
      throw err instanceof Error ? err : mixCancelError();
    }
    abortCheck();
    const preview = {
      lead: Math.max(0, Number(extra.lead) || 0),
      start_time: Math.max(0, Number(extra.start_time) || 0),
      end_time: extra.duration ? Math.max(0, Number(extra.start_time) || 0) + extra.duration : null,
    };
    const win = layerReadWindow(preview, layer.buffer.duration, F);
    if (win) {
      layers.push({
        buffer: layer.buffer,
        offset: win.whenOffset,
        readOff: win.readStart,
        dur: win.readDur,
        gain: extra.volume,
      });
    }
  }
  if (!layers.length) throw new Error("nothing to hear from that point — the song has already ended there");
  // Total length = the latest end across all sources (root plays to its end).
  let total = 1;
  for (const l of layers) {
    const bufDur = l.buffer.duration || 0;
    const readOff = Math.min(l.readOff, Math.max(0, bufDur - 0.001));
    const readDur = l.dur != null ? l.dur : Math.max(0.05, bufDur - readOff);
    total = Math.max(total, l.offset + readDur);
  }
  abortCheck();
  stage("rendering the layered mix…");
  // Phone renderers are memory-starved: a 5-minute song at 44.1 kHz stereo is
  // ~100 MB of offline output alone and the WAV encode doubles that — enough to
  // kill the mix on an older phone. Long renders therefore mix at 22.05 kHz:
  // half the samples, the same stereo image, and roughly half the peak memory
  // and encode time — inaudible for a voice-over-music audition. Desktop export
  // passes lowMemory:false and keeps the full 44.1 kHz.
  const fullRate = 44100;
  const mixRate =
    opts.rate && opts.rate > 0
      ? opts.rate
      : opts.lowMemory && total > 90
        ? 22050
        : fullRate;
  const len = Math.min(600, Math.max(1, total)) * mixRate; // ≤ 10 min safety cap
  const mix = new OAC(2, Math.ceil(len), mixRate);
  try {
    for (const l of layers) {
      abortCheck();
      const bufDur = l.buffer.duration || 0;
      const readOff = l.readOff >= bufDur ? Math.max(0, bufDur - 0.001) : l.readOff;
      const readDur = l.dur != null ? l.dur : Math.max(0.05, bufDur - readOff);
      const src = mix.createBufferSource();
      src.buffer = l.buffer;
      const g = mix.createGain();
      g.gain.value = isFinite(l.gain) && l.gain >= 0 ? Math.min(3, l.gain) : 1;
      src.connect(g);
      g.connect(mix.destination);
      src.start(l.offset, readOff, readDur);
    }
    abortCheck(); // deadline passed before the render began — don't start it
    const rendered = await renderOffline(mix);
    abortCheck(); // deadline passed during the render — skip the expensive encode
    stage("encoding the mix…");
    const ch0 = rendered.getChannelData(0);
    const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;
    let lastPct = 0;
    const blob = await encodeWavStereo(ch0, ch1, mixRate, {
      signal,
      onProgress: (pct) => {
        if (opts.onStage && pct - lastPct >= 0.1) {
          lastPct = pct;
          stage("encoding the mix… " + Math.round(pct * 100) + "%");
        }
      },
    });
    if (!blob) throw new Error("mix encode produced nothing");
    return blob;
  } finally {
    // Best-effort release of the render context: OfflineAudioContext inherits
    // BaseAudioContext (not AudioContext), so close() is absent on
    // spec-compliant engines and this is a no-op there — the context is simply
    // left to GC after its render completes. Some engines do expose it
    // (analyzeTake guards the same way), so calling it can only help.
    try { if (typeof mix.close === "function") mix.close().catch(() => {}); } catch (_) {}
  }
}
/* A cancellable offline mix with a hard deadline. Returns a Promise for the WAV
   Blob plus an `.abort()` method: calling abort() (or the deadline elapsing)
   stops the decode / render / encode through the shared AbortController, so a
   superseded or too-slow render actually stops instead of keeping burning the
   phone's CPU and WebKit contexts behind whatever fallback the caller showed.
   The caller still awaits the returned promise — the race below resolves it at
   deadline + 1.5 s so an abort that lands mid-OfflineAudioContext (which can't
   be interrupted) still settles — and reads `err.message` from the same
   mixCancelError() every stage throws. Stage messages ("rendering the layered
   mix…", "encoding the mix… 40%") arrive via opts.onStage when the caller wants
   live progress in its UI. lowMemory:false (export) keeps the 44.1 kHz output;
   audition/preview defaults to the phone-friendly adaptive rate. */
function mixRenderJob(commit, extra, F, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const ms = opts.ms || 45000;
  const hard = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, ms);
  const job = Promise.race([
    renderIOSMixBlob(commit, extra, F, {
      signal: ctl.signal,
      onStage: opts.onStage,
      lowMemory: opts.lowMemory !== false,
      rate: opts.rate,
    }),
    new Promise((_, reject) => setTimeout(() => reject(mixCancelError()), ms + 1500)),
  ]).then(
    (blob) => { clearTimeout(hard); return blob; },
    (err) => { clearTimeout(hard); throw err; }
  );
  job.abort = () => { try { ctl.abort(); } catch (_) {} };
  return job;
}



/* "Take only" preview. Native <audio> with a blob: URL is unreliable on iOS
   Safari, so if the element can't start quickly, decode the in-memory blob
   through Web Audio instead (WAV always decodes). */
function playDry(url, start) {
  closeAudio();
  const el = new Audio(url);
  routeElToOutput(el); // route the take preview to the chosen output device
  let done = false;
  const fallback = () => {
    if (done) return;
    done = true;
    try { el.pause(); el.removeAttribute("src"); el.load(); } catch (_) {}
    playBlobViaWebAudio(url, start);
  };
  el.onerror = fallback;
  const t = setTimeout(fallback, 4000);
  el.onplaying = () => {
    if (done) return;
    done = true;
    clearTimeout(t);
    setStudioStatus("▶ take preview");
  };
  if (isFinite(start) && start > 0) el.currentTime = start;
  el.play().catch(fallback);
  audioEngine.elements.push(el);
}

/* Decode a blob: URL and play it through Web Audio (hardened resume). Used by
   playDry when the phone won't play the blob in a native <audio> element. */
async function playBlobViaWebAudio(url, start) {
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_) { ctx = null; }
  if (!ctx) {
    setStudioStatus("⚠ this browser can't preview the take.", true);
    return;
  }
  audioEngine.ctx = ctx;
  if (!(await preparePlaybackContext(ctx))) {
    if (audioEngine.ctx === ctx) audioEngine.ctx = null;
    try { ctx.close().catch(() => {}); } catch (_) {}
    setStudioStatus("⚠ this browser can't preview the take.", true);
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("could not load the take");
    const ab = await res.arrayBuffer();
    const buffer = await decodeAudioCompat(ctx, ab);
    if (!audioEngine.ctx) return;
    const off = Math.max(0, Number(start) || 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(ctx.currentTime + 0.05, off < buffer.duration ? off : 0);
    audioEngine.sources.push(src);
    setStudioStatus("▶ take preview");
  } catch (err) {
    // Don't leak the context on iOS (4-context cap) after a failed preview.
    try { ctx.close().catch(() => {}); } catch (_) {}
    if (audioEngine.ctx === ctx) audioEngine.ctx = null;
    setStudioStatus("⚠ couldn't preview the take on this browser — " + err.message, true);
  }
}

let lastPlayCountRepo = null;
function countRepoPlay(repoId) {
  if (lastPlayCountRepo === repoId) return;
  lastPlayCountRepo = repoId;
  fetch(`/api/recordings/${repoId}/play`, { method: "POST" }).catch(() => {});
}

function stopPlayback() {
  closeAudio();
  setStudioStatus("");
}


/* ── Studio / recording ────────────────────────────────── */
/* A take session: the checked-out commit's chain is used as backing — unless
   "No backing" is ticked in the record-setup dialog, in which case the song is muted
   and the take is a cappella to the count-in ticks. Either way ONLY the dry
   mic is recorded: the backing is never routed into the take, and the mic is
   routed to the speakers only when the optional monitor is on — an output-only
   parallel path (monitorInput), so it can never leak into the recorded take.
   Previewing/committing is done afterwards.

   iOS/WebKit caveat: the moment ANY mic capture is live, WebKit forces the
   page's audio session to PlayAndRecord + DefaultToSpeaker (WebCore
   MediaSessionManagerCocoa / AudioSessionIOS) — on iPhone the song, count-in
   and 监听 monitor all play from the phone's own speaker during a take, and no
   page code can redirect them (WebKit exposes no output-device API). That is a
   platform constraint of every recording flow here, not something this session
   does wrong. */
const studio = {
  stream: null,
  recorder: null,
  monitor: null, // { src, splitter, gain } live monitor — output-only, never recorded
  pick: "both",  // input channel resolved for this session: "both" | "L" | "R"
  blob: null,
  blobUrl: null,
  takeDuration: 0,
  takeStartGuess: 0,  // auto-detected audible start, pre-filled in commit modal
  takeEndGuess: 0,    // auto-detected audible end, pre-filled in commit modal
  timerId: null,
  startTimer: null,
  countdownTimer: null,
  takeStart: 0,
  recording: false,
  cancelled: false,
  backingCommit: null,
  sessionFrom: 0, // root position where this take's session begins — 0 = song's start; mid-song = the chosen “start point” minus the TAKE_PRE_ROLL lead-in, so the last count-in tick lands exactly on the point
  lead: 0, // root-timeline position of the take blob's zero = sessionFrom (minus the sync-delay compensation when the take was sung along with the audible backing); the mix reads the blob from (start_time − lead)
  takeCompEnabled: false, // this session qualifies for sync-delay compensation (mid-song AND backing audible) — a-cappella / whole-song sessions never compensate
  sessionLatencyMs: 0,    // round-trip (output + input) latency measured from the browser for this session's recording chain
  latencyCompMs: 0,       // sync delay backed out of `lead` — 0 unless takeCompEnabled
};

/* Seconds of audible count-in after the backing starts (four ticks cueing
   "start singing as the last one ends"). The recorder starts together with the
   backing at the session's chosen start point on the song timeline
   (studio.sessionFrom), so a take captures everything from that instant and is
   placed at mix time by its own detected start_time (lead = sessionFrom, minus
   the sing-along sync-delay compensation — see applyLatencyComp). The
   pre-roll, ticks, and any DSP convergence at the blob's start are never heard
   because the mix reads the blob from (start_time − lead). */
const TAKE_PRE_ROLL = 1.5;

function setStudioStatus(text, isError) {
  const el = document.getElementById("studio-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

function setRecordUI(recording) {
  const btn = document.getElementById("record-take-btn");
  if (!btn) return;
  btn.disabled = recording;
  btn.textContent = recording ? "… recording" : "● Record Take";
}

function updateTakeTimer() {
  const t = document.getElementById("take-timer");
  if (!t) return;
  t.textContent = studio.takeStart ? fmtTime((Date.now() - studio.takeStart) / 1000) : "0:00";
}

/* Mic capture is shared by the initial-recording and take-session paths.
   Explicit processing flags keep the voice clean, and the RAW getUserMedia
   stream is recorded directly — never routed through the Web Audio graph
   (createMediaStreamSource → createMediaStreamDestination), which resamples
   the mic to the context's sample rate and audibly degrades the take.
   echoCancellation also cancels any backing that bleeds from the speakers
   into the mic, so playback can't contaminate the recorded take. */
const RECORD_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  // autoGainControl off: the browser's adaptive gain "pumps" when the voice
  // first enters (gain swells, then pulls back) — the "warm-up / adjust" sound
  // at the top of a take. Fixed gain keeps the take level stable; any quietness
  // is recoverable with the commit Volume slider.
  autoGainControl: false,
  channelCount: 1,
};

const STUDIO_PHONES_KEY = "studio_headphones";
const STUDIO_MUTE_BACKING_KEY = "studio_mute_backing";
const STUDIO_CHANNEL_KEY = "studio_input_channel";
const STUDIO_MONITOR_KEY = "studio_monitor";
const STUDIO_OUTPUT_KEY = "studio_output_device";
// Sing-along sync calibration in MILLISECONDS, remembered per device/browser.
// A take sung while the backing is audible lands ~round-trip late (see
// applyLatencyComp); the Review dialog's “Sync delay (ms)” tunes the value on
// the device it was recorded on and this key keeps it for the next take there.
const STUDIO_TAKE_DELAY_KEY = "studio_take_delay_ms";

/* Level of the optional input monitor (0..1). The monitor is a parallel
   output-only path — the take recorder's sink gain stays pinned to 0, so
   monitoring can never leak into the WAV. */
const MONITOR_VOLUME = 0.7;

/* Which input channel to record + monitor: "both" (full mix, the default),
   "L" (interface input 1) or "R" (interface input 2). Set in the record-setup
   dialog (openRecordSetup); read by both the take and new-recording paths. */
function inputChannelForTake() {
  const v = localStorage.getItem(STUDIO_CHANNEL_KEY);
  return v === "L" || v === "R" ? v : "both";
}

function monitorForTake() {
  return localStorage.getItem(STUDIO_MONITOR_KEY) === "1";
}

/* Audio output device for the app's sounds (backing/count-in/监听 monitor
   during a take, the normal playback mix, take previews). "" means the OS
   system default — which is usually the room speakers. Web Audio can only ever
   reach ctx.destination, so when the singer wears headphones on a SEPARATE
   device the backing would blast from the speakers and bleed into the raw take.
   Choosing a device here renders to that output instead (Chrome/Edge:
   AudioContext.setSinkId) so the song stays in the headphones. Browsers without
   setSinkId silently fall back to the OS default. */
function outputDeviceForTake() {
  const v = localStorage.getItem(STUDIO_OUTPUT_KEY);
  return v && v !== "default" ? v : "";
}

/* Best-effort routing of an AudioContext to the saved output device. Browsers
   without setSinkId, or a saved device that has since been unplugged, silently
   fall back to the system default — never a hard failure. */
async function routeCtxToOutput(ctx) {
  const id = outputDeviceForTake();
  if (!id || !ctx || typeof ctx.setSinkId !== "function") return false;
  try {
    await ctx.setSinkId(id);
    return true;
  } catch (_) {
    return false;
  }
}

/* Bring a freshly created playback context into an audible state BEFORE
   anything is scheduled into it: resume it (the click's gesture is still live),
   route it to the chosen output device, then wait until the context really is
   running with its clock advancing.

   Both steps matter. Resuming inside the gesture satisfies the browser's
   autoplay policy — the take session does the same (resume first, then route) —
   and routing calls AudioContext.setSinkId(), which switches the context's
   output device and re-creates its stream. A source scheduled while that
   hand-off is still in flight can be dropped silently, leaving the hub row
   “playing” over silence until the user presses ■ Stop and plays again (that
   second context starts on an output that has already settled). Waiting for a
   running context whose clock advances keeps the schedule out of that window.
   Returns the context when ready, null when the browser won't start it — the
   caller then plays through a native <audio> element instead. */
async function preparePlaybackContext(ctx) {
  if (!ctx) return null;
  if (!(await ensureCtxRunning(ctx))) return null;
  await routeCtxToOutput(ctx); // may restart the output stream
  for (let i = 0; i < 12; i++) {
    if (ctx.state !== "running" && !(await ensureCtxRunning(ctx))) break;
    const t0 = ctx.currentTime;
    await new Promise((r) => setTimeout(r, 40));
    if (ctx.state === "running" && ctx.currentTime > t0) return ctx;
  }
  return null;
}

/* “Scheduled” is not “audible”: a context the browser holds back (suspended by
   the autoplay policy, or still settling onto a re-created output stream)
   accepts the schedule and never advances. The old code then turned the hub row
   blue and said “▶ playing” over silence, and only ■ Stop + a second play made
   sound. Confirm the mix really started (context still ours, running, clock
   past the scheduled start) before claiming playback: the caller falls back to
   the commit's own file on a native <audio> element when this returns false, so
   the very first press makes sound. */
async function confirmMixStarted(ctx, startAt) {
  for (let i = 0; i < 12; i++) {
    if (!ctx || ctx !== audioEngine.ctx || ctx.state === "closed") return false;
    if (ctx.state === "running" && ctx.currentTime >= startAt + 0.05) return true;
    if (ctx.state !== "running" && !(await ensureCtxRunning(ctx))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !!ctx && ctx === audioEngine.ctx && ctx.state === "running" && ctx.currentTime >= startAt + 0.05;
}

/* Same best-effort routing for the native <audio> fallback path
   (HTMLMediaElement.setSinkId exists on Chrome and recent Safari). */
function routeElToOutput(el) {
  const id = outputDeviceForTake();
  if (!id || !el || typeof el.setSinkId !== "function") return;
  try {
    el.setSinkId(id).catch(() => {});
  } catch (_) {}
}

/* Fill the top bar's output-device <select> (#studio-output — the ONLY place
   playback output is chosen now; the record-setup dialog mirrors it). Browsers
   only reveal the real output labels once speaker-selection permission exists
   (Chrome/Edge navigator.mediaDevices.selectAudioOutput); before that the
   select offers a "Choose…" entry that opens the OS picker. On browsers with
   no picker and no labelled devices the control is hidden and audio simply
   follows the OS default. */
async function populateOutputSelect(selOrId) {
  const sel = typeof selOrId === "string" ? document.getElementById(selOrId) : selOrId;
  if (!sel) return;
  const field = sel.closest ? sel.closest(".rc-field") : null;
  // The CSP is style-src 'self' (no unsafe-inline): visibility must not rely on
  // inline style attributes, so toggle the hidden attribute ([hidden] in
  // style.css) instead of element.style assignments on a markup style.
  const show = () => { (field || sel).hidden = false; };
  const hide = () => { (field || sel).hidden = true; };
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
    hide();
    return;
  }
  const canPick = typeof navigator.mediaDevices.selectAudioOutput === "function";
  let outs = [];
  try {
    outs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audiooutput" && !!d.deviceId && !!d.label
    );
  } catch (_) {}
  // Some OSes list the same output twice — de-dupe by deviceId.
  const seen = {};
  const unique = [];
  for (const d of outs) {
    if (!seen[d.deviceId]) {
      seen[d.deviceId] = true;
      unique.push(d);
    }
  }
  outs = unique;
  if (!outs.length && !canPick) {
    hide(); // only the OS default is reachable — nothing to pick here
    return;
  }
  const saved = outputDeviceForTake();
  const parts = ['<option value="">System default (OS setting)</option>'];
  if (!outs.length) {
    parts.push('<option value="__pick__">Choose headphones / output device…</option>');
  } else {
    for (const d of outs) {
      parts.push(`<option value="${scEscapeHTML(d.deviceId)}">${scEscapeHTML(d.label)}</option>`);
    }
    if (canPick) parts.push('<option value="__pick__">Choose a different output…</option>');
  }
  sel.innerHTML = parts.join("");
  show();
  sel.value = outs.some((d) => d.deviceId === saved) ? saved : "";
  const onChange = async () => {
    const v = sel.value;
    if (v === "__pick__") {
      try {
        const picked = await navigator.mediaDevices.selectAudioOutput();
        if (picked && picked.deviceId) {
          // Persist + re-fill: the picker grants speaker-selection permission,
          // so enumerateDevices now returns every labelled output.
          localStorage.setItem(STUDIO_OUTPUT_KEY, picked.deviceId);
          populateOutputSelect(sel);
        } else {
          sel.value = outputDeviceForTake(); // "Default" was chosen in the picker
          localStorage.setItem(STUDIO_OUTPUT_KEY, "");
        }
      } catch (_) {
        sel.value = outputDeviceForTake(); // user cancelled the picker
      }
      return;
    }
    localStorage.setItem(STUDIO_OUTPUT_KEY, v);
  };
  // populateOutputSelect can run again on the SAME element (after a pick
  // re-fills the options), so drop the previous listener instead of stacking
  // duplicates that would open the picker twice.
  if (sel._rcOutChange) sel.removeEventListener("change", sel._rcOutChange);
  sel._rcOutChange = onChange;
  sel.addEventListener("change", onChange);
}

/* Mute the backing during a take? Default ON ("always"): with the song not
   playing, nothing can bleed from the speakers into the mic, so the take is
   guaranteed clean — the cost is an a cappella take, sung to the count-in
   ticks only. Uncheck it (e.g. when recording in headphones) to sing along
   with the song again. */
function muteBackingForTake() {
  return localStorage.getItem(STUDIO_MUTE_BACKING_KEY) !== "0";
}

/* Mic processing for a take session. The browser's echo canceller + noise
   suppressor are the #1 "first second sounds unclear" culprit: they take a
   moment to adapt when the voice enters and smear the attack. With headphones,
   or when "No backing" is on (nothing is playing, so there is no echo to
   cancel), turn them OFF and record the raw mic. Only when the backing is
   actually playing through speakers do they stay ON — they're the only defense
   against backing bleed. */
function takeMicConstraints(pick) {
  // Picking a specific side (L/R) needs BOTH channels delivered — with 1 we'd
  // only ever see the downmix and could not separate input 1 from input 2.
  const channelCount = pick !== "both" ? 2 : 1;
  if (isIOS()) {
    // iPhone/iPad capture has no raw bypass: WebKit gates its voice-processing
    // gain behind echoCancellation, so asking for EC/NS/AGC all off makes Safari
    // hand back a very quiet (near-silent) mic track. Keep the voice path on AND
    // let iOS apply its own input gain (autoGainControl true) — with AGC forced
    // off even a normal voice through a phone mic or a quiet 声卡 preamp records
    // far too small. The dialog flags still work (Monitor still connects,
    // No-backing still mutes the song); only the capture keeps Safari's own
    // DSP + gain so a phone recording has a normal level.
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  }
  if (monitorForTake() || localStorage.getItem(STUDIO_PHONES_KEY) === "1" || muteBackingForTake()) {
    return { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount };
  }
  return { ...RECORD_AUDIO_CONSTRAINTS, channelCount };
}

/* iOS Safari identifies itself; its WebKit engine also powers Chrome/Firefox
   on iPhone/iPad. */
function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (typeof navigator.platform === "string" &&
      navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1)
  );
}

/* Encode recorded Float32 mono samples into a 16-bit PCM WAV Blob. WAV is the
   one container every Web Audio decodeAudioData (including Safari/iOS) can
   decode, so recording directly to WAV means a take is playable on every
   browser with no transcode step. */
function encodeWav(chunks, inRate, outRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) return null;
  const ratio = inRate / outRate;
  const max = Math.max(1, Math.round(total / ratio));
  const out = new Int16Array(max);
  let o = 0;
  let acc = 0;
  let cnt = 0;
  let nextOut = 1; // output sample index the running average is being built toward
  const push = () => {
    let s = (acc / cnt) * 32767;
    out[o++] = s > 32767 ? 32767 : s < -32768 ? -32768 : s | 0;
    acc = 0;
    cnt = 0;
  };
  let src = 0;
  for (let k = 0; k < chunks.length; k++) {
    const ch = chunks[k];
    for (let i = 0; i < ch.length; i++) {
      acc += ch[i];
      cnt++;
      src++;
      // Emit one averaged output sample whenever the cumulative input count
      // crosses the next output boundary. Averaging over fractional groups
      // (2–3 samples per output) resamples any context rate correctly —
      // `cnt >= ratio` would instead collapse 48 kHz → 22050 Hz into 16 kHz.
      if (src >= nextOut * ratio) {
        nextOut++;
        push();
      }
    }
  }
  if (cnt > 0 && o < max) push();
  const n = o;
  const dataBytes = n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);   // PCM
  dv.setUint16(22, 1, true);   // mono
  dv.setUint32(24, outRate, true);
  dv.setUint32(28, outRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, "data");
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, out[i], true);
  return new Blob([buf], { type: "audio/wav" });
}

/* One recorder interface for a take session. The mic is captured through the
   AudioContext into a 22050 Hz mono 16-bit WAV on every browser — the one
   container every Web Audio decodeAudioData (including iOS Safari) accepts.
   The blob timeline starts at the same instant the backing starts, so
   onTakeStopped aligns the take purely by its detected start_time. */
function createTakeRecorder(ctx, stream, pick) {
  return createRecorder(ctx, stream, {
    // The recorder assembles the WAV itself (createRecorder → encodeWav); it is
    // delivered whole in onStop. No per-buffer accumulation needed here.
    onData: () => {},
    onStop: (wavBlob) => onTakeStopped(wavBlob),
  }, pick);
}

/* Shared mic→recorder factory — PCM → WAV capture through an AudioContext on
   every browser (no MediaRecorder): guarantees a WAV take everywhere. */
function createRecorder(ctxIn, stream, handlers, pick) {
  // PCM → WAV capture through an AudioContext.
  const ownCtx = !ctxIn;
  const ctx = ctxIn || new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  // Picking a specific side (L/R) needs BOTH input channels: a 1-input
  // ScriptProcessor downmixes the stereo stream to mono before the callback,
  // which would lose the side we must keep.
  const proc = ctx.createScriptProcessor(4096, pick !== "both" ? 2 : 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0; // pull the graph without feeding the mic back to the speakers
  src.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  const pcm = [];
  let running = false;
  let stopped = false;
  proc.onaudioprocess = (e) => {
    if (!running) return;
    const ib = e.inputBuffer;
    const c0 = ib.getChannelData(0);
    if (pick === "L") {
      // interface input 1 only
      pcm.push(new Float32Array(c0));
      return;
    }
    if (pick === "R" && ib.numberOfChannels > 1) {
      // interface input 2 only (a mono source upmixes both sides to the same
      // signal, so this stays safe even if the device delivered one channel)
      pcm.push(new Float32Array(ib.getChannelData(1)));
      return;
    }
    if (ib.numberOfChannels > 1) {
      const c1 = ib.getChannelData(1);
      const m = new Float32Array(c0.length);
      for (let i = 0; i < c0.length; i++) m[i] = (c0[i] + c1[i]) / 2;
      pcm.push(m);
    } else {
      pcm.push(new Float32Array(c0));
    }
  };
  return {
    get mimeType() { return "audio/wav"; },
    get state() { return stopped ? "inactive" : running ? "recording" : "inactive"; },
    start: () => { running = true; ctx.resume().catch(() => {}); },
    stop: () => {
      if (stopped) return;
      stopped = true;
      running = false;
      try { src.disconnect(); proc.disconnect(); sink.disconnect(); } catch (_) {}
      if (ownCtx) ctx.close().catch(() => {});
      handlers.onStop(encodeWav(pcm, ctx.sampleRate || 44100, 22050));
    },
  };
}

/* ── Sing-along sync (latency compensation) ───────────────────────────────
   A take sung while the backing is AUDIBLE is recorded late by the device's
   round trip: the phrase the singer follows is heard ~output latency after its
   root-timeline point, and the capture path adds ~input latency before the
   voice lands in the take blob. The take's blob zero (lead) is pulled earlier
   by that amount so the recorded phrase sits where it was sung — `lead` is the
   only knob that moves recorded content, because every mix path maps
   blob position p to root (lead + p) and reads the blob from (start_time −
   lead). The compensation rides the commit's `lead` metadata, so the live
   mix, the iOS offline render, the share page and later mid-song sessions all
   inherit it with no schema or server change. Browsers expose the round trip
   only partially (Chromium: AudioContext.baseLatency/outputLatency + the mic
   track's input latency; Safari: none of them), so the Review dialog's “Sync
   delay (ms)” tunes the value on the actual device once and applyLatencyComp
   reuses the saved calibration from then on. */

function measureTakeRoundTripLatency(ctx, stream) {
  let secs = 0;
  if (ctx) {
    const b = Number(ctx.baseLatency);
    const o = Number(ctx.outputLatency);
    if (isFinite(b) && b > 0) secs += b;
    if (isFinite(o) && o > 0) secs += o;
  }
  try {
    const track = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
    const s = track && typeof track.getSettings === "function" ? track.getSettings() : null;
    const il = s ? Number(s.latency) : NaN;
    if (isFinite(il) && il > 0) secs += il;
  } catch (_) {}
  return Math.max(0, secs);
}

function storedTakeDelayMs() {
  const v = parseInt(localStorage.getItem(STUDIO_TAKE_DELAY_KEY) || "", 10);
  return isFinite(v) && v > 0 ? v : 0;
}

/* Cap on sync compensation for a session: blob zero must stay on the root
   timeline (lead ≥ 0 — the blob can't begin before the song's top), and more
   than two seconds of compensation is never a real device round trip. */
function maxTakeDelayMs(sessionFrom) {
  return Math.min(2000, Math.max(0, Math.floor((Number(sessionFrom) || 0) * 1000)));
}

/* Decide + apply this take session's sync compensation to studio.lead. Only a
   mid-song take with the backing audible qualifies — singing along with the
   song is what makes every phrase land late. An a-cappella (“No backing”) or
   whole-song session keeps lead = sessionFrom exactly (as before). */
function applyLatencyComp(ctx, stream) {
  const backingMuted = muteBackingForTake();
  const measured = Math.round(measureTakeRoundTripLatency(ctx, stream) * 1000);
  studio.sessionLatencyMs = measured;
  const canComp = !backingMuted && (studio.sessionFrom || 0) > 0;
  if (!canComp) {
    studio.takeCompEnabled = false;
    studio.latencyCompMs = 0;
    studio.lead = studio.sessionFrom || 0;
    return;
  }
  const saved = storedTakeDelayMs();
  // The browser-measured round trip by default; a saved calibration (this
  // device was tuned on an earlier take) wins over a fresh measurement.
  const base = saved > 0 ? saved : measured;
  studio.takeCompEnabled = true;
  studio.latencyCompMs = Math.min(Math.max(0, Math.round(base)), maxTakeDelayMs(studio.sessionFrom));
  studio.lead = Math.max(0, studio.sessionFrom - studio.latencyCompMs / 1000);
}

async function getUserMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Mic access is blocked: this page is on plain http — serve it over HTTPS to record");
  }
  // Let the user pick the real mic. The OS "default" input is often a
  // loopback / stereo-mix device that records whatever plays (e.g. the
  // backing track) — which is exactly the "parent sound in my take" symptom.
  const sel = document.getElementById("studio-device");
  const deviceId = sel && sel.value ? sel.value : "";
  const pick = inputChannelForTake();
  const constraints = deviceId
    ? { audio: { ...takeMicConstraints(pick), deviceId: { exact: deviceId } } }
    : { audio: takeMicConstraints(pick) };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (_) {
    // Some devices/OS reject an exact deviceId — retry without pinning, but
    // KEEP the processing flags so echo cancellation still strips any backing
    // that bleeds into the mic. Bare browser defaults are the last resort.
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: takeMicConstraints(pick) });
    } catch (_2) {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }
}

/* Optional live monitor: route the mic to the headphones/speakers so the
   player hears their input while recording. This is a PARALLEL output-only
   path — the take recorder still captures the raw stream with its sink gain
   pinned to 0, so monitoring can never leak into the WAV. Browser monitoring
   adds ~20–40 ms of latency (fine for practicing); an interface's hardware
   direct-monitor button (e.g. the Scarlett's) is zero-latency and tighter. */
function monitorInput(ctx, stream, pick) {
  let src;
  try {
    src = ctx.createMediaStreamSource(stream);
  } catch (_) {
    return null; // Web Audio capture unsupported — recording still works
  }
  const g = ctx.createGain();
  g.gain.value = MONITOR_VOLUME;
  // A mono device has nothing to pick: route its one channel to both ears.
  const settings =
    stream.getAudioTracks()[0] && stream.getAudioTracks()[0].getSettings
      ? stream.getAudioTracks()[0].getSettings()
      : null;
  const eff = settings && settings.channelCount === 1 && pick !== "both" ? "both" : pick;
  let splitter = null;
  if (eff === "L" || eff === "R") {
    splitter = ctx.createChannelSplitter(2);
    src.connect(splitter);
    splitter.connect(g, eff === "L" ? 0 : 1, 0); // that side to both ears
  } else {
    src.connect(g);
  }
  g.connect(ctx.destination);
  return { src, splitter, gain: g };
}

/* Fixed backing level during a take session (0..1), applied only when the
   "No backing" setup-dialog toggle is OFF. The backing plays at 70% so it
   rarely bleeds into the take. */
function getBackingVolume() {
  return 0.7;
}

/* Audible count-in ticks over the TAKE_PRE_ROLL pre-roll so the singer knows
   exactly when to start. Four even ticks with a rising pitch; the last one ends
   at the "go" moment (backingStartAt + TAKE_PRE_ROLL), so "sing as the last
   tick ends" = the intended take start. As graph output they sit in the
   browser's AEC echo reference and are cancelled from the mic; even if a sliver
   reaches the blob, the mix reads the take from its own start_time, so ticks
   and pre-roll are never heard. */
function scheduleCountIn(ctx, backingStartAt, chainStartAt, probe) {
  const out = ctx.createGain();
  out.gain.value = 0.45;
  // The ticks are the session's canary: scheduled unconditionally into the
  // session output, so when the take-audio diagnostic sees graphPeak here the
  // graph is producing sound and any silence is the OS output device, not code.
  out.connect(probe || ctx.destination);
  const n = 4;
  const dur = 0.09; // osc length per tick (gain is inaudible after ~when + 0.08)
  const span = chainStartAt - backingStartAt;
  for (let i = 0; i < n; i++) {
    // Position each tick by its END: tick i+1 ends at i+1/n of the pre-roll, so
    // the 4th tick's decay tail finishes just before the recorder starts.
    const end = backingStartAt + (span * (i + 1)) / n;
    const when = end - dur;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 500 + i * 220; // 500, 720, 940, 1160 — rising "go" feel
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, when);
    g.gain.exponentialRampToValueAtTime(0.5, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
    osc.connect(g);
    g.connect(out);
    osc.start(when);
    osc.stop(end);
  }
}

/* Live audio diagnostic for the "silent take" reports. The count-in ticks are
   scheduled unconditionally into the session context, so a running context with
   a live graph MUST be audible; when it is not, this readout says which layer
   broke: the context (suspended/closed right after Start), the graph (signal
   scheduled but silent), or the OS output device (graph peak is loud yet
   nothing is heard — check the Playback output dropdown / system volume).
   Mirrors into the session modal's #take-diag line and the console. */
function attachTakeAudioDiag(ctx, times, probe) {
  if (!ctx) return;
  const buf = probe && probe.fftSize ? new Uint8Array(probe.fftSize) : null;
  const graphPeak = () => {
    if (!buf || !probe) return -1;
    try {
      probe.getByteTimeDomainData(buf);
      let mx = 0;
      for (let i = 0; i < buf.length; i++) {
        const d = Math.abs(buf[i] - 128);
        if (d > mx) mx = d;
      }
      return mx / 128; // 0 = digital silence, ~0.3+ = clearly audible signal
    } catch (_) { return -1; }
  };
  const snap = (label) => {
    let state = "?";
    let now = -1;
    try { state = ctx.state; now = ctx.currentTime; } catch (_) { state = "closed"; }
    let rel = "";
    const bt = times && times.backingStartAt;
    if (bt >= 0 && now >= 0) {
      const d = now - bt;
      rel = d < 0
        ? "ticks begin in " + (-d).toFixed(2) + "s"
        : d < 1.6
          ? "inside the count-in (+" + d.toFixed(2) + "s)"
          : "past the backing start by " + d.toFixed(1) + "s";
    }
    const pk = graphPeak();
    const line = label + " — ctx=" + state + ", clock=" + now.toFixed(3) + "s (" + rel + "), graphPeak=" + (pk < 0 ? "n/a" : pk.toFixed(3));
    console.log("[take-audio-diag] " + line);
    const el = document.getElementById("take-diag");
    if (el) {
      el.hidden = false;
      el.textContent = (el.textContent ? el.textContent + "\n" : "") + line;
    }
  };
  snap("scheduled");
  [700, 1800, 4200].forEach((ms) => setTimeout(() => snap("+" + ms + "ms"), ms));
}

async function populateMicDevices(selOrId) {
  const sel = typeof selOrId === "string" ? document.getElementById(selOrId) : selOrId;
  if (!sel) return;
  // Browsers only expose mic APIs on secure contexts (HTTPS) or localhost.
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    sel.innerHTML = `<option value="">Mic blocked — HTTPS required</option>`;
    return;
  }
  try {
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    if (!mics.length) return;
    // Until mic permission is granted, browsers hide the real device names.
    // Tell the user instead of listing useless "Microphone 1/2" fallbacks.
    if (!mics.some((d) => d.label)) {
      sel.innerHTML = `<option value="">Allow mic access to see devices</option>`;
      return;
    }
    const saved = localStorage.getItem("studio_mic_device") || "";
    sel.innerHTML = mics
      .map((d, i) => `<option value="${scEscapeHTML(d.deviceId)}">${scEscapeHTML(d.label || "Microphone " + (i + 1))}</option>`)
      .join("");
    const match = mics.find((d) => d.deviceId === saved);
    sel.value = (match && match.deviceId) || mics[0].deviceId;
    // populateMicDevices can re-run on the SAME element — every record-setup
    // dialog open refreshes the studio bar's #studio-device list — so drop any
    // previous listener instead of stacking duplicates.
    if (sel._rcMicChange) sel.removeEventListener("change", sel._rcMicChange);
    sel._rcMicChange = () => localStorage.setItem("studio_mic_device", sel.value);
    sel.addEventListener("change", sel._rcMicChange);
  } catch (_) { /* enumerateDevices can throw on some browsers — non-fatal */ }
}

async function startTakeRecording() {
  if (!hub.checkedOut || studio.recording) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStudioStatus("✗ Microphone blocked: this page is on plain http — serve it over HTTPS to record takes.", true);
    return;
  }
  const repoId = hub.checkedOut.repoId;
  const commit = (hub.commits.get(repoId) || []).find((c) => c.id === hub.checkedOut.commitId);
  if (!commit) return;
  studio.recording = true; // guard against double-click while mic + buffers load
  studio.cancelled = false; // fresh session — commit/discard/cancel all leave this true; must reset BEFORE the post-decode check below

  // Create the AudioContext synchronously inside the click so the browser's
  // autoplay policy is satisfied. Resume it IMMEDIATELY, still inside the
  // gesture: browsers that start a fresh context suspended (Safari/iOS, and
  // Chrome under autoplay restrictions) only grant the resume while the
  // gesture is live. Deferring it until after the mic prompt + decode would
  // leave the context suspended, and every source scheduled into a suspended
  // context is dropped silently — the session UI runs but nothing is audible.
  closeAudio(); // stop any ongoing playback first
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  audioEngine.ctx = ctx;
  try { ctx.resume().catch(() => {}); } catch (_) {}

  let stream;
  try {
    stream = await getUserMic();
  } catch (err) {
    studio.recording = false;
    closeAudio();
    setStudioStatus("✗ microphone unavailable: " + err.message, true);
    return;
  }
  // Second chance at running (the immediate resume above may have been too
  // early for the engine) — and a hard check before the slow decode + schedule:
  // a context that is still suspended would schedule fine but silently drop the
  // count-in, the backing, and the monitor while the session UI runs normally.
  // Surface that instead of recording a take nobody can hear.
  const running = await ensureCtxRunning(ctx);
  if (!running) {
    studio.recording = false;
    cleanupTakeMedia();
    renderHub();
    setStudioStatus("✗ the browser held the take's audio back — tap Start again to grant it", true);
    return;
  }
  // Send the backing + count-in + 监听 monitor to the chosen output device
  // (e.g. the singer's headphones) rather than the OS default — which is
  // usually the room speakers and would blast the song into the raw take.
  await routeCtxToOutput(ctx);
  studio.stream = stream;
  studio.backingCommit = commit;

  // Resolve the chosen input channel against what the device actually
  // delivered: a single-channel device has nothing to pick, so L/R falls back
  // to the full mix.
  let pick = inputChannelForTake();
  const trackSettings =
    stream.getAudioTracks()[0] && stream.getAudioTracks()[0].getSettings
      ? stream.getAudioTracks()[0].getSettings()
      : null;
  if (trackSettings && trackSettings.channelCount === 1 && pick !== "both") {
    pick = "both";
    setStudioStatus("ℹ this input has a single channel — using L+R.", false);
  }
  studio.pick = pick;

  // Optional live monitor, connected the moment the stream exists so the
  // player hears the count-in AND their instrument. Output-only: the recorder
  // below still captures the raw mic, so the monitor never reaches the WAV.
  if (monitorForTake()) {
    studio.monitor = monitorInput(ctx, stream, pick);
  }

  const chain = buildChain(commit);
  const backingMuted = muteBackingForTake(); // "No backing" — only the ticks play

  // The setup dialog's chosen "start point" is where the singer should come in
  // (the last count-in tick lands exactly there), so the session begins
  // TAKE_PRE_ROLL earlier on the root timeline — the backing rolls INTO the
  // phrase instead of starting cold at it. A whole-song take keeps
  // setupChosenStart 0 → sessionFrom 0 → the classic whole-song count-in.
  const startPoint = Math.max(0, Number(setupChosenStart) || 0);
  setupChosenStart = 0; // the value belongs to the dialog that just closed
  const sessionFrom = startPoint > 0 ? Math.max(0, startPoint - TAKE_PRE_ROLL) : 0;
  studio.sessionFrom = sessionFrom;

  // Phase 1 — decode EVERY backing buffer BEFORE fixing the timeline, UNLESS
  // the backing is muted ("No backing"): then skip fetch + decode entirely so
  // the count-in starts instantly and nothing can bleed into the mic. Decoding
  // is the slow part (fetch + decodeAudioData). If the start times were
  // computed first, a slow decode would push `backingStartAt` into the past and
  // the start timer would fire immediately — collapsing the count-in (the
  // backing, ticks, and recorder would all start mid-decode).
  let decoded = [];
  if (!backingMuted) {
    try {
      decoded = await Promise.all(
        chain.map(async ({ commit: c, offset }) => ({ c, offset, layer: await decodeLayer(ctx, c.url) }))
      );
    } catch (err) {
      studio.recording = false;
      cleanupTakeMedia();
      renderHub();
      setStudioStatus("✗ could not load the backing: " + err.message, true);
      return;
    }
  }
  if (studio.cancelled || !audioEngine.ctx) {
    // Defensive bail (e.g. cancel raced the decode): restore every flag + the
    // UI so the studio can never be left stuck for the next session.
    studio.recording = false;
    cleanupTakeMedia();
    renderHub();
    return;
  }

  // Phase 2 — timeline fixed in this tick, so the count-in below is a reliable
  // TAKE_PRE_ROLL seconds long.
  const backingStartAt = ctx.currentTime + 0.35; // backing chain + recorder start here
  const chainStartAt = backingStartAt + TAKE_PRE_ROLL; // 4th count-in tick ends here

  // The backing plays through its own gain node at a fixed level — or is muted
  // entirely when "No backing" is on — so it can't contaminate the take: the
  // #1 cause of "the original is in my take" is the backing bleeding through
  // the speakers into the mic.
  const backingGain = ctx.createGain();
  backingGain.gain.value = backingMuted ? 0 : getBackingVolume();
  // Pass-through probe on the session's whole output (backing + count-in
  // ticks) for the take-audio diagnostic below. AnalyserNode does not alter
  // the audio; without one the graph connects exactly as before.
  let diagProbe = null;
  if (typeof ctx.createAnalyser === "function") {
    try {
      diagProbe = ctx.createAnalyser();
      diagProbe.fftSize = 1024;
      backingGain.connect(diagProbe);
      diagProbe.connect(ctx.destination);
    } catch (_) { diagProbe = null; }
  }
  if (!diagProbe) backingGain.connect(ctx.destination);

  // Schedule every backing layer from the session's point on the root
  // timeline (sessionFrom = 0 reproduces the whole-song scheduling exactly;
  // mid-song sessions read each layer's tail through layerReadWindow so a
  // previous take that ended before the point simply isn't heard).
  for (const { c, layer } of decoded) {
    scheduleSessionLayer(ctx, layer, c, studio.sessionFrom || 0, backingStartAt, backingGain, commitVolume(c));
  }

  // Audible count-in ticks over the pre-roll — the 4th ends exactly at
  // chainStartAt ("start singing now"). As graph output they're part of the AEC
  // echo reference the browser cancels from the mic; even if a sliver bleeds
  // in, the mix reads the take from its own start_time, so pre-roll content
  // (ticks, backing bleed, DSP convergence) is never heard in the take.
  scheduleCountIn(ctx, backingStartAt, chainStartAt, diagProbe);

  // Record the RAW mic stream directly — same capture path as the initial
  // recording. The take is the clean dry mic: nothing from the backing or the
  // AudioContext graph is connected to this recorder. The optional monitor
  // (monitorInput) is a separate output-only path, so listening back can never
  // contaminate the take.
  studio.takeLevel = null;
  studio.recorder = createTakeRecorder(ctx, stream, pick);
  if (!studio.recorder) {
    studio.recording = false;
    cleanupTakeMedia();
    renderHub();
    setStudioStatus("✗ this browser cannot record audio (no Web Audio capture)", true);
    return;
  }
  // The take blob starts at the same instant as the backing (blob zero = the
  // session's zero on the root timeline), so the take is positioned by its
  // detected blob start + lead (a whole-song take → sessionFrom 0 → lead 0 →
  // placed purely by detection). When the backing is AUDIBLE the take also
  // lands late by the device round trip (see applyLatencyComp) — lead is then
  // sessionFrom minus that compensation, so the phrase lands where it was
  // sung. Recording from the backing start is the key to a clean take top:
  // the old code started the recorder TAKE_PRE_ROLL after the backing, so
  // anything sung during the count-in was cut and the take began mid-phrase —
  // exactly the "first seconds sound messed up" symptom.
  applyLatencyComp(ctx, stream);

  // Count-in pre-roll: the recorder starts at backingStartAt; the four ticks
  // run over the next TAKE_PRE_ROLL seconds as a musical count ("start singing
  // as the last tick ends"). With "No backing" on, the song itself is muted and
  // you sing a cappella to the ticks; either way the recorder is already
  // capturing, so singing early loses nothing, and at mix time the take is read
  // from its own start_time, so pre-roll audio never appears in the take.
  showRecordSession();
  attachTakeAudioDiag(ctx, { backingStartAt, chainStartAt }, diagProbe);
  const tt = document.getElementById("take-timer");
  if (tt) tt.textContent = "♪ count-in…";

  const startMs = Math.max(0, Math.round((backingStartAt - ctx.currentTime) * 1000));
  studio.startTimer = setTimeout(() => {
    studio.startTimer = null;
    if (studio.cancelled || !studio.recorder) return;
    studio.recorder.start(250);
    studio.takeStart = Date.now();
    updateTakeTimer();
    studio.timerId = setInterval(updateTakeTimer, 200);
    setStudioStatus("● recording — start singing as the last tick ends", false);
    setRecordUI(true);
  }, startMs);
}


/* ── Modal ─────────────────────────────────────────────── */
let modalEl = null;

function closeModal() {
  stopSetupAudition(); // stop any "Listen from here" preview before the dialog's context disappears
  stopReviewPreview(); // stop any review-take preview transport playback the same way
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }
}

function showModal(html, onMount) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "rc-modal";
  overlay.id = "rc-modal";
  overlay.innerHTML = `
    <div class="rc-modal-inner">
      <button type="button" class="rc-modal-close" id="rc-modal-close" aria-label="Close">&times;</button>
      ${html}
    </div>`;
  document.body.appendChild(overlay);
  modalEl = overlay;
  overlay.querySelector("#rc-modal-close").addEventListener("click", () => {
    if (studio.recording) cancelTake();
    else closeModal();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      if (studio.recording) cancelTake();
      else closeModal();
    }
  });
  if (onMount) onMount(overlay);
  return overlay;
}

/* ── Take session lifecycle ────────────────────────────── */
function cleanupTakeMedia() {
  if (studio.monitor) {
    try { studio.monitor.src.disconnect(); } catch (_) {}
    try { if (studio.monitor.splitter) studio.monitor.splitter.disconnect(); } catch (_) {}
    try { studio.monitor.gain.disconnect(); } catch (_) {}
    studio.monitor = null;
  }
  if (studio.stream) {
    studio.stream.getTracks().forEach((t) => t.stop());
    studio.stream = null;
  }
  closeAudio();
}

function completeTake() {
  if (!studio.recorder || !studio.recording) return;
  // Still in the count-in (recorder not started yet) → treat Complete as Cancel.
  if (studio.recorder.state === "inactive") { cancelTake(); return; }
  try { studio.recorder.stop(); } catch (_) {}
}

function cancelTake() {
  studio.cancelled = true;
  setRecordUI(false); // restore the button immediately (renderHub below re-creates it)
  if (studio.countdownTimer) {
    clearTimeout(studio.countdownTimer);
    studio.countdownTimer = null;
  }
  if (studio.startTimer) {
    clearTimeout(studio.startTimer);
    studio.startTimer = null;
  }
  if (studio.recorder && studio.recorder.state !== "inactive") {
    try { studio.recorder.stop(); } catch (_) {}
  }
  clearInterval(studio.timerId);
  studio.recording = false;
  cleanupTakeMedia();
  closeModal();
  setStudioStatus("");
  renderHub();
}

function onTakeStopped(blobOverride) {
  const cancelled = studio.cancelled;
  clearInterval(studio.timerId);
  studio.recording = false;
  setRecordUI(false); // button stays "… recording" until renderHub; restore it here too
  cleanupTakeMedia();
  if (cancelled) return;
  // The recorder delivers the finished WAV blob whole (createRecorder → encodeWav).
  if (!blobOverride || !blobOverride.size) {
    setStudioStatus("✗ take capture failed — nothing was recorded. Please try again.", true);
    renderHub();
    return;
  }
  const blob = blobOverride;
  studio.blob = blob;
  studio.blobUrl = URL.createObjectURL(blob);
  analyzeTake(blob).then((info) => {
    if (!studio.blob) return; // discarded while decoding
    studio.takeDuration = info.duration;
    studio.takeStartGuess = info.start;
    studio.takeEndGuess = info.end;
    studio.takeLevel = info.level;
    openTakePreview();
  });
}

function decodeBlobDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = new Audio();
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(el.duration || 0);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    el.src = url;
  });
}

/* Decode the recorded take to find its exact duration and its audible range
   (first/last non-silent sample). The times returned here are BLOB-RELATIVE.
   A take's blob zero is the session's zero — studio.sessionFrom minus the
   sing-along sync-delay compensation, i.e. studio.lead, on the root timeline
   (0 for whole-song takes) — so the Review modal lands the take at
   (blob position + lead). At mix time the blob is read from (start_time −
   lead), which keeps every blob position at its true root spot.

   Decoding via decodeAudioData (WAV always decodes) gives exact sample-level
   duration/level on every browser — <audio>.duration is unreliable for
   blobs. */
function analyzeTake(blob) {
  const safeClose = (ctx) => {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
  };
  return new Promise((resolve) => {
    let oc = null;
    try { oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100); } catch (_) { oc = null; }
    blob.arrayBuffer()
      .then((buf) => {
        if (oc) return decodeAudioCompat(oc, buf);
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        return decodeAudioCompat(ac, buf).then((a) => { safeClose(ac); return a; });
      })
      .then((audio) => {
        safeClose(oc);
        const rate = audio.sampleRate || 44100;
        const duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        const ch = audio.getChannelData(0);
        const win = Math.max(1, Math.round(rate * 0.05)); // 50 ms windows
        const thr = 0.01;                                 // ~ -40 dBFS
        let first = -1;
        let last = -1;
        let sumSq = 0;
        let winCount = 0;
        for (let i = 0; i < ch.length; i += win) {
          let sum = 0;
          const end = Math.min(ch.length, i + win);
          for (let j = i; j < end; j++) { const s = ch[j]; sum += s * s; }
          const rms = Math.sqrt(sum / (end - i));
          sumSq += rms * rms;
          winCount++;
          if (rms > thr) {
            if (first < 0) first = i;
            last = end;
          }
        }
        const PAD = 0.15; // small pad so a soft attack/release isn't clipped
        resolve({
          duration,
          start: first >= 0 ? Math.max(0, first / rate - PAD) : 0,
          end: last >= 0 ? Math.min(duration, last / rate + PAD) : duration,
          // Overall RMS — lets the Review modal warn when the take came out
          // silent (e.g. an iOS mic that captured nothing).
          level: winCount ? Math.sqrt(sumSq / winCount) : 0,
        });
      })
      .catch(() => {
        safeClose(oc);
        // Last-resort: <audio> metadata duration, guarded (blobs can report
        // Infinity). Timeout so the modal can never hang.
        Promise.race([
          decodeBlobDuration(blob),
          new Promise((r) => setTimeout(() => r(0), 3000)),
        ]).then((d) => {
          const dur = isFinite(d) && d > 0 ? d : 0;
          resolve({ duration: dur, start: 0, end: dur, level: null });
        });
      });
  });
}

/* "● Record Take" is two-phase: a setup dialog carries every per-take option —
   input channel (L/R), 监听 Monitor, Headphones and No backing — and confirms
   the take's mic + playback output, both of which are chosen ONCE in the top
   bar (#studio-device / #studio-output; getUserMic() reads the former,
   routeCtxToOutput() the latter). THEN the count-in flow runs. Without mic
   permission the browser hides device names, so opening the dialog re-populates
   the two top-bar lists (stale until then) and mirrors their current choices
   into read-only notes; the actual getUserMedia happens on "Start from here",
   inside the click. The four dialog options are persisted to the same
   localStorage keys the old bar toggles wrote, so every other path
   (new recording → Record from mic) keeps working with the last-used values. */
function openRecordSetup() {
  if (studio.recording || !hub.checkedOut) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    startTakeRecording(); // surfaces the HTTPS/blocked error directly
    return;
  }
  const repoId = hub.checkedOut.repoId;
  const commit = (hub.commits.get(repoId) || []).find((c) => c.id === hub.checkedOut.commitId);
  if (!commit) return;
  // Record Take ALWAYS honors the commit the user has checked out — the ✓ in the
  // list decides where the new take stacks, never the newest commit. The one
  // real trap worth surfacing: recording over an OLDER take while newer takes
  // exist forks the history — the new take layers onto that older commit (and
  // only that commit's own ancestor chain) and will NOT play together with the
  // newer takes on the other branch. Warn about exactly what will be mixed, then
  // proceed over the user's chosen commit; Cancel aborts and leaves the ✓ where
  // it is so they can re-pick a base. It must NEVER silently re-target the
  // newest take — that would override the commit the user just chose.
  const cs = hub.commits.get(repoId) || [];
  const head = cs.reduce((m, x) => (!m || x.id > m.id ? x : m), null);
  if (head && head.id !== commit.id) {
    const proceed = window.confirm(
      `● Record Take will layer the new take over ${commitHash(commit.id)} (${commit.message}). The newest take in this recording is ${commitHash(head.id)} (${head.message}): a take recorded here will NOT play together with it — the session mix stays ${commitHash(commit.id)} and that commit's own earlier chain only. Record over ${commitHash(commit.id)} anyway?`
    );
    if (!proceed) return; // keep the ✓ untouched — the user can re-check-out the commit they meant
  }
  // The dialog's song transport always shows: the checked-out chain plays from
  // the top right away so the singer can drag the progress bar to where the take
  // should start (the default is where this commit's own content begins — 0:00
  // for a whole-song commit is the classic full pass). The session later starts
  // TAKE_PRE_ROLL before the chosen point so the last count-in tick lands on it.
  setupChosenStart = 0;
  showModal(`
    <h3 class="rc-modal-title">Record over ${commitHash(commit.id)}</h3>
    <p class="rc-modal-sub">Pick where in the song this take starts, then hit Start: the song plays from the top while you drag the progress bar, and the count-in begins ${TAKE_PRE_ROLL.toFixed(1)} s before your point so the song reaches it exactly as the last tick ends. The microphone and playback output are chosen once in the top bar (the two dropdowns right next to “● Record Take”); this dialog confirms those and carries every other take option.</p>
    <div class="rc-field">Microphone for this take
      <p class="rc-device-note" id="setup-device-note"></p>
      <span class="rc-hint">Mirrors the top bar’s mic dropdown — the take always records through that one choice.</span>
    </div>
    <div class="rc-field">Playback output for this take
      <p class="rc-device-note" id="setup-output-note"></p>
      <span class="rc-hint">Mirrors the top bar’s Playback output dropdown — pick your headphones there so the song you sing along to doesn't blast from the room speakers and bleed into the mic; “System default” follows your OS sound output.</span>
    </div>
    <div class="rc-field rc-start-pick">
      <label class="rc-start-label" for="setup-start-bar">Where in the song the take starts
        <span class="rc-start-time" id="setup-start-time">0:00</span>
      </label>
      <input type="range" id="setup-start-bar" min="0" max="0" step="0.1" value="0" disabled="" aria-label="Where in the song this take starts" />
      <span class="rc-start-actions">
        <button type="button" class="rc-btn rc-btn-ghost rc-btn-sm" id="setup-listen-btn" disabled="">▶ Listen from here</button>
        <button type="button" class="rc-btn rc-btn-ghost rc-btn-sm" id="setup-to-top-btn">↶ From the top</button>
      </span>
      <span class="rc-hint" id="setup-start-hint">Measuring the song… it starts playing from the top so you can drag to pick where to record.</span>
    </div>
    <label class="rc-field">Input channel
      <select id="setup-channel" title="Which physical input of the interface to record + monitor: Left = input 1, Right = input 2. A single-channel device ignores this and uses L+R.">
        <option value="both">L+R both — full mix</option>
        <option value="L">Left (1) — e.g. an instrument in interface input 1</option>
        <option value="R">Right (2) — e.g. an instrument in interface input 2</option>
      </select>
    </label>
    <div class="rc-take-opts">
      <label class="studio-phones" title="Hear your input live while recording. Browser monitoring adds ~20–40 ms latency (fine for practicing); keep speakers off to avoid feedback — wear headphones, or use your interface's hardware Direct Monitor button for zero-latency monitoring. The monitor never enters the recorded take.">
        <input type="checkbox" id="setup-monitor" /> 监听 Monitor — hear your input while recording (wear headphones; an open speaker will feedback)
      </label>
      <label class="studio-phones" title="Headphones? Records the raw mic with the browser's echo canceller / noise suppressor turned off — the clearest take.">
        <input type="checkbox" id="setup-headphones" /> Headphones — record the raw mic (browser echo canceller / noise suppressor off)
      </label>
      <label class="studio-phones" title="Mute the backing during this take (default on)? With the song muted nothing can bleed from the speakers into the mic — the take is guaranteed clean — but you sing a cappella to the count-in ticks. Uncheck to sing along with the song, e.g. in headphones.">
        <input type="checkbox" id="setup-no-backing" /> No backing (default) — mute the song; uncheck to sing along with it
      </label>
    </div>
    <div class="rc-modal-actions">
      <button type="button" class="rc-btn rc-btn-ghost" id="setup-cancel-btn">Cancel</button>
      <button type="button" class="rc-btn rc-btn-primary" id="setup-start-btn">Start from here →</button>
    </div>
  `, (overlay) => {
    const devNote = overlay.querySelector("#setup-device-note");
    const outNote = overlay.querySelector("#setup-output-note");
    const chSel = overlay.querySelector("#setup-channel");
    chSel.value = inputChannelForTake();
    const monEl = overlay.querySelector("#setup-monitor");
    monEl.checked = monitorForTake();
    const hpEl = overlay.querySelector("#setup-headphones");
    hpEl.checked = localStorage.getItem(STUDIO_PHONES_KEY) === "1";
    const nbEl = overlay.querySelector("#setup-no-backing");
    nbEl.checked = muteBackingForTake();
    // Every take gets the song transport + start-point scrubber — pick where in
    // the song the take starts and hear the exact spot before committing to it.
    wireSetupStartPicker(overlay, commit);
    // The mic + playback output live ONCE in the top bar's #studio-device /
    // #studio-output selects (getUserMic()/routeCtxToOutput() read them when the
    // take starts), so this dialog only confirms them instead of asking a second
    // time. Re-populate the bar lists here (a just-granted mic permission is the
    // one case where the lists are stale), then mirror the current selections
    // into the read-only notes.
    const selectedLabel = (sel) => {
      if (!sel) return "";
      const opt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      return opt ? opt.textContent.trim() : "";
    };
    const refreshNotes = () => {
      const barSel = document.getElementById("studio-device");
      const micLabel = selectedLabel(barSel);
      devNote.textContent =
        barSel && barSel.value && micLabel
          ? micLabel
          : "The phone’s current input for this take. To record through a specific 声卡, allow mic access once (hit Start) — the real device names then appear in the top bar’s mic dropdown, and you pick it there before the next take.";
      if (outNote) {
        outNote.textContent =
          selectedLabel(document.getElementById("studio-output")) || "System default (OS setting)";
      }
    };
    populateMicDevices("studio-device").then(refreshNotes);
    if (outNote) populateOutputSelect("studio-output").then(refreshNotes);
    refreshNotes();
    overlay.querySelector("#setup-cancel-btn").addEventListener("click", () => closeModal());
    overlay.querySelector("#setup-start-btn").addEventListener("click", () => {
      // No mic/output device to copy: both choices already live in the top bar
      // (#studio-device / #studio-output). Persist only the dialog-local take
      // options here — the same localStorage keys (and write timing) the old bar
      // toggles used, so every other flow keeps reading the same values.
      localStorage.setItem(STUDIO_CHANNEL_KEY, chSel.value);
      localStorage.setItem(STUDIO_MONITOR_KEY, monEl.checked ? "1" : "0");
      localStorage.setItem(STUDIO_PHONES_KEY, hpEl.checked ? "1" : "0");
      localStorage.setItem(STUDIO_MUTE_BACKING_KEY, nbEl.checked ? "1" : "0");
      closeModal();
      startTakeRecording();
    });
  });
}

/* Wire the record-setup dialog's song transport: the checked-out chain starts
   playing from the top on open, the progress bar is its scrubber, and
   setupChosenStart holds the settled point where the take starts (the session
   later begins TAKE_PRE_ROLL before it so the count-in's last tick lands
   exactly on it). The bar stays disabled only until the backing's length is
   measured — the playback itself starts immediately and derives its end from
   the decoded layers, so it never waits for that read. */
async function wireSetupStartPicker(overlay, commit) {
  const bar = overlay.querySelector("#setup-start-bar");
  const timeEl = overlay.querySelector("#setup-start-time");
  const hintEl = overlay.querySelector("#setup-start-hint");
  const listenBtn = overlay.querySelector("#setup-listen-btn");
  const topBtn = overlay.querySelector("#setup-to-top-btn");
  if (!bar || !timeEl || !hintEl || !listenBtn || !topBtn) return;
  // Default: re-record where this take's own content begins (0:00 whole-song).
  setupChosenStart = Math.max(0, Number(commit.start_time) || 0);
  setSetupClock(setupChosenStart);
  // Auto-play from the top right away (still inside the dialog-open click's
  // gesture, so the AudioContext can start) — the singer then drags the bar to
  // where the take should start. If the browser holds the playback back, the
  // audition reports it and “▶ Listen from here” retries inside a fresh tap.
  listenBtn.disabled = false;
  startSetupAudition(0);

  const total = await backingChainTotal(commit);
  if (!overlay.isConnected) return; // the dialog was closed while measuring
  if (total == null) {
    // No chain length: the bar can't be scaled, but playback/Listen still work
    // (an audition's end comes from its decoded layers).
    bar.disabled = true;
    if (!setupAudition) {
      hintEl.textContent =
        "Couldn't measure the song's length, so the bar is off — press “▶ Listen from here” to hear from " +
        fmtStartTime(setupChosenStart) + ", or hit “Start from here →” to record from there.";
    }
    return;
  }
  bar.max = String(total);
  bar.disabled = false;
  // Clamp the default to the measured length (a commit whose start_time sat past
  // the chain's end would otherwise schedule a silent backing at session time).
  setupChosenStart = Math.max(0, Math.min(setupChosenStart, total));
  if (!setupAudition) {
    // Not playing (the auto-play finished or was held back while measuring) →
    // settle the bar at the clamped default and go idle.
    bar.value = String(setupChosenStart);
    setSetupClock(setupChosenStart);
    refreshIdleHint();
  }
  const clampBar = () => Math.max(0, Math.min(Number(bar.value) || 0, Math.max(0, Number(bar.max) || 0)));
  const settleAt = (v) => {
    setupChosenStart = v;
    bar.value = String(v);
    setSetupClock(v);
  };
  // Drag: while the thumb moves the singer owns the readout — the playhead
  // clock/bar stand down until release. Release ("change") is the decision:
  // the choice is recorded and, when the song is playing, it seeks there and
  // keeps playing from the new point so the singer hears exactly what they
  // picked before the count-in.
  bar.addEventListener("input", () => {
    setupScrubbing = true;
    setSetupClock(clampBar());
  });
  bar.addEventListener("change", () => {
    const v = clampBar();
    setupScrubbing = false;
    settleAt(v);
    if (setupAudition) {
      stopSetupAudition();          // silence the old schedule…
      startSetupAudition(v);        // …and keep playing from the picked point
    } else {
      refreshIdleHint();
    }
  });

  listenBtn.addEventListener("click", () => {
    if (setupAudition) {
      // “■ Stop”: silence the song. The choice stays wherever the bar was last
      // settled (the default or the last drag-release), and the clock/bar snap
      // back to it so the idle readout always shows what Start will use.
      stopSetupAudition();
      bar.value = String(setupChosenStart);
      setSetupClock(setupChosenStart);
      return;
    }
    startSetupAudition(setupChosenStart);
  });
  topBtn.addEventListener("click", () => {
    bar.value = "0";
    setupScrubbing = false;
    if (setupAudition) {
      // Seeking to the top: reset the choice and keep playing from 0:00.
      setupChosenStart = 0;
      setSetupClock(0);
      stopSetupAudition();
      startSetupAudition(0);
    } else {
      settleAt(0);
      refreshIdleHint();
    }
  });
}

function showRecordSession() {
  const commit = studio.backingCommit;
  const backingMuted = muteBackingForTake();
  let sub = backingMuted
    ? "No backing — the song is muted for this take, so nothing can bleed into the mic: you record clean a cappella to the four rising ticks (start singing as the last one ends). The recorder is already capturing from the instant the ticks begin, so anything you sing from the first note is recorded. The take is only the dry mic (nothing mixed in)."
    : "Count-in: four rising ticks — start singing as the last one ends. The recorder is already capturing from the instant the backing starts, so anything you sing from the first note is recorded. The take is only the dry mic (nothing mixed in); wearing headphones (tick “Headphones” in the setup dialog) records the raw mic with no echo suppression — the clearest take.";
  if (monitorForTake()) {
    sub += " Monitor is on: you’re hearing your input through the browser — keep headphones on (an open speaker will feedback).";
  }
  // Singing along "raw" (no echo canceller) is only clean if the song reaches
  // your headphones and not the room speakers — the mic would otherwise record
  // the backing through the air. Tell the singer when that route is at risk.
  const singAlongRaw =
    !backingMuted && (monitorForTake() || localStorage.getItem(STUDIO_PHONES_KEY) === "1");
  if (singAlongRaw && !outputDeviceForTake()) {
    sub += " ⚠ Singing along with the song while recording raw: the song plays through your system default output — if that comes out of the speakers (not your headphones), cancel and set Playback output to your headphones in the top bar (the dropdown next to “● Record Take”) before starting again.";
  }
  // Mid-song takes: say where the take actually lands so the singer watches for
  // the chosen phrase rather than the song's beginning.
  if (studio.sessionFrom > 0) {
    if (backingMuted) {
      sub +=
        " The song is muted, so this is a cappella: count the four ticks, and when the last one ends (at " +
        fmtStartTime(studio.sessionFrom + TAKE_PRE_ROLL) +
        " in the song) start singing the phrase that lives there — the take is placed at that point when you preview it over the backing.";
    } else {
      sub +=
        " This take starts inside the song — the backing begins at " +
        fmtStartTime(studio.sessionFrom) + " and the " + TAKE_PRE_ROLL.toFixed(1) +
        " s of lead-in carries the four ticks, so the last tick ends at " +
        fmtStartTime(studio.sessionFrom + TAKE_PRE_ROLL) + ": start singing the phrase then.";
    }
  }
  showModal(`
    <h3 class="rc-modal-title">Recording over ${commitHash(commit.id)}</h3>
    <p class="rc-modal-sub">${sub}</p>
    <div class="rc-timer-wrap">
      <span class="rc-rec-dot"></span>
      <span class="rc-timer" id="take-timer">0:00</span>
    </div>
    <p class="rc-diag" id="take-diag" hidden></p>
    <div class="rc-modal-actions">
      <button type="button" class="rc-btn rc-btn-ghost" id="cancel-take-btn">Cancel</button>
      <button type="button" class="rc-btn rc-btn-primary" id="complete-take-btn">■ Complete</button>
    </div>
  `, (overlay) => {
    overlay.querySelector("#complete-take-btn").addEventListener("click", completeTake);
    overlay.querySelector("#cancel-take-btn").addEventListener("click", cancelTake);
  });
  updateTakeTimer();
}

/* ── Review-take preview transport ─────────────────────────

   The “Review take” dialog's two preview buttons used to be fire-and-forget:
   press ▶ and the audio ran until it ended or the next action replaced it.
   Each preview now runs inside a small transport — a scrubber bar with an
   m:ss.t clock that follows the playhead, a “↶ From the start” reset, and the
   active preview button flipping to “■ Stop” (press it again to stop; pressing
   the other ▶ switches previews). One preview runs at a time; closing the
   modal or starting another preview stops it.

   The bar spans ROOT-timeline seconds — the same clock the Start/End fields
   speak. “Take only” reads the take blob (whose zero sits `lead` seconds into
   the parent), so its bar covers [lead, lead + take length]; “With original”
   plays the whole chain with this take over it, so its bar covers [0, mix
   end]. Dragging while a preview plays jumps it — release restarts the preview
   from the new point, exactly like the record-setup scrubber, and the playhead
   readout stands down while the thumb is being dragged.

   Playback paths mirror the rest of the app: “Take only” is a native <audio>
   element with a Web Audio decode fallback (playDry / playBlobViaWebAudio);
   “With original” is the live Web Audio schedule on desktop and the
   offline-rendered mix + native element on iOS (the playCommit paths). */

let reviewPreview = null;    // active preview { seq, kind, F, teardown } | null
let reviewSeq = 0;           // monotonic — invalidates stale async preview engines
let reviewScrubbing = false; // the user is dragging the bar — playhead UI stands down
let reviewGeo = { kind: null, min: 0, max: 0, start: 0 }; // bar span, in root seconds

function reviewTransportEls() {
  return {
    wrap: document.getElementById("review-transport"),
    label: document.getElementById("review-prev-label"),
    bar: document.getElementById("review-prev-bar"),
    time: document.getElementById("review-prev-time"),
    note: document.getElementById("review-prev-note"),
    reset: document.getElementById("review-prev-reset"),
  };
}

function reviewLive(seq) {
  return !!reviewPreview && reviewPreview.seq === seq;
}

/* Snap a root-timeline position into the bar's current span (clamped to
   [min, max] once the length is known). */
function reviewClamp(pos) {
  const v = Math.max(reviewGeo.min, Number(pos) || 0);
  return reviewGeo.max > reviewGeo.min ? Math.min(reviewGeo.max, v) : v;
}

function reviewClockText(pos) {
  const v = reviewClamp(pos);
  return reviewGeo.max > reviewGeo.min
    ? fmtStartTime(v) + " / " + fmtStartTime(reviewGeo.max)
    : fmtStartTime(v);
}

function reviewSetClock(pos) {
  const els = reviewTransportEls();
  if (els.time) els.time.textContent = reviewClockText(pos);
}

function reviewSetNote(text) {
  const els = reviewTransportEls();
  if (els.note) els.note.textContent = text;
}

/* Size the bar once the preview's content length is known. */
function reviewSetRange(minRoot, maxRoot) {
  const els = reviewTransportEls();
  if (!els.bar) return;
  reviewGeo.min = Math.max(0, Number(minRoot) || 0);
  reviewGeo.max = Math.max(reviewGeo.min, Number(maxRoot) || 0);
  els.bar.min = String(reviewGeo.min);
  els.bar.max = String(reviewGeo.max);
  els.bar.disabled = !(reviewGeo.max > reviewGeo.min);
}

/* Playhead tick from a sounding preview: moves the bar + clock unless the user
   is dragging the thumb (then they own the readout until release). */
function reviewTick(seq, pos) {
  if (!reviewLive(seq) || reviewScrubbing) return;
  const els = reviewTransportEls();
  const v = reviewClamp(pos);
  if (els.bar && document.activeElement !== els.bar) els.bar.value = String(v);
  reviewSetClock(v);
}
/* The active preview button flips to “■ Stop”; the other stays a ▶ (pressing
   it switches previews). activeKind null → both sit idle as ▶. */
function reviewSetButtons(activeKind) {
  const flip = (btn, idleLabel, active) => {
    if (!btn) return;
    btn.textContent = active ? "■ Stop" : idleLabel;
    btn.classList.toggle("rc-btn-live", !!active);
  };
  flip(document.getElementById("preview-take-btn"), "▶ Take only", activeKind === "take");
  flip(document.getElementById("preview-mix-btn"), "▶ With original", activeKind === "mix");
}

/* Stop whatever review preview is sounding and release its audio. Idempotent —
   called on modal close, before a new preview starts, and on “■ Stop”.
   Mirrors stopSetupAudition: closeAudio() also clears hub.playing and any blue
   .playing row (the modal can sit over the hub list). */
function stopReviewPreview() {
  const p = reviewPreview;
  if (!p) return;
  reviewPreview = null;
  reviewScrubbing = false;
  if (typeof p.teardown === "function") {
    try { p.teardown(); } catch (_) {}
  }
  closeAudio();
}

/* Natural end / failure / user stop of the preview whose seq matches — the
   transport stays visible but idle: buttons back to ▶, the bar frozen where
   playback stopped, reset disabled, and the note explaining the state. */
function reviewFinish(seq, note) {
  if (!reviewLive(seq)) return;
  stopReviewPreview();
  reviewSetButtons(null);
  const els = reviewTransportEls();
  if (els.reset) els.reset.disabled = true;
  if (els.bar) els.bar.disabled = true;
  reviewSetNote(note);
  setStudioStatus(""); // the transport is now the source of truth
}
/* The point where a fresh preview begins, on the root timeline. The take-only
   preview starts where the Start field says the take sits (auto-detected take
   start + lead; never before lead — the blob has no content there). “With
   original” starts at the song's top so the take is heard in full context,
   over everything it was recorded against. */
function reviewStartRoot(kind) {
  const lead = studio.lead || 0;
  if (kind !== "take") return 0;
  const fieldEl = document.getElementById("commit-start");
  const field = fieldEl ? parseFloat(fieldEl.value) : NaN;
  if (isFinite(field)) return Math.max(lead, field);
  const guess = isFinite(studio.takeStartGuess) && studio.takeStartGuess > 0 ? studio.takeStartGuess : 0;
  return lead + guess;
}

/* The two preview buttons: start that kind's preview, or — when that kind is
   already sounding and its button reads “■ Stop” — stop it instead. */
function reviewStart(kind) {
  if (kind === "take" && !studio.blobUrl) return;
  if (reviewPreview && reviewPreview.kind === kind) {
    reviewFinish(reviewPreview.seq, "Preview stopped.");
    return;
  }
  reviewBegin(kind, reviewStartRoot(kind), false);
}

/* Begin — or, when keepRange, restart — a preview of `kind` from root position
   F. keepRange is set by a scrub release / the reset button: the measured bar
   span stays put (no re-measure flicker) while the engine starts fresh at F. */
function reviewBegin(kind, F, keepRange) {
  stopReviewPreview();
  // A preview is now the page's only audio: silence anything else that was
  // sounding (a hub-row play, a leftover fallback context) so the two can't
  // mix. The old inline preview handlers' playCommit/playDry did the same.
  if (audioEngine.ctx || audioEngine.elements.length) closeAudio();
  const lead = studio.lead || 0;
  const seq = ++reviewSeq;
  if (!keepRange) {
    reviewGeo.kind = kind;
    reviewGeo.min = kind === "take" ? lead : 0;
    reviewGeo.max = 0; // unknown yet — the engine measures and enables the bar
    reviewGeo.start = Math.max(reviewGeo.min, F);
  }
  reviewPreview = { seq, kind, F, teardown: null };
  const els = reviewTransportEls();
  if (els.wrap) els.wrap.hidden = false;
  if (els.label) els.label.textContent = kind === "take" ? "Take-only preview" : "With-original preview";
  if (els.bar) {
    els.bar.min = String(reviewGeo.min);
    els.bar.max = String(reviewGeo.max);
    els.bar.disabled = !(reviewGeo.max > reviewGeo.min);
    els.bar.value = String(reviewGeo.max > reviewGeo.min ? reviewClamp(F) : Math.max(reviewGeo.min, F));
  }
  reviewSetClock(F);
  reviewSetButtons(kind);
  if (els.reset) els.reset.disabled = false;
  if (kind === "take") reviewTakeEngine(seq, F);
  else reviewMixEngine(seq, F);
}
/* “Take only”: the dry take. Primary path is a native <audio> element (instant,
   no decode); if the device won't start blob audio (the iOS quirk playDry
   exists for) or the element stalls, fall back to a Web Audio decode. */
function reviewTakeEngine(seq, F) {
  const lead = studio.lead || 0;
  const url = studio.blobUrl;
  const off = Math.max(0, F - lead); // blob seconds — the take blob's zero sits at root `lead`
  if (!url) {
    reviewFinish(seq, "This take's audio is gone — re-record it before previewing.");
    return;
  }
  reviewSetNote(off > 0.05 ? "Loading the take from " + fmtStartTime(F) + "…" : "Loading the take…");
  const el = new Audio(url);
  routeElToOutput(el); // keep the preview on the chosen output device
  let torn = false;    // stopped / superseded / fell back
  let sounding = false;
  let tick = null;
  let stall = null;
  const teardown = () => {
    if (torn) return;
    torn = true;
    if (stall) clearTimeout(stall);
    if (tick) clearInterval(tick);
    try { el.pause(); el.removeAttribute("src"); el.load(); } catch (_) {}
  };
  if (reviewPreview && reviewPreview.seq === seq) reviewPreview.teardown = teardown;
  const fallback = () => {
    if (torn || !reviewLive(seq)) return;
    teardown();
    reviewTakeWAEngine(seq, F); // decode the in-memory blob through Web Audio
  };
  stall = setTimeout(fallback, 4000); // the element never started → decode path
  tick = setInterval(() => {
    if (torn || !reviewLive(seq)) { clearInterval(tick); return; }
    if (!sounding) return; // not playing yet — leave the readout where reviewBegin put it
    reviewTick(seq, lead + (el.currentTime || 0));
  }, 150);
  el.onerror = fallback;
  el.onloadedmetadata = () => {
    if (torn || !reviewLive(seq)) return;
    const d = el.duration;
    if (isFinite(d) && d > 0) reviewSetRange(lead, lead + d);
  };
  el.onplaying = () => {
    if (torn || !reviewLive(seq)) return;
    clearTimeout(stall);
    sounding = true;
    const d = el.duration;
    if (isFinite(d) && d > 0) reviewSetRange(lead, lead + d);
    reviewSetNote(
      "▶ take-only preview playing" +
        (off > 0.05 ? " from " + fmtStartTime(F) : " from its top") +
        " — drag the bar to jump, or press “■ Stop” above to silence it."
    );
  };
  el.onended = () => {
    if (!sounding || torn || !reviewLive(seq)) return;
    reviewFinish(seq, "Take-only preview finished.");
  };
  if (off > 0) el.currentTime = off;
  el.play().catch(() => { if (!torn && reviewLive(seq)) fallback(); });
  audioEngine.elements.push(el); // paused + released by closeAudio() on stop
}
/* The take decoded + played through Web Audio — the element engine's fallback
   (mirrors playBlobViaWebAudio, steered by the transport). */
async function reviewTakeWAEngine(seq, F) {
  const lead = studio.lead || 0;
  const url = studio.blobUrl;
  if (!url) return;
  reviewSetNote("Loading the take…");
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_) {
    ctx = null;
  }
  if (!ctx) {
    reviewFinish(seq, "Web Audio is unavailable on this device.");
    return;
  }
  audioEngine.ctx = ctx;
  if (!(await preparePlaybackContext(ctx))) {
    if (audioEngine.ctx === ctx) audioEngine.ctx = null;
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    reviewFinish(seq, "the browser held the playback back — press “▶ Take only” again to start it");
    return;
  }
  let layer = null;
  try {
    layer = await decodeLayer(ctx, url); // cached by URL; re-decodes cost nothing
  } catch (_) {
    layer = null;
  }
  if (!reviewLive(seq) || !audioEngine.ctx || audioEngine.ctx !== ctx) {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    return; // superseded while decoding
  }
  const closeCtx = () => {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    if (audioEngine.ctx === ctx) audioEngine.ctx = null;
  };
  if (!layer || !layer.buffer) {
    closeCtx();
    reviewFinish(seq, "couldn't load the take to preview it — check the connection and try again");
    return;
  }
  const dur = layer.buffer.duration || 0;
  const off = Math.max(0, F - lead); // blob seconds
  if (off >= Math.max(0.05, dur - 0.05)) {
    closeCtx();
    reviewFinish(seq, "Nothing to hear from that point — the take has already ended there.");
    return;
  }
  reviewSetRange(lead, lead + dur);
  const startAt = ctx.currentTime + 0.05;
  let src = null;
  try {
    src = ctx.createBufferSource();
    src.buffer = layer.buffer;
    src.connect(ctx.destination);
    src.start(startAt, Math.min(off, Math.max(0, dur - 0.001)), undefined);
    audioEngine.sources.push(src);
  } catch (_) {
    src = null;
  }
  if (!src) {
    closeCtx();
    reviewFinish(seq, "couldn't start the preview in this browser");
    return;
  }
  const endAt = startAt + Math.max(0.05, dur - off) + 0.2;
  const tick = setInterval(() => {
    if (!audioEngine.ctx || audioEngine.ctx !== ctx || !reviewLive(seq)) { clearInterval(tick); return; }
    if (ctx.currentTime < endAt) reviewTick(seq, F + Math.max(0, ctx.currentTime - startAt));
    else {
      clearInterval(tick);
      reviewFinish(seq, "Take-only preview finished.");
    }
  }, 150);
  if (reviewPreview && reviewPreview.seq === seq) reviewPreview.teardown = () => clearInterval(tick);
  reviewSetNote(
    "▶ take-only preview playing" +
      (off > 0.05 ? " from " + fmtStartTime(F) : " from its top") +
      " — drag the bar to jump, or press “■ Stop” above to silence it."
  );
}
/* The take as an overlay layer for “With original”, from the modal fields — the
   same geometry the commit will use. The take blob's zero sits at root `lead`;
   its audible content starts at Start (root seconds), and End, when set past
   Start, trims it. Volume comes from the modal's % slider (100 = unchanged). */
function reviewMixExtra() {
  const startEl = document.getElementById("commit-start");
  const startT = parseFloat(startEl && startEl.value) || 0;
  const endEl = document.getElementById("commit-end");
  const endT = parseFloat(endEl ? endEl.value : ""); // NaN for "end"
  const duration = isFinite(endT) && endT > startT ? endT - startT : undefined;
  const volEl = document.getElementById("commit-volume");
  const rawVol = parseFloat(volEl && volEl.value);
  return {
    url: studio.blobUrl,
    start_time: startT,
    duration,
    volume: isFinite(rawVol) ? Math.max(0, Math.min(2, rawVol / 100)) : 1, // 0–200%
    lead: studio.lead || 0,
  };
}

/* One-line playing status for the with-original transport note. */
function reviewMixPlayingNote(F) {
  return (
    "▶ with-original preview playing" +
    (Number(F) > 0.05 ? " from " + fmtStartTime(F) : " from the top") +
    " — drag the bar to jump, or press “■ Stop” above to silence it."
  );
}

function reviewMixEngine(seq, F) {
  const commit = studio.backingCommit;
  const extra = reviewMixExtra();
  if (!commit) {
    reviewFinish(seq, "No parent recording to preview against.");
    return;
  }
  if (!extra.url) {
    reviewFinish(seq, "This take's audio is gone — re-record it before previewing.");
    return;
  }
  reviewSetNote(Number(F) > 0.05 ? "Mixing from " + fmtStartTime(F) + "…" : "Mixing the song with this take…");
  if (isIOS()) reviewMixIOSEngine(seq, F, commit, extra);
  else reviewMixWAEngine(seq, F, commit, extra);
}
/* Desktop with-original preview: the live Web Audio schedule of the chain + the
   take overlay (mirrors the record-setup audition, which shares its layer read
   windows with the iOS render — a scrubbed restart schedules the same geometry
   from root F). The bar's max is the mix's end across the decoded layers. */
async function reviewMixWAEngine(seq, F, commit, extra) {
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_) {
    ctx = null; // e.g. the iOS 4-context cap
  }
  if (!ctx) {
    reviewFinish(seq, "Web Audio is unavailable on this device.");
    return;
  }
  audioEngine.ctx = ctx;
  if (!(await preparePlaybackContext(ctx))) {
    if (audioEngine.ctx === ctx) audioEngine.ctx = null;
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    reviewFinish(seq, "the browser held the playback back — press “▶ With original” again to start it");
    return;
  }
  // Decode the whole chain + this take's blob (cached per URL, so a reseek is
  // a fast re-schedule). A layer that fails to decode is skipped, not fatal.
  const layers = [];
  for (const { commit: c } of buildChain(commit)) {
    try {
      layers.push({ c, layer: await decodeLayer(ctx, c.url) });
    } catch (err) {
      layers.push({ c, layer: null, err });
    }
  }
  if (extra && extra.url) {
    const c = {
      lead: extra.lead,
      start_time: extra.start_time,
      end_time: extra.duration != null ? extra.start_time + extra.duration : null,
    };
    try {
      layers.push({ c, layer: await decodeLayer(ctx, extra.url), gain: extra.volume });
    } catch (err) {
      layers.push({ c, layer: null, err });
    }
  }
  if (!reviewLive(seq) || !audioEngine.ctx || audioEngine.ctx !== ctx) {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    return; // superseded while decoding
  }
  const closeCtx = () => {
    try { if (ctx && typeof ctx.close === "function") ctx.close().catch(() => {}); } catch (_) {}
    if (audioEngine.ctx === ctx) audioEngine.ctx = null;
  };
  const failed = [];
  const startAt = ctx.currentTime + 0.05;
  let scheduled = 0;
  for (const { c, layer, gain } of layers) {
    if (!layer) continue;
    try {
      scheduleSessionLayer(ctx, layer, c, F, startAt, undefined, gain !== undefined ? gain : commitVolume(c));
      scheduled++;
    } catch (err) {
      failed.push(err);
    }
  }
  if (!scheduled) {
    closeCtx();
    reviewFinish(seq, "nothing to hear from that point — the song has already ended there");
    return;
  }
  // Bar max = the mix's end across the decoded layers (root seconds); the bar
  // keeps its kind's min (0 for a mix) so a scrub can restart anywhere inside it.
  let total = F;
  for (const { c, layer } of layers) {
    if (!layer || !layer.buffer || !c) continue;
    const end = layerRootEnd(c, layer.buffer.duration);
    if (end != null && end > total) total = end;
  }
  reviewSetRange(reviewGeo.min, total);
  const endAt = startAt + (total - F) + 0.2;
  const tick = setInterval(() => {
    if (!audioEngine.ctx || audioEngine.ctx !== ctx || !reviewLive(seq)) { clearInterval(tick); return; }
    if (ctx.currentTime < endAt) reviewTick(seq, F + Math.max(0, ctx.currentTime - startAt));
    else {
      clearInterval(tick);
      reviewFinish(seq, "With-original preview finished.");
    }
  }, 150);
  if (reviewPreview && reviewPreview.seq === seq) reviewPreview.teardown = () => clearInterval(tick);
  const row = document.querySelector(`.rc-commit[data-commit="${commit.id}"]`);
  if (row) row.classList.add("playing");
  hub.playing = { repoId: commit.repo_id, commitId: commit.id };
  syncPlayState();
  if (commit.repo_id) countRepoPlay(commit.repo_id);
  setStudioStatus(
    failed.length
      ? "⚠ " + failed.length + " layer(s) couldn't decode for the preview — " + (failed[0].message || "")
      : "▶ with-original preview"
  );
  reviewSetNote(reviewMixPlayingNote(F));
}
/* iOS with-original preview: WebKit drops live Web Audio sources silently, so
   the chain + take is rendered OFFLINE (renderIOSMixBlob — pure DSP, same as
   the record-setup audition) and the resulting WAV plays through a native
   <audio> element, the proven iOS path. The render is async, so play() falls
   outside the original tap's gesture and iOS blocks it the first time — arm
   again on the next touch (iosSetupAudition does the same). */
async function reviewMixIOSEngine(seq, F, commit, extra) {
  const from = Number(F) > 0.05 ? fmtStartTime(F) : "the top";
  // Register the cancel hook immediately so “■ Stop” pressed while the mix is
  // still rendering aborts it — the old code let the render keep running out its
  // whole timeout before the reviewLive guard discarded the result, wasting the
  // phone's only JS thread on every stopped preview.
  const job = mixRenderJob(commit, extra, F, {
    ms: 40000,
    onStage: (s) => { if (reviewLive(seq)) reviewSetNote(s); },
  });
  if (reviewPreview && reviewPreview.seq === seq) {
    const prevTeardown = reviewPreview.teardown;
    reviewPreview.teardown = () => {
      try { job.abort(); } catch (_) {}
      if (prevTeardown) prevTeardown();
    };
  }
  let blob = null;
  try {
    blob = await job;
  } catch (err) {
    if (!reviewLive(seq)) return; // stopped or superseded while rendering
    // Never leave the take silent: the layered render failed (deadline, decode,
    // or phone memory), but the fresh take itself is always playable — fall back
    // to the take-only preview with a clear note. reviewBegin tears this preview
    // down and restarts it as kind "take", which is what the transport shows.
    const why = (err && err.message) || err;
    // Start the take at its own audible start — exactly what the "Take-only
    // preview" button would play — not at the mix's F (the take has no backing
    // around it anymore).
    reviewBegin("take", reviewStartRoot("take"), false);
    reviewSetNote("⚠ couldn't render the layered mix on this phone (" + why + ") — playing the take alone so you can still hear the new recording.");
    return;
  }
  if (!reviewLive(seq)) return; // superseded while rendering
  const url = URL.createObjectURL(blob);
  const el = new Audio();
  el.preload = "auto";
  routeElToOutput(el); // keep the rendered mix on the chosen output device
  el._mixUrl = url;    // revoked in closeAudio()
  reviewSetNote("Mixing done — starting playback…");
  let torn = false;
  let sounding = false;
  let tick = null;
  let bail = null;
  const teardown = () => {
    if (torn) return;
    torn = true;
    if (bail) clearTimeout(bail);
    if (tick) clearInterval(tick);
    try { el.pause(); el.removeAttribute("src"); el.load(); } catch (_) {}
  };
  if (reviewPreview && reviewPreview.seq === seq) reviewPreview.teardown = teardown;
  audioEngine.elements.push(el); // paused + _mixUrl revoked by closeAudio()
  tick = setInterval(() => {
    if (torn || !reviewLive(seq)) { clearInterval(tick); return; }
    if (!sounding) return; // not playing yet — leave the readout where reviewBegin put it
    reviewTick(seq, F + (el.currentTime || 0));
  }, 150);
  bail = setTimeout(() => {
    if (!torn && reviewLive(seq) && !sounding) {
      reviewFinish(seq, "playback didn't start — press “▶ With original” to retry");
    }
  }, 25000);
  el.onloadedmetadata = () => {
    if (torn || !reviewLive(seq)) return;
    const d = el.duration;
    if (isFinite(d) && d > 0) reviewSetRange(0, Math.max(reviewGeo.max, F + d));
  };
  const markPlaying = () => {
    if (torn || !reviewLive(seq) || sounding) return;
    sounding = true;
    if (bail) clearTimeout(bail);
    const d = el.duration;
    if (isFinite(d) && d > 0) reviewSetRange(0, Math.max(reviewGeo.max, F + d));
    const row = document.querySelector(`.rc-commit[data-commit="${commit.id}"]`);
    if (row) row.classList.add("playing");
    hub.playing = { repoId: commit.repo_id, commitId: commit.id };
    syncPlayState();
    if (commit.repo_id) countRepoPlay(commit.repo_id);
    setStudioStatus("▶ with-original preview (rendered mix)");
    reviewSetNote(reviewMixPlayingNote(F));
  };
  el.onplaying = markPlaying;
  el.onended = () => { if (sounding && reviewLive(seq)) reviewFinish(seq, "With-original preview finished."); };
  const tryPlay = () => {
    if (torn || !reviewLive(seq) || sounding) return;
    el.play()
      .then(() => { if (!torn && reviewLive(seq)) markPlaying(); })
      .catch((e) => {
        if (torn || !reviewLive(seq)) return;
        if (e && e.name === "AbortError") return; // stopped by closeAudio()
        if (e && e.name === "NotAllowedError") {
          // iOS needs a fresh user gesture for the play() — the next touch IS one.
          reviewSetNote("Rendering done — tap once to play from " + from + ".");
          const retry = () => {
            window.removeEventListener("touchend", retry);
            window.removeEventListener("click", retry);
            if (torn || !reviewLive(seq) || sounding) return;
            el.play()
              .then(() => { if (!torn && reviewLive(seq)) markPlaying(); })
              .catch((e2) => {
                if (torn || !reviewLive(seq)) return;
                if (e2 && e2.name === "AbortError") return;
                reviewFinish(seq, "the browser blocked the preview — press “▶ With original” again");
              });
          };
          window.addEventListener("touchend", retry, { once: true });
          window.addEventListener("click", retry, { once: true });
          return;
        }
        reviewFinish(seq, "couldn't play the rendered mix: " + ((e && e.message) || e));
      });
  };
  el.addEventListener("loadedmetadata", tryPlay, { once: true });
  el.addEventListener("canplay", tryPlay, { once: true });
}

function openTakePreview() {
  const commit = studio.backingCommit;
  // takeStartGuess is blob-relative. The blob's zero is the session start =
  // studio.sessionFrom on the root timeline (minus the sing-along sync-delay
  // compensation, which pulls lead earlier — see applyLatencyComp); for a
  // whole-song take sessionFrom is 0, so blob position == root position and
  // the Start field uses it directly — the `+ lead` keeps the formula correct
  // for mid-song takes whose session began TAKE_PRE_ROLL before the point.
  const start = (isFinite(studio.takeStartGuess) && studio.takeStartGuess > 0 ? studio.takeStartGuess : 0) + (studio.lead || 0);
  // “Sync delay (ms)”: only a mid-song take sung along with the audible
  // backing gets compensated (takeCompEnabled). studio.lead already includes
  // the session's compensation; this field lets the singer fine-tune it for
  // THIS device — the Start field above follows live, and the value rides
  // `lead` into the commit and is remembered for the next take on this device.
  const syncEnabled = !!studio.takeCompEnabled;
  const syncMax = syncEnabled ? maxTakeDelayMs(studio.sessionFrom) : 0;
  const syncMs = syncEnabled ? Math.min(Math.max(0, Math.round(studio.latencyCompMs)), syncMax) : 0;
  const measuredMs = Math.round(studio.sessionLatencyMs || 0);
  const syncHtml = syncEnabled
    ? `
    <label class="rc-field" title="A take sung along with the audible backing is recorded this many ms late (you follow what you hear, and the capture path adds its own input latency). The browser-measured round trip for this device is ${measuredMs} ms — listen to “With original” and nudge until your voice locks to the song. Remembered on this device for future takes.">
      <span>Sync delay (ms)${syncMs ? ` — ${syncMs} ms applied` : ""}</span>
      <input type="number" id="commit-sync-ms" min="0" max="${syncMax}" step="10" value="${syncMs}" />
    </label>`
    : "";
  const contributorDefault = displayName(hub.user) || "admin";
  const warnings = [];
  if (typeof studio.takeLevel === "number" && studio.takeLevel < 0.002) {
    warnings.push("This take decoded as silent / very quiet — the mic may not have captured your voice (a known iOS mic issue). Re-record, and check the iPhone isn’t muted.");
  }
  if (studio.blob && studio.blob.size > (MAX_AUDIO_UPLOAD_MB - 1) * 1024 * 1024) {
    warnings.push(`This take is ${(studio.blob.size / (1024 * 1024)).toFixed(1)} MB — near the ${MAX_AUDIO_UPLOAD_MB} MB upload cap. Consider re-recording a shorter take.`);
  }
  const warnHtml = warnings.length
    ? warnings.map((w) => `<p class="rc-hint rc-hint-danger">⚠ ${w}</p>`).join("")
    : "";
  showModal(`
    <h3 class="rc-modal-title">Review take</h3>
    <p class="rc-modal-sub">Over <span class="rc-hash">${commitHash(commit.id)}</span> · ${scEscapeHTML(commit.message)}</p>
    <div class="rc-preview-row">
      <button type="button" class="rc-btn rc-btn-ghost" id="preview-take-btn">▶ Take only</button>
      <button type="button" class="rc-btn rc-btn-ghost" id="preview-mix-btn">▶ With original</button>
    </div>
    <div class="rc-preview-transport" id="review-transport" hidden>
      <label class="rc-start-label" for="review-prev-bar"><span id="review-prev-label">Take-only preview</span>
        <span class="rc-start-time" id="review-prev-time">0:00</span>
      </label>
      <input type="range" id="review-prev-bar" min="0" max="0" step="0.1" value="0" disabled="" aria-label="Preview position — drag to jump" />
      <span class="rc-preview-actions">
        <button type="button" class="rc-btn rc-btn-ghost rc-btn-sm" id="review-prev-reset" disabled="">↶ From the start</button>
      </span>
      <span class="rc-hint" id="review-prev-note">Press ▶ Take only to hear the dry take, or ▶ With original to hear it over the song — while either plays, this bar scrubs and the preview button above becomes “■ Stop”.</span>
    </div>
    <label class="rc-field">Commit message
      <input type="text" id="commit-message" maxlength="500" placeholder="e.g. second take, stronger chorus" />
    </label>
    <label class="rc-field">Contributor
      <input type="text" id="commit-contributor" maxlength="60" placeholder="admin" value="${scEscapeHTML(contributorDefault)}" />
    </label>
    <div class="rc-field-row">
      <label class="rc-field">Start (s)
        <input type="number" id="commit-start" step="0.1" min="0" value="${start.toFixed(1)}" />
      </label>
      <label class="rc-field">End (s)
        <input type="text" id="commit-end" inputmode="decimal" value="end" placeholder="end — natural take length" />
      </label>
      <label class="rc-field">Mode
        <select id="commit-mode">
          <option value="overlay">overlay — layered on parent</option>
          <option value="single">single — standalone sound</option>
        </select>
      </label>
    </div>${syncHtml}
    <label class="rc-vol-field" title="How loud this take plays against the parent — 100% is unchanged">
      <span>Volume</span>
      <input type="range" id="commit-volume" min="0" max="200" step="5" value="100" />
      <span class="rc-vol-pct" id="commit-volume-pct">100%</span>
    </label>
    <p class="rc-hint">Start is auto-detected from the first sound in your take — adjust if needed.${syncEnabled ? ` Sync delay backs out the recording round trip so a take sung along with the audible backing lands where it was sung (this device measured ${measuredMs} ms; tune it with “With original” preview and it is remembered here).` : ""} Leave End as "end" to play the take's natural length.</p>
    ${warnHtml}
    <div class="rc-modal-actions">
      <button type="button" class="rc-btn rc-btn-ghost" id="discard-take-btn">Discard</button>
      <button type="button" class="rc-btn rc-btn-primary" id="commit-take-btn">Commit take</button>
    </div>
  `, (overlay) => {
    // ▶ Take only / ▶ With original run inside the transport below the buttons:
    // the active preview button flips to “■ Stop” (reviewStart stops it when
    // re-pressed) and the bar scrubs root-timeline seconds.
    overlay.querySelector("#preview-take-btn").addEventListener("click", () => reviewStart("take"));
    overlay.querySelector("#preview-mix-btn").addEventListener("click", () => reviewStart("mix"));
    const prevBar = overlay.querySelector("#review-prev-bar");
    if (prevBar) {
      // Drag: while the thumb moves the user owns the readout — the playhead
      // clock/bar stand down until release. Release is the seek: restart the
      // preview from the new point so it keeps playing from there (same as the
      // record-setup scrubber).
      prevBar.addEventListener("input", () => {
        if (prevBar.disabled) return;
        reviewScrubbing = true;
        reviewSetClock(reviewClamp(Number(prevBar.value) || 0));
      });
      prevBar.addEventListener("change", () => {
        reviewScrubbing = false;
        if (!reviewPreview) return;
        const v = reviewClamp(Number(prevBar.value) || 0);
        reviewBegin(reviewPreview.kind, v, true); // keep the measured span; play from v
      });
    }
    const prevReset = overlay.querySelector("#review-prev-reset");
    if (prevReset) {
      prevReset.addEventListener("click", () => {
        if (!reviewPreview) return;
        reviewBegin(reviewPreview.kind, reviewGeo.start, true);
      });
    }
    const volInput = overlay.querySelector("#commit-volume");
    const volPct = overlay.querySelector("#commit-volume-pct");
    volInput.addEventListener("input", () => { volPct.textContent = volInput.value + "%"; });
    // “Sync delay (ms)”: shifting the compensation changes studio.lead, and the
    // Start field (root position = detected blob start + lead) follows so the
    // “With original” preview and the commit use the corrected geometry.
    const startInput = overlay.querySelector("#commit-start");
    const syncInput = overlay.querySelector("#commit-sync-ms");
    if (syncInput) {
      const syncMaxV = Math.max(0, parseInt(syncInput.max, 10) || 0);
      syncInput.addEventListener("input", () => {
        const v = Math.max(0, Math.min(Math.round(parseFloat(syncInput.value) || 0), syncMaxV));
        if (String(v) !== syncInput.value) syncInput.value = String(v);
        studio.latencyCompMs = v;
        studio.lead = Math.max(0, (studio.sessionFrom || 0) - v / 1000);
        localStorage.setItem(STUDIO_TAKE_DELAY_KEY, String(v));
        if (startInput) {
          const s = (isFinite(studio.takeStartGuess) && studio.takeStartGuess > 0 ? studio.takeStartGuess : 0) + (studio.lead || 0);
          startInput.value = s.toFixed(1);
        }
      });
    }

    overlay.querySelector("#discard-take-btn").addEventListener("click", () => {
      studio.cancelled = true;
      setRecordUI(false);
      cleanupTakeMedia();
      if (studio.blobUrl) URL.revokeObjectURL(studio.blobUrl);
      studio.blobUrl = null;
      studio.blob = null;
      closeModal();
      setStudioStatus("");
      renderHub();
    });
    overlay.querySelector("#commit-take-btn").addEventListener("click", () => commitTake(overlay));
  });
}

async function commitTake(overlay) {
  const commit = studio.backingCommit;
  const message = (overlay.querySelector("#commit-message").value || "").trim();
  const contributor = overlay.querySelector("#commit-contributor").value.trim();
  const start = parseFloat(overlay.querySelector("#commit-start").value) || 0;
  const endRaw = parseFloat(overlay.querySelector("#commit-end").value);
  const end = isFinite(endRaw) && endRaw > 0 ? endRaw : null;
  const mode = overlay.querySelector("#commit-mode").value;
  const rawVol = parseFloat(overlay.querySelector("#commit-volume").value);
  const volume = isFinite(rawVol) ? rawVol / 100 : 1; // 0 = muted
  if (!message) {
    alert("Please enter a commit message.");
    return;
  }
  if (!studio.blob) return;
  const btn = overlay.querySelector("#commit-take-btn");
  btn.disabled = true;
  btn.textContent = "Uploading…";
  try {
    const url = await uploadBlob(studio.blob);
    const data = await hubApi(`/api/recordings/${commit.repo_id}/commits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: commit.id, message, url, start_time: start, end_time: end, mode, volume, lead: studio.lead || 0, contributor }),
    });
    // The committed take is now this repo's newest commit — advance the ✓ onto
    // it so the next ● Record Take layers on top of this one. (Before this, the
    // ✓ stayed on the original base forever, so every repeated Record Take
    // became a SIBLING of the root and the newest take's chain only ever held
    // that one parent — the earlier takes were never mixed under it. With every
    // take parented, the history grows as one stack root → take1 → take2 → …
    // and playing the newest one mixes the whole ancestor chain.)
    if (data && data.commit && data.commit.id != null) {
      hub.checkedOut = { repoId: commit.repo_id, commitId: data.commit.id };
    }
    studio.cancelled = true;
    cleanupTakeMedia();
    if (studio.blobUrl) URL.revokeObjectURL(studio.blobUrl);
    studio.blobUrl = null;
    studio.blob = null;
    closeModal();
    setStudioStatus("");
    await loadHub();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Commit take";
    alert(err.message);
  }
}

/* Quick magic-byte check so a stale file (WebM/OGG/FLAC from before the WAV
   migration) fails with a clear message instead of a confusing server round-trip.
   Returns "wav" | "mp3" | "WebM" | "Ogg" | "FLAC" | "MP4/M4A" | "unknown" | null
   (null = couldn't read or too small — let the server decide). M4A is allowed:
   uploadBlob transcodes it to WAV; every other non-WAV/MP3 kind is rejected. */
async function sniffAudioKind(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (head.length < 12) return null;
    if (
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45
    ) return "wav";
    if (
      (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) ||
      (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
    ) return "mp3";
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "WebM";
    if (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return "Ogg";
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) return "FLAC";
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "MP4/M4A";
    return "unknown";
  } catch (_) {
    return null;
  }
}

/* M4A → 22050 Hz mono 16-bit PCM WAV, converted in the browser. The client
   picked the file, so its browser can decode M4A; re-encoding to the same WAV
   format the recorder produces keeps every stored file decodable through
   decodeAudioData on every browser (including iOS Safari) — the server still
   only ever receives WAV/MP3 bytes. */
async function transcodeM4aToWav(blob) {
  const ab = await blob.arrayBuffer().catch(() => null);
  if (!ab) throw new Error("Could not read the M4A file.");
  let shared = null;
  let ctx = null;
  if (audioEngine.ctx && audioEngine.ctx.state !== "closed") {
    shared = audioEngine.ctx;
    ctx = shared;
  } else {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) { ctx = null; }
  }
  if (!ctx) throw new Error("This browser could not create an audio context to convert the M4A file.");
  let buf;
  try {
    buf = await decodeAudioCompat(ctx, ab);
  } catch (err) {
    throw new Error("This browser could not decode the M4A file: " + (err.message || err));
  } finally {
    if (!shared) { try { if (typeof ctx.close === "function") ctx.close(); } catch (_) {} }
  }
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const mono = new Float32Array(buf.length);
  if (ch1) {
    for (let i = 0; i < buf.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
  } else {
    mono.set(ch0);
  }
  return encodeWav([mono], buf.sampleRate || 44100, 22050);
}

async function uploadBlob(blob) {
  const kind = await sniffAudioKind(blob);
  let out = blob;
  if (kind === "MP4/M4A") {
    out = await transcodeM4aToWav(blob);
    if (!out || out.size > MAX_AUDIO_UPLOAD_BYTES) {
      throw new Error(`The M4A is too long — converting it to WAV exceeds the ${MAX_AUDIO_UPLOAD_MB}MB upload limit.`);
    }
  } else if (kind && kind !== "wav" && kind !== "mp3" && kind !== "unknown") {
    throw new Error(
      `Unsupported audio type: ${kind}. This site accepts WAV, MP3, or M4A (M4A is converted to WAV).`
    );
  }
  const token = getHubToken();
  const res = await fetch("/api/music/upload", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: out,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.url;
}


/* ── First-login profile setup (invite-code account) ───── */
/* The invite code creates the account and auto-joins its band. This form
   collects the display name / email and lets the user tick every band they
   also belong to (the invite-bound band is already joined, pre-checked). */
async function showProfileSetup() {
  const bandsData = await hubApi("/api/bands");
  const bands = bandsData.bands || [];
  const myBandIds = new Set((hub.user && hub.user.bands || []).map((b) => b.id));
  const bandOptions = bands
    .map(
      (b) => `
        <label class="rc-check">
          <input type="checkbox" class="profile-band-cb" value="${b.id}" ${myBandIds.has(b.id) ? "checked" : ""} />
          <span>${scEscapeHTML(b.name)}</span>
        </label>`
    )
    .join("");
  showModal(`
    <h3 class="rc-modal-title">Welcome — set up your profile</h3>
    <p class="rc-modal-sub">Your invite-code account is ready. Recordings in the REC HUB are private to the bands you join.</p>
    <label class="rc-field">Nickname
      <input type="text" id="profile-nickname" maxlength="60" placeholder="How your name appears on takes" />
    </label>
    <label class="rc-field">Email
      <input type="email" id="profile-email" maxlength="200" placeholder="you@example.com" />
    </label>
    <div class="rc-field">
      <span class="rc-field-label">Bands <span class="rc-hint">(the band from your invite is already selected — tick any others you belong to)</span></span>
      <div class="rc-band-picker" id="profile-bands">${bandOptions || '<p class="rc-hint">No bands exist yet — ask the admin to create one.</p>'}</div>
    </div>
    <p class="rc-modal-error" id="profile-error"></p>
    <div class="rc-modal-actions">
      <button type="button" class="rc-btn rc-btn-primary" id="profile-save-btn">Save profile</button>
    </div>
  `, (overlay) => {
    overlay.querySelector("#profile-save-btn").addEventListener("click", async () => {
      const nickname = overlay.querySelector("#profile-nickname").value.trim();
      const email = overlay.querySelector("#profile-email").value.trim();
      const bandIds = Array.from(overlay.querySelectorAll(".profile-band-cb:checked")).map((cb) => Number(cb.value));
      const errEl = overlay.querySelector("#profile-error");
      if (!nickname) { errEl.textContent = "Please enter a nickname."; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { errEl.textContent = "Please enter a valid email."; return; }
      if (!bandIds.length) { errEl.textContent = "Choose at least one band."; return; }
      try {
        const data = await hubApi("/api/auth/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname, email, band_ids: bandIds }),
        });
        hub.user = data.user;
        hub.admin = !!data.user.is_admin;
        closeModal();
        await loadHub();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  });
}

/* ── New recording (init repo) ─────────────────────────── */
let newRecBlob = null;     // Blob when the source was recorded from mic
let newRecUrl = null;      // /recordings/... URL when uploaded, or blob: URL
let newRecStream = null;
let newRecRecorder = null;
let newRecTimer = null;
let newRecStart = 0;
let newRecDuration = 0;
let newRecCtx = null;      // explicit context for the mic-recording graph (so we can close it)
let newRecMonitor = null;  // live monitor node for the mic-recording graph

async function openNewRecording() {
  newRecBlob = null;
  newRecUrl = null;
  const contributorDefault = displayName(hub.user) || "admin";
  // Members pick one of their own bands; admins may pick any band.
  const allBands = hub.admin
    ? await hubApi("/api/bands").then((d) => d.bands || []).catch(() => [])
    : (hub.user && hub.user.bands) || [];
  const bandOptions = allBands
    .map(
      (b) => `<option value="${b.id}">${scEscapeHTML(b.name)}</option>`
    )
    .join("");
  showModal(`
    <h3 class="rc-modal-title">New Recording</h3>
    ${
      bandOptions
        ? `<label class="rc-field">Band <span class="rc-hint">(recording is private to this band's members)</span>
        <select id="new-band">${bandOptions}</select>
      </label>`
        : `<p class="rc-hint rc-hint-warn">No bands yet — ask the admin to create one (admin page → Bands).</p>`
    }
    <label class="rc-field">Title
      <input type="text" id="new-title" maxlength="300" placeholder="e.g. Midnight Dreams" />
    </label>
    <label class="rc-field">Type
      <select id="new-source-type">
        <option value="original" selected>原创</option>
        <option value="cover">Cover</option>
      </select>
    </label>
    <label class="rc-field">Commit message
      <input type="text" id="new-message" maxlength="500" placeholder="e.g. initial recording" />
    </label>
    <label class="rc-field">Contributor
      <input type="text" id="new-contributor" maxlength="60" placeholder="admin" value="${scEscapeHTML(contributorDefault)}" />
    </label>
    <div class="rc-source-row">
      <button type="button" class="rc-btn rc-btn-ghost" id="new-file-btn">⬆ Upload audio</button>
      <input type="file" id="new-file" accept=".wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4,audio/*" class="rc-file-hidden" />
      <button type="button" class="rc-btn rc-btn-ghost" id="new-record-btn">● Record from mic</button>
      <button type="button" class="rc-btn rc-btn-ghost" id="new-stop-btn" hidden>■ Stop</button>
    </div>
    <p class="rc-source-status" id="new-source-status">Choose an audio source.</p>
    <p class="rc-hint" id="new-mic-hint">● Record from mic records through the microphone chosen in the top bar (next to ● Record Take) and follows the input channel (L/R) and 监听 Monitor options you set there for your last ● Record Take — first time defaults: L+R, monitor off.</p>
    <div class="rc-timer-wrap" id="new-timer-wrap" hidden><span class="rc-timer" id="new-timer">0:00</span></div>
    <p class="rc-note">注意：上传录音，即用户承诺拥有录音全部版权及授权；禁止上传侵权、违规音频，谢谢。</p>
    <div class="rc-modal-actions">
      <button type="button" class="rc-btn rc-btn-ghost" id="new-cancel-btn">Cancel</button>
      <button type="button" class="rc-btn rc-btn-primary" id="new-create-btn" ${bandOptions ? "" : "disabled"}>Create Recording</button>
    </div>
  `, (overlay) => {
    overlay.querySelector("#new-file-btn").addEventListener("click", () => {
      overlay.querySelector("#new-file").click();
    });
    overlay.querySelector("#new-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      e.target.value = "";
      const status = overlay.querySelector("#new-source-status");
      if (f.size > MAX_AUDIO_UPLOAD_BYTES) {
        status.textContent = `✗ File too large — max ${MAX_AUDIO_UPLOAD_MB}MB.`;
        return;
      }
      status.textContent = "Uploading…";
      uploadBlob(f)
        .then((url) => {
          newRecBlob = null;
          newRecUrl = url;
          status.textContent = "✓ Audio ready: " + url;
        })
        .catch((err) => { status.textContent = "✗ " + err.message; });
    });
    overlay.querySelector("#new-record-btn").addEventListener("click", () => startNewRec(overlay));
    overlay.querySelector("#new-stop-btn").addEventListener("click", () => stopNewRec(overlay));
    overlay.querySelector("#new-cancel-btn").addEventListener("click", () => {
      cancelNewRec();
      closeModal();
    });
    overlay.querySelector("#new-create-btn").addEventListener("click", () => createNewRecording(overlay));
  });
}

async function startNewRec(overlay) {
  try {
    newRecStream = await getUserMic();
  } catch (err) {
    overlay.querySelector("#new-source-status").textContent = "✗ mic unavailable: " + err.message;
    return;
  }
  // Explicit context (created inside this click, satisfying the autoplay
  // policy) so stopNewRec / cancelNewRec can close it — createRecorder with a
  // context passed in leaves context management to us.
  newRecCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Same output routing as the take path — the 监听 monitor plays on the chosen
  // device (e.g. headphones), not the OS default speakers.
  await routeCtxToOutput(newRecCtx);
  const trackSettings =
    newRecStream.getAudioTracks()[0] && newRecStream.getAudioTracks()[0].getSettings
      ? newRecStream.getAudioTracks()[0].getSettings()
      : null;
  let pick = inputChannelForTake();
  if (trackSettings && trackSettings.channelCount === 1 && pick !== "both") pick = "both";
  // Same output-only live monitor as the take path — never reaches the WAV.
  if (monitorForTake()) newRecMonitor = monitorInput(newRecCtx, newRecStream, pick);
  newRecRecorder = createRecorder(newRecCtx, newRecStream, {
    // The recorder assembles the WAV itself; onStop delivers the finished blob.
    onData: () => {},
    onStop: (wavBlob) => {
      const blob = wavBlob;
      if (!blob || !blob.size) {
        const statusEl = overlay.querySelector("#new-source-status");
        statusEl.textContent = "✗ nothing was recorded — please try again.";
        overlay.querySelector("#new-record-btn").hidden = false;
        overlay.querySelector("#new-stop-btn").hidden = true;
        return;
      }
      newRecBlob = blob;
      if (newRecUrl && newRecUrl.startsWith("blob:")) URL.revokeObjectURL(newRecUrl);
      newRecUrl = URL.createObjectURL(blob);
      const status = overlay.querySelector("#new-source-status");
      status.textContent = "✓ Recorded take ready (" + fmtTime(newRecDuration) + ")";
      overlay.querySelector("#new-record-btn").hidden = false;
      overlay.querySelector("#new-stop-btn").hidden = true;
    },
  }, pick);
  if (!newRecRecorder) {
    if (newRecMonitor) {
      try { newRecMonitor.src.disconnect(); } catch (_) {}
      try { if (newRecMonitor.splitter) newRecMonitor.splitter.disconnect(); } catch (_) {}
      try { newRecMonitor.gain.disconnect(); } catch (_) {}
      newRecMonitor = null;
    }
    if (newRecCtx) {
      try { newRecCtx.close().catch(() => {}); } catch (_) {}
      newRecCtx = null;
    }
    newRecStream.getTracks().forEach((t) => t.stop());
    newRecStream = null;
    overlay.querySelector("#new-source-status").textContent = "✗ this browser cannot record audio";
    return;
  }
  newRecRecorder.start(250);
  newRecStart = Date.now();
  newRecDuration = 0;
  overlay.querySelector("#new-record-btn").hidden = true;
  overlay.querySelector("#new-stop-btn").hidden = false;
  overlay.querySelector("#new-timer-wrap").hidden = false;
  newRecTimer = setInterval(() => {
    newRecDuration = (Date.now() - newRecStart) / 1000;
    overlay.querySelector("#new-timer").textContent = fmtTime(newRecDuration);
  }, 200);
}


function stopNewRec(overlay) {
  if (newRecRecorder && newRecRecorder.state !== "inactive") newRecRecorder.stop();
  if (newRecStream) {
    newRecStream.getTracks().forEach((t) => t.stop());
    newRecStream = null;
  }
  if (newRecMonitor) {
    try { newRecMonitor.src.disconnect(); } catch (_) {}
    try { if (newRecMonitor.splitter) newRecMonitor.splitter.disconnect(); } catch (_) {}
    try { newRecMonitor.gain.disconnect(); } catch (_) {}
    newRecMonitor = null;
  }
  if (newRecCtx) {
    // Close AFTER recorder.stop() so onStop can still read ctx.sampleRate.
    try { newRecCtx.close().catch(() => {}); } catch (_) {}
    newRecCtx = null;
  }
  clearInterval(newRecTimer);
  if (overlay) {
    overlay.querySelector("#new-timer-wrap").hidden = true;
  }
}

function cancelNewRec() {
  if (newRecRecorder && newRecRecorder.state !== "inactive") {
    try { newRecRecorder.stop(); } catch (_) {}
  }
  if (newRecStream) {
    newRecStream.getTracks().forEach((t) => t.stop());
    newRecStream = null;
  }
  if (newRecMonitor) {
    try { newRecMonitor.src.disconnect(); } catch (_) {}
    try { if (newRecMonitor.splitter) newRecMonitor.splitter.disconnect(); } catch (_) {}
    try { newRecMonitor.gain.disconnect(); } catch (_) {}
    newRecMonitor = null;
  }
  if (newRecCtx) {
    try { newRecCtx.close().catch(() => {}); } catch (_) {}
    newRecCtx = null;
  }
  clearInterval(newRecTimer);
  if (newRecUrl && newRecUrl.startsWith("blob:")) URL.revokeObjectURL(newRecUrl);
  newRecUrl = null;
  newRecBlob = null;
}

async function createNewRecording(overlay) {
  const title = overlay.querySelector("#new-title").value.trim();
  const message = overlay.querySelector("#new-message").value.trim() || "Initial recording";
  const contributor = overlay.querySelector("#new-contributor").value.trim();
  const sourceType = overlay.querySelector("#new-source-type").value;
  const bandEl = overlay.querySelector("#new-band");
  const bandId = bandEl ? Number(bandEl.value) : null;
  if (!bandId) { alert("Please choose a band for this recording."); return; }
  if (!title) { alert("Please enter a title."); return; }
  if (!newRecUrl) { alert("Please upload or record an audio source first."); return; }
  const btn = overlay.querySelector("#new-create-btn");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    let url = newRecUrl;
    if (newRecBlob) {
      url = await uploadBlob(newRecBlob);
    }
    const data = await hubApi("/api/recordings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, message, url, sort_order: 0, contributor, source_type: sourceType, band_id: bandId }),
    });
    // Check out the new repo's initial commit so ● Record Take is armed for it
    // right away — its first take then parents onto this commit (root → take1).
    if (data && data.repo && data.repo.id != null && data.commit && data.commit.id != null) {
      hub.checkedOut = { repoId: data.repo.id, commitId: data.commit.id };
    }
    cancelNewRec();
    closeModal();
    await loadHub();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Create Recording";
    alert(err.message);
  }
}

/* ── Init ──────────────────────────────────────────────── */
async function initHub() {
  await refreshAuth();
  await loadHub();
}

if (hubRootEl) initHub();

