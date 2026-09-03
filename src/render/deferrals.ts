// 미뤄둔 결정 — the deferral ledger panel.
//
// The question this panel answers is "what did we decide not to decide, and where
// does it come back?" Nothing else on the page answers it. The blocker panel reads a
// blank `[Answer]:`, and a finished run has none while still owing 230 decisions.
//
// It carries THREE ledgers, kept separate because they are separate claims: the
// artifacts' `## Assumptions & Open Questions` (items, with an assigned stage where
// the tree names one), its `[assumption]` entries (no owner), and each stage's
// `memory.md` `## Open questions` (diaryOpenBlock, no owner). The stage-diary card
// that used to sit here read all four memory.md axes and was unmounted for it
// (render/health.ts, SHOW_DIARY) — three of those axes are the orchestrator's
// reasoning and state no debt. Only the Open questions axis does, so only it came
// back, and it came back here rather than there.
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
//      under the ledger rows says that in one sentence rather than letting a count
//      read as a defect tally.
//   4. Never let the layout assert a comparison the data does not support. The three
//      ledgers get a ROW EACH (ledgerRows) rather than tiles in one strip, because
//      equal tiles side by side say "these measure the same thing" and only the first
//      four numbers do. Same rule as the timing panel's bar length vs bar colour.

import type { DashboardModel } from "../model/types";
import type { DeferralItem, OwnerStatus } from "../scan/deferrals";
import { dur, esc, pill, section, shortTs } from "./common";

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

/**
 * Which stage each decision was handed to, and how many landed there. This is the one
 * view that answers "who is carrying the most of this", so it only exists when at
 * least one item names a stage.
 *
 * WHEN NO ITEM HAS AN OWNER IT IS NOT RENDERED. On a tree whose 배정 cells are all
 * prose it collapsed to a single row — `(unassigned) · 배정 없음 · 15` — which repeated
 * the ledger row above it verbatim and spent a raw enum name to do it. A `<details>`
 * that costs a click and returns nothing new is worse than no `<details>`.
 */
function ownerTable(m: DashboardModel): string {
  const all = m.deferrals.byOwner;
  const stages = all.filter((o) => o.stage !== undefined).length;
  if (stages === 0) return "";
  const rows = all
    .map((o) => {
      const face = FACE[o.status];
      // A bucket row carries no stage; its Korean label lives here, not in the model.
      return `<tr><th class="g-name">${esc(o.stage ?? face.label)}</th>
  <td>${pill(face.label, face.tone, face.tip)}</td>
  <td class="g-n">${o.count}</td></tr>`;
    })
    .join("");
  return `<details class="dfr-owners"><summary>배정된 자리별 집계 · stage ${stages}곳</summary>
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

/**
 * The SECOND mandated open-questions ledger — `## Open questions` in each stage's
 * `memory.md` (`knowledge/aidlc-shared/memory-template.md` puts it in every one).
 *
 * It lands here rather than back in 결정과 이슈 because this is the panel that answers
 * "what is still owed?", and that card was unmounted for mixing this axis with three
 * that do not answer it (Interpretations / Deviations / Tradeoffs — 140 · 63 of prose
 * on one run, none of it stating a debt). The Open questions axis is the exception:
 * on one real tree its 34 entries across 6 stages read as plain obligations ("재스캔
 * 비용을 받아들일지 … 결정할 것"), and nothing on screen was showing them.
 *
 * Two honesty rules, both borrowed from the artifact ledger above:
 *
 *   - The HEADING is the declaration, so a `note` entry counts as open just like a
 *     `followUp` one. `questionStatus` is a regex reading of the sentence and is used
 *     only to sort, never to drop an entry the engine filed under Open questions.
 *   - A diary bullet has no 배정 cell either, so no owner is claimed. The diary is the
 *     orchestrator's own note, not a contract with a later stage — which is exactly
 *     why these are kept apart from the artifact items instead of summed with them.
 */
function diaryOpenBlock(m: DashboardModel): string {
  const all = m.diaries.records.filter((r) => r.axis === "openQuestions");
  const open = all.filter((r) => r.questionStatus !== "resolved");
  if (open.length === 0) return "";
  const resolved = all.length - open.length;
  // Newest first, and the sentences that name an obligation ahead of the rest.
  const ordered = [...open]
    .reverse()
    .sort((a, b) =>
      a.questionStatus === b.questionStatus ? 0 : a.questionStatus === "followUp" ? -1 : 1,
    );
  const rows = ordered
    .map(
      (r) => `<li class="dfr-item">
  <div class="dfr-meta">${pill(
    r.questionStatus === "followUp" ? "후속 확인" : "일지 미결",
    r.questionStatus === "followUp" ? "warn" : "mute",
    r.questionStatus === "followUp"
      ? "문장 자체가 후속 확인·결정을 요구합니다"
      : "stage 가 미결 소절에 적었지만 문장에 후속 신호는 없습니다 — 소절 자체가 미결 선언이라 그대로 셉니다",
  )}
    <span class="dfr-route"><span class="dfr-from">${esc(
      r.unit ? `${r.unit} / ${r.stage}` : r.stage,
    )}</span></span>
    ${r.ts ? `<span class="dfr-age">${esc(shortTs(r.ts))}</span>` : ""}
    <a class="dfr-source" href="/open?rel=${encodeURIComponent(r.rel)}" title="${esc(
      r.rel,
    )} 열기">원문</a>
  </div>
  <div class="dfr-text">${esc(r.text.length > 260 ? `${r.text.slice(0, 260)}…` : r.text)}</div>
</li>`,
    )
    .join("");
  return `<details class="dfr-assum"><summary>stage 일지의 미결 ${open.length}건 — 배정 없음</summary>
  <p class="note">산출물이 아니라 <code>memory.md</code>의 <code>## Open questions</code>에서 읽었습니다 —
  엔진이 모든 stage 일지에 두라고 정한 두 번째 미결 대장입니다. 오케스트레이터가 스스로 적은 메모라
  하류 단계와의 계약이 아니고 배정 칸도 없어서, 위 산출물 미결과 <b>합산하지 않습니다</b>.${
    resolved > 0 ? ` 해소 표시가 붙은 ${resolved}건은 제외했습니다.` : ""
  }</p>
  <ul class="dfr-list">${rows}</ul>
</details>`;
}

/**
 * The three ledgers, one row each.
 *
 * This started as a six-tile KPI strip and that was the wrong shape for the content:
 * six numbers side by side in identical tiles read as six comparable measurements of
 * one thing, which is the single claim this panel must not make — the first four
 * partition `items`, and the last two are separate reads that are never summed with
 * them. Three leading zeros also took half the width while 15 · 12 · 28 were squeezed
 * to the right, and the sixth tile wrapped onto a row of its own, taking the divider
 * that was carrying the "these are different" signal with it.
 *
 * A row per ledger fixes all of that by construction: the count, what it is, where it
 * was read from, and — only for the ledger that has owners — the owner breakdown as
 * chips. Zeros stay visible (a `지난 단계 0` is worth reading: nothing has fallen
 * through) but they no longer compete with the totals for the eye.
 */
function ledgerRows(
  d: DashboardModel["deferrals"],
  diaryOpen: number,
  diaryFollowUp: number,
): string {
  const chip = (label: string, n: number, tone: string, tip: string) =>
    `<span class="dfr-chip t-${n > 0 ? tone : "zero"}" title="${esc(tip)}">${esc(
      label,
    )} <b>${n}</b></span>`;

  const rows: string[] = [
    row({
      n: d.items.length,
      // Urgency of the whole ledger is its worst live status, not its size.
      tone:
        d.counts.passed > 0 || d.counts.unassigned > 0
          ? "bad"
          : d.counts.current > 0
            ? "warn"
            : "mute",
      label: "산출물 미결",
      source: "<code>## Assumptions &amp; Open Questions</code>의 미결 항목",
      chips: KPI_ORDER.map((s) => chip(FACE[s].label, d.counts[s], FACE[s].tone, FACE[s].tip)).join(
        "",
      ),
    }),
  ];
  if (d.assumptions.length > 0) {
    rows.push(
      row({
        n: d.assumptions.length,
        tone: "mute",
        label: "확인되지 않은 전제",
        source: "같은 절의 <code>[assumption]</code> 항목",
        chips: chip(
          "배정 없음",
          d.assumptions.length,
          "mute",
          "산문이라 배정 칸이 없습니다 — 사용자가 그 단계 질문지에서 확인해 줄 때까지 전제로 남습니다",
        ),
      }),
    );
  }
  if (diaryOpen > 0) {
    rows.push(
      row({
        n: diaryOpen,
        tone: diaryFollowUp > 0 ? "warn" : "mute",
        label: "stage 일지 미결",
        source: "각 stage <code>memory.md</code>의 <code>## Open questions</code>",
        chips:
          chip("후속 확인", diaryFollowUp, "warn", "문장 자체가 후속 확인·결정을 요구하는 항목") +
          chip(
            "그 외",
            diaryOpen - diaryFollowUp,
            "mute",
            "미결 소절에 적혀 있으나 문장에 후속 신호는 없는 항목 — 소절 자체가 미결 선언이라 그대로 셉니다",
          ),
      }),
    );
  }
  return `<ul class="dfr-ledgers">${rows.join("")}</ul>
<p class="note">세 대장은 <b>서로 다른 읽기</b>입니다 — 배정 칸이 있는 것은 첫 줄뿐이고,
아래 둘은 물어볼 자리가 정해져 있지 않습니다. <b>합산하지 않습니다.</b></p>`;
}

function row(r: {
  n: number;
  tone: string;
  label: string;
  source: string;
  chips: string;
}): string {
  return `<li class="dfr-ledger">
  <span class="dfr-ledger-n t-${r.tone}">${r.n}</span>
  <div class="dfr-ledger-body">
    <div class="dfr-ledger-h">${esc(r.label)} <span class="dfr-ledger-src">${r.source}</span></div>
    <div class="dfr-chips">${r.chips}</div>
  </div>
</li>`;
}

function body(m: DashboardModel): string {
  const d = m.deferrals;
  const diary = diaryOpenBlock(m);
  if (d.sections === 0) {
    return `<p class="note">산출물에 <code>## Assumptions &amp; Open Questions</code> 절이 없습니다 — 이 실행은
    미결 대장을 남기지 않았거나 아직 산출물을 쓰지 않았습니다. (읽은 산출물 ${d.artifacts}개)</p>${diary}`;
  }
  if (d.items.length === 0 && d.assumptions.length === 0) {
    // `emptySections` counts only an explicit `None.`; `sections` counts the heading
    // wherever it appears. A gap between them is a shape this reader cannot parse,
    // and calling that "비어 있음" is the one thing this panel must never say — it is
    // exactly the false all-clear that reading only the table shape used to produce.
    const unread = d.sections - d.emptySections;
    if (unread > 0) {
      return `<p class="note warn">산출물 ${d.sections}곳에 <code>## Assumptions &amp; Open Questions</code>
      절이 있고, 그중 <b>${unread}곳은 이 리더가 아는 모양이 아닙니다</b> — 표(<code>| 항목 | 배정 |</code>)도,
      <code>[assumption]</code> 태그도, <code>**OQ1**</code> 형태의 대장 id 도 없습니다.
      <b>미결이 없다는 뜻이 아니라 읽지 못했다는 뜻입니다.</b>
      명시적으로 <code>None.</code>을 선언한 절은 ${d.emptySections}곳입니다.</p>${diary}`;
    }
    return `<p class="note">${pill(
      "미결 없음",
      "ok",
      "미결 대장 절은 있고 그 안이 비어 있음 — 명시적으로 '없음'을 선언한 상태",
    )} 산출물 ${d.sections}곳의 미결 대장이 모두 <code>None.</code>입니다.</p>${diary}`;
  }

  const diaryOpen = m.diaries.records.filter(
    (r) => r.axis === "openQuestions" && r.questionStatus !== "resolved",
  );
  const diaryFollowUp = diaryOpen.filter((r) => r.questionStatus === "followUp").length;
  const kpis = ledgerRows(d, diaryOpen.length, diaryFollowUp);

  const exits = d.counts.nextCycle + d.counts.outOfScope;
  const lead = `<p class="note">미결 <b>${d.items.length}건</b> · 산출물 ${d.sections}곳에
  <code>## Assumptions &amp; Open Questions</code> 대장이 있습니다 (원시 ${d.rows}행 → 중복 정리 후 ${
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
${diary}
${ownerTable(m)}`;
}

export function renderDeferrals(m: DashboardModel): string {
  return section("미뤄둔 결정", body(m), "deferrals");
}
