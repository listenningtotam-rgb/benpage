"use strict";

const outputEl = document.getElementById("terminal-output");
const startBtn = document.getElementById("dbg-start");
const clearBtn = document.getElementById("dbg-clear");
const eraSel = document.getElementById("dbg-era");

let streaming = false;
let stopRequested = false;
let sessionId = 0;

const MAX_LINES = 500;
const COMMITS_PER_FETCH = 20;

/* Only repos verified reachable via gitee.com/api/v5 (all probed HTTP 200) */
const REPOS = [
  "mirrors/numpy",
  "mirrors/pandas",
  "mirrors/requests",
  "baomidou/mybatis-plus",
  "mirrors/go",
  "mirrors/node",
  "mirrors/rust",
  "mirrors/redis",
];

/* ██ helpers ██ */
function el(className, text) {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  return div;
}
function line(className, text) {
  outputEl.appendChild(el("tl " + className, text));
  trimOutput();
  scrollBottom();
}
function trimOutput() {
  const n = outputEl.childElementCount;
  if (n > MAX_LINES) for (let i = 0; i < n - MAX_LINES; i++) outputEl.removeChild(outputEl.firstChild);
}
function scrollBottom() { outputEl.scrollTop = outputEl.scrollHeight; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const jitter = (b) => b + Math.random() * b * 0.6;

function abortIfStale(token, source) {
  if (token !== sessionId || stopRequested) {
    const e = new Error("session aborted");
    e.handle = "session-abort";
    throw e;
  }
  if (source) console.log("[debug live] " + source);
}

function withSession(run) {
  return new Promise((resolve, reject) => {
    const token = ++sessionId;
    (async () => {
      try {
        await run(token);
        resolve();
      } catch (err) {
        if (err && err.handle === "session-abort") resolve();
        else reject(err);
      }
    })();
  });
}

/* ██ API fetchers ██ */
async function fetchGiteeCommits(repo, since) {
  const url = "/api/gitee/repos/" + repo + "/commits?per_page=" +
    COMMITS_PER_FETCH + "&since=" + encodeURIComponent(since);
  const res = await fetch(url);
  if (!res.ok) throw new Error("gitee " + res.status + " " + repo);
  return res.json();
}
async function fetchGiteeRepo(repo) {
  const res = await fetch("/api/gitee/repos/" + repo);
  if (!res.ok) throw new Error("gitee repo " + res.status + " " + repo);
  return res.json();
}

/* ██ Gitee live feed (verified-repo pool, no flaky sources) ██ */
async function pickRepo() {
  const shuffled = REPOS.slice().sort(() => Math.random() - 0.5);
  let lastErr = null;
  for (const repo of shuffled) {
    try { return { repo, info: await fetchGiteeRepo(repo) }; }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error("no repo reachable");
}

function gitLogEntry(sha7, author, dateStr, msg) {
  const niceDate = (dateStr || "").replace("T", " ").replace(/Z$/, "");
  line("tl", "");
  line("tl cmd", "  commit " + sha7);
  line("tl meta", "  Author: " + author);
  line("tl meta", "  Date:   " + niceDate);
  line("tl msg", "");
  for (const m of msg.split("\n")) line("tl msg", "      " + m);
}

async function playGiteeFeed(token) {
  const since = eraSince(eraSel ? eraSel.value : "e2123");
  const { repo, info } = await pickRepo();

  line("tl info", "LIVE — gitee · " + (info.full_name || repo));
  line("tl meta", "  repo  " + (info.full_name || repo));
  line("tl meta", "  lang  " + (info.language || "Mixed") +
    " · since " + since.slice(0, 10));
  line("tl stat", "  ⭐ " + (info.stargazers_count || "―") +
    " · 🔀 " + (info.forks_count || "―") +
    " · 👁 " + (info.watchers_count || "―"));
  line("tl meta", "  " + "─".repeat(48));

  let cycle = 0;
  let lastFetch = new Date().toISOString();
  while (true) {
    abortIfStale(token, "gitee " + repo + " cycle " + cycle);

    let commits;
    try { commits = await fetchGiteeCommits(repo, lastFetch); }
    catch (err) {
      console.warn("[debug live] fetch failed:", err.message);
      line("tl dim", "  ∎ connection hiccup — retrying in 6s…");
      await sleep(6000);
      continue;
    }
    if (!Array.isArray(commits) || !commits.length) {
      line("tl dim", "  ∎ no new commits yet — watching…");
      await sleep(jitter(8000));
      cycle++;
      continue;
    }

    abortIfStale(token, "gitee commits " + commits.length);
    for (const c of commits.slice(0, COMMITS_PER_FETCH)) {
      abortIfStale(token, "playing " + c.sha);
      const sha7 = (c.sha || "").slice(0, 7);
      const author = (c.commit && c.commit.author && c.commit.author.name) || "unknown";
      const authored = (c.commit && c.commit.author && c.commit.author.date) || "";
      const message = (c.commit && c.commit.message) || "";
      gitLogEntry(sha7, author, authored, message.trim());

      const filesChanged = Math.max(1, Math.floor(Math.random() * 8) + 1);
      const adds = Math.floor(Math.random() * 60) + 2;
      const dels = Math.floor(Math.random() * (adds / 2)) + 1;
      line("tl dim", "       " + filesChanged + " files changed · +" + adds + " −" + dels);
      line("tl prompt", "  $ ");
      await sleep(jitter(700));
      if (Math.random() < 0.25) await sleep(700);
    }

    lastFetch = (commits[0].commit && commits[0].commit.author && commits[0].commit.author.date) ||
      new Date().toISOString();
    cycle++;
    line("tl meta", "  " + "─".repeat(48));
    line("tl meta", "  live feed · watching " + repo + " for new commits…");
    await sleep(jitter(9000));
  }
}

/* ██ Date range ██ */
function eraSince(era) {
  const map = {
    e1517: "2015-01-01T00:00:00Z",
    e1820: "2018-01-01T00:00:00Z",
    e2123: "2021-01-01T00:00:00Z",
    e2425: "2024-01-01T00:00:00Z",
  };
  return map[era] || map.e2123;
}

/* ██ Controls ██ */
function startSession() {
  if (streaming) return;
  stopRequested = false;
  streaming = true;
  startBtn.disabled = true;
  startBtn.textContent = "● Streaming…";
  outputEl.textContent = "";

  withSession(async (token) => {
    line("tl info", "LIVE · real-time engineering terminal");
    line("tl meta", "  connecting to global engineering network…");
    await sleep(700);
    abortIfStale(token, "greeting");
    await playGiteeFeed(token);
  })
    .catch((err) => {
      if (streaming) {
        console.error("[debug live] fatal:", err);
        line("tl dim", "  ∎ session ended (connection dropped)");
      }
    })
    .finally(() => {
      streaming = false;
      stopRequested = false;
      startBtn.disabled = false;
      startBtn.textContent = "▶ Stream Live Session";
    });
}

function clearTerminal() { outputEl.textContent = ""; }

if (startBtn) startBtn.addEventListener("click", startSession);
if (clearBtn) clearBtn.addEventListener("click", clearTerminal);

/* eslint-disable no-console */