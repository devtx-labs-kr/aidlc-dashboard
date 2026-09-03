// Find the questions the run is waiting on — the single most useful thing this
// dashboard can show, because an AI-DLC run that looks "stopped" is usually
// sitting on an unanswered question rather than broken.
//
// FORMAT. Every stage that asks something writes `<stage-dir>/<stage>-questions.md`:
//
//   ## Q1 — Plan Approval
//   <prose + the option list>
//   [Answer]: A (Approve Plan) — 사용자 승인 2026-07-30
//
// An UNANSWERED question is an `[Answer]:` marker with nothing but whitespace
// after the colon. That is the engine's own convention (the stop hook's
// pending-question carve-out reads the same shape), and it is what distinguishes
// "asked and waiting" from "asked and answered" — verified against a real stall
// where one unit's `[Answer]:` was blank and stop.drops corroborated with three
// "pending-question carve-out" lines.
//
// THE HEADING IS WRITTEN FIVE WAYS. Measured across one long real run (23
// artifacts, 195 `##` headings): `Q1 —` 119, `[Q1]` 58, `[F1]` 13, `F1.` 5. The
// bracket is optional, follow-ups use an `F` id, and either form can carry a
// suffix. Matching only the bare `Q<n>` form found 119 of 194 asks — 39% of that
// run's questions were invisible, including a whole stage's worth. So the id is
// matched with the bracket and suffix optional. The fifth way is the suffix
// WITHOUT a hyphen: run B wrote `Q1-a`/`Q6-b`, a later run wrote `## Q6a. (후속)
// …`, and requiring the hyphen dropped it — a real follow-up with a filled
// `[Answer]:`. The hyphen is optional for that reason.
//
// AND NOT EVERY ASK HAS AN ID AT ALL. Three headings the engine writes carry a
// gating `[Answer]:` with no `Q<n>`, and the engine's own parser treats them as
// question sections — `aidlc-lib.ts` gates on
// `(title === "Requested Changes Feedback" || questionId !== null)`:
//
//   ## Consolidated Summary Confirmation   the per-stage approval receipt, answered
//                                         exactly `Looks correct` / `Request changes`
//   ## Assumption Confirmation             `A. Accept assumptions` /
//                                         `B. Convert to follow-up questions`
//   ## Requested Changes Feedback          the free-text "What should change?"
//
// `stage-protocol.md` is explicit that these block: *"Do not revise anything until
// the human provides that feedback"*, and the assumption one *"Do not invoke the
// reviewer or proceed to completion while an assumption confirmation `[Answer]:`
// is blank."* So a run parked on any of them is hard-stopped — and this reader
// used to show it as ZERO blockers, because the id regex is all that opened a
// span. Measured on one real tree: 103 `##` headings across its questions files,
// 27 invisible, of which **14 were these three** (10 summary + 3 assumption + 1
// feedback). All were filled there, so the hidden-blocker count was 0 — but the
// summary confirmation exists at every stage gate, which makes it the single most
// likely state for a run to be waiting in.
//
// TWO RULES KEEP THAT WIDENING FROM INVENTING QUESTIONS:
//
//   1. A heading is an ask only if its span holds an `[Answer]:` marker. The
//      marker is how the engine asks, so a heading without one is prose — real
//      example, `## [Q5] 후속 — 원문에서 확인한 것`, a narrative section reusing an
//      answered question's id. Without this rule it reads as a blocker.
//   2. The answer is the first NON-EMPTY marker in the span, not the first
//      marker. A human answering under the engine's blank placeholder leaves
//      `[Answer]:` followed by `[Answer]: C. …`; taking the first marker calls
//      that question unanswered. Measured: of 194 spans exactly one holds two
//      markers, and it is that shape — blank-then-filled, never filled-then-blank.
//
// WHERE WE LOOK. Questions live at two depths: `<phase>/<stage>/` for ordinary
// stages and `construction/<unit>/<stage>/` for per-unit Construction stages, so
// the scan walks both. Only the record tree is walked (never the whole project),
// and the walk is bounded to the known phase dirs.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What kind of ask a heading is. `confirmation` is one of the three id-less gate
 * headings; the remedy differs (pick a fixed option / write feedback rather than
 * answer a question), so the panel says which one it is looking at.
 */
export type AskKind = "question" | "confirmation";

/** One question block found in a questions artifact. */
export interface QuestionEntry {
  /** Heading label, e.g. "Q1 — Plan Approval". */
  heading: string;
  /** The answer text; empty string means unanswered. */
  answer: string;
  answered: boolean;
  kind: AskKind;
}

/** One questions artifact. */
export interface QuestionsFile {
  /** Record-relative POSIX path, for display. */
  rel: string;
  phase: string;
  stage: string;
  /** Set only for a per-unit Construction artifact. */
  unit?: string;
  questions: QuestionEntry[];
  /** Questions with a blank `[Answer]:`. */
  unanswered: QuestionEntry[];
  /** File mtime (ISO) — how long the ask has been outstanding. */
  mtime: string;
}

export interface QuestionsReport {
  files: QuestionsFile[];
  /** Only the artifacts that still have a blank answer, newest-asked first. */
  blocked: QuestionsFile[];
  totalQuestions: number;
  totalUnanswered: number;
}

/** The phase dirs a record can hold (mirrors PHASES in the engine's lib). */
const PHASE_DIRS = ["initialization", "ideation", "inception", "construction", "operation"];

/** Any `## ` heading — always ends the previous span, whether or not it opens one. */
const H2_RE = /^##\s/;
/**
 * A `## ` heading carrying a question id: `Q1`, `[Q1]`, `F1`, `[F1]`, with an
 * optional suffix that may or may not be hyphenated (`Q1-a`, `Q6a`). The id must be
 * followed by a delimiter or end of line, so a prose heading that merely starts
 * with the letter (`## U1의 완료는 …`) is not an ask, and neither is one whose id is
 * only mentioned mid-sentence.
 */
const QUESTION_HEADING_RE = /^##\s+\[?([QF]\d+(?:-?[A-Za-z0-9]+)?)\]?(?:$|[\s.:\]])/;
/** Just the heading text, for the id-less gate headings below. */
const H2_TITLE_RE = /^##\s+(.+?)\s*$/;
/**
 * The three id-less headings the engine writes as questions. Matched on the exact
 * literal (lowercased) because `memory-seed/org.md` lists these H2s among the
 * tokens a stage must write "character for character" — they stay English even in
 * a Korean run, so there is no localisation to tolerate here. A suffix is NOT
 * accepted: the protocol appends *sibling* sections sharing the title, and
 * `aidlc-lib.ts` guards duplicates by that same exact name.
 */
const GATE_HEADINGS = new Set([
  "consolidated summary confirmation",
  "assumption confirmation",
  "requested changes feedback",
]);
// The engine writes `[Answer]:` at line start; capture the remainder verbatim so
// a multi-word answer with a trailing comment still reads as answered.
const ANSWER_RE = /^\[Answer\]:[ \t]*(.*)$/;

/**
 * Parse one questions artifact's text. Exported for tests: this is the whole
 * answered/unanswered contract, checkable from a string.
 *
 * A span runs from a question-id heading to the next `## ` heading of any kind.
 * It becomes a question only if it holds an `[Answer]:` marker, and its answer is
 * the first non-empty marker in it — see the two rules in the header comment for
 * the real-run shapes that forced both. An `[Answer]:` outside any span (before
 * the first heading, or under a prose heading) is ignored.
 */
export function parseQuestions(text: string): QuestionEntry[] {
  const spans: { heading: string; markers: string[]; kind: AskKind }[] = [];
  let current: { heading: string; markers: string[]; kind: AskKind } | undefined;

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (H2_RE.test(line)) {
      const title = (H2_TITLE_RE.exec(line)?.[1] ?? "").trim();
      const kind: AskKind | undefined = QUESTION_HEADING_RE.test(line)
        ? "question"
        : GATE_HEADINGS.has(title.toLowerCase())
          ? "confirmation"
          : undefined;
      current = kind ? { heading: title, markers: [], kind } : undefined;
      if (current) spans.push(current);
      continue;
    }
    if (!current) continue;
    const a = ANSWER_RE.exec(line);
    if (a) current.markers.push((a[1] ?? "").trim());
  }

  return spans
    .filter((s) => s.markers.length > 0)
    .map((s) => {
      // Blank after the colon == still waiting. This is the whole signal.
      const answer = s.markers.find((m) => m.length > 0) ?? "";
      return { heading: s.heading, answer, answered: answer.length > 0, kind: s.kind };
    });
}

function statMtime(p: string): string {
  try {
    return fs
      .statSync(p)
      .mtime.toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "";
  }
}

/** Read one questions artifact into a QuestionsFile, or undefined if unreadable. */
function readFileEntry(
  recordDir: string,
  relParts: string[],
  phase: string,
  stage: string,
  unit: string | undefined,
): QuestionsFile | undefined {
  const abs = path.join(recordDir, ...relParts);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
  const questions = parseQuestions(text);
  return {
    rel: relParts.join("/"),
    phase,
    stage,
    unit,
    questions,
    unanswered: questions.filter((q) => !q.answered),
    mtime: statMtime(abs),
  };
}

/** Questions artifacts directly inside a stage dir (`*-questions.md`). */
function scanStageDir(
  recordDir: string,
  relParts: string[],
  phase: string,
  stage: string,
  unit: string | undefined,
  into: QuestionsFile[],
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(recordDir, ...relParts));
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith("-questions.md")) continue;
    const e = readFileEntry(recordDir, [...relParts, f], phase, stage, unit);
    if (e) into.push(e);
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk the record's phase dirs for questions artifacts. Handles both
 * `<phase>/<stage>/` and `construction/<unit>/<stage>/`: under construction, a
 * child dir is treated as a unit when it itself holds stage subdirectories, and
 * as a stage otherwise (the stage-major layout writes both side by side).
 * Never throws.
 */
export function readQuestions(recordDir: string): QuestionsReport {
  const files: QuestionsFile[] = [];

  for (const phase of PHASE_DIRS) {
    const phaseAbs = path.join(recordDir, phase);
    if (!isDir(phaseAbs)) continue;
    let children: string[];
    try {
      children = fs.readdirSync(phaseAbs);
    } catch {
      continue;
    }
    for (const child of children.sort()) {
      const childAbs = path.join(phaseAbs, child);
      if (!isDir(childAbs)) continue;

      // A unit dir holds stage dirs; a stage dir holds .md files. Distinguish by
      // asking whether any child is itself a directory.
      let grandchildren: string[] = [];
      try {
        grandchildren = fs.readdirSync(childAbs);
      } catch {
        // fall through: treat as a stage dir
      }
      const stageSubdirs = grandchildren.filter((g) => isDir(path.join(childAbs, g)));

      if (stageSubdirs.length > 0) {
        // `child` is a unit of work (construction/<unit>/<stage>/...).
        for (const stage of stageSubdirs.sort()) {
          scanStageDir(recordDir, [phase, child, stage], phase, stage, child, files);
        }
        // A unit dir can also hold loose questions artifacts; pick those up too.
        scanStageDir(recordDir, [phase, child], phase, child, undefined, files);
      } else {
        scanStageDir(recordDir, [phase, child], phase, child, undefined, files);
      }
    }
  }

  const blocked = files
    .filter((f) => f.unanswered.length > 0)
    .sort((a, b) => (a.mtime > b.mtime ? -1 : a.mtime < b.mtime ? 1 : 0));

  return {
    files,
    blocked,
    totalQuestions: files.reduce((n, f) => n + f.questions.length, 0),
    totalUnanswered: files.reduce((n, f) => n + f.unanswered.length, 0),
  };
}
