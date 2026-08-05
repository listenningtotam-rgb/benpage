/* ── Admin Dashboard Logic ─────────────────────────────── */
/* JWT stored in localStorage: "benpage_admin_token"        */

const TOKEN_KEY = "benpage_admin_token";
const USER_KEY = "benpage_admin_user";

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
  $("#dash-view").hidden = true;
}

function showDashView(username) {
  $("#login-view").hidden = true;
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
    showDashView(data.user.username);
    await loadAll();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
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
async function loadMusic() {
  const data = await api("/api/music");
  const list = $("#music-list");

  if (!data.tracks.length) {
    list.innerHTML = '<p class="empty-note">No tracks yet — add your first one above.</p>';
    return;
  }

  list.innerHTML = data.tracks
    .map(
      (t) => `
      <div class="item-card">
        <div class="item-info">
          <div class="item-title">${escapeHTML(t.title)}</div>
          <div class="item-sub">${escapeHTML(t.url)}</div>
        </div>
        <div class="item-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit-music" data-id="${t.id}">Edit</button>
          <button type="button" class="btn btn-danger btn-sm" data-action="delete-music" data-id="${t.id}">Delete</button>
        </div>
      </div>`
    )
    .join("");
}

function showMusicForm(track = null) {
  $("#music-form-wrap").hidden = false;
  $("#music-form-title").textContent = track ? "Edit Track" : "Add Track";
  $("#music-id").value = track ? track.id : "";
  $("#music-title").value = track ? track.title : "";
  $("#music-url").value = track ? track.url : "";
  $("#music-sort").value = track ? track.sort_order : 0;
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
async function uploadAudioBlob(blob, statusEl) {
  setUploadStatus(statusEl, "uploading", "Uploading…");
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch("/api/music/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
  return data.url;
}

$("#music-upload-btn").addEventListener("click", () => $("#music-file").click());

$("#music-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  const statusEl = $("#music-upload-status");
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
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
  return data.url;
}

function resizeImage(file, maxDim = 1920, quality = 0.85) {
  return new Promise((resolve, reject) => {
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
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
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
          <div class="item-sub">${escapeHTML(p.date)} · ${escapeHTML(p.tag || "Note")} · ${p.blocks.length} block(s)</div>
        </div>
        <div class="item-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit-blog" data-id="${p.id}">Edit</button>
          <button type="button" class="btn btn-danger btn-sm" data-action="delete-blog" data-id="${p.id}">Delete</button>
        </div>
      </div>`
    )
    .join("");
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
    showDashView(data.user.username);
    await loadAll();
  } catch (err) {
    clearSession();
    showLoginView();
  }
})();