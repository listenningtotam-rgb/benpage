/* ── Blog Section ───────────────────────────────────────── */
/* Posts are loaded from the SQLite database via /api/blog.
   Each post supports:
   - text  : paragraphs of words
   - image : one or more pictures (src + alt + caption)
   - video : embedded <video> playback (mp4 source)
*/

let BLOG_POSTS = []; // loaded from /api/blog

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
      </header>
      ${renderBlocks(post)}
    </article>`;
  blogDetail.hidden = false;
  document.body.style.overflow = "hidden"; // lock scroll while reading
}

function closeBlogDetail() {
  blogDetail.hidden = true;
  document.body.style.overflow = "";
  blogDetailContent.innerHTML = "";
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

    return (
      `<article class="blog-card" data-id="${escapeHTML(post.id)}">
        ${coverHtml}
        <div class="blog-card-body">
          <div class="blog-card-meta">
            <span class="blog-tag">${escapeHTML(post.tag || "Note")}</span>
            <span class="blog-date">${fmtDate(post.date)}</span>
          </div>
          <h3 class="blog-card-title">${escapeHTML(post.title)}</h3>
          ${mediaBadge}
        </div>
      </article>`
    );
  }).join("");

  blogGrid.querySelectorAll(".blog-card").forEach((card) => {
    card.addEventListener("click", () => {
      const post = BLOG_POSTS.find((p) => String(p.id) === card.dataset.id);
      if (post) renderBlogDetail(post);
    });
  });
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