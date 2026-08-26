/* ── REC HUB ────────────────────────────────────────────── */
/* Git-like recording hub. Each music row is a "repo" (a recording
   project); every take is a recording_commits commit:
     · message     → commit message
     · url         → sound file for the take
     · contributor → who made the take ('admin' by default — the only account)
     · start_time  → seconds into the parent's playback where the take starts
     · end_time    → seconds into the parent's playback where it ends
     · volume      → linear gain multiplier for this take when the chain plays
                     (1.0 = unchanged; used to balance a take vs the parent)
     · lead        → seconds between the backing start and the take blob's zero
                     point. New takes record from the backing start (lead = 0);
                     older takes used a 1.5 s count-in pre-roll (lead = 1.5).
                     The mix reads the blob from start_time − lead so the take
                     stays exactly where it was sung.
     · mode        → 'single' (plays alone) | 'overlay' (layered on parent)
   Visitors browse & listen. The owner (existing admin JWT in localStorage,
   same key as admin.js) can init a recording, check out a commit, record a
   take over its playback, preview it, and commit it. */

const trackListEl = document.getElementById("track-list");
const sectionTitleEl = document.querySelector("#music .section-title");
if (sectionTitleEl) sectionTitleEl.textContent = "REC HUB";

const TOKEN_KEY = "benpage_admin_token"; // same key as public/admin.js

const hub = {
  repos: [],
  commits: new Map(),     // repoId -> [commit...]
  expanded: null,         // repoId of the expanded commit history
  checkedOut: null,       // { repoId, commitId }
  admin: false,
  user: null,
};

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
  const token = localStorage.getItem(TOKEN_KEY);
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
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;
  try {
    const data = await hubApi("/api/auth/me");
    hub.admin = true;
    hub.user = data.user;
  } catch (_) {
    /* token expired/invalid → guest view */
  }
}

async function loadHub() {
  try {
    const data = await hubApi("/api/recordings");
    hub.repos = data.repos || [];
    hub.commits = new Map(hub.repos.map((r) => [r.id, r.commits || []]));
  } catch (err) {
    if (trackListEl) {
      trackListEl.innerHTML = `<p class="empty-note">Failed to load recordings.</p>`;
    }
    return;
  }
  renderHub();
}

/* ── Rendering ─────────────────────────────────────────── */
function renderHub() {
  if (!trackListEl) return;
  const toolbar = `
    <div class="hub-toolbar">
      ${
        hub.admin
          ? `<div class="hub-admin">
               <span class="hub-admin-user">● ${scEscapeHTML(
                 (hub.user && (hub.user.username || hub.user.name)) || "admin"
               )}</span>
               <button type="button" class="rc-btn rc-btn-primary" id="new-recording-btn">+ New Recording</button>
             </div>`
          : `<div class="hub-login-note">Sign in to record takes &nbsp;·&nbsp; <a href="/admin.html">admin →</a></div>`
      }
      <div class="studio-bar" id="studio-bar" ${hub.admin ? "" : "hidden"}>
        <span class="studio-checkout" id="studio-checkout">Nothing checked out — click a commit to record over it</span>
        <button type="button" class="rc-btn rc-btn-record" id="record-take-btn" disabled>● Record Take</button>
        <select id="studio-device" class="studio-device" title="Microphone used for takes — pick the real mic, not a loopback/stereo-mix device"></select>
        <label class="studio-phones" title="Headphones? Records the raw mic with the browser's echo canceller / noise suppressor turned off — the clearest take.">
          <input type="checkbox" id="studio-phones" ${localStorage.getItem(STUDIO_PHONES_KEY) === "1" ? "checked" : ""} /> Headphones
        </label>
        <label class="studio-phones" title="Mute the backing during this take (default on)? With the song muted nothing can bleed from the speakers into the mic — the take is guaranteed clean — but you sing a cappella to the count-in ticks. Uncheck to sing along with the song, e.g. in headphones.">
          <input type="checkbox" id="studio-no-backing" ${muteBackingForTake() ? "checked" : ""} /> No backing
        </label>
        <button type="button" class="rc-btn rc-btn-ghost" id="stop-playback-btn">■ Stop</button>
        <span class="studio-status" id="studio-status"></span>
      </div>
    </div>
    <div id="repo-list" class="repo-list"></div>`;
  trackListEl.innerHTML = toolbar;
  attachRepoListEvents();
  if (hub.admin) {
    document.getElementById("new-recording-btn").addEventListener("click", openNewRecording);
    document.getElementById("record-take-btn").addEventListener("click", startTakeRecording);
    document.getElementById("stop-playback-btn").addEventListener("click", stopPlayback);
    const phonesEl = document.getElementById("studio-phones");
    if (phonesEl) {
      phonesEl.checked = localStorage.getItem(STUDIO_PHONES_KEY) === "1";
      phonesEl.addEventListener("change", () =>
        localStorage.setItem(STUDIO_PHONES_KEY, phonesEl.checked ? "1" : "0")
      );
    }
    const noBackingEl = document.getElementById("studio-no-backing");
    if (noBackingEl) {
      noBackingEl.checked = muteBackingForTake();
      noBackingEl.addEventListener("change", () =>
        localStorage.setItem(STUDIO_MUTE_BACKING_KEY, noBackingEl.checked ? "1" : "0")
      );
    }
    populateMicDevices();
  }
  renderRepos();
}

function renderRepos() {
  const list = document.getElementById("repo-list");
  if (!list) return;
  if (!hub.repos.length) {
    list.innerHTML = `<p class="empty-note">No recordings yet${hub.admin ? " — start one above." : "."}</p>`;
    updateStudioBar();
    return;
  }
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  hub.repos.forEach((repo) => frag.appendChild(renderRepoCard(repo)));
  list.appendChild(frag);
  updateStudioBar();
}

function renderRepoCard(repo) {
  const commits = hub.commits.get(repo.id) || [];
  const head = commits[commits.length - 1] || null;
  const expanded = hub.expanded === repo.id;
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
          ${commits.length} commit${commits.length === 1 ? "" : "s"}
          ${head ? ` · HEAD ${commitHash(head.id)} ${scEscapeHTML(head.message)}` : ""}
          · ${Number(repo.play_count) || 0} plays
        </div>
      </div>
      <div class="rc-repo-actions">
        <button type="button" class="rc-icon-btn" data-action="share-repo" data-repo="${repo.id}" title="Share">↗</button>
        <button type="button" class="rc-icon-btn" data-action="toggle-repo" data-repo="${repo.id}" title="Commit history">${expanded ? "▾" : "▸"}</button>
        ${
          hub.admin
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

function renderCommitRows(repo, commits) {
  if (!commits.length) return `<p class="empty-note">No commits yet.</p>`;
  return commits
    .map((c) => {
      const checkedOut =
        hub.checkedOut && hub.checkedOut.repoId === repo.id && hub.checkedOut.commitId === c.id;
      const isOverlay = c.mode === "overlay";
      return `
        <div class="rc-commit ${checkedOut ? "checked-out" : ""}" data-commit="${c.id}">
          <div class="rc-commit-main" data-action="select-commit" data-repo="${repo.id}" data-commit="${c.id}">
            <div class="rc-commit-line">
              <span class="rc-hash">${commitHash(c.id)}</span>
              <span class="rc-msg">${scEscapeHTML(c.message)}</span>
              <span class="rc-badge ${isOverlay ? "rc-badge-overlay" : "rc-badge-single"}">${isOverlay ? "overlay" : "single"}</span>
            </div>
            <div class="rc-commit-meta">
              <span class="rc-range">⏱ ${fmtRange(c)}</span>
              ${isOverlay && c.parent_id != null ? `<span class="rc-parent">parent ${commitHash(c.parent_id)}</span>` : `<span class="rc-parent rc-parent-root">root</span>`}
              <span class="rc-byline">
                <span class="rc-date">${fmtStamp(c.created_at)}</span>
                <span class="rc-contributor">· 👤 ${scEscapeHTML(c.contributor || "admin")}</span>
              </span>
              ${hub.admin
                ? `<label class="rc-vol" title="Balance this take against the parent — 100% is unchanged">
                     <span>vol</span>
                     <input type="range" data-action="set-volume" data-repo="${repo.id}" data-commit="${c.id}" min="0" max="200" step="5" value="${Math.round(commitVolume(c) * 100)}" />
                     <span class="rc-vol-val">${Math.round(commitVolume(c) * 100)}%</span>
                   </label>`
                : `<span class="rc-vol" title="Take volume vs the parent — 100% is unchanged"><span>vol</span><span class="rc-vol-val">${Math.round(commitVolume(c) * 100)}%</span></span>`}
              ${checkedOut ? `<span class="rc-checked">✓ checked out</span>` : ""}
            </div>
          </div>
          <button type="button" class="rc-icon-btn rc-commit-play" data-action="play-commit" data-repo="${repo.id}" data-commit="${c.id}" title="Play this commit">▶</button>
          ${
            hub.admin
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

    if (action === "play-repo") {
      const commits = hub.commits.get(repoId) || [];
      const head = commits[commits.length - 1];
      if (head) playCommit(head);
    } else if (action === "toggle-repo") {
      hub.expanded = hub.expanded === repoId ? null : repoId;
      renderRepos();
    } else if (action === "share-repo") {
      const repo = hub.repos.find((r) => r.id === repoId);
      if (repo && typeof window.openShareDialog === "function") {
        window.openShareDialog({ title: repo.title, path: `/music/${repoId}` });
      }
    } else if (action === "play-commit") {
      const c = findCommit(Number(btn.dataset.commit));
      if (c) playCommit(c);
    } else if (action === "delete-commit") {
      const c = findCommit(Number(btn.dataset.commit));
      if (!c || !hub.admin) return;
      if (!window.confirm(`Delete commit ${commitHash(c.id)} "${c.message}"? This cannot be undone.`)) return;
      const playing = document.querySelector(".rc-commit.playing");
      if (playing && Number(playing.dataset.commit) === c.id) stopPlayback();
      hubApi(`/api/recordings/${repoId}/commits/${c.id}`, { method: "DELETE" })
        .then(() => {
          if (hub.checkedOut && hub.checkedOut.repoId === repoId && hub.checkedOut.commitId === c.id) {
            hub.checkedOut = null;
          }
          return loadHub();
        })
        .catch((err) => alert(err.message));
    } else if (action === "delete-repo") {
      if (!hub.admin) return;
      const repo = hub.repos.find((r) => r.id === repoId);
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
      if (hub.admin) {
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
    if (!input || !hub.admin) return;
    const repoId = Number(input.dataset.repo);
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
  if (!hub.admin) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const label = document.getElementById("studio-checkout");
  const btn = document.getElementById("record-take-btn");
  if (!hub.checkedOut) {
    label.textContent = "Nothing checked out — click a commit to record over it";
    btn.disabled = true;
  } else {
    const repo = hub.repos.find((r) => r.id === hub.checkedOut.repoId);
    const c = (hub.commits.get(hub.checkedOut.repoId) || []).find(
      (x) => x.id === hub.checkedOut.commitId
    );
    label.textContent = `Checked out: ${repo ? repo.title + " " : ""}${c ? commitHash(c.id) + " · " + c.message : ""}`;
    btn.disabled = false;
  }
  if (hub.admin && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
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
   it every time (0.5-3 s) used to swallow the count-in's lead time. */
const bufferCache = new Map(); // url → AudioBuffer

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

/* Decode one audio layer for playback → an AudioBuffer (cached by URL).
   Every recording in the library is WAV (and backings are WAV or MP3), and
   decodeAudioData accepts WAV and MP3 on every browser — including iOS
   Safari — so this is the single, deterministic playback path. */
async function decodeLayer(ctx, url) {
  const hit = bufferCache.get(url);
  if (hit) return { kind: "buffer", buffer: hit };
  // blob: URLs ignore cache mode and Safari rejects the cache option on them.
  const res = await fetch(url, url.indexOf("blob:") === 0 ? {} : { cache: "no-cache" });
  if (!res.ok) throw new Error("Could not load audio: " + url);
  const ab = await res.arrayBuffer();
  const buffer = await decodeAudioCompat(ctx, ab);
  bufferCache.set(url, buffer);
  return { kind: "buffer", buffer };
}

function closeAudio() {
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

/* iPadOS 13+ reports a desktop "MacIntel" UA; maxTouchPoints > 1 is the
   reliable tell. iOS Safari's Web Audio clock can run while sources are
   dropped silently, so iOS always plays through a native <audio> element. */
function isIOS() {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
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
  // First resume inside the user gesture, then decode every layer, then resume
  // again (awaited) so the clock is running before any source is scheduled.
  await ensureCtxRunning(ctx);
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
  if (!audioEngine.ctx) return; // stopped while loading
  // The commit clicked is jobs[0]; if its own file won't decode, the mix is
  // pointless — fall back to the same native <audio> path the share page uses.
  if (results[0] && results[0].status === "rejected") {
    playNativeTrack(commit, null, (results[0].reason && results[0].reason.message) || "audio would not decode");
    return;
  }
  const running = await ensureCtxRunning(ctx);
  if (!audioEngine.ctx) return; // stopped while resuming
  if (!running) {
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
  const row = document.querySelector(`.rc-commit[data-commit="${commit.id}"]`);
  if (row) row.classList.add("playing");
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
  const el = new Audio(url);
  el.preload = "auto";
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

/* Stereo 16-bit PCM WAV encoder for the rendered iOS mix. The render is already
   at the target sample rate, so no resampling — a straight two-channel write.
   (encodeWav above stays mono + resampling for the take recorder.) */
function encodeWavStereo(ch0, ch1, rate) {
  const n = Math.min(ch0.length, ch1.length);
  if (!n) return null;
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
  let o = 44;
  for (let i = 0; i < n; i++) {
    dv.setInt16(o, pcm(ch0[i] * 32767), true); o += 2;
    dv.setInt16(o, pcm(ch1[i] * 32767), true); o += 2;
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
  if (!commit || !commit.url) {
    playNativeTrack(commit, null, "no audio file");
    return;
  }
  setStudioStatus("▶ mixing…");
  let blob = null;
  try {
    blob = await Promise.race([
      renderIOSMixBlob(commit, extra),
      new Promise((_, rej) => setTimeout(() => rej(new Error("render timed out")), 30000)),
    ]);
  } catch (err) {
    setStudioStatus(`⚠ couldn't render the layered mix on this phone (${err.message}) — playing the commit alone.`, true);
    playNativeTrack(commit, extra, "mix render failed");
    return;
  }
  const mixUrl = URL.createObjectURL(blob);
  const row = document.querySelector(`.rc-commit[data-commit="${commit.id}"]`);
  const el = new Audio();
  el.preload = "auto";
  el._mixUrl = mixUrl; // revoked in closeAudio
  let started = false; // terminal: actually sounding, or gave up / fell back
  let attempt = 0;     // play() attempts for this blob
  // Still the active attempt? false once playing, or after closeAudio()/giveUp()
  // superseded this element (e.g. the user re-tapped play on another commit).
  const live = () => !started && el._mixUrl === mixUrl;
  const giveUp = (why) => {
    if (!live()) return;
    started = true;
    try { URL.revokeObjectURL(mixUrl); } catch (_) {}
    el._mixUrl = null;
    // The commit's own file over a server URL is the proven iOS playback path —
    // better than leaving the user stuck on "mixing…".
    setStudioStatus(`⚠ couldn't play the rendered mix (${why}) — playing the recording alone.`, true);
    playNativeTrack(commit, extra, "rendered mix didn't start");
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
    started = true; // audio is actually sounding — only now may the row go blue
    if (row) row.classList.add("playing");
    setStudioStatus(`▶ playing ${commitHash(commit.id)} (rendered mix)`);
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
  if (commit.repo_id) countRepoPlay(commit.repo_id);
}

/* Decode every chain layer, render the mix offline, and return a WAV Blob. */
async function renderIOSMixBlob(commit, extra) {
  const RATE = 44100;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const dec = new OAC(2, 1, RATE); // decoder only — its length is irrelevant
  const layers = [];
  for (const { commit: c, offset } of buildChain(commit)) {
    const layer = await decodeLayer(dec, c.url);
    layers.push({
      buffer: layer.buffer,
      offset,
      readOff: Math.max(0, (Number(c.start_time) || 0) - (Number(c.lead) || 0)),
      dur: takeDuration(c),
      gain: commitVolume(c),
    });
  }
  if (extra && extra.url) {
    const layer = await decodeLayer(dec, extra.url);
    layers.push({
      buffer: layer.buffer,
      offset: Math.max(0, Number(extra.start_time) || 0),
      readOff: Math.max(0, (Number(extra.start_time) || 0) - (Number(extra.lead) || 0)),
      dur: extra.duration,
      gain: extra.volume,
    });
  }
  if (!layers.length) throw new Error("no audio layers to mix");
  // Total length = the latest end across all sources (root plays to its end).
  let total = 1;
  for (const l of layers) {
    const bufDur = l.buffer.duration || 0;
    const readOff = Math.min(l.readOff, Math.max(0, bufDur - 0.001));
    const readDur = l.dur != null ? l.dur : Math.max(0.05, bufDur - readOff);
    total = Math.max(total, l.offset + readDur);
  }
  const len = Math.min(600, Math.max(1, total)) * RATE; // ≤ 10 min safety cap
  const mix = new OAC(2, Math.ceil(len), RATE);
  for (const l of layers) {
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
  const rendered = await renderOffline(mix);
  const ch0 = rendered.getChannelData(0);
  const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;
  const blob = encodeWavStereo(ch0, ch1, RATE);
  if (!blob) throw new Error("mix encode produced nothing");
  return blob;
}

/* "Take only" preview. Native <audio> with a blob: URL is unreliable on iOS
   Safari, so if the element can't start quickly, decode the in-memory blob
   through Web Audio instead (WAV always decodes). */
function playDry(url, start) {
  closeAudio();
  const el = new Audio(url);
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
  if (!(await ensureCtxRunning(ctx))) {
    audioEngine.ctx = null;
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
  fetch(`/api/music/${repoId}/play`, { method: "POST" }).catch(() => {});
}

function stopPlayback() {
  closeAudio();
  setStudioStatus("");
}


/* ── Studio / recording ────────────────────────────────── */
/* A take session: the checked-out commit's chain is used as backing — unless
   "No backing" is ticked in the studio bar, in which case the song is muted
   and the take is a cappella to the count-in ticks. Either way ONLY the dry
   mic is recorded: the backing is never routed into the take and the mic is
   never routed to the speakers (no monitoring), so playback cannot get into
   the take. Previewing/committing is done afterwards. */
const studio = {
  stream: null,
  recorder: null,
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
  lead: 0, // blob zero = backing start (0 for new takes; was TAKE_PRE_ROLL pre-roll)
};

/* Seconds of audible count-in after the backing starts (four ticks cueing
   "start singing as the last one ends"). The recorder starts together with the
   backing, so a take captures everything from the backing's first instant and
   is placed at mix time by its own detected start_time (lead = 0). The
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
function takeMicConstraints() {
  if (isIOS()) {
    // iOS Safari can return a silent capture when echo cancellation / AGC are
    // forced off, and its own DSP is solid — so on iOS keep the browser
    // defaults on regardless of the headphone / "No backing" flags.
    return { ...RECORD_AUDIO_CONSTRAINTS };
  }
  if (localStorage.getItem(STUDIO_PHONES_KEY) === "1" || muteBackingForTake()) {
    return { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  }
  return { ...RECORD_AUDIO_CONSTRAINTS };
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
function createTakeRecorder(ctx, stream) {
  return createRecorder(ctx, stream, {
    // The recorder assembles the WAV itself (createRecorder → encodeWav); it is
    // delivered whole in onStop. No per-buffer accumulation needed here.
    onData: () => {},
    onStop: (wavBlob) => onTakeStopped(wavBlob),
  });
}

/* Shared mic→recorder factory — PCM → WAV capture through an AudioContext on
   every browser (no MediaRecorder): guarantees a WAV take everywhere. */
function createRecorder(ctxIn, stream, handlers) {
  // PCM → WAV capture through an AudioContext.
  const ownCtx = !ctxIn;
  const ctx = ctxIn || new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
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

async function getUserMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Mic access is blocked: this page is on plain http — serve it over HTTPS to record");
  }
  // Let the user pick the real mic. The OS "default" input is often a
  // loopback / stereo-mix device that records whatever plays (e.g. the
  // backing track) — which is exactly the "parent sound in my take" symptom.
  const sel = document.getElementById("studio-device");
  const deviceId = sel && sel.value ? sel.value : "";
  const constraints = deviceId
    ? { audio: { ...takeMicConstraints(), deviceId: { exact: deviceId } } }
    : { audio: takeMicConstraints() };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (_) {
    // Some devices/OS reject an exact deviceId — retry without pinning, but
    // KEEP the processing flags so echo cancellation still strips any backing
    // that bleeds into the mic. Bare browser defaults are the last resort.
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: takeMicConstraints() });
    } catch (_2) {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }
}

/* Fixed backing level during a take session (0..1), applied only when the
   "No backing" studio-bar toggle is OFF. The backing plays at 70% so it
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
function scheduleCountIn(ctx, backingStartAt, chainStartAt) {
  const out = ctx.createGain();
  out.gain.value = 0.45;
  out.connect(ctx.destination);
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

async function populateMicDevices() {
  const sel = document.getElementById("studio-device");
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
    sel.addEventListener("change", () => localStorage.setItem("studio_mic_device", sel.value));
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
  // autoplay policy is satisfied; resume it once mic + buffers are ready.
  closeAudio(); // stop any ongoing playback first
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  audioEngine.ctx = ctx;

  let stream;
  try {
    stream = await getUserMic();
  } catch (err) {
    studio.recording = false;
    closeAudio();
    setStudioStatus("✗ microphone unavailable: " + err.message, true);
    return;
  }
  await ctx.resume().catch(() => {});
  studio.stream = stream;
  studio.backingCommit = commit;

  const chain = buildChain(commit);
  const backingMuted = muteBackingForTake(); // "No backing" — only the ticks play

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
  backingGain.connect(ctx.destination);

  for (const { c, offset, layer } of decoded) {
    scheduleLayer(ctx, layer, offset, Math.max(0, (Number(c.start_time) || 0) - (Number(c.lead) || 0)), takeDuration(c), backingStartAt, backingGain, commitVolume(c));
  }

  // Audible count-in ticks over the pre-roll — the 4th ends exactly at
  // chainStartAt ("start singing now"). As graph output they're part of the AEC
  // echo reference the browser cancels from the mic; even if a sliver bleeds
  // in, the mix reads the take from its own start_time, so pre-roll content
  // (ticks, backing bleed, DSP convergence) is never heard in the take.
  scheduleCountIn(ctx, backingStartAt, chainStartAt);

  // Record the RAW mic stream directly — same capture path as the initial
  // recording. The take is the clean dry mic: nothing from the backing or the
  // AudioContext graph is connected to this recorder, and the mic is not
  // routed to the speakers, so monitor playback can never contaminate the take.
  studio.takeLevel = null;
  studio.recorder = createTakeRecorder(ctx, stream);
  if (!studio.recorder) {
    studio.recording = false;
    cleanupTakeMedia();
    renderHub();
    setStudioStatus("✗ this browser cannot record audio (no Web Audio capture)", true);
    return;
  }
  // The take blob starts at the same instant as the backing (blob zero = root
  // zero), so lead is 0 and the take is positioned purely by its detected
  // start_time. Recording from the backing start is the key to a clean take
  // top: the old code started the recorder TAKE_PRE_ROLL after the backing, so
  // anything sung during the count-in was cut and the take began mid-phrase —
  // exactly the "first seconds sound messed up" symptom.
  studio.lead = 0;

  // Count-in pre-roll: the recorder starts at backingStartAt; the four ticks
  // run over the next TAKE_PRE_ROLL seconds as a musical count ("start singing
  // as the last tick ends"). With "No backing" on, the song itself is muted and
  // you sing a cappella to the ticks; either way the recorder is already
  // capturing, so singing early loses nothing, and at mix time the take is read
  // from its own start_time, so pre-roll audio never appears in the take.
  showRecordSession();
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
   (first/last non-silent sample). The times returned here are BLOB-RELATIVE:
   new takes record from the backing start (lead = 0), so blob position == root
   position; the commit modal still adds `lead` for generality. At mix time the
   blob is read from (start_time − lead), which keeps every blob position at its
   true root spot.

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

function showRecordSession() {
  const commit = studio.backingCommit;
  const backingMuted = muteBackingForTake();
  const sub = backingMuted
    ? "No backing — the song is muted for this take, so nothing can bleed into the mic: you record clean a cappella to the four rising ticks (start singing as the last one ends). The recorder is already capturing from the instant the ticks begin, so anything you sing from the first note is recorded. The take is only the dry mic (nothing mixed in)."
    : "Count-in: four rising ticks — start singing as the last one ends. The recorder is already capturing from the instant the backing starts, so anything you sing from the first note is recorded. The take is only the dry mic (nothing mixed in); wearing headphones (tick “Headphones” in the studio bar) records the raw mic with no echo suppression — the clearest take.";
  showModal(`
    <h3 class="rc-modal-title">Recording over ${commitHash(commit.id)}</h3>
    <p class="rc-modal-sub">${sub}</p>
    <div class="rc-timer-wrap">
      <span class="rc-rec-dot"></span>
      <span class="rc-timer" id="take-timer">0:00</span>
    </div>
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


function openTakePreview() {
  const commit = studio.backingCommit;
  // takeStartGuess is blob-relative. New takes record from the backing start
  // (lead = 0), so blob position == root-timeline position and the Start field
  // uses it directly; the `+ lead` keeps the formula correct for legacy
  // commits whose blob started after a pre-roll.
  const start = (isFinite(studio.takeStartGuess) && studio.takeStartGuess > 0 ? studio.takeStartGuess : 0) + (studio.lead || 0);
  const contributorDefault = (hub.user && (hub.user.username || hub.user.name)) || "admin";
  const warnings = [];
  if (typeof studio.takeLevel === "number" && studio.takeLevel < 0.002) {
    warnings.push("This take decoded as silent / very quiet — the mic may not have captured your voice (a known iOS mic issue). Re-record, and check the iPhone isn’t muted.");
  }
  if (studio.blob && studio.blob.size > 15 * 1024 * 1024) {
    warnings.push(`This take is ${(studio.blob.size / (1024 * 1024)).toFixed(1)} MB — near the 16 MB upload cap. Consider re-recording a shorter take.`);
  }
  const warnHtml = warnings.length
    ? warnings.map((w) => `<p class="rc-hint" style="color:#c0392b;font-weight:600">⚠ ${w}</p>`).join("")
    : "";
  showModal(`
    <h3 class="rc-modal-title">Review take</h3>
    <p class="rc-modal-sub">Over <span class="rc-hash">${commitHash(commit.id)}</span> · ${scEscapeHTML(commit.message)}</p>
    <div class="rc-preview-row">
      <button type="button" class="rc-btn rc-btn-ghost" id="preview-take-btn">▶ Take only</button>
      <button type="button" class="rc-btn rc-btn-ghost" id="preview-mix-btn">▶ With original</button>
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
    </div>
    <label class="rc-vol-field" title="How loud this take plays against the parent — 100% is unchanged">
      <span>Volume</span>
      <input type="range" id="commit-volume" min="0" max="200" step="5" value="100" />
      <span class="rc-vol-pct" id="commit-volume-pct">100%</span>
    </label>
    <p class="rc-hint">Start is auto-detected from the first sound in your take — adjust if needed. Leave End as "end" to play the take's natural length.</p>
    ${warnHtml}
    <div class="rc-modal-actions">
      <button type="button" class="rc-btn rc-btn-ghost" id="discard-take-btn">Discard</button>
      <button type="button" class="rc-btn rc-btn-primary" id="commit-take-btn">Commit take</button>
    </div>
  `, (overlay) => {
    overlay.querySelector("#preview-take-btn").addEventListener("click", () => playDry(studio.blobUrl, studio.takeStartGuess));
    const volInput = overlay.querySelector("#commit-volume");
    const volPct = overlay.querySelector("#commit-volume-pct");
    volInput.addEventListener("input", () => { volPct.textContent = volInput.value + "%"; });
    overlay.querySelector("#preview-mix-btn").addEventListener("click", () => {
      const startT = parseFloat(overlay.querySelector("#commit-start").value) || 0;
      const endT = parseFloat(overlay.querySelector("#commit-end").value);
      const duration = isFinite(endT) && endT > startT ? endT - startT : undefined;
      const rawVol = parseFloat(volInput.value);
      const volume = isFinite(rawVol) ? rawVol / 100 : 1; // 0 = muted
      playCommit(commit, { url: studio.blobUrl, start_time: startT, duration, volume, lead: studio.lead || 0 });
    });
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
    await hubApi(`/api/recordings/${commit.repo_id}/commits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: commit.id, message, url, start_time: start, end_time: end, mode, volume, lead: studio.lead || 0, contributor }),
    });
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
    if (!out || out.size > 16 * 1024 * 1024) {
      throw new Error("The M4A is too long — converting it to WAV exceeds the 16MB upload limit.");
    }
  } else if (kind && kind !== "wav" && kind !== "mp3" && kind !== "unknown") {
    throw new Error(
      `Unsupported audio type: ${kind}. This site accepts WAV, MP3, or M4A (M4A is converted to WAV).`
    );
  }
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch("/api/music/upload", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: out,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.url;
}


/* ── New recording (init repo) ─────────────────────────── */
let newRecBlob = null;     // Blob when the source was recorded from mic
let newRecUrl = null;      // /recordings/... URL when uploaded, or blob: URL
let newRecStream = null;
let newRecRecorder = null;
let newRecTimer = null;
let newRecStart = 0;
let newRecDuration = 0;

function openNewRecording() {
  newRecBlob = null;
  newRecUrl = null;
  const contributorDefault = (hub.user && (hub.user.username || hub.user.name)) || "admin";
  showModal(`
    <h3 class="rc-modal-title">New Recording</h3>
    <label class="rc-field">Title
      <input type="text" id="new-title" maxlength="300" placeholder="e.g. Midnight Dreams" />
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
    <div class="rc-timer-wrap" id="new-timer-wrap" hidden><span class="rc-timer" id="new-timer">0:00</span></div>
    <div class="rc-modal-actions">
      <button type="button" class="rc-btn rc-btn-ghost" id="new-cancel-btn">Cancel</button>
      <button type="button" class="rc-btn rc-btn-primary" id="new-create-btn">Create Recording</button>
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
      if (f.size > 16 * 1024 * 1024) {
        status.textContent = "✗ File too large — max 16MB.";
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
  newRecRecorder = createRecorder(null, newRecStream, {
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
  });
  if (!newRecRecorder) {
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
  clearInterval(newRecTimer);
  if (newRecUrl && newRecUrl.startsWith("blob:")) URL.revokeObjectURL(newRecUrl);
  newRecUrl = null;
  newRecBlob = null;
}

async function createNewRecording(overlay) {
  const title = overlay.querySelector("#new-title").value.trim();
  const message = overlay.querySelector("#new-message").value.trim() || "Initial recording";
  const contributor = overlay.querySelector("#new-contributor").value.trim();
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
    await hubApi("/api/recordings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, message, url, sort_order: 0, contributor }),
    });
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

if (trackListEl) initHub();

