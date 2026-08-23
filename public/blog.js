/* ── Blog Section ───────────────────────────────────────── */
/* Posts are loaded from the SQLite database via /api/blog.
   Each post supports:
   - text  : paragraphs of words
   - image : one or more pictures (src + alt + caption)
   - video : embedded <video> playback (mp4 source)
*/

let BLOG_POSTS = []; // loaded from /api/blog

/* Show only this many posts by default; the rest are revealed by a
   "Show more" button. Kept in sync with music.js's INITIAL_TRACKS. */
const INITIAL_POSTS = 5;

/* ── DOM helpers ────────────────────────────────────────── */
const blogGrid = document.getElementById("blog-grid");
const blogDetail = document.getElementById("blog-detail");
const blogDetailContent = document.getElementById("blog-detail-content");
const blogDetailClose = document.getElementById("blog-detail-close");

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;")
    .replace(/'/g, "&" + "#39;");
}

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function renderBlocks(post) {
  return (post.blocks || []).map((b) => {
    if (b.type === "image") {
      return (
        `<figure class="blog-figure">` +
          `<img class="blog-img" src="${escapeHTML(b.src)}" alt="${escapeHTML(b.alt || b.caption || "Blog image")}" loading="lazy" />` +
          (b.caption ? `<figcaption class="blog-figcaption">${escapeHTML(b.caption)}</figcaption>` : "") +
        `</figure>`
      );
    }
    if (b.type === "video") {
      return (
        `<figure class="blog-figure">` +
          `<video class="blog-video" controls preload="metadata" ${b.poster ? `poster="${escapeHTML(b.poster)}"` : ""}>` +
            `<source src="${escapeHTML(b.src)}" type="video/mp4" />` +
            `Your browser does not support video playback.` +
          `</video>` +
          (b.caption ? `<figcaption class="blog-figcaption">${escapeHTML(b.caption)}</figcaption>` : "") +
        `</figure>`
      );
    }
    // default: text
    return `<div class="blog-text">${b.html || ""}</div>`;
  }).join("");
}

function renderBlogDetail(post) {
  blogDetailContent.innerHTML =
    `<article class="blog-post">
      <header class="blog-post-header">
        <span class="blog-tag">${escapeHTML(post.tag || "Note")}</span>
        <h3 class="blog-post-title">${escapeHTML(post.title)}</h3>
        <span class="blog-date">${fmtDate(post.date)}</span>
        <span class="blog-reads">👁 <span class="blog-reads-num">${Number(post.read_count) || 0}</span> reads</span>
        <button type="button" class="blog-share-btn" title="Share as a web page (WeChat)">↗ 分享</button>
      </header>
      ${renderBlocks(post)}
    </article>`;
  blogDetail.hidden = false;
  document.body.style.overflow = "hidden"; // lock scroll while reading

  const shareBtn = blogDetailContent.querySelector(".blog-share-btn");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      if (typeof window.openShareDialog === "function") {
        window.openShareDialog({ title: post.title, path: `/post/${post.id}` });
      }
    });
  }
}

function closeBlogDetail() {
  blogDetail.hidden = true;
  document.body.style.overflow = "";
  blogDetailContent.innerHTML = "";
}

/* Collapse the blog grid to the first INITIAL_POSTS cards and keep a
   "Show more (N)" button (placed right after the grid) that reveals the rest. */
function applyBlogPager() {
  const cards = blogGrid.querySelectorAll(".blog-card");
  const hiddenCount = Math.max(0, cards.length - INITIAL_POSTS);
  let moreWrap = document.getElementById("blog-more-wrap");

  cards.forEach((el, i) => {
    el.hidden = i >= INITIAL_POSTS; // style.css honors [hidden]
  });

  if (hiddenCount === 0) {
    if (moreWrap) moreWrap.remove();
    return;
  }

  if (!moreWrap) {
    moreWrap = document.createElement("div");
    moreWrap.id = "blog-more-wrap";
    moreWrap.className = "list-more";
    blogGrid.after(moreWrap);
  }
  moreWrap.innerHTML = `<button type="button" class="list-more-btn">Show more (${hiddenCount})</button>`;
  moreWrap.querySelector(".list-more-btn").addEventListener("click", () => {
    cards.forEach((el, i) => {
      if (i >= INITIAL_POSTS) el.hidden = false;
    });
    moreWrap.remove();
  });
}

function renderBlogGrid() {
  blogGrid.innerHTML = BLOG_POSTS.map((post) => {
    const cover = post.cover || (post.blocks.find((b) => b.type === "image") || {}).src || "";
    const blockTypes = (post.blocks || []).map((b) => b.type);
    const hasVideo = blockTypes.includes("video");
    const hasImage = blockTypes.includes("image");

    const mediaBadge = hasVideo
      ? '<span class="blog-media-badge">▶ Video</span>'
      : hasImage
        ? '<span class="blog-media-badge">▧ Photo</span>'
        : '<span class="blog-media-badge">✎ Words</span>';

    const coverHtml = cover
      ? `<div class="blog-card-cover"><img src="${escapeHTML(cover)}" alt="${escapeHTML(post.title)}" loading="lazy" /></div>`
      : `<div class="blog-card-cover blog-card-cover-text">✎</div>`;

    const readCount = Number(post.read_count) || 0;

    return (
      `<article class="blog-card" data-id="${escapeHTML(post.id)}">
        ${coverHtml}
        <div class="blog-card-body">
          <div class="blog-card-meta">
            <span class="blog-tag">${escapeHTML(post.tag || "Note")}</span>
            <span class="blog-date">${fmtDate(post.date)}</span>
          </div>
          <h3 class="blog-card-title">${escapeHTML(post.title)}</h3>
          <div class="blog-card-stats">
            <span class="blog-reads" title="Read count">👁 <span class="blog-reads-num">${readCount}</span> reads</span>
            <button type="button" class="card-share" title="Share as a web page (WeChat)">↗</button>
          </div>
          ${mediaBadge}
        </div>
      </article>`
    );
  }).join("");

  blogGrid.querySelectorAll(".blog-card").forEach((card) => {
    card.addEventListener("click", () => {
      const post = BLOG_POSTS.find((p) => String(p.id) === card.dataset.id);
      if (post) {
        renderBlogDetail(post);
        countBlogRead(post);
      }
    });

    // Share as a standalone web page without opening the post overlay.
    const shareBtn = card.querySelector(".card-share");
    if (shareBtn) {
      shareBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const post = BLOG_POSTS.find((p) => String(p.id) === card.dataset.id);
        if (post && typeof window.openShareDialog === "function") {
          window.openShareDialog({ title: post.title, path: `/post/${post.id}` });
        }
      });
    }
  });

  applyBlogPager();
}

/* ── Read counter ─────────────────────────────────────── */
/* Each time a post is opened its read count is bumped. Best-effort:
   a network failure never blocks opening the post. */
function countBlogRead(post) {
  fetch(`/api/blog/${post.id}/read`, { method: "POST" })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
    .then((data) => {
      post.read_count = data.read_count;
      document.querySelectorAll(`.blog-card[data-id="${post.id}"] .blog-reads-num`).forEach((el) => {
        el.textContent = post.read_count;
      });
      const detailNum = blogDetailContent.querySelector(".blog-post-header .blog-reads-num");
      if (detailNum) detailNum.textContent = post.read_count;
    })
    .catch(() => {});
}

async function loadBlog() {
  if (!blogGrid) return;
  try {
    const res = await fetch("/api/blog");
    const data = await res.json();
    BLOG_POSTS = data.posts || [];
    renderBlogGrid();
  } catch (err) {
    blogGrid.innerHTML = `<p class="empty-note">Failed to load posts.</p>`;
  }
}

/* ── Init ───────────────────────────────────────────────── */
if (blogGrid) {
  loadBlog();
}

if (blogDetailClose) {
  blogDetailClose.addEventListener("click", closeBlogDetail);
}

if (blogDetail) {
  blogDetail.addEventListener("click", (e) => {
    if (e.target === blogDetail) closeBlogDetail();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && blogDetail && !blogDetail.hidden) closeBlogDetail();
});