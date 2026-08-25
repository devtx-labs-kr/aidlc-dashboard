// The view-model the renderers consume, and the provenance record every panel
// carries.
//
// WHY PROVENANCE IS A FIRST-CLASS FIELD. The four sources this dashboard reads
// have genuinely different freshness, and mixing them without saying so produces
// confident wrong numbers:
//
//   disk         live at read time
//   audit        live, but only as live as the hooks that append to it
//   state.md     rewritten at each transition; carries its own Last Updated
//   runtime-graph recompiled ONLY at stage transitions — measured 19h behind the
//                audit on a real in-flight run, under-reporting 6 stages
//
// So a panel says where its numbers came from and how old they are, and a stale
// source is called stale on screen rather than quietly averaged in.

import type { CreditViewModel } from "../credit/view/credit-model";
import type { StageArtifact } from "../scan/artifacts";
import type { HealthReport } from "../scan/hooks-health";
import type { ConstructionMatrix } from "../scan/matrix";
import type { DiaryReport } from "../scan/memory-diary";
import type { AidlcState } from "../scan/parser";
import type { QuestionsReport } from "../scan/questions";
import type { SensorReport } from "../scan/sensors";
import type { TimingReport } from "../scan/timing";

/** Where a number came from. */
export type SourceKind =
  | "disk"
  | "audit"
  | "state.md"
  | "runtime-graph"
  | "hooks-health"
  | "stage-graph";

/** Freshness of one source, resolved at assembly time. */
export interface Provenance {
  source: SourceKind;
  /** ISO timestamp the source last changed (embedded field preferred over mtime). */
  asOf?: string;
  /** Seconds between `asOf` and the assembly clock. Undefined when asOf is. */
  ageSec?: number;
  /** True when this source is known to lag another that corroborates it. */
  stale: boolean;
  /** Why, in one human sentence. Only set when stale. */
  staleReason?: string;
}

/** Identity of the run being shown. */
export interface RunIdentity {
  /** Workspace root passed on the command line. */
  root: string;
  /** Active space name. */
  space: string;
  /** Intent record dir name. */
  record: string;
  /** Record-relative path of the state file, for display. */
  stateRel: string;
  /**
   * Absolute path of the intent record dir. NOT for display — this is the jail
   * the /open endpoint resolves artifact paths against, so a click can never
   * reach a file outside the record being shown.
   */
  recordDir: string;
  /**
   * Harness dir the stage catalogue was read from (".kiro" / ".claude" /
   * ".aidlc" / …), or undefined when none was found. Display-only: the dashboard
   * reads the `aidlc/` docs tree, which is the same on every harness, so this
   * says which engine install happens to sit beside it — not what is supported.
   */
  harnessDir?: string;
  /** Registry metadata for this intent, when intents.json listed it. */
  slug?: string;
  scope?: string;
  status?: string;
}

/** The unanswered-question blocker, lifted to the top of the model. */
export interface Blocker {
  /** Stage the question belongs to. */
  stage: string;
  /** Unit of work, for a per-unit Construction question. */
  unit?: string;
  /** Question heading, e.g. "Q1 — Plan Approval". */
  heading: string;
  /** Record-relative path of the questions artifact. */
  rel: string;
  /** When the artifact was last written — how long the ask has been open. */
  since: string;
  /** Seconds outstanding at assembly time. */
  waitingSec?: number;
  /** True when this question belongs to the stage the engine is currently on. */
  isCurrentStage: boolean;
}

/** Approval-gate ledger. */
export interface GateSummary {
  approved: number;
  rejected: number;
  /** `Revision Count` from state.md — rework the run absorbed. */
  revisionCount?: number;
  /** Stage sitting at an approval gate right now, per the audit. */
  awaitingStage?: string;
  jumps: number;
}

/** Everything the page needs. Serialised verbatim as /api/model. */
export interface DashboardModel {
  /** ISO timestamp of this assembly — the clock all ages are relative to. */
  generatedAt: string;
  identity: RunIdentity;
  state: AidlcState;
  matrix?: ConstructionMatrix;
  sensors: SensorReport;
  questions: QuestionsReport;
  diaries: DiaryReport;
  health: HealthReport;
  timing: TimingReport;
  blockers: Blocker[];
  gates: GateSummary;
  /**
   * Credit-usage view for the top-of-page panel (u3-owned view-model, wired here
   * by u4). Always present — a run with no collected credit data degrades to a
   * `status: "none"` model rather than an absent slot, so the renderer never has
   * to guard for it. The container is host-owned; the value type is imported from
   * u3 (`../credit/view/credit-model`) — a one-way u4→u3 dependency.
   */
  credit: CreditViewModel;
  /** Audit event counts by type, for the stream filter. */
  eventCounts: [string, number][];
  /** Newest audit events, for the stream panel (bounded — see assemble.ts). */
  recentEvents: {
    ts: string;
    event: string;
    stage?: string;
    unit?: string;
    detail?: string;
    shard: string;
  }[];
  /** Total events in the ledger, so a truncated stream can say so. */
  totalEvents: number;
  /** Freshness per source, keyed by source kind. */
  provenance: Record<SourceKind, Provenance>;
  /** Non-fatal problems hit while reading (missing catalogue, unreadable file). */
  warnings: string[];
  /**
   * Files each stage produced, keyed by the same identity the overview renders:
   * `<phase>/<slug>` for ordinary stages, `construction/<unit>/<slug>` for the
   * per-unit Construction copies (the slug alone repeats once per Bolt, so it is
   * not a key). Absent key = we never scanned that stage; empty array = we did
   * and it had nothing, which is why the toggle can be disabled honestly.
   */
  artifacts: Record<string, StageArtifact[]>;
}
