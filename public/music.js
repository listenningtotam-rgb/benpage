/* ── Music Section ─────────────────────────────────────── */
/* SoundCloud-style waveform player. Tracks come from /api/music. */

const trackListEl = document.getElementById("track-list");
const SC_ORANGE = "#ff5500";
/* Semi-transparent gray layer that covers the unplayed part of the waveform. */
const PROGRESS_LAYER = "rgba(18, 22, 44, 0.85)";

let MUSIC_TRACKS = []; // loaded from /api/music (kept so counters update in place)

/* Show only this many tracks by default; the rest are revealed by a
   "Show more" button. Kept in sync with blog.js's INITIAL_POSTS. */
const INITIAL_TRACKS = 5;

/* A single shared audio element → only one track plays at a time. */
const musicState = {
  audio: null,
  player: null,    // current { el, url, title, bars, canvas, timeEl, playBtn }
  pending: false,
};

/* ── Helpers ───────────────────────────────────────────── */
/* scEscapeHTML is prefixed to avoid clashing with blog.js's escapeHTML */
function scEscapeHTML(str) {
  return String(str)
    .replace(/\u0026/g, "\u0026amp;")
    .replace(/\u003C/g, "\u0026lt;")
    .replace(/\u003E/g, "\u0026gt;")
    .replace(/\u0022/g, "\u0026quot;")
    .replace(/\u0027/g, "\u0026#39;");
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ── Deterministic per-track waveform ──────────────────── */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildWaveform(seed, count = 110) {
  const rand = mulberry32(seed);
  const bars = new Array(count);
  for (let i = 0; i < count; i++) {
    const x = i / count;
    const intro = x < 0.12 ? x / 0.12 : 1;                       // quiet fade-in
    const outro = x > 0.85 ? Math.max(0, (1 - x) / 0.15) : 1;    // fade-out tail
    const level = 0.35 + 0.65 * rand();                          // random section level
    const pulse = 0.75 + 0.25 * Math.sin(x * Math.PI * 9);       // natural fluctuation
    bars[i] = Math.max(0.06, Math.min(1, level * pulse * (0.35 + 0.65 * intro * outro)));
  }
  return bars;
}

/* ── Waveform canvas rendering ─────────────────────────── */
function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawWaveform(canvas, bars, progressPct) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const w = rect.width;
  const h = rect.height;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const played = w * Math.min(1, Math.max(0, progressPct));
  const n = bars.length;
  const gap = Math.max(1, Math.round(w / 340));
  const bw = (w - gap * (n - 1)) / n;
  const radius = Math.max(1, bw * 0.45);

  // Draw the full waveform in the bright base color.
  ctx.fillStyle = SC_ORANGE;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = i * (bw + gap);
    const bh = Math.max(2.5, bars[i] * h * 0.92);
    const y = (h - bh) / 2;
    roundedRectPath(ctx, x, y, bw, bh, radius);
  }
  ctx.fill();

  // Gray layer over the unplayed portion — it shrinks away as the track plays.
  if (played < w - 0.5) {
    ctx.fillStyle = PROGRESS_LAYER;
    ctx.fillRect(played, 0, w - played, h);
  }
}

function redrawCurrent() {
  if (!musicState.player) return;
  const p = musicState.player;
  const a = musicState.audio;
  const progress = isFinite(a.duration) && a.duration > 0 ? a.currentTime / a.duration : 0;
  drawWaveform(p.canvas, p.bars, progress);

  const left = isFinite(a.duration) && a.duration > 0 ? fmtTime(a.currentTime) : "0:00";
  const right = isFinite(a.duration) && a.duration > 0 ? fmtTime(a.duration) : "0:00";
  p.timeEl.textContent = `${left} / ${right}`;
}

function requestDraw() {
  if (musicState.pending) return;
  musicState.pending = true;
  requestAnimationFrame(() => {
    musicState.pending = false;
    redrawCurrent();
  });
}

/* ── Seeking ───────────────────────────────────────────── */
function attachSeek(canvas) {
  let dragging = false;
  function seekFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (!musicState.audio || !isFinite(musicState.audio.duration) || musicState.audio.duration <= 0) return;
    musicState.audio.currentTime = x * musicState.audio.duration;
  }
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    seekFromEvent(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) seekFromEvent(e);
  });
  const stop = () => { dragging = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
}

/* ── Playback control ──────────────────────────────────── */
function getAudio() {
  if (!musicState.audio) {
    musicState.audio = new Audio();
    musicState.audio.preload = "metadata";

    musicState.audio.addEventListener("timeupdate", requestDraw);
    musicState.audio.addEventListener("loadedmetadata", requestDraw);
    musicState.audio.addEventListener("play", () => {
      if (musicState.player) {
        musicState.player.el.classList.add("playing");
        musicState.player.playBtn.setAttribute("aria-label", `Pause ${musicState.player.title}`);
      }
      // Count a play when a NEW start happens (switch to another track, or
      // replay after the track ended). Pause → resume is the same play.
      const p = musicState.player;
      if (p && p.id != null && p.id !== lastPlayCountId) {
        lastPlayCountId = p.id;
        countPlay(p);
      }
    });
    musicState.audio.addEventListener("pause", () => {
      if (musicState.player) {
        musicState.player.el.classList.remove("playing");
        musicState.player.playBtn.setAttribute("aria-label", `Play ${musicState.player.title}`);
      }
    });
    musicState.audio.addEventListener("ended", () => {
      lastPlayCountId = null; // replaying a finished track counts as a new play
      if (musicState.player) {
        musicState.player.el.classList.remove("playing");
        musicState.player.playBtn.setAttribute("aria-label", `Play ${musicState.player.title}`);
        musicState.player.timeEl.textContent = "0:00 / " + fmtTime(musicState.audio.duration);
        drawWaveform(musicState.player.canvas, musicState.player.bars, 0);
      }
    });
    musicState.audio.addEventListener("error", () => {
      if (musicState.player) {
        musicState.player.el.classList.add("has-error");
        musicState.player.timeEl.textContent = "Not available";
      }
    });
  }
  return musicState.audio;
}

function setActive(player) {
  if (musicState.player && musicState.player !== player) {
    musicState.player.el.classList.remove("playing");
    musicState.player.playBtn.setAttribute("aria-label", `Play ${musicState.player.title}`);
  }
  musicState.player = player;
}

function togglePlay(player) {
  const audio = getAudio();
  const same = musicState.player === player;

  if (same && !audio.paused) {
    audio.pause();
    return;
  }

  if (same) {
    // Just resume the paused track (don't restart it).
    audio.play().catch(() => {});
    return;
  }

  setActive(player);
  audio.src = player.url;
  audio.play().catch(() => {
    player.el.classList.add("has-error");
    player.timeEl.textContent = "Not available";
  });
}

function resetAllWaveforms() {
  document.querySelectorAll(".sc-track").forEach((el) => {
    const p = musicState.player;
    if (p && p.el === el) {
      redrawCurrent();
    } else {
      const canvas = el.querySelector(".sc-wave-canvas");
      const bars = el._bars;
      if (canvas && bars) drawWaveform(canvas, bars, 0);
    }
  });
}

/* ── Play counter ─────────────────────────────────────── */
/* A play is counted when a track starts. Pausing/resuming the same track
   does not re-count; replaying after it ends (or switching tracks) does.
   Counting is best-effort and never blocks playback. */
let lastPlayCountId = null;

function countPlay(player) {
  if (player.id == null) return;
  fetch(`/api/music/${player.id}/play`, { method: "POST" })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
    .then((data) => {
      const track = MUSIC_TRACKS.find((t) => String(t.id) === String(player.id));
      if (track) track.play_count = data.play_count;
      if (player.playsEl) player.playsEl.textContent = data.play_count;
    })
    .catch(() => {});
}

/* ── Rendering ─────────────────────────────────────────── */
/* Collapse the track list to the first INITIAL_TRACKS entries and keep a
   "Show more (N)" button that reveals the rest. */
function applyTrackPager() {
  const items = trackListEl.querySelectorAll(".sc-track");
  let moreWrap = trackListEl.querySelector(".list-more");

  if (items.length <= INITIAL_TRACKS) {
    if (moreWrap) moreWrap.remove();
    return;
  }

  items.forEach((el, i) => {
    el.hidden = i >= INITIAL_TRACKS; // style.css honors [hidden]
  });

  if (!moreWrap) {
    moreWrap = document.createElement("div");
    moreWrap.className = "list-more";
    trackListEl.appendChild(moreWrap);
  }
  const hidden = items.length - INITIAL_TRACKS;
  moreWrap.innerHTML = `<button type="button" class="list-more-btn">Show more (${hidden})</button>`;
  moreWrap.querySelector(".list-more-btn").addEventListener("click", () => {
    items.forEach((el, i) => {
      if (i >= INITIAL_TRACKS) el.hidden = false;
    });
    moreWrap.remove();
    resetAllWaveforms(); // hidden canvases had 0 width — draw them now
  });
}

function renderTracks(tracks) {
  if (!trackListEl) return;
  if (!tracks || tracks.length === 0) {
    trackListEl.innerHTML = `<p class="empty-note">No tracks yet.</p>`;
    return;
  }

  trackListEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  tracks.forEach((track) => {
    const url = String(track.url || "");
    const title = String(track.title || "Untitled");
    const playCount = Number(track.play_count) || 0;
    const seed = hashString((track.id != null ? track.id + ":" : "") + url + title);
    const bars = buildWaveform(seed);
    // 原创 (original) vs Cover — set once when the recording was created.
    const isCover = track.source_type === "cover";
    const badge = `<span class="rc-badge ${isCover ? "rc-badge-cover" : "rc-badge-original"}">${isCover ? "Cover" : "原创"}</span>`;

    const el = document.createElement("div");
    el.className = "sc-track";
    el.innerHTML = `
      <button type="button" class="sc-play" aria-label="Play ${scEscapeHTML(title)}">
        <svg class="sc-ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <svg class="sc-ico-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
      </button>
      <div class="sc-body">
        <div class="sc-top">
          <span class="sc-left">
            ${badge}
            <span class="sc-title" title="${scEscapeHTML(title)}">${scEscapeHTML(title)}</span>
          </span>
          <span class="sc-side">
            <span class="sc-time">0:00 / 0:00</span>
            <span class="sc-plays" title="Play count">▶ <span class="sc-plays-num">${playCount}</span> plays</span>
          </span>
          <button type="button" class="sc-share" title="Share as a web page" aria-label="Share ${scEscapeHTML(title)}">↗</button>
        </div>
        <div class="sc-wave">
          <canvas class="sc-wave-canvas"></canvas>
        </div>
      </div>
    `;

    const player = {
      el,
      id: track.id != null ? track.id : null,
      url,
      title,
      bars,
      canvas: el.querySelector(".sc-wave-canvas"),
      timeEl: el.querySelector(".sc-time"),
      playsEl: el.querySelector(".sc-plays-num"),
      playBtn: el.querySelector(".sc-play"),
    };
    el._bars = bars; // used by resetAllWaveforms

    player.playBtn.addEventListener("click", () => togglePlay(player));
    attachSeek(player.canvas);

    // Share as a standalone web page (WeChat friends / Moments / short link).
    const shareBtn = el.querySelector(".sc-share");
    if (shareBtn) {
      shareBtn.addEventListener("click", () => {
        if (track.id == null || typeof window.openShareDialog !== "function") return;
        window.openShareDialog({ title, path: `/music/${track.id}` });
      });
    }

    frag.appendChild(el);
  });

  trackListEl.appendChild(frag);
  applyTrackPager();
  resetAllWaveforms();
}

async function loadTracks() {
  try {
    const res = await fetch("/api/music");
    const data = await res.json();
    MUSIC_TRACKS = data.tracks || [];
    renderTracks(MUSIC_TRACKS);
  } catch (err) {
    if (trackListEl) {
      trackListEl.innerHTML = `<p class="empty-note">Failed to load tracks.</p>`;
    }
  }
}

/* Redraw on resize (debounced) so canvases stay crisp at any width. */
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resetAllWaveforms, 120);
});
if (trackListEl && typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => resetAllWaveforms());
  ro.observe(trackListEl);
}

/* ── Init ───────────────────────────────────────────────── */
if (trackListEl) {
  loadTracks();
}