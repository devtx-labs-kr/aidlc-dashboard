// Panel (b) — why the run is stopped.
//
// This panel is first on the page for a reason: an AI-DLC run that looks hung is
// almost always waiting on a human answer, and the answer's location (which unit,
// which file) is exactly what is tedious to find by hand.

import type { Blocker, DashboardModel } from "../model/types";
import { dur, esc, pill, section, shortTs } from "./common";

function blockerCard(b: Blocker): string {
  const where = b.unit ? `${b.unit} · ${b.stage}` : b.stage;
  const tone = b.isCurrentStage ? "bad" : "warn";
  const label = b.isCurrentStage ? "현재 stage" : "이전 stage (파킹된 질문)";
  return `<div class="blocker ${tone}">
  <div class="blocker-head">${pill(label, tone)}<span class="blocker-where">${esc(where)}</span>
    <span class="blocker-age">${esc(dur(b.waitingSec))} 대기</span></div>
  <div class="blocker-q">${esc(b.heading)}</div>
  <div class="blocker-path">${esc(b.rel)} · ${esc(shortTs(b.since))}</div>
</div>`;
}

function blockerBody(m: DashboardModel): string {
  if (m.blockers.length === 0) {
    return `<p class="note">미답변 질문 없음. ${pill("정상", "ok")}</p>`;
  }
  const current = m.blockers.filter((b) => b.isCurrentStage);
  const stale = m.blockers.filter((b) => !b.isCurrentStage);
  const head =
    current.length > 0
      ? `<p class="lead">현재 stage 가 답변 ${current.length}건 대기 중 — 이 답 없이는 워크플로 정지.</p>`
      : `<p class="lead">현재 stage 는 정상. 다만 이전 stage 에 미답변 질문 ${stale.length}건 잔존.</p>`;
  return head + [...current, ...stale].map(blockerCard).join("\n");
}

/** The blocker card alone — placed first on the page, above everything. */
export function renderBlockerCard(m: DashboardModel): string {
  return section("🚧 병목", blockerBody(m), "blockers");
}
