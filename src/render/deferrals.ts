// 미뤄둔 결정 — the deferral ledger panel.
//
// The question this panel answers is "what did we decide not to decide, and where
// does it come back?" Nothing else on the page answers it. The blocker panel reads a
// blank `[Answer]:`, and a finished run has none while still owing 230 decisions. The
// stage-diary card that used to sit here read `memory.md` — what the orchestrator
// thought — which on one real run shared zero files and zero item text with this
// ledger and named nothing still outstanding; it is unmounted for that reason
// (render/health.ts, SHOW_DIARY).
//
// THREE RULES THIS PANEL FOLLOWS, mirroring the timing panel's hard-won ones:
//
//   1. Rank by what the reader must act on, not by size. `passed` leads — the stage
//      an item was assigned to has finished, so nobody is going to ask it — then
//      `current`, which is the run's live bill. `nextCycle` and `outOfScope` are
//      deliberate exits and sort last however many there are.
//   2. Show the direction, do not label it. A row prints `기록 stage → 배정 stage`
//      so the reader sees for themselves whether a decision was pushed forward or
//      handed back to a closed stage. Computing "backward" would need an ordering
//      assumption this module has no measured right to make.
//   3. Say what cannot be seen. The engine writes no close marker for an open item,
//      so `passed` cannot mean "dropped" — it means "no answer is visible". The note
//      under the KPI row says that in one sentence rather than letting a count read
//      as a defect tally.

import type { DashboardModel } from "../model/types";
import type { DeferralItem, OwnerStatus } from "../scan/deferrals";
import { dur, esc, pill, section } from "./common";

interface StatusFace {
  label: string;
  tone: "ok" | "warn" | "bad" | "mute";
  tip: string;
}

const FACE: Record<OwnerStatus, StatusFace> = {
  passed: {
    label: "지난 단계",
    tone: "bad",
    tip: "이 결정을 맡기로 한 단계가 이미 끝났습니다. 답이 기록된 흔적은 없습니다 — 엔진이 닫힘 표시를 쓰지 않으므로 '버려졌다'가 아니라 '보이지 않는다'는 뜻입니다",
  },
  current: {
    label: "현재 단계",
    tone: "warn",
    tip: "지금 진행 중인 단계가 이 결정을 물어야 합니다 — 이번 차례에 청구되는 몫",
  },
  ahead: {
    label: "예정 단계",
    tone: "mute",
    tip: "아직 시작하지 않은 단계로 배정됐습니다 — 그 단계에 가면 다시 물어옵니다",
  },
  outOfScope: {
    label: "범위 밖 단계",
    tone: "warn",
    tip: "실재하는 단계지만 이번 실행 범위(state.md)에 없습니다 — 아무도 물어보지 않습니다",
  },
  nextCycle: {
    label: "다음 차수",
    tone: "mute",
    tip: "이번 차수 밖으로 명시적으로 밀어낸 항목",
  },
  unassigned: {
    label: "배정 없음",
    tone: "bad",
    tip: "배정 칸에서 단계를 읽어낼 수 없습니다 — 물어볼 자리가 정해지지 않았으므로 다음 단계에서 사라질 수 있습니다",
  },
};

/** KPI order: the two that need action, then the two that are merely scheduled. */
const KPI_ORDER: OwnerStatus[] = ["passed", "current", "ahead", "unassigned"];

function assignmentText(cell: string): string {
  const flat = cell.replace(/`/g, "");
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function itemRow(it: DeferralItem): string {
  const face = FACE[it.ownerStatus];
  const origin = it.unit ? `${it.unit} / ${it.stage}` : it.stage;
  const target = it.ownerStage ?? "—";
  const fanIn =
    it.sources.length > 1 ? ` <span class="dfr-fan">+${it.sources.length - 1}</span>` : "";
  return `<li class="dfr-item">
  <div class="dfr-meta">${pill(face.label, face.tone, face.tip)}
    <span class="dfr-route"><span class="dfr-from">${esc(origin)}</span> → <span class="dfr-to">${esc(
      target,
    )}</span></span>${fanIn}
    <span class="dfr-age" title="이 항목이 처음 기록된 뒤 지난 시간">${esc(dur(it.ageSec))}</span>
    <a class="dfr-source" href="/open?rel=${encodeURIComponent(it.rel)}" title="${esc(
      it.rel,
    )} 열기">원문</a>
  </div>
  <div class="dfr-text">${esc(it.item.length > 300 ? `${it.item.slice(0, 300)}…` : it.item)}</div>
  ${
    it.assignment.length > 0
      ? // The cell is markdown and its slugs arrive backticked; the backticks are
        // redundant inside <code>, so they come off here rather than in the scanner —
        // the model keeps the cell verbatim because it also carries registry ids.
        `<div class="dfr-assign">배정 <code>${esc(assignmentText(it.assignment))}</code></div>`
      : ""
  }
</li>`;
}

function itemList(items: DeferralItem[], visible: number, key: string): string {
  if (items.length === 0) return `<p class="note">해당 없음.</p>`;
  const shown = items.slice(0, visible);
  const rest = items.slice(visible);
  return `<ul class="dfr-list">${shown.map(itemRow).join("")}</ul>${
    rest.length > 0
      ? `<details class="dfr-more"><summary>${esc(key)} 나머지 ${rest.length}건</summary>
  <ul class="dfr-list">${rest.map(itemRow).join("")}</ul></details>`
      : ""
  }`;
}

function ownerTable(m: DashboardModel): string {
  const rows = m.deferrals.byOwner
    .map((o) => {
      const face = FACE[o.status];
      return `<tr><th class="g-name">${esc(o.stage)}</th>
  <td>${pill(face.label, face.tone, face.tip)}</td>
  <td class="g-n">${o.count}</td></tr>`;
    })
    .join("");
  return `<details class="dfr-owners"><summary>배정된 자리별 집계 · ${m.deferrals.byOwner.length}곳</summary>
  <table class="tbl">
    <thead><tr><th>배정된 자리</th><th>상태</th><th>건수</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</details>`;
}

function assumptionsBlock(m: DashboardModel): string {
  const list = m.deferrals.assumptions;
  if (list.length === 0) return "";
  const rows = list
    .map(
      (a) => `<li class="dfr-item">
  <div class="dfr-meta">${pill("전제", "mute", "확인되지 않은 채로 다음 단계에 넘어간 전제 — 배정된 자리가 없습니다")}
    <span class="dfr-route"><span class="dfr-from">${esc(
      a.unit ? `${a.unit} / ${a.stage}` : a.stage,
    )}</span></span>
    <a class="dfr-source" href="/open?rel=${encodeURIComponent(a.rel)}" title="${esc(
      a.rel,
    )} 열기">원문</a>
  </div>
  <div class="dfr-text">${esc(a.text.length > 260 ? `${a.text.slice(0, 260)}…` : a.text)}</div>
</li>`,
    )
    .join("");
  return `<details class="dfr-assum"><summary>확인되지 않은 전제 ${list.length}건 — 배정 없음</summary>
  <p class="note">엔진의 stage 규약은 전제를 <code>[assumption]</code>으로 표시하고, 사용자가 그 단계의 질문지에서
  확인해 줄 때까지 하류 산출물에서도 전제로 남기라고 정합니다. 표가 아니라 산문이라 배정된 자리가 없어
  이 대시보드도 어디서 청구될지 말할 수 없습니다 — 산문에서 단계 이름을 추측하지 않습니다.</p>
  <ul class="dfr-list">${rows}</ul>
</details>`;
}

function body(m: DashboardModel): string {
  const d = m.deferrals;
  if (d.sections === 0) {
    return `<p class="note">산출물에 <code>## Assumptions &amp; Open Questions</code> 절이 없습니다 — 이 실행은
    미결 대장을 남기지 않았거나 아직 산출물을 쓰지 않았습니다. (읽은 산출물 ${d.artifacts}개)</p>`;
  }
  if (d.items.length === 0 && d.assumptions.length === 0) {
    return `<p class="note">${pill(
      "미결 없음",
      "ok",
      "미결 대장 절은 있고 그 안이 비어 있음 — 명시적으로 '없음'을 선언한 상태",
    )} 산출물 ${d.sections}곳의 미결 대장이 모두 비어 있습니다.</p>`;
  }

  const kpis = `<div class="dfr-stats">${KPI_ORDER.map((s) => {
    const face = FACE[s];
    const n = d.counts[s];
    const tone = n > 0 ? face.tone : "zero";
    return `<div class="dfr-stat t-${tone}" title="${esc(face.tip)}">
    <span class="dfr-stat-n">${n}</span>
    <span class="dfr-stat-l">${esc(face.label)}</span>
  </div>`;
  }).join("")}</div>`;

  const exits = d.counts.nextCycle + d.counts.outOfScope;
  const lead = `<p class="note">미결 <b>${d.items.length}건</b> · 산출물 ${d.sections}곳의
  <code>## Assumptions &amp; Open Questions</code> 대장에서 읽었습니다 (원시 ${d.rows}행, 중복 정리 후 ${
    d.items.length
  }건)${exits > 0 ? ` · 이번 차수 밖으로 명시적으로 밀어낸 것 ${exits}건은 위 숫자에 없습니다` : ""}.
  엔진 규약은 <b>하류 단계가 미결을 필요로 하면 후속 질문으로 다시 묻는다</b>고 정합니다 — 여기 있는 항목은
  없어진 것이 아니라 <b>다시 물어올 것</b>입니다. 항목이 닫혔다는 표시는 엔진이 쓰지 않으므로
  <b>‘지난 단계’는 버려졌다는 뜻이 아니라 답이 보이지 않는다는 뜻</b>입니다.</p>`;

  const byStatus = (s: OwnerStatus) => d.items.filter((i) => i.ownerStatus === s);
  const passed = byStatus("passed");
  const current = byStatus("current");
  const rest = d.items.filter(
    (i) => i.ownerStatus !== "passed" && i.ownerStatus !== "current" && i.ownerStatus !== "ahead",
  );
  const ahead = byStatus("ahead");

  const warn = d.catalogMissing
    ? `<p class="note warn">stage 카탈로그가 없어 배정 칸의 단계 이름을 이 실행의 state.md 로만 판정했습니다 —
    범위 밖 단계가 <b>배정 없음</b>으로 내려가 있을 수 있습니다.</p>`
    : "";

  return `${kpis}${lead}${warn}
<div class="dfr-focus">
  <h3>지난 단계로 배정됨 · ${passed.length}건</h3>
  ${itemList(passed, 6, "지난 단계")}
</div>
<div class="dfr-focus">
  <h3>현재 단계가 물어야 할 것 · ${current.length}건</h3>
  ${itemList(current, 5, "현재 단계")}
</div>
${
  ahead.length > 0
    ? `<details class="dfr-ahead"><summary>예정 단계로 배정됨 ${ahead.length}건 — 그 단계에 가면 물어옵니다</summary>
  <ul class="dfr-list">${ahead.map(itemRow).join("")}</ul>
</details>`
    : ""
}
${
  rest.length > 0
    ? `<details class="dfr-rest"><summary>배정 없음·차수 밖 ${rest.length}건</summary>
  <ul class="dfr-list">${rest.map(itemRow).join("")}</ul>
</details>`
    : ""
}
${assumptionsBlock(m)}
${ownerTable(m)}`;
}

export function renderDeferrals(m: DashboardModel): string {
  return section("미뤄둔 결정", body(m), "deferrals");
}
