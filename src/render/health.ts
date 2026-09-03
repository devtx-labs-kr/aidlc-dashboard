// User-facing decisions and issues, plus the optional raw ledger.
// Hook health stays in the model for diagnostics and freshness calculations but
// is intentionally not exposed as a dashboard card.

import type { DashboardModel } from "../model/types";
import type { DiaryRecord } from "../scan/memory-diary";
import { esc, pill, section, shortTs } from "./common";

function diaryWhere(record: DiaryRecord): string {
  return record.unit ? `${record.unit} / ${record.stage}` : record.stage;
}

interface DiaryKind {
  label: string;
  tone: "ok" | "warn" | "mute";
  tooltip: string;
}

function diaryKind(record: DiaryRecord): DiaryKind {
  if (record.axis === "deviations") {
    return {
      label: "계획 변경",
      tone: "warn",
      tooltip: "실행 중 원래 계획에서 달라진 내용과 그 이유를 기록한 항목",
    };
  }
  if (record.axis === "tradeoffs") {
    return {
      label: "선택 근거",
      tone: "ok",
      tooltip: "여러 대안 사이에서 무엇을 얻고 포기하며 선택했는지 기록한 항목",
    };
  }
  if (record.axis === "interpretations") {
    return {
      label: "해석",
      tone: "mute",
      tooltip: "모호한 요구나 지시를 어떤 의미로 이해했는지 기록한 항목",
    };
  }
  if (record.questionStatus === "resolved") {
    return {
      label: "해결됨",
      tone: "ok",
      tooltip: "이전에 열린 질문이나 이슈가 해결되었음을 표시한 항목",
    };
  }
  if (record.questionStatus === "followUp") {
    return {
      label: "후속 확인",
      tone: "warn",
      tooltip: "아직 확인하거나 결정해야 할 작업이 남은 항목",
    };
  }
  return {
    label: "참고",
    tone: "mute",
    tooltip: "열린 질문이지만 후속 조치나 해결 여부가 명시되지 않은 항목",
  };
}

function diaryItem(record: DiaryRecord): string {
  const kind = diaryKind(record);
  const text = record.text.length > 320 ? `${record.text.slice(0, 320)}…` : record.text;
  return `<li class="diary-item">
  <div class="diary-meta">${pill(kind.label, kind.tone, kind.tooltip)}
    <span class="diary-where">${esc(diaryWhere(record))}</span>
    <span class="diary-time">${esc(shortTs(record.ts))}</span>
    <a class="diary-source" href="/open?rel=${encodeURIComponent(record.rel)}" title="${esc(
      record.rel,
    )} 열기">원문</a>
  </div>
  <div class="diary-text">${esc(text)}</div>
</li>`;
}

function diaryList(records: DiaryRecord[], visible: number): string {
  if (records.length === 0) return `<p class="note">기록 없음.</p>`;
  const shown = records.slice(0, visible);
  const rest = records.slice(visible);
  return `<ul class="diary-list">${shown.map(diaryItem).join("")}</ul>${
    rest.length > 0
      ? `<details class="diary-more"><summary>나머지 ${rest.length}건</summary>
  <ul class="diary-list">${rest.map(diaryItem).join("")}</ul></details>`
      : ""
  }`;
}

interface DiaryStageRollup {
  label: string;
  decision: number;
  deviation: number;
  followUp: number;
  resolved: number;
  note: number;
  latest: string;
}

function diaryStageTable(records: DiaryRecord[]): string {
  const grouped = new Map<string, DiaryStageRollup>();
  for (const record of records) {
    const key = `${record.phase}/${record.unit ?? ""}/${record.stage}`;
    let row = grouped.get(key);
    if (!row) {
      row = {
        label: diaryWhere(record),
        decision: 0,
        deviation: 0,
        followUp: 0,
        resolved: 0,
        note: 0,
        latest: "",
      };
      grouped.set(key, row);
    }
    if (record.axis === "interpretations" || record.axis === "tradeoffs") row.decision++;
    else if (record.axis === "deviations") row.deviation++;
    else if (record.questionStatus === "followUp") row.followUp++;
    else if (record.questionStatus === "resolved") row.resolved++;
    else row.note++;
    if ((record.ts ?? "") > row.latest) row.latest = record.ts ?? "";
  }
  const rows = [...grouped.values()]
    .sort((a, b) => b.latest.localeCompare(a.latest) || a.label.localeCompare(b.label))
    .map((row) => {
      const total = row.decision + row.deviation + row.followUp + row.resolved + row.note;
      return `<tr><th class="g-name">${esc(row.label)}</th>
  <td class="g-n">${row.decision || ""}</td><td class="g-n">${row.deviation || ""}</td>
  <td class="g-n">${row.followUp || ""}</td><td class="g-n">${row.resolved || ""}</td>
  <td class="g-n">${row.note || ""}</td><td class="g-n">${total}</td></tr>`;
    })
    .join("");
  return `<details class="diary-audit"><summary>Stage별 전체 기록 · 정규화 ${records.length}건</summary>
  <div class="diary-table-wrap"><table class="tbl diary-table">
    <thead><tr><th>stage</th><th>결정</th><th>변경</th><th>후속</th><th>해결</th><th>참고</th><th>계</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</details>`;
}

function diaryBody(m: DashboardModel): string {
  const d = m.diaries;
  if (d.stages.length === 0) return `<p class="note">stage 일지(memory.md) 없음.</p>`;
  if (d.records.length === 0) return `<p class="note">기록된 결정이나 후속 이슈 없음.</p>`;

  const newest = (records: DiaryRecord[]) => [...records].reverse();
  const followUps = newest(
    d.records.filter(
      (record) => record.axis === "openQuestions" && record.questionStatus === "followUp",
    ),
  );
  const resolved = newest(
    d.records.filter(
      (record) => record.axis === "openQuestions" && record.questionStatus === "resolved",
    ),
  );
  const decisions = newest(
    d.records.filter((record) => record.axis === "interpretations" || record.axis === "tradeoffs"),
  );
  const deviations = newest(d.records.filter((record) => record.axis === "deviations"));

  const kpis = `<div class="diary-stats">
  <div class="diary-stat ${followUps.length > 0 ? "warn" : "ok"}"><span class="diary-stat-n">${
    followUps.length
  }</span><span class="diary-stat-l">후속 확인</span></div>
  <div class="diary-stat ok"><span class="diary-stat-n">${resolved.length}</span><span class="diary-stat-l">해결 기록</span></div>
  <div class="diary-stat"><span class="diary-stat-n">${deviations.length}</span><span class="diary-stat-l">계획 변경</span></div>
  <div class="diary-stat"><span class="diary-stat-n">${decisions.length}</span><span class="diary-stat-l">결정 근거</span></div>
</div>`;

  const followUpBody =
    followUps.length > 0
      ? diaryList(followUps, 6)
      : `<p class="note">${pill(
          "정리됨",
          "ok",
          "해결 표시 없이 남아 있는 후속 확인 후보가 없음을 의미",
        )} 해결 표시 없이 남은 후속 후보 없음.</p>`;

  return `${kpis}
<div class="diary-focus">
  <h3>후속 확인 후보</h3>
  ${followUpBody}
</div>
<div class="diary-columns">
  <div class="diary-group"><h3>최근 결정</h3>${diaryList(decisions, 4)}</div>
  <div class="diary-group"><h3>최근 계획 변경</h3>${diaryList(deviations, 4)}</div>
</div>
${
  resolved.length > 0
    ? `<details class="diary-resolved"><summary>해결 기록 ${resolved.length}건</summary>${diaryList(
        resolved,
        6,
      )}</details>`
    : ""
}
${diaryStageTable(d.records)}`;
}

function streamBody(m: DashboardModel): string {
  if (m.recentEvents.length === 0) return `<p class="note">감사 기록 비어 있음.</p>`;

  const opts = m.eventCounts
    .map(([k, v]) => `<option value="${esc(k)}">${esc(k)} (${v})</option>`)
    .join("");

  const rows = m.recentEvents
    .map(
      (e) =>
        `<tr data-ev="${esc(e.event)}">
  <td class="ts">${esc(shortTs(e.ts))}</td>
  <td><code class="ev">${esc(e.event)}</code></td>
  <td>${esc(e.unit ? `${e.unit} / ${e.stage ?? ""}` : (e.stage ?? ""))}</td>
  <td class="det">${esc(e.detail && e.detail.length > 160 ? `${e.detail.slice(0, 160)}…` : (e.detail ?? ""))}</td>
</tr>`,
    )
    .join("\n");

  return `<div class="filter-row">
  <label>종류 <select id="ev-filter"><option value="">전체 (${m.totalEvents}건)</option>${opts}</select></label>
  <span class="mute">최근 ${m.recentEvents.length}건 표시 · 전체 ${m.totalEvents}건 · shard ${
    m.health.hooks.length ? "" : ""
  }${esc(String(new Set(m.recentEvents.map((e) => e.shard)).size))}개</span>
</div>
<table class="tbl stream" id="ev-table">
  <thead><tr><th>시각</th><th>이벤트</th><th>stage / unit</th><th>내용</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// Both panels in this module are BUILT but not MOUNTED. Flip a flag to re-mount
// one with no other edit; referencing the builders here (rather than deleting the
// calls) is what keeps them live code the type-checker still covers.
//
// SHOW_STREAM — the raw event list is noise for the people this dashboard is shown to.
//
// SHOW_DIARY — 결정과 이슈 was the decision panel until 미뤄둔 결정 (render/deferrals.ts)
// replaced it. It read `memory.md`, which records what the ORCHESTRATOR thought, and
// on one real run that came to 140 결정 근거 · 63 계획 변경 · 28 후속 확인 — three digits of
// prose in which nothing stated what the run still owed the reader or where it would
// be asked again. The deferral ledger answers that from the engine's own mandated
// section, with an assigned stage per item, so the two panels were not two views of
// one thing: one of them was the question the reader actually had. `m.diaries` stays
// in the model for /api/model, on the same footing as sensors, gates and hook health.
// ONE AXIS OF IT DID COME BACK, and not here: `## Open questions` is mandated in every
// stage's memory.md by the engine's own memory template, and its entries do state a
// debt ("재스캔 비용을 받아들일지 … 결정할 것"). It renders inside 미뤄둔 결정
// (render/deferrals.ts, diaryOpenBlock) beside the other two ledgers, because that is
// the panel answering the question those entries belong to. The other three axes are
// what stays unmounted — mixing them back in is what made this card unreadable.
const SHOW_STREAM = false;
const SHOW_DIARY = false;

export function renderHealth(m: DashboardModel): string {
  return [
    ...(SHOW_DIARY ? [section("결정과 이슈", diaryBody(m), "decisions")] : []),
    ...(SHOW_STREAM ? [section("감사 원장", streamBody(m), "stream")] : []),
  ].join("\n");
}
