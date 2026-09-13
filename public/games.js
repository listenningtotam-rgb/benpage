/* ── Game Section ───────────────────────────────────────── */

// The Game section works like the Apps section (public/apps.js): a gallery of
// cards, each opening a panel in place. Games run entirely in the browser, so
// there is no fetching — every game module (e.g. public/game24.js) exposes its
// own init() / stop() and is driven lazily from openGame().

const gameGalleryEl = document.getElementById("game-gallery");
const gameDetailEl = document.getElementById("game-detail");
const gamePanels = {
  game24: document.getElementById("app-24"),
  sea: document.getElementById("app-sea"),
};

// Direct-access URLs — every game also lives at https://<domain>/{path}
// (server serves the single-page index.html shell; see server.js APP_PATHS).
// Visiting one auto-opens that game as a standalone page.
const GAME_PATHS = {
  "/24-game": { key: "game24", title: "24 点 · 24 Game" },
  "/sea-battle": { key: "sea", title: "怒海战舰 · Naval Fury" },
};

// Which game panel is open right now — switching games stops the old one first
// so no background game keeps a rAF loop alive behind a hidden panel.
let currentGame = null;

function openGame(target, opts = {}) {
  if (currentGame && currentGame !== target) stopGame();
  gameGalleryEl.hidden = true;
  gameDetailEl.hidden = false;
  Object.entries(gamePanels).forEach(([k, el]) => { el.hidden = k !== target; });

  // Games start when opened (and are paused again by closeGame / stopGame).
  if (target === "game24") window.Game24 && window.Game24.init();
  if (target === "sea") window.SeaBattle && window.SeaBattle.init();
  currentGame = target;

  if (opts.standalone) {
    document.body.classList.add("game-standalone");
    if (opts.title) document.title = `${opts.title} · BEN 言`;
    const game = document.getElementById("game");
    if (game && game.scrollIntoView) game.scrollIntoView();
    else window.scrollTo(0, 0);
  }
}

function stopGame() {
  currentGame = null;
  if (window.Game24) window.Game24.stop();
  if (window.SeaBattle) window.SeaBattle.stop();
}

// Only the cards in the Game gallery open games.
document.querySelectorAll("#game-gallery .app-open").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    if (!target) return;
    openGame(target);
  });
});

document.getElementById("game-detail-close").addEventListener("click", () => {
  if (document.body.classList.contains("game-standalone")) {
    // Standalone game page (domain/{path}) — closing leaves the game.
    window.location.href = "/";
    return;
  }
  stopGame();
  gameDetailEl.hidden = true;
  gameGalleryEl.hidden = false;
});

// Open the game when the page was loaded at one of its direct paths. Runs
// after DOM ready so game24.js (loaded after games.js) has defined
// window.Game24 before we may call into it.
function bootGameFromPath() {
  const hit = GAME_PATHS[location.pathname];
  if (hit) openGame(hit.key, { standalone: true, title: hit.title });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootGameFromPath);
else bootGameFromPath();
