// Reconstruct the Construction per-unit progress matrix. The (unit × stage)
// progress is not carried by any single file:
//
//   - aidlc-state.md      → one checkbox for the WHOLE stage, no per-unit cursor
//   - runtime-graph.json  → `bolt_dag` has the unit ROSTER + topology + each
//                           unit's `kind`, but its `stages` rows carry no unit
//                           field (so no per-unit progress), and it is only
//                           recompiled at transitions so it lags mid-stage
//   - construction/<unit>/<stage>/ dirs → the only live record of which unit has
//                           produced what
//
// So the matrix is `bolt_dag` (structure) × disk (completion) × stage-graph.json
// (the artifact contract that says when a unit's segment is actually DONE).
//
// WHY THREE STATES. The obvious rule — a cell is present when the segment dir is
// non-empty — over-reports: a unit stopped at its plan-approval question has
// `code-generation-plan.md` + `code-generation-questions.md` on disk but no
// `code-summary.md`, and reads as fully present — which hides the very unit the
// run is blocked on. Intersecting the dir listing with the stage's contracted
// artifacts for that unit's kind separates "started" from "finished" and names
// what is missing. Verified on a 9-unit run: 30 of 31 populated cells matched
// the contract exactly and the single mismatch was the real blocker.
//
// Degradation: no stage catalogue (older harness, partial sync) → fall back to the
// binary present/absent rule, with `expected` empty and state never "partial".
//
// Node fs only (local FS) — no vscode import — so it stays unit-testable headless
// the way parser.ts / resolve.ts are.

import * as fs from "node:fs";
import * as path from "node:path";
import { type StageInfo, type StageStatus, displayFromSlug } from "./parser";
import {
  type StageCatalog,
  expectedArtifacts,
  requiredArtifacts,
  vacuouslyCovered,
} from "./stage-catalog";

// The per-unit Construction stage slugs — the stages the engine runs once per Unit of
// Work (each writing a `construction/<unit>/<stage>/` segment). The remaining
// Construction stages (build-and-test / ci-pipeline) run once globally and are NOT
// part of the matrix.
//
// FALLBACK ONLY. The stage graph declares this per stage as `for_each: "unit-of-work"`
// and `CatalogStage.forEach` already parsed it, while this hardcoded set did the
// deciding — the same "fixed list instead of the declared contract" shape the harness
// discovery and STAGE_DISPLAY notes warn about, and it would silently mis-shape the
// matrix the first time the engine adds or retires a per-unit stage. `isPerUnitStage`
// asks the catalogue first; this set is what a tree with no harness dir falls back to.
export const PER_UNIT_STAGE_SLUGS: ReadonlySet<string> = new Set([
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
]);

/** How the state file's declared schema version compares with the harness's. */
export type StateCompat = "verified" | "unknown" | "incompatible";

/**
 * The per-stage unit-receipt ledger, read from the audit. Mirrors the engine's two
 * modes exactly (`aidlc-orchestrate.ts::unitLedgerFor`): once a stage has ANY unit
 * lifecycle event, its `UNIT_COMPLETED` receipts are the completion authority and
 * artifacts are only evidence; a stage with no lifecycle events at all is "a genuinely
 * ledger-free legacy flow" and stays artifact-driven, which is the behaviour every
 * earlier tree had. Absent entirely → artifact-driven, unchanged.
 */
/**
 * Whether a unit's stage is done, per the engine's receipt rules.
 *
 * THREE STATES, because a boolean conflated two different answers. `settled(): boolean`
 * returned false both for "the engine says this unit is not done" and for "this reader
 * cannot tell" — so every gap in our reproduction of the engine printed as a red ▩, which
 * is a fabricated blocker. `unverifiable` is the honest third answer, and it is the same
 * discipline as `Provenance` elsewhere in this model: a source we cannot check gets its own
 * shape rather than borrowing a verdict.
 */
export type ReceiptState = "settled" | "unsettled" | "unverifiable";

/**
 * WHY a receipt could not be checked. Carried rather than collapsed, because the four
 * causes do not agree on what the ENGINE would say — and that is a different question
 * from what this reader can prove:
 *
 *   no-run-floor        the engine's verdict is KNOWN and it is "uncovered": a row with no
 *                       `Run floor` fails its exact-match test, and the engine will re-fan
 *                       the unit. What is unknown is only whether the work is actually
 *                       done. So this one must NOT be labelled "not incomplete".
 *   team-claim          the claim FILE decides (`eventMatchesClaimAttempt`); the engine
 *                       could settle it or not, and neither is derivable here.
 *   wave-fingerprint    an artifact fingerprint decides; same.
 *   ambiguous-floor     the floor is `AMBIGUOUS:<ts>#<digest>`, not reproducible; same.
 */
export type ReceiptReason = "no-run-floor" | "team-claim" | "wave-fingerprint" | "ambiguous-floor";

export interface ReceiptVerdict {
  state: ReceiptState;
  /** Set only when `state` is `unverifiable`. */
  reason?: ReceiptReason;
}

export interface UnitLifecycle {
  /** True when this stage has emitted any UNIT_* event, i.e. receipts are in force. */
  inUse: (stageSlug: string) => boolean;
  /** How this unit's receipt for this stage reads, and why when it cannot be read. */
  state: (unit: string, stageSlug: string) => ReceiptVerdict;
}

/** UNIT_* events, per audit-format.md. Any of them proves the ledger is in use. */
const UNIT_LIFECYCLE_EVENTS = new Set([
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
]);

export interface LifecycleEvent {
  event: string;
  ts?: string;
  stage?: string;
  unit?: string;
  shard?: string;
  fields?: Record<string, string>;
}

/** Boundary events that raise EVERY stage's floor. */
const GLOBAL_BOUNDARY = new Set(["WORKFLOW_STARTED", "STAGE_JUMPED"]);

/** `Gate Stages` (comma list) else the `Stage` field — the engine's own fallback. */
function gateStages(e: LifecycleEvent): string[] {
  const explicit = e.fields?.["Gate Stages"];
  if (explicit) {
    return explicit
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return e.stage ? [e.stage] : [];
}

/**
 * Read the per-stage unit-receipt ledger from the audit, reproducing
 * `aidlc-lib.ts::currentUnitLifecycleRows` + `unitLifecycleSnapshot` as far as the audit
 * alone allows, and reporting `unverifiable` for the rest rather than guessing.
 *
 * ORDER: compute the attempt floor → keep only rows whose `Run floor` field EQUALS it →
 * reduce cross-shard same-second groups by safety rank → replay, completion adds and
 * anything else deletes. Getting that order wrong is not cosmetic: checking wave mode
 * before the floor filter let ONE old wave row block every later attempt for good.
 *
 * THE FLOOR IS SCOPED PER UNIT UNDER TEAM OWNERSHIP (`key = teamOwnership ? unit : ""` in
 * the engine). One stage-wide floor meant unit A's `GATE_REJECTED` invalidated unit B's
 * finished work.
 *
 * THE FLOOR STRING IS REBUILT, NOT COMPARED LOOSELY. The engine compares the row's field
 * against `<event>:<timestamp>#<ordinal>` where the ordinal counts that event name among
 * the boundary rows, or `unstarted#0` with no boundary at all. Asking only "is this row
 * after the last boundary?" accepted a row carrying a stale floor, and accepted rows with
 * no floor field at all.
 */
export function readUnitLifecycle(
  events: readonly LifecycleEvent[],
  opts: { unitMajor?: boolean; teamOwnership?: boolean } = {},
): UnitLifecycle {
  const rows = events.map((e, i) => ({ e, i }));
  const lifecycle = rows.filter(
    ({ e }) => !!e.stage && UNIT_LIFECYCLE_EVENTS.has(e.event) && !!e.unit,
  );
  const inUse = new Set(lifecycle.map(({ e }) => e.stage as string));
  const pairs = new Map<string, { stage: string; unit: string }>();
  for (const { e } of lifecycle) {
    pairs.set(`${e.stage}\u0001${e.unit}`, { stage: e.stage as string, unit: e.unit as string });
  }

  /** The engine's floor token for one (stage, unit), or null when it is AMBIGUOUS. */
  const floorFor = (stage: string, unit: string): string | null => {
    const boundary = rows.filter(({ e }) => {
      if (e.ts === undefined) return false;
      if (GLOBAL_BOUNDARY.has(e.event)) return true;
      if (e.event === "GATE_REJECTED") {
        if (!gateStages(e).includes(stage)) return false;
        const eventUnit = e.fields?.Unit;
        return eventUnit === undefined || eventUnit === unit;
      }
      return (
        e.event === "STAGE_STARTED" &&
        e.stage === stage &&
        !opts.unitMajor &&
        !e.fields?.Workflow?.startsWith("single-stage:")
      );
    });
    if (boundary.length === 0) return "unstarted#0";
    const latestTs = boundary[boundary.length - 1]!.e.ts as string;
    const tied = boundary.filter(({ e }) => e.ts === latestTs);
    // Tied across shards → the engine mints `AMBIGUOUS:<ts>#<sha>` over per-shard block
    // positions this reader does not have. Not reproducible, so not claimed.
    if (new Set(tied.map(({ e }) => e.shard)).size > 1) return null;
    const ordinals = new Map<string, number>();
    let floor = "unstarted#0";
    for (const { e } of boundary) {
      const n = (ordinals.get(e.event) ?? 0) + 1;
      ordinals.set(e.event, n);
      floor = `${e.event}:${e.ts}#${n}`;
    }
    return floor;
  };

  const out = new Map<string, ReceiptVerdict>();
  for (const [key, { stage, unit }] of pairs) {
    const floor = floorFor(stage, opts.teamOwnership ? unit : "");
    if (floor === null) {
      out.set(key, { state: "unverifiable", reason: "ambiguous-floor" });
      continue;
    }
    // Under team ownership the engine compares each row's `Attempt Generation` with the
    // CLAIM FILE's — missing field is a mismatch when a stamp is active, matching value is
    // a pass — and that file is outside the audit. Neither verdict is derivable, so the
    // whole pair is unverifiable; team/unit-major reads `## Unit Progress` instead.
    if (opts.teamOwnership) {
      out.set(key, { state: "unverifiable", reason: "team-claim" });
      continue;
    }

    const mine = lifecycle.filter(({ e }) => e.stage === stage && e.unit === unit);
    const current = mine.filter(({ e }) => e.fields?.["Run floor"] === floor);
    // A pre-2.5.0 ledger carries no `Run floor` at all. The engine fails closed there, but
    // "this ledger predates the field" is a can't-tell, not a not-done: reporting it as ▩
    // would put a red cell on every older tree.
    if (current.length === 0 && mine.some(({ e }) => e.fields?.["Run floor"] === undefined)) {
      out.set(key, { state: "unverifiable", reason: "no-run-floor" });
      continue;
    }
    // Wave mode adds an artifact-fingerprint check — but only for THIS attempt's rows.
    if (current.some(({ e }) => e.fields?.Mode === "wave")) {
      out.set(key, { state: "unverifiable", reason: "wave-fingerprint" });
      continue;
    }

    // Cross-shard rows inside one second are causally unordered, so the engine reduces each
    // (timestamp, unit) group to one candidate per shard and ranks them
    // PAUSED(2) > STARTED/RESUMED(1) > COMPLETED(0), taking the highest: "a possible pause
    // blocks all progress … only unanimous terminal candidates settle it".
    const rank = (event: string) =>
      event === "UNIT_PAUSED" ? 2 : event === "UNIT_COMPLETED" ? 0 : 1;
    const reduced: typeof current = [];
    for (let a = 0; a < current.length; ) {
      let b = a + 1;
      while (b < current.length && current[b]!.e.ts === current[a]!.e.ts) b++;
      const byShard = new Map<string, (typeof current)[number]>();
      for (const row of current.slice(a, b)) byShard.set(row.e.shard ?? "", row);
      const candidates = [...byShard.values()];
      candidates.sort((x, y) => rank(x.e.event) - rank(y.e.event) || x.i - y.i);
      reduced.push(candidates[candidates.length - 1]!);
      a = b;
    }

    let settled = false;
    for (const { e } of reduced) settled = e.event === "UNIT_COMPLETED";
    out.set(key, { state: settled ? "settled" : "unsettled" });
  }

  return {
    inUse: (slug) => inUse.has(slug),
    state: (unit, slug) => out.get(`${slug}\u0001${unit}`) ?? { state: "unsettled" },
  };
}

/** The engine's own marker for a per-unit stage, with the fixed list as fallback. */
function isPerUnitStage(slug: string, catalog: StageCatalog | undefined): boolean {
  const row = catalog?.bySlug.get(slug);
  if (row) return row.forEach === "unit-of-work";
  return PER_UNIT_STAGE_SLUGS.has(slug);
}

/** One Unit column of the matrix, in bolt_dag roster (topological) order. */
export interface MatrixUnit {
  /** Unit slug, verbatim from bolt_dag.units. */
  name: string;
  /** Title-cased display name derived from the slug. */
  display: string;
  /** Unit kind (ui/service/library/spec/...) — drives the artifact contract. */
  kind?: string;
  /** Units this one depends on, verbatim from bolt_dag. */
  dependsOn: string[];
}

/**
 * absent   — no segment dir, or an empty one: this unit has not started the stage.
 * partial  — artifacts on disk, but the stage's contract for this unit's kind is
 *            not met yet. `missing` names what is outstanding.
 * complete — every contracted artifact is on disk (or, with no catalogue, the
 *            segment dir is simply non-empty).
 * unsettled — every contracted artifact is on disk BUT the unit's completion receipt
 *            for this stage is missing, on a stage that demonstrably uses the unit
 *            lifecycle. Not "complete": the engine says so in its own words —
 *            "receipts become the completion authority and artifact existence degrades
 *            to evidence — a paused or partially-written unit has artifacts but no
 *            receipt and stays uncovered (issue: artifact presence was mistaken for
 *            completion)" (aidlc-orchestrate.ts::unitLedgerFor). Not "partial" either,
 *            because nothing is missing from the contract; what is missing is the
 *            receipt. A paused, stale or reopened unit lands here.
 * unverified — every contracted artifact is on disk and the receipt CANNOT BE CHECKED from
 *            the audit alone: team ownership (the claim file decides), wave mode (an
 *            artifact fingerprint decides), an `AMBIGUOUS` attempt floor, or a ledger
 *            predating the `Run floor` field. Kept apart from `unsettled` because merging
 *            them printed a red "not done" over every gap in this reader's reproduction of
 *            the engine — a fabricated blocker.
 * n/a      — the stage contracts NOTHING for this unit's kind, so there is nothing
 *            to be missing. Distinct from `absent` on purpose: measured on a real
 *            run, a `packaging` unit sat at functional-design, whose every artifact
 *            is scoped to service/spec/ui/library. The cell had expected=[] and so
 *            rendered as "미착수" — reading as a unit that never started a stage it
 *            had in fact run (its questions file and audit events were there). Only
 *            claimed when the catalogue has the stage row AND the unit's kind is
 *            known; without either, "nothing expected" means "we don't know".
 */
export type CellState = "absent" | "partial" | "complete" | "unsettled" | "unverified" | "n/a";

/** One per-unit cell. */
export interface MatrixCell {
  unit: string;
  state: CellState;
  /** Artifact basenames found on disk, minus the questions file. */
  present: string[];
  /** Contracted artifacts for this unit's kind ([] when no catalogue). */
  expected: string[];
  /** expected − present, non-empty only when state is "partial". */
  missing: string[];
  /** Why the receipt could not be checked. Set only when state is "unverified". */
  receiptReason?: ReceiptReason;
}

/**
 * One per-unit Construction stage as a matrix row. `status` is the authoritative
 * state.md checkbox (the engine's verdict for the stage as a whole), while the
 * cells are reconstructed live from disk. For a completed stage the two agree —
 * the gate only opens once every unit's segment landed. For an in-flight stage
 * they need not, and `provisional` flags that the counts still grow.
 */
export interface MatrixStage {
  slug: string;
  display: string;
  status: StageStatus;
  /** false when the stage is scope-excluded (SKIP): no cells, no counts. */
  execute: boolean;
  /** Per-unit cells in roster order (empty for a skipped stage). */
  cells: MatrixCell[];
  /** Units whose cell is "complete". */
  complete: number;
  /** Units whose cell is "partial" — started, contract unmet. */
  partial: number;
  /** Artifacts met but no completion receipt — see CellState `unsettled`. */
  unsettled: number;
  /** Artifacts met, receipt not checkable from the audit — see CellState `unverified`. */
  unverified: number;
  /** Units the stage contracts nothing for — excluded from the row's denominator. */
  notApplicable: number;
  /** Roster size (0 for a skipped stage). */
  total: number;
  /** True when the stage is not yet [x] — counts are a snapshot, not final. */
  provisional: boolean;
}

export interface ConstructionMatrix {
  /** Unit roster in bolt_dag order (topological: dependencies before dependents). */
  units: MatrixUnit[];
  /** The per-unit Construction stages present in state.md, in document order. */
  stages: MatrixStage[];
  /** Topological batches from bolt_dag: units in one batch may run in parallel. */
  batches: string[][];
  /**
   * False when no stage catalogue was available (cells are binary only).
   *
   * `contractAware` and `stateVerified` are separate axes on purpose. Collapsing an
   * unreadable `State Version` into "no catalogue" threw the artifact contract away
   * wholesale and degraded the matrix to 2-state, which HIDES blocked units — a real
   * cost paid for a missing label. Showing the contract while saying it is unverified is
   * strictly more information than showing neither.
   */
  contractAware: boolean;
  /**
   * Whether the state/catalogue pairing was actually CHECKED, and how it came out. Three
   * values, not a boolean: a boolean `stateVerified` read `true` whenever the state's own
   * number was numeric, even with the harness silent about the version it supports — that
   * is nothing compared against, so the honest answer is `unknown`.
   *
   *   verified     both sides declared a version and they match
   *   unknown      one side is silent, or the state's value is unparseable (which the
   *                engine itself refuses — `classifyStateVersion`)
   *   incompatible declared and different; the catalogue is withheld entirely
   */
  stateCompat: StateCompat;
  /**
   * True when at least one stage's unit lifecycle is in force, so a cell can be
   * `unsettled` from a missing receipt. Independent of `contractAware`: receipts come
   * from the audit, so a tree with NO catalogue can still produce ▩, and the old
   * "칸은 파일 유무만 뜻함" note was wrong whenever it did.
   */
  receiptAware: boolean;
}

/** bolt_dag as this module consumes it. */
export interface BoltDag {
  units: MatrixUnit[];
  batches: string[][];
}

/**
 * Parse the Unit roster + topology out of runtime-graph.json's `bolt_dag`.
 * Returns undefined when the file is unparseable or carries no bolt_dag (a run
 * before units-generation) — the signal to keep the flat render. Roster order is
 * topological (the engine writes dependencies first).
 */
export function parseBoltDag(graphText: string): BoltDag | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(graphText);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const dag = (doc as Record<string, unknown>).bolt_dag;
  if (typeof dag !== "object" || dag === null) return undefined;
  const rawUnits = (dag as Record<string, unknown>).units;
  if (!Array.isArray(rawUnits)) return undefined;

  const units: MatrixUnit[] = [];
  for (const u of rawUnits) {
    if (typeof u !== "object" || u === null) continue;
    const r = u as Record<string, unknown>;
    const name = r.name;
    if (typeof name !== "string" || name.length === 0) continue;
    units.push({
      name,
      display: displayFromSlug(name),
      kind: typeof r.kind === "string" ? r.kind : undefined,
      dependsOn: Array.isArray(r.depends_on)
        ? r.depends_on.filter((d): d is string => typeof d === "string")
        : [],
    });
  }
  if (units.length === 0) return undefined;

  const rawBatches = (dag as Record<string, unknown>).batches;
  const batches: string[][] = Array.isArray(rawBatches)
    ? rawBatches
        .filter((b): b is unknown[] => Array.isArray(b))
        .map((b) => b.filter((n): n is string => typeof n === "string"))
    : [];

  return { units, batches };
}

/**
 * Artifact basenames a segment dir holds, minus the `-questions` file. Questions
 * are a conversation artifact, never listed in a stage's produces[], so counting
 * them would make every started segment look contract-complete.
 *
 * THE EXTENSION IS NOT ALWAYS `.md`. A stage's `produces` names artifacts
 * logically (`traceability`), and the engine picks the format — measured on one
 * real run: 41 `.md` and 7 `.json` across the Construction segments, with
 * `traceability` always written as `traceability.json`. An `.md`-only filter
 * therefore reported `traceability` missing in every cell that contracts it, so 8
 * cells that met their contract sat at "partial" permanently and no cell in the
 * run could ever reach "complete". Strip whatever extension is there instead, and
 * dedupe so `x.md` + `x.json` counts once.
 */
function readSegment(recordDir: string, unit: string, stageSlug: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(recordDir, "construction", unit, stageSlug), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const bases = new Set<string>();
  for (const e of entries) {
    // Dotfiles are never artifacts; a dir inside a segment is not one either.
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const base = e.name.replace(/\.[^.]+$/, "");
    if (base.endsWith("-questions")) continue;
    bases.add(base);
  }
  return [...bases].sort();
}

/**
 * Build the matrix from the roster + the parsed Construction stages + a segment
 * oracle. Pure: `readUnitSegment` is injected so this is testable without a
 * filesystem. `catalog` undefined → binary cells (extension-compatible).
 * Returns undefined when there is no roster or no per-unit stage to show.
 */
export function buildConstructionMatrix(
  dag: BoltDag,
  constructionStages: StageInfo[],
  readUnitSegment: (unit: string, stageSlug: string) => string[],
  catalog: StageCatalog | undefined,
  /** Omitted → artifact-driven, which is the engine's own ledger-free branch. */
  lifecycle?: UnitLifecycle,
  /** How the state/catalogue version pairing came out. Default `unknown`. */
  stateCompat?: StateCompat,
): ConstructionMatrix | undefined {
  if (dag.units.length === 0) return undefined;

  let receiptsInForce = false;
  const stages: MatrixStage[] = [];
  for (const st of constructionStages) {
    if (!isPerUnitStage(st.slug, catalog)) continue; // global stage — not a row
    if (!st.execute) {
      // Scope-excluded (SKIP): a row for continuity, but no per-unit scan/count.
      stages.push({
        slug: st.slug,
        display: st.display,
        status: st.status,
        execute: false,
        cells: [],
        complete: 0,
        partial: 0,
        unsettled: 0,
        unverified: 0,
        notApplicable: 0,
        total: 0,
        provisional: false,
      });
      continue;
    }

    const catStage = catalog?.bySlug.get(st.slug);
    const cells: MatrixCell[] = dag.units.map((u) => {
      const present = readUnitSegment(u.name, st.slug);
      // JUDGED on the required set, DISPLAYED as the whole contract. A conditional
      // artifact absent must not read as partial — the engine does not check it either
      // (see requiredArtifacts). `expected` stays the union so the cell can still show
      // what the stage may write here.
      const required = catStage ? requiredArtifacts(catStage, u.kind) : [];
      const expected = catStage ? expectedArtifacts(catStage, u.kind) : [];
      const missing = required.filter((a) => !present.includes(a));
      // A known kind that the stage contracts nothing REQUIRED for is not "not started".
      // Requires both the catalogue row and the kind: with either absent, an empty
      // required set means "unknown", which stays on the binary rule below.
      // Artifacts met is COVERAGE, not completion. Where the stage uses the unit
      // lifecycle, the `UNIT_COMPLETED` receipt is the authority and a unit with every
      // file but no receipt is unsettled — paused, stale or reopened.
      const artifactsMet = present.length > 0 && missing.length === 0;
      const needsReceipt = lifecycle?.inUse(st.slug) === true;
      if (needsReceipt) receiptsInForce = true;
      const receipt = needsReceipt ? lifecycle?.state(u.name, st.slug) : undefined;
      const state: CellState =
        catStage !== undefined && u.kind !== undefined && vacuouslyCovered(catStage, u.kind)
          ? "n/a"
          : present.length === 0
            ? "absent"
            : !artifactsMet
              ? "partial"
              : receipt?.state === "unsettled"
                ? "unsettled"
                : receipt?.state === "unverifiable"
                  ? "unverified"
                  : "complete";
      return {
        unit: u.name,
        state,
        present,
        expected,
        missing,
        ...(receipt?.reason ? { receiptReason: receipt.reason } : {}),
      };
    });

    const notApplicable = cells.filter((c) => c.state === "n/a").length;
    stages.push({
      slug: st.slug,
      display: st.display,
      status: st.status,
      execute: true,
      cells,
      complete: cells.filter((c) => c.state === "complete").length,
      partial: cells.filter((c) => c.state === "partial").length,
      unsettled: cells.filter((c) => c.state === "unsettled").length,
      unverified: cells.filter((c) => c.state === "unverified").length,
      notApplicable,
      total: dag.units.length,
      // Only a completed stage is guaranteed to hold every unit's segment; an
      // in-flight stage's counts are a snapshot that grows until it gates.
      provisional: st.status !== "done",
    });
  }
  if (stages.length === 0) return undefined;

  return {
    units: dag.units,
    stages,
    batches: dag.batches,
    contractAware: catalog !== undefined,
    stateCompat: stateCompat ?? "unknown",
    receiptAware: receiptsInForce,
  };
}

/** runtime-graph.json lives next to aidlc-state.md in the intent record dir. */
const RUNTIME_GRAPH_FILE = "runtime-graph.json";

/**
 * Filesystem entry point: given the intent record dir (the folder holding
 * aidlc-state.md and runtime-graph.json), the parsed Construction stages, and
 * the workspace's stage catalogue, reconstruct the matrix. Returns undefined
 * when the graph is missing/unparseable or carries no bolt_dag. Never throws.
 */
export function scanConstructionMatrix(
  recordDir: string,
  constructionStages: StageInfo[],
  catalog: StageCatalog | undefined,
  lifecycle?: UnitLifecycle,
  stateCompat?: StateCompat,
): ConstructionMatrix | undefined {
  let graphText: string;
  try {
    graphText = fs.readFileSync(path.join(recordDir, RUNTIME_GRAPH_FILE), "utf-8");
  } catch {
    return undefined;
  }
  const dag = parseBoltDag(graphText);
  if (!dag) return undefined;
  return buildConstructionMatrix(
    dag,
    constructionStages,
    (unit, slug) => readSegment(recordDir, unit, slug),
    catalog,
    lifecycle,
    stateCompat,
  );
}
