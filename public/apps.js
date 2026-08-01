/* ── Apps Section ───────────────────────────────────────── */

// ─── City / Timezone Database ─────────────────────────────
const ZONES = [
  { tz: "Asia/Shanghai",      label: "Shanghai · Beijing" },
  { tz: "Asia/Tokyo",         label: "Tokyo" },
  { tz: "Asia/Singapore",     label: "Singapore" },
  { tz: "Asia/Hong_Kong",     label: "Hong Kong" },
  { tz: "Asia/Seoul",         label: "Seoul" },
  { tz: "Asia/Dubai",         label: "Dubai" },
  { tz: "Asia/Kolkata",       label: "Mumbai" },
  { tz: "Europe/London",      label: "London" },
  { tz: "Europe/Paris",       label: "Paris · Frankfurt" },
  { tz: "Europe/Moscow",      label: "Moscow" },
  { tz: "America/New_York",   label: "New York" },
  { tz: "America/Chicago",    label: "Chicago" },
  { tz: "America/Los_Angeles",label: "Los Angeles" },
  { tz: "America/Sao_Paulo",  label: "São Paulo" },
  { tz: "Australia/Sydney",   label: "Sydney" },
  { tz: "Pacific/Auckland",   label: "Auckland" },
  { tz: "UTC",                label: "UTC · London" }
];

// ─── DOM helpers ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function pad(n) { return String(n).padStart(2, "0"); }

function fmtShort(dt) {
  return dt.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtOffset(tzName) {
  const d = new Date();
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tzName, timeZoneName: "shortOffset" });
  const parts = dtf.formatToParts(d);
  const off = parts.find((p) => p.type === "timeZoneName");
  return off ? (off.value || "UTC") : "UTC";
}

// ─── Gallery open / close ─────────────────────────────────
const gallery = $("apps-gallery");
const detail = $("app-detail");
const panels = { worldtime: $("app-worldtime"), fx: $("app-fx") };

document.querySelectorAll(".app-open").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    gallery.hidden = true;
    detail.hidden = false;
    Object.entries(panels).forEach(([k, el]) => { el.hidden = k !== target; });

    if (target === "worldtime") initWorldtime();
    if (target === "fx") initFx();
  });
});

$("app-detail-close").addEventListener("click", () => {
  detail.hidden = true;
  gallery.hidden = false;
});

// ─── App 1: Global Time ───────────────────────────────────
const wtCity = $("wt-city"), wtTime = $("wt-time"), wtDate = $("wt-date"), wtOffset = $("wt-offset");
const wtFrom = $("wt-from"), wtTo = $("wt-to"), wtResult = $("wt-result");
const thumbWorld = $("thumb-worldtime");
const thumbTimeEl = thumbWorld.querySelector(".thumb-clock-time");
const thumbTzEl = thumbWorld.querySelector(".thumb-clock-tz");

let wtZone = "Asia/Shanghai";
let wtTimer = null;

function fillSelect(sel, selected) {
  sel.innerHTML = "";
  ZONES.forEach((z) => {
    const opt = document.createElement("option");
    opt.value = z.tz;
    opt.textContent = z.label;
    if (z.tz === selected) opt.selected = true;
    sel.appendChild(opt);
  });
}

function updateClock() {
  const now = new Date();
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: wtZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(now);
  const d = new Intl.DateTimeFormat("en-US", {
    timeZone: wtZone, weekday: "long", year: "numeric", month: "long", day: "numeric"
  }).format(now);

  wtTime.textContent = t;
  wtDate.textContent = d;
  wtCity.textContent = ZONES.find((z) => z.tz === wtZone)?.label || wtZone;
  wtOffset.textContent = fmtOffset(wtZone);

  thumbTimeEl.textContent = t;
  thumbTzEl.textContent = fmtOffset(wtZone);

  convert();
}

function fmtShortWithZone(tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric"
  }).format(new Date());
}

function convert() {
  const from = wtFrom.value, to = wtTo.value;
  if (!from || !to) return;
  const now = new Date();

  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: from, hour: "2-digit", minute: "2-digit", hour12: false
  }).format(now);
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: to, hour: "2-digit", minute: "2-digit", hour12: false
  }).format(now);

  const fd = fmtShortWithZone(from);
  const td = fmtShortWithZone(to);

  const fl = ZONES.find((z) => z.tz === from)?.label || from;
  const tl = ZONES.find((z) => z.tz === to)?.label || to;

  const sameDay = fd === td;

  wtResult.innerHTML =
    `<div><strong>${fl}</strong> — ${fd}<br>${f}</div>` +
    `<div class="wt-gap">${sameDay ? "Same date" : "Different date"}</div>` +
    `<div><strong>${tl}</strong> — ${td}<br>${t}</div>`;
}

function initWorldtime() {
  wtZone = "Asia/Shanghai";
  fillSelect(wtFrom, "Asia/Shanghai");
  fillSelect(wtTo, "America/New_York");

  [wtFrom, wtTo].forEach((sel) => sel.addEventListener("change", convert));

  clearInterval(wtTimer);
  updateClock();
  wtTimer = setInterval(updateClock, 1000);
  setInterval(() => { thumbTimeEl.textContent = new Intl.DateTimeFormat("en-US", { timeZone: wtZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); }, 1000);
}

// ─── App 2: FX Market Watch ───────────────────────────────
const FX_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CNY", "AUD", "CAD", "CHF", "HKD", "KRW", "NZD", "SGD", "INR", "MXN", "THB", "MYR", "VND"];

const FX_SNAPSHOT = {
  USD: 1, EUR: 0.92, GBP: 0.79, JPY: 155.5, CNY: 7.24, AUD: 1.52,
  CAD: 1.37, CHF: 0.88, HKD: 7.8, KRW: 1380, NZD: 1.66, SGD: 1.35, INR: 83.5, MXN: 18.5,
  THB: 35.6, MYR: 4.45, VND: 25450
};

const fxBase = $("fx-base"), fxBody = $("fx-body"), fxStatus = $("fx-status");
const thumbFxPrice = $("thumb-fx").querySelector(".thumb-fx-price");

let fxRates = null;
let fxMode = "loading";
let fxTimer = null;

function fracDigits(pair) {
  if (pair.endsWith("JPY") || pair.endsWith("KRW") || pair.endsWith("THB")) return 2;
  if (pair.endsWith("VND")) return 0;
  return 4;
}

function renderFx() {
  if (!fxRates) return;
  const base = fxBase.value;
  const baseRate = fxRates[base];
  if (!baseRate) return;

  const rows = [];
  FX_CURRENCIES.forEach((c) => {
    if (c === base) return;
    const quote = fxRates[c] || FX_SNAPSHOT[c];
    if (!quote) return;

    const mid = baseRate / quote; // base → quote
    const pair = base + "/" + c;
    const digits = fracDigits(pair);

    // Market-maker style spread: 1–2 pips for majors
    const pip = Math.pow(10, -digits);
    const spreadPips = pair === "EUR/USD" || pair === "GBP/USD" || pair === "USD/JPY" ? 1 : 2;
    const half = (spreadPips * pip) / 2;

    const bid = mid - half, ask = mid + half;

    // Trend: compare with previous close (snapshot) — small deterministic variation
    const prev = FX_SNAPSHOT[c] ? baseRate / FX_SNAPSHOT[c] : mid;
    const trend = mid > prev ? "▲" : mid < prev ? "▼" : "—";
    const trendClass = mid > prev ? "up" : mid < prev ? "down" : "flat";

    rows.push(
      `<tr>
        <td class="fx-pair">${pair}</td>
        <td class="fx-num">${bid.toFixed(digits)}</td>
        <td class="fx-num">${ask.toFixed(digits)}</td>
        <td class="fx-num">${spreadPips} pip</td>
        <td class="fx-trend ${trendClass}">${trend}</td>
      </tr>`
    );
  });

  fxBody.innerHTML = rows.join("");

  // Thumbnail: default EUR/USD
  if (fxRates.USD && fxRates.EUR) {
    const mid = fxRates.EUR / fxRates.USD || 0.92;
    const digits = 4, pip = 1e-4;
    thumbFxPrice.textContent = (mid - pip).toFixed(4) + " / " + (mid + pip).toFixed(4);
  }
}

async function fetchRates() {
  fxStatus.className = "fx-status loading";
  fxStatus.textContent = "● LOADING";

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data || !data.rates) throw new Error("bad payload");
    fxRates = data.rates;
    fxMode = "live";
    fxStatus.className = "fx-status live";
    fxStatus.textContent = "● LIVE";
  } catch (e) {
    fxRates = { ...FX_SNAPSHOT };
    fxMode = "snapshot";
    fxStatus.className = "fx-status offline";
    fxStatus.textContent = "● SNAPSHOT (offline)";
  }
  renderFx();
}

function initFx() {
  clearInterval(fxTimer);
  fetchRates();
  fxTimer = setInterval(fetchRates, 60000); // refresh each minute
  fxBase.addEventListener("change", renderFx);
}

// ─── Boot: animate world-time thumbnail on page load ──────
(function bootThumb() {
  setInterval(() => {
    thumbTimeEl.textContent = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date());
    thumbTzEl.textContent = fmtOffset("Asia/Shanghai");
  }, 1000);
})();