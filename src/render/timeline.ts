// Panel (c) — where the wall-clock went.
//
// Every second belongs to one visible bucket: user wait, parked, observed
// execution, or unknown. Unknown is deliberately not painted as execution.

import type { DashboardModel } from "../model/types";
import type { GapSplit, StageEndKind, StageSpan, TimingReport } from "../scan/timing";
import { esc, hours, mins, pill, section, shortTs } from "./common";

/** Track offset+width as percentages of the whole run, for the gantt row. */
function trackGeometry(
  startedAt: string,
  elapsedSec: number,
  runStart: number,
  runSpan: number,
): { left: number; width: number; tick: boolean } {
  if (runSpan <= 0) return { left: 0, width: 100, tick: false };
  const left = ((Date.parse(startedAt) - runStart) / 1000 / runSpan) * 100;
  const width = (elapsedSec / runSpan) * 100;
  // A 0-second stage is normal (the three bootstrap stages stamp STARTED and
  // COMPLETED in the same second), but the 0.4% floor that keeps a bar visible is
  // worth 31 minutes on a 130h run — enough to make `workspace-scaffold` (0.0min) as
  // wide as `scope-definition` (29.9min), and to stack the three bootstrap bars into
  // one indistinguishable blob. So a zero-length stage gets a tick, not a bar.
  if (elapsedSec <= 0) return { left: Math.max(0, left), width: 0, tick: true };
  return { left: Math.max(0, left), width: Math.max(0.4, width), tick: false };
}

function kindClass(kind: StageEndKind): string {
  if (kind === "completed") return "done";
  if (kind === "skipped") return "skip";
  if (kind === "awaiting-approval") return "await";
  if (kind === "superseded") return "sup";
  return "live";
}

const KIND_LABEL: Record<StageEndKind, string> = {
  completed: "완료",
  skipped: "건너뜀",
  "awaiting-approval": "승인 대기",
  "in-flight": "진행 중",
  superseded: "재진입으로 대체",
};

/** One segment's own split, so the tooltip describes the bar under the cursor. */
function segmentTip(
  stage: string,
  g: GapSplit & { startedAt: string; endedAt: string; endKind: StageEndKind },
): string {
  return `${stage} — ${KIND_LABEL[g.endKind]}\n${shortTs(g.startedAt)} → ${shortTs(
    g.endedAt,
  )}\n사용자 대기 ${mins(g.humanWaitSec)}분 · 일시중지 ${mins(g.parkedSec)}분 · 관측 실행 ${mins(
    g.observedSec,
  )}분 · 대화 ${mins(g.conversationSec)}분 · 미분류 ${mins(g.unknownSec)}분`;
}

function ganttRow(s: StageSpan, runStart: number, runSpan: number): string {
  const bars = s.segments
    .map((segment) => {
      const g = trackGeometry(segment.startedAt, segment.elapsedSec, runStart, runSpan);
      // FILL THE BAR WITH THE SPLIT, not with the end kind. Bar width is calendar
      // occupancy, and on a real run the widest stage (30.6% of the track) was 93.8%
      // parked and ranked 16th of 22 in observed execution — so colouring by end kind
      // made a night of waiting look identical to a night of work. End kind moves to
      // the outline; the four buckets are the fill.
      const total =
        segment.humanWaitSec +
        segment.parkedSec +
        segment.observedSec +
        segment.conversationSec +
        segment.unknownSec;
      const fill =
        total > 0
          ? (
              [
                ["wait", segment.humanWaitSec],
                ["parked", segment.parkedSec],
                ["observed", segment.observedSec],
                ["conv", segment.conversationSec],
                ["unknown", segment.unknownSec],
              ] as const
            )
              .filter(([, sec]) => sec > 0)
              .map(
                ([kind, sec]) =>
                  `<i class="${kind}" style="width:${((sec / total) * 100).toFixed(2)}%"></i>`,
              )
              .join("")
          : "";
      if (g.tick) {
        return `<span class="g-tick k-${kindClass(segment.endKind)}" style="left:${g.left.toFixed(
          2,
        )}%" title="${esc(`${segmentTip(s.stage, segment)}\n0초 — 같은 초에 시작·완료`)}"></span>`;
      }
      return `<span class="g-bar k-${kindClass(segment.endKind)}" style="left:${g.left.toFixed(
        2,
      )}%;width:${g.width.toFixed(2)}%" title="${esc(segmentTip(s.stage, segment))}">${fill}</span>`;
    })
    .join("");
  // Abbreviated so the column stays one line; the full text is the cell tooltip.
  const load = [
    s.workload.artifacts ? `산출 ${s.workload.artifacts}` : "",
    s.workload.sensors ? `sensor ${s.workload.sensors}` : "",
    // Sensor failures were tallied and then dropped here; on a real run that hid 84.
    s.workload.sensorFailures ? `실패 ${s.workload.sensorFailures}` : "",
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
  <td class="g-n conv">${esc(mins(s.conversationSec))}</td>
  <td class="g-n unknown">${esc(mins(s.unknownSec))}</td>
  <td class="g-n attn"><b>${esc(mins(s.workSec))}</b></td>
  <td class="g-load" title="${esc(load)}">${esc(load)}</td>
</tr>`;
}

function pct(value: number, total: number): string {
  return total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
}

/**
 * Rework — the ledger's most valuable signal and, until now, the one the panel was
 * silent about. `m.gates` counted the events and no render module read it, so a run
 * with 11 rejections and 18.9h of redone work looked identical to one with none.
 *
 * The rejection reason is shown verbatim: it is a human's own sentence about what was
 * wrong, which no aggregate can replace.
 */
function reworkBlock(m: DashboardModel, classifiedSec: number): string {
  const r = m.rework;
  if (r.rejected === 0 && r.revisions === 0 && r.jumps === 0) {
    return `<p class="note">반려·수정 기록 없음 — 모든 관문을 한 번에 통과.</p>`;
  }
  const share = classifiedSec > 0 ? pct(r.reworkSec, classifiedSec) : "0.0";
  const rows = r.stages
    .map((s) => {
      return `<tr>
  <th class="g-name">${esc(s.stage)}${
    s.settled
      ? ""
      : '<span class="prov-mark" title="아직 승인되지 않음 — 시간은 계속 늘어남">~</span>'
  }</th>
  <td class="g-n">${esc(String(s.submissions || "—"))}</td>
  <td class="g-n unknown"><b>${esc(String(s.rejections))}</b></td>
  <td class="g-n">${esc(String(s.revisions || "—"))}${
    s.revisionHigh ? `<span class="mute"> /${esc(String(s.revisionHigh))}</span>` : ""
  }</td>
  <td class="g-n"><b>${esc(hours(s.reworkSec))}</b></td>
  <td class="g-n">${s.feedback.length > 0 ? `${s.feedback.length}건` : "—"}</td>
</tr>`;
    })
    .join("\n");

  // The reason goes UNDER the table, at full card width. It is a human's dense
  // paragraph — 1042 characters on one measured rejection, no line breaks — and a
  // table cell competing with five numeric columns is the wrong container for it
  // twice over: the cell clamped it visually AND the renderer sliced it at 400
  // characters, dropping 642 of those 1042 without a mark to say so. "Shown
  // verbatim" has to mean the whole thing, so nothing is sliced here.
  const reasons = r.stages
    .filter((s) => s.feedback.length > 0)
    .flatMap((s) =>
      s.feedback.map(
        (f) => `<li class="why-item">
  <div class="why-head"><b>${esc(s.stage)}</b><span class="mute">${esc(shortTs(f.at))}</span></div>
  <p class="why-text">${esc(f.text)}</p>
</li>`,
      ),
    )
    .join("");
  const reasonBlock = reasons
    ? `<details class="why-all"><summary>사람이 적은 반려 사유 ${r.stages.reduce(
        (n, s) => n + s.feedback.length,
        0,
      )}건 — 전문</summary>
  <p class="note">원장에서 <code>**Feedback**</code>을 그대로 옮긴 것입니다. 반려·수정 쌍에서 중복은 제거했고
  stage 당 최대 6건까지 보관합니다 — 요약하거나 자르지 않습니다.</p>
  <ul class="why-list">${reasons}</ul>
</details>`
    : "";

  return `<div class="time-stats">
  <div class="unknown"><span class="time-stat-n">${esc(hours(r.reworkSec))}</span><span class="time-stat-l">재작업 ${esc(share)}%</span></div>
  <div><span class="time-stat-n">${r.rejected}</span><span class="time-stat-l">반려</span></div>
  <div><span class="time-stat-n">${r.approved}</span><span class="time-stat-l">승인</span></div>
  <div><span class="time-stat-n">${r.revisions}</span><span class="time-stat-l">수정 회차</span></div>
  ${r.jumps ? `<div><span class="time-stat-n">${r.jumps}</span><span class="time-stat-l">stage 점프</span></div>` : ""}
  ${r.freezeBlocked ? `<div><span class="time-stat-n">${r.freezeBlocked}</span><span class="time-stat-l">검토중 편집 차단</span></div>` : ""}
</div>
<div class="timeline-table-wrap"><table class="tbl">
  <thead><tr><th>stage</th><th title="STAGE_AWAITING_APPROVAL — 관문에 올린 횟수">제출</th><th>반려</th><th title="수정 회차 / state.md 의 누적 Revision count">수정</th><th title="첫 반려 → 마지막 승인">재작업</th><th title="사람이 적은 반려 사유 — 전문은 표 아래에 있습니다">사유</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
${reasonBlock}
<p class="note">재작업 = <b>첫 반려부터 마지막 승인까지</b>. 두 번 반려된 stage 는 그 사이 승인까지 포함한
  "아직 받아들여지지 않은 시간"이며, 회차별 합이 아닙니다 — 원장에 수정 회차의 종료 표시가 없습니다.
  ${share}% 는 분류 대상 구간(${esc(hours(classifiedSec))}) 기준.${
    r.provisional ? " <b>~</b> 표시 stage 는 아직 승인 전이라 계속 늘어납니다." : ""
  }</p>`;
}

/**
 * The five buckets: one bar plus a legend that carries BOTH the hours and the share.
 *
 * The hours used to live in a tile strip above the bar — six equal tiles holding the
 * window total and its five parts, which made the whole look like a sixth part and
 * invited an addition that does not work (the five sum to the CLASSIFIED span, 52.1h,
 * not to the 57.2h window; the 4.7h of 무기록 is in neither). The tiles also duplicated
 * this legend, which already listed all five, and the sixth tile wrapped onto a row of
 * its own. So the total is now a headline (it is the denominator, not a part) and the
 * hours moved down here, next to the share they belong to.
 */
function breakdown(split: GapSplit, total: number): string {
  const parts = [
    ["wait", "사용자 대기", split.humanWaitSec, "관문·질문이 열린 뒤 사람이 답하기까지"],
    ["parked", "일시중지", split.parkedSec, "present 한 모든 사본이 park 상태였던 구간"],
    [
      "observed",
      "관측 실행",
      split.observedSec,
      "5분 미만 이벤트 간격과 명시적 위임 구간의 합 — 순수 모델·CPU 실행 시간이 아닙니다",
    ],
    [
      "conv",
      "대화",
      split.conversationSec,
      "한 사본의 HUMAN_TURN 에서 바로 그 사본의 다음 HUMAN_TURN 까지. 엔진의 대화 응답(감사 기록을 남기지 않음)과 사람이 읽고 입력한 시간이 함께 들어 있고 원장에 그 경계가 없어, 대기도 실행도 아닌 자기 몫으로 둡니다",
    ],
    [
      "unknown",
      "미분류",
      split.unknownSec,
      "5분 이상인데 신뢰할 만한 마커가 없는 구간 — 실행으로 칠하지 않고 남겨 둡니다",
    ],
  ] as const;
  return `<div class="time-breakdown" role="img" aria-label="${esc(
    parts.map(([, label, seconds]) => `${label} ${pct(seconds, total)}%`).join(", "),
  )}">
${parts
  .filter(([, , seconds]) => seconds > 0)
  .map(
    ([kind, label, seconds]) =>
      `<span class="${kind}" style="width:${pct(seconds, total)}%" title="${esc(
        `${label} ${hours(seconds)} (${pct(seconds, total)}%)`,
      )}"></span>`,
  )
  .join("")}
</div>
<div class="time-legend">
${parts
  .map(
    ([kind, label, seconds, tip]) =>
      `<span class="lgi" title="${esc(tip)}"><i class="${kind}"></i><b class="${kind}">${esc(
        hours(seconds),
      )}</b> ${esc(label)} <span class="mute">${esc(pct(seconds, total))}%</span></span>`,
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
  <td class="g-n conv">${esc(mins(w.conversationSec))}</td>
  <td class="g-n unknown">${esc(mins(w.unknownSec))}</td>
  <td class="g-n">${w.gatesApproved || ""}</td>
  <td class="g-load" title="${esc(w.stages.join(", "))}">${esc(w.stages.slice(0, 2).join(", "))}</td>
  <td class="g-n" title="${esc(w.units.join(", ") || "감사 기록에 유닛 귀속 없음")}">${w.units.length || "—"}</td>
</tr>`;
    })
    .join("\n");

  const par = t.parallelism;
  const delta = t.personIdleSec - t.total.idleSec;
  // WHY THE TWO FIGURES DIFFER, stated from what was measured rather than assumed.
  // The old wording blamed interleaving ("someone else's events filled my wait")
  // unconditionally; on a run whose clones never overlap that is impossible, and the
  // real cause there is the handover gap. So the reason is chosen by overlap.
  const deltaNote =
    Math.abs(delta) <= 60
      ? "두 수치가 거의 같음."
      : t.overlapSec > 0
        ? delta > 0
          ? `합친 기록에서는 남의 이벤트가 내 대기를 메워 <b>${esc(hours(delta))} 만큼 덜 잡힘</b>
             (clone 들이 ${esc(hours(t.overlapSec))} 겹쳐 일했다).`
          : `합친 기록이 <b>${esc(hours(-delta))} 더 많음</b> — 겹치지 않은 인계 공백은 팀으로는 멈춘
             시간이지만 개인 타임라인에는 부재.`
        : delta > 0
          ? `차이 <b>${esc(hours(delta))}</b> 는 겹침이 아니라 인계 때문 — clone 들이 시간상 전혀 겹치지
             않으므로(겹침 0), 한 clone 이 park 한 구간을 팀 단위로는 다른 clone 의 부재로 볼 수 없다.`
          : `합친 기록이 <b>${esc(hours(-delta))} 더 많음</b> — clone 간 인계 공백
             (${esc(hours(t.handoverSec))})은 팀으로는 멈춘 시간이지만 개인 타임라인에는 부재.`;

  // "병렬" is a claim about time, so it is made only when the windows actually
  // overlap. Measured on a real 3-shard run: 0 overlap, i.e. a sequential handover.
  const shapeLabel =
    t.overlapSec > 0
      ? `clone ${t.clones}개 · 겹쳐 일한 시간 ${esc(hours(t.overlapSec))}`
      : `clone ${t.clones}개 · 순차 인계(겹침 없음)${
          t.handoverSec > 60 ? ` · 인계 공백 ${esc(hours(t.handoverSec))}` : ""
        }`;
  const hostNote =
    t.workers.length > t.clones
      ? `<p class="note">기록 ${t.workers.length}개 중 일부는 <b>같은 작업 사본</b>이 다른 호스트 이름으로
         남긴 것 — 사본 수는 ${t.clones}개다.</p>`
      : "";
  const parkedOut = t.workers.filter((w) => w.endedParked);

  return `<details open><summary>작업자별 분해 — ${shapeLabel}</summary>
<div class="worker-stats">
  <span><b>${esc(hours(t.personElapsedSec))}</b> 사람-시간 합</span>
  <span><b>${esc(hours(t.personHumanWaitSec))}</b> 사용자 대기</span>
  <span><b>${esc(hours(t.personParkedSec))}</b> 일시중지</span>
  <span><b>${esc(hours(t.personObservedSec))}</b> 관측 실행</span>
  <span><b>${esc(hours(t.personConversationSec))}</b> 대화</span>
  <span><b>${esc(hours(t.personUnknownSec))}</b> 미분류</span>
  ${par ? `<span><b>${esc(par.toFixed(2))}×</b> 실효 병렬도</span>` : ""}
</div>
<div class="timeline-table-wrap"><table class="tbl">
  <thead><tr><th>clone</th><th>이벤트</th><th>구간(분)</th><th>사용자 대기</th><th>중지</th><th>관측 실행</th><th>대화</th><th>미분류</th><th>게이트</th><th>주 stage</th><th>유닛</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">각 행은 <b>그 clone 의 타임라인만</b> 보고 계산 = "각 사람이 얼마나 기다렸나".
  위쪽 팀 단위 중지·대기 합(${esc(hours(t.total.idleSec))})은 전 기록을 한 줄로 합친 값.
  ${deltaNote}</p>
${hostNote}
${
  parkedOut.length
    ? `<p class="note warn">${parkedOut
        .map((w) => `<b>${esc(w.label)}</b> 는 ${esc(shortTs(w.lastTs))} 에 park 상태로 끝남`)
        .join(" · ")} — 되돌아오지 않은 기록이다.</p>`
    : ""
}
${
  par
    ? `<p class="note">실효 병렬도 = 사람-시간 합 ÷ 팀 벽시계. 겹쳐 일한 시간이 있을 때만 의미가 있어
       겹침이 0이면 표시하지 않는다.</p>`
    : ""
}
<p class="note">⚠️유닛 열이 "—"인 clone 은 감사 기록의 <code>Output path</code> 가 산출물이 아니라 코드 경로여서
  유닛 역추적 불가 — 담당 stage 까지만 확실.</p>
</details>`;
}

/**
 * A time axis for the Gantt track, plus the read clock at the right edge.
 *
 * Without it the last bar always touches the right edge, which reads as "the run
 * finished here" on a run that is merely open — and the stretch after the last event
 * (which bars no longer cover, since 1차) had nothing to name it.
 */
function trackAxis(t: TimingReport, runStart: number, runSpan: number): string {
  if (!t.firstTs || runSpan <= 0) return "";
  const ticks = 4;
  const marks: string[] = [];
  for (let i = 0; i <= ticks; i++) {
    const at = new Date(runStart + (runSpan * 1000 * i) / ticks);
    const label = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    marks.push(
      `<span class="ax-t" style="left:${((i / ticks) * 100).toFixed(2)}%">${esc(label)}</span>`,
    );
  }
  // The silence gets its own shaded band so it is visibly outside the bars.
  const silence =
    t.sinceLastEventSec > 0
      ? `<span class="ax-gap" style="left:${(
          ((runSpan - t.sinceLastEventSec) / runSpan) * 100
        ).toFixed(2)}%;width:${((t.sinceLastEventSec / runSpan) * 100).toFixed(2)}%" title="${esc(
          `마지막 기록 이후 ${hours(t.sinceLastEventSec)} — 기록이 없어 분류하지 않는 구간`,
        )}"></span>`
      : "";
  return `<div class="g-axis">${silence}${marks.join("")}</div>`;
}

function body(m: DashboardModel): string {
  const t = m.timing;
  if (t.stages.length === 0 || !t.firstTs)
    return `<p class="note">감사 기록에 stage 구간 없음.</p>`;

  const runStart = Date.parse(t.firstTs);
  const runSpan = t.elapsedSec;

  // WHAT IS THE RUN WAITING ON — said out loud rather than left to be inferred from
  // the rightmost bar. `awaitingStage` is undefined on a run that never emitted
  // STAGE_AWAITING_APPROVAL for its current stage, and silence there is what made a
  // reader guess from bar colour.
  const inFlight = t.stages.filter((s) => s.endKind === "in-flight");
  const nowLine = `<p class="note">${
    inFlight.length
      ? `진행 중 ${inFlight
          .map((s) => `<b>${esc(s.stage)}</b> ${esc(hours(s.elapsedSec))}`)
          .join(" · ")}`
      : "진행 중인 stage 없음"
  } · ${
    t.awaitingStage
      ? `승인 대기 <b>${esc(t.awaitingStage)}</b>`
      : '승인 대기 없음<span class="mute"> (지금 관문에서 승인을 기다리는 stage 가 없다는 뜻 — 과거 제출 이력은 아래 재작업 표)</span>'
  }${m.rework.provisional ? " · 반려 후 승인 전인 stage 있음" : ""}</p>`;

  // On a multi-clone run the merged split is not a per-person figure.
  const mergedNote = t.parallel
    ? `<p class="note warn">기록 ${t.workers.length}개(사본 ${t.clones}개) 병합 — 위 분류는 전 기록을 한 줄로
       합친 <b>팀 단위</b> 수치. 개인별 시간은 <b>작업자별 분해</b> 참조.</p>`
    : "";

  // The window total is the DENOMINATOR of everything below it, not a sixth bucket, so
  // it stands alone. `분류 대상` is stated beside it because that — not the window — is
  // what the percentages divide by. The gap between the two is the 무기록 stretch, and
  // that is named ONCE, in the date-range note below: the pill lives next to the last
  // event, which is what it is about. Saying it here as well put the same fact twice
  // within five lines. The number still has to be stated somewhere — an open run's
  // window grows on every poll while the ledger does not — but once is enough.
  const classified = runSpan - t.sinceLastEventSec;
  const kpis = `<div class="time-head">
  <span class="time-head-n" title="${esc(
    t.sinceLastEventSec > 0
      ? `첫 기록 → 지금. 마지막 기록 이후 ${hours(t.sinceLastEventSec)} 은 아래 분류에 포함되지 않는다(기록이 없어 분류할 수 없음).`
      : "첫 기록 → 마지막 기록",
  )}">${esc(hours(runSpan))}</span>
  <span class="time-head-l">${t.parallel ? "팀 벽시계" : "전체 경과"}</span>
  <span class="time-head-sub">아래 비율의 기준은 <b>분류 대상 ${esc(hours(classified))}</b></span>
</div>
${
  // The percentages are OF THE CLASSIFIED SPAN, not of the window: nothing past the
  // last event is classified, so dividing by the window would make the five shares
  // shrink every poll on a quiet tree and never reach 100%.
  breakdown(t.total, classified)
}
<p class="note">${esc(shortTs(t.firstTs))} ~ ${esc(shortTs(t.lastEventTs ?? t.lastTs))}${
    // The window of an open run ends at the read clock, so it keeps growing while
    // nothing happens — name that stretch instead of folding it into the span.
    t.sinceLastEventSec > 0
      ? ` · ${pill(`마지막 기록 이후 ${hours(t.sinceLastEventSec)} 무기록`, "warn")}`
      : ""
  }${t.parallel ? ` · ${pill(`사본 ${t.clones}개`, "warn")}` : ""} · 위임 ${esc(
    hours(t.total.delegatedSec),
  )}</p>
${nowLine}
${mergedNote}
<details${m.rework.rejected > 0 ? " open" : ""}><summary>재작업 — 반려 ${
    m.rework.rejected
  }건 · ${esc(hours(m.rework.reworkSec))}</summary>
${reworkBlock(m, runSpan - t.sinceLastEventSec)}
</details>
${workerTable(t)}`;

  const rows = t.stages.map((s) => ganttRow(s, runStart, runSpan)).join("\n");

  // The long unclassified gaps, surfaced rather than folded silently into WORK.
  // WHICH STAGE WAS THIS GAP IN. The span itself carries only its two event names, so
  // "18 minutes between two artifact writes" was unactionable — the reader could not
  // tell which part of the run to go look at. The stage whose segment contains the
  // timestamp is derivable from data already on the page, so derive it.
  const stageAt = (ts: string): string | undefined =>
    t.stages.find((s) => s.segments.some((g) => ts >= g.startedAt && ts <= g.endedAt))?.stage;
  const unknown = [...t.total.unknown]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 12)
    .map((s) => {
      const stage = stageAt(s.at);
      return `<li><b>${esc(mins(s.seconds))}분</b> ${
        stage ? `<span class="g-where">${esc(stage)}</span>` : ""
      } <code>${esc(s.fromEvent)} → ${esc(s.toEvent)}</code> <span class="mute">${esc(
        shortTs(s.at),
      )}</span></li>`;
    })
    .join("");

  return `${kpis}
<div class="timeline-table-wrap"><table class="tbl gantt">
  <thead><tr><th>stage</th><th class="g-track-h">진입 구간${trackAxis(t, runStart, runSpan)}</th><th>전체(분)</th><th>사용자 대기</th><th>중지</th><th>관측 실행</th><th title="사람 턴에서 바로 다음 사람 턴까지 — 엔진의 대화 응답과 사람이 읽고 입력한 시간이 섞여 있어 어느 쪽으로도 계상하지 않는다.">대화</th><th>미분류</th><th title="관측 실행 + 미분류 — 사람 대기·중지·대화를 뺀 시간. 실행 시간이 아니라 '대기로 설명되지 않는 시간'이며, 어느 stage가 비쌌는지는 전체(분)보다 이 열이 답한다.">작업 추정</th><th>작업량</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">막대 <b>길이</b>는 달력 점유, <b>내부 색</b>은 그 구간의 분류 —
  <i class="lg wait"></i>대기 · <i class="lg parked"></i>중지 · <i class="lg observed"></i>관측 ·
  <i class="lg conv"></i>대화 · <i class="lg unknown"></i>미분류. 테두리는 종료 방식: 청록=완료 · 회색=건너뜀 · 주황=승인대기 ·
  파랑=진행중 · 점선=재진입으로 대체(그 시도는 끝났고 다시 시작됨). 0초 stage 는 막대가 아니라 눈금.
  <b>어느 stage 가 비쌌는지는 길이가 아니라 「작업 추정」 열로 읽으세요</b> — 가장 긴 막대가 대기로만 채워질 수 있습니다.</p>
<p class="note warn">관측 실행은 5분 미만 이벤트 간격과 명시적 위임 구간의 합이며, 순수 모델·CPU 실행 시간이 아님.
  <b>대화</b>는 사람 턴에서 바로 다음 사람 턴까지 — 엔진의 대화 응답은 감사 기록을 남기지 않으므로 그 구간에는
  엔진 작업과 사람이 읽고 입력한 시간이 함께 들어 있고, 원장에 경계가 없어 <b>어느 쪽으로도 계상하지 않습니다</b>.</p>
${
  unknown
    ? `<details><summary>미분류 5분+ 공백 ${t.total.unknown.length}건 (상위 12)</summary><ul class="gaps">${unknown}</ul>
<p class="note">대기·중지·실행 어느 쪽으로도 확정할 수 없어 실행 시간에서 분리한 구간.</p></details>`
    : ""
}
${
  t.total.inferredParkSec > 0 || t.total.parkAnomalies > 0
    ? `<p class="note warn">일시중지 중 ${esc(
        hours(t.total.inferredParkSec),
      )}은 session 재개 이벤트로 추정${
        t.total.parkAnomalies > 0 ? ` · park 마커 이상 ${t.total.parkAnomalies}건` : ""
      }.</p>`
    : ""
}`;
}

export function renderTimeline(m: DashboardModel): string {
  return section("시간 분석", body(m), "timeline");
}
