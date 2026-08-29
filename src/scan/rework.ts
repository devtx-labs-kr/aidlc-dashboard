// How much of the run was doing work over again.
//
// WHY THIS IS ITS OWN READER. The audit's richest signal is not what got produced,
// it is what got sent back. Measured on one real run: 26 gate submissions against 17
// approvals, **11 rejections**, 11 revisions and 2 backward jumps — and the time
// between a stage's first rejection and its final approval came to **18.94h, 14.6% of
// the whole wall clock**. None of that reached the screen: `GateSummary` counted the
// events and no render module read it, while the timing panel showed a stage's rework
// only as a second bar with no indication of why it was re-entered.
//
// WHAT A REJECTION CARRIES. `GATE_REJECTED` and `STAGE_REVISING` are emitted in the
// same second and both hold a `**Feedback**` field with the human's reason in full
// prose (measured: 22 Feedback fields across the 22 events). That text is the highest
// information density in the ledger, so it is surfaced rather than counted.
//
// WHAT "REWORK TIME" MEANS HERE, exactly: from a stage's FIRST `GATE_REJECTED` to the
// LAST `GATE_APPROVED` that follows it. A stage rejected twice therefore counts the
// whole stretch including the approval in between — it is "time this stage spent not
// yet accepted", not a sum of individual revision spans, which the ledger cannot give
// because a revision has no close marker of its own. When no approval follows the
// last rejection the rework is still open: `settled` is false and the span is measured
// to the stage's last event, which the screen marks provisional rather than dropping.
//
// Node-free and never throws: it reads the already-parsed ledger.

import type { AuditLedger } from "./audit";

/** One stage's rework record. Only stages that were actually sent back appear. */
export interface StageRework {
  stage: string;
  /** `STAGE_AWAITING_APPROVAL` — how many times it was submitted for approval. */
  submissions: number;
  rejections: number;
  /** `STAGE_REVISING` events, i.e. how many revision rounds were opened. */
  revisions: number;
  /** Highest `Revision count` field seen on this stage's revisions, when present. */
  revisionHigh?: number;
  firstRejectedAt: string;
  /** First rejection → last approval after it (or to the last event when unsettled). */
  reworkSec: number;
  /** False when no approval followed the last rejection — still being reworked. */
  settled: boolean;
  /** Rejection reasons, newest first. */
  feedback: { at: string; text: string }[];
}

export interface ReworkReport {
  /** Stages that were sent back, costliest first. */
  stages: StageRework[];
  approved: number;
  rejected: number;
  revisions: number;
  jumps: number;
  /** `REVIEW_FREEZE_BLOCKED` — an edit refused because a review was in progress. */
  freezeBlocked: number;
  /** Σ per-stage rework time. */
  reworkSec: number;
  /** True when at least one stage's rework has not closed yet. */
  provisional: boolean;
}

const MAX_FEEDBACK = 6;

/**
 * Build the rework report from a merged ledger. Pure over the events, so a test can
 * drive it from a synthetic list.
 */
export function buildRework(ledger: AuditLedger): ReworkReport {
  const submissions = new Map<string, number>();
  const rejections = new Map<string, string[]>(); // stage → rejection timestamps
  const revisions = new Map<string, number>();
  const revisionHigh = new Map<string, number>();
  const approvals = new Map<string, string[]>(); // stage → approval timestamps
  const feedback = new Map<string, { at: string; text: string }[]>();
  const lastSeen = new Map<string, string>(); // stage → last timestamp of any event
  const bump = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  const push = (m: Map<string, string[]>, k: string, v: string): void => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };

  for (const e of ledger.events) {
    const stage = e.stage;
    if (!stage) continue;
    lastSeen.set(stage, e.ts);
    if (e.event === "STAGE_AWAITING_APPROVAL") bump(submissions, stage);
    else if (e.event === "GATE_APPROVED") push(approvals, stage, e.ts);
    else if (e.event === "GATE_REJECTED") {
      push(rejections, stage, e.ts);
      const text = e.fields.Feedback?.trim();
      if (text) {
        const list = feedback.get(stage) ?? [];
        list.push({ at: e.ts, text });
        feedback.set(stage, list);
      }
    } else if (e.event === "STAGE_REVISING") {
      bump(revisions, stage);
      const raw = e.fields["Revision count"];
      if (raw && /^\d+$/.test(raw.trim())) {
        const n = Number(raw.trim());
        if (n > (revisionHigh.get(stage) ?? 0)) revisionHigh.set(stage, n);
      }
      // Only used when the rejection itself carried no reason.
      const text = e.fields.Feedback?.trim();
      if (text && !(feedback.get(stage) ?? []).some((f) => f.text === text)) {
        const list = feedback.get(stage) ?? [];
        list.push({ at: e.ts, text });
        feedback.set(stage, list);
      }
    }
  }

  const stages: StageRework[] = [];
  for (const [stage, rejectedAt] of rejections) {
    const first = rejectedAt[0]!;
    const last = rejectedAt[rejectedAt.length - 1]!;
    const after = (approvals.get(stage) ?? []).filter((ts) => ts > last);
    const settled = after.length > 0;
    const end = settled ? after[after.length - 1]! : (lastSeen.get(stage) ?? last);
    const reworkSec = Math.max(0, (Date.parse(end) - Date.parse(first)) / 1000);
    const high = revisionHigh.get(stage);
    stages.push({
      stage,
      submissions: submissions.get(stage) ?? 0,
      rejections: rejectedAt.length,
      revisions: revisions.get(stage) ?? 0,
      ...(high === undefined ? {} : { revisionHigh: high }),
      firstRejectedAt: first,
      reworkSec: Number.isFinite(reworkSec) ? reworkSec : 0,
      settled,
      feedback: (feedback.get(stage) ?? []).slice().reverse().slice(0, MAX_FEEDBACK),
    });
  }
  stages.sort((a, b) => b.reworkSec - a.reworkSec);

  const n = (k: string): number => ledger.counts.get(k) ?? 0;
  return {
    stages,
    approved: n("GATE_APPROVED"),
    rejected: n("GATE_REJECTED"),
    revisions: n("STAGE_REVISING"),
    jumps: n("STAGE_JUMPED"),
    freezeBlocked: n("REVIEW_FREEZE_BLOCKED"),
    reworkSec: stages.reduce((sum, s) => sum + s.reworkSec, 0),
    provisional: stages.some((s) => !s.settled),
  };
}
