/* ── Admin Dashboard Logic ─────────────────────────────── */
/* JWT stored in localStorage: "benpage_admin_token"        */

const TOKEN_KEY = "benpage_admin_token";
const USER_KEY = "benpage_admin_user";

// Max AUDIO upload size in MB — keep in sync with server.js
// MAX_AUDIO_UPLOAD_BYTES and nginx client_max_body_size
// (deploy/nginx-upload.conf). Blog photos have their own 5 MB cap
// (server.js MAX_UPLOAD_BYTES), enforced server-side.
const MAX_AUDIO_UPLOAD_MB = 100;

/* Admin lists (music + blog) show only this many rows by default, with a
   "Show more" button to reveal the rest. */
const INITIAL_ROWS = 5;

const $ = (sel) => document.querySelector(sel);

/* ── API helper ────────────────────────────────────────── */
async function api(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── Auth state ────────────────────────────────────────── */
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function showLoginView() {
  $("#login-view").hidden = false;
  $("#change-view").hidden = true;
  $("#dash-view").hidden = true;
}

function showChangeView() {
  $("#login-view").hidden = true;
  $("#change-view").hidden = false;
  $("#dash-view").hidden = true;
  $("#change-form").reset();
  $("#change-error").hidden = true;
  $("#change-password").focus();
}

function showDashView(username) {
  $("#login-view").hidden = true;
  $("#change-view").hidden = true;
  $("#dash-view").hidden = false;
  $("#dash-username").textContent = username || "";
}

/* ── Login ─────────────────────────────────────────────── */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("#login-error");
  errorEl.hidden = true;

  const username = $("#login-username").value.trim();
  const password = $("#login-password").value;

  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setSession(data.token, data.user);
    $("#login-password").value = "";
    if (data.must_change_password) {
      showChangeView();
    } else {
      showDashView(data.user.username);
      await loadAll();
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

/* ── Forced password change (first login) ─────────────── */
$("#change-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("#change-error");
  errorEl.hidden = true;
  const pw = $("#change-password").value;
  if (pw !== $("#change-password2").value) {
    errorEl.textContent = "Passwords do not match.";
    errorEl.hidden = false;
    return;
  }
  try {
    await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: $("#change-current").value,
        new_password: pw,
      }),
    });
    showDashView(JSON.parse(localStorage.getItem(USER_KEY) || "{}").username || "");
    await loadAll();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

/* ── Settings: change password ────────────────────────── */
$("#settings-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = $("#settings-password-status");
  const pw = $("#settings-new").value;
  if (pw !== $("#settings-new2").value) {
    setUploadStatus(statusEl, "err", "✗ Passwords do not match.");
    return;
  }
  setUploadStatus(statusEl, "uploading", "Updating…");
  try {
    await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: $("#settings-current").value,
        new_password: pw,
      }),
    });
    $("#settings-password-form").reset();
    setUploadStatus(statusEl, "ok", "✓ Password updated.");
    setTimeout(() => setUploadStatus(statusEl, null), 3000);
  } catch (err) {
    setUploadStatus(statusEl, "err", "✗ " + err.message);
  }
});

$("#logout-btn").addEventListener("click", () => {
  clearSession();
  showLoginView();
});

/* ── Tab switching ─────────────────────────────────────── */
document.querySelectorAll(".dash-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".dash-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".dash-panel").forEach((p) => (p.hidden = true));
    $(".dash-panel#tab-" + tab.dataset.tab).hidden = false;
    closeVinylPicker();
  });
});

/* ── Bands (REC HUB 乐队) ──────────────────────────────── */
async function loadBands() {
  const data = await api("/api/admin/bands");
  const list = $("#band-list");
  const bands = data.bands || [];
  if (!bands.length) {
    list.innerHTML =
      '<p class="empty-note">No bands yet — create one above. Band members join via invite codes.</p>';
    return;
  }
  list.innerHTML = bands
    .map((b) => {
      const members = (b.members || [])
        .map((m) => escapeHTML(m.nickname || m.username))
        .join(", ");
      const sub = [
        `${b.member_count || 0} member${b.member_count === 1 ? "" : "s"}`,
        b.description ? escapeHTML(b.description) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `
      <div class="item-card">
        <div class="item-info">
          <div class="item-title">${escapeHTML(b.name)}</div>
          <div class="item-sub">${sub}</div>
          ${members ? `<div class="item-sub">Members: ${members}</div>` : ""}
        </div>
        <div class="item-actions">
          <button type="button" class="btn btn-danger btn-sm" data-action="delete-band" data-id="${b.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
  applyListPager(list, ".item-card");
}

function showBandForm(band = null) {
  $("#band-form-wrap").hidden = false;
  $("#band-form-title").textContent = band ? "Edit Band" : "Add Band";
  $("#band-id").value = band ? band.id : "";
  $("#band-name").value = band ? band.name : "";
  $("#band-description").value = band ? band.description || "" : "";
  setUploadStatus($("#band-status"), null);
  $("#band-name").focus();
}

function hideBandForm() {
  $("#band-form-wrap").hidden = true;
  $("#band-form").reset();
}

$("#band-add-btn").addEventListener("click", () => showBandForm());

$("#band-cancel-btn").addEventListener("click", hideBandForm);

$("#band-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#band-id").value;
  const payload = {
    name: $("#band-name").value.trim(),
    description: $("#band-description").value.trim(),
  };
  try {
    if (id) {
      // The admin API has no band rename endpoint — keep it additive/simple.
      await api(`/api/admin/bands/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/admin/bands", { method: "POST", body: JSON.stringify(payload) });
    }
    hideBandForm();
    await loadBands();
  } catch (err) {
    setUploadStatus($("#band-status"), "err", "✗ " + err.message);
  }
});

/* ── Invite codes (REC HUB 邀请码) ─────────────────────── */
async function loadInvites() {
  const data = await api("/api/admin/invites");
  const list = $("#invite-list");
  const invites = data.invites || [];
  if (!invites.length) {
    list.innerHTML =
      '<p class="empty-note">No invite codes yet — generate one for a band. The first person to use a code creates their account.</p>';
    return;
  }
  list.innerHTML = invites
    .map((inv) => {
      const used = inv.used_by
        ? `used by ${escapeHTML(inv.used_nickname || inv.used_username || "?")}`
        : "unused";
      const copyBtn = inv.used_by
        ? ""
        : `<button type="button" class="btn btn-ghost btn-sm invite-copy" data-code="${escapeHTML(inv.code)}" title="Copy invite code">Copy</button>`;
      return `
      <div class="item-card">
        <div class="item-info">
          <div class="item-title invite-title">
            <code class="invite-code">${escapeHTML(inv.code)}</code>
            <span class="src-badge">${escapeHTML(inv.band_name || "?")}</span>
          </div>
          <div class="item-sub">${used} · created ${escapeHTML(String(inv.created_at || ""))}</div>
        </div>
        <div class="item-actions">
          ${copyBtn}
          <button type="button" class="btn btn-danger btn-sm" data-action="delete-invite" data-id="${inv.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
  applyListPager(list, ".item-card");
}

async function showInviteForm() {
  const data = await api("/api/admin/bands");
  const select = $("#invite-band");
  select.innerHTML = data.bands
    .map((b) => `<option value="${b.id}">${escapeHTML(b.name)}</option>`)
    .join("");
  if (!data.bands.length) {
    setUploadStatus($("#invite-status"), "err", "✗ Create a band first.");
    return;
  }
  $("#invite-form-wrap").hidden = false;
  setUploadStatus($("#invite-status"), null);
  select.focus();
}

function hideInviteForm() {
  $("#invite-form-wrap").hidden = true;
  $("#invite-form").reset();
}

$("#invite-add-btn").addEventListener("click", showInviteForm);

$("#invite-cancel-btn").addEventListener("click", hideInviteForm);

$("#invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = $("#invite-status");
  setUploadStatus(statusEl, "uploading", "Generating…");
  try {
    const data = await api("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify({ band_id: Number($("#invite-band").value) }),
    });
    setUploadStatus(statusEl, "ok", `✓ New code: ${data.invite.code}`);
    hideInviteForm();
    await loadInvites();
  } catch (err) {
    setUploadStatus(statusEl, "err", "✗ " + err.message);
  }
});


/* ── Music CRUD ────────────────────────────────────────── */
/* Collapse an admin list (#music-list / #blog-list) to the first
   INITIAL_ROWS rows and keep a "Show more (N)" button that reveals the rest. */
function applyListPager(listEl, rowSelector) {
  const rows = listEl.querySelectorAll(rowSelector);
  const hidden = Math.max(0, rows.length - INITIAL_ROWS);
  let moreWrap = listEl.querySelector(".list-more");

  rows.forEach((el, i) => {
    el.hidden = i >= INITIAL_ROWS; // admin.css honors [hidden]
  });

  if (hidden === 0) {
    if (moreWrap) moreWrap.remove();
    return;
  }

  if (!moreWrap) {
    moreWrap = document.createElement("div");
    moreWrap.className = "list-more";
    listEl.appendChild(moreWrap);
  }
  moreWrap.innerHTML = `<button type="button" class="btn btn-ghost list-more-btn">Show more (${hidden})</button>`;
  moreWrap.querySelector(".list-more-btn").addEventListener("click", () => {
    rows.forEach((el, i) => {
      if (i >= INITIAL_ROWS) el.hidden = false;
    });
    moreWrap.remove();
  });
}

async function loadMusic() {
  const data = await api("/api/music");
  const list = $("#music-list");

  if (!data.tracks.length) {
    list.innerHTML = '<p class="empty-note">No tracks yet — add your first one above.</p>';
    return;
  }

  list.innerHTML = data.tracks
    .map((t) => {
      const isCover = t.source_type === "cover";
      const badge = `<span class="src-badge ${isCover ? "src-badge-cover" : "src-badge-original"}">${isCover ? "Cover" : "原创"}</span>`;
      return `
      <div class="item-card">
        <div class="item-info">
          <div class="item-title music-title-row">${badge}<span class="music-title-text">${escapeHTML(t.title)}</span></div>
          <div class="item-sub">${escapeHTML(t.url)} · ${t.commit_count != null ? t.commit_count + " commit" + (t.commit_count === 1 ? "" : "s") + " · " : ""}${t.play_count || 0} plays</div>
        </div>
        <div class="item-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit-music" data-id="${t.id}">Edit</button>
          <button type="button" class="btn btn-danger btn-sm" data-action="delete-music" data-id="${t.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");

  applyListPager(list, ".item-card");
}

function showMusicForm(track = null) {
  $("#music-form-wrap").hidden = false;
  $("#music-form-title").textContent = track ? "Edit Track" : "Add Track";
  $("#music-id").value = track ? track.id : "";
  $("#music-title").value = track ? track.title : "";
  $("#music-url").value = track ? track.url : "";
  $("#music-sort").value = track ? track.sort_order : 0;
  // 原创 (original) vs Cover — the new-recording form defaults to Cover;
  // when editing, keep whatever the track already has.
  $("#music-source-type").value = track ? (track.source_type === "cover" ? "cover" : "original") : "cover";
  $("#music-file").value = "";
  resetNeteasePanel();
  const statusEl = $("#music-upload-status");
  if (track && track.url) {
    setUploadStatus(statusEl, "ok", "✓ " + track.url);
  } else {
    setUploadStatus(statusEl, null);
  }
  $("#music-title").focus();
}

function hideMusicForm() {
  $("#music-form-wrap").hidden = true;
  $("#music-url").value = "";
  $("#music-file").value = "";
  resetNeteasePanel();
  setUploadStatus($("#music-upload-status"), null);
}

/* Close and clear the NetEase import panel (called when opening/closing the form). */
function resetNeteasePanel() {
  neteaseResults = [];
  const wrap = $("#netease-search-wrap");
  if (wrap) {
    wrap.hidden = true;
    $("#netease-keywords").value = "";
    $("#netease-results").innerHTML = "";
  }
}

$("#music-add-btn").addEventListener("click", () => showMusicForm());

/* ── Audio upload (music) ─────────────────────────────── */
/* Turn a failed upload response into an actionable message. */
function uploadErrorMessage(res, data) {
  if (res.status === 413) {
    // Prefer the app's own 413 body — it names the real per-endpoint limit
    // (5 MB for blog photos, MAX_AUDIO_UPLOAD_MB for audio). An empty body
    // means nginx cut the request off before it reached Node (deployed
    // client_max_body_size below the app cap).
    if (data && data.error) return "Upload failed (413): " + data.error;
    return (
      "Upload failed (413): the file exceeds the server upload limit " +
      `(audio ${MAX_AUDIO_UPLOAD_MB}MB, images 5MB). ` +
      "Ask the server admin to raise nginx client_max_body_size (see deploy/nginx-upload.conf)."
    );
  }
  return (data && data.error) || `Upload failed (${res.status})`;
}

/* Reject known-bad containers (WebM/OGG/FLAC from before the WAV migration)
   before they hit the server, with a clear message. Returns the detected kind,
   or null/"unknown" if the server must be the judge. M4A is allowed:
   uploadAudioBlob transcodes it to WAV. */
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

/* Convert an M4A upload to 22050 Hz mono 16-bit PCM WAV in the browser, so the
   shared /api/music/upload endpoint (which only stores WAV/MP3 so every browser
   can decodeAudioData them, including iOS Safari) keeps receiving exactly the
   same bytes it always did. */
async function transcodeM4aToWav(blob) {
  const ab = await blob.arrayBuffer().catch(() => null);
  if (!ab) throw new Error("Could not read the M4A file.");
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_) { ctx = null; }
  if (!ctx) throw new Error("This browser could not create an audio context to convert the M4A file.");
  let buf;
  try {
    buf = await new Promise((resolve, reject) => {
      const ok = (b) =>
        b && typeof b.duration === "number"
          ? resolve(b)
          : reject(new Error("decodeAudioData returned no audio"));
      const bad = (err) =>
        reject(err instanceof Error ? err : new Error(String((err && err.message) || err || "decodeAudioData failed")));
      try {
        const p = ctx.decodeAudioData(ab, ok, bad);
        if (p && typeof p.then === "function") p.then(ok, bad);
      } catch (err) { bad(err); }
    });
  } catch (err) {
    throw new Error("This browser could not decode the M4A file: " + (err.message || err));
  } finally {
    try { if (typeof ctx.close === "function") ctx.close(); } catch (_) {}
  }
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const mono = new Float32Array(buf.length);
  if (ch1) {
    for (let i = 0; i < buf.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
  } else {
    mono.set(ch0);
  }
  return encodePcmWav(mono, buf.sampleRate || 44100, 22050);
}

/* 16-bit PCM WAV writer (mono, resampling) — same output format as the
   recording hub's encodeWav in public/music.js. Returns a Blob or null for
   silent input. */
function encodePcmWav(mono, inRate, outRate) {
  const ratio = inRate / outRate;
  const max = Math.max(1, Math.round(mono.length / ratio));
  const out = new Int16Array(max);
  let o = 0;
  let acc = 0;
  let cnt = 0;
  let nextOut = 1;
  const push = () => {
    let s = (acc / cnt) * 32767;
    out[o++] = s > 32767 ? 32767 : s < -32768 ? -32768 : s | 0;
    acc = 0;
    cnt = 0;
  };
  for (let i = 0; i < mono.length; i++) {
    acc += mono[i];
    cnt++;
    if (i + 1 >= nextOut * ratio) { nextOut++; push(); }
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

async function uploadAudioBlob(blob, statusEl) {
  const kind = await sniffAudioKind(blob);
  let out = blob;
  if (kind === "MP4/M4A") {
    out = await transcodeM4aToWav(blob);
    if (!out || out.size > MAX_AUDIO_UPLOAD_MB * 1024 * 1024) {
      throw new Error(`The M4A is too long — converting it to WAV exceeds the ${MAX_AUDIO_UPLOAD_MB}MB upload limit.`);
    }
  } else if (kind && kind !== "wav" && kind !== "mp3" && kind !== "unknown") {
    throw new Error(
      `Unsupported audio type: ${kind}. This site accepts WAV, MP3, or M4A (M4A is converted to WAV).`
    );
  }
  setUploadStatus(statusEl, "uploading", "Uploading…");
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch("/api/music/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: out,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(uploadErrorMessage(res, data));
  }
  return data.url;
}

$("#music-upload-btn").addEventListener("click", () => $("#music-file").click());

$("#music-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  const statusEl = $("#music-upload-status");
  if (file.size > MAX_AUDIO_UPLOAD_MB * 1024 * 1024) {
    setUploadStatus(statusEl, "err", `✗ File is too large — max ${MAX_AUDIO_UPLOAD_MB}MB.`);
    return;
  }
  try {
    const url = await uploadAudioBlob(file, statusEl);
    $("#music-url").value = url;
    setUploadStatus(statusEl, "ok", "✓ " + url);
  } catch (err) {
    setUploadStatus(statusEl, "err", "✗ " + err.message);
  }
});

/* ── 网易云导入 (播放源直连网易云 CDN, 不占本站流量) ───────────── */
let neteaseResults = []; // 最近一次搜索结果, 供点击选取

function fmtDuration(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!isFinite(total) || total <= 0) return "";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

async function runNeteaseSearch() {
  const kw = $("#netease-keywords").value.trim();
  const resultsEl = $("#netease-results");
  if (!kw) {
    resultsEl.innerHTML = '<p class="empty-note">请输入歌名或歌手。</p>';
    return;
  }
  resultsEl.innerHTML = '<p class="empty-note">搜索中…</p>';
  try {
    const data = await api(`/api/netease/search?keywords=${encodeURIComponent(kw)}`);
    neteaseResults = data.results || [];
    if (!neteaseResults.length) {
      resultsEl.innerHTML =
        '<p class="empty-note">没有找到结果 — 试试「歌手名 + 歌名」。</p>';
      return;
    }
    resultsEl.innerHTML = neteaseResults
      .map((r, i) => {
        const dur = fmtDuration(r.duration_ms);
        const meta = [r.artists, r.album, dur].filter(Boolean).join(" · ");
        return `<button type="button" class="netease-result" data-index="${i}">
          <span class="netease-result-name">${escapeHTML(r.name)}</span>
          <span class="netease-result-artist">${escapeHTML(meta)}</span>
        </button>`;
      })
      .join("");
    resultsEl.querySelectorAll(".netease-result").forEach((btn) => {
      btn.addEventListener("click", () => pickNeteaseResult(Number(btn.dataset.index)));
    });
  } catch (err) {
    resultsEl.innerHTML = `<p class="empty-note">✗ ${escapeHTML(err.message)}</p>`;
  }
}

function pickNeteaseResult(index) {
  const r = neteaseResults[index];
  if (!r || !r.id) return;
  $("#music-title").value = `${r.name}${r.artists ? " - " + r.artists : ""}`;
  // Recordings 播放器只认 player.url —— 存本站 302 端点即可, 前端零改动。
  $("#music-url").value = `/api/netease/audio/${r.id}`;
  $("#music-source-type").value = "cover";
  $("#netease-search-wrap").hidden = true;
  setUploadStatus(
    $("#music-upload-status"),
    "ok",
    `✓ 已选定网易云播放源 (song #${r.id}) — 音频将直连网易云 CDN`
  );
}

$("#netease-toggle-btn").addEventListener("click", () => {
  const wrap = $("#netease-search-wrap");
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) $("#netease-keywords").focus();
});

$("#netease-search-btn").addEventListener("click", runNeteaseSearch);
$("#netease-keywords").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runNeteaseSearch();
  }
});

$("#music-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#music-id").value;
  const url = $("#music-url").value.trim();
  if (!url) {
    alert("Please upload an audio file or import from NetEase first.");
    return;
  }
  const payload = {
    title: $("#music-title").value.trim(),
    url,
    sort_order: parseInt($("#music-sort").value, 10) || 0,
    source_type: $("#music-source-type").value,
  };
  try {
    if (id) {
      await api(`/api/music/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/music", { method: "POST", body: JSON.stringify(payload) });
    }
    hideMusicForm();
    await loadMusic();
  } catch (err) {
    alert(err.message);
  }
});

document.querySelector('[data-cancel="music"]').addEventListener("click", hideMusicForm);

/* ── Image upload helpers ─────────────────────────────── */
async function uploadImageBlob(blob, statusEl) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(uploadErrorMessage(res, data));
  }
  return data.url;
}

function resizeImage(file, maxDim = 1920, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("No image received from the browser. Try picking the file again."));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Image compression failed"))),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(describeImageReadError(file)));
    };
    img.src = url;
  });
}

/* Turn a browser image-decode failure into an actionable message. */
function describeImageReadError(file) {
  const name = (file && file.name) || "";
  const type = (file && file.type) || "";
  const hint = "Convert it to JPG or PNG and try again.";
  if (/heic|heif/i.test(type + name)) {
    return `"${name}" is HEIC/HEIF (iPhone photo format) and this browser cannot read it. ${hint}`;
  }
  if (
    /^image\/(avif|tiff|tif|vnd\.adobe\.photoshop|svg\+xml)/i.test(type) ||
    /\.(avif|tif|tiff|psd|raw|nef|cr2|dng|svg)$/i.test(name)
  ) {
    return `"${name}" (${type || "unknown type"}) is not a supported image format. ${hint}`;
  }
  return `Could not read "${name}" (${type || "unknown type"}). The file may be corrupted or in an unsupported format. ${hint}`;
}

function setUploadStatus(el, state, text) {
  if (!el) return;
  if (!state) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = "upload-status " + state;
  el.textContent = text;
}

/* ── Blogger-style WYSIWYG editor ──────────────────────── */
/* One big editable area — text and photos mix inline.      */
/* Photos are uploaded to /photo/... and shown right in the */
/* content, exactly like blogspot.com/blog/post/edit/.      */

const blogEditor = $("#blog-editor");

/* Blocks (DB format) -> editable HTML */
function blocksToHTML(blocks) {
  return (blocks || [])
    .map((b) => {
      if (b.type === "image") {
        const alt = escapeHTML(b.alt || b.caption || "");
        const cap = b.caption
          ? `<div class="wysiwyg-caption">${escapeHTML(b.caption)}</div>`
          : "";
        return `<p class="wysiwyg-img-wrap"><img src="${escapeHTML(b.src)}" alt="${alt}" />${cap}</p>`;
      }
      if (b.type === "video") {
        const poster = b.poster ? ` poster="${escapeHTML(b.poster)}"` : "";
        const cap = b.caption
          ? `<div class="wysiwyg-caption">${escapeHTML(b.caption)}</div>`
          : "";
        return `<p class="wysiwyg-video-wrap"><video controls preload="metadata"${poster}><source src="${escapeHTML(b.src)}" type="video/mp4" /></video>${cap}</p>`;
      }
      return b.html || "";
    })
    .join("\n");
}

/* Editable HTML -> Blocks (DB format, for save) */
function htmlToBlocks(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks = [];
  const childNodes = Array.from(template.content.childNodes);

  for (const node of childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (text) blocks.push({ type: "text", html: `<p>${escapeHTML(text)}</p>` });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const el = node;
    const img = el.querySelector("img");
    const video = el.querySelector("video");

    if (img && !video) {
      const capEl = el.querySelector(".wysiwyg-caption");
      const src = img.getAttribute("src") || "";
      let alt = img.getAttribute("alt") || "";
      let caption = "";
      if (capEl) {
        caption = capEl.textContent.trim();
        alt = alt || caption;
      } else if (img.title) {
        caption = img.title;
        alt = alt || caption;
      }
      if (src) blocks.push({ type: "image", src, alt, caption });
      continue;
    }

    if (video) {
      const sourceEl = video.querySelector("source");
      const src = (sourceEl && sourceEl.getAttribute("src")) || video.getAttribute("src") || "";
      const capEl = el.querySelector(".wysiwyg-caption");
      const caption = capEl ? capEl.textContent.trim() : "";
      if (src) {
        blocks.push({
          type: "video",
          src,
          poster: video.getAttribute("poster") || "",
          caption,
        });
      }
      continue;
    }

    const inner = el.innerHTML.trim();
    if (inner) blocks.push({ type: "text", html: el.outerHTML });
  }

  return blocks;
}

/* Insert an image at the current caret, in a paragraph */
function insertImageAtCursor(src, alt) {
  blogEditor.focus();
  const html =
    `<p class="wysiwyg-img-wrap"><img src="${escapeHTML(src)}" alt="${escapeHTML(alt || "")}" /></p>` +
    `<p><br /></p>`;
  document.execCommand("insertHTML", false, html);
}

/* Toolbar */
$("#blog-toolbar").addEventListener("mousedown", (e) => {
  const btn = e.target.closest(".tb-btn");
  if (!btn) return;
  e.preventDefault(); // keep the text selection

  const cmd = btn.dataset.cmd;

  if (cmd === "insertImage") {
    $("#wysiwyg-file").click();
    return;
  }
  if (cmd === "insertVideo") {
    const url = prompt("Video URL (mp4):");
    if (!url) return;
    const poster = prompt("Poster image URL (optional, Enter to skip):", "") || "";
    blogEditor.focus();
    const html =
      `<p class="wysiwyg-video-wrap"><video controls preload="metadata"${poster ? ` poster="${escapeHTML(poster)}"` : ""}><source src="${escapeHTML(url)}" type="video/mp4" /></video></p>` +
      `<p><br /></p>`;
    document.execCommand("insertHTML", false, html);
    return;
  }
  if (cmd === "createLink") {
    const url = prompt("Link URL:");
    if (!url) return;
    blogEditor.focus();
    document.execCommand("createLink", false, url);
    return;
  }
  if (cmd === "insertVinyl") {
    openVinylPicker();
    return;
  }

  blogEditor.focus();
  document.execCommand(cmd, false, btn.dataset.value || null);
});

/* Insert photo via toolbar button — upload then inline */
$("#wysiwyg-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  const statusEl = $("#wysiwyg-upload-status");
  setUploadStatus(statusEl, "uploading", "Uploading…");
  try {
    const blob = await resizeImage(file);
    const url = await uploadImageBlob(blob, statusEl);
    insertImageAtCursor(url, "");
    setUploadStatus(statusEl, "ok", "✓ Uploaded");
    setTimeout(() => setUploadStatus(statusEl, null), 2500);
  } catch (err) {
    setUploadStatus(statusEl, "err", "✗ " + err.message);
  }
});

/* Paste a photo anywhere in the editor → auto upload + insert (Blogger behavior) */
blogEditor.addEventListener("paste", async (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const imageItem = Array.from(items).find((it) => it.type && it.type.startsWith("image/"));
  if (!imageItem) return;
  e.preventDefault();

  const file = imageItem.getAsFile();
  const statusEl = $("#wysiwyg-upload-status");
  setUploadStatus(statusEl, "uploading", "Uploading…");
  try {
    const blob = await resizeImage(file);
    const url = await uploadImageBlob(blob, statusEl);
    insertImageAtCursor(url, "");
    setUploadStatus(statusEl, "ok", "✓ Uploaded");
    setTimeout(() => setUploadStatus(statusEl, null), 2500);
  } catch (err) {
    setUploadStatus(statusEl, "err", "✗ " + err.message);
  }
});

/* ── 黑胶档案 picker：搜索并插入唱片详情 ────────────────── */
/* 点击工具栏 💿 打开面板。正文光标在面板出现前被记住，点选结果后恢复
   光标，并把内容插入编辑器：封面作为普通博客图片块（image），唱片详情
   作为一个文本块（text）——因此存库后仍与现有的 3-block 模型一致，
   公开页 / 分享页无需任何改动。 */
let vinylPickerOpen = false;
let vinylEditorRange = null;
let vinylPickerReqId = 0; /* 丢弃并发请求的过期响应 */

function setVinylStatus(state, text) {
  setUploadStatus($("#vinyl-picker-status"), state, text);
}

/* 记住正文里的当前光标/选区。若光标已不在正文（例如正在操作搜索框），
   保留上一次记录的值。 */
function captureVinylEditorRange() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!blogEditor.contains(range.commonAncestorContainer)) return;
  vinylEditorRange = range.cloneRange();
}

document.addEventListener("selectionchange", () => {
  if (vinylPickerOpen) captureVinylEditorRange();
});

function openVinylPicker() {
  if ($("#blog-form-wrap").hidden) return; // 需要先进入 New/Edit Post
  const picker = $("#vinyl-picker");
  if (!picker.hidden) {
    $("#vinyl-picker-q").focus();
    return;
  }
  blogEditor.focus();
  captureVinylEditorRange();
  vinylPickerOpen = true;
  picker.hidden = false;
  $("#vinyl-picker-q").value = "";
  $("#vinyl-picker-results").innerHTML = "";
  vinylPickerBrowse();
  $("#vinyl-picker-q").focus();
}

function closeVinylPicker() {
  vinylPickerOpen = false;
  vinylEditorRange = null;
  const picker = $("#vinyl-picker");
  if (!picker || picker.hidden) return;
  picker.hidden = true;
  $("#vinyl-picker-results").innerHTML = "";
  setVinylStatus(null);
}

function vinylRestoreEditorCaret() {
  blogEditor.focus();
  if (!vinylEditorRange) return;
  const sel = window.getSelection();
  try {
    sel.removeAllRanges();
    sel.addRange(vinylEditorRange);
  } catch (_) {
    /* stale range — 让光标停在 focus 后的默认位置 */
  }
}

/* 统一取年份 / 封面 / 事实行（本地档案与 Discogs 字段略有差异） */
function vinylYearOf(r) {
  if (r.year != null && r.year !== "") return String(r.year);
  return String(r.release_date || "").slice(0, 4);
}

function vinylArtOf(r) {
  return String(r.cover_image || r.thumb || r.cover_path || "").trim();
}

function vinylFactLine(r) {
  return [vinylYearOf(r), r.country, r.label, r.catalog_number]
    .filter(Boolean)
    .join(" · ");
}

function vinylFmtDuration(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return "";
  const total = Math.round(n / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function vinylRowsOf(kind, records) {
  return (records || []).map((r) => ({
    kind,
    r,
    title: String(r.title || ""),
    artist: String(r.artist || ""),
    art: vinylArtOf(r),
    facts: vinylFactLine(r),
  }));
}

function renderVinylPickerRows(rows) {
  const listEl = $("#vinyl-picker-results");
  listEl.innerHTML = "";
  if (!rows.length) return;
  const frag = document.createDocumentFragment();
  rows.forEach((row) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vinyl-pick-item";
    btn.innerHTML =
      (row.art
        ? `<img class="vinyl-pick-thumb" src="${escapeHTML(row.art)}" alt="" loading="lazy" />`
        : '<span class="vinyl-pick-thumb vinyl-pick-thumb-ph">💿</span>') +
      '<span class="vinyl-pick-body">' +
      `<span class="vinyl-pick-title">${escapeHTML(row.title)}</span>` +
      `<span class="vinyl-pick-sub">${escapeHTML(row.artist || "未知艺人")}${row.facts ? " · " + escapeHTML(row.facts) : ""}</span>` +
      "</span>" +
      `<span class="vinyl-pick-tag tag-${row.kind}">${row.kind === "local" ? "本地档案" : "Discogs"}</span>` +
      '<span class="vinyl-pick-go">插入 →</span>';
    btn.addEventListener("click", () => pickVinylRow(row));
    frag.appendChild(btn);
  });
  listEl.appendChild(frag);
  listEl.querySelectorAll("img.vinyl-pick-thumb").forEach((img) => {
    img.addEventListener("error", () => { img.hidden = true; }, { once: true });
  });
}

/* 浏览档案：GET /api/vinyl（行内已含 tracks，无需再逐条取详情） */
async function vinylPickerBrowse() {
  const reqId = ++vinylPickerReqId;
  setVinylStatus("uploading", "正在读取黑胶档案…");
  $("#vinyl-picker-results").innerHTML = "";
  let data;
  try {
    data = await api("/api/vinyl");
  } catch (err) {
    if (reqId !== vinylPickerReqId) return;
    setVinylStatus("err", "✗ " + err.message);
    return;
  }
  if (reqId !== vinylPickerReqId) return;
  const rows = vinylRowsOf("local", data.records);
  renderVinylPickerRows(rows);
  setVinylStatus(
    "ok",
    rows.length
      ? `档案共 ${rows.length} 张 — 输入关键词可同时搜索 Discogs。`
      : "档案里还没有唱片。"
  );
}

/* 搜索：POST /api/vinyl/search（本地档案 + Discogs） */
async function vinylPickerSearch() {
  const q = $("#vinyl-picker-q").value.trim();
  if (!q) {
    vinylPickerBrowse();
    return;
  }
  const reqId = ++vinylPickerReqId;
  setVinylStatus("uploading", "正在搜索黑胶档案 + Discogs…");
  $("#vinyl-picker-results").innerHTML = "";
  let data;
  try {
    data = await api("/api/vinyl/search", {
      method: "POST",
      body: JSON.stringify({ q }),
    });
  } catch (err) {
    if (reqId !== vinylPickerReqId) return;
    setVinylStatus("err", "✗ " + err.message);
    return;
  }
  if (reqId !== vinylPickerReqId) return;
  const rows = vinylRowsOf("local", data.local).concat(
    vinylRowsOf("external", data.external)
  );
  renderVinylPickerRows(rows);
  const nLocal = (data.local || []).length;
  const nEx = (data.external || []).length;
  let msg;
  if (!rows.length) {
    msg = "没有找到匹配的唱片，换个关键词再试。";
  } else if (!data.externalEnabled) {
    msg = `仅本地档案 ${nLocal} 条（未配置 Discogs token）— 点击结果插入。`;
  } else {
    msg = `结果 ${rows.length} 条（档案 ${nLocal} · Discogs ${nEx}）— 点击结果插入。`;
    if (data.externalError) msg += " Discogs：" + data.externalError;
  }
  setVinylStatus("ok", msg);
}

/* 把一条来源（本地记录 or Discogs detail）规整为待插入详情。
   publicVinylRow 与 discogs detail 字段名基本一致，可共用一套逻辑。 */
function vinylNormalizeDetail(record, sharePath) {
  const r = record || {};
  const styles = []
    .concat(r.genres || [], r.styles || [])
    .filter(Boolean)
    .slice(0, 6)
    .join(" · ");
  return {
    title: String(r.title || ""),
    artist: String(r.artist || ""),
    facts: vinylFactLine(r),
    styles,
    cover: vinylArtOf(r),
    tracks: (r.tracks || [])
      .filter((t) => t && t.title)
      .map((t) => ({
        title: String(t.title),
        duration: vinylFmtDuration(t.length_ms != null ? t.length_ms : t.length),
      })),
    sharePath,
  };
}

/* 点选一条结果 → 取全量详情（Discogs 需实时 lookup）→ 插入正文 */
async function pickVinylRow(row) {
  const buttons = Array.from(
    $("#vinyl-picker-results").querySelectorAll(".vinyl-pick-item")
  );
  buttons.forEach((b) => { b.disabled = true; });
  setVinylStatus(
    "uploading",
    row.kind === "local" ? "正在整理档案详情…" : "正在从 Discogs 获取详情…"
  );
  let d;
  let note = "";
  if (row.kind === "local") {
    // 档案行已含 tracks / 封面，直接规整即可。
    d = vinylNormalizeDetail(row.r, `/vinyl/${row.r.slug || ""}`);
  } else {
    try {
      const data = await api(
        `/api/vinyl/lookup?discogs_id=${encodeURIComponent(row.r.discogs_id)}`
      );
      if (!data || !data.detail) throw new Error("Discogs 未返回详情");
      d = vinylNormalizeDetail(
        data.detail,
        `/vinyl/discogs/${data.detail.discogs_id}`
      );
    } catch (err) {
      // 详情失败时退而用搜索摘要插入（无曲目列表），并如实提示。
      note = err.message;
      d = vinylNormalizeDetail(row.r, `/vinyl/discogs/${row.r.discogs_id}`);
    }
  }
  const isEmpty =
    !d.title && !d.artist && !d.facts && !d.styles && !d.tracks.length;
  if (isEmpty) {
    buttons.forEach((b) => { b.disabled = false; });
    setVinylStatus("err", "✗ 这个条目缺少可插入的信息。");
    return;
  }
  insertVinylDetail(d);
  closeVinylPicker();
  const statusEl = $("#wysiwyg-upload-status");
  const who = `${d.title}${d.artist ? " — " + d.artist : ""}`;
  setUploadStatus(
    statusEl,
    "ok",
    `✓ 已插入${note ? "（Discogs 详情获取失败，已用搜索摘要插入）" : ""}：${who}`
  );
  setTimeout(() => setUploadStatus(statusEl, null), 4000);
}

/* 组装并插入正文：封面 = image 块，详情 = 单个 text 块。
   结构与编辑器其它插入一致（<p class="wysiwyg-img-wrap">… + <p><br /></p>），
   保存时 htmlToBlocks 会把它们识别为 image/text 两类块。 */
function insertVinylDetail(d) {
  vinylRestoreEditorCaret();
  const headParts = [d.title, d.artist].filter(Boolean);
  let html = "";
  if (d.cover) {
    html +=
      `<p class="wysiwyg-img-wrap"><img src="${escapeHTML(d.cover)}" ` +
      `alt="${escapeHTML(headParts.join(" "))} cover" /></p>`;
  }
  html += '<div class="wysiwyg-vinyl">';
  html += `<p><strong>${escapeHTML(d.title)}</strong>${
    d.artist ? " — " + escapeHTML(d.artist) : ""
  }</p>`;
  if (d.facts) html += `<p>${escapeHTML(d.facts)}</p>`;
  if (d.styles) html += `<p>${escapeHTML(d.styles)}</p>`;
  if (d.tracks.length) {
    html += "<ol>";
    d.tracks.forEach((t) => {
      html += `<li>${escapeHTML(
        t.duration ? `${t.title} — ${t.duration}` : t.title
      )}</li>`;
    });
    html += "</ol>";
  }
  if (d.sharePath) {
    html += `<p><a href="${escapeHTML(d.sharePath)}">📀 打开黑胶档案分享页 ↗</a></p>`;
  }
  html += "</div><p><br /></p>";
  document.execCommand("insertHTML", false, html);
}

$("#vinyl-picker-close").addEventListener("click", closeVinylPicker);
$("#vinyl-picker-browse-btn").addEventListener("click", vinylPickerBrowse);
$("#vinyl-picker-search-btn").addEventListener("click", vinylPickerSearch);
$("#vinyl-picker-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    vinylPickerSearch();
  }
});

/* ── Cover image upload ───────────────────────────────── */
$("#cover-upload-btn").addEventListener("click", () => $("#cover-file").click());

$("#cover-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  const statusEl = $("#cover-upload-status");
  setUploadStatus(statusEl, "uploading", "Uploading…");
  try {
    const blob = await resizeImage(file);
    const url = await uploadImageBlob(blob, statusEl);
    $("#blog-cover").value = url;
    setUploadStatus(statusEl, "ok", "✓ Uploaded");
    setTimeout(() => setUploadStatus(statusEl, null), 2500);
  } catch (err) {
    setUploadStatus(statusEl, "err", "✗ " + err.message);
  }
});

async function loadBlog() {
  const data = await api("/api/blog");
  const list = $("#blog-list");

  if (!data.posts.length) {
    list.innerHTML = '<p class="empty-note">No posts yet — create your first one above.</p>';
    return;
  }

  list.innerHTML = data.posts
    .map(
      (p) => `
      <div class="item-card">
        <div class="item-info">
          <div class="item-title">${escapeHTML(p.title)}</div>
          <div class="item-sub">${escapeHTML(p.date)} · ${escapeHTML(p.tag || "Note")} · ${p.blocks.length} block(s) · ${p.read_count || 0} reads</div>
        </div>
        <div class="item-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit-blog" data-id="${p.id}">Edit</button>
          <button type="button" class="btn btn-danger btn-sm" data-action="delete-blog" data-id="${p.id}">Delete</button>
        </div>
      </div>`
    )
    .join("");

  applyListPager(list, ".item-card");
}

function showBlogForm(post = null) {
  closeVinylPicker();
  $("#blog-form-wrap").hidden = false;
  $("#blog-form-title").textContent = post ? "Edit Post" : "New Post";
  $("#blog-id").value = post ? post.id : "";
  $("#blog-title").value = post ? post.title : "";
  $("#blog-tag").value = post ? post.tag || "" : "";
  $("#blog-date").value = post ? post.date : new Date().toISOString().slice(0, 10);
  $("#blog-cover").value = post ? post.cover || "" : "";
  blogEditor.innerHTML = post ? blocksToHTML(post.blocks || []) : "";
  $("#blog-title").focus();
}

function hideBlogForm() {
  $("#blog-form-wrap").hidden = true;
  blogEditor.innerHTML = "";
  closeVinylPicker();
}

$("#blog-add-btn").addEventListener("click", () => showBlogForm());

$("#blog-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#blog-id").value;
  const payload = {
    title: $("#blog-title").value.trim(),
    tag: $("#blog-tag").value.trim(),
    date: $("#blog-date").value,
    cover: $("#blog-cover").value.trim(),
    blocks: htmlToBlocks(blogEditor.innerHTML),
  };
  try {
    if (id) {
      await api(`/api/blog/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/blog", { method: "POST", body: JSON.stringify(payload) });
    }
    hideBlogForm();
    await loadBlog();
  } catch (err) {
    alert(err.message);
  }
});

document.querySelector('[data-cancel="blog"]').addEventListener("click", hideBlogForm);

/* ── List item actions (edit / delete, delegation) ────── */
const listsContainer = $("#dash-view");

listsContainer.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === "edit-music") {
    const data = await api("/api/music");
    const track = data.tracks.find((t) => String(t.id) === id);
    if (track) showMusicForm(track);
  }

  if (action === "delete-music") {
    if (!confirm("Delete this track?")) return;
    try {
      await api(`/api/music/${id}`, { method: "DELETE" });
      await loadMusic();
    } catch (err) {
      alert(err.message);
    }
  }

  if (action === "edit-blog") {
    const data = await api("/api/blog");
    const post = data.posts.find((p) => String(p.id) === id);
    if (post) showBlogForm(post);
  }

  if (action === "delete-blog") {
    if (!confirm("Delete this post?")) return;
    try {
      await api(`/api/blog/${id}`, { method: "DELETE" });
      await loadBlog();
    } catch (err) {
      alert(err.message);
    }
  }

  if (action === "delete-band") {
    if (!confirm("Delete this band? Its recordings stay but become public, and its invite codes stop working.")) return;
    try {
      await api(`/api/admin/bands/${id}`, { method: "DELETE" });
      await loadBands();
    } catch (err) {
      alert(err.message);
    }
  }

  if (action === "delete-invite") {
    if (!confirm("Delete this invite code? The linked account keeps its bands.")) return;
    try {
      await api(`/api/admin/invites/${id}`, { method: "DELETE" });
      await loadInvites();
    } catch (err) {
      alert(err.message);
    }
  }

  const copyBtn = e.target.closest(".invite-copy");
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.code);
      const old = copyBtn.textContent;
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => (copyBtn.textContent = old), 1500);
    } catch (err) {
      alert("Copy failed: " + err.message);
    }
  }
});

/* ── Init ──────────────────────────────────────────────── */
async function loadAll() {
  await Promise.all([loadMusic(), loadBlog(), loadBands(), loadInvites()]);
}

function escapeHTML(str) {
  const ENTITIES = {
    "&": "amp;",
    "<": "lt;",
    ">": "gt;",
    '"': "quot;",
    "'": "#39;"
  };
  return String(str).replace(/[&<>"']/g, (c) => "&" + ENTITIES[c]);
}

(async function init() {
  const token = getToken();
  if (!token) {
    showLoginView();
    return;
  }
  try {
    const data = await api("/api/auth/me");
    if (data.user.must_change_password) {
      showChangeView();
    } else {
      showDashView(data.user.username);
      await loadAll();
    }
  } catch (err) {
    clearSession();
    showLoginView();
  }
})();
