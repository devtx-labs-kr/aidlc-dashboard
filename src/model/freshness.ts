// Resolve how fresh each source is, and decide which ones to call stale.
//
// The one non-obvious judgement is runtime-graph.json. It is not merely "old" —
// it is recompiled only when a transition-class event lands in the audit tail
// (GATE_APPROVED / STAGE_STARTED / STAGE_AWAITING_APPROVAL / AUDIT_MERGED /
// WORKFLOW_COMPLETED, per hooks/aidlc-runtime-compile.ts). Mid-stage the audit
// keeps growing while the graph does not, so during the phase of a run someone
// actually wants to watch, the graph is systematically behind.
//
// Measured on a real in-flight run: graph 19.2h behind the audit, its
// `sensor_firings` empty for the in-flight stage while the audit held 178
// firings, and 6 stages under-reported overall (a backward jump re-ran stages the
// graph had already snapshotted). Hence the comparison below is against the
// audit's last timestamp, not the wall clock: a paused run whose graph matches
// its audit is NOT stale, it is simply idle.

import * as fs from "node:fs";
import type { Provenance, SourceKind } from "./types";

/** Seconds a source may lag the audit before we call it stale. */
const LAG_TOLERANCE_SEC = 300;

/** File mtime as a second-precision ISO string, or undefined. */
export function mtimeIso(p: string): string | undefined {
  try {
    return fs
      .statSync(p)
      .mtime.toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  } catch {
    return undefined;
  }
}

function ageSec(asOf: string | undefined, now: string): number | undefined {
  if (!asOf) return undefined;
  const a = Date.parse(asOf);
  const n = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(n)) return undefined;
  return Math.max(0, (n - a) / 1000);
}

function hours(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export interface FreshnessInput {
  /** Assembly clock (ISO). */
  now: string;
  /** Last timestamp in the audit ledger — the reference for "current". */
  auditLastTs?: string;
  /** `Last Updated` field from state.md. */
  stateLastUpdated?: string;
  /** Absolute path of state.md, for an mtime fallback. */
  statePath: string;
  /** Absolute path of runtime-graph.json (may not exist). */
  graphPath: string;
  /**
   * Latest timestamp the graph itself carries (max completed_at/started_at over
   * its stage rows). Preferred over mtime: it says what the graph KNOWS, whereas
   * mtime can be bumped by a file sync that changed nothing.
   */
  graphLastEventTs?: string;
  /** Latest hook heartbeat. */
  hooksLastActivity?: string;
  /** Absolute path of the stage catalogue, when one was found. */
  catalogPath?: string;
  /** Extra sentence appended to the graph's stale reason (e.g. sensor drift). */
  graphDriftNote?: string;
}

/**
 * Build the per-source provenance map. `disk` is always fresh by definition (it
 * is read during assembly); everything else is dated and compared to the audit.
 */
export function buildProvenance(input: FreshnessInput): Record<SourceKind, Provenance> {
  const { now, auditLastTs } = input;

  const mk = (
    source: SourceKind,
    asOf: string | undefined,
    stale = false,
    staleReason?: string,
  ): Provenance => ({
    source,
    asOf,
    ageSec: ageSec(asOf, now),
    stale,
    staleReason,
  });

  // runtime-graph: stale when it knows less than the audit does.
  const graphAsOf = input.graphLastEventTs ?? mtimeIso(input.graphPath);
  let graphStale = false;
  let graphReason: string | undefined;
  if (graphAsOf && auditLastTs) {
    const lag = (Date.parse(auditLastTs) - Date.parse(graphAsOf)) / 1000;
    if (Number.isFinite(lag) && lag > LAG_TOLERANCE_SEC) {
      graphStale = true;
      graphReason = `감사 기록보다 ${hours(lag)} 뒤처짐 — 이 스냅샷은 stage 전이 시점에만 재컴파일됨${input.graphDriftNote ? `. ${input.graphDriftNote}` : ""}`;
    }
  } else if (!graphAsOf) {
    graphStale = true;
    graphReason = "runtime-graph.json 읽기 실패 — units-generation 미진입 또는 미동기화";
  }

  // state.md is NOT flagged stale for merely lagging the audit.
  //
  // Its `Last Updated` is stamped at stage transitions by design, so mid-stage it
  // always trails the ledger — that is the contract, not a fault, and the fields
  // it carries (the checkbox grid, the phase verdicts, the current stage) are
  // authoritative regardless. Flagging it would train the reader to ignore the
  // badge, which is precisely the signal runtime-graph needs to keep. The age is
  // still reported so a genuinely abandoned run is visible.
  const stateAsOf = input.stateLastUpdated ?? mtimeIso(input.statePath);

  return {
    disk: mk("disk", now),
    audit: mk("audit", auditLastTs),
    "state.md": mk("state.md", stateAsOf),
    "runtime-graph": mk("runtime-graph", graphAsOf, graphStale, graphReason),
    "hooks-health": mk("hooks-health", input.hooksLastActivity),
    "stage-graph": input.catalogPath
      ? mk("stage-graph", mtimeIso(input.catalogPath))
      : mk("stage-graph", undefined, true, "stage-graph.json 없음 — 산출물 계약 판정 생략"),
  };
}

/**
 * Latest timestamp a runtime-graph knows about, over its stage rows. Returns
 * undefined for an unparseable/absent graph. Kept here rather than in the scan
 * layer because it exists purely to date the graph.
 */
export function graphLastEvent(graphPath: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(graphPath, "utf-8");
  } catch {
    return undefined;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const stages = (doc as Record<string, unknown>).stages;
  if (!Array.isArray(stages)) return undefined;

  let latest: string | undefined;
  for (const s of stages) {
    if (typeof s !== "object" || s === null) continue;
    const r = s as Record<string, unknown>;
    for (const k of ["completed_at", "started_at"]) {
      const v = r[k];
      if (typeof v === "string" && (!latest || v > latest)) latest = v;
    }
  }
  return latest;
}
