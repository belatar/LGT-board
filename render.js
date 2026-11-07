"use strict";

// Builds the Today and History views from stored data. Shared by the dashboard and (later) the public
// board page, so it only uses the data passed in: { days, people, me, status }.

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

const initials = (people, id) => personName(people, id).split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();

function avatar(data, id) {
  const p = data.people[id];
  const usable = p && p.photo && (!p.photo.expiresAt || p.photo.expiresAt > Date.now()) && !data.noPhotos;
  if (usable) return el("img", { class: "ava", src: p.photo.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  return el("span", { class: "ava ava-txt", "aria-hidden": "true" }, initials(data.people, id));
}

function rankBadge(rank) {
  return el("span", { class: `rank${rank <= 3 ? ` r${rank}` : ""}` }, rank);
}

function flags(row) {
  return row.flawless ? el("span", { class: "flag", title: "Flawless: no hints, no mistakes" }, "✦") : null;
}

function resultRow(data, row) {
  const me = row.id === data.me;
  const name = el("span", { class: "name" }, personName(data.people, row.id));
  if (row.state === "failed") {
    return el("li", { class: `row failed${me ? " me" : ""}` },
      el("span", { class: "rank", title: "Didn't solve it" }, "✗"), avatar(data, row.id), name, el("span", { class: "score muted" }, "failed"));
  }
  if (row.rank == null && row.state === "solved") {
    return el("li", { class: `row${me ? " me" : ""}` },
      el("span", { class: "rank", title: "Not on LinkedIn's leaderboard yet" }, "–"), avatar(data, row.id), name, flags(row), el("span", { class: "score" }, fmtScore(row)));
  }
  if (row.rank == null) {
    return el("li", { class: `row waiting${me ? " me" : ""}` },
      el("span", { class: "rank" }, "–"), avatar(data, row.id), name, el("span", { class: "score muted" }, "not yet"));
  }
  return el("li", { class: `row${me ? " me" : ""}` },
    rankBadge(row.rank), avatar(data, row.id), name, flags(row), el("span", { class: "score" }, fmtScore(row)));
}

// The day's own result in History: "You #2 · 0:42", "You · 5 guesses" (not ranked yet), "You: failed" or "You: –".
function mineText(r) {
  if (!r) return "You: –";
  if (r.state === "failed") return "You: failed";
  if (r.rank != null) return `You #${r.rank} · ${fmtScore(r)}`;
  return r.state === "solved" ? `You · ${fmtScore(r)}` : "You: –";
}

// Today: one card per game with its connections leaderboard.
function renderToday(data, onOpenGame) {
  const games = latestDays(data.days);
  if (!games.length) return el("p", { class: "empty" }, "No results yet. The first check runs a minute after installing.");
  return el("div", { class: "grid" }, games.map(d => {
    const played = d.rows.filter(hasPlayed).length;
    return el("section", { class: "card game" },
      el("header", { class: "card-head" },
        el("h2", {}, onOpenGame ? el("button", { class: "linkish", onclick: () => onOpenGame(d.type), title: "History" }, gameName(d.type)) : gameName(d.type)),
        el("span", { class: "puzzle" }, `#${d.puzzle}`),
        el("span", { class: "count" }, `${played} of ${d.rows.length} played`)),
      d.rows.length
        ? el("ol", { class: "rows" }, d.rows.map(r => resultRow(data, r)))
        : el("p", { class: "muted" }, "No connections on the leaderboard yet."));
  }));
}

// Table sorts, remembered per browser and view (fall back to the default without storage).
const sorts = {};
function tableSort(name, cols, fallback) {
  if (!sorts[name]) {
    try { sorts[name] = JSON.parse(localStorage.getItem(`lgt-sort-${name}`)); } catch (e) { /* no storage */ }
    if (!sorts[name] || !cols.some(c => c.key === sorts[name].key)) sorts[name] = fallback;
  }
  return sorts[name];
}
function setTableSort(name, sort) {
  sorts[name] = sort;
  try { localStorage.setItem(`lgt-sort-${name}`, JSON.stringify(sort)); } catch (e) { /* no storage */ }
}

const playerCell = (data, id) => el("td", { class: "l" }, el("span", { class: "who" }, avatar(data, id),
  el("span", { class: "name" }, personName(data.people, id))));

// A standings table: a click on a column header sorts by it (again: reverses).
// rows(sort) gives the sorted entries, cells(entry) the cells after the player.
function sortableTable(data, name, cols, fallback, rows, cells) {
  const sort = tableSort(name, cols, fallback);
  const head = cols.map(c => {
    const on = c.key === sort.key;
    const pick = () => { setTableSort(name, on ? { key: c.key, dir: -sort.dir } : { key: c.key, dir: c.dir }); table.replaceWith(sortableTable(data, name, cols, fallback, rows, cells)); };
    return el("th", { class: c.key === "name" ? "l" : null, title: c.title, "aria-sort": on ? (sort.dir > 0 ? "ascending" : "descending") : null },
      el("button", { class: `sort${on ? " on" : ""}${c.title ? " help" : ""}`, onclick: pick },
        el("span", { class: "lbl" }, c.label), el("span", { class: "arrow", "aria-hidden": "true" }, on ? (sort.dir > 0 ? "▲" : "▼") : "")));
  });
  const table = el("table", { class: "standings" },
    el("thead", {}, el("tr", {}, head)),
    el("tbody", {}, rows(sort).map(s => el("tr", { class: s.id === data.me ? "me" : null }, playerCell(data, s.id), cells(s)))));
  return table;
}

const avgRankText = s => s.avgRank == null ? "–" : s.avgRank.toFixed(1);

function standingsTable(data, type) {
  return sortableTable(data, "history", STANDING_COLS, DEFAULT_SORT, sort => standings(data.days, type, sort, data.people),
    s => [el("td", {}, s.played), el("td", {}, s.wins), el("td", {}, avgRankText(s)), el("td", {}, fmtTime(s.best)), el("td", {}, fmtTime(s.avg))]);
}

// Leaderboard: everyone who ever played, over all games.
function renderLeaderboard(data) {
  const days = Object.values(data.days);
  if (!days.length) return el("p", { class: "empty" }, "No results yet.");
  const games = new Set(days.map(d => d.type)).size, dates = new Set(days.map(d => d.date)).size;
  const table = sortableTable(data, "leaderboard", LEADER_COLS, LEADER_SORT, sort => leaderboard(data.days, sort, data.people),
    s => [el("td", {}, s.played), el("td", {}, s.wins), el("td", {}, avgRankText(s)), el("td", { class: "pts" }, s.points)]);
  return el("section", { class: "card leader" },
    el("header", { class: "card-head" }, el("h2", {}, "Leaderboard"),
      el("span", { class: "count" }, `${games} ${games === 1 ? "game" : "games"} · ${dates} ${dates === 1 ? "day" : "days"}`)),
    table);
}

// History of one game: standings over all stored days, and the days themselves.
function renderHistory(data, type, onPickGame) {
  const types = [...new Set(Object.values(data.days).map(d => d.type))].sort((a, b) => a - b);
  if (!types.length) return el("p", { class: "empty" }, "No history yet.");
  if (!types.includes(type)) type = types[0];
  const pills = el("nav", { class: "pills", "aria-label": "Game" }, types.map(t =>
    el("button", { class: `pill${t === type ? " on" : ""}`, "aria-pressed": String(t === type), onclick: () => onPickGame(t) }, gameName(t))));

  const table = standingsTable(data, type);
  const dayList = el("ol", { class: "days" }, daysOf(data.days, type).map(d => {
    const ranked = d.rows.filter(r => r.rank != null);
    const mine = d.rows.find(r => r.id === data.me);
    return el("li", { class: "day" },
      el("div", { class: "day-head" },
        el("strong", {}, fmtDay(d.date)), el("span", { class: "puzzle" }, `#${d.puzzle}`),
        data.me ? el("span", { class: "count" }, mineText(mine)) : null),
      el("div", { class: "podium" }, ranked.slice(0, 3).map(r =>
        el("span", { class: "pod" }, rankBadge(r.rank), personName(data.people, r.id).split(" ")[0], el("span", { class: "muted" }, fmtScore(r))))));
  }));

  return el("div", { class: "history" }, pills,
    el("div", { class: "hist-grid" },
      el("section", { class: "card" }, el("header", { class: "card-head" }, el("h2", {}, "Standings"), el("span", { class: "count" }, `${daysOf(data.days, type).length} days`)), table),
      el("section", { class: "card" }, el("header", { class: "card-head" }, el("h2", {}, "Days")), dayList)));
}
