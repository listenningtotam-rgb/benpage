/* ── Game 1: 24 点 · 24 Game ────────────────────────────── */
/* Combine four cards into 24 with + − × ÷ — every card used exactly
   once.  Rendered into the #app-24 panel (see index.html / games.js,
   which calls window.Game24.init() when the game opens and .stop()
   when the panel closes).

   • Hands are poker 1–13 and always solvable: a random hand is re-rolled
     until the exact solver finds a solution (fallback hand 6,6,6,6).
   • Arithmetic is exact rational ({ n, d }) so a solution can never be a
     floating-point near-miss (8 ÷ 3 × 9 is exactly 24).
   • Classes only, no inline style/script — the site CSP allows 'self'. */

const G24_PANEL = document.getElementById("app-24");
const g24CardsEl = document.getElementById("g24-cards");
const g24OpsEl = document.getElementById("g24-ops");
const g24StatusEl = document.getElementById("g24-status");
const g24TimerEl = document.getElementById("g24-timer");
const g24StatsEl = document.getElementById("g24-stats");
const g24NewBtn = document.getElementById("g24-new");
const g24HintBtn = document.getElementById("g24-hint");
const g24UndoBtn = document.getElementById("g24-undo");
const g24ResetBtn = document.getElementById("g24-reset");

/* Prefixed globals keep this file independent of blog.js / music.js
   (same convention as scEscapeHTML in music.js). */
const G24_OP_GLYPH = { "+": "+", "-": "−", "*": "×", "/": "÷" };
const G24_SUITS = ["♠", "♥", "♣", "♦"];
const G24_SOLVED_VALUE = 24;
/* Guaranteed-solvable hand, used only if the RNG never lands on one. */
const G24_FALLBACK_HAND = [6, 6, 6, 6];

function g24Esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ── Exact rational arithmetic ─────────────────────────── */
/* { n, d } with d > 0 and gcd(n, d) = 1. */
function g24Gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}

function g24Rat(n, d = 1) {
  if (d < 0) { n = -n; d = -d; }
  const g = g24Gcd(n, d);
  return { n: n / g, d: d / g };
}

function g24Add(a, b) { return g24Rat(a.n * b.d + b.n * a.d, a.d * b.d); }
function g24Sub(a, b) { return g24Rat(a.n * b.d - b.n * a.d, a.d * b.d); }
function g24Mul(a, b) { return g24Rat(a.n * b.n, a.d * b.d); }
/* Division is a no-op when the right side is 0 (null = "not allowed"). */
function g24Div(a, b) { return b.n === 0 ? null : g24Rat(a.n * b.d, a.d * b.n); }

function g24IsSolved(v) { return v.n === G24_SOLVED_VALUE * v.d; }
function g24Text(v) { return v.d === 1 ? String(v.n) : `${v.n}/${v.d}`; }

/* ── Solver ────────────────────────────────────────────── */
/* Exact search over every pair order and operator; returns one full
   expression string, or null when the current numbers cannot make 24. */
function g24Search(items) {
  if (items.length === 1) return g24IsSolved(items[0].v) ? items[0].expr : null;

  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const a = items[i], b = items[j];
      const rest = items.filter((_, k) => k !== i && k !== j);
      const merged = [];

      if (i < j) { // + and × are commutative — try each once, not twice
        merged.push({ v: g24Add(a.v, b.v), expr: `(${a.expr} + ${b.expr})` });
        merged.push({ v: g24Mul(a.v, b.v), expr: `(${a.expr} × ${b.expr})` });
      }
      merged.push({ v: g24Sub(a.v, b.v), expr: `(${a.expr} − ${b.expr})` });
      const quotient = g24Div(a.v, b.v);
      if (quotient) merged.push({ v: quotient, expr: `(${a.expr} ÷ ${b.expr})` });

      for (const item of merged) {
        const hit = g24Search(rest.concat([item]));
        if (hit) return hit;
      }
    }
  }
  return null;
}

/* Drop the outermost parentheses of a solved expression for display. */
function g24Pretty(expr) {
  const m = /^\((.*)\)$/.exec(expr);
  return m ? m[1] : expr;
}
/* ── Game state ────────────────────────────────────────── */
let g24Deal = null;       // { nums: [4] } — the hand currently being played
let g24LastHand = null;   // previous hand, so a new deal always differs
let g24Hand = [];         // live cards: { id, v, expr, face, suit }
let g24Sel = null;        // id of the selected card (null = none)
let g24Op = null;         // pending operator: "+" | "-" | "*" | "/"
let g24History = [];      // snapshots for Undo
let g24Won = false;       // this hand has been solved
let g24Credited = false;  // this hand already counted in 已解
let g24Solved = 0;        // hands solved in this session
let g24Hints = 0;         // hints shown in this session
let g24Elapsed = 0;       // seconds banked for the current hand
let g24TickTimer = null;  // ticking only while the panel is open
let g24TickStart = 0;     // Date.now() when the current tick window began
let g24NextId = 1;        // card id counter
let g24StatusTone = "";

/* ── Dealing ───────────────────────────────────────────── */
function g24ItemsOf(nums) {
  return nums.map((n) => ({ v: g24Rat(n), expr: String(n) }));
}

function g24SameHand(a, b) {
  if (!b) return false;
  const key = (arr) => arr.slice().sort((x, y) => x - y).join(",");
  return key(a) === key(b);
}

/* A random poker hand the solver can actually solve. */
function g24PickHand() {
  for (let tries = 0; tries < 500; tries++) {
    const nums = [];
    for (let i = 0; i < 4; i++) nums.push(1 + Math.floor(Math.random() * 13));
    if (g24SameHand(nums, g24LastHand)) continue; // never repeat the last hand
    if (!g24Search(g24ItemsOf(nums))) continue;   // skip unsolvable deals
    return nums;
  }
  return G24_FALLBACK_HAND.slice();
}

/* ── Render ────────────────────────────────────────────── */
function g24RenderCards() {
  g24CardsEl.innerHTML = g24Hand.map((card, i) => {
    const cls = ["g24-card"];
    if (card.id === g24Sel) cls.push("g24-selected");
    if (g24Hand.length === 1) cls.push("g24-single");
    // Face cards keep their suit; merged cards show how they were built.
    const badge = card.face != null
      ? `<span class="g24-card-suit">${card.suit}</span>`
      : `<span class="g24-card-expr">${g24Esc(card.expr)}</span>`;
    return (
      `<button type="button" class="${cls.join(" ")}" data-id="${card.id}"` +
      ` aria-label="第 ${i + 1} 张牌 ${g24Text(card.v)}">` +
      `<span class="g24-card-value">${g24Text(card.v)}</span>${badge}` +
      `</button>`
    );
  }).join("");
}

function g24RenderOps() {
  g24OpsEl.querySelectorAll(".g24-op").forEach((btn) => {
    btn.classList.toggle("g24-op-active", btn.dataset.op === g24Op);
  });
  g24UndoBtn.disabled = g24History.length === 0;
  g24StatsEl.textContent = `已解 ${g24Solved} · 提示 ${g24Hints}`;
}

function g24RenderAll() {
  g24RenderCards();
  g24RenderOps();
  g24RenderClock();
}

function g24SetStatus(text, tone) {
  g24StatusTone = tone || "";
  g24StatusEl.textContent = text;
  g24StatusEl.className = "g24-status" + (tone ? " g24-" + tone : "");
}

/* ── Clock ─────────────────────────────────────────────── */
function g24ClockSeconds() {
  return g24TickTimer ? g24Elapsed + (Date.now() - g24TickStart) / 1000 : g24Elapsed;
}

function g24FmtClock(sec) {
  const total = Math.floor(sec);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function g24RenderClock() {
  g24TimerEl.textContent = g24FmtClock(g24ClockSeconds());
}

function g24StopClock() {
  if (!g24TickTimer) return;
  clearInterval(g24TickTimer);
  g24TickTimer = null;
  g24Elapsed += (Date.now() - g24TickStart) / 1000;
}

function g24StartClock() {
  g24StopClock(); // bank whatever the last window measured
  g24TickStart = Date.now();
  g24TickTimer = setInterval(g24RenderClock, 250);
  g24RenderClock();
}
/* ── Hand lifecycle ────────────────────────────────────── */
/* (Re)build the four face cards from a dealt hand and restart the clock. */
function g24LoadHand(nums) {
  g24Hand = nums.map((n, i) => ({
    id: g24NextId++,
    v: g24Rat(n),
    expr: String(n),
    face: n,
    suit: G24_SUITS[i % G24_SUITS.length],
  }));
  g24Sel = null;
  g24Op = null;
  g24History = [];
  g24Won = false;
  g24Credited = false;
  g24Elapsed = 0;
  g24RenderAll();
  g24StartClock();
}

function g24NewDeal() {
  const nums = g24PickHand();
  g24LastHand = nums.slice();
  g24Deal = { nums: nums.slice() };
  g24LoadHand(nums);
  g24SetStatus("四张牌算 24 · make 24 —— 每张牌只用一次", "");
}

function g24ResetHand() {
  if (!g24Deal) return;
  g24LoadHand(g24Deal.nums.slice());
  g24SetStatus("重来 —— 同一副牌 · same hand, fresh start", "");
}

/* ── Merging two cards ─────────────────────────────────── */
function g24Apply(operator, a, b) {
  if (operator === "+") return g24Add(a, b);
  if (operator === "-") return g24Sub(a, b);
  if (operator === "*") return g24Mul(a, b);
  return g24Div(a, b); // null when dividing by zero
}

function g24Snapshot() {
  return {
    hand: g24Hand.map((card) => ({ ...card })),
    sel: g24Sel,
    op: g24Op,
    won: g24Won,
    status: { text: g24StatusEl.textContent, tone: g24StatusTone },
  };
}

function g24Merge(idA, operator, idB) {
  const a = g24Hand.find((card) => card.id === idA);
  const b = g24Hand.find((card) => card.id === idB);
  if (!a || !b || a === b) return;

  const value = g24Apply(operator, a.v, b.v);
  if (!value) { // ÷ 0 — keep both cards, just explain why
    g24SetStatus("不能除以 0 · cannot divide by zero", "warn");
    return;
  }

  g24History.push(g24Snapshot());
  const merged = {
    id: g24NextId++,
    v: value,
    expr: `(${a.expr} ${G24_OP_GLYPH[operator]} ${b.expr})`,
    face: null,
    suit: "",
  };
  const insertAt = Math.min(g24Hand.indexOf(a), g24Hand.indexOf(b));
  g24Hand = g24Hand.filter((card) => card !== a && card !== b);
  g24Hand.splice(insertAt, 0, merged); // the result takes the first slot
  g24Sel = null;
  g24Op = null;
  g24RenderAll();

  if (g24Hand.length > 1) {
    g24SetStatus(`还剩 ${g24Hand.length} 张牌 · ${g24Hand.length} cards left`, "");
    return;
  }

  if (g24IsSolved(g24Hand[0].v)) {
    g24StopClock();
    g24Won = true;
    if (!g24Credited) { g24Credited = true; g24Solved++; } // once per hand
    g24RenderOps();
    g24SetStatus(`🎉 ${g24Pretty(g24Hand[0].expr)} = 24 —— 用时 ${g24FmtClock(g24Elapsed)} · solved!`, "win");
  } else {
    g24SetStatus(`只剩 ${g24Text(g24Hand[0].v)} —— 不是 24，撤销或重来 · not 24`, "warn");
  }
}
/* ── Hint / Undo ───────────────────────────────────────── */
/* Solves the cards still on the table (not the original hand), so the hint
   always applies to the position the player is actually in. */
function g24Hint() {
  if (!g24Hand.length) return;
  const found = g24Search(g24Hand.map((card) => ({ v: card.v, expr: card.expr })));
  if (!found) {
    g24SetStatus("当前局面已经算不出 24 了 —— 撤销或重来 · no way to 24 from here", "warn");
    return;
  }
  g24Hints++;
  g24RenderOps();
  g24SetStatus(`提示：${g24Pretty(found)} = 24`, "hint");
}

function g24Undo() {
  const snap = g24History.pop();
  if (!snap) return;
  g24Hand = snap.hand;
  g24Sel = snap.sel;
  g24Op = snap.op;
  g24Won = snap.won;
  g24SetStatus(snap.status.text, snap.status.tone);
  g24RenderAll();
  // Undoing out of a win (or resuming after the panel was closed) ticks on.
  if (!g24Won && !g24TickTimer) g24StartClock();
}

/* ── Interaction ───────────────────────────────────────── */
/* Pick a card, pick an operator, the next card merges with it. */
function g24ClickCard(id) {
  if (g24Sel === null) { g24Sel = id; g24RenderAll(); return; }               // first pick
  if (g24Sel === id) { g24Sel = null; g24Op = null; g24RenderAll(); return; } // tap again = clear
  if (g24Op === null) { g24Sel = id; g24RenderAll(); return; }                // move the pick
  g24Merge(g24Sel, g24Op, id);                                                // combine
}

g24CardsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".g24-card");
  if (btn) g24ClickCard(Number(btn.dataset.id));
});

g24OpsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".g24-op");
  if (!btn) return;
  g24Op = g24Op === btn.dataset.op ? null : btn.dataset.op;
  g24RenderAll();
});

g24NewBtn.addEventListener("click", g24NewDeal);
g24HintBtn.addEventListener("click", g24Hint);
g24UndoBtn.addEventListener("click", g24Undo);
g24ResetBtn.addEventListener("click", g24ResetHand);

/* Keyboard shortcuts — only while this panel is on screen. */
const G24_KEY_OPS = { "+": "+", "-": "-", "*": "*", "x": "*", "X": "*", "/": "/" };

document.addEventListener("keydown", (e) => {
  if (!G24_PANEL || G24_PANEL.hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const key = e.key;
  if (key >= "1" && key <= "4") { // 1–4 pick the card in that slot
    const card = g24Hand[Number(key) - 1];
    if (!card) return;
    e.preventDefault();
    g24ClickCard(card.id);
    return;
  }

  if (G24_KEY_OPS[key]) {
    e.preventDefault();
    g24Op = g24Op === G24_KEY_OPS[key] ? null : G24_KEY_OPS[key];
    g24RenderAll();
    return;
  }

  const lower = String(key).toLowerCase();
  if (lower === "n") { e.preventDefault(); g24NewDeal(); }
  else if (lower === "h") { e.preventDefault(); g24Hint(); }
  else if (lower === "u" || key === "Backspace") { e.preventDefault(); g24Undo(); }
});

/* ── Public API (called from games.js) ─────────────────── */
/* First open deals a hand; reopening resumes the one in progress. */
function g24Init() {
  if (!G24_PANEL) return;
  if (!g24Deal) {
    g24NewDeal();
    return;
  }
  g24RenderAll();
  if (!g24Won) g24StartClock();
}

/* Called when the panel closes: bank the elapsed time and stop ticking. */
function g24Stop() {
  g24StopClock();
}

window.Game24 = { init: g24Init, stop: g24Stop };



