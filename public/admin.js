/* ── Admin Dashboard Logic ─────────────────────────────── */
/* JWT stored in localStorage: "benpage_admin_token"        */

const TOKEN_KEY = "benpage_admin_token";
const USER_KEY = "benpage_admin_user";

// Max upload size in MB — keep in sync with server.js (MAX_UPLOAD_BYTES /
// MAX_AUDIO_UPLOAD_BYTES) and nginx client_max_body_size (deploy/nginx-upload.conf).
const MAX_UPLOAD_MB = 16;

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
    $("#tab-" + tab.dataset.tab).hidden = false;
  });
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
  setUploadStatus($("#music-upload-status"), null);
}

$("#music-add-btn").addEventListener("click", () => showMusicForm());

/* ── Audio upload (music) ─────────────────────────────── */
/* Turn a failed upload response into an actionable message. */
function uploadErrorMessage(res, data) {
  if (res.status === 413) {
    return (
      `Upload failed (413): the file is larger than the ${MAX_UPLOAD_MB}MB server limit. ` +
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
    if (!out || out.size > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new Error(`The M4A is too long — converting it to WAV exceeds the ${MAX_UPLOAD_MB}MB upload limit.`);
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
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    setUploadStatus(statusEl, "err", `✗ File is too large — max ${MAX_UPLOAD_MB}MB.`);
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

$("#music-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#music-id").value;
  const url = $("#music-url").value.trim();
  if (!url) {
    alert("Please upload an audio file first.");
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
});

/* ── Init ──────────────────────────────────────────────── */
async function loadAll() {
  await Promise.all([loadMusic(), loadBlog()]);
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
