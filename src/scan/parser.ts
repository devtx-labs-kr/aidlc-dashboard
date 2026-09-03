// Parser for aidlc-docs/aidlc-state.md — the single source of truth for
// AI-DLC progress. The parsing rules here are ported verbatim from the
// verified aidlc-statusline.ts hook (extractField / phaseProgress / the
// STAGE_DISPLAY map), so what the status line shows and what this panel
// shows stay in lockstep. No speculative fields — v1 reads state only.

/** Canonical lifecycle phase order and display names. */
export const PHASE_ORDER = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

export type PhaseKey = (typeof PHASE_ORDER)[number];

export const PHASE_DISPLAY: Record<PhaseKey, string> = {
  initialization: "Initialization",
  ideation: "Ideation",
  inception: "Inception",
  construction: "Construction",
  operation: "Operation",
};

/**
 * Stage slug → display name, for a workspace with NO catalogue. Mirrors STAGE_DISPLAY
 * in aidlc-statusline.ts.
 *
 * This is the fallback, not the source: a hardcoded roster of the engine's stages goes
 * stale by construction, and it had. v2.7 renamed `application-design` to
 * `domain-design` and added `contract-design`, so on a real run parked at
 * **domain-design** the panel printed the current stage as raw kebab-case beside
 * "Refined Mockups" — while still carrying the retired name. `stageDisplay()` asks the
 * workspace's own `stage-graph.json` first for that reason; the retired entry stays
 * because an older tree can still hold it in `aidlc-state.md`.
 */
export const STAGE_DISPLAY: Record<string, string> = {
  "workspace-scaffold": "Workspace Scaffold",
  "workspace-detection": "Workspace Detection",
  "state-init": "State Init",
  "intent-capture": "Intent Capture",
  "market-research": "Market Research",
  feasibility: "Feasibility",
  "scope-definition": "Scope Definition",
  "team-formation": "Team Formation",
  "rough-mockups": "Rough Mockups",
  "approval-handoff": "Approval & Handoff",
  "reverse-engineering": "Reverse Engineering",
  "practices-discovery": "Practices Discovery",
  "requirements-analysis": "Requirements Analysis",
  "user-stories": "User Stories",
  "refined-mockups": "Refined Mockups",
  // Retired in v2.7 (→ domain-design). Kept so an older tree still reads.
  "application-design": "Application Design",
  "domain-design": "Domain Design",
  "contract-design": "Contract Design",
  "units-generation": "Units Generation",
  "delivery-planning": "Delivery Planning",
  "functional-design": "Functional Design",
  "nfr-requirements": "NFR Requirements",
  "nfr-design": "NFR Design",
  "infrastructure-design": "Infrastructure Design",
  "code-generation": "Code Generation",
  "build-and-test": "Build and Test",
  "ci-pipeline": "CI Pipeline",
  "deployment-pipeline": "Deployment Pipeline",
  "environment-provisioning": "Env Provisioning",
  "deployment-execution": "Deployment Execution",
  "observability-setup": "Observability Setup",
  "incident-response": "Incident Response",
  "performance-validation": "Performance Validation",
  "feedback-optimization": "Feedback & Optimization",
};

/**
 * A slug with no name anywhere: `nfr-design` → `Nfr Design`. Never leave raw kebab-case
 * on screen beside title-cased siblings — that is how a missing table entry reads as a
 * different KIND of thing rather than as a missing name.
 */
function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Display name for a stage slug, most authoritative source first:
 *
 *   1. the workspace's own `stage-graph.json` (regenerated per harness release, so it
 *      cannot go stale and it knows stages this file has never heard of),
 *   2. STAGE_DISPLAY, for a tree with no harness dir — the common case for a sync copy,
 *   3. the title-cased slug.
 */
export function stageDisplay(
  slug: string,
  fromCatalog?: (slug: string) => string | undefined,
): string {
  return fromCatalog?.(slug) ?? STAGE_DISPLAY[slug] ?? titleCase(slug);
}

// Agent slug → display name. Mirrors the *.md frontmatter display_name values
// in the v2 ruleset (kiro-ide/agents). The orchestrator pseudo-agent has no
// agent file but can appear as Active Agent during orchestrator transitions.
export const AGENT_DISPLAY: Record<string, string> = {
  orchestrator: "Orchestrator",
  "aidlc-architect-agent": "Architect Agent",
  "aidlc-architecture-reviewer-agent": "Architecture Reviewer",
  "aidlc-aws-platform-agent": "AWS Platform Agent",
  "aidlc-compliance-agent": "Compliance Agent",
  "aidlc-delivery-agent": "Delivery Agent",
  "aidlc-design-agent": "Design Agent",
  "aidlc-developer-agent": "Developer Agent",
  "aidlc-devsecops-agent": "DevSecOps Agent",
  "aidlc-operations-agent": "Operations Agent",
  "aidlc-pipeline-deploy-agent": "Pipeline & Deploy Agent",
  "aidlc-product-agent": "Product Agent",
  "aidlc-product-lead-agent": "Product Lead",
  "aidlc-quality-agent": "Quality Agent",
};

// Stage checkbox status. Codes documented inline in aidlc-state.md:
//   [ ] not started, [-] in progress, [?] awaiting approval (gate open),
//   [R] revising (user rejected gate), [x] completed, [S] skipped.
// A "[ ] ... — SKIP" line (scope-excluded stage) is also treated as skipped.
export type StageStatus = "pending" | "active" | "awaiting" | "revising" | "done" | "skipped";

export interface StageInfo {
  slug: string;
  display: string;
  status: StageStatus;
  /** false when the scope marker is SKIP (excluded from this run). */
  execute: boolean;
  /**
   * The Unit name of the `#### Bolt: <unit>` section this stage sits under, or
   * undefined for stages outside any Bolt section — every phase except the
   * per-unit Construction stages, plus the two global Construction stages
   * (build-and-test / ci-pipeline). With per-unit × per-stage state the five
   * Construction stage slugs repeat once per Bolt, so this is how the copies
   * are told apart. Mirrors `CheckboxLine.bolt` in the engine (aidlc-lib.ts).
   */
  bolt?: string;
}

/**
 * One Construction Bolt (Unit of Work) and its five per-unit stages. Derived
 * from the `Per unit:` roster + the `#### Bolt:` sections in aidlc-state.md;
 * a roster Unit with no section yet (not entered) yields an empty `stages`
 * list and `pending` status. See design/per-bolt-progress.md.
 */
export interface BoltInfo {
  /** Unit slug, as listed on the `Per unit:` line. */
  unit: string;
  /** Title-cased display name derived from the slug. */
  display: string;
  /** Status derived from the Bolt's stages (active/awaiting/revising win). */
  status: StageStatus;
  /** The five per-unit stages, or empty when the Bolt is not yet entered. */
  stages: StageInfo[];
  /** Completed executable stages. */
  done: number;
  /** Total executable stages present (0 before the Bolt is entered). */
  total: number;
  /** True when this is the Bolt named by `Current Bolt`. */
  isCurrent: boolean;
}

/**
 * One Bolt batch from the `Bolt batches:` line — the batch coordinate that
 * bolt-plan.md carries but the single-slug `#### Bolt:` grammar cannot. A batch
 * groups one OR several Units (e.g. B3 runs three Units in parallel); the
 * grouping is written by `set-units --batches` (aidlc-state.ts) and is inert to
 * the state machine. Members are the per-Unit `BoltInfo`s, in batch order.
 */
export interface BatchInfo {
  /** Batch label verbatim from bolt-plan.md (e.g. "B1", "B3"). */
  label: string;
  /** The Units in this batch, as BoltInfo, in the order the line lists them. */
  units: BoltInfo[];
  /** Status derived from member Units (active/awaiting/revising win). */
  status: StageStatus;
  /** Completed executable stages summed across the batch's Units. */
  done: number;
  /** Total executable stages summed across the batch's Units. */
  total: number;
  /** True when any member Unit is the `Current Bolt`. */
  isCurrent: boolean;
}

export interface PhaseInfo {
  key: string;
  display: string;
  /** From the "## Phase Progress" section: Active | Pending | Verified | Skipped. */
  declaredStatus: string;
  stages: StageInfo[];
  /** Completed executable stages. */
  done: number;
  /** Total executable (non-skipped) stages. */
  total: number;
  /** 0–100, or null when the phase is fully skipped (no executable stages). */
  pct: number | null;
  skipped: boolean;
}

export interface AidlcState {
  project: string;
  projectType: string;
  /**
   * `State Version` verbatim, or undefined when the field is missing. The engine's
   * `classifyStateVersion()` refuses a state whose version does not match the compiled
   * graph — v2.7 (version 8) renamed `application-design` to `domain-design` and added
   * `contract-design`, so a pre-v8 file's stage rows no longer match. This reader does
   * not enforce a number (that would go stale exactly as STAGE_DISPLAY did); assemble
   * cross-checks the ROSTER against the catalogue instead. The field is carried so the
   * screen can state what the tree declares.
   */
  stateVersion?: string;
  /**
   * `Unit Ownership` / `Construction Iteration`, and whether the state carries the
   * engine-owned `## Unit Progress` projection. Read but NOT interpreted: in
   * `team` + `unit-major` that table — not the disk — is the authority for owner,
   * receipt, review, gate and merged state. Carried so `assemble` can say the panel is
   * not reading it rather than quietly showing a reconstruction. See CLAUDE.md.
   */
  unitOwnership?: string;
  constructionIteration?: string;
  hasUnitProgress: boolean;
  /** The parsed `## Unit Progress` table, when the state carries one. */
  unitProgress?: UnitProgress;
  scope: string;
  lifecyclePhase: string;
  currentStage: string;
  currentStageDisplay: string;
  nextStage: string;
  status: string;
  activeAgent: string;
  activeAgentDisplay: string;
  lastUpdated: string;
  /**
   * `Revision Count` from the Runtime State section — how many times a gate was
   * rejected and a stage sent back. Empty string when the field is absent.
   * Read for the dashboard specifically: rework volume is a quality signal no
   * other panel carries.
   */
  revisionCount: string;
  phases: PhaseInfo[];
  overallDone: number;
  overallTotal: number;
  overallPct: number;
  /** True when the workflow Status field reads Completed / Complete. */
  complete: boolean;
  /**
   * Construction Bolts in `Per unit:` roster order, present only when the
   * Construction block carries a `Per unit:` line (the Bolt-loop engine).
   * Undefined on a stock-engine / pre-Bolt-loop state file, where Construction
   * renders through the flat phase path. See design/per-bolt-progress.md.
   */
  constructionBolts?: BoltInfo[];
  /**
   * Construction Bolts grouped into batches per the `Bolt batches:` line, in
   * batch order. Present only when that line exists; this is the Batch → Unit →
   * Stage view (bolt-plan.md's B1..B4). See design/per-bolt-progress.md.
   */
  constructionBatches?: BatchInfo[];
  /** The `Current Bolt` field value, when present. */
  currentBolt?: string;
}

// Match the Markdown list field pattern used throughout aidlc-state.md:
//   - **Lifecycle Phase**: IDEATION
// Anchored on "^-\s*\*\*LABEL\*\*:" so prose lines that merely contain the
// label cannot hijack the value. Ported from aidlc-statusline.ts:extractField.
function extractField(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^-\\s*\\*\\*${escaped}\\*\\*:[^\\S\\n]*([^\\n]*)`, "m");
  const m = text.match(re);
  return m?.[1] !== undefined ? m[1].replace(/\r$/, "").trim() : "";
}

// `#### Bolt: <unit-name>` section heading. Mirrors BOLT_HEADING_RE in the
// engine (aidlc-lib.ts) so the panel groups Construction stages exactly as the
// engine does.
const BOLT_HEADING_RE = /^####\s+Bolt:\s+([a-z0-9][a-z0-9-]*)\s*$/;

// The `Per unit: a, b, c` roster line under `### CONSTRUCTION PHASE`: the full,
// ordered Unit list, present even before a Bolt has been entered.
const PER_UNIT_RE = /^Per unit:\s*(.+)$/m;

// The `Bolt batches: B1=[a], B2=[b, c]` line written by set-units --batches
// (aidlc-state.ts). Inert metadata: the batch coordinate (bolt-plan.md's
// B1..B4) that the single-slug `#### Bolt:` grammar cannot carry. One group
// per batch; a group is `LABEL=[unit, unit]`. The line is the normalised form
// the engine emits, so the parse mirrors it verbatim.
const BOLT_BATCHES_RE = /^Bolt batches:\s*(.+)$/m;
const BATCH_GROUP_RE = /([^\s=\[\],]+)\s*=\s*\[([^\]]*)\]/g;

function stageStatusFromBox(box: string, isSkipMarker: boolean): StageStatus {
  if (box === "x") return "done";
  if (box === "-") return "active";
  if (box === "?") return "awaiting";
  if (box === "R") return "revising";
  if (box === "S") return "skipped";
  // box === " " (or anything else): pending, unless scope-excluded.
  return isSkipMarker ? "skipped" : "pending";
}

/**
 * Parse the "## Phase Progress" section into a phaseKey → declared status map.
 * Lines look like: `- **Initialization**: Active`.
 */
function parseDeclaredPhaseStatus(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^-\s*\*\*([A-Za-z]+)\*\*:\s*([A-Za-z]+)/gm;
  // Restrict to the Phase Progress section to avoid colliding with other
  // bold-list fields (Project, Scope, …) elsewhere in the document.
  const section = sliceSection(text, "## Phase Progress");
  let m = re.exec(section);
  while (m !== null) {
    const key = m[1]!.toLowerCase();
    if ((PHASE_ORDER as readonly string[]).includes(key)) {
      out[key] = m[2]!;
    }
    m = re.exec(section);
  }
  return out;
}

/** Return the text from a "## Heading" up to the next "## " heading. */
function sliceSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const after = start + heading.length;
  const next = text.indexOf("\n## ", after);
  return next < 0 ? text.slice(after) : text.slice(after, next);
}

/**
 * Parse the "## Stage Progress" section into per-phase stage lists, grouped by
 * the `### XXX PHASE` sub-headings. Stage lines look like:
 *   - [x] workspace-scaffold — EXECUTE
 *   - [ ] reverse-engineering — SKIP
 */
export function parseStages(
  text: string,
  catalogName?: (slug: string) => string | undefined,
): Map<string, StageInfo[]> {
  const byPhase = new Map<string, StageInfo[]>();
  const lines = text.split(/\r?\n/);
  let current: string | null = null;
  // Enclosing `#### Bolt:` section, tracked only within a phase block. A Bolt
  // section runs from its heading to the first BLANK LINE or any `#`–`###`
  // heading — the exact boundary the engine uses (aidlc-lib.ts:2073), so the
  // two global Construction stages (build-and-test / ci-pipeline), which follow
  // the last Bolt section with no heading of their own, are NOT tagged.
  let currentBolt: string | undefined;
  // The em dash (—) separates slug from the EXECUTE/SKIP marker; we don't
  // depend on it — we read the box + slug, then test the whole line for SKIP.
  const stageRe = /^-\s*\[(.)\]\s*([a-z0-9-]+)/;
  for (const line of lines) {
    const head = line.match(/^###\s+([A-Za-z]+)\s+PHASE/i);
    if (head) {
      current = head[1]!.toLowerCase();
      currentBolt = undefined;
      if (!byPhase.has(current)) byPhase.set(current, []);
      continue;
    }
    const boltHead = line.match(BOLT_HEADING_RE);
    if (boltHead) {
      currentBolt = boltHead[1];
      continue;
    }
    if (line.startsWith("## ")) current = null; // left the Stage Progress block
    // A blank line or a `#`–`###` heading closes the current Bolt section.
    if (line.trim() === "" || /^#{1,3}\s/.test(line)) currentBolt = undefined;
    if (!current) continue;
    const m = line.match(stageRe);
    if (!m) continue;
    const box = m[1]!;
    const slug = m[2]!;
    const isSkipMarker = /\bSKIP\b/.test(line);
    byPhase.get(current)?.push({
      slug,
      display: stageDisplay(slug, catalogName),
      status: stageStatusFromBox(box, isSkipMarker),
      execute: !isSkipMarker,
      ...(currentBolt !== undefined ? { bolt: currentBolt } : {}),
    });
  }
  return byPhase;
}

/** Title-case a kebab-case unit slug: "study-session" → "Study Session". */
export function displayFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Derive a Bolt's overall status from its stages (active states win). */
function boltStatusFromStages(stages: StageInfo[]): StageStatus {
  const exec = stages.filter((s) => s.execute);
  if (exec.length === 0) return "pending";
  for (const s of exec) {
    if (s.status === "active" || s.status === "awaiting" || s.status === "revising") {
      return s.status;
    }
  }
  if (exec.every((s) => s.status === "done")) return "done";
  return "pending";
}

// A real Unit slug on the `Per unit:` line: kebab-case, exactly the shape the
// engine's BOLT_HEADING_RE accepts. Anything else — most importantly the
// `[TBD]` placeholder the stock stage-major engine leaves until a Bolt loop
// fills the roster — is not a Unit and must not seed a phantom Bolt.
const UNIT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Build the per-Bolt view from the parsed Construction stages + the `Per unit:`
 * roster. Returns undefined when there is no roster line (stock-engine state
 * file) OR the roster holds no real Unit slug (e.g. `Per unit: [TBD]` on the
 * stock stage-major engine), signalling the caller to keep the flat render.
 */
function buildConstructionBolts(
  text: string,
  constructionStages: StageInfo[],
  currentBolt: string,
): BoltInfo[] | undefined {
  const rosterMatch = text.match(PER_UNIT_RE);
  if (!rosterMatch) return undefined;
  const roster = (rosterMatch[1] ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => UNIT_SLUG_RE.test(u));
  if (roster.length === 0) return undefined;

  // Group the tagged Construction stages by their Bolt.
  const byBolt = new Map<string, StageInfo[]>();
  for (const s of constructionStages) {
    if (s.bolt === undefined) continue;
    if (!byBolt.has(s.bolt)) byBolt.set(s.bolt, []);
    byBolt.get(s.bolt)?.push(s);
  }

  return roster.map((unit) => {
    const stages = byBolt.get(unit) ?? [];
    // Same denominator rule as the phase counts below: a skipped stage is not
    // outstanding work, whether the skip came from scope (`— SKIP`) or runtime (`[S]`).
    const executable = stages.filter((s) => s.execute && s.status !== "skipped");
    return {
      unit,
      display: displayFromSlug(unit),
      status: boltStatusFromStages(stages),
      stages,
      done: executable.filter((s) => s.status === "done").length,
      total: executable.length,
      isCurrent: unit === currentBolt,
    };
  });
}

/**
 * Group the per-Unit BoltInfos into batches per the `Bolt batches:` line.
 * Returns undefined when that line is absent. Each batch's Unit members are
 * looked up in `bolts` by slug, preserving the line's order; the batch's
 * done/total are the sums over its members, and its status is derived the same
 * way a single Bolt's is (active states win). See design/per-bolt-progress.md.
 */
function buildConstructionBatches(text: string, bolts: BoltInfo[]): BatchInfo[] | undefined {
  const lineMatch = text.match(BOLT_BATCHES_RE);
  if (!lineMatch) return undefined;
  const byUnit = new Map(bolts.map((b) => [b.unit, b]));

  const batches: BatchInfo[] = [];
  const batchLine = lineMatch[1] ?? "";
  BATCH_GROUP_RE.lastIndex = 0;
  let m = BATCH_GROUP_RE.exec(batchLine);
  while (m !== null) {
    const label = m[1]!;
    const members = (m[2] ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((u) => byUnit.get(u))
      .filter((b): b is BoltInfo => b !== undefined);
    const allStages = members.flatMap((b) => b.stages);
    batches.push({
      label,
      units: members,
      status: boltStatusFromStages(allStages),
      done: members.reduce((n, b) => n + b.done, 0),
      total: members.reduce((n, b) => n + b.total, 0),
      isCurrent: members.some((b) => b.isCurrent),
    });
    m = BATCH_GROUP_RE.exec(batchLine);
  }
  return batches.length > 0 ? batches : undefined;
}

export function parseState(
  text: string,
  /**
   * Name lookup from the workspace's own stage catalogue, when one was found. Passing
   * it makes the display names come from the tree being read rather than from this
   * file's snapshot of the engine — see `stageDisplay`.
   */
  catalogName?: (slug: string) => string | undefined,
): AidlcState {
  const project = extractField(text, "Project");
  const projectType = extractField(text, "Project Type");
  const stateVersion = extractField(text, "State Version");
  const unitOwnership = extractField(text, "Unit Ownership");
  const constructionIteration = extractField(text, "Construction Iteration");
  // `## Unit Progress` is an engine-owned projection present only in team/unit-major.
  const unitProgress = parseUnitProgress(text);
  const hasUnitProgress = unitProgress !== undefined;
  const scope = extractField(text, "Scope");
  const lifecyclePhase = extractField(text, "Lifecycle Phase");
  const currentStage = extractField(text, "Current Stage");
  const nextStage = extractField(text, "Next Stage");
  const status = extractField(text, "Status");
  const activeAgent = extractField(text, "Active Agent");
  const lastUpdated = extractField(text, "Last Updated");
  const revisionCount = extractField(text, "Revision Count");
  const currentBolt = extractField(text, "Current Bolt");

  const declared = parseDeclaredPhaseStatus(text);
  const stagesByPhase = parseStages(text, catalogName);

  const phases: PhaseInfo[] = [];
  let overallDone = 0;
  let overallTotal = 0;

  for (const key of PHASE_ORDER) {
    const stages = stagesByPhase.get(key) ?? [];
    if (stages.length === 0 && !(key in declared)) continue; // phase absent
    // A skipped stage leaves the denominator however the skip was expressed. Two
    // shapes mean it: `— SKIP` (scope-excluded, so `execute` is false) and the `[S]`
    // checkbox (in scope, but the run skipped it — the audit carries a matching
    // STAGE_SKIPPED). Only the first used to be excluded, so a run that skipped a
    // stage at runtime could never reach 100%: measured on a real run, overall read
    // 20/25 = 80% with `[S] market-research — EXECUTE` outstanding forever, while
    // its own Ideation phase read 86% though state.md declared that phase Verified.
    // Dropping both kinds gives 20/24 = 83% overall and Ideation 100%, which agrees
    // with the engine's own verdict.
    const executable = stages.filter((s) => s.execute && s.status !== "skipped");
    const total = executable.length;
    const done = executable.filter((s) => s.status === "done").length;
    const declaredStatus = declared[key] ?? "";
    const skipped =
      declaredStatus.toLowerCase() === "skipped" || (total === 0 && stages.length > 0);
    overallDone += done;
    overallTotal += total;
    phases.push({
      key,
      display: PHASE_DISPLAY[key],
      declaredStatus,
      stages,
      done,
      total,
      pct: total > 0 ? Math.round((done * 100) / total) : null,
      skipped,
    });
  }

  const overallPct = overallTotal > 0 ? Math.round((overallDone * 100) / overallTotal) : 0;
  const complete = status === "Completed" || status === "Complete";

  // Per-Bolt Construction view — present only when a `Per unit:` roster exists.
  // The overall done/total above are untouched (Option A): the Bolt dimension
  // is a presentation layer over the same flat counts.
  const constructionBolts = buildConstructionBolts(
    text,
    stagesByPhase.get("construction") ?? [],
    currentBolt,
  );
  // Batch grouping (Batch → Unit → Stage) per the `Bolt batches:` line, layered
  // over the per-Unit bolts. Present only when both exist.
  const constructionBatches = constructionBolts
    ? buildConstructionBatches(text, constructionBolts)
    : undefined;

  return {
    project,
    projectType,
    ...(stateVersion ? { stateVersion } : {}),
    ...(unitOwnership ? { unitOwnership } : {}),
    ...(constructionIteration ? { constructionIteration } : {}),
    hasUnitProgress,
    ...(unitProgress ? { unitProgress } : {}),
    scope,
    lifecyclePhase,
    currentStage,
    currentStageDisplay: stageDisplay(currentStage, catalogName),
    nextStage,
    status,
    activeAgent,
    activeAgentDisplay: AGENT_DISPLAY[activeAgent] ?? activeAgent,
    lastUpdated,
    revisionCount,
    phases,
    overallDone,
    overallTotal,
    overallPct,
    complete,
    ...(constructionBolts ? { constructionBolts, currentBolt } : {}),
    ...(constructionBatches ? { constructionBatches } : {}),
  };
}

/**
 * One row of the state's `## Unit Progress` table — the engine-owned projection that is
 * authoritative for owner, per-unit stage state and gate in `team` + `unit-major`.
 *
 * PARSED THE WAY THE ENGINE PARSES IT, not from the prose template. `aidlc-state.ts::
 * parseUnitProgressTable` locates the section with `/^## Unit Progress\r?$/m`, takes the
 * first `|` line as the header, requires `header[0] === "unit"` and a separator row of
 * the same width, then keys rows by their first cell. Mirroring that is why this is
 * implementable at all: an earlier note here refused to write it for want of a real tree
 * to measure, which was the right instinct about the TEMPLATE and the wrong conclusion
 * about the WRITER — reading the writer's own format is the same move as preferring
 * `stage-graph.json` over a hardcoded stage list.
 *
 * COLUMNS ARE READ BY HEADER, never by position. Between `unit` and `gate` sit "per-unit
 * Construction stage columns in graph order", and the set is whatever the graph compiled;
 * an optional `merged` column may follow. Fixed indices would mis-read every run whose
 * stage set differs.
 */
export interface UnitProgressRow {
  unit: string;
  /** `-` until the claim increment supplies ownership; kept verbatim. */
  owner?: string;
  /** Stage column header → checkbox status, for the columns this table carries. */
  stages: Record<string, StageStatus>;
  /** The `gate` cell's status, when the table carries that column. */
  gate?: StageStatus;
  /** The `merged` cell verbatim, when present — optional in the contract. */
  merged?: string;
}

export interface UnitProgress {
  rows: UnitProgressRow[];
  /** Stage column headers in table order, i.e. compiled graph order. */
  stageColumns: string[];
  /** True when the section exists but could not be parsed to the engine's shape. */
  malformed: boolean;
}

/** Checkbox cell → status, using the same vocabulary as `## Stage Progress`. */
function cellStatus(cell: string): StageStatus | undefined {
  const m = /^\[(.)\]$/.exec(cell.trim());
  if (!m) return undefined;
  return stageStatusFromBox(m[1] ?? " ", false);
}

/**
 * Read `## Unit Progress`. Returns undefined when the section is absent (the normal case
 * — it exists only in team/unit-major). Never throws; a shape the engine would refuse
 * comes back `malformed` with no rows, so the panel can say so instead of guessing.
 */
export function parseUnitProgress(text: string): UnitProgress | undefined {
  const head = /^##[ \t]+Unit Progress[ \t]*$/m.exec(text.replace(/\r\n/g, "\n"));
  if (!head) return undefined;
  const body = text.replace(/\r\n/g, "\n").slice(head.index + head[0].length);
  const section = body.split(/^## /m)[0] ?? "";
  const lines = section.split("\n");
  // `startsWith("|")` with NO trim, because that is exactly what the engine accepts
  // (`lines.findIndex((line) => line.startsWith("|"))`). Tolerating an indented table here
  // meant calling a table "authoritative" that `aidlc-state.ts` would refuse outright.
  const first = lines.findIndex((l) => l.startsWith("|"));
  if (first < 0) return { rows: [], stageColumns: [], malformed: true };
  const table = lines
    .slice(first)
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const header = table[0];
  const separator = table[1];
  // The engine's own two guards: `header[0]` must be `unit`, and the separator must be
  // the same width. Anything else it calls "Invalid Unit Progress table header".
  if (!header || !separator || header[0]?.toLowerCase() !== "unit") {
    return { rows: [], stageColumns: [], malformed: true };
  }
  if (separator.length !== header.length) return { rows: [], stageColumns: [], malformed: true };

  const lower = header.map((h) => h.toLowerCase());
  const ownerAt = lower.indexOf("owner");
  const gateAt = lower.indexOf("gate");
  const mergedAt = lower.indexOf("merged");
  const stageAt = header
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => i !== 0 && i !== ownerAt && i !== gateAt && i !== mergedAt);

  const rows: UnitProgressRow[] = [];
  for (const cells of table.slice(2)) {
    if (cells.length !== header.length) continue;
    if (cells.every((c) => /^-+$/.test(c))) continue;
    const unit = cells[0];
    if (!unit) continue;
    const stages: Record<string, StageStatus> = {};
    for (const { h, i } of stageAt) {
      const st = cellStatus(cells[i] ?? "");
      if (st) stages[h] = st;
    }
    const owner = ownerAt >= 0 ? cells[ownerAt] : undefined;
    const gate = gateAt >= 0 ? cellStatus(cells[gateAt] ?? "") : undefined;
    const merged = mergedAt >= 0 ? cells[mergedAt] : undefined;
    rows.push({
      unit,
      ...(owner ? { owner } : {}),
      stages,
      ...(gate ? { gate } : {}),
      ...(merged ? { merged } : {}),
    });
  }
  return { rows, stageColumns: stageAt.map(({ h }) => h), malformed: false };
}
