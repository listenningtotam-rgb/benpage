// ─── Canvas Setup ────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// ─── Responsive sizing ───────────────────────────────────
const LOGICAL_W = 800;
const LOGICAL_H = 450;

let scaleX = 1;
let scaleY = 1;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  scaleX = canvas.width / LOGICAL_W;
  scaleY = canvas.height / LOGICAL_H;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ─── Constants (in logical coordinates) ──────────────────
const GROUND_Y = LOGICAL_H - 60;
const GRAVITY = 0.6;
const JUMP_VEL = -11;
const INITIAL_SPEED = 4;
const MAX_SPEED = 12;
const SPEED_INCR = 0.0008;

// ─── Game State ──────────────────────────────────────────
const state = {
  speed: INITIAL_SPEED,
  score: 0,
  started: false,
  nightMode: true,   // start in dark mode by default
  frame: 0,
};

// ─── Dino ────────────────────────────────────────────────
const dino = {
  x: 60,
  y: GROUND_Y,
  w: 36,
  h: 44,
  vy: 0,
  jumping: false,
  ducking: false,
};

function resetDino() {
  dino.y = GROUND_Y;
  dino.vy = 0;
  dino.jumping = false;
  dino.ducking = false;
}

// ─── Obstacles ───────────────────────────────────────────
let obstacles = [];

function spawnObstacle() {
  const r = Math.random();
  let type, w, h;

  if (r < 0.55) {
    type = 'cactus-small';
    w = 16; h = 32;
  } else if (r < 0.85) {
    type = 'cactus-large';
    w = 24; h = 44;
  } else if (state.score > 200) {
    type = Math.random() < 0.5 ? 'ptero-low' : 'ptero-high';
    w = 36; h = 28;
  } else {
    type = 'cactus-small';
    w = 16; h = 32;
  }

  let y = GROUND_Y - h;
  if (type === 'ptero-high') y = GROUND_Y - h - 50;
  if (type === 'ptero-low')  y = GROUND_Y - h - 20;

  obstacles.push({ x: LOGICAL_W + 20, y, w, h, type, passed: false });
}

// ─── Clouds ──────────────────────────────────────────────
let clouds = [];

function spawnCloud() {
  clouds.push({
    x: LOGICAL_W + 20,
    y: 30 + Math.random() * 80,
    w: 50 + Math.random() * 30,
    speed: 0.8 + Math.random() * 0.5,
  });
}

// ─── Stars (night mode) ─────────────────────────────────
let stars = [];
function generateStars() {
  stars = [];
  for (let i = 0; i < 60; i++) {
    stars.push({
      x: Math.random() * LOGICAL_W,
      y: Math.random() * (LOGICAL_H - 100),
      r: 0.5 + Math.random() * 1.5,
      a: 0.3 + Math.random() * 0.7,
    });
  }
}
generateStars();

// ─── Ground ──────────────────────────────────────────────
let groundOffset = 0;

// ─── Auto-start after 1.5s so the background is lively ──
let autoStartTimer = setTimeout(() => {
  state.started = true;
}, 1500);

// ─── Controls ───────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault();
    if (!state.started) { state.started = true; clearTimeout(autoStartTimer); }
    jump();
  }
  if (e.code === 'ArrowDown') {
    e.preventDefault();
    dino.ducking = true;
    if (dino.jumping) {
      dino.vy = Math.max(dino.vy, 8);
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowDown') {
    dino.ducking = false;
  }
});

canvas.addEventListener('click', () => {
  if (!state.started) { state.started = true; clearTimeout(autoStartTimer); }
  jump();
});

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (!state.started) { state.started = true; clearTimeout(autoStartTimer); }
  jump();
});

// ─── Jump Logic ──────────────────────────────────────────
function jump() {
  if (dino.jumping) return;
  dino.vy = JUMP_VEL;
  dino.jumping = true;
}

// ─── Collision (no game over, just reset if hit) ─────────
function rectCollide(a, b) {
  const shrink = 4;
  return (
    a.x + shrink < b.x + b.w - shrink &&
    a.x + a.w - shrink > b.x + shrink &&
    a.y + shrink < b.y + b.h - shrink &&
    a.y + a.h - shrink > b.y + shrink
  );
}

// ─── Restart (soft reset) ───────────────────────────────
function softReset() {
  state.speed = INITIAL_SPEED;
  state.score = 0;
  state.frame = 0;
  obstacles = [];
  clouds = [];
  groundOffset = 0;
  resetDino();
}

// ─── Draw Functions ──────────────────────────────────────

function drawBackground() {
  // Always dark background for better contrast with overlay text
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  for (const s of stars) {
    ctx.globalAlpha = s.a * 0.6;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, GROUND_Y, LOGICAL_W, LOGICAL_H - GROUND_Y);
}

function drawGround() {
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(LOGICAL_W, GROUND_Y);
  ctx.stroke();

  for (let x = -groundOffset; x < LOGICAL_W; x += 35) {
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(x, GROUND_Y + 6, 20, 2);
  }
}

function drawClouds() {
  for (const c of clouds) {
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, c.w * 0.5, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(c.x - c.w * 0.25, c.y + 4, c.w * 0.35, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(c.x + c.w * 0.25, c.y + 4, c.w * 0.35, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawDino() {
  const dx = dino.x;
  const dy = dino.y - dino.h;

  ctx.fillStyle = '#ccc';

  if (dino.ducking && !dino.jumping) {
    ctx.fillRect(dx + 4, dy + 10, 24, 14);
    ctx.fillRect(dx + 20, dy + 4, 14, 16);
    ctx.fillStyle = '#fff';
    ctx.fillRect(dx + 28, dy + 6, 4, 4);
    ctx.fillStyle = '#ccc';
    ctx.fillRect(dx - 4, dy + 14, 8, 6);
    if (state.started) {
      ctx.fillRect(dx + 6, dy + 24, 6, 8);
      ctx.fillRect(dx + 18, dy + 24, 6, 8);
    }
  } else {
    ctx.fillRect(dx + 4, dy + 6, 20, 28);
    ctx.fillRect(dx + 16, dy, 18, 22);
    ctx.fillStyle = '#fff';
    ctx.fillRect(dx + 26, dy + 4, 6, 6);
    ctx.fillStyle = '#ccc';
    ctx.fillRect(dx + 30, dy + 14, 4, 3);
    ctx.fillRect(dx - 6, dy + 18, 10, 8);
    ctx.fillRect(dx + 10, dy + 20, 4, 10);
    if (!dino.jumping) {
      const legOffset = Math.sin(state.frame * 0.3) * 3;
      ctx.fillRect(dx + 8, dy + 34, 6, 10 + legOffset);
      ctx.fillRect(dx + 18, dy + 34, 6, 10 - legOffset);
    } else {
      ctx.fillRect(dx + 8, dy + 34, 6, 10);
      ctx.fillRect(dx + 18, dy + 34, 6, 10);
    }
  }
}

function drawObstacles() {
  for (const o of obstacles) {
    ctx.fillStyle = '#888';

    if (o.type === 'cactus-small') {
      ctx.fillRect(o.x + 4, o.y, 8, o.h);
      ctx.fillRect(o.x, o.y + 6, 16, 6);
      ctx.fillRect(o.x + 2, o.y - 6, 6, 8);
      ctx.fillRect(o.x + 8, o.y - 4, 6, 6);
    } else if (o.type === 'cactus-large') {
      ctx.fillRect(o.x + 6, o.y, 12, o.h);
      ctx.fillRect(o.x, o.y + 10, 24, 8);
      ctx.fillRect(o.x + 2, o.y - 8, 8, 12);
      ctx.fillRect(o.x + 14, o.y - 4, 8, 8);
      ctx.fillRect(o.x - 4, o.y + 16, 8, 6);
    } else {
      const flap = Math.sin(state.frame * 0.2) > 0;
      ctx.fillRect(o.x + 8, o.y + 6, 20, 16);
      ctx.fillRect(o.x + 22, o.y + 10, 12, 6);
      if (flap) {
        ctx.fillRect(o.x + 10, o.y - 4, 16, 10);
      } else {
        ctx.fillRect(o.x + 10, o.y + 22, 16, 8);
      }
      ctx.fillStyle = '#fff';
      ctx.fillRect(o.x + 14, o.y + 8, 4, 4);
      ctx.fillStyle = '#888';
    }
  }
}

// ─── Update ──────────────────────────────────────────────
function update() {
  if (!state.started) return;

  state.frame++;
  state.score += state.speed * 0.05;
  state.speed = Math.min(MAX_SPEED, state.speed + SPEED_INCR);

  // Ground scroll
  groundOffset = (groundOffset + state.speed) % 35;

  // Dino physics
  if (dino.jumping) {
    dino.vy += GRAVITY;
    dino.y += dino.vy;
    if (dino.y >= GROUND_Y) {
      dino.y = GROUND_Y;
      dino.vy = 0;
      dino.jumping = false;
    }
  }

  // Clouds
  if (state.frame % 180 === 0 && clouds.length < 4) {
    spawnCloud();
  }
  for (let i = clouds.length - 1; i >= 0; i--) {
    clouds[i].x -= clouds[i].speed;
    if (clouds[i].x < -80) clouds.splice(i, 1);
  }

  // Spawn obstacles
  const minGap = Math.max(60, 180 - state.speed * 6);
  if (obstacles.length === 0 || LOGICAL_W - obstacles[obstacles.length - 1].x > minGap) {
    if (Math.random() < 0.012 * state.speed) {
      spawnObstacle();
    }
  }

  // Move obstacles & check collision → soft reset
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.x -= state.speed;

    const dinoBox = {
      x: dino.x,
      y: dino.y - dino.h,
      w: dino.w,
      h: dino.h,
    };
    if (rectCollide(dinoBox, o)) {
      softReset();
      return;
    }

    if (o.x < -60) obstacles.splice(i, 1);
  }
}

// ─── Render ──────────────────────────────────────────────
function render() {
  ctx.save();
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

  drawBackground();
  drawClouds();
  drawGround();
  drawObstacles();
  drawDino();

  ctx.restore();
}

// ─── Game Loop ───────────────────────────────────────────
function gameLoop() {
  update();
  render();
  requestAnimationFrame(gameLoop);
}

gameLoop();