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

// Stage slug → display name. Mirrors STAGE_DISPLAY in aidlc-statusline.ts.
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
  "application-design": "Application Design",
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
export function parseStages(text: string): Map<string, StageInfo[]> {
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
      display: STAGE_DISPLAY[slug] ?? slug,
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
    const executable = stages.filter((s) => s.execute);
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

export function parseState(text: string): AidlcState {
  const project = extractField(text, "Project");
  const projectType = extractField(text, "Project Type");
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
  const stagesByPhase = parseStages(text);

  const phases: PhaseInfo[] = [];
  let overallDone = 0;
  let overallTotal = 0;

  for (const key of PHASE_ORDER) {
    const stages = stagesByPhase.get(key) ?? [];
    if (stages.length === 0 && !(key in declared)) continue; // phase absent
    const executable = stages.filter((s) => s.execute);
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
    scope,
    lifecyclePhase,
    currentStage,
    currentStageDisplay: STAGE_DISPLAY[currentStage] ?? currentStage,
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
