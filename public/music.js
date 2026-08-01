/* ── Music Section ─────────────────────────────────────── */
/* Tracks are loaded from the SQLite database via /api/music. */

/* ── DOM helpers ────────────────────────────────────────── */
const trackList = document.getElementById("track-list");

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;")
    .replace(/'/g, "&" + "#39;");
}

function renderTracks(tracks) {
  if (!trackList) return;
  if (!tracks || tracks.length === 0) {
    trackList.innerHTML = `<p class="empty-note">No tracks yet.</p>`;
    return;
  }

  trackList.innerHTML = tracks
    .map((track, i) => {
      const num = String(i + 1).padStart(2, "0");
      return (
        `<div class="track-card">
          <div class="track-info">
            <span class="track-number">${num}</span>
            <div class="track-meta">
              <h3 class="track-title">${escapeHTML(track.title)}</h3>
            </div>
          </div>
          <audio class="track-audio" controls preload="none">
            <source src="${escapeHTML(track.url)}" />
            Your browser does not support audio playback.
          </audio>
        </div>`
      );
    })
    .join("");
}

async function loadTracks() {
  try {
    const res = await fetch("/api/music");
    const data = await res.json();
    renderTracks(data.tracks);
  } catch (err) {
    if (trackList) {
      trackList.innerHTML = `<p class="empty-note">Failed to load tracks.</p>`;
    }
  }
}

/* ── Init ───────────────────────────────────────────────── */
if (trackList) {
  loadTracks();
}