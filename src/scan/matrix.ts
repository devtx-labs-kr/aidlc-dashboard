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
import { type StageCatalog, expectedArtifacts } from "./stage-catalog";

// The five per-unit Construction stage slugs — the stages the engine runs once
// per Unit of Work (each writing a `construction/<unit>/<stage>/` segment). The
// remaining Construction stages (build-and-test / ci-pipeline) run once globally
// and are NOT part of the matrix.
export const PER_UNIT_STAGE_SLUGS: ReadonlySet<string> = new Set([
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
]);

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
 * n/a      — the stage contracts NOTHING for this unit's kind, so there is nothing
 *            to be missing. Distinct from `absent` on purpose: measured on a real
 *            run, a `packaging` unit sat at functional-design, whose every artifact
 *            is scoped to service/spec/ui/library. The cell had expected=[] and so
 *            rendered as "미착수" — reading as a unit that never started a stage it
 *            had in fact run (its questions file and audit events were there). Only
 *            claimed when the catalogue has the stage row AND the unit's kind is
 *            known; without either, "nothing expected" means "we don't know".
 */
export type CellState = "absent" | "partial" | "complete" | "n/a";

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
  /** False when no stage catalogue was available (cells are binary only). */
  contractAware: boolean;
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
): ConstructionMatrix | undefined {
  if (dag.units.length === 0) return undefined;

  const stages: MatrixStage[] = [];
  for (const st of constructionStages) {
    if (!PER_UNIT_STAGE_SLUGS.has(st.slug)) continue; // global stage — not a row
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
        notApplicable: 0,
        total: 0,
        provisional: false,
      });
      continue;
    }

    const catStage = catalog?.bySlug.get(st.slug);
    const cells: MatrixCell[] = dag.units.map((u) => {
      const present = readUnitSegment(u.name, st.slug);
      const expected = catStage ? expectedArtifacts(catStage, u.kind) : [];
      const missing = expected.filter((a) => !present.includes(a));
      // A known kind that the stage contracts nothing for is not "not started".
      // Requires both the catalogue row and the kind: with either absent, an empty
      // `expected` means "unknown", which stays on the binary rule below.
      const state: CellState =
        catStage !== undefined && u.kind !== undefined && expected.length === 0
          ? "n/a"
          : present.length === 0
            ? "absent"
            : missing.length === 0
              ? "complete"
              : "partial";
      return { unit: u.name, state, present, expected, missing };
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
  );
}
