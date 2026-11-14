"use strict";

// Shared by the background script, the dashboard and (later) the public board page.

// LinkedIn's gameTypeId → name. Unknown ids show as "Game n" until named here.
const GAMES = {
  1: "Pinpoint",
  2: "Crossclimb",
  3: "Queens",
  4: "Wend",
  5: "Tango",
  6: "Zip",
  7: "Mini Sudoku",
  8: "Patches"
};
const gameName = type => GAMES[type] || `Game ${type}`;

// LinkedIn's persisted queries. They can change; Settings → Advanced can override them.
const QUERIES = {
  games: "voyagerIdentityDashGames.f854b81db0ddac8d34a258e73d6414c5",
  board: "voyagerIdentityDashGameConnectionsEntities.3ba704202db4679ab5a17add51058ae8",
  // The result screen after a game: your own results for all of today's games (time or guesses, solved or
  // failed). Only asked when LinkedIn's leaderboard doesn't list you yet (it lags behind, e.g. for Pinpoint).
  endPage: "voyagerIdentityDashGameEndPage.319a70534af9a99b7c328cf51ae2442a"
};

const MIN_INTERVAL = 15;
const DEFAULT_SETTINGS = {
  intervalMin: 15,     // how often to check LinkedIn (minutes, at least MIN_INTERVAL)
  helperTab: true,     // open a hidden linkedin.com tab for checks when LinkedIn refuses direct requests
  queryOverrides: {},  // { games, board, endPage }: LinkedIn queryId overrides, for when LinkedIn changes them
  board: {             // the public board (opt-in)
    enabled: false,
    repo: "belatar/LGT-board",
    branch: "main",
    token: "",         // fine-grained GitHub token, Contents: read and write on that repo only
    passphrase: ""
  }
};

// "owner/name" → "https://owner.github.io/name/"
function boardUrl(repo) {
  const [owner, name] = (repo || "").split("/");
  return owner && name ? `https://${owner.toLowerCase()}.github.io/${name}/` : "";
}

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  const s = Object.assign({}, DEFAULT_SETTINGS, settings);
  s.board = Object.assign({}, DEFAULT_SETTINGS.board, settings && settings.board);
  return s;
}

// LinkedIn's puzzles change at midnight Pacific time, so a puzzle's date is the Pacific date.
function puzzleDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}

// The next reset of LinkedIn's puzzles (midnight Pacific): { la: "PST" or "PDT", local: "09:00 MEZ" } in the
// viewer's own time zone, 24h. Worked out each time, so it follows both daylight saving switches.
function resetInfo(now = new Date()) {
  const [y, m, d] = puzzleDate(now).split("-").map(Number);
  const zone = (at, opts, locale = "en-US") => new Intl.DateTimeFormat(locale, Object.assign({ timeZone: "America/Los_Angeles" }, opts))
    .formatToParts(at).find(p => p.type === "timeZoneName").value;
  const offset = Number(zone(new Date(Date.UTC(y, m - 1, d + 1, 8)), { timeZoneName: "shortOffset" }).replace("GMT", "") || 0);
  const at = new Date(Date.UTC(y, m - 1, d + 1, -offset));
  const here = locale => new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(at).find(p => p.type === "timeZoneName").value;
  let name = here("de-DE"); // MEZ / MESZ
  if (/^(GMT|UTC)/.test(name)) name = here("en-US"); // EST, PDT, … outside Europe
  const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return { at, la: zone(at, { timeZoneName: "short" }), local: `${time} ${name}` };
}

// 8 → "0:08", 754 → "12:34"
function fmtTime(sec) {
  if (sec == null) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// A row's score as text: time if LinkedIn reports one, otherwise the number of guesses.
function fmtScore(row) {
  if (row.time != null) return fmtTime(row.time);
  if (row.guesses != null) return `${row.guesses} ${row.guesses === 1 ? "guess" : "guesses"}`;
  return "";
}

// "2026-11-08" → "8. November 2026" (board)
function fmtDateDe(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// "2026-11-04" → "Wed 4 Nov"
function fmtDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function fmtClock(ts) {
  return ts ? new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "never";
}

const personName = (people, id) => {
  const p = people[id];
  return p ? [p.first, p.last].filter(Boolean).join(" ") || "Unknown" : "Unknown";
};

// The day entries of one game, newest first.
function daysOf(days, type) {
  return Object.values(days).filter(d => d.type === type).sort((a, b) => b.puzzle - a.puzzle);
}

// Today's entry per game: the newest puzzle of each game type.
function latestDays(days) {
  const out = {};
  for (const d of Object.values(days)) if (!out[d.type] || d.puzzle > out[d.type].puzzle) out[d.type] = d;
  return Object.values(out).sort((a, b) => a.type - b.type);
}

// Whether a row is a finished game: ranked by LinkedIn, or (not ranked yet) solved or failed.
const hasPlayed = r => r.rank != null || r.state === "solved" || r.state === "failed";

// History columns: key, header, natural direction (1 = ascending first). Missing values always go last.
const STANDING_COLS = [
  { key: "name", label: "Player", dir: 1 }, { key: "played", label: "Played", dir: -1 },
  { key: "wins", label: "Wins", dir: -1 }, { key: "avgRank", label: "Avg rank", dir: 1 },
  { key: "best", label: "Best", dir: 1 }, { key: "avg", label: "Average", dir: 1 },
  { key: "points", label: "Points", dir: -1, title: "Every day: 1 point for every player you finished ahead of (a better rank, "
    + "or they failed), plus 1 point for a flawless game. Added up over all days of this game." }
];
const DEFAULT_SORT = { key: "avgRank", dir: 1 };

// Leaderboard columns (all games together); the points column explains itself on hover.
const LEADER_COLS = [
  { key: "name", label: "Player", dir: 1 }, { key: "played", label: "Played", dir: -1 },
  { key: "wins", label: "Wins", dir: -1 }, { key: "avgRank", label: "Avg rank", dir: 1 },
  { key: "points", label: "Points", dir: -1, title: "Each game, every day: 1 point for every player you finished ahead of "
    + "(a better rank, or they failed), plus 1 point for a flawless game. Added up over all games ever played." }
];
const LEADER_SORT = { key: "points", dir: -1 };

function sortStandings(list, sort, people) {
  sort = sort || DEFAULT_SORT;
  const val = s => sort.key === "name" ? personName(people || {}, s.id).toLowerCase() : s[sort.key];
  const cmp = (a, b) => {
    const va = val(a), vb = val(b);
    if ((va == null) !== (vb == null)) return va == null ? 1 : -1;
    if (va == null || va === vb) return 0;
    return (va < vb ? -1 : 1) * sort.dir;
  };
  // Ties: the default order (avg rank, then wins, then played).
  const avg = (a, b) => (a.avgRank == null) - (b.avgRank == null) || (a.avgRank || 0) - (b.avgRank || 0);
  return list.sort((a, b) => cmp(a, b) || avg(a, b) || b.wins - a.wins || b.played - a.played);
}

// Points of one day's game per player: 1 for every player left behind (a worse rank, or failed; without a rank of
// your own, only those who failed), +1 for a flawless game. Nothing for a failed game.
function dayPoints(day) {
  const played = day.rows.filter(hasPlayed), out = {};
  for (const r of played) {
    if (r.state === "failed") { out[r.id] = 0; continue; }
    out[r.id] = played.filter(o => o.id !== r.id && (o.state === "failed" || (r.rank != null && o.rank != null && o.rank > r.rank))).length
      + (r.flawless ? 1 : 0);
  }
  return out;
}

// Per-person totals over the given days: played, wins (rank 1), average rank, points, best and average score
// (time, or guesses in games scored by guesses such as Pinpoint).
function totals(dayList) {
  const by = {};
  for (const d of dayList) {
    const points = dayPoints(d);
    for (const r of d.rows) {
      if (!hasPlayed(r)) continue;
      const s = by[r.id] || (by[r.id] = { id: r.id, played: 0, wins: 0, rankSum: 0, ranked: 0, points: 0, scores: [] });
      s.played++;
      s.points += points[r.id];
      if (r.rank != null) { s.rankSum += r.rank; s.ranked++; }
      if (r.rank === 1) s.wins++;
      const score = r.time != null ? r.time : r.guesses;
      if (score != null && r.state !== "failed") s.scores.push(score);
    }
  }
  return Object.values(by).map(s => ({
    id: s.id, played: s.played, wins: s.wins, points: s.points,
    avgRank: s.ranked ? s.rankSum / s.ranked : null,
    best: s.scores.length ? Math.min(...s.scores) : null,
    avg: s.scores.length ? s.scores.reduce((a, b) => a + b, 0) / s.scores.length : null
  }));
}

// History of one game.
function standings(days, type, sort, people) {
  return sortStandings(totals(daysOf(days, type)), sort, people);
}

// Everyone who ever played any game.
function leaderboard(days, sort, people) {
  return sortStandings(totals(Object.values(days)), sort || LEADER_SORT, people);
}

// Whether a game is scored by guesses (Pinpoint) instead of time.
const byGuesses = (days, type) => daysOf(days, type).some(d => d.rows.some(r => r.time == null && r.guesses != null));

/* ---------- update check (dashboard and Settings footers), as in TDT ---------- */

const INSTALL_PAGE = "https://belatar.github.io/LGT-releases/";

function newerVersion(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Firefox checks update_url about once a day. This compares with the published list right away
// (Firefox has no runtime.requestUpdateCheck) and offers the newer version for install, in `out`.
async function runUpdateCheck(out) {
  const manifest = browser.runtime.getManifest();
  const gecko = manifest.browser_specific_settings.gecko;
  out.textContent = "Checking…";
  try {
    const res = await fetch(gecko.update_url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const updates = ((await res.json()).addons[gecko.id] || {}).updates || [];
    const latest = updates.reduce((a, u) => (!a || newerVersion(u.version, a.version) ? u : a), null);
    if (!latest || !newerVersion(latest.version, manifest.version)) {
      out.textContent = "You have the latest version.";
      return;
    }
    const install = document.createElement("a");
    install.href = INSTALL_PAGE;
    install.target = "_blank";
    install.rel = "noopener";
    install.textContent = `Install ${latest.version} now`;
    out.replaceChildren(`Version ${latest.version} is available. Firefox installs it within a day, or `, install);
  } catch (e) {
    out.textContent = `Update check failed: ${e.message || e}`;
  }
}

// Fills a footer made of #about-version, #about-check and #about-status.
function setupAbout() {
  document.getElementById("about-version").textContent = `LGT ${browser.runtime.getManifest().version}`;
  document.getElementById("about-check").addEventListener("click", () => runUpdateCheck(document.getElementById("about-status")));
}
