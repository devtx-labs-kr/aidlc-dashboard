// Panel (c) — where the wall-clock went.
//
// Every second belongs to one visible bucket: user wait, parked, observed
// execution, or unknown. Unknown is deliberately not painted as execution.

import type { DashboardModel } from "../model/types";
import type { GapSplit, StageEndKind, StageSpan, TimingReport } from "../scan/timing";
import { dur, esc, mins, pill, section, shortTs } from "./common";

/** Track offset+width as percentages of the whole run, for the gantt row. */
function trackGeometry(
  startedAt: string,
  elapsedSec: number,
  runStart: number,
  runSpan: number,
): { left: number; width: number } {
  if (runSpan <= 0) return { left: 0, width: 100 };
  const left = ((Date.parse(startedAt) - runStart) / 1000 / runSpan) * 100;
  const width = (elapsedSec / runSpan) * 100;
  return { left: Math.max(0, left), width: Math.max(0.4, width) };
}

function kindClass(kind: StageEndKind): string {
  if (kind === "completed") return "done";
  if (kind === "skipped") return "skip";
  if (kind === "awaiting-approval") return "await";
  return "live";
}

function ganttRow(s: StageSpan, runStart: number, runSpan: number): string {
  const tip = `${s.stage}\n${shortTs(s.startedAt)} → ${shortTs(s.endedAt)}\n전체 ${mins(
    s.elapsedSec,
  )}분 · 사용자 대기 ${mins(s.humanWaitSec)}분 · 일시중지 ${mins(
    s.parkedSec,
  )}분 · 관측 실행 ${mins(s.observedSec)}분 · 미분류 ${mins(s.unknownSec)}분`;
  const bars = s.segments
    .map((segment) => {
      const g = trackGeometry(segment.startedAt, segment.elapsedSec, runStart, runSpan);
      return `<span class="g-bar ${kindClass(segment.endKind)}" style="left:${g.left.toFixed(
        2,
      )}%;width:${g.width.toFixed(2)}%" title="${esc(tip)}"></span>`;
    })
    .join("");
  // Abbreviated so the column stays one line; the full text is the cell tooltip.
  const load = [
    s.workload.artifacts ? `산출 ${s.workload.artifacts}` : "",
    s.workload.sensors ? `sensor ${s.workload.sensors}` : "",
    s.workload.delegations ? `위임 ${s.workload.delegations}` : "",
    s.workload.humanTurns ? `사람 ${s.workload.humanTurns}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<tr>
  <th class="g-name">${esc(s.stage)}</th>
  <td class="g-track"><div class="g-track-line">${bars}</div></td>
  <td class="g-n">${esc(mins(s.elapsedSec))}</td>
  <td class="g-n wait">${esc(mins(s.humanWaitSec))}</td>
  <td class="g-n parked">${esc(mins(s.parkedSec))}</td>
  <td class="g-n work">${esc(mins(s.observedSec))}</td>
  <td class="g-n unknown">${esc(mins(s.unknownSec))}</td>
  <td class="g-load" title="${esc(load)}">${esc(load)}</td>
</tr>`;
}

function pct(value: number, total: number): string {
  return total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
}

function breakdown(split: GapSplit, total: number): string {
  const parts = [
    ["wait", "사용자 대기", split.humanWaitSec],
    ["parked", "일시중지", split.parkedSec],
    ["observed", "관측 실행", split.observedSec],
    ["unknown", "미분류", split.unknownSec],
  ] as const;
  return `<div class="time-breakdown" role="img" aria-label="${esc(
    parts.map(([, label, seconds]) => `${label} ${pct(seconds, total)}%`).join(", "),
  )}">
${parts
  .filter(([, , seconds]) => seconds > 0)
  .map(
    ([kind, label, seconds]) =>
      `<span class="${kind}" style="width:${pct(seconds, total)}%" title="${esc(
        `${label} ${dur(seconds)} (${pct(seconds, total)}%)`,
      )}"></span>`,
  )
  .join("")}
</div>
<div class="time-legend">
${parts
  .map(
    ([kind, label, seconds]) =>
      `<span><i class="${kind}"></i>${label} <b>${esc(pct(seconds, total))}%</b></span>`,
  )
  .join("")}
</div>`;
}

/**
 * The per-worker table, shown only for a parallel run.
 *
 * WHY BOTH NUMBERS ARE KEPT. The merged and per-worker idle figures measure
 * different things, and NEITHER dominates the other — both directions were
 * measured:
 *
 *   - merged UNDER-reports when clones overlap: while A waits at a gate, B's
 *     events land inside that gap, so the gate→HUMAN_TURN pair is no longer
 *     adjacent and the wait reads as work. On a real 4-developer run this lost
 *     69% of the waiting (819 min merged vs 2,632 min per-worker).
 *   - merged OVER-reports at a handoff: A's SESSION_ENDED followed 45 min later
 *     by B's SESSION_STARTED is a real team-wide pause, but it belongs to neither
 *     shard's own timeline, so per-worker misses it entirely.
 *
 * So: merged idle = "nobody on the team was working"; per-worker idle = "how long
 * each person waited". Both are shown, labelled for what they are, and the delta
 * is described in whichever direction it actually falls.
 */
function workerTable(t: TimingReport): string {
  if (!t.parallel) return "";

  const rows = t.workers
    .map((w) => {
      const lead = w.gatesApproved > 0;
      return `<tr>
  <th class="g-name">${esc(w.label)}${lead ? ' <span class="tag-lead" title="승인 게이트를 통과시킨 = 워크플로를 주도한 clone">주도</span>' : ""}</th>
  <td class="g-n">${w.events}</td>
  <td class="g-n">${esc(mins(w.elapsedSec))}</td>
  <td class="g-n wait">${esc(mins(w.humanWaitSec))}</td>
  <td class="g-n parked">${esc(mins(w.parkedSec))}</td>
  <td class="g-n work">${esc(mins(w.observedSec))}</td>
  <td class="g-n unknown">${esc(mins(w.unknownSec))}</td>
  <td class="g-n">${w.gatesApproved || ""}</td>
  <td class="g-load" title="${esc(w.stages.join(", "))}">${esc(w.stages.slice(0, 2).join(", "))}</td>
  <td class="g-n" title="${esc(w.units.join(", ") || "감사 기록에 유닛 귀속 없음")}">${w.units.length || "—"}</td>
</tr>`;
    })
    .join("\n");

  const par = t.parallelism;
  const delta = t.personIdleSec - t.total.idleSec;
  // The two figures can differ in either direction — see the note above.
  const deltaNote =
    delta > 60
      ? `합친 기록에서는 남의 이벤트가 내 대기를 메워 <b>${esc(dur(delta))} 만큼 덜 잡힘</b>.`
      : delta < -60
        ? `반대로 합친 기록이 <b>${esc(dur(-delta))} 더 많음</b> — clone 간 인계 공백(한 사람이 끝내고
           다음 사람이 시작하기까지)은 팀 전체로는 멈춘 시간이지만 개인 타임라인에는 부재.`
        : "두 수치가 거의 같음 — clone 들이 시간상 거의 겹치지 않았다는 뜻.";

  return `<details open><summary>작업자별 분해 — clone ${t.workers.length}개 (병렬 개발)</summary>
<div class="worker-stats">
  <span><b>${esc(dur(t.personElapsedSec))}</b> 사람-시간 합</span>
  <span><b>${esc(dur(t.personHumanWaitSec))}</b> 사용자 대기</span>
  <span><b>${esc(dur(t.personParkedSec))}</b> 일시중지</span>
  <span><b>${esc(dur(t.personObservedSec))}</b> 관측 실행</span>
  <span><b>${esc(dur(t.personUnknownSec))}</b> 미분류</span>
  <span><b>${par ? `${esc(par.toFixed(2))}×` : "—"}</b> 실효 병렬도</span>
</div>
<div class="timeline-table-wrap"><table class="tbl">
  <thead><tr><th>clone</th><th>이벤트</th><th>구간(분)</th><th>사용자 대기</th><th>중지</th><th>관측 실행</th><th>미분류</th><th>게이트</th><th>주 stage</th><th>유닛</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">각 행은 <b>그 clone 의 타임라인만</b> 보고 계산 = "각 사람이 얼마나 기다렸나".
  위쪽 팀 단위 중지·대기 합(${esc(dur(t.total.idleSec))})은 전 기록을 한 줄로 합친 값.
  ${deltaNote}</p>
<p class="note">실효 병렬도 = 사람-시간 합 ÷ 팀 벽시계. clone 이 ${t.workers.length}개여도 실제로 겹쳐 일한
  정도는 ${par ? esc(par.toFixed(2)) : "?"}배.</p>
<p class="note">⚠️유닛 열이 "—"인 clone 은 감사 기록의 <code>Output path</code> 가 산출물이 아니라 코드 경로여서
  유닛 역추적 불가 — 담당 stage 까지만 확실.</p>
</details>`;
}

function body(m: DashboardModel): string {
  const t = m.timing;
  if (t.stages.length === 0 || !t.firstTs)
    return `<p class="note">감사 기록에 stage 구간 없음.</p>`;

  const runStart = Date.parse(t.firstTs);
  const runSpan = t.elapsedSec;

  // On a parallel run the merged split is not a per-person figure.
  const mergedNote = t.parallel
    ? `<p class="note warn">clone ${t.workers.length}개 병합 기록 — 위 분류는 전 기록을 한 줄로 합친
       <b>팀 단위</b> 수치. 개인별 시간은 <b>작업자별 분해</b> 참조.</p>`
    : "";

  const kpis = `<div class="time-stats">
  <div><span class="time-stat-n">${esc(dur(runSpan))}</span><span class="time-stat-l">${
    t.parallel ? "팀 벽시계" : "전체 경과"
  }</span></div>
  <div class="wait"><span class="time-stat-n">${esc(
    dur(t.total.humanWaitSec),
  )}</span><span class="time-stat-l">사용자 대기</span></div>
  <div class="parked"><span class="time-stat-n">${esc(
    dur(t.total.parkedSec),
  )}</span><span class="time-stat-l">일시중지</span></div>
  <div class="observed"><span class="time-stat-n">${esc(
    dur(t.total.observedSec),
  )}</span><span class="time-stat-l">관측 실행</span></div>
  <div class="unknown"><span class="time-stat-n">${esc(
    dur(t.total.unknownSec),
  )}</span><span class="time-stat-l">미분류</span></div>
</div>
${breakdown(t.total, runSpan)}
<p class="note">${esc(shortTs(t.firstTs))} ~ ${esc(shortTs(t.lastTs))}${
    t.parallel ? ` · ${pill(`clone ${t.workers.length}개`, "warn")}` : ""
  } · 위임 ${esc(dur(t.total.delegatedSec))}</p>
${mergedNote}
${workerTable(t)}`;

  const rows = t.stages.map((s) => ganttRow(s, runStart, runSpan)).join("\n");

  // The long unclassified gaps, surfaced rather than folded silently into WORK.
  const unknown = [...t.total.unknown]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 12)
    .map(
      (s) =>
        `<li><b>${esc(mins(s.seconds))}분</b> <code>${esc(s.fromEvent)} → ${esc(s.toEvent)}</code> <span class="mute">${esc(
          shortTs(s.at),
        )}</span></li>`,
    )
    .join("");

  return `${kpis}
<div class="timeline-table-wrap"><table class="tbl gantt">
  <thead><tr><th>stage</th><th class="g-track-h">진입 구간</th><th>전체(분)</th><th>사용자 대기</th><th>중지</th><th>관측 실행</th><th>미분류</th><th>작업량</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">막대는 실제 Stage 진입 구간. 청록=완료 · 회색=건너뜀 · 주황=승인대기 · 파랑=진행중.</p>
<p class="note warn">관측 실행은 5분 미만 이벤트 간격과 명시적 위임 구간의 합이며, 순수 모델·CPU 실행 시간이 아님.</p>
${
  unknown
    ? `<details><summary>미분류 5분+ 공백 ${t.total.unknown.length}건 (상위 12)</summary><ul class="gaps">${unknown}</ul>
<p class="note">대기·중지·실행 어느 쪽으로도 확정할 수 없어 실행 시간에서 분리한 구간.</p></details>`
    : ""
}
${
  t.total.inferredParkSec > 0 || t.total.parkAnomalies > 0
    ? `<p class="note warn">일시중지 중 ${esc(
        dur(t.total.inferredParkSec),
      )}은 session 재개 이벤트로 추정${
        t.total.parkAnomalies > 0 ? ` · park 마커 이상 ${t.total.parkAnomalies}건` : ""
      }.</p>`
    : ""
}`;
}

export function renderTimeline(m: DashboardModel): string {
  return section("시간 분석", body(m), "timeline");
}
