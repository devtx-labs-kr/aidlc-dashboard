// Workspace picker: explicit path entry, bounded discovery, and one unified
// cross-platform filesystem explorer.

import type { BrowseResult } from "../scan/browse";
import { type ExplorerModel, type ExplorerRootKind, buildExplorer } from "../scan/explorer";
import type { WorkspaceDiscovery, WorkspaceMatch } from "../scan/workspaces";
import { esc } from "./common";

const PICKER_STYLE = `
:root {
  color-scheme:light dark;
  --bg:#101215; --panel:#181b1f; --raised:#20242a; --line:#343a42; --fg:#f0f1ec;
  --mute:#979d9f; --ok:#55c98b; --warn:#e6ad55; --bad:#ed7469; --accent:#68a8ef;
}
@media (prefers-color-scheme:light) {
  :root {
    --bg:#f3f4f1; --panel:#fff; --raised:#f7f8f5; --line:#d7dad5; --fg:#191c1c;
    --mute:#687071; --ok:#14784b; --warn:#946016; --bad:#bd4037; --accent:#2868ad;
  }
}
* { box-sizing:border-box; }
body {
  margin:0; min-width:280px; background:var(--bg); color:var(--fg);
  font:14px/1.5 "Avenir Next","Segoe UI",sans-serif; letter-spacing:0;
}
body::before {
  content:""; position:fixed; inset:0; pointer-events:none; opacity:.22;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),
    linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:32px 32px; mask-image:linear-gradient(to bottom,#000,transparent 70%);
}
a { color:inherit; }
code,.path,input {
  font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; letter-spacing:0;
}
.shell { position:relative; max-width:980px; margin:0 auto; padding:40px 24px 64px; }
.masthead {
  display:grid; grid-template-columns:minmax(0,1fr) auto; gap:24px; align-items:end;
  padding-bottom:22px; border-bottom:1px solid var(--line);
}
.eyebrow { margin:0 0 8px; color:var(--ok); font:600 11px/1.2 inherit; text-transform:uppercase; }
h1 { margin:0; font-size:clamp(25px,5vw,38px); line-height:1.08; font-weight:650; }
.scan-summary { min-width:128px; text-align:right; color:var(--mute); font-size:12px; }
.scan-summary strong { display:block; color:var(--fg); font-size:23px; line-height:1.1; }
main { display:grid; gap:0; }
.section { padding:26px 0; border-bottom:1px solid var(--line); }
.section-head {
  display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:14px;
}
h2 { margin:0; font-size:13px; font-weight:650; }
.quiet-link { color:var(--mute); font-size:12px; text-decoration:none; }
.quiet-link:hover { color:var(--accent); }
.rescan-link { display:inline-flex; align-items:center; gap:4px; }
.rescan-icon {
  display:inline-block; width:1em; text-align:center; transform-origin:50% 50%;
}
.rescan-link.scanning { color:var(--accent); cursor:wait; pointer-events:none; }
.rescan-link.scanning .rescan-icon { animation:picker-rescan-spin .7s linear infinite; }
@keyframes picker-rescan-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) {
  .rescan-link.scanning .rescan-icon { animation:none; }
}
.workspace-list {
  display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px;
}
.workspace {
  position:relative; min-width:0; border:1px solid var(--line); border-radius:7px;
  background:var(--panel); transition:border-color .15s ease,transform .15s ease;
}
.workspace:hover { border-color:var(--accent); transform:translateY(-1px); }
.workspace.current { border-color:var(--ok); }
.workspace a {
  min-height:91px; padding:14px; display:grid; grid-template-columns:minmax(0,1fr) auto;
  gap:5px 16px; text-decoration:none;
}
.workspace-name {
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:650;
}
.workspace-path {
  grid-column:1/-1; color:var(--mute); overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; font-size:11px;
}
.workspace-kind { color:var(--ok); font-size:10.5px; }
.workspace-action {
  grid-row:1/3; grid-column:2; align-self:center; color:var(--accent); font-size:11px; font-weight:650;
}
.current-mark {
  position:absolute; top:8px; right:10px; color:var(--ok); font-size:10px; text-transform:uppercase;
}
.empty {
  margin:0; padding:20px; border:1px dashed var(--line); color:var(--mute); text-align:center;
}
.notice { margin:0 0 14px; padding:9px 11px; border-left:3px solid var(--bad); color:var(--bad); }
.truncated { margin:10px 0 0; color:var(--warn); font-size:11.5px; }
.manual-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; }
input {
  width:100%; min-width:0; height:40px; padding:0 11px; border:1px solid var(--line);
  border-radius:6px; background:var(--panel); color:var(--fg); font-size:12px;
}
input:focus { outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent); border-color:var(--accent); }
button,.btn {
  height:40px; padding:0 15px; display:inline-flex; align-items:center; justify-content:center;
  border:1px solid var(--ok); border-radius:6px; background:var(--ok); color:#07130d;
  font:650 12px/1 inherit; text-decoration:none; cursor:pointer;
}
button:hover,.btn:hover { filter:brightness(1.08); }
.field-note { margin:8px 0 0; color:var(--mute); font-size:11.5px; }
.explorer-panel { border:1px solid var(--line); border-radius:7px; background:var(--panel); overflow:hidden; }
.explorer-roots {
  display:flex; align-items:stretch; min-height:43px; overflow-x:auto; border-bottom:1px solid var(--line);
  scrollbar-width:thin;
}
.explorer-root {
  flex:none; min-width:84px; padding:8px 11px; display:flex; align-items:center; gap:7px;
  border-right:1px solid var(--line); color:var(--mute); text-decoration:none; font-size:11px;
}
.explorer-root:hover { color:var(--accent); background:color-mix(in srgb,var(--accent) 6%,transparent); }
.explorer-root.active {
  color:var(--fg); box-shadow:inset 0 -2px var(--ok); background:var(--raised);
}
.root-icon { width:16px; color:var(--accent); text-align:center; font:650 12px/1 monospace; }
.explorer-location { padding:12px 14px; border-bottom:1px solid var(--line); }
.breadcrumbs {
  min-height:24px; display:flex; align-items:center; gap:4px; overflow-x:auto; white-space:nowrap;
  scrollbar-width:thin;
}
.breadcrumbs a,.breadcrumbs span {
  min-height:24px; padding:3px 5px; display:inline-flex; align-items:center;
  border-radius:4px; color:var(--mute); font-size:11px; text-decoration:none;
}
.breadcrumbs a:hover { color:var(--accent); background:var(--raised); }
.breadcrumbs span[aria-current="location"] { color:var(--fg); font-weight:650; }
.crumb-separator { flex:none; color:var(--line); font-size:12px; }
.cwd { margin:5px 5px 0; color:var(--mute); font-size:10.5px; overflow-wrap:anywhere; }
.explorer-tools {
  padding:10px 14px; display:grid; grid-template-columns:minmax(180px,1fr) auto;
  align-items:center; gap:8px; border-bottom:1px solid var(--line); background:var(--raised);
}
.filter-wrap { position:relative; }
.filter-wrap input { height:34px; padding:0 36px 0 30px; background:var(--panel); }
.filter-icon {
  position:absolute; left:10px; top:50%; color:var(--mute); transform:translateY(-50%);
  font-size:13px; pointer-events:none;
}
.filter-clear {
  position:absolute; top:5px; right:5px; width:24px; height:24px; padding:0;
  border-color:transparent; background:transparent; color:var(--mute); font-size:17px; font-weight:400;
}
.filter-clear:hover { color:var(--fg); filter:none; background:var(--raised); }
.filter-clear[hidden] { display:none; }
.explorer-actions { display:flex; gap:6px; align-items:center; }
.explorer-actions a {
  min-height:30px; padding:5px 9px; display:inline-flex; align-items:center;
  border:1px solid var(--line); border-radius:5px; color:var(--mute); font-size:11px; text-decoration:none;
}
.explorer-actions a:hover { border-color:var(--accent); color:var(--accent); }
.explorer-actions a.select-current { border-color:var(--ok); color:var(--ok); }
.directory-viewport { max-height:360px; overflow-y:auto; scrollbar-width:thin; }
.dirs { list-style:none; margin:0; padding:0; }
.dir-row { min-height:41px; display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--line); }
.dir-row:last-child { border-bottom:0; }
.dir-row:hover { background:color-mix(in srgb,var(--accent) 7%,transparent); }
.dir-row[hidden] { display:none; }
.dir-nav {
  min-width:0; flex:1; padding:9px 14px; display:flex; align-items:center; gap:8px;
  text-decoration:none;
}
.dir-icon { width:18px; flex:none; color:var(--accent); text-align:center; }
.dir-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tag {
  flex:none; color:var(--ok); border:1px solid currentColor; border-radius:5px;
  padding:0 5px; font-size:9.5px;
}
.tag.unreadable { color:var(--mute); }
.dir-pick { flex:none; margin-right:14px; color:var(--ok); font-size:11px; text-decoration:none; }
.explorer-empty { margin:0; border:0; border-radius:0; background:var(--panel); }
.filter-empty[hidden] { display:none; }
.footer { padding-top:18px; color:var(--mute); font-size:11.5px; }
.footer a { color:var(--accent); }
@media (max-width:640px) {
  .shell { padding:26px 16px 48px; }
  .masthead { grid-template-columns:1fr; gap:14px; }
  .scan-summary { text-align:left; }
  .scan-summary strong { display:inline; margin-right:5px; font-size:17px; }
  .workspace-list { grid-template-columns:1fr; }
  .manual-form { grid-template-columns:1fr; }
  .manual-form button { width:100%; }
  .explorer-tools { grid-template-columns:1fr; }
  .explorer-actions { justify-content:space-between; }
  .explorer-actions a { flex:1; justify-content:center; text-align:center; }
  .tag { display:none; }
}
`;

const EMPTY_DISCOVERY: WorkspaceDiscovery = {
  workspaces: [],
  searchedRoots: [],
  scannedDirectories: 0,
  truncated: false,
};

/** `/browse?dir=…` link, with the hidden-files flag carried along. */
function browseHref(dir: string, showHidden: boolean): string {
  const query = new URLSearchParams({ dir });
  if (showHidden) query.set("hidden", "1");
  return `/browse?${query.toString()}`;
}

function workspaceRow(workspace: WorkspaceMatch, current?: string): string {
  const isCurrent = current === workspace.path;
  return `<article class="workspace${isCurrent ? " current" : ""}">
  ${isCurrent ? '<span class="current-mark">현재</span>' : ""}
  <a href="/select?dir=${encodeURIComponent(workspace.path)}">
    <span class="workspace-name">${esc(workspace.name)}</span>
    <span class="workspace-kind">AI-DLC 워크스페이스</span>
    <span class="workspace-path">${esc(workspace.path)}</span>
    <span class="workspace-action">열기&nbsp;›</span>
  </a>
</article>`;
}

function directoryRow(entry: BrowseResult["entries"][number], showHidden: boolean): string {
  const tag = entry.isWorkspace
    ? '<span class="tag">워크스페이스</span>'
    : entry.isAidlcDir
      ? '<span class="tag">aidlc 트리</span>'
      : entry.unreadable
        ? '<span class="tag unreadable">읽기 불가</span>'
        : "";
  const select =
    entry.isWorkspace || entry.isAidlcDir
      ? `<a class="dir-pick" href="/select?dir=${encodeURIComponent(entry.fullPath)}">열기</a>`
      : "";

  return `<li class="dir-row" data-dir-name="${esc(entry.name.toLocaleLowerCase())}">
  <a class="dir-nav" href="${esc(browseHref(entry.fullPath, showHidden))}">
    <span class="dir-icon" aria-hidden="true">${entry.isWorkspace ? "◆" : "›"}</span>
    <span class="dir-name">${esc(entry.name)}</span>${tag}
  </a>
  ${select}
</li>`;
}

function rootIcon(kind: ExplorerRootKind): string {
  switch (kind) {
    case "home":
      return "⌂";
    case "current":
      return "◆";
    case "cloud":
      return "☁";
    case "drive":
      return "▣";
    case "volume":
      return "◫";
    case "filesystem":
      return "/";
  }
}

function renderExplorer(
  browse: BrowseResult,
  showHidden: boolean,
  explorer: ExplorerModel,
): string {
  const roots = explorer.roots
    .map(
      (root) =>
        `<a class="explorer-root${root.active ? " active" : ""}" href="${esc(
          browseHref(root.path, showHidden),
        )}"${root.active ? ' aria-current="true"' : ""}>
  <span class="root-icon" aria-hidden="true">${rootIcon(root.kind)}</span>
  <span>${esc(root.label)}</span>
</a>`,
    )
    .join("");
  const breadcrumbs = explorer.breadcrumbs
    .map((crumb, index) => {
      const separator =
        index > 0 ? '<span class="crumb-separator" aria-hidden="true">›</span>' : "";
      const content = crumb.current
        ? `<span aria-current="location">${esc(crumb.label)}</span>`
        : `<a href="${esc(browseHref(crumb.path, showHidden))}">${esc(crumb.label)}</a>`;
      return `${separator}${content}`;
    })
    .join("");
  const selectCurrent = browse.isWorkspace
    ? `<a class="select-current" href="/select?dir=${encodeURIComponent(browse.dir)}">이 폴더 열기</a>`
    : "";
  const rows =
    browse.entries.length > 0
      ? `<ul class="dirs">${browse.entries
          .map((entry) => directoryRow(entry, showHidden))
          .join("")}</ul>`
      : '<p class="empty explorer-empty">표시할 하위 폴더가 없습니다.</p>';

  return `<section class="section explorer-section" aria-labelledby="explorer-title">
  <div class="section-head"><h2 id="explorer-title">폴더 탐색</h2></div>
  <div class="explorer-panel">
    <nav class="explorer-roots" aria-label="탐색 루트">${roots}</nav>
    <div class="explorer-location">
      <nav class="breadcrumbs" aria-label="현재 경로">${breadcrumbs}</nav>
      <div class="cwd">${esc(browse.dir)}</div>
    </div>
    <div class="explorer-tools">
      <div class="filter-wrap">
        <span class="filter-icon" aria-hidden="true">⌕</span>
        <input id="directory-filter" type="search" aria-label="현재 폴더에서 디렉터리 이름 필터"
               placeholder="폴더 이름 필터" autocomplete="off" spellcheck="false">
        <button id="clear-directory-filter" class="filter-clear" type="button"
                aria-label="필터 지우기" title="필터 지우기" hidden>×</button>
      </div>
      <div class="explorer-actions">
        ${selectCurrent}
      <a href="${esc(browseHref(browse.dir, !showHidden))}">${
        showHidden ? "숨김 폴더 감추기" : "숨김 폴더 보기"
      }</a>
      </div>
    </div>
    <div class="directory-viewport">
      ${rows}
      <p id="directory-filter-empty" class="empty explorer-empty filter-empty" hidden>
        일치하는 폴더가 없습니다.
      </p>
    </div>
  </div>
</section>`;
}

export function renderPicker(
  browse: BrowseResult,
  showHidden: boolean,
  current?: string,
  discovery: WorkspaceDiscovery = EMPTY_DISCOVERY,
  explorer: ExplorerModel = buildExplorer(browse.dir, { activeRoot: current }),
): string {
  const workspaces =
    discovery.workspaces.length > 0
      ? `<div class="workspace-list">${discovery.workspaces
          .map((workspace) => workspaceRow(workspace, current))
          .join("")}</div>`
      : '<p class="empty">검색된 워크스페이스가 없습니다.</p>';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI-DLC 워크스페이스 선택</title>
<style>${PICKER_STYLE}</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <div>
      <p class="eyebrow">AI-DLC dashboard</p>
      <h1>워크스페이스 선택</h1>
    </div>
    <div class="scan-summary">
      <strong>${discovery.workspaces.length}</strong>개 발견
      <div>${discovery.scannedDirectories.toLocaleString("ko-KR")}개 폴더 확인</div>
    </div>
  </header>

  <main>
    ${renderExplorer(browse, showHidden, explorer)}

    <section class="section" aria-labelledby="manual-title">
      <div class="section-head"><h2 id="manual-title">경로로 열기</h2></div>
      ${browse.error ? `<p class="notice" role="alert">${esc(browse.error)}</p>` : ""}
      <form class="manual-form" action="/select" method="get">
        <input name="dir" aria-label="워크스페이스 경로"
               placeholder="/Users/me/Development/project"
               value="${browse.isWorkspace ? esc(browse.dir) : ""}"
               autocomplete="off" spellcheck="false">
        <button type="submit">워크스페이스 열기</button>
      </form>
      <p class="field-note"><code>aidlc/</code> 폴더가 있는 루트 경로 · <code>~</code> 사용 가능</p>
    </section>

    <section class="section" aria-labelledby="found-title">
      <div class="section-head">
        <h2 id="found-title">찾은 워크스페이스</h2>
        <a id="rescan-link" class="quiet-link rescan-link" href="/pick">
          <span class="rescan-icon" aria-hidden="true">↻</span><span>다시 검색</span>
        </a>
      </div>
      ${workspaces}
      ${
        discovery.truncated
          ? '<p class="truncated">검색 한도에 도달했습니다. 위에서 경로를 직접 지정할 수 있습니다.</p>'
          : ""
      }
    </section>
  </main>

  ${
    current
      ? `<footer class="footer">현재 워크스페이스 · <code>${esc(current)}</code> ·
         <a href="/">대시보드로 돌아가기</a></footer>`
      : ""
  }
</div>
<script>
const rescan = document.getElementById("rescan-link");
rescan?.addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  rescan.classList.add("scanning");
  rescan.setAttribute("aria-busy", "true");
});

const directoryFilter = document.getElementById("directory-filter");
const clearDirectoryFilter = document.getElementById("clear-directory-filter");
const filterEmpty = document.getElementById("directory-filter-empty");
const directoryRows = [...document.querySelectorAll(".dir-row")];

function applyDirectoryFilter() {
  if (!(directoryFilter instanceof HTMLInputElement)) return;
  const query = directoryFilter.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const row of directoryRows) {
    const matches = !query || (row.dataset.dirName || "").includes(query);
    row.hidden = !matches;
    if (matches) visible++;
  }
  if (clearDirectoryFilter) clearDirectoryFilter.hidden = !query;
  if (filterEmpty) filterEmpty.hidden = !query || visible > 0;
}

directoryFilter?.addEventListener("input", applyDirectoryFilter);
directoryFilter?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !(directoryFilter instanceof HTMLInputElement)) return;
  directoryFilter.value = "";
  applyDirectoryFilter();
});
clearDirectoryFilter?.addEventListener("click", () => {
  if (!(directoryFilter instanceof HTMLInputElement)) return;
  directoryFilter.value = "";
  applyDirectoryFilter();
  directoryFilter.focus();
});
</script>
</body>
</html>`;
}

/** Shown when no workspace has been chosen yet and none was given on the CLI. */
export function renderNoRoot(
  browse: BrowseResult,
  showHidden: boolean,
  discovery?: WorkspaceDiscovery,
): string {
  return renderPicker(browse, showHidden, undefined, discovery);
}
