// Read the compiled stage catalogue that ships INSIDE the workspace under
// inspection: <root>/<harness>/tools/data/stage-graph.json. 32 stage rows, one
// per stage of the 5-phase lifecycle, each carrying the artifact contract the
// engine holds itself to.
//
// HARNESS-NEUTRAL BY DISCOVERY, NOT BY LIST. The same engine ships into several
// harness dirs — `.claude` (Claude Code), `.kiro` (Kiro CLI and IDE both),
// `.aidlc` — and the engine itself resolves its own dir
// open-set rather than matching a fixed set (aidlc-lib.ts: deriveHarnessDir /
// KNOWN_HARNESS_DIRS, where the list is only a probe-ORDER hint). This module
// mirrors that: it looks for ANY dot-directory carrying
// tools/data/stage-graph.json, so a harness that does not exist yet needs no
// edit here. The known names are used only to order the probe when a dev tree
// holds several harness dirs at once.
//
// Why read it from --root rather than bundling a copy: the catalogue is compiled
// per harness generation (aidlc-graph.ts: compileStageGraph), so a workspace on
// an older/newer engine has a DIFFERENT contract. Bundling one would silently
// mis-report any workspace that drifted from it. Absent/unparseable → undefined,
// and every consumer degrades rather than guessing (the dashboard is read-only
// and must never invent a contract the run did not actually have).
//
// Node fs only, no throw: a scan module never takes the server down.

import * as fs from "node:fs";
import * as path from "node:path";

/** Path of the catalogue INSIDE a harness dir. */
const CATALOG_SUBPATH = path.join("tools", "data", "stage-graph.json");

/**
 * Probe ORDER hint only — NOT the set of harnesses that exist. Mirrors
 * KNOWN_HARNESS_DIRS in the engine's aidlc-lib.ts, including its rule that
 * `.claude` wins when several trees coexist in a dev repo. Discovery below falls
 * back to scanning every dot-dir, so an unlisted harness still resolves.
 */
export const KNOWN_HARNESS_DIRS = [".claude", ".kiro", ".aidlc"] as const;

/** A plausible harness dir name: dot-prefixed, e.g. ".kiro" / ".gemini". */
function isHarnessDirName(name: string): boolean {
  return /^\.[a-z0-9][a-z0-9._-]*$/i.test(name);
}

function hasCatalog(root: string, harness: string): boolean {
  try {
    return fs.statSync(path.join(root, harness, CATALOG_SUBPATH)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the harness dir under `root` that carries a stage catalogue.
 *
 * Order: the known names first (so `.claude` wins in a dev tree holding several),
 * then ANY other dot-dir on disk — that second rung is what keeps this open-set.
 * Returns undefined when no harness ships a catalogue, which is a legitimate
 * state: a workspace can hold an `aidlc/` docs tree with the harness kept
 * elsewhere, and the dashboard still reports everything except the artifact
 * contract.
 */
export function findHarnessDir(root: string): string | undefined {
  for (const h of KNOWN_HARNESS_DIRS) {
    if (hasCatalog(root, h)) return h;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !isHarnessDirName(e.name)) continue;
    if ((KNOWN_HARNESS_DIRS as readonly string[]).includes(e.name)) continue; // already probed
    if (hasCatalog(root, e.name)) return e.name;
  }
  return undefined;
}

/**
 * Every harness dir under `root` that ships a catalogue, in probe order.
 *
 * `findHarnessDir` returns only the winner, which is all the catalogue reader
 * needs. The usage panel needs the full list: when a dev tree holds both `.kiro`
 * and `.claude`, probe order silently decides which usage provider `auto` picks,
 * and that decision has to be stated on screen rather than guessed at.
 */
export function harnessDirsWithCatalog(root: string): string[] {
  const found: string[] = [];
  for (const h of KNOWN_HARNESS_DIRS) {
    if (hasCatalog(root, h)) found.push(h);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !isHarnessDirName(e.name)) continue;
    if ((KNOWN_HARNESS_DIRS as readonly string[]).includes(e.name)) continue; // already probed
    if (hasCatalog(root, e.name)) found.push(e.name);
  }
  return found;
}

/**
 * One stage row. Only the fields this dashboard consumes are typed; the file
 * carries more (condition/inputs/outputs/rules_in_context/reviewer/...) which we
 * pass over rather than mirror, so a catalogue that grows a field still parses.
 */
export interface CatalogStage {
  slug: string;
  /** Dotted stage number, e.g. "3.5". */
  number: string;
  /** Human display name, e.g. "Code Generation". */
  name: string;
  phase: string;
  /** Artifacts the stage is contracted to produce (basenames, no .md). */
  produces: string[];
  /** Artifacts it MAY produce — kind-dependent, e.g. frontend-components for ui. */
  optionalProduces: string[];
  /**
   * artifact → the unit kinds that artifact applies to. An artifact ABSENT from
   * this map applies to every kind; one present applies only to the listed kinds.
   * This is what makes a per-unit expectation exact (see expectedArtifacts).
   */
  producesKinds: Record<string, string[]>;
  /** "unit-of-work" on the 5 per-unit Construction stages (3.1–3.5), else undefined. */
  forEach?: string;
  /** Sensor ids declared for the stage. */
  sensors: string[];
}

export interface StageCatalog {
  stages: CatalogStage[];
  /** slug → row, for the by-slug lookups every consumer actually does. */
  bySlug: Map<string, CatalogStage>;
  /** Absolute path read, for provenance. */
  sourcePath: string;
  /** The harness dir it was found in, e.g. ".kiro" — shown on the page. */
  harnessDir: string;
  /**
   * The state-file schema version THIS harness supports, read from its own
   * `tools/aidlc-lib.ts` (`export const CURRENT_STATE_VERSION = "8"`). Undefined when
   * the constant is not found, in which case no version claim is made at all.
   *
   * Read from the harness rather than pinned here on purpose: neither
   * `stage-graph.json` nor `harness.json` carries it, and a constant in this repo would
   * go stale exactly as the STAGE_DISPLAY table did. Parsing one line out of the
   * harness's own source is the only way to get the number the harness itself would
   * enforce, and a spelling change degrades to silence instead of a false claim.
   */
  stateVersion?: string;
}

/** `export const CURRENT_STATE_VERSION = "8"` in the harness's own lib. */
const STATE_VERSION_RE = /CURRENT_STATE_VERSION\s*(?::\s*[^=]+)?=\s*["'`](\d+)["'`]/;

function readHarnessStateVersion(root: string, harness: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(root, harness, "tools", "aidlc-lib.ts"), "utf-8");
    return STATE_VERSION_RE.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asKindMap(v: unknown): Record<string, string[]> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const kinds = asStringArray(val);
    if (kinds.length > 0) out[k] = kinds;
  }
  return out;
}

/**
 * Read + parse the catalogue under `root`, discovering the harness dir unless
 * `harnessDir` pins it (the `--harness` flag, for a tree where discovery would
 * pick the wrong one of several). Returns undefined when no harness ships a
 * readable catalogue — the signal for consumers to fall back to contract-free
 * behaviour. Never throws.
 */
export function readStageCatalog(root: string, harnessDir?: string): StageCatalog | undefined {
  const harness = harnessDir ?? findHarnessDir(root);
  if (!harness) return undefined;

  const sourcePath = path.join(root, harness, CATALOG_SUBPATH);
  let raw: string;
  try {
    raw = fs.readFileSync(sourcePath, "utf-8");
  } catch {
    return undefined;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // The catalogue is a bare ARRAY of stage rows (not an object with a `stages`
  // key) — verified against v2-2.5.26. Anything else is a shape we do not know.
  if (!Array.isArray(doc)) return undefined;

  const stages: CatalogStage[] = [];
  for (const row of doc) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const slug = r.slug;
    if (typeof slug !== "string" || slug.length === 0) continue;
    stages.push({
      slug,
      number: typeof r.number === "string" ? r.number : "",
      name: typeof r.name === "string" ? r.name : slug,
      phase: typeof r.phase === "string" ? r.phase : "",
      produces: asStringArray(r.produces),
      optionalProduces: asStringArray(r.optional_produces),
      producesKinds: asKindMap(r.produces_kinds),
      forEach: typeof r.for_each === "string" ? r.for_each : undefined,
      sensors: asStringArray(r.sensors),
    });
  }
  if (stages.length === 0) return undefined;

  return {
    stages,
    bySlug: new Map(stages.map((s) => [s.slug, s])),
    sourcePath,
    harnessDir: harness,
    ...(() => {
      const v = readHarnessStateVersion(root, harness);
      return v ? { stateVersion: v } : {};
    })(),
  };
}

/** Keep an artifact when it is kind-agnostic, or when it lists this unit's kind. */
function applies(stage: CatalogStage, artifact: string, kind: string | undefined): boolean {
  const kinds = stage.producesKinds[artifact];
  if (!kinds) return true; // kind-agnostic — applies to every unit
  return kind !== undefined && kinds.includes(kind);
}

/**
 * The artifacts a unit of this `kind` MUST have for the stage to count as covered —
 * `produces` filtered by `produces_kinds`, and nothing else.
 *
 * `optional_produces` IS DELIBERATELY EXCLUDED, because the engine excludes it. From
 * `tools/aidlc-orchestrate.ts` (`unitCovered`): *"node.optional_produces entries are
 * DELIBERATELY not checked here — they are artifacts the unit MAY write (marked
 * CONDITIONAL in the stage body), so their absence never blocks coverage."*
 *
 * Unioning the two was wrong in the one direction this module promises never to err in.
 * On the v2.7 catalogue exactly one stage carries an optional artifact —
 * `functional-design`, `frontend-components`, scoped to kind `ui` — so a **ui** unit
 * that wrote both of its required artifacts (`functional-spec`, `traceability`) and not
 * the conditional one read **partial** here while the engine had it covered. That is a
 * falsely-PARTIAL cell, i.e. a blocker on screen that does not exist, and the old
 * comment on this function promised it could not happen.
 *
 * `kind` undefined (a bolt_dag with no kinds) keeps only the kind-agnostic artifacts —
 * an under-claim, so a cell may read COMPLETE early but never falsely PARTIAL.
 */
export function requiredArtifacts(stage: CatalogStage, kind: string | undefined): string[] {
  return stage.produces.filter((a) => applies(stage, a, kind));
}

/**
 * Everything that MAY appear — required ∪ conditional, same kind filter. Used for
 * display ("this is the contract for this cell"), never for the complete/partial
 * judgement. See `requiredArtifacts` for why the two must not be the same list.
 */
export function expectedArtifacts(stage: CatalogStage, kind: string | undefined): string[] {
  return [...stage.produces, ...stage.optionalProduces].filter((a) => applies(stage, a, kind));
}

/**
 * True when the stage contracts nothing REQUIRED of this kind, so the cell is `n/a`
 * rather than "not started". Mirrors the engine's two-step exactly: its empty-produces
 * guard runs on the UNFILTERED list — *"a stage that declares no required produces at
 * all can never be proven-covered"* — and only after that does the kind filter make a
 * kind vacuously covered.
 */
export function vacuouslyCovered(stage: CatalogStage, kind: string | undefined): boolean {
  if (stage.produces.length === 0) return false;
  return requiredArtifacts(stage, kind).length === 0;
}
