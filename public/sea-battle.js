"use strict";
/*
 * Game 2 — 怒海战舰 · Naval Fury
 * ------------------------------
 * Top-down naval battle that lives inside the Game section's detail panel.
 * public/games.js calls window.SeaBattle.init() when the panel opens and
 * .stop() when it closes or another game takes over, so anything the game
 * owns (rAF loop, key/pointer listeners, HUD text) is released again.
 *
 * Desktop only by design: the ship is steered with W A S D / arrow keys and
 * the guns follow the mouse.  Phones get a "please use a desktop" notice
 * instead of a half-broken touch layout.
 *
 * The page runs under a strict CSP (script-src 'self', style-src 'self'), so
 * there are no inline styles and no image assets: sea, islands, ships, shells
 * and the radar are all canvas paths/gradients, and every DOM change goes
 * through textContent / classList / hidden.
 *
 * The simulation (sbStep) is pure data — no DOM, no canvas, fixed 60 Hz steps.
 * sbRender() only reads that state.  That split is what makes the game
 * testable from Node with a stubbed canvas (see the harness note at the end).
 */

/* ── Panel wiring ──────────────────────────────────────── */
const SB_PANEL = document.getElementById("app-sea");
const SB_CANVAS = document.getElementById("sb-canvas");
const SB_NOTICE = document.getElementById("sb-desktop-only");
const SB_HUD = document.getElementById("sb-hud");
const SB_HP_TEXT = document.getElementById("sb-hp-text");
const SB_WAVE = document.getElementById("sb-wave");
const SB_KILLS = document.getElementById("sb-kills");
const SB_TIMER = document.getElementById("sb-timer");
const SB_ACC = document.getElementById("sb-acc");
const SB_OVERLAY = document.getElementById("sb-overlay");
const SB_OVERLAY_TITLE = document.getElementById("sb-overlay-title");
const SB_OVERLAY_TEXT = document.getElementById("sb-overlay-text");
const SB_OVERLAY_BTN = document.getElementById("sb-overlay-btn");

/* ── View / world constants ────────────────────────────── */
const SB_VIEW_W = 960;          // logical drawing units, scaled to the CSS box
const SB_VIEW_H = 600;
const SB_WORLD_W = 2400;        // the sea is bigger than the screen, camera follows
const SB_WORLD_H = 1600;
const SB_STEP = 1 / 60;         // fixed simulation step
const SB_MAX_FRAME = 0.1;       // never advance more than 100 ms of sim per frame
const SB_SHELL_LIFE = 2.6;
const SB_SHELL_R = 3;
const SB_ISLANDS = 7;
const SB_KEYS = {
  KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1,
  ArrowUp: 1, ArrowLeft: 1, ArrowDown: 1, ArrowRight: 1,
  Space: 1, ShiftLeft: 1, ShiftRight: 1, KeyP: 1, Escape: 1, KeyR: 1,
};

/* Every gameplay number lives here: ship classes and the wave list. */
const SB_KIND = {
  player:    { hp: 100, r: 16, maxSpeed: 168, accel: 150, turn: 1.70, reload: 0.50, dmg: 12, detect: 0,   keep: 0,   spread: 0.02, shellSpeed: 470, barrels: 1 },
  destroyer: { hp: 40,  r: 14, maxSpeed: 142, accel: 120, turn: 1.25, reload: 1.70, dmg: 7,  detect: 560, keep: 330, spread: 0.06, shellSpeed: 400, barrels: 1 },
  cruiser:   { hp: 90,  r: 18, maxSpeed: 112, accel: 95,  turn: 0.90, reload: 2.20, dmg: 13, detect: 620, keep: 380, spread: 0.05, shellSpeed: 410, barrels: 2 },
  flagship:  { hp: 160, r: 22, maxSpeed: 96,  accel: 80,  turn: 0.72, reload: 2.70, dmg: 18, detect: 700, keep: 430, spread: 0.04, shellSpeed: 430, barrels: 3 },
};

const SB_WAVES = [
  ["destroyer", "destroyer", "destroyer"],
  ["destroyer", "destroyer", "destroyer", "cruiser", "cruiser"],
  ["destroyer", "destroyer", "destroyer", "destroyer", "cruiser", "cruiser", "flagship"],
];

const SB_TOTAL_ENEMIES = SB_WAVES.reduce(function (n, w) { return n + w.length; }, 0);

/* Palette shared by the renderer (all procedural, no assets). */
const SB_COLOR = {
  seaTop: "#0a1b28", seaBottom: "#071019",
  foam: "rgba(126,200,227,0.10)",
  island: "#243140", islandTop: "#2e3d4d", sand: "#c8a878",
  playerHull: "#33414d", playerDeck: "#4d5f6d", playerAccent: "#7ec8e3",
  enemyHull: "#463434", enemyDeck: "#5c4444", enemyAccent: "#ff8a5b",
  bossHull: "#4a2f3a", bossDeck: "#63394a", bossAccent: "#ff5566",
  shell: "#ffd479", hpGood: "#9be29b", hpMid: "#ffd479", hpBad: "#ff5566",
  panel: "rgba(6,18,26,0.72)", panelEdge: "rgba(126,200,227,0.35)",
};


/* ── Small helpers ─────────────────────────────────────── */
function sbClamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function sbLerp(a, b, t) { return a + (b - a) * t; }

/* signed shortest delta from `a` to `b` (radians) */
function sbAngleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* rotate `cur` toward `target` but never faster than `rate` rad/s */
function sbSlew(cur, target, rate, dt) {
  const d = sbAngleDelta(cur, target);
  const step = rate * dt;
  return cur + sbClamp(d, -step, step);
}

function sbLen(x, y) { return Math.sqrt(x * x + y * y); }

function sbFmtTime(sec) {
  const t = Math.max(0, Math.floor(sec));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

/* mulberry32 — same shape as the one rechub.js uses, so a run is reproducible */
let sbSeed = 1;
function sbSrand(seed) { sbSeed = (seed >>> 0) || 1; }

function sbRnd() {
  sbSeed = (sbSeed + 0x6D2B79F5) >>> 0;
  let t = sbSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function sbRndRange(a, b) { return a + (b - a) * sbRnd(); }

/* ── Module state ──────────────────────────────────────── */
let sbState = null;        // the whole simulation, pure data
let sbMode = "ready";      // ready | playing | paused | won | lost | mobile
let sbRaf = 0;
let sbLastTs = 0;
let sbAccum = 0;
let sbScaleX = 1;          // logical unit → backing-store pixel
let sbScaleY = 1;
let sbBound = false;
let sbCtx = null;

const sbKeys = Object.create(null);
const sbInput = {
  throttle: 0,             // -1 … 1
  turn: 0,                 // -1 … 1
  boost: false,
  firing: false,
  aimX: SB_VIEW_W / 2,     // pointer position in view units
  aimY: SB_VIEW_H / 2,
};

/* set by the pointer handlers, cleared on stop() */
let sbMouseDown = false;

/* ── World building ──────────────────────────────────────── */

function sbWorldCenter() { return { x: SB_WORLD_W / 2, y: SB_WORLD_H / 2 }; }

function sbBuildIslands(s) {
  const c = sbWorldCenter();
  for (let guard = 0; guard < 400 && s.islands.length < SB_ISLANDS; guard++) {
    const r = sbRndRange(58, 128);
    const x = sbRndRange(150 + r, SB_WORLD_W - 150 - r);
    const y = sbRndRange(150 + r, SB_WORLD_H - 150 - r);
    if (sbLen(x - c.x, y - c.y) < 400 + r) continue;      // keep the start area clear
    let ok = true;
    for (let i = 0; i < s.islands.length; i++) {
      const o = s.islands[i];
      if (sbLen(x - o.x, y - o.y) < o.r + r + 150) { ok = false; break; }
    }
    if (!ok) continue;
    const n = Math.round(sbRndRange(9, 13));
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(sbRndRange(0.82, 1.16));
    s.islands.push({ x: x, y: y, r: r, pts: pts, a: sbRndRange(0, Math.PI * 2) });
  }
}

function sbIslandHit(s, x, y, pad) {
  const p = pad || 0;
  for (let i = 0; i < s.islands.length; i++) {
    const is = s.islands[i];
    if (sbLen(x - is.x, y - is.y) < is.r + p) return true;
  }
  return false;
}

function sbLineBlocked(s, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = sbLen(dx, dy);
  const steps = Math.max(1, Math.ceil(d / 46));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (sbIslandHit(s, x1 + dx * t, y1 + dy * t, 0)) return true;
  }
  return false;
}

function sbRandomSeaPoint(s) {
  for (let i = 0; i < 60; i++) {
    const x = sbRndRange(160, SB_WORLD_W - 160);
    const y = sbRndRange(160, SB_WORLD_H - 160);
    if (!sbIslandHit(s, x, y, 60)) return { x: x, y: y };
  }
  return sbWorldCenter();
}

function sbMakeShip(kind, x, y, angle) {
  const k = SB_KIND[kind];
  return {
    kind: kind, x: x, y: y, angle: angle, v: 0,
    hp: k.hp, maxHp: k.hp, r: k.r,
    turret: angle, reload: k.reload * sbRndRange(0.1, 0.6),
    alive: true, sinkT: 0, flash: 0, fireT: 0, wakeT: 0, bumpT: 0, smokeT: 0,
    state: "patrol", wp: null, side: sbRnd() < 0.5 ? -1 : 1,
  };
}

function sbBuildState() {
  const s = {
    world: { w: SB_WORLD_W, h: SB_WORLD_H },
    islands: [], player: null, enemies: [], shells: [], fx: [],
    wave: 0, kills: 0, shots: 0, hits: 0, time: 0,
    nextWaveT: 0, over: false, won: false, msg: "", msgT: 0,
    cam: { x: 0, y: 0 },
  };
  sbBuildIslands(s);
  const c = sbWorldCenter();
  s.player = sbMakeShip("player", c.x, c.y, -Math.PI / 2);
  s.player.reload = 0;
  sbUpdateCam(s);
  return s;
}

function sbFlash(s, text, secs) { s.msg = text; s.msgT = secs; }

function sbSpawnEnemy(s, kind) {
  const k = SB_KIND[kind];
  let x = 260;
  let y = 260;
  for (let i = 0; i < 40; i++) {
    const edge = Math.floor(sbRnd() * 4);
    if (edge === 0) { x = sbRndRange(160, SB_WORLD_W - 160); y = 200; }
    else if (edge === 1) { x = sbRndRange(160, SB_WORLD_W - 160); y = SB_WORLD_H - 200; }
    else if (edge === 2) { x = 200; y = sbRndRange(160, SB_WORLD_H - 160); }
    else { x = SB_WORLD_W - 200; y = sbRndRange(160, SB_WORLD_H - 160); }
    if (sbLen(x - s.player.x, y - s.player.y) < 760) continue;
    if (sbIslandHit(s, x, y, k.r + 30)) continue;
    break;
  }
  const e = sbMakeShip(kind, x, y, Math.atan2(s.player.y - y, s.player.x - x));
  s.enemies.push(e);
  return e;
}

function sbStartWave(s) {
  s.wave += 1;
  s.nextWaveT = 0;
  const list = SB_WAVES[s.wave - 1] || [];









  for (let i = 0; i < list.length; i++) sbSpawnEnemy(s, list[i]);
  sbFlash(s, "第 " + s.wave + " 波 · Wave " + s.wave, 2.6);
}

function sbUpdateCam(s) {
  const p = s.player;
  s.cam.x = sbClamp(p.x - SB_VIEW_W / 2, 0, SB_WORLD_W - SB_VIEW_W);
  s.cam.y = sbClamp(p.y - SB_VIEW_H / 2, 0, SB_WORLD_H - SB_VIEW_H);


/* Ships are solid: bumping shoves both apart and costs a little hull. */








}

/* ── Simulation (pure data, no DOM) ──────────────────────── */

function sbAimWorld(s, input) {
  return { x: s.cam.x + input.aimX, y: s.cam.y + input.aimY };
}

function sbIntegrate(s, ship, dt) {
  ship.x += Math.cos(ship.angle) * ship.v * dt;
  ship.y += Math.sin(ship.angle) * ship.v * dt;
  sbResolveIslands(s, ship);
  const m = ship.r + 36;
  const cx = sbClamp(ship.x, m, s.world.w - m);
  const cy = sbClamp(ship.y, m, s.world.h - m);
  if (cx !== ship.x || cy !== ship.y) ship.v *= 0.5;   // soft world edge
  ship.x = cx;
  ship.y = cy;
}

function sbResolveIslands(s, ship) {
  for (let i = 0; i < s.islands.length; i++) {
    const is = s.islands[i];
    const dx = ship.x - is.x;
    const dy = ship.y - is.y;
    const d = sbLen(dx, dy);
    const min = is.r + ship.r;
    if (d >= min) continue;
    if (d < 0.0001) { ship.x = is.x + min; continue; }
    ship.x = is.x + (dx / d) * min;
    ship.y = is.y + (dy / d) * min;
    ship.v *= 0.35;                                     // beaching kills your speed
  }
}

function sbFire(s, ship, angle, k) {
  const n = k.barrels || 1;
  for (let i = 0; i < n; i++) {
    const lane = n === 1 ? 0 : (i - (n - 1) / 2);
    const a = angle + lane * 0.055 + (sbRnd() - 0.5) * k.spread * 2;
    const ox = Math.cos(angle) * (ship.r + 7) - Math.sin(angle) * lane * 6;
    const oy = Math.sin(angle) * (ship.r + 7) + Math.cos(angle) * lane * 6;
    s.shells.push({
      x: ship.x + ox, y: ship.y + oy,
      vx: Math.cos(a) * k.shellSpeed, vy: Math.sin(a) * k.shellSpeed,
      life: SB_SHELL_LIFE, dmg: k.dmg,
      from: ship.kind === "player" ? "player" : "enemy",
    });
  }
  if (ship.kind === "player") s.shots += 1;
  ship.reload = k.reload;
  ship.fireT = 0.12;
  sbFxPush(s, "muzzle", ship.x + Math.cos(angle) * (ship.r + 8), ship.y + Math.sin(angle) * (ship.r + 8), 0, 0, 0.12, ship.r * 0.5);
}

function sbDamage(s, ship, dmg) {
  if (!ship.alive) return;
  ship.hp = Math.max(0, ship.hp - dmg);
  ship.flash = 1;
  if (ship.hp <= 0) sbSink(s, ship);
}

function sbSink(s, ship) {
  if (!ship.alive) return;
  ship.alive = false;
  ship.sinkT = 0;
  ship.v = 0;
  if (ship.kind === "player") sbFlash(s, "舰体进水 · Hull breached", 1.8);
  else s.kills += 1;
  sbBoomFx(s, ship);
}

function sbPlayerStep(s, input, dt) {
  const p = s.player;
  const k = SB_KIND.player;
  p.reload = Math.max(0, p.reload - dt);
  if (p.fireT > 0) p.fireT -= dt;
  if (!p.alive) {
    p.sinkT += dt;
    p.v = Math.max(0, p.v - 70 * dt);
    sbIntegrate(s, p, dt);
    return;
  }
  const boost = input.boost ? 1 : 0;
  const vmax = k.maxSpeed * (1 + 0.35 * boost);
  if (input.throttle !== 0) p.v += input.throttle * k.accel * (1 + 0.5 * boost) * dt;
  p.v -= p.v * 0.75 * dt;                              // water drag
  p.v = sbClamp(p.v, -vmax * 0.42, vmax);              // reversing is slow
  const speedFrac = sbClamp(Math.abs(p.v) / k.maxSpeed, 0, 1);
  if (input.turn !== 0) p.angle += input.turn * k.turn * (0.3 + 0.7 * speedFrac) * dt;
  const aim = sbAimWorld(s, input);
  const want = Math.atan2(aim.y - p.y, aim.x - p.x);
  p.turret = sbSlew(p.turret, want, 14, dt);
  if (input.firing && p.reload <= 0 && Math.abs(sbAngleDelta(p.turret, want)) < 0.3) {
    sbFire(s, p, p.turret, k);
  }
  sbIntegrate(s, p, dt);
  p.wakeT -= dt;
  if (Math.abs(p.v) > 26 && p.wakeT <= 0) { p.wakeT = 0.07; sbWakeFx(s, p); }
}

function sbShellsStep(s, dt) {
  for (let i = s.shells.length - 1; i >= 0; i--) {
    const sh = s.shells[i];
    sh.x += sh.vx * dt;
    sh.y += sh.vy * dt;
    sh.life -= dt;
    let dead = sh.life <= 0;
    if (!dead && sbIslandHit(s, sh.x, sh.y, SB_SHELL_R)) {
      sbSplashFx(s, sh.x, sh.y);
      dead = true;
    }
    if (!dead) {
      const targets = sh.from === "player" ? s.enemies : [s.player];
      for (let j = 0; j < targets.length; j++) {
        const t = targets[j];
        if (!t.alive) continue;
        if (sbLen(t.x - sh.x, t.y - sh.y) < t.r + SB_SHELL_R) {
          sbDamage(s, t, sh.dmg);
          sbHitFx(s, sh.x, sh.y);
          if (sh.from === "player") s.hits += 1;
          dead = true;
          break;
        }
      }
    }
    if (dead) s.shells.splice(i, 1);
  }
}

/* ── Enemy AI ────────────────────────────────────────────── */

function sbEnemyStep(s, e, dt) {
  if (!e.alive) { e.sinkT += dt; return; }
  const k = SB_KIND[e.kind];
  const p = s.player;
  e.reload = Math.max(0, e.reload - dt);
  if (e.fireT > 0) e.fireT -= dt;
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const dist = Math.max(0.001, sbLen(dx, dy));
  const toP = Math.atan2(dy, dx);
  const blocked = sbIslandHit(s, e.x + Math.cos(e.angle) * (e.r + 95), e.y + Math.sin(e.angle) * (e.r + 95), e.r + 12) ||
    sbIslandHit(s, e.x + Math.cos(e.angle) * (e.r + 40), e.y + Math.sin(e.angle) * (e.r + 40), e.r + 6);

  if (p.alive && dist < k.detect) {
    e.state = "engage";
    let want;
    if (dist > k.keep + 70) want = toP;                          // close in
    else if (dist < k.keep - 70) want = toP + Math.PI;           // back off
    else want = toP + e.side * Math.PI * 0.5;                    // circle strafe
    if (blocked) want += e.side * 0.9;
    e.angle += sbClamp(sbAngleDelta(e.angle, want), -k.turn * dt, k.turn * dt);
    const tv = dist > k.keep - 70 ? 1 : 0.25;
    e.v += k.accel * tv * dt - e.v * 0.7 * dt;
    e.v = sbClamp(e.v, 0, k.maxSpeed);
    const t = dist / k.shellSpeed;                               // lead the player
    const px = p.x + Math.cos(p.angle) * p.v * t;
    const py = p.y + Math.sin(p.angle) * p.v * t;
    const wantT = Math.atan2(py - e.y, px - e.x);
    e.turret = sbSlew(e.turret, wantT, 2.2, dt);
    if (e.reload <= 0 && Math.abs(sbAngleDelta(e.turret, wantT)) < 0.22 &&
        !sbLineBlocked(s, e.x, e.y, p.x, p.y)) {
      sbFire(s, e, e.turret, k);
    }
  } else {
    e.state = "patrol";
    if (!e.wp || sbLen(e.wp.x - e.x, e.wp.y - e.y) < 110 || sbIslandHit(s, e.wp.x, e.wp.y, 50)) {
      e.wp = sbRandomSeaPoint(s);
    }
    let want = Math.atan2(e.wp.y - e.y, e.wp.x - e.x);
    if (blocked) want += e.side * 0.8;
    e.angle += sbClamp(sbAngleDelta(e.angle, want), -k.turn * 0.7 * dt, k.turn * 0.7 * dt);
    e.v += k.accel * 0.45 * dt - e.v * 0.7 * dt;
    e.v = sbClamp(e.v, 0, k.maxSpeed * 0.55);
    e.turret = sbSlew(e.turret, e.angle, 1.4, dt);
  }

  sbIntegrate(s, e, dt);
  e.wakeT -= dt;
  if (e.v > 26 && e.wakeT <= 0) { e.wakeT = 0.09; sbWakeFx(s, e); }
  if (e.hp < e.maxHp * 0.4) {                            // burning below 40 %
    e.smokeT = (e.smokeT || 0) - dt;
    if (e.smokeT <= 0) { e.smokeT = 0.34; sbSmokeFx(s, e); }
  }
}

function sbSeparateShips(s, dt) {
  const all = s.enemies.concat([s.player]);
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];
      if (!b.alive) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = sbLen(dx, dy);
      const min = a.r + b.r;
      if (d >= min) continue;
      if (d < 0.0001) { a.x -= min; continue; }
      const nx = dx / d;
      const ny = dy / d;
      const push = (min - d) * 0.5;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      a.v *= 0.7; b.v *= 0.7;
      if (a.bumpT <= 0) { a.bumpT = 0.6; sbDamage(s, a, 4); }
      if (b.bumpT <= 0) { b.bumpT = 0.6; sbDamage(s, b, 4); }
    }
  }
  for (let i = 0; i < all.length; i++) if (all[i].bumpT > 0) all[i].bumpT -= dt;
}

/* ── Visual effects (state only — the renderer draws them) ─ */

function sbFxPush(s, kind, x, y, vx, vy, life, size) {
  if (s.fx.length > 420) s.fx.shift();
  s.fx.push({ kind: kind, x: x, y: y, vx: vx, vy: vy, life: life, maxLife: life, size: size });
}

function sbFxStep(s, dt) {
  for (let i = s.fx.length - 1; i >= 0; i--) {
    const f = s.fx[i];
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.vx -= f.vx * 1.6 * dt;
    f.vy -= f.vy * 1.6 * dt;
    if (f.kind === "smoke") f.size += 9 * dt;
    if (f.kind === "muzzle") f.size += 14 * dt;
    f.life -= dt;
    if (f.life <= 0) s.fx.splice(i, 1);
  }
}

function sbWakeFx(s, ship) {
  const back = ship.angle + Math.PI;
  for (let i = 0; i < 2; i++) {
    sbFxPush(s, "wake",
      ship.x + Math.cos(back) * ship.r * 0.9 + sbRndRange(-5, 5),
      ship.y + Math.sin(back) * ship.r * 0.9 + sbRndRange(-5, 5),
      Math.cos(back) * 12, Math.sin(back) * 12, 0.9, ship.r * 0.5);
  }
}

function sbSmokeFx(s, ship) {
  sbFxPush(s, "smoke", ship.x + sbRndRange(-6, 6), ship.y + sbRndRange(-6, 6),
    sbRndRange(-8, 8), sbRndRange(-16, -4), 1.4, ship.r * 0.5);
}

function sbSplashFx(s, x, y) {
  for (let i = 0; i < 5; i++) {
    const a = sbRndRange(0, Math.PI * 2);
    const sp = sbRndRange(30, 90);
    sbFxPush(s, "splash", x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.42, 3);
  }
}

function sbHitFx(s, x, y) {
  for (let i = 0; i < 8; i++) {
    const a = sbRndRange(0, Math.PI * 2);
    const sp = sbRndRange(50, 150);
    sbFxPush(s, "boom", x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.5, 4);
  }
  sbFxPush(s, "smoke", x, y, 0, -12, 1.1, 8);
}

function sbBoomFx(s, ship) {
  for (let i = 0; i < 26; i++) {
    const a = sbRndRange(0, Math.PI * 2);
    const sp = sbRndRange(40, 210);
    sbFxPush(s, "boom", ship.x, ship.y, Math.cos(a) * sp, Math.sin(a) * sp, sbRndRange(0.5, 1.1), 6);
  }
  for (let i = 0; i < 8; i++) {
    sbFxPush(s, "smoke", ship.x + sbRndRange(-10, 10), ship.y + sbRndRange(-10, 10),
      sbRndRange(-14, 14), sbRndRange(-26, -8), sbRndRange(1.2, 2.2), 10);
  }
}

/* ── One fixed simulation step ───────────────────────────── */

function sbStep(s, input, dt) {
  s.time += dt;
  if (s.msgT > 0) s.msgT = Math.max(0, s.msgT - dt);

  sbPlayerStep(s, input, dt);
  for (let i = 0; i < s.enemies.length; i++) sbEnemyStep(s, s.enemies[i], dt);
  sbShellsStep(s, dt);
  sbSeparateShips(s, dt);
  sbFxStep(s, dt);

  for (let i = 0; i < s.enemies.length; i++) {
    const e = s.enemies[i];
    if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 4);
    if (!e.alive && e.sinkT > 1.5) { s.enemies.splice(i, 1); i--; }
  }
  const p = s.player;
  if (p.flash > 0) p.flash = Math.max(0, p.flash - dt * 4);
  if (!p.alive && !s.over && p.sinkT > 1.5) s.over = true;

  /* wave flow: clear the current wave, wait a beat, send the next one */
  if (p.alive && !s.won) {
    let alive = 0;
    for (let i = 0; i < s.enemies.length; i++) if (s.enemies[i].alive) alive++;
    if (alive === 0) {
      if (s.wave < SB_WAVES.length) {
        if (s.nextWaveT > 0) {
          s.nextWaveT -= dt;
          if (s.nextWaveT <= 0) sbStartWave(s);
        } else {
          s.nextWaveT = 2.4;
          sbFlash(s, "本波已肃清 · Wave clear", 2.2);
        }
      } else {
        s.won = true;
      }
    }
  }

  sbUpdateCam(s);
  return s;










}

/* ── Renderer (reads state, never writes it) ─────────────── */

function sbRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function sbHpColor(frac) {
  if (frac > 0.55) return SB_COLOR.hpGood;
  if (frac > 0.28) return SB_COLOR.hpMid;
  return SB_COLOR.hpBad;
}

function sbDrawSea(ctx, s) {
  const g = ctx.createLinearGradient(0, 0, 0, SB_VIEW_H);
  g.addColorStop(0, SB_COLOR.seaTop);
  g.addColorStop(1, SB_COLOR.seaBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SB_VIEW_W, SB_VIEW_H);
  ctx.strokeStyle = SB_COLOR.foam;
  ctx.lineWidth = 1.5;
  const gap = 64;
  const off = (s.time * 14) % gap;
  for (let y = -gap + off; y < SB_VIEW_H + gap; y += gap) {
    const row = Math.round((y + s.cam.y) / gap);
    ctx.beginPath();
    for (let x = 0; x <= SB_VIEW_W; x += 32) {
      const wy = y + Math.sin((x + s.cam.x + row * 40) * 0.012) * 3;
      if (x === 0) ctx.moveTo(x, wy);
      else ctx.lineTo(x, wy);
    }
    ctx.stroke();
  }
}

function sbIslandPath(ctx, is, x, y, scale) {
  const n = is.pts.length;
  ctx.beginPath();
  for (let j = 0; j <= n; j++) {
    const k = j % n;
    const a = is.a + (k / n) * Math.PI * 2;
    const rr = is.r * is.pts[k] * scale;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (j === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function sbDrawIslands(ctx, s) {
  for (let i = 0; i < s.islands.length; i++) {
    const is = s.islands[i];
    const x = is.x - s.cam.x;
    const y = is.y - s.cam.y;
    if (x < -is.r * 2 || y < -is.r * 2 || x > SB_VIEW_W + is.r * 2 || y > SB_VIEW_H + is.r * 2) continue;
    sbIslandPath(ctx, is, x, y, 1.24);
    ctx.fillStyle = "rgba(126,200,227,0.10)";        // shallow water
    ctx.fill();
    sbIslandPath(ctx, is, x, y, 1.05);
    ctx.fillStyle = "rgba(200,168,120,0.45)";        // beach
    ctx.fill();
    sbIslandPath(ctx, is, x, y, 0.94);
    ctx.fillStyle = SB_COLOR.island;
    ctx.fill();
    sbIslandPath(ctx, is, x, y, 0.70);
    ctx.fillStyle = SB_COLOR.islandTop;
    ctx.fill();
  }
}

function sbShipPath(ctx, r) {
  ctx.beginPath();
  ctx.moveTo(r * 1.15, 0);
  ctx.quadraticCurveTo(r * 0.6, -r * 0.72, -r * 0.55, -r * 0.7);
  ctx.lineTo(-r * 1.0, -r * 0.5);
  ctx.lineTo(-r * 1.0, r * 0.5);
  ctx.lineTo(-r * 0.55, r * 0.7);
  ctx.quadraticCurveTo(r * 0.6, r * 0.72, r * 1.15, 0);
  ctx.closePath();
}

function sbDrawTurret(ctx, r, lane, rel, accent, recoil) {
  ctx.save();
  ctx.translate(r * 0.12, lane * r * 0.42);
  ctx.rotate(rel);
  ctx.fillStyle = accent;
  ctx.fillRect(recoil, -2, r * 0.95, 4);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.36, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(230,240,245,0.92)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

function sbDrawEnemyHp(ctx, x, y, ship, r) {
  const frac = sbClamp(ship.hp / ship.maxHp, 0, 1);
  const w = Math.max(30, r * 2.6);
  const bx = x - w / 2;
  const by = y - r - 15;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(bx - 1, by - 1, w + 2, 6);
  ctx.fillStyle = sbHpColor(frac);
  if (frac > 0) ctx.fillRect(bx, by, w * frac, 4);
}

function sbDrawShip(ctx, s, ship) {
  const k = SB_KIND[ship.kind];
  const x = ship.x - s.cam.x;
  const y = ship.y - s.cam.y;
  const r = ship.r;
  const isPlayer = ship.kind === "player";
  const sunk = !ship.alive;
  const t = sunk ? sbClamp(ship.sinkT / 1.5, 0, 1) : 0;
  if (x < -80 || y < -80 || x > SB_VIEW_W + 80 || y > SB_VIEW_H + 80) return;

  const boss = ship.kind === "flagship";
  const hull = boss ? SB_COLOR.bossHull : isPlayer ? SB_COLOR.playerHull : SB_COLOR.enemyHull;
  const deck = boss ? SB_COLOR.bossDeck : isPlayer ? SB_COLOR.playerDeck : SB_COLOR.enemyDeck;
  const accent = boss ? SB_COLOR.bossAccent : isPlayer ? SB_COLOR.playerAccent : SB_COLOR.enemyAccent;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ship.angle);
  if (sunk) { ctx.globalAlpha = Math.max(0, 1 - t); ctx.scale(1 + t * 0.22, 1 + t * 0.22); }

  ctx.save();
  ctx.translate(2.5, 3);
  sbShipPath(ctx, r);
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.fill();
  ctx.restore();

  sbShipPath(ctx, r);
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = deck;
  ctx.beginPath();
  ctx.moveTo(r * 0.95, 0);
  ctx.quadraticCurveTo(r * 0.5, -r * 0.5, -r * 0.5, -r * 0.48);
  ctx.lineTo(-r * 0.85, -r * 0.34);
  ctx.lineTo(-r * 0.85, r * 0.34);
  ctx.lineTo(-r * 0.5, r * 0.48);
  ctx.quadraticCurveTo(r * 0.5, r * 0.5, r * 0.95, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillRect(-r * 0.42, -r * 0.3, r * 0.72, r * 0.6);

  const recoil = ship.fireT > 0 ? -3 : 0;
  const barrels = k.barrels || 1;
  for (let i = 0; i < barrels; i++) {
    const lane = barrels === 1 ? 0 : i - (barrels - 1) / 2;
    sbDrawTurret(ctx, r, lane, ship.turret - ship.angle, accent, recoil);
  }

  if (ship.flash > 0) {
    ctx.globalAlpha = ship.flash * 0.55;
    sbShipPath(ctx, r);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }
  ctx.restore();

  if (!sunk && !isPlayer) sbDrawEnemyHp(ctx, x, y, ship, r);
}

function sbDrawShells(ctx, s) {
  for (let i = 0; i < s.shells.length; i++) {
    const sh = s.shells[i];
    const x = sh.x - s.cam.x;
    const y = sh.y - s.cam.y;
    if (x < -24 || y < -24 || x > SB_VIEW_W + 24 || y > SB_VIEW_H + 24) continue;
    const a = Math.atan2(sh.vy, sh.vx);
    ctx.strokeStyle = sh.from === "player" ? "rgba(255,212,121,0.85)" : "rgba(255,140,140,0.85)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - Math.cos(a) * 12, y - Math.sin(a) * 12);
    ctx.stroke();
    ctx.fillStyle = sh.from === "player" ? SB_COLOR.shell : "#ff8a8a";
    ctx.beginPath();
    ctx.arc(x, y, SB_SHELL_R, 0, Math.PI * 2);
    ctx.fill();
  }
}

function sbDrawFx(ctx, s, phase) {
  for (let i = 0; i < s.fx.length; i++) {
    const f = s.fx[i];
    const isWake = f.kind === "wake";
    if ((phase === "wake") !== isWake) continue;
    const x = f.x - s.cam.x;
    const y = f.y - s.cam.y;
    if (x < -40 || y < -40 || x > SB_VIEW_W + 40 || y > SB_VIEW_H + 40) continue;
    const t = sbClamp(f.life / f.maxLife, 0, 1);
    ctx.globalAlpha = t;
    if (f.kind === "wake") {
      ctx.globalAlpha = t * 0.5;
      ctx.strokeStyle = "rgba(200,235,250,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, f.size * (2 - t), 0, Math.PI * 2);
      ctx.stroke();
    } else if (f.kind === "splash") {
      ctx.fillStyle = "rgba(200,235,250,0.9)";
      ctx.beginPath();
      ctx.arc(x, y, f.size * (0.6 + t), 0, Math.PI * 2);
      ctx.fill();
    } else if (f.kind === "boom") {
      ctx.fillStyle = t > 0.5 ? "#ffd479" : "#ff8a5b";
      ctx.beginPath();
      ctx.arc(x, y, f.size * (0.5 + (1 - t) * 1.6), 0, Math.PI * 2);
      ctx.fill();
    } else if (f.kind === "smoke") {
      ctx.globalAlpha = t * 0.35;
      ctx.fillStyle = "#8fa3b0";
      ctx.beginPath();
      ctx.arc(x, y, f.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (f.kind === "muzzle") {
      ctx.fillStyle = "#ffe9a8";
      ctx.beginPath();
      ctx.arc(x, y, f.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function sbDrawBanner(ctx, s) {
  if (s.msgT <= 0 || !s.msg) return;
  ctx.globalAlpha = sbClamp(s.msgT, 0, 1);
  ctx.font = "600 26px 'SF Mono', Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#7ec8e3";
  ctx.fillText(s.msg, SB_VIEW_W / 2, 100);
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";



}

function sbDrawHpBar(ctx, s) {
  const p = s.player;
  const frac = sbClamp(p.hp / p.maxHp, 0, 1);
  const w = 240;
  const h = 14;
  const x = 20;
  const y = 20;
  ctx.fillStyle = SB_COLOR.panel;
  sbRoundRect(ctx, x - 5, y - 5, w + 10, h + 10, 10);
  ctx.fill();
  ctx.strokeStyle = SB_COLOR.panelEdge;
  ctx.lineWidth = 1;
  sbRoundRect(ctx, x - 5, y - 5, w + 10, h + 10, 10);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  sbRoundRect(ctx, x, y, w, h, 7);
  ctx.fill();
  if (frac > 0) {
    ctx.fillStyle = sbHpColor(frac);
    sbRoundRect(ctx, x, y, Math.max(8, w * frac), h, 7);
    ctx.fill();
  }
  ctx.font = "700 13px 'SF Mono', Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#0a141c";
  ctx.fillText("HP " + Math.ceil(p.hp) + " / " + p.maxHp, x + w / 2, y + h - 3);
  ctx.textAlign = "left";
  if (frac < 0.3 && p.alive) {                       // low hull warning wash
    ctx.globalAlpha = 0.10 + 0.07 * Math.sin(s.time * 6);
    ctx.fillStyle = SB_COLOR.hpBad;
    ctx.fillRect(0, 0, SB_VIEW_W, SB_VIEW_H);
    ctx.globalAlpha = 1;
  }
}

function sbDrawRadar(ctx, s) {
  const rw = 168;
  const rh = 112;
  const rx = SB_VIEW_W - rw - 18;
  const ry = 18;
  ctx.fillStyle = SB_COLOR.panel;
  sbRoundRect(ctx, rx, ry, rw, rh, 10);
  ctx.fill();
  ctx.strokeStyle = SB_COLOR.panelEdge;
  ctx.lineWidth = 1;
  sbRoundRect(ctx, rx, ry, rw, rh, 10);
  ctx.stroke();
  const sc = Math.min((rw - 16) / s.world.w, (rh - 16) / s.world.h);
  const ox = rx + (rw - s.world.w * sc) / 2;
  const oy = ry + (rh - s.world.h * sc) / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.strokeRect(ox + s.cam.x * sc, oy + s.cam.y * sc, SB_VIEW_W * sc, SB_VIEW_H * sc);
  ctx.fillStyle = "rgba(200,168,120,0.5)";
  for (let i = 0; i < s.islands.length; i++) {
    const is = s.islands[i];
    ctx.beginPath();
    ctx.arc(ox + is.x * sc, oy + is.y * sc, Math.max(1.5, is.r * sc), 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < s.enemies.length; i++) {
    const e = s.enemies[i];
    if (!e.alive) continue;
    ctx.fillStyle = e.kind === "flagship" ? SB_COLOR.bossAccent : SB_COLOR.enemyAccent;
    ctx.beginPath();
    ctx.arc(ox + e.x * sc, oy + e.y * sc, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = SB_COLOR.playerAccent;
  ctx.beginPath();
  ctx.arc(ox + s.player.x * sc, oy + s.player.y * sc, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = SB_COLOR.playerAccent;
  ctx.beginPath();
  ctx.moveTo(ox + s.player.x * sc, oy + s.player.y * sc);
  ctx.lineTo(ox + (s.player.x + Math.cos(s.player.angle) * 90) * sc,
    oy + (s.player.y + Math.sin(s.player.angle) * 90) * sc);
  ctx.stroke();
}

function sbDrawCrosshair(ctx, s) {
  const x = sbInput.aimX;
  const y = sbInput.aimY;
  const p = s.player;
  const k = SB_KIND.player;
  const ready = 1 - sbClamp(p.reload / k.reload, 0, 1);
  ctx.strokeStyle = ready >= 1 ? "rgba(255,212,121,0.95)" : "rgba(255,212,121,0.45)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 17, y); ctx.lineTo(x - 11, y);
  ctx.moveTo(x + 17, y); ctx.lineTo(x + 11, y);
  ctx.moveTo(x, y - 17); ctx.lineTo(x, y - 11);
  ctx.moveTo(x, y + 17); ctx.lineTo(x, y + 11);
  ctx.stroke();
  if (ready < 1) {                                   // reload ring
    ctx.strokeStyle = "rgba(126,200,227,0.9)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ready);
    ctx.stroke();
  }
  const aim = sbAimWorld(s, sbInput);
  let best = null;
  let bd = 1e9;
  for (let i = 0; i < s.enemies.length; i++) {
    const e = s.enemies[i];
    if (!e.alive) continue;
    const d = sbLen(e.x - aim.x, e.y - aim.y);
    if (d < bd) { bd = d; best = e; }
  }
  if (best && bd < 260) {                            // lead marker for the nearest target
    const tt = sbLen(best.x - p.x, best.y - p.y) / k.shellSpeed;
    const lx = best.x + Math.cos(best.angle) * best.v * tt - s.cam.x;
    const ly = best.y + Math.sin(best.angle) * best.v * tt - s.cam.y;
    ctx.strokeStyle = "rgba(255,85,0,0.8)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(lx, ly, 9, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function sbRender() {
  const ctx = sbCtx;
  const s = sbState;
  if (!ctx || !s) return;
  ctx.setTransform(sbScaleX, 0, 0, sbScaleY, 0, 0);
  ctx.clearRect(0, 0, SB_VIEW_W, SB_VIEW_H);
  sbDrawSea(ctx, s);
  sbDrawIslands(ctx, s);
  sbDrawFx(ctx, s, "wake");
  const ships = s.enemies.concat([s.player]);
  ships.sort(function (a, b) { return a.y - b.y; });
  for (let i = 0; i < ships.length; i++) sbDrawShip(ctx, s, ships[i]);
  sbDrawShells(ctx, s);
  sbDrawFx(ctx, s, "other");
  sbDrawBanner(ctx, s);
  sbDrawHpBar(ctx, s);
  sbDrawRadar(ctx, s);
  if (sbMode === "playing" || sbMode === "paused") sbDrawCrosshair(ctx, s);















/* Desktop-only gate: fine pointer + hover means a mouse is present.  iPadOS
 * reports a desktop UA, so the touch-point count is the fallback (the same
 * defensive shape rechub.js uses for iOS). */













}

/* ── HUD + overlay text ──────────────────────────────────── */

function sbSetText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

function sbSetHud() {
  const s = sbState;
  if (!s) return;
  sbSetText(SB_HP_TEXT, Math.ceil(s.player.hp) + " / " + s.player.maxHp);
  sbSetText(SB_WAVE, "第 " + Math.max(1, s.wave) + " / " + SB_WAVES.length + " 波");
  sbSetText(SB_KILLS, "击沉 " + s.kills + " / " + SB_TOTAL_ENEMIES);
  sbSetText(SB_TIMER, sbFmtTime(s.time));
  sbSetText(SB_ACC, "命中 " + (s.shots ? Math.round((s.hits / s.shots) * 100) : 0) + "%");
}

function sbStatsLine(s) {
  const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
  return "击沉 " + s.kills + " 艘 · 命中率 " + acc + "% · 用时 " + sbFmtTime(s.time);
}

function sbSetMode(mode) {
  sbMode = mode;
  if (!SB_OVERLAY) return;
  const show = mode !== "playing" && mode !== "mobile";
  SB_OVERLAY.hidden = !show;
  if (!show) return;
  const stats = sbState ? sbStatsLine(sbState) : "";
  if (mode === "ready") {
    sbSetText(SB_OVERLAY_TITLE, "怒海战舰 · Naval Fury");
    sbSetText(SB_OVERLAY_TEXT, "WASD / 方向键 转舵前进 · 鼠标瞄准 · 按住左键开火 · Shift 冲刺 · P 暂停");
    sbSetText(SB_OVERLAY_BTN, "开始战斗 · Start");
  } else if (mode === "paused") {
    sbSetText(SB_OVERLAY_TITLE, "已暂停 · Paused");
    sbSetText(SB_OVERLAY_TEXT, stats);
    sbSetText(SB_OVERLAY_BTN, "继续 · Resume");
  } else if (mode === "won") {
    sbSetText(SB_OVERLAY_TITLE, "海域已肃清 · Victory");
    sbSetText(SB_OVERLAY_TEXT, stats);
    sbSetText(SB_OVERLAY_BTN, "再来一局 · Play again");
  } else {
    sbSetText(SB_OVERLAY_TITLE, "战舰沉没 · Sunk");
    sbSetText(SB_OVERLAY_TEXT, stats);
    sbSetText(SB_OVERLAY_BTN, "再来一局 · Play again");
  }
}

/* ── Input ───────────────────────────────────────────────── */

function sbPanelOpen() { return !!SB_PANEL && !SB_PANEL.hidden && sbMode !== "mobile"; }

function sbClearKeys() { for (const k in sbKeys) sbKeys[k] = false; }

function sbReadInput() {
  sbInput.throttle = ((sbKeys.KeyW || sbKeys.ArrowUp) ? 1 : 0) - ((sbKeys.KeyS || sbKeys.ArrowDown) ? 1 : 0);
  sbInput.turn = ((sbKeys.KeyD || sbKeys.ArrowRight) ? 1 : 0) - ((sbKeys.KeyA || sbKeys.ArrowLeft) ? 1 : 0);
  sbInput.boost = !!(sbKeys.ShiftLeft || sbKeys.ShiftRight);
  sbInput.firing = sbMouseDown || !!sbKeys.Space;
  return sbInput;
}

function sbOnKeyDown(e) {
  if (!sbPanelOpen()) return;
  const code = e.code;
  if (!SB_KEYS[code]) return;
  e.stopPropagation();                      // keep the background dino from stealing Space/arrows
  if (e.cancelable && typeof e.preventDefault === "function") e.preventDefault();
  if (sbKeys[code]) return;
  sbKeys[code] = true;
  if (code === "KeyP" || code === "Escape") sbTogglePause();
  else if (code === "KeyR") sbRestart();
  else if (code === "Space" && sbMode !== "playing") sbPrimaryAction();
}

function sbOnKeyUp(e) {
  if (SB_KEYS[e.code]) sbKeys[e.code] = false;
}

function sbCanvasPoint(e) {
  if (!SB_CANVAS || !SB_CANVAS.getBoundingClientRect) return null;
  const rect = SB_CANVAS.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return null;
  return {
    x: sbClamp(((e.clientX - rect.left) / rect.width) * SB_VIEW_W, 0, SB_VIEW_W),
    y: sbClamp(((e.clientY - rect.top) / rect.height) * SB_VIEW_H, 0, SB_VIEW_H),
  };
}

function sbOnPointerMove(e) {
  if (!sbPanelOpen()) return;
  const p = sbCanvasPoint(e);
  if (!p) return;
  sbInput.aimX = p.x;
  sbInput.aimY = p.y;
}

function sbOnPointerDown(e) {
  if (!sbPanelOpen()) return;
  if (e.button !== undefined && e.button !== 0) return;
  sbMouseDown = true;
  const p = sbCanvasPoint(e);
  if (p) { sbInput.aimX = p.x; sbInput.aimY = p.y; }
  if (SB_CANVAS && SB_CANVAS.setPointerCapture && e.pointerId !== undefined) {
    try { SB_CANVAS.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
  }
}

function sbOnPointerUp() { sbMouseDown = false; }

function sbIsDesktop() {
  try {
    if (typeof window.matchMedia === "function") {
      if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) return true;
      if (window.matchMedia("(hover: none), (pointer: coarse)").matches) return false;
    }
  } catch (err) { /* matchMedia is optional */ }
  return (navigator.maxTouchPoints || 0) < 2;
}

/* ── Lifecycle ───────────────────────────────────────────── */

function sbResize() {
  if (!SB_CANVAS) return;
  const rect = SB_CANVAS.getBoundingClientRect ? SB_CANVAS.getBoundingClientRect() : null;
  const cssW = rect && rect.width ? rect.width : SB_VIEW_W;
  const cssH = rect && rect.height ? rect.height : (cssW * SB_VIEW_H) / SB_VIEW_W;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (SB_CANVAS.width !== bw) SB_CANVAS.width = bw;
  if (SB_CANVAS.height !== bh) SB_CANVAS.height = bh;
  sbScaleX = bw / SB_VIEW_W;
  sbScaleY = bh / SB_VIEW_H;
}

function sbStartLoop() {
  if (sbRaf || typeof requestAnimationFrame !== "function") return;
  sbLastTs = 0;
  sbAccum = 0;
  sbRaf = requestAnimationFrame(sbFrame);
}

function sbStopLoop() {
  if (sbRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(sbRaf);
  sbRaf = 0;
}

function sbFrame(ts) {
  sbRaf = 0;
  if (!sbPanelOpen() || sbMode !== "playing") return;
  const t = typeof ts === "number" ? ts : Date.now();
  if (!sbLastTs) sbLastTs = t;
  let dt = (t - sbLastTs) / 1000;
  sbLastTs = t;
  if (!(dt > 0)) dt = 0;                    // guards NaN / clock jumps
  if (dt > SB_MAX_FRAME) dt = SB_MAX_FRAME;
  sbAccum += dt;

  let steps = 0;
  while (sbAccum >= SB_STEP && steps < 8) {
    sbStep(sbState, sbReadInput(), SB_STEP);
    sbAccum -= SB_STEP;
    steps += 1;
  }
  if (steps >= 8) sbAccum = 0;              // never spiral after a long stall

  sbSetHud();
  if (sbState.won) sbFinish("won");
  else if (sbState.over) sbFinish("lost");
  sbRender();
  if (sbMode === "playing") sbRaf = requestAnimationFrame(sbFrame);
}

function sbFinish(mode) {
  sbStopLoop();
  sbMouseDown = false;
  sbInput.firing = false;
  sbClearKeys();
  sbSetHud();
  sbSetMode(mode);
  sbRender();
}

function sbNewGame() {
  sbSrand((typeof window !== "undefined" && window.SB_TEST_SEED) || (Date.now() & 0x7fffffff));
  sbState = sbBuildState();
  sbStartWave(sbState);
  sbClearKeys();
  sbMouseDown = false;
  sbInput.firing = false;
  sbInput.throttle = 0;
  sbInput.turn = 0;
  sbSetMode("ready");
  sbSetHud();
}

function sbResume() {
  if (sbMode !== "paused" && sbMode !== "ready") return;
  sbSetMode("playing");
  sbStartLoop();
  sbRender();
}

function sbTogglePause() {
  if (sbMode === "playing") {
    sbStopLoop();
    sbSetMode("paused");
    sbRender();
  } else if (sbMode === "paused") {
    sbResume();
  }
}

function sbRestart() {
  sbStopLoop();
  sbNewGame();
  sbRender();
}

function sbPrimaryAction() {
  if (sbMode === "ready" || sbMode === "paused") sbResume();
  else if (sbMode === "won" || sbMode === "lost") sbRestart();
}

function sbOnVisibility() {
  if (document.hidden && sbMode === "playing") {
    sbStopLoop();
    sbSetMode("paused");
  }
}

function sbOnBlur() {
  if (sbMode === "playing") {
    sbStopLoop();
    sbSetMode("paused");
  }
}

function sbBind() {
  if (sbBound) return;
  sbBound = true;
  window.addEventListener("keydown", sbOnKeyDown, true);
  window.addEventListener("keyup", sbOnKeyUp, true);
  window.addEventListener("pointerup", sbOnPointerUp);
  window.addEventListener("blur", sbOnBlur);
  document.addEventListener("visibilitychange", sbOnVisibility);
  if (SB_CANVAS) {
    SB_CANVAS.addEventListener("pointermove", sbOnPointerMove);
    SB_CANVAS.addEventListener("pointerdown", sbOnPointerDown);
  }
  if (SB_OVERLAY_BTN) SB_OVERLAY_BTN.addEventListener("click", sbPrimaryAction);
}

function sbUnbind() {
  if (!sbBound) return;
  sbBound = false;
  window.removeEventListener("keydown", sbOnKeyDown, true);
  window.removeEventListener("keyup", sbOnKeyUp, true);
  window.removeEventListener("pointerup", sbOnPointerUp);
  window.removeEventListener("blur", sbOnBlur);
  document.removeEventListener("visibilitychange", sbOnVisibility);
  if (SB_CANVAS) {
    SB_CANVAS.removeEventListener("pointermove", sbOnPointerMove);
    SB_CANVAS.removeEventListener("pointerdown", sbOnPointerDown);
  }
  if (SB_OVERLAY_BTN) SB_OVERLAY_BTN.removeEventListener("click", sbPrimaryAction);
}

/* games.js entry point — called every time the Game panel opens. */
function sbInit() {
  if (!SB_PANEL) return;
  if (!sbIsDesktop()) {
    sbStopLoop();
    sbSetMode("mobile");
    if (SB_CANVAS) SB_CANVAS.hidden = true;
    if (SB_HUD) SB_HUD.hidden = true;
    if (SB_NOTICE) SB_NOTICE.hidden = false;
    return;
  }
  if (SB_CANVAS) SB_CANVAS.hidden = false;
  if (SB_HUD) SB_HUD.hidden = false;
  if (SB_NOTICE) SB_NOTICE.hidden = true;
  if (!sbCtx && SB_CANVAS && SB_CANVAS.getContext) sbCtx = SB_CANVAS.getContext("2d");
  if (!sbState) sbNewGame();
  else if (!sbState.won && !sbState.over && sbMode === "playing") sbSetMode("paused");
  sbBind();
  sbResize();
  sbSetHud();
  sbRender();
}

/* games.js teardown — no rAF, no listeners, no frozen clock. */
function sbStop() {
  sbStopLoop();
  sbUnbind();
  sbClearKeys();
  sbMouseDown = false;
  sbInput.firing = false;
  if (sbMode === "playing") sbSetMode("paused");
}

/* Public API for the Game section shell: openGame() calls init(), closeGame()
 * / stopGame() call stop(), so a hidden panel never keeps a rAF loop alive. */
window.SeaBattle = { init: sbInit, stop: sbStop };
/*
 * Headless test hooks (harmless in the browser): the Node harness drives
 * sbStep() directly and reads the state instead of scraping pixels, which is
 * how the shell / hit / wave / sink rules get verified without a real canvas.
 * Set window.SB_TEST_SEED before init() to make a run reproducible.
 */
window.SeaBattle._debug = {
  step: sbStep,
  render: sbRender,
  kinds: SB_KIND,
  waves: SB_WAVES,
  get state() { return sbState; },
};
