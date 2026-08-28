/* ── Apps Section ───────────────────────────────────────── */

// ─── DOM helpers ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Gallery open / close ─────────────────────────────────
const gallery = $("apps-gallery");
const detail = $("app-detail");
const panels = { calendar: $("app-calendar"), fx: $("app-fx"), rechub: $("app-rechub"), vinyl: $("app-vinyl") };

document.querySelectorAll(".app-open").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    // Buttons that reuse .app-open purely for styling (e.g. in-app actions)
    // carry no data-target — leave them to their own handlers.
    if (!target) return;
    gallery.hidden = true;
    detail.hidden = false;
    Object.entries(panels).forEach(([k, el]) => { el.hidden = k !== target; });

    if (target === "calendar") initCalendar();
    if (target === "fx") initFx();
    if (target === "vinyl") window.VinylArchive && window.VinylArchive.init();
  });
});

$("app-detail-close").addEventListener("click", () => {
  detail.hidden = true;
  gallery.hidden = false;
  if (window.VinylArchive) window.VinylArchive.stop();
});

/* ── App 1: FX Holiday Calendar ─────────────────────────── */
const CURRENCY_NAMES = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", JPY: "Japanese Yen",
  CNY: "Chinese Yuan", AUD: "Australian Dollar", CAD: "Canadian Dollar",
  CHF: "Swiss Franc", HKD: "Hong Kong Dollar", KRW: "South Korean Won",
  NZD: "New Zealand Dollar", SGD: "Singapore Dollar"
};

const calMonthLabel = $("cal-month-label");
const calGrid = $("cal-grid");
const calDetail = $("cal-detail");
const calDetailDate = $("cal-detail-date");
const calDetailCurrencies = $("cal-detail-currencies");
const thumbCalMonth = document.querySelector(".thumb-cal-month");
const thumbCalGrid = document.querySelector(".thumb-cal-grid");

let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

// ── Date helpers ─────────────────────────────────────────
function daysIn(y, m) { return new Date(y, m + 1, 0).getDate(); }

/* Anonymous Gregorian algorithm — Easter Sunday for year y */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

// ── Holiday rule builders ────────────────────────────────
// Each rule: (y, m) => day numbers (1-based) in month m where market is closed.
function fixedRule(m, d) { return (y, mm) => (mm === m ? [d] : []); }

function nthRule(m, weekday, n) {
  return (y, mm) => {
    if (mm !== m) return [];
    const first = new Date(y, m, 1);
    let day = 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7;
    return day <= daysIn(y, m) ? [day] : [];
  };
}

function lastRule(m, weekday) {
  return (y, mm) => {
    if (mm !== m) return [];
    const dim = daysIn(y, m);
    const last = new Date(y, m, dim);
    return [dim - ((last.getDay() - weekday + 7) % 7)];
  };
}

function easterRule(offset) {
  return (y, mm) => {
    const e = easter(y);
    e.setDate(e.getDate() + offset);
    return e.getMonth() === mm ? [e.getDate()] : [];
  };
}

function fixedListRule(list) { // list of "MM-DD" strings
  return (y, mm) => {
    const out = [];
    list.forEach((s) => {
      const [m, d] = s.split("-").map(Number);
      if (m - 1 === mm) out.push(d);
    });
    return out;
  };
}

function lunarRule(table) { // {year: ["MM-DD", ...]} — Gregorian dates of lunar holidays
  return (y, mm) =>
    (table[y] || []).filter((s) => Number(s.slice(0, 2)) - 1 === mm).map((s) => Number(s.slice(3)));
}

// ── Lunar / national holiday tables (approximate public days) ──
const CN_DATES = {
  2024: ["01-01","02-09","02-10","02-11","02-12","02-13","02-14","02-15","02-16","02-17","04-04","05-01","06-10","09-17","10-01","10-02","10-03"],
  2025: ["01-01","01-28","01-29","01-30","01-31","02-01","02-02","02-03","02-04","04-04","05-01","05-05","06-02","10-01","10-02","10-03","10-06"],
  2026: ["01-01","02-16","02-17","02-18","02-19","02-20","02-21","02-22","04-05","05-01","06-19","09-25","10-01","10-02","10-03"],
  2027: ["01-01","02-06","02-07","02-08","02-09","02-10","02-11","02-12","04-05","05-01","06-09","09-15","10-01","10-02","10-03","10-04"],
  2028: ["01-01","01-26","01-27","01-28","01-29","01-30","01-31","02-01","04-04","05-01","05-28","09-03","10-01","10-02","10-03"]
};

// Spring Festival (3 days) + Mid-Autumn for HK / SG / KR
const SHORT_LUNAR = {
  2024: ["02-10","02-11","02-12","09-17"],
  2025: ["01-29","01-30","01-31","10-06"],
  2026: ["02-17","02-18","02-19","09-25"],
  2027: ["02-06","02-07","02-08","09-15"],
  2028: ["01-26","01-27","01-28","10-03"]
};

const KR_LUNAR = {
  2024: ["02-10","02-11","02-12","09-16","09-17","09-18"],
  2025: ["01-29","01-30","01-31","10-05","10-06","10-07"],
  2026: ["02-17","02-18","02-19","09-24","09-25","09-26"],
  2027: ["02-06","02-07","02-08","09-14","09-15","09-16"],
  2028: ["01-26","01-27","01-28","10-02","10-03","10-04"]
};

// ── Per-currency market holidays ─────────────────────────
const FX_RULES = {
  USD: [
    fixedRule(0, 1),          // New Year's Day
    nthRule(0, 1, 3),         // Martin Luther King Jr. Day (3rd Mon)
    easterRule(-2),           // Good Friday
    lastRule(4, 1),           // Memorial Day (last Mon May)
    fixedRule(5, 19),         // Juneteenth
    fixedRule(6, 4),          // Independence Day
    nthRule(8, 1, 1),         // Labor Day (1st Mon Sep)
    lastRule(10, 4),          // Thanksgiving (4th Thu Nov)
    fixedRule(11, 25)         // Christmas
  ],
  EUR: [
    fixedRule(0, 1),          // New Year's Day
    easterRule(-2),           // Good Friday
    easterRule(1),            // Easter Monday
    fixedRule(4, 1),          // Labour Day
    fixedRule(4, 8),          // Victory in Europe Day
    easterRule(39),           // Ascension Day
    easterRule(50),           // Whit Monday
    fixedRule(11, 25),        // Christmas
    fixedRule(11, 26)         // Boxing Day
  ],
  GBP: [
    fixedRule(0, 1),          // New Year's Day
    easterRule(-2),           // Good Friday
    easterRule(1),            // Easter Monday
    nthRule(4, 1, 1),         // Early May Bank Holiday
    lastRule(4, 1),           // Spring Bank Holiday
    lastRule(7, 1),           // Summer Bank Holiday
    fixedRule(11, 25),        // Christmas
    fixedRule(11, 26)         // Boxing Day
  ],
  JPY: [
    fixedRule(0, 1),          // New Year's Day
    fixedRule(0, 2),          // Bank holiday (Jan 2)
    nthRule(0, 1, 2),         // Coming of Age Day
    fixedRule(1, 11),         // National Foundation Day
    fixedRule(1, 23),         // Emperor's Birthday
    fixedRule(2, 20),         // Vernal Equinox (approx)
    fixedRule(3, 29),         // Showa Day
    fixedRule(4, 3),          // Constitution Memorial Day
    fixedRule(4, 4),          // Greenery Day
    fixedRule(4, 5),          // Children's Day
    nthRule(6, 1, 3),         // Marine Day (3rd Mon Jul)
    fixedRule(7, 11),         // Mountain Day
    nthRule(8, 1, 3),         // Respect for the Aged Day (3rd Mon Sep)
    fixedRule(8, 22),         // Autumnal Equinox (approx)
    nthRule(9, 1, 2),         // Sports Day (2nd Mon Oct)
    fixedRule(9, 3),          // Culture Day
    fixedRule(9, 23)          // Labour Thanksgiving Day
  ],
  CNY: [
    fixedRule(0, 1),          // New Year's Day
    fixedRule(4, 1),          // Labour Day
    fixedRule(9, 1),          // National Day
    lunarRule(CN_DATES)       // Spring Festival, Qingming, Dragon Boat, Mid-Autumn
  ],
  AUD: [
    fixedRule(0, 1),          // New Year's Day
    fixedRule(0, 26),         // Australia Day
    easterRule(-2),           // Good Friday
    easterRule(1),            // Easter Monday
    fixedRule(3, 25),         // Anzac Day
    nthRule(5, 1, 2),         // King's Birthday (2nd Mon Jun)
    fixedRule(11, 25),        // Christmas
    fixedRule(11, 26)         // Boxing Day
  ],
  CAD: [
    fixedRule(0, 1),          // New Year's Day
    easterRule(-2),           // Good Friday
    lastRule(4, 1),           // Victoria Day (last Mon May)
    fixedRule(6, 1),          // Canada Day
    nthRule(8, 1, 1),         // Labour Day (1st Mon Sep)
    nthRule(9, 1, 2),         // Thanksgiving (2nd Mon Oct)
    fixedRule(10, 11),        // Remembrance Day
    fixedRule(11, 25),        // Christmas
    fixedRule(11, 26)         // Boxing Day
  ],
  CHF: [
    fixedRule(0, 1),          // New Year's Day
    easterRule(-2),           // Good Friday
    easterRule(1),            // Easter Monday
    fixedRule(4, 1),          // Labour Day
    easterRule(39),           // Ascension Day
    easterRule(50),           // Whit Monday
    fixedRule(7, 1),          // Swiss National Day
    fixedRule(11, 25),        // Christmas
    fixedRule(11, 26)         // Boxing Day
  ],
  HKD: [
    fixedRule(0, 1),          // New Year's Day
    easterRule(-2),           // Good Friday
    easterRule(1),            // Easter Monday
    fixedRule(3, 5),          // Ching Ming Festival (approx)
    fixedRule(4, 1),          // Labour Day
    fixedRule(9, 1),          // National Day
    fixedRule(11, 25),        // Christmas
    fixedRule(11, 26),        // Boxing Day
    lunarRule(SHORT_LUNAR)    // Spring Festival + Mid-Autumn
  ],
  KRW: [
    fixedRule(0, 1),          // New Year's Day
    fixedRule(2, 1),          // Independence Movement Day
    fixedRule(4, 5),          // Children's Day
    fixedRule(5, 6),          // Memorial Day
    fixedRule(7, 15),         // Liberation Day
    fixedRule(9, 3),          // National Foundation Day
    fixedRule(9, 9),          // Hangeul Day
    fixedRule(11, 25),        // Christmas
    lunarRule(KR_LUNAR)       // Seollal + Chuseok
  ],
  NZD: [
    fixedRule(0, 1),          // New Year's Day
    fixedRule(0, 2),          // Day after New Year
    fixedRule(1, 6),          // Waitangi Day
    easterRule(-2),           // Good Friday
    easterRule(1),            // Easter Monday
    fixedRule(3, 25),         // Anzac Day
    nthRule(5, 1, 1),         // King's Birthday (1st Mon Jun)
    lastRule(9, 1),           // Labour Day (4th Mon Oct)
    fixedRule(11, 25),        // Christmas
    fixedRule(11, 26)         // Boxing Day
  ],
  SGD: [
    fixedRule(0, 1),          // New Year's Day
    easterRule(-2),           // Good Friday
    fixedRule(4, 1),          // Labour Day
    fixedRule(7, 9),          // National Day
    fixedRule(11, 25),        // Christmas
    lunarRule(SHORT_LUNAR)    // Spring Festival + Mid-Autumn
  ]
};

/* Return array of currency codes NOT trading on the given date. */
function holidayCurrencies(date) {
  const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
  const closed = [];
  Object.entries(FX_RULES).forEach(([code, rules]) => {
    const hit = rules.some((rule) => rule(y, m).includes(d));
    if (hit) closed.push(code);
  });
  return closed;
}

/* Render one month grid into #cal-grid */
function renderCalendar() {
  const y = calYear, m = calMonth;
  calMonthLabel.textContent = new Date(y, m, 1).toLocaleDateString("en-US", { year: "numeric", month: "long" });

  const firstDay = new Date(y, m, 1).getDay();
  const dim = daysIn(y, m);
  const today = new Date();
  const tY = today.getFullYear(), tM = today.getMonth(), tD = today.getDate();

  let html = "";
  for (let i = 0; i < firstDay; i++) html += `<div class="cal-cell cal-blank"></div>`;
  for (let d = 1; d <= dim; d++) {
    const closed = holidayCurrencies(new Date(y, m, d));
    const isToday = y === tY && m === tM && d === tD;
    const cls = ["cal-cell", closed.length ? "cal-holiday" : "cal-open"];
    if (isToday) cls.push("cal-today");
    html += `<button type="button" class="${cls.join(" ")}" data-day="${d}">${d}</button>`;
  }
  calGrid.innerHTML = html;

  // hide detail if it's for another month
  if (!calDetail.hidden) {
    const sel = calGrid.querySelector(".cal-cell.selected");
    if (!sel) calDetail.hidden = true;
  }
}

function renderThumb() {
  const now = new Date();
  thumbCalMonth.textContent = now.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  const dots = [];
  const dim = daysIn(now.getFullYear(), now.getMonth());
  for (let d = 1; d <= dim; d += 5) {
    const closed = holidayCurrencies(new Date(now.getFullYear(), now.getMonth(), d));
    dots.push(`<span class="${closed.length ? "dot-red" : "dot-green"}"></span>`);
  }
  thumbCalGrid.innerHTML = dots.join("");
}

function initCalendar() {
  calYear = new Date().getFullYear();
  calMonth = new Date().getMonth();
  calDetail.hidden = true;
  renderCalendar();
  renderThumb();
}

$("cal-prev").addEventListener("click", () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});
$("cal-next").addEventListener("click", () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});
$("cal-today").addEventListener("click", () => {
  calYear = new Date().getFullYear();
  calMonth = new Date().getMonth();
  renderCalendar();
});

calGrid.addEventListener("click", (e) => {
  const cell = e.target.closest(".cal-cell[data-day]");
  if (!cell) return;
  const d = Number(cell.dataset.day);
  const date = new Date(calYear, calMonth, d);
  const closed = holidayCurrencies(date);

  calGrid.querySelectorAll(".cal-cell.selected").forEach((el) => el.classList.remove("selected"));
  cell.classList.add("selected");

  if (!closed.length) {
    calDetail.hidden = true;
    return;
  }

  calDetailDate.textContent = date.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });

  // Any long-running holiday block? Just list currencies.
  const chips = closed.map((code) =>
    `<span class="cal-chip"><strong>${code}</strong>${CURRENCY_NAMES[code] ? " · " + CURRENCY_NAMES[code] : ""}</span>`
  ).join("");
  calDetailCurrencies.innerHTML = chips;
  calDetail.hidden = false;
});

/* ── App 2: FX Market Watch ─────────────────────────────── */
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

// ─── Boot: animate FX holiday thumbnail on page load ─────
renderThumb();