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
  $("#music-title").focus();
}

function hideMusicForm() {
  $("#music-form-wrap").hidden = true;
}

$("#music-add-btn").addEventListener("click", () => showMusicForm());

$("#music-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#music-id").value;
  const payload = {
    title: $("#music-title").value.trim(),
    url: $("#music-url").value.trim(),
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

/* ── Blog CRUD ─────────────────────────────────────────── */
let blogBlocks = [];

function blockEditorHTML(block, index) {
  if (block.type === "image") {
    return `
      <div class="block-editor" data-index="${index}">
        <div class="block-editor-head">
          <span class="block-type">Image</span>
          <button type="button" class="block-remove" data-remove-block="${index}" aria-label="Remove block">&times;</button>
        </div>
        <label>Image URL
          <input type="url" data-blk-field="src" value="${escapeHTML(block.src || "")}" placeholder="https://..." />
        </label>
        <label>Alt text
          <input type="text" data-blk-field="alt" value="${escapeHTML(block.alt || "")}" />
        </label>
        <label>Caption
          <input type="text" data-blk-field="caption" value="${escapeHTML(block.caption || "")}" />
        </label>
      </div>`;
  }
  if (block.type === "video") {
    return `
      <div class="block-editor" data-index="${index}">
        <div class="block-editor-head">
          <span class="block-type">Video</span>
          <button type="button" class="block-remove" data-remove-block="${index}" aria-label="Remove block">&times;</button>
        </div>
        <label>Video URL (mp4)
          <input type="url" data-blk-field="src" value="${escapeHTML(block.src || "")}" placeholder="https://.../video.mp4" />
        </label>
        <label>Poster image URL
          <input type="url" data-blk-field="poster" value="${escapeHTML(block.poster || "")}" placeholder="https://... (optional)" />
        </label>
        <label>Caption
          <input type="text" data-blk-field="caption" value="${escapeHTML(block.caption || "")}" />
        </label>
      </div>`;
  }
  // default text block
  return `
    <div class="block-editor" data-index="${index}">
      <div class="block-editor-head">
        <span class="block-type">Text</span>
        <button type="button" class="block-remove" data-remove-block="${index}" aria-label="Remove block">&times;</button>
      </div>
      <label>HTML content
        <textarea data-blk-field="html">${escapeHTML(block.html || "")}</textarea>
      </label>
    </div>`;
}

function renderBlockEditors() {
  const container = $("#blog-blocks");
  container.innerHTML = blogBlocks.map(blockEditorHTML).join("");
}

function addBlock(type) {
  const base =
    type === "image"
      ? { type: "image", src: "", alt: "", caption: "" }
      : type === "video"
        ? { type: "video", src: "", poster: "", caption: "" }
        : { type: "text", html: "" };
  blogBlocks.push(base);
  renderBlockEditors();
}

// Add block buttons (event delegation)
$("#blog-blocks").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-block]");
  if (!btn) return;
  blogBlocks.splice(Number(btn.dataset.removeBlock), 1);
  renderBlockEditors();
});

document.querySelectorAll("[data-add-block]").forEach((btn) => {
  btn.addEventListener("click", () => addBlock(btn.dataset.addBlock));
});

// Sync edited fields back into blogBlocks on change
$("#blog-blocks").addEventListener("input", (e) => {
  const el = e.target.closest("[data-blk-field]");
  if (!el) return;
  const editor = el.closest(".block-editor");
  const index = Number(editor.dataset.index);
  blogBlocks[index][el.dataset.blkField] = el.value;
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
  blogBlocks = post ? JSON.parse(JSON.stringify(post.blocks || [])) : [];
  renderBlockEditors();
  $("#blog-title").focus();
}

function hideBlogForm() {
  $("#blog-form-wrap").hidden = true;
  blogBlocks = [];
  renderBlockEditors();
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
    blocks: blogBlocks.filter((b) => {
      if (b.type === "text") return b.html && b.html.trim();
      return b.src && b.src.trim();
    }),
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