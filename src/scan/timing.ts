// Where the run's wall-clock actually went.
//
// PORTED from v2-patches/scripts/harness_timing_report.py (classify_gaps +
// stage_table). That reader was corrected against three real runs, so the rules
// below are transcribed rather than re-derived — including the two defects its
// comments record, both of which a fresh implementation walks straight into:
//
//   1. Bootstrap stages (workspace-scaffold / workspace-detection / state-init)
//      emit STARTED and COMPLETED in the SAME second. Filtering on `elapsed > 0`
//      would mark completed stages as unfinished. Zero-second stages count.
//   2. Measuring only COMPLETED stages hides the stage you most want to see —
//      the one sitting at its approval gate. Its STARTED→AWAITING_APPROVAL span
//      is already-settled work. So the end point is chosen
//      COMPLETED > AWAITING_APPROVAL > last event in the ledger.
//
// WHY GAPS ARE CLASSIFIED AT ALL. Wall-clock is not a measure of the engine:
// most of it is the engine waiting for a human at an approval gate (measured on
// one run: 58 of 79 minutes). So each gap between consecutive events is sorted:
//
//   HUMAN  a gate-opening event followed by HUMAN_TURN.
//   PARKED WORKFLOW_PARKED → WORKFLOW_UNPARKED, plus an inferred session break
//          when an old ledger has no balanced park pair.
//   ACTIVE event-dense time (<5 minutes) and explicit delegated work.
//   UNKNOWN a 5-minute+ gap with no trustworthy semantic marker.
//
// ACTIVE is deliberately called "observed", not "actual execution": the ledger
// records event boundaries, not CPU/model activity. UNKNOWN stays separate
// instead of being presented as execution.

import type { AuditEvent, AuditLedger } from "./audit";

/** Events that open a human wait: after one of these, a gap to HUMAN_TURN is IDLE. */
const GATE_OPEN = new Set([
  "DECISION_RECORDED",
  "QUESTION_ASKED",
  "GATE_OPENED",
  "STAGE_AWAITING_APPROVAL",
]);

/**
 * Session-resume markers. A gap ENDING in one of these was the human being away,
 * even with no gate event in front of it — measured on two runs where a 38- and a
 * 43-minute gap ran SENSOR_PASSED → GUARDRAIL_LOADED and was followed by a human.
 */
const SESSION_RESUME = new Set(["GUARDRAIL_LOADED", "HEALTH_CHECKED", "SESSION_STARTED"]);

/** Delegation open/close — the span between them is a subagent working. */
const AGENT_OPEN = new Set(["REVIEW_REQUESTED", "SUBAGENT_DISPATCHED", "MERGE_DISPATCH"]);
const AGENT_CLOSE = new Set(["SUBAGENT_COMPLETED", "REVIEW_COMPLETED"]);

/** Gaps shorter than this are not classified as waiting — they are just work. */
const IDLE_FLOOR_SEC = 60;
/** Unclassified gaps at or above this are surfaced for human judgement. */
const SUSPECT_SEC = 300;

/** Per-stage workload tally — what the stage actually produced. */
export interface Workload {
  /** ARTIFACT_CREATED + ARTIFACT_UPDATED. */
  artifacts: number;
  /** SENSOR_FIRED. */
  sensors: number;
  /** SENSOR_FAILED. */
  sensorFailures: number;
  /** SUBAGENT_COMPLETED. */
  delegations: number;
  /** HUMAN_TURN (no stage field, so counted within the span). */
  humanTurns: number;
}

/** A long gap we refuse to classify confidently. */
export interface SuspectSpan {
  seconds: number;
  fromEvent: string;
  toEvent: string;
  at: string;
}

export interface GapSplit {
  /** A prompt/approval marker followed by the user's turn. */
  humanWaitSec: number;
  /** Explicit workflow park time, plus conservative inferred session breaks. */
  parkedSec: number;
  /** Park time inferred only from a session-resume marker. Subset of parkedSec. */
  inferredParkSec: number;
  /** Event-dense time and explicit delegation spans. */
  observedSec: number;
  /** Long gaps with no trustworthy semantic classification. */
  unknownSec: number;
  /** Delegated time. Subset of observedSec. */
  delegatedSec: number;
  /** Unbalanced/repeated park markers encountered while classifying. */
  parkAnomalies: number;
  /** Long gaps kept visible instead of silently called execution. */
  unknown: SuspectSpan[];
  /** Compatibility aggregate: humanWaitSec + parkedSec. */
  idleSec: number;
  /** Compatibility alias for delegatedSec. */
  agentSec: number;
  /** Compatibility aggregate: observedSec + unknownSec. */
  workSec: number;
  /** Compatibility alias for unknown. */
  suspect: SuspectSpan[];
}

/** How a stage's span was closed. */
export type StageEndKind = "completed" | "skipped" | "awaiting-approval" | "in-flight";

export interface StageSegment extends GapSplit {
  startedAt: string;
  endedAt: string;
  endKind: StageEndKind;
  elapsedSec: number;
}

export interface StageSpan extends GapSplit {
  stage: string;
  /** First segment start and last segment end, for the run-position track. */
  startedAt: string;
  endedAt: string;
  endKind: StageEndKind;
  /** Sum of entered segments, not first-start → last-end wall time. */
  elapsedSec: number;
  /** Separate entries after a backward jump; gaps between entries are excluded. */
  segments: StageSegment[];
  workload: Workload;
}

/**
 * One audit shard's own timeline — i.e. one clone, which in practice means one
 * developer's machine.
 *
 * WHY THIS EXISTS. The gap rules above read a SINGLE sequence of events: a gap is
 * idle because nothing happened in it. Merge four developers' shards into one
 * sequence and that premise breaks — while A waits at a gate, B is working, so
 * A's wait gets filled by B's events and is misread as work. Measured on a real
 * 4-developer run: merged idle 818.7 min vs per-shard idle 2,631.5 min, so the
 * merged view loses 69% of the waiting.
 *
 * So gaps are ALSO classified per shard, and that is the number to trust for
 * "how long did people actually wait".
 */
export interface WorkerSpan {
  /** Shard basename, e.g. "jiho-kim-c02dw4rrmd6r-0c1b20ca004a.md". */
  shard: string;
  /** Human-ish label: the shard name minus the host/clone-id suffix. */
  label: string;
  events: number;
  firstTs: string;
  lastTs: string;
  /** First → last event for THIS shard. */
  elapsedSec: number;
  humanWaitSec: number;
  parkedSec: number;
  observedSec: number;
  unknownSec: number;
  delegatedSec: number;
  /** Compatibility aggregates. */
  idleSec: number;
  agentSec: number;
  workSec: number;
  /** GATE_APPROVED count — identifies who drove the workflow. */
  gatesApproved: number;
  /** STAGE_COMPLETED count. */
  stagesCompleted: number;
  /** Stages this shard touched, most active first. */
  stages: string[];
  /** Units this shard touched (often empty — see the note in model/types.ts). */
  units: string[];
}

export interface TimingReport {
  /** Stages in first-seen (run) order. */
  stages: StageSpan[];
  /**
   * Gap split over the MERGED timeline. Correct for a single-clone run; for a
   * parallel one it under-reports idle (see WorkerSpan). `parallel` below says
   * which case this is.
   */
  total: GapSplit;
  firstTs?: string;
  lastTs?: string;
  /** Team wall-clock: first → last event across every shard. */
  elapsedSec: number;
  /** Stage awaiting approval right now, per the ledger. */
  awaitingStage?: string;
  /** Per-shard timelines, busiest first. One entry for a single-clone run. */
  workers: WorkerSpan[];
  /** True when more than one shard carries events — a parallel run. */
  parallel: boolean;
  /** Σ per-worker idle. The trustworthy waiting figure. */
  personIdleSec: number;
  /** Σ per-worker work. */
  personWorkSec: number;
  personHumanWaitSec: number;
  personParkedSec: number;
  personObservedSec: number;
  personUnknownSec: number;
  /** Σ per-worker elapsed — person-time, not wall-clock. */
  personElapsedSec: number;
  /**
   * personElapsedSec / elapsedSec: how many developers were effectively active at
   * once. 1.0 = fully sequential; 4 shards at 1.5 means the four overlapped far
   * less than their count suggests. Undefined when wall-clock is 0.
   */
  parallelism?: number;
}

function secs(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 1000;
}

/**
 * Classify the gaps between consecutive events. Exported for tests: the whole
 * IDLE/AGENT/WORK rule is here and checkable from a synthetic event list.
 */
export function classifyGaps(events: AuditEvent[]): GapSplit {
  let humanWaitSec = 0;
  let parkedSec = 0;
  let inferredParkSec = 0;
  let observedSec = 0;
  let unknownSec = 0;
  let delegatedSec = 0;
  let parkAnomalies = 0;
  const shards = new Set(events.map((event) => event.shard));
  const parkedShards = new Set<string>();
  const unknown: SuspectSpan[] = [];

  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i]!;
    const b = events[i + 1]!;
    const gap = secs(a.ts, b.ts);
    if (!Number.isFinite(gap) || gap <= 0) continue;

    if (a.event === "WORKFLOW_PARKED") {
      if (parkedShards.has(a.shard)) parkAnomalies++;
      parkedShards.add(a.shard);
    } else if (a.event === "WORKFLOW_UNPARKED") {
      if (!parkedShards.has(a.shard)) parkAnomalies++;
      parkedShards.delete(a.shard);
    }

    // In a merged ledger, one parked clone does not mean the team stopped.
    if (parkedShards.size > 0 && parkedShards.size === shards.size) {
      parkedSec += gap;
    } else if (GATE_OPEN.has(a.event) && b.event === "HUMAN_TURN" && gap >= IDLE_FLOOR_SEC) {
      humanWaitSec += gap;
    } else if (SESSION_RESUME.has(b.event) && gap >= IDLE_FLOOR_SEC) {
      // Old ledgers do not always carry balanced park markers. Keep this
      // conservative fallback visible as inferred pause time.
      parkedSec += gap;
      inferredParkSec += gap;
    } else if (AGENT_OPEN.has(a.event) && AGENT_CLOSE.has(b.event)) {
      delegatedSec += gap;
      observedSec += gap;
    } else if (gap >= SUSPECT_SEC) {
      unknownSec += gap;
      unknown.push({ seconds: gap, fromEvent: a.event, toEvent: b.event, at: a.ts });
    } else {
      observedSec += gap;
    }
  }

  const idleSec = humanWaitSec + parkedSec;
  const workSec = observedSec + unknownSec;
  return {
    humanWaitSec,
    parkedSec,
    inferredParkSec,
    observedSec,
    unknownSec,
    delegatedSec,
    parkAnomalies,
    unknown,
    idleSec,
    agentSec: delegatedSec,
    workSec,
    suspect: unknown,
  };
}

function emptyWorkload(): Workload {
  return { artifacts: 0, sensors: 0, sensorFailures: 0, delegations: 0, humanTurns: 0 };
}

/**
 * Strip the host and clone-id suffix off a shard filename to get something
 * readable. Shards are named `<host-slug>-<clone12hex>.md`, and the host slug
 * itself usually carries the developer's name (`jiho-kim-c02dw4rrmd6r`), so
 * dropping the trailing two dash-separated tokens leaves the useful part.
 * A name that does not match keeps its basename.
 */
export function shardLabel(shard: string): string {
  const base = shard.endsWith(".md") ? shard.slice(0, -3) : shard;
  // Trailing 12-hex clone id.
  const noClone = base.replace(/-[0-9a-f]{12}$/i, "");
  // Trailing host token, only when it looks like a machine id rather than a name
  // (mixed letters+digits, e.g. "c02dw4rrmd6r"), so "macbook-pro-8-local" stays.
  return noClone.replace(/-(?=[a-z]*\d)[a-z0-9]{8,}$/i, "");
}

/** Rank map entries by count, descending, returning the keys. */
function topKeys(counts: Map<string, number>, limit: number): string[] {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

/**
 * Classify each shard's events on their OWN timeline. This is the correct way to
 * measure waiting on a parallel run — see WorkerSpan for the measured evidence
 * that the merged view loses most of it.
 */
export function buildWorkers(events: AuditEvent[]): WorkerSpan[] {
  const byShard = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const list = byShard.get(e.shard);
    if (list) list.push(e);
    else byShard.set(e.shard, [e]);
  }

  const out: WorkerSpan[] = [];
  for (const [shard, evs] of byShard) {
    // `events` arrives time-ordered, so each shard's slice is too.
    const split = classifyGaps(evs);
    const stages = new Map<string, number>();
    const units = new Map<string, number>();
    let gatesApproved = 0;
    let stagesCompleted = 0;
    for (const e of evs) {
      if (e.stage) stages.set(e.stage, (stages.get(e.stage) ?? 0) + 1);
      if (e.unit) units.set(e.unit, (units.get(e.unit) ?? 0) + 1);
      if (e.event === "GATE_APPROVED") gatesApproved++;
      else if (e.event === "STAGE_COMPLETED") stagesCompleted++;
    }
    const firstTs = evs[0]!.ts;
    const lastTs = evs[evs.length - 1]!.ts;
    out.push({
      shard,
      label: shardLabel(shard),
      events: evs.length,
      firstTs,
      lastTs,
      elapsedSec: secs(firstTs, lastTs),
      humanWaitSec: split.humanWaitSec,
      parkedSec: split.parkedSec,
      observedSec: split.observedSec,
      unknownSec: split.unknownSec,
      delegatedSec: split.delegatedSec,
      idleSec: split.idleSec,
      agentSec: split.agentSec,
      workSec: split.workSec,
      gatesApproved,
      stagesCompleted,
      stages: topKeys(stages, 4),
      units: topKeys(units, 12),
    });
  }

  return out.sort((a, b) => b.events - a.events);
}

/**
 * Derive per-stage spans and the whole-run split from the ledger.
 *
 * A stage's start is its FIRST STAGE_STARTED (a backward jump re-enters a stage;
 * keeping the first start means the span covers the rework rather than hiding
 * it). Its end is the LAST COMPLETED, else the last AWAITING_APPROVAL, else the
 * ledger's final event for a stage still running.
 */
export function buildTiming(ledger: AuditLedger, nowTs?: string): TimingReport {
  if (ledger.events.length === 0) {
    return {
      stages: [],
      total: classifyGaps([]),
      elapsedSec: 0,
      workers: [],
      parallel: false,
      personIdleSec: 0,
      personWorkSec: 0,
      personHumanWaitSec: 0,
      personParkedSec: 0,
      personObservedSec: 0,
      personUnknownSec: 0,
      personElapsedSec: 0,
    };
  }

  const all = ledger.events;
  const startIndex = all.findIndex((e) => e.event === "WORKFLOW_STARTED");
  const from = startIndex >= 0 ? startIndex : 0;
  const completedIndex = all.findLastIndex((e, i) => i >= from && e.event === "WORKFLOW_COMPLETED");
  const actual = all.slice(from, completedIndex >= 0 ? completedIndex + 1 : undefined);
  const firstTs = actual[0]!.ts;
  const lastActualTs = actual[actual.length - 1]!.ts;
  const requestedEnd = completedIndex >= 0 ? lastActualTs : (nowTs ?? lastActualTs);
  const endTs = Date.parse(requestedEnd) >= Date.parse(lastActualTs) ? requestedEnd : lastActualTs;
  const events =
    endTs === lastActualTs
      ? actual
      : [
          ...actual,
          {
            ts: endTs,
            event: "ANALYSIS_NOW",
            fields: {},
            shard: actual[actual.length - 1]!.shard,
          },
        ];

  interface OpenStage {
    startedAt: string;
    awaiting: boolean;
  }
  interface RawSegment {
    startedAt: string;
    endedAt: string;
    endKind: StageEndKind;
  }

  const open = new Map<string, OpenStage>();
  const raw = new Map<string, RawSegment[]>();
  const finalKind = new Map<string, StageEndKind>();
  const order: string[] = [];
  let awaitingStage: string | undefined;

  const close = (stage: string, endedAt: string, endKind: StageEndKind): void => {
    const current = open.get(stage);
    if (!current) return;
    const list = raw.get(stage) ?? [];
    list.push({ startedAt: current.startedAt, endedAt, endKind });
    raw.set(stage, list);
    open.delete(stage);
    finalKind.set(stage, endKind);
  };

  for (const e of actual) {
    const stage = e.stage;
    if (!stage) continue;
    if (!order.includes(stage)) order.push(stage);

    if (e.event === "STAGE_STARTED") {
      // A repeated start is a real re-entry. Close a malformed still-open entry
      // at the new boundary rather than stretching one bar across unrelated work.
      close(stage, e.ts, open.get(stage)?.awaiting ? "awaiting-approval" : "in-flight");
      open.set(stage, { startedAt: e.ts, awaiting: false });
      if (awaitingStage === stage) awaitingStage = undefined;
    } else if (e.event === "STAGE_COMPLETED") {
      close(stage, e.ts, "completed");
      if (awaitingStage === stage) awaitingStage = undefined;
    } else if (e.event === "STAGE_SKIPPED") {
      close(stage, e.ts, "skipped");
      if (awaitingStage === stage) awaitingStage = undefined;
    } else if (e.event === "STAGE_AWAITING_APPROVAL") {
      awaitingStage = stage;
      const current = open.get(stage);
      if (current) current.awaiting = true;
    }
  }

  for (const [stage, current] of open) {
    close(stage, endTs, current.awaiting ? "awaiting-approval" : "in-flight");
  }

  const stages: StageSpan[] = [];

  for (const stage of order) {
    const stageSegments = raw.get(stage);
    if (!stageSegments?.length) continue;

    const segments: StageSegment[] = stageSegments.map((segment) => {
      const within = events.filter((e) => e.ts >= segment.startedAt && e.ts <= segment.endedAt);
      const split = classifyGaps(within);
      return {
        ...segment,
        ...split,
        elapsedSec: secs(segment.startedAt, segment.endedAt),
      };
    });
    const sum = (pick: (segment: StageSegment) => number): number =>
      segments.reduce((n, segment) => n + pick(segment), 0);

    const workload = emptyWorkload();
    for (const e of actual) {
      if (e.stage !== stage) continue;
      if (e.event === "ARTIFACT_CREATED" || e.event === "ARTIFACT_UPDATED") workload.artifacts++;
      else if (e.event === "SENSOR_FIRED") workload.sensors++;
      else if (e.event === "SENSOR_FAILED") workload.sensorFailures++;
      else if (e.event === "SUBAGENT_COMPLETED") workload.delegations++;
    }
    for (const segment of stageSegments) {
      workload.humanTurns += actual.filter(
        (e) => e.event === "HUMAN_TURN" && e.ts >= segment.startedAt && e.ts <= segment.endedAt,
      ).length;
    }

    const humanWaitSec = sum((s) => s.humanWaitSec);
    const parkedSec = sum((s) => s.parkedSec);
    const observedSec = sum((s) => s.observedSec);
    const unknownSec = sum((s) => s.unknownSec);
    const delegatedSec = sum((s) => s.delegatedSec);
    const unknown = segments.flatMap((s) => s.unknown);
    const idleSec = humanWaitSec + parkedSec;
    const workSec = observedSec + unknownSec;

    stages.push({
      stage,
      startedAt: segments[0]!.startedAt,
      endedAt: segments[segments.length - 1]!.endedAt,
      endKind: finalKind.get(stage) ?? "in-flight",
      elapsedSec: sum((s) => s.elapsedSec),
      segments,
      humanWaitSec,
      parkedSec,
      inferredParkSec: sum((s) => s.inferredParkSec),
      observedSec,
      unknownSec,
      delegatedSec,
      parkAnomalies: sum((s) => s.parkAnomalies),
      unknown,
      idleSec,
      agentSec: delegatedSec,
      workSec,
      suspect: unknown,
      workload,
    });
  }

  const workers = buildWorkers(actual);
  const elapsedSec = secs(firstTs, endTs);
  const personElapsedSec = workers.reduce((n, w) => n + w.elapsedSec, 0);

  return {
    stages,
    total: classifyGaps(events),
    firstTs,
    lastTs: endTs,
    elapsedSec,
    awaitingStage,
    workers,
    parallel: workers.length > 1,
    personIdleSec: workers.reduce((n, w) => n + w.idleSec, 0),
    personWorkSec: workers.reduce((n, w) => n + w.workSec, 0),
    personHumanWaitSec: workers.reduce((n, w) => n + w.humanWaitSec, 0),
    personParkedSec: workers.reduce((n, w) => n + w.parkedSec, 0),
    personObservedSec: workers.reduce((n, w) => n + w.observedSec, 0),
    personUnknownSec: workers.reduce((n, w) => n + w.unknownSec, 0),
    personElapsedSec,
    parallelism: elapsedSec > 0 ? personElapsedSec / elapsedSec : undefined,
  };
}
