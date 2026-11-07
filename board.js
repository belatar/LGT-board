"use strict";

// The public board: fetches the encrypted results, decrypts them in the browser with the passphrase and shows
// them with the same views as the add-on's dashboard. Checks for new results every few minutes.

const $ = id => document.getElementById(id);
const DATA_URL = "board.json.enc";
const PASS_KEY = "lgt-board-pass";
const REFRESH_MS = 5 * 60e3;

let passphrase = null;
let data = null;
let lastCt = null;
let lastDay = null;

const store = {
  get() { try { return localStorage.getItem(PASS_KEY); } catch (e) { return null; } },
  set(v) { try { localStorage.setItem(PASS_KEY, v); } catch (e) { /* private window */ } },
  clear() { try { localStorage.removeItem(PASS_KEY); } catch (e) { /* ignore */ } }
};

async function fetchFile() {
  const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (r.status === 404) throw new Error("Nothing published yet.");
  if (!r.ok) throw new Error(`Couldn't load the results (HTTP ${r.status}).`);
  return r.json();
}

function route() {
  const [view, arg] = location.hash.slice(1).split("/");
  return { view: ["history", "leaderboard"].includes(view) ? view : "today", type: arg ? Number(arg) : null };
}

function render() {
  if (!data) return;
  const { view, type } = route();
  $("tab-today").classList.toggle("on", view === "today");
  $("tab-history").classList.toggle("on", view === "history");
  $("tab-leaderboard").classList.toggle("on", view === "leaderboard");
  $("status").textContent = `Updated ${fmtClock(data.generatedAt)}`;
  const r = resetInfo();
  const time = r.local.replace(" ", " Uhr ");
  $("reset").replaceChildren("Reset für die ",
    el("a", { href: "https://www.linkedin.com/games", target: "_blank", rel: "noreferrer" }, "LinkedIn Games"),
    ` ist 00:00 Uhr ${r.la}, das entspricht aktuell ${time}.`);
  $("reset").hidden = $("note").hidden = $("about").hidden = false;
  lastDay = puzzleDate();
  // No "me" on the board: friends read it, so nobody's row is marked and the days show no "You" result.
  const d = { days: data.days || {}, people: data.people || {}, me: null, noPhotos: true };
  $("view").replaceChildren(view === "history" ? renderHistory(d, type, t => { location.hash = `history/${t}`; })
    : view === "leaderboard" ? renderLeaderboard(d)
    : renderToday(d, t => { location.hash = `history/${t}`; }));
}

function showLocked(message) {
  data = null;
  $("tabs").hidden = true;
  $("lock").hidden = true;
  $("view").replaceChildren();
  $("status").textContent = "";
  $("reset").hidden = $("note").hidden = $("about").hidden = true;
  $("unlock").hidden = false;
  $("unlock-error").hidden = !message;
  $("unlock-error").textContent = message || "";
  $("pass").focus();
}

// Loads the file and decrypts it if it changed. A wrong passphrase goes back to the lock screen.
async function refresh() {
  if (!passphrase) return;
  try {
    const file = await fetchFile();
    $("error").hidden = true;
    if (data && file.ct === lastCt) {
      if (puzzleDate() !== lastDay) render(); // LinkedIn's reset: the reset time and Today move on.
      return;
    }
    try {
      data = await decryptJson(file, passphrase);
    } catch (e) {
      passphrase = null;
      store.clear();
      showLocked("That passphrase doesn't open these results.");
      return;
    }
    lastCt = file.ct;
    $("unlock").hidden = true;
    $("tabs").hidden = false;
    $("lock").hidden = false;
    render();
  } catch (e) {
    $("error").hidden = false;
    $("error").textContent = data ? `${e.message} Showing the results from ${fmtClock(data.generatedAt)}.` : e.message;
  }
}

$("unlock").addEventListener("submit", async ev => {
  ev.preventDefault();
  passphrase = $("pass").value;
  $("unlock-btn").disabled = true;
  $("unlock-btn").textContent = "Unlocking…";
  try {
    await refresh();
    if (passphrase && $("remember").checked) store.set(passphrase);
  } finally {
    $("unlock-btn").disabled = false;
    $("unlock-btn").textContent = "Unlock";
    $("pass").value = "";
  }
});

$("lock").addEventListener("click", () => {
  passphrase = null;
  lastCt = null;
  store.clear();
  showLocked();
});

addEventListener("hashchange", render);
setInterval(refresh, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

passphrase = store.get();
if (passphrase) refresh(); else showLocked();
