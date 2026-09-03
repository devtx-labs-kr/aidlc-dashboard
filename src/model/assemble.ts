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
import { readDeferrals } from "../scan/deferrals";
import { readHealth } from "../scan/hooks-health";
import { type StateCompat, readUnitLifecycle, scanConstructionMatrix } from "../scan/matrix";
import { readDiaries } from "../scan/memory-diary";
import { type StageStatus, parseState } from "../scan/parser";
import { readQuestions } from "../scan/questions";
import { resolveState } from "../scan/resolve";
import { buildRework } from "../scan/rework";
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
        kind: q.kind,
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
  // Display names come from the tree's own catalogue when it has one — the local table
  // in scan/parser.ts is a snapshot of the engine's stage roster and had already gone
  // stale (v2.7's `domain-design` / `contract-design` were missing).
  const state = parseState(stateText, catalog ? (s) => catalog?.bySlug.get(s)?.name : undefined);

  const ledger = readAuditLedger(recordDir, isStage);
  if (ledger.events.length === 0) warnings.push("감사 기록 비어 있음 — hook 미발화 가능성");

  const sensors = readSensorReport(recordDir, ledger);
  const questions = readQuestions(recordDir);
  const diaries = readDiaries(recordDir);
  const health = readHealth(recordDir);
  const timing = buildTiming(ledger, now);

  // The deferral ledger needs to know where each assigned stage currently stands.
  // Keyed by slug with EVERY occurrence's status, because a Construction stage slug
  // repeats once per unit and "the stage this was deferred to has finished" is only
  // true when all of its copies have — see scan/deferrals.ts.
  const stageStatuses = new Map<string, StageStatus[]>();
  for (const p of state.phases) {
    for (const s of p.stages) {
      const seen = stageStatuses.get(s.slug);
      if (seen) seen.push(s.status);
      else stageStatuses.set(s.slug, [s.status]);
    }
  }
  const deferrals = readDeferrals(recordDir, {
    stageStatuses,
    catalogSlugs: catalog ? new Set(catalog.bySlug.keys()) : undefined,
    isStage,
    now,
  });

  // STATE / CATALOGUE COMPATIBILITY, measured rather than versioned.
  //
  // The engine refuses a state whose `State Version` does not match the compiled graph
  // — `classifyStateVersion()` in aidlc-lib.ts, enforced by both `next`/`report` and
  // `--doctor` — and names the reason: v2.7 (version 8) renamed `application-design` to
  // `domain-design` and inserted `contract-design`, "so a pre-v8 state file's stage rows
  // no longer match the compiled graph". Reading a v7 state against a v8 catalogue
  // produces a plausible and wrong page, because every contract judgement below is made
  // against the wrong contract.
  //
  // This does NOT hardcode the number. A pinned `8` would go stale the way the
  // STAGE_DISPLAY table did, and it cannot see a hand-edited roster at all. What matters
  // is the thing the version stands for, so compare the ROSTERS: a slug the state lists
  // and the catalogue does not know (or the reverse) IS the incompatibility, and it is
  // visible in the data on any version, present or missing.
  //
  // DIRECTION DEPENDS ON WHETHER THE VERSIONS AGREE, and the first reason given here for
  // going one-directional was simply wrong: it claimed "a scope can exclude stages from
  // enumeration", but the state contract says the engine emits "one checkbox row per
  // compiled stage in that phase" and spells SKIP as a row (`- [ ] slug — SKIP: reason`).
  // So when both sides declare a version AND the versions match, the state SHOULD list
  // every compiled stage and a catalogue-only stage is a real divergence — compare both
  // directions. When agreement cannot be established (either side silent), fall back to
  // one direction: a state listing a stage the catalogue never heard of is unambiguous on
  // any version, while the reverse there is just a thinner tree. That fallback is what
  // keeps this repo's own version-less synthetic fixture from reporting a mismatch.
  // The declared numbers, when BOTH sides declare one. The harness states the schema it
  // supports in its own `aidlc-lib.ts`; the state file states the schema it was written
  // against. A difference is what the engine refuses, and it is invisible to the roster
  // check below when the roster happens to match — a state relabelled 7 on a v8 roster
  // reads clean there, and the engine would still refuse to run it.
  const harnessVersion = catalog?.stateVersion;
  // A DECLARED difference blocks, exactly like a roster mismatch. Warning and then
  // handing the same catalogue to the matrix anyway was the worst of both: the page said
  // the two sources disagree and then judged v7 cells against the v8 contract regardless.
  const versionMismatch =
    harnessVersion !== undefined &&
    state.stateVersion !== undefined &&
    harnessVersion !== state.stateVersion;
  if (versionMismatch) {
    warnings.push(
      `state.md 은 State Version ${state.stateVersion}, harness 는 ${harnessVersion} 을 지원합니다 (${catalog?.harnessDir}/tools/aidlc-lib.ts) — 엔진은 이 조합에서 next·report·doctor 를 모두 거부합니다. 다른 세대의 계약으로 판정할 수 없어 산출물 계약 판정을 내렸습니다`,
    );
  }
  // Missing / empty / non-numeric is `unparseable` to the engine and also refused. It is
  // reported, but it does NOT block: the version field being absent says nothing about
  // whether the ROSTER diverged, and the roster check below is what actually measures
  // that. Blocking here would degrade the matrix to 2-state — which hides blocked units
  // — on the strength of a missing label alone.
  // THREE-VALUED, because "verified" was claiming something never done: with the harness
  // silent about its own version there is nothing to compare against, so the honest
  // answer is `unknown`, not `verified`.
  const stateVersionReadable = state.stateVersion !== undefined && /^\d+$/.test(state.stateVersion);
  const stateCompat: StateCompat = versionMismatch
    ? "incompatible"
    : stateVersionReadable && harnessVersion !== undefined
      ? "verified"
      : "unknown";
  if (!stateVersionReadable) {
    warnings.push(
      `state.md 의 State Version 을 읽을 수 없습니다 (${state.stateVersion === undefined ? "필드 없음" : `값: ${state.stateVersion}`}) — 엔진은 누락·빈 값·비수치를 모두 거부합니다(aidlc-lib.ts classifyStateVersion). 산출물 계약은 그대로 보여주지만 엔진과 동일한 완료 판정이라고 주장하지 않습니다`,
    );
  }

  // TEAM / UNIT-MAJOR: the state's `## Unit Progress` table is the engine-owned authority
  // for owner, per-unit stage state and gate, and it is parsed (scan/parser.ts) rather
  // than reconstructed. What is reported here is when that authority is absent or in a
  // shape the engine itself would refuse.
  //
  // AND, not OR. The contract is "present only when `Unit Ownership: team` AND
  // `Construction Iteration: unit-major`", so `solo` + `unit-major` is a normal run with
  // no such table and must not be told it is missing one. `team` WITHOUT `unit-major` is
  // the misconfiguration, and gets its own line.
  const team = state.unitOwnership?.toLowerCase() === "team";
  const unitMajorMode = state.constructionIteration?.toLowerCase() === "unit-major";
  const teamMode = team && unitMajorMode;
  if (team && !unitMajorMode) {
    warnings.push(
      `Unit Ownership 은 team 인데 Construction Iteration 이 unit-major 가 아닙니다 (${state.constructionIteration ?? "없음"}) — 엔진 계약은 이 둘을 함께 요구하고, 그때만 Unit Progress 표가 존재합니다. 설정을 확인할 것`,
    );
  }
  if (state.unitProgress?.malformed) {
    warnings.push(
      "state.md 의 `## Unit Progress` 표를 엔진이 정한 모양으로 읽지 못했습니다 (표가 줄 맨 앞에서 시작하지 않거나, 첫 열이 `unit` 이 아니거나, 구분선 폭이 헤더와 다름 — 엔진도 같은 조건에서 거부합니다). owner·유닛 게이트를 표시하지 않습니다",
    );
  } else if (teamMode && !state.unitProgress) {
    warnings.push(
      "team / unit-major 실행인데 state.md 에 `## Unit Progress` 절이 없습니다 — owner·유닛 게이트의 권위 있는 원천이 없어 아래 매트릭스는 디스크와 감사 기록으로 재구성한 값입니다",
    );
  }

  const stateSlugs = state.phases.flatMap((p) => p.stages.map((st) => st.slug));
  const unknownToCatalog = catalog ? stateSlugs.filter((sl) => !catalog?.bySlug.has(sl)) : [];
  const versionsAgree =
    harnessVersion !== undefined && state.stateVersion !== undefined && !versionMismatch;
  const missingFromState =
    catalog && versionsAgree
      ? [...catalog.bySlug.keys()].filter((sl) => !stateSlugs.includes(sl))
      : [];
  const rosterMismatch = unknownToCatalog.length > 0 || missingFromState.length > 0;
  if (rosterMismatch) {
    const ver = state.stateVersion
      ? `(State Version: ${state.stateVersion})`
      : "(State Version 없음)";
    const engineNote = "엔진도 이 조합을 거부합니다: aidlc-lib.ts classifyStateVersion";
    warnings.push(
      `state.md 과 stage 카탈로그의 stage 목록이 어긋납니다 ${ver}${unknownToCatalog.length > 0 ? ` · 카탈로그가 모르는 stage: ${unknownToCatalog.join(", ")}` : ""}${missingFromState.length > 0 ? ` · state 에 행이 없는 stage: ${missingFromState.join(", ")} (엔진은 SKIP 도 한 행씩 씁니다)` : ""}. 산출물 계약 판정을 신뢰할 수 없어 근사값으로 내렸습니다 (${engineNote})`,
    );
  }

  const construction = state.phases.find((p) => p.key === "construction");
  const matrix = construction
    ? // A mismatched roster means the catalogue describes a different run shape, so the
      // matrix must not claim contract-awareness. Withholding the catalogue routes it
      // through the existing, already-loud 2-state degradation instead of inventing a
      // second "degraded" mode.
      scanConstructionMatrix(
        recordDir,
        construction.stages,
        rosterMismatch || versionMismatch ? undefined : catalog,
        // Completion receipts come from the audit. Where a stage uses the unit
        // lifecycle they outrank artifact presence — the engine's own rule.
        readUnitLifecycle(ledger.events, { unitMajor: unitMajorMode, teamOwnership: team }),
        // An unverified version does NOT throw the contract away — it withholds the claim
        // that the judgement matches the engine's. Separate axes, not one.
        stateCompat,
      )
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
    deferrals,
    health,
    timing,
    blockers: buildBlockers(questions, state.currentStage, now),
    gates: buildGates(ledger, state.revisionCount, timing.awaitingStage),
    rework: buildRework(ledger),
    usage,
    eventCounts: [...ledger.counts].sort((a, b) => b[1] - a[1]),
    recentEvents: recent,
    totalEvents: ledger.events.length,
    provenance,
    warnings,
    artifacts,
  };
}
