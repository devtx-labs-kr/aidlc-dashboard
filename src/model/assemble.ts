// The single entry point: workspace root → DashboardModel.
//
// Read order matters in one place only — the stage catalogue is loaded FIRST
// because the audit parser needs it to attribute Context-only events to the right
// stage (see the Context shape note in scan/audit.ts). Everything else is
// independent.
//
// Read-only throughout. No scan module throws, so a partially-synced tree
// degrades to a thinner page with warnings rather than a 500.

import * as fs from "node:fs";
import * as path from "node:path";
import { type TokenViewModel, assembleTokens } from "../credit/claude/token-model";
import { type TranscriptMemo, readTranscripts } from "../credit/claude/transcript-reader";
import type { TrendWindow } from "../credit/trend/trend";
import {
  type CreditReadStore,
  type CreditViewModel,
  assembleCredit,
} from "../credit/view/credit-model";
import { type StageArtifact, listStageArtifacts } from "../scan/artifacts";
import { type AuditLedger, readAuditLedger } from "../scan/audit";
import { readHealth } from "../scan/hooks-health";
import { scanConstructionMatrix } from "../scan/matrix";
import { readDiaries } from "../scan/memory-diary";
import { parseState } from "../scan/parser";
import { readQuestions } from "../scan/questions";
import { resolveState } from "../scan/resolve";
import { readSensorReport } from "../scan/sensors";
import { type StageCatalog, harnessDirsWithCatalog, readStageCatalog } from "../scan/stage-catalog";
import { buildTiming } from "../scan/timing";
import { buildProvenance, graphLastEvent } from "./freshness";
import type {
  Blocker,
  DashboardModel,
  GateSummary,
  RunIdentity,
  UsageMode,
  UsageView,
} from "./types";

/** Newest events kept for the stream panel. The full ledger stays server-side. */
const RECENT_EVENT_LIMIT = 300;

/**
 * What the host injects so `assemble` can fill the usage slot: the read-only
 * snapshot store (u1, Kiro side), the trend window the request asked for (u4
 * parses `?cw=`), and the per-file memo the Claude side reuses across polls.
 * Optional — omitted, the usage slot degrades to an empty view of the resolved
 * kind, which keeps every caller and test that never passes it working unchanged.
 */
export interface UsageContext {
  /** Kiro snapshot store. Absent → the credit view degrades to `none`. */
  store?: CreditReadStore;
  window: TrendWindow;
  collecting?: boolean;
  /** Which panel to show. Default `auto` (resolved from the harness dir). */
  mode?: UsageMode;
  /** Claude transcript memo, held by the host for the process lifetime. */
  memo?: TranscriptMemo;
  /** Home dir override (tests). */
  home?: string;
}

/**
 * Which usage provider to run. `auto` reads the harness dir: a workspace whose
 * catalogue came from `.claude` was driven by Claude Code, so its usage lives in
 * Claude Code's transcripts. Anything else — including no harness dir at all —
 * falls back to the Kiro credit panel, which degrades to an empty view on its own
 * when nothing has been collected.
 */
function resolveUsageKind(mode: UsageMode, harnessDir: string | undefined): "kiro" | "claude" {
  if (mode !== "auto") return mode;
  return harnessDir === ".claude" ? "claude" : "kiro";
}

/** The empty token view used when Claude assembly fails. */
function emptyTokens(window: TrendWindow): TokenViewModel {
  return {
    status: "none",
    totals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 },
    grandTotal: 0,
    byModel: [],
    messages: 0,
    sidechainMessages: 0,
    sessions: 0,
    trend: { window, points: [], summary: { latest: null, min: null, max: null, count: 0 } },
    lastActivityAt: null,
    firstActivityAt: null,
    dir: null,
    triedPath: "",
    notes: [],
  };
}

/** The empty credit view used when no store is wired or assembly fails (BR1.4). */
function emptyCredit(window: TrendWindow, collecting = false): CreditViewModel {
  return {
    status: collecting ? "loading" : "none",
    current: null,
    lastSuccessAt: null,
    freshness: { stale: false, lastSuccessAt: null },
    trend: { window, points: [], summary: { latest: null, min: null, max: null, count: 0 } },
    warning: null,
  };
}

/** Thrown only when there is no run to show at all. */
export class NoRunError extends Error {
  constructor(
    readonly kind: "none" | "ambiguous",
    root: string,
  ) {
    super(
      kind === "ambiguous"
        ? `intent 가 여럿인데 active-intent 커서 없음: ${root}`
        : `AI-DLC 워크플로 미검출: ${root}`,
    );
    this.name = "NoRunError";
  }
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Registry metadata for the active record, when intents.json lists it. */
function readRegistry(
  root: string,
  space: string,
  record: string,
): { slug?: string; scope?: string; status?: string } {
  const p = path.join(root, "aidlc", "spaces", space, "intents", "intents.json");
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return {};
  }
  try {
    const doc = JSON.parse(raw);
    if (!Array.isArray(doc)) return {};
    for (const e of doc) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      if (r.dirName !== record) continue;
      return {
        slug: typeof r.slug === "string" ? r.slug : undefined,
        scope: typeof r.scope === "string" ? r.scope : undefined,
        status: typeof r.status === "string" ? r.status : undefined,
      };
    }
  } catch {
    // Malformed registry: identity falls back to the dir name.
  }
  return {};
}

/** Gate ledger from the audit + the revision count state.md tracks. */
function buildGates(
  ledger: AuditLedger,
  revisionCount: string | undefined,
  awaiting?: string,
): GateSummary {
  const n = (k: string) => ledger.counts.get(k) ?? 0;
  const rev =
    revisionCount && /^\d+$/.test(revisionCount.trim()) ? Number(revisionCount.trim()) : undefined;
  return {
    approved: n("GATE_APPROVED"),
    rejected: n("GATE_REJECTED"),
    revisionCount: rev,
    awaitingStage: awaiting,
    jumps: n("STAGE_JUMPED"),
  };
}

/**
 * Lift unanswered questions into blockers, current stage first.
 *
 * Not every blank `[Answer]:` is live: a question parked mid-run stays blank
 * forever, so `isCurrentStage` separates "the run is waiting on this right now"
 * from "this was abandoned earlier". Both are shown — a stale one is a real loose
 * end — but only the current-stage ones are the reason the run is stopped.
 */
function buildBlockers(
  questions: ReturnType<typeof readQuestions>,
  currentStage: string | undefined,
  now: string,
): Blocker[] {
  const out: Blocker[] = [];
  for (const f of questions.blocked) {
    for (const q of f.unanswered) {
      const since = f.mtime;
      const parsed = Date.parse(since);
      out.push({
        stage: f.stage,
        unit: f.unit,
        heading: q.heading,
        rel: f.rel,
        since,
        waitingSec: Number.isFinite(parsed)
          ? Math.max(0, (Date.parse(now) - parsed) / 1000)
          : undefined,
        isCurrentStage: currentStage !== undefined && f.stage === currentStage,
      });
    }
  }
  // Current stage first, then newest ask first.
  return out.sort((a, b) => {
    if (a.isCurrentStage !== b.isCurrentStage) return a.isCurrentStage ? -1 : 1;
    return a.since > b.since ? -1 : a.since < b.since ? 1 : 0;
  });
}

/** The one field worth showing beside an event in the stream. */
function eventDetail(fields: Record<string, string>): string | undefined {
  for (const k of [
    "Details",
    "Reason",
    "Sensor ID",
    "Question",
    "Decision",
    "Target",
    "Error",
    "Source",
  ]) {
    const v = fields[k];
    if (v && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Read the workspace and assemble the model. `harnessDir` pins the harness the
 * stage catalogue is read from; omitted, it is discovered (see
 * scan/stage-catalog.ts — harness-agnostic by design, since the `aidlc/` docs
 * tree is identical across Kiro CLI/IDE and Claude Code). Throws
 * NoRunError only when no intent record can be resolved; every other failure
 * becomes a warning.
 *
 * The docs tree stays harness-neutral; the ONE panel that is not is usage, since
 * the two harnesses expose usage through different mechanisms. `usageCtx.mode`
 * picks the panel (default `auto` — see resolveUsageKind).
 */
export function assemble(
  root: string,
  harnessDir?: string,
  usageCtx?: UsageContext,
): DashboardModel {
  const resolved = resolveState(root);
  if (resolved.kind !== "ok") throw new NoRunError(resolved.kind, root);

  const now = isoNow();
  const warnings: string[] = [];

  const statePath = path.join(root, resolved.rel);
  const recordDir = path.dirname(statePath);
  const graphPath = path.join(recordDir, "runtime-graph.json");

  // Discover every harness dir that ships a catalogue ONCE. The first entry is the
  // same winner `findHarnessDir` would pick (identical probe order), and the full
  // list is what the usage panel needs to notice coexistence — so doing it here
  // replaces two separate directory scans with one.
  const harnesses = harnessDirsWithCatalog(root);
  const discoveredHarness = harnessDir ?? harnesses[0];

  // FIRST: the catalogue, so audit attribution can consult it.
  let catalog: StageCatalog | undefined;
  try {
    catalog = readStageCatalog(root, discoveredHarness);
  } catch {
    catalog = undefined;
  }
  if (!catalog) {
    warnings.push(
      harnessDir
        ? `${harnessDir}/tools/data/stage-graph.json 읽기 실패 — 산출물 계약 판정과 stage 귀속이 근사값으로 하락`
        : "stage 카탈로그 미검출 (<root>/<harness>/tools/data/stage-graph.json, .kiro·.claude·.aidlc 등 탐색) — " +
            "산출물 계약 판정과 stage 귀속이 근사값으로 하락. harness 트리가 다른 곳에 있으면 --harness 로 지정할 것",
    );
  }
  const isStage = catalog ? (s: string) => catalog?.bySlug.has(s) : undefined;

  let stateText: string;
  try {
    stateText = fs.readFileSync(statePath, "utf-8");
  } catch {
    throw new NoRunError("none", root);
  }
  const state = parseState(stateText);

  const ledger = readAuditLedger(recordDir, isStage);
  if (ledger.events.length === 0) warnings.push("감사 기록 비어 있음 — hook 미발화 가능성");

  const sensors = readSensorReport(recordDir, ledger);
  const questions = readQuestions(recordDir);
  const diaries = readDiaries(recordDir);
  const health = readHealth(recordDir);
  const timing = buildTiming(ledger, now);

  const construction = state.phases.find((p) => p.key === "construction");
  const matrix = construction
    ? scanConstructionMatrix(recordDir, construction.stages, catalog)
    : undefined;

  // Per-stage file listing for the overview's expandable rows, keyed the way the
  // renderer identifies a row. SKIP stages are scanned too — a skipped stage that
  // somehow has files on disk is worth seeing — and each scan is one readdir.
  //
  // CONSTRUCTION LIVES AT TWO DEPTHS. `construction/` holds BOTH per-unit dirs
  // (`construction/PU-1-.../code-generation/`) and the global stage dirs
  // (`construction/code-generation/`), and which one a stage uses is not
  // knowable from the checkbox: `StageInfo.bolt` is set only when state.md wrote
  // `#### Bolt:` sections, and a real run was observed with per-unit artifacts
  // on disk and bolt undefined on every Construction row. So for Construction we
  // scan the global dir AND every unit the matrix roster knows, then merge —
  // whichever exists contributes. Without the merge those files are invisible.
  const artifacts: Record<string, StageArtifact[]> = {};
  const units = matrix ? matrix.units.map((u) => u.name) : [];
  for (const p of state.phases) {
    for (const s of p.stages) {
      if (s.bolt) {
        // Explicit Bolt section: one unambiguous path.
        artifacts[`construction/${s.bolt}/${s.slug}`] ??= listStageArtifacts(
          recordDir,
          p.key,
          s.slug,
          s.bolt,
        );
        continue;
      }
      const key = `${p.key}/${s.slug}`;
      if (artifacts[key]) continue;
      const merged = listStageArtifacts(recordDir, p.key, s.slug);
      if (p.key === "construction") {
        for (const u of units) merged.push(...listStageArtifacts(recordDir, p.key, s.slug, u));
        // Re-sort across the merge: each listStageArtifacts call sorted its own
        // directory, but concatenation puts the global dir's files before every
        // unit's regardless of name. Unit-major, matching the per-call order.
        merged.sort(
          (a, b) => (a.unit ?? "").localeCompare(b.unit ?? "") || a.name.localeCompare(b.name),
        );
      }
      artifacts[key] = merged;
    }
  }

  // Quantify the graph's drift so the badge can say what is actually missing,
  // rather than only that it is old.
  let graphDriftNote: string | undefined;
  const graphFired = ((): number | undefined => {
    try {
      const doc = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
      if (!Array.isArray(doc?.stages)) return undefined;
      return doc.stages.reduce(
        (n: number, s: Record<string, unknown>) =>
          n + (Array.isArray(s.sensor_firings) ? s.sensor_firings.length : 0),
        0,
      );
    } catch {
      return undefined;
    }
  })();
  if (graphFired !== undefined && sensors.totalFired > graphFired) {
    graphDriftNote = `감사 기록의 sensor 발화 ${sensors.totalFired}건 중 ${sensors.totalFired - graphFired}건이 이 스냅샷에 부재`;
  }

  const provenance = buildProvenance({
    now,
    auditLastTs: ledger.lastTs,
    stateLastUpdated: state.lastUpdated,
    statePath,
    graphPath,
    graphLastEventTs: graphLastEvent(graphPath),
    hooksLastActivity: health.lastActivity,
    catalogPath: catalog?.sourcePath,
    graphDriftNote,
  });

  // resolved.rel is `aidlc/spaces/<space>/intents/<record>/aidlc-state.md`.
  const relParts = resolved.rel.split("/");
  const space = relParts[2] ?? "default";
  const record = relParts[4] ?? path.basename(recordDir);

  const identity: RunIdentity = {
    root,
    space,
    record,
    stateRel: resolved.rel,
    recordDir,
    harnessDir: catalog?.harnessDir,
    ...readRegistry(root, space, record),
  };

  // Usage slot. Which provider runs is resolved here, then that provider's
  // assembly is isolated: both read outside the workspace (SQLite handle / home
  // dir) and a failure there must degrade the one panel, never the dashboard
  // (BR1.4 / NFR1.5).
  const window = usageCtx?.window ?? "30d";
  const mode = usageCtx?.mode ?? "auto";
  // Resolve against the harness that was ASKED FOR or discovered, not the one the
  // catalogue reports: a `--harness .claude` whose stage-graph.json is unreadable
  // leaves `catalog` undefined, and reading the kind off the catalogue would then
  // silently show the credit panel for a Claude run.
  const usageKind = resolveUsageKind(mode, catalog?.harnessDir ?? discoveredHarness);
  if (mode === "auto" && harnesses.length > 1) {
    warnings.push(
      `harness 디렉터리 ${harnesses.join("·")} 가 공존 — 사용량 패널을 ${usageKind === "claude" ? "Claude Code 토큰" : "Kiro 크레딧"}으로 자동 선택했습니다. 다른 쪽을 보려면 --usage ${usageKind === "claude" ? "kiro" : "claude"} 를 지정하세요.`,
    );
  }

  let usage: UsageView;
  if (usageKind === "claude") {
    try {
      const agg = readTranscripts(root, window, {
        home: usageCtx?.home,
        now: new Date(now),
        memo: usageCtx?.memo,
      });
      usage = { kind: "claude", tokens: assembleTokens(agg, window) };
    } catch (err) {
      warnings.push(
        `토큰 사용량 조립 실패 — 사용량 패널만 하락: ${err instanceof Error ? err.message : String(err)}`,
      );
      usage = { kind: "claude", tokens: emptyTokens(window) };
    }
  } else if (usageCtx?.store) {
    try {
      usage = {
        kind: "kiro",
        credit: assembleCredit(usageCtx.store, new Date(now), window, usageCtx.collecting),
      };
    } catch (err) {
      warnings.push(
        `크레딧 조립 실패 — 크레딧 패널만 하락: ${err instanceof Error ? err.message : String(err)}`,
      );
      usage = { kind: "kiro", credit: emptyCredit(window, usageCtx.collecting) };
    }
  } else {
    usage = { kind: "kiro", credit: emptyCredit(window, usageCtx?.collecting) };
  }

  const recent = ledger.events
    .slice(-RECENT_EVENT_LIMIT)
    .reverse()
    .map((e) => ({
      ts: e.ts,
      event: e.event,
      stage: e.stage,
      unit: e.unit,
      detail: eventDetail(e.fields),
      shard: e.shard,
    }));

  return {
    generatedAt: now,
    identity,
    state,
    matrix,
    sensors,
    questions,
    diaries,
    health,
    timing,
    blockers: buildBlockers(questions, state.currentStage, now),
    gates: buildGates(ledger, state.revisionCount, timing.awaitingStage),
    usage,
    eventCounts: [...ledger.counts].sort((a, b) => b[1] - a[1]),
    recentEvents: recent,
    totalEvents: ledger.events.length,
    provenance,
    warnings,
    artifacts,
  };
}
