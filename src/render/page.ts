// The page shell: CSS, layout, and the poll script.
//
// One self-contained HTML document, no framework and no build step — the whole
// dashboard is a string. Collapsible sections are native <details>, so the only
// client-side JavaScript is the refresh poll and the event-stream filter.
//
// Refresh model: the browser re-fetches the rendered body every `pollMs` and
// swaps it in. Deliberately NOT a file watcher — the inspected tree is usually a
// synced copy, and sync tools write via atomic rename, which kqueue/FSEvents can
// miss. A poll cannot miss anything; the whole read costs ~10ms.

import { renderTokens } from "../credit/claude/token-view";
import { renderCredit } from "../credit/view/credit-view";
import type { DashboardModel } from "../model/types";
import { VERSION } from "../version";
import { esc } from "./common";
import { renderHealth } from "./health";
import { renderOverview } from "./overview";
import { renderTimeline } from "./timeline";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #12141a; --card: #1a1d26; --line: #2b3040; --fg: #e6e9f0; --mute: #8b93a7;
  --ok: #4ec98b; --warn: #e5a54b; --bad: #e2685f; --accent: #5b9cf8; --accent2: #7fd1c1;
}
@media (prefers-color-scheme: light) {
  :root { --bg:#f6f7fa; --card:#fff; --line:#e2e5ec; --fg:#1b1f2a; --mute:#697086;
          --ok:#1c9d63; --warn:#b8791b; --bad:#c8453b; --accent:#2f6fd0; --accent2:#2b9c8a; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.92em; }
a { color: var(--accent); }

header.top { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line);
  padding:10px 18px; display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
header.top h1 { font-size:15px; margin:0; font-weight:650; }
header.top .path { color:var(--mute); font-size:12px; }
header.top nav { margin-left:auto; display:flex; gap:12px; align-items:center; font-size:12px; }
header.top nav a { text-decoration:none; }
header.top nav a.pickbtn, header.top nav button.pickbtn {
  border:1px solid var(--line); border-radius:6px; padding:2px 9px; color:var(--fg);
  background:transparent; font:inherit; font-size:12px; cursor:pointer; }
header.top nav a.pickbtn:hover, header.top nav button.pickbtn:hover {
  border-color:var(--accent); color:var(--accent); }
button.reload { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-width:92px; }
button.reload .reload-icon { display:inline-block; width:1em; height:1em; line-height:1; transform-origin:50% 50%; }
button.reload.spin { border-color:var(--accent2); color:var(--accent2); cursor:wait; }
button.reload.spin .reload-icon { animation:reload-spin .7s linear infinite; }
button.reload:disabled { opacity:.9; }
@keyframes reload-spin { to { transform:rotate(360deg); } }
#poll-state.err { color:var(--bad); }

main { padding:16px 18px 60px; max-width:1500px; margin:0 auto; display:grid; gap:14px;
  grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr)); align-items:start; }
main > .col { display:grid; gap:14px; min-width:0; }
.card { background:var(--card); border:1px solid var(--line); border-radius:9px; padding:13px 15px;
  min-width:0; overflow:hidden; }
.card h2 { font-size:13px; margin:0 0 10px; font-weight:650; letter-spacing:.01em;
  display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.note { color:var(--mute); font-size:12px; margin:7px 0 0; }
.note.warn { color:var(--warn); }
.lead { margin:0 0 10px; font-size:13px; }
.mute { color:var(--mute); }
.bad { color:var(--bad); }

.hero-top { display:flex; align-items:baseline; justify-content:space-between; }
.hero-phase { font-size:19px; font-weight:680; letter-spacing:.04em; }
.hero-pct { font-size:23px; font-weight:700; color:var(--accent2); }
.hero-meta { color:var(--mute); font-size:12px; margin-top:5px; }
.hero-meta.small { font-size:11px; }
.hero-now { margin-top:7px; font-size:13px; }
.hero-now .k { color:var(--mute); margin-right:5px; }
.hero-count { color:var(--mute); font-size:11.5px; margin-left:7px; }

.bar { height:7px; background:var(--line); border-radius:4px; overflow:hidden; margin:7px 0 2px; }
.bar-fill { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); }
.bar-overall { height:9px; }

details.phase { border-top:1px solid var(--line); padding:7px 0 3px; }
details.phase:first-of-type { border-top:0; }
details.phase summary { cursor:pointer; display:flex; align-items:center; gap:9px; font-size:12.5px; }
.phase-name { font-weight:600; }
.phase-count { color:var(--mute); }
.phase-declared { margin-left:auto; color:var(--mute); font-size:11px; }
ul.stages { list-style:none; margin:5px 0 4px; padding:0 0 0 3px;
  display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:1px 10px; }
ul.stages li { font-size:12px; color:var(--mute); display:flex; gap:6px; align-items:baseline; }
.glyph { width:11px; display:inline-block; text-align:center; }
li.s-done { color:var(--ok); } li.s-active { color:var(--accent); font-weight:600; }
li.s-awaiting { color:var(--warn); font-weight:600; } li.s-revising { color:var(--warn); }
li.s-skipped { opacity:.45; text-decoration:line-through; }
.skip { font-size:9.5px; border:1px solid var(--line); border-radius:6px; padding:0 4px; }

/* Expandable stage rows. A stage with files gets a <details>; one without stays
   a plain <li> (.no-art) so an empty toggle never invites a dead click. The
   <details> must fill its grid cell, hence the flex:1 1 100% / min-width:0. */
ul.stages li.stage { align-items:flex-start; }
details.art-box { flex:1 1 100%; min-width:0; }
details.art-box > summary { display:flex; gap:6px; align-items:baseline; cursor:pointer;
  list-style:none; }
details.art-box > summary::-webkit-details-marker { display:none; }
details.art-box > summary::after { content:'▾'; font-size:9px; opacity:.5; }
details.art-box[open] > summary::after { content:'▴'; }
li.no-art { padding-right:13px; }        /* keep text aligned with toggled rows */
.art-count { font-size:9.5px; color:var(--mute); border:1px solid var(--line);
  border-radius:6px; padding:0 4px; margin-left:auto; }
ul.arts { list-style:none; margin:3px 0 6px; padding:0 0 0 17px;
  display:flex; flex-direction:column; gap:1px; }
ul.arts li.art { display:block; }
a.art-link { display:flex; gap:5px; align-items:baseline; font-size:11.5px;
  color:var(--fg); text-decoration:none; border-radius:5px; padding:1px 4px; }
a.art-link:hover { background:var(--line); }
.art-mark { width:13px; flex:none; font-size:10.5px; }
.art-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.art-unit { font-size:9.5px; color:var(--mute); border:1px solid var(--line);
  border-radius:5px; padding:0 3px; flex:none; max-width:132px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.art-size { margin-left:auto; font-size:9.5px; color:var(--mute); flex:none; }
li.a-questions a.art-link, li.a-diary a.art-link { color:var(--mute); }
a.art-link.busy { opacity:.5; }
a.art-link.opened { background:var(--ok); color:#fff; }
a.art-link.failed { color:var(--warn); text-decoration:underline wavy; }

.mx-wrap { overflow-x:auto; }
table.mx { border-collapse:collapse; font-size:11.5px; }
table.mx th, table.mx td { padding:3px 5px; text-align:center; }
table.mx tbody th { text-align:left; white-space:nowrap; font-weight:500; }
.mx-unit { writing-mode:vertical-rl; transform:rotate(180deg); font-weight:500;
  color:var(--mute); max-height:96px; font-size:10.5px; cursor:help; }
.mx-cell { font-size:15px; line-height:1; cursor:help; }
.c-complete { color:var(--ok); } .c-partial { color:var(--warn); } .c-absent { color:var(--line); }
.mx-n { color:var(--mute); font-variant-numeric:tabular-nums; padding-left:9px !important; }
tr.mx-skip { opacity:.4; } tr.mx-skip td { font-size:10px; color:var(--mute); }
.prov-mark { color:var(--warn); margin-left:3px; cursor:help; }

.dag { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-top:9px; }
.batch { border:1px solid var(--line); border-radius:6px; padding:3px 6px; display:flex; gap:4px; align-items:center; }
.batch-label { color:var(--mute); font-size:10px; }
.batch-unit { background:var(--line); border-radius:4px; padding:1px 5px; font-size:10.5px; }
.batch-arrow { color:var(--mute); }

.time-stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); border-block:1px solid var(--line);
  margin-bottom:10px; }
.time-stats > div { min-width:0; padding:8px 10px; border-left:1px solid var(--line); }
.time-stats > div:first-child { border-left:0; }
.time-stat-n { display:block; font-size:18px; line-height:1.2; font-weight:680;
  font-variant-numeric:tabular-nums; white-space:nowrap; }
.time-stat-l { display:block; color:var(--mute); font-size:10.5px; margin-top:2px; }
.time-stats .wait .time-stat-n, .g-n.wait { color:var(--warn); }
.time-stats .parked .time-stat-n, .g-n.parked { color:var(--accent); }
.time-stats .observed .time-stat-n { color:var(--ok); }
.time-stats .unknown .time-stat-n, .g-n.unknown { color:var(--mute); }
.time-breakdown { display:flex; width:100%; height:8px; overflow:hidden; background:var(--line);
  border-radius:3px; }
.time-breakdown > span { display:block; min-width:1px; }
.time-breakdown .wait, .time-legend i.wait { background:var(--warn); }
.time-breakdown .parked, .time-legend i.parked { background:var(--accent); }
.time-breakdown .observed, .time-legend i.observed { background:var(--ok); }
.time-breakdown .unknown, .time-legend i.unknown { background:var(--mute); }
.time-legend { display:flex; gap:5px 13px; flex-wrap:wrap; margin-top:6px; color:var(--mute);
  font-size:10.5px; }
.time-legend span { display:inline-flex; align-items:center; gap:4px; }
.time-legend i { width:7px; height:7px; border-radius:2px; flex:none; }
.time-legend b { color:var(--fg); font-weight:600; }
.worker-stats { display:flex; flex-wrap:wrap; gap:4px 14px; margin:8px 0 3px; color:var(--mute);
  font-size:10.5px; }
.worker-stats b { color:var(--fg); font-size:11.5px; font-variant-numeric:tabular-nums; }
.timeline-table-wrap { overflow-x:auto; }

.diary-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-block:1px solid var(--line);
  margin:0 0 13px; }
.diary-stat { min-width:0; padding:8px 10px; border-left:1px solid var(--line); }
.diary-stat:first-child { border-left:0; }
.diary-stat-n { display:block; font-size:18px; line-height:1.2; font-weight:680;
  font-variant-numeric:tabular-nums; }
.diary-stat-l { display:block; color:var(--mute); font-size:10.5px; margin-top:2px; }
.diary-stat.ok .diary-stat-n { color:var(--ok); }
.diary-stat.warn .diary-stat-n { color:var(--warn); }
.diary-focus > h3, .diary-group > h3 { margin:0 0 7px; font-size:11.5px; font-weight:650; }
.diary-focus { padding-bottom:12px; }
.diary-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 16px;
  border-top:1px solid var(--line); }
.diary-group { min-width:0; padding-top:11px; }
.diary-group + .diary-group { border-left:1px solid var(--line); padding-left:16px; }
.diary-list { list-style:none; margin:0; padding:0; }
.diary-item { padding:7px 0; border-bottom:1px solid var(--line); min-width:0; }
.diary-item:last-child { border-bottom:0; }
.diary-meta { display:flex; align-items:center; gap:7px; min-width:0; font-size:10.5px; }
.diary-where { color:var(--mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.diary-time { color:var(--mute); margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
.diary-source { flex:none; font-size:10px; text-decoration:none; }
.diary-text { margin-top:4px; font-size:11.5px; line-height:1.45; overflow-wrap:anywhere; }
.diary-more > summary, .diary-resolved > summary, .diary-audit > summary { padding-top:7px; }
.diary-resolved, .diary-audit { border-top:1px solid var(--line); margin-top:11px; padding-top:2px; }
.diary-table-wrap { overflow-x:auto; }
.diary-table { min-width:520px; }
.diary-table .g-name { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:700px) {
  .time-stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .time-stats > div:nth-child(3), .time-stats > div:nth-child(5) { border-left:0; }
  .time-stats > div:nth-child(n+3) { border-top:1px solid var(--line); }
  .time-stats > div:nth-child(5) { grid-column:1 / -1; }
  .diary-stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .diary-stat:nth-child(3) { border-left:0; border-top:1px solid var(--line); }
  .diary-stat:nth-child(4) { border-top:1px solid var(--line); }
  .diary-columns { grid-template-columns:1fr; }
  .diary-group + .diary-group { border-left:0; border-top:1px solid var(--line); padding-left:0; }
}

.blocker { border:1px solid var(--line); border-left-width:3px; border-radius:7px; padding:9px 11px; margin-bottom:8px; }
.blocker.bad { border-left-color:var(--bad); } .blocker.warn { border-left-color:var(--warn); }
.blocker-head { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.blocker-where { font-weight:620; font-size:12.5px; }
.blocker-age { margin-left:auto; color:var(--mute); font-size:11px; }
.blocker-q { margin-top:5px; font-size:13px; }
.blocker-path { margin-top:3px; color:var(--mute); font-size:11px; word-break:break-all; }
.pill { font-size:10px; border-radius:10px; padding:1px 7px; border:1px solid currentColor; white-space:nowrap; }
.pill.has-help { cursor:help; text-decoration:underline dotted; text-underline-offset:2px; }
.pill.ok { color:var(--ok); } .pill.warn { color:var(--warn); }
.pill.bad { color:var(--bad); } .pill.mute { color:var(--mute); }

table.tbl { width:100%; border-collapse:collapse; font-size:11.5px; margin-top:8px; }
table.tbl th, table.tbl td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
table.tbl thead th { color:var(--mute); font-weight:500; font-size:10.5px; white-space:nowrap; }
td.ts, .g-n { font-variant-numeric:tabular-nums; white-space:nowrap; }
.g-n { text-align:right; }
.g-n.idle { color:var(--warn); } .g-n.work { color:var(--ok); }
td.out { max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
td.det { color:var(--mute); }
ul.errs { margin:0; padding-left:15px; } ul.errs li { margin:1px 0; }
ul.errs .more { color:var(--mute); list-style:none; }
ul.per-stage { list-style:none; margin:9px 0 0; padding:0; font-size:11.5px; }
ul.per-stage li { padding:2px 0; } .per-stage .st { display:inline-block; min-width:160px; }
details summary { cursor:pointer; font-size:12px; color:var(--mute); margin-top:9px; }

.gantt .g-name { white-space:nowrap; font-weight:500; max-width:170px; overflow:hidden; text-overflow:ellipsis; }
.g-track-h { width:44%; }
.g-track { width:44%; padding:4px 6px !important; }
.g-track-line { position:relative; height:11px; min-width:260px; }
.g-bar { position:absolute; top:0; height:11px; border-radius:3px; background:var(--accent);
  min-width:2px; cursor:help; }
.g-bar.done { background:var(--accent2); } .g-bar.skip { background:var(--mute); opacity:.55; }
.g-bar.await { background:var(--warn); } .g-bar.live { background:var(--accent); }
.g-load { color:var(--mute); font-size:10.5px; max-width:150px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.tag-lead { font-size:9.5px; color:var(--accent); border:1px solid currentColor;
  border-radius:8px; padding:0 5px; white-space:nowrap; cursor:help; }
.gantt tbody td, .gantt tbody th { line-height:1.35; }
ul.gaps, ul.oq { margin:6px 0 0; padding-left:17px; font-size:11.5px; }
ul.gaps li, ul.oq li { margin:2px 0; }
table.tbl td code { white-space:nowrap; }
.filter-row { display:flex; gap:11px; align-items:center; font-size:11.5px; margin-top:6px; flex-wrap:wrap; }
.filter-row select { background:var(--card); color:var(--fg); border:1px solid var(--line);
  border-radius:5px; padding:2px 5px; font-size:11.5px; max-width:260px; }
.stream code.ev { font-size:10.5px; }
.warnbox { border:1px solid var(--warn); border-radius:7px; padding:8px 11px; margin-bottom:12px;
  font-size:12px; color:var(--warn); grid-column:1/-1; }
.warnbox ul { margin:4px 0 0; padding-left:17px; }

/* Credit view (u3) — first card in the primary column. Uses host tokens only.
   The u3 view emits .card via section(); these style its inner blocks. */
.credit-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.credit-current { display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
.credit-gauge { flex:none; }
.credit-current table.tbl { flex:1 1 260px; margin-top:0; }
.credit-progress { margin-top:10px; }
.credit-progress .note { margin-top:4px; }
.credit-trend { margin-top:12px; }
.credit-chart { margin:8px 0 4px; overflow-x:auto; }
/* Claude token panel — shares the credit card's layout; only the model
   breakdown table is extra. The share cell stacks a bar over its own number so
   the column reads without relying on the bar's length alone. */
.token-models { margin-top:12px; }
.token-models th, .token-models td { white-space:nowrap; }
.token-share { min-width:110px; }
.token-share .note { margin-top:2px; }
.window-toggle { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.window-toggle a { text-decoration:none; }
.window-toggle a[aria-checked="true"] { border-color:var(--accent); color:var(--accent); }
footer { color:var(--mute); font-size:11px; text-align:center; padding:0 0 26px; }
`;

/** The refresh poll + stream filter. Kept tiny and dependency-free. */
const SCRIPT = (pollMs: number) => `
(function () {
  var wrap = document.getElementById('body-wrap');
  var btn = document.getElementById('reload-btn');
  var state = document.getElementById('poll-state');

  function bindFilter() {
    var sel = document.getElementById('ev-filter');
    if (!sel) return;
    sel.addEventListener('change', function () {
      var v = sel.value;
      document.querySelectorAll('#ev-table tbody tr').forEach(function (tr) {
        tr.style.display = !v || tr.dataset.ev === v ? '' : 'none';
      });
    });
  }
  bindFilter();

  // One refresh path for every trigger — the button, the timer and the
  // tab-focus handler all call this, so they can never drift apart.
  var busy = false;
  async function refresh(manual) {
    if (busy) return;
    busy = true;
    if (manual && btn) {
      btn.classList.add('spin');
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      var reloadLabel = btn.querySelector('.reload-label');
      if (reloadLabel) reloadLabel.textContent = '새로고침 중';
    }
    try {
      // The single manual control refreshes both credit usage and the workspace.
      // A degraded credit subsystem (503) must not block the workspace refresh.
      if (manual) {
        var creditRes = await fetch('/api/refresh', { method: 'POST', cache: 'no-store' });
        if (!creditRes.ok && creditRes.status !== 503) throw new Error(creditRes.status);
      }
      var res = await fetch('/api/body' + window.location.search, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      var html = await res.text();
      // Preserve which <details> the reader had open across the swap.
      var open = new Set();
      document.querySelectorAll('details[data-key]').forEach(function (d) {
        if (d.open) open.add(d.dataset.key);
      });
      var y = window.scrollY;
      wrap.innerHTML = html;
      document.querySelectorAll('details[data-key]').forEach(function (d) {
        if (open.size) d.open = open.has(d.dataset.key);
      });
      window.scrollTo(0, y);
      bindFilter();
      if (state) {
        state.textContent = '갱신 ' + new Date().toLocaleTimeString();
        state.classList.remove('err');
      }
    } catch (e) {
      // Server down, or a sync replacing files mid-read. Say so rather than
      // leaving a stale page that looks current.
      if (state) {
        state.textContent = '갱신 실패 — 재시도 중';
        state.classList.add('err');
      }
    } finally {
      busy = false;
      if (manual && btn) setTimeout(function () {
        btn.classList.remove('spin');
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        var reloadLabel = btn.querySelector('.reload-label');
        if (reloadLabel) reloadLabel.textContent = '새로고침';
      }, 300);
    }
  }

  // Manual reload. Needed because a change the poll cannot see coming — a stage
  // flipped between SKIP and EXECUTE, a hand-edited state file — should be
  // observable on demand rather than after waiting out the interval.
  if (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); refresh(true); });
  }
  // Artifact links open in the user's editor, so the page must NOT navigate.
  // Delegated on document: the refresh swaps innerHTML, and a listener bound to
  // each link would die with the old nodes (the same reason the poll re-renders
  // rather than patches). Also keeps <details> state out of the click path —
  // the toggle is native, this only intercepts the anchors inside it.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a.art-link');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('busy')) return;
    a.classList.add('busy');
    fetch(a.getAttribute('href'), { method: 'GET' })
      .then(function (r) {
        if (r.ok) { a.classList.add('opened'); return; }
        return r.json().catch(function () { return {}; }).then(function (j) {
          a.classList.add('failed');
          a.setAttribute('title', (j && j.error) || ('열기 실패 (' + r.status + ')'));
        });
      })
      .catch(function () {
        a.classList.add('failed');
        a.setAttribute('title', '열기 실패 — 서버에 닿지 못했다');
      })
      .then(function () {
        a.classList.remove('busy');
        setTimeout(function () { a.classList.remove('opened'); }, 1200);
      });
  });

  // r / F5-like shortcut, ignored while typing in the event filter.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    e.preventDefault();
    refresh(true);
  });
${
  pollMs > 0
    ? `  setInterval(function () {
    if (document.hidden) return;               // don't poll a background tab
    refresh(false);
  }, ${pollMs});

  // Coming back to the tab refreshes at once. Without this the hidden-tab guard
  // above leaves the page up to one full interval stale on return, which reads
  // as "the dashboard did not notice my change".
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh(false);
  });`
    : "  /* auto-poll disabled (--poll 0) — the reload button still works */"
}
})();
`;

function warnings(m: DashboardModel): string {
  if (m.warnings.length === 0) return "";
  return `<div class="warnbox"><b>읽기 경고</b><ul>${m.warnings
    .map((w) => `<li>${esc(w)}</li>`)
    .join("")}</ul></div>`;
}

/**
 * The refreshable part of the page: everything inside #body-wrap. Served on its
 * own at /api/body so the poll swaps only this.
 *
 * The primary column keeps usage and decision context together. The secondary
 * column presents run structure before its timing analysis, so the reader sees
 * what ran before interpreting how long it took.
 */
export function renderBody(m: DashboardModel): string {
  // Tag details elements so the poll can restore what the reader had open.
  const keyed = (html: string, prefix: string): string => {
    let i = 0;
    return html.replace(/<details/g, () => `<details data-key="${prefix}-${i++}"`);
  };
  // Usage leads the primary column, followed by the decisions that explain the
  // run. Overview cards lead the secondary column and provide context for timing.
  // Which usage panel renders is resolved during assembly (model.usage), so the
  // renderer just dispatches on the discriminant — the two panels share the card
  // slot, the `?cw=` window contract and the `credit-*` CSS.
  const usage =
    m.usage.kind === "claude"
      ? renderTokens(m.usage.tokens, m.usage.tokens.trend.window)
      : renderCredit(m.usage.credit, m.usage.credit.trend.window);
  return `${warnings(m)}
<div class="col primary-col">
${keyed(usage, "credit")}
${keyed(renderHealth(m), "h")}
</div>
<div class="col secondary-col">
${keyed(renderOverview(m), "o")}
${keyed(renderTimeline(m), "t")}
</div>`;
}

/** The full document. */
export function renderPage(m: DashboardModel, pollMs: number): string {
  const title = `AI-DLC · ${m.identity.slug ?? m.identity.record}`;
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <h1>${esc(m.identity.slug ?? m.identity.record)}</h1>
  <span class="path">${esc(m.identity.root)} · space ${esc(m.identity.space)} · harness ${esc(
    m.identity.harnessDir ?? "미검출",
  )}</span>
  <nav>
    <a class="pickbtn" href="/pick">📁 폴더 변경</a>
    <button id="reload-btn" class="pickbtn reload" type="button"
            title="지금 다시 읽기 (r) — SKIP↔EXECUTE 변경처럼 폴링이 놓칠 수 있는 수정을 즉시 반영">
      <span class="reload-icon" aria-hidden="true">⟳</span><span class="reload-label">새로고침</span>
    </button>
    <span id="poll-state" class="mute">${esc(m.generatedAt)}</span>
  </nav>
</header>
<main id="body-wrap">
${renderBody(m)}
</main>
<footer>읽기 전용 — 이 대시보드는 워크스페이스에 쓰지 않음. · v${esc(VERSION)}</footer>
<script>${SCRIPT(pollMs)}</script>
</body>
</html>`;
}
