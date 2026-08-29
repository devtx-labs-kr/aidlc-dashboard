// List the files a stage produced, so the dashboard can offer them as links the
// user opens in their editor.
//
// WHERE WE LOOK. Same two depths as the questions scan: `<phase>/<stage>/` for
// ordinary stages and `construction/<unit>/<stage>/` for per-unit Construction
// stages. Only the record tree is walked, and only one directory deep — this is
// a listing, not a search.
//
// WHAT WE LIST. Markdown AND html in the stage dir, classified into three kinds
// so the UI can badge them:
//
//   questions — `<stage>-questions.md`, the conversation artifact. Deliberately
//               included (a stalled run is usually sitting on one of these), even
//               though the contract matrix excludes it from produces[].
//   diary     — `memory.md`, the stage observation diary the orchestrator keeps.
//   artifact  — everything else: the contract deliverables.
//
// ⭐ html is a REAL deliverable, not an extra. The visual-mockups plugin's HTML
// path writes `<stage>/…​.html` at rough-mockups / refined-mockups (observed:
// `ideation/rough-mockups/rough-mockup.html`, `inception/refined-mockups/
// mockup.html`), so a markdown-only filter silently hides the one artifact those
// stages exist to produce.
//
// ⭐ So is json, for the same reason. `traceability` is contracted by 8 stages of
// the stage graph (user-stories, domain-design, units-generation and all five
// per-unit Construction stages) and the engine writes it as `traceability.json` —
// a contract deliverable, not bookkeeping. Measured on one real run: of the 13
// `.json` files in the record, 10 are that artifact sitting in a stage dir, and
// the other 3 (`runtime-graph.json`, `.aidlc-active-directive.json`,
// `.aidlc-stop-hook/block-count.json`) live at the record root or under dot dirs,
// which this one-deep stage listing never reaches. So allowing `.json` here adds
// the deliverable without admitting the bookkeeping. The remaining extensions
// (`.last`, `.drops`) are hook state and stay out.
//
// The matrix scan (scan/matrix.ts readSegment) filters questions out because it
// judges contract completeness; this scan keeps them because it answers a
// different question ("what can I read about this stage?"). Same directory, two
// deliberately different filters — do not unify them.
//
// Node fs only, never throws: an unreadable or absent stage dir is an empty list.

import * as fs from "node:fs";
import * as path from "node:path";

/** What kind of file this is, for badging. */
export type ArtifactKind = "artifact" | "questions" | "diary";

/** Extensions the listing surfaces. Kept in sync with open-file.ts's own
 *  allowlist — that one guards the spawn, this one only decides what is shown,
 *  and a file listed but unopenable would be a dead link. */
const LISTED_EXT = [".md", ".html", ".json"];

/** One file inside a stage directory. */
export interface StageArtifact {
  /** Basename with extension, e.g. "intent-statement.md". */
  name: string;
  /** Record-relative POSIX path — what the open endpoint receives. */
  rel: string;
  kind: ArtifactKind;
  /** Bytes on disk; 0 when stat failed. Shown so an empty stub is visible. */
  size: number;
  /**
   * Unit of Work this file belongs to, for per-unit Construction stages.
   * Load-bearing for display, not decoration: a Construction row merges every
   * unit's copy of the stage dir, so `code-generation-plan.md` appears once per
   * unit and the basename alone cannot tell them apart.
   */
  unit?: string;
}

function classify(name: string, stageSlug: string): ArtifactKind {
  if (name === "memory.md") return "diary";
  if (name === `${stageSlug}-questions.md`) return "questions";
  // Some stages name the file after the unit or a sub-topic; treat any
  // `*-questions.md` as a question artifact rather than a deliverable.
  if (name.endsWith("-questions.md")) return "questions";
  return "artifact";
}

/** Sort: deliverables first (alphabetical), then questions, then the diary. */
const KIND_ORDER: Record<ArtifactKind, number> = { artifact: 0, questions: 1, diary: 2 };

/**
 * List one stage's files. `unit` set → the per-unit Construction path.
 * `recordDir` is absolute; the returned `rel` is record-relative POSIX so it can
 * be handed straight to the open endpoint (which re-resolves it under the record
 * root and refuses anything that escapes).
 */
export function listStageArtifacts(
  recordDir: string,
  phase: string,
  stageSlug: string,
  unit?: string,
): StageArtifact[] {
  const segments = unit ? ["construction", unit, stageSlug] : [phase, stageSlug];
  const dir = path.join(recordDir, ...segments);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: StageArtifact[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!LISTED_EXT.some((ext) => e.name.toLowerCase().endsWith(ext))) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, e.name)).size;
    } catch {
      // Keep the entry — a stat failure should not hide a file that exists.
    }
    out.push({
      name: e.name,
      rel: [...segments, e.name].join("/"),
      kind: classify(e.name, stageSlug),
      size,
      ...(unit ? { unit } : {}),
    });
  }
  // Unit first so a merged Construction row groups by unit rather than
  // interleaving six identically-named plans.
  return out.sort(
    (a, b) =>
      (a.unit ?? "").localeCompare(b.unit ?? "") ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name),
  );
}
