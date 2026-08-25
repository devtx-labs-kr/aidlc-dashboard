// The per-stage learning diary — what the orchestrator recorded about its own
// reasoning as it worked.
//
// FORMAT. Each stage keeps `<stage-dir>/memory.md` under four canonical H2
// headings, written by the §13 Learnings Ritual at every stage end:
//
//   ## Interpretations   — how an ambiguous instruction was read
//   ## Deviations        — where the run departed from the plan, and why
//   ## Tradeoffs         — what was given up for what
//   ## Open questions    — what remains unresolved
//
// Entries are `- <ISO> — <text>` bullets. A stage-major diary can fan in the same
// entries already present in per-unit diaries, so the report keeps per-file data
// but also builds a normalized, deduplicated record list for user-facing views.
//
// WHY NOT runtime-graph.json's memory_entries. It carries the same counts
// pre-aggregated, but only as of the last stage transition — the in-flight stage
// reads null there while its memory.md already has entries. Counting the files
// directly is both live and cheap.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";

/** The four canonical diary axes, in document order. */
export const DIARY_AXES = ["interpretations", "deviations", "tradeoffs", "openQuestions"] as const;
export type DiaryAxis = (typeof DIARY_AXES)[number];
export type DiaryQuestionStatus = "followUp" | "resolved" | "note";

/** H2 heading text → axis. Matched case-insensitively on the heading. */
const HEADING_TO_AXIS: Record<string, DiaryAxis> = {
  interpretations: "interpretations",
  deviations: "deviations",
  tradeoffs: "tradeoffs",
  "open questions": "openQuestions",
};

/** One diary bullet. */
export interface DiaryEntry {
  axis: DiaryAxis;
  /** Leading ISO timestamp when the bullet had one. */
  ts?: string;
  /** Bullet text with the timestamp prefix stripped. */
  text: string;
  /** Conservative interpretation of an Open questions entry. */
  questionStatus?: DiaryQuestionStatus;
}

/** One normalized entry with its source location. */
export interface DiaryRecord extends DiaryEntry {
  /** Record-relative POSIX path of the source memory.md. */
  rel: string;
  phase: string;
  stage: string;
  unit?: string;
}

/** One stage's diary. */
export interface StageDiary {
  /** Record-relative POSIX path of the memory.md. */
  rel: string;
  phase: string;
  stage: string;
  /** Set only for a per-unit Construction diary. */
  unit?: string;
  counts: Record<DiaryAxis, number>;
  total: number;
  entries: DiaryEntry[];
}

export interface DiaryReport {
  /** Per-file records, useful for source inspection. May contain fan-in duplicates. */
  stages: StageDiary[];
  /** Placeholder-free records with stage/unit fan-in duplicates removed. */
  records: DiaryRecord[];
  /** Counts over `records`, not the raw per-file entries. */
  totals: Record<DiaryAxis, number>;
  totalEntries: number;
}

const PHASE_DIRS = ["initialization", "ideation", "inception", "construction", "operation"];

const H2_RE = /^##\s+(.+?)\s*$/;
// `- 2026-07-29T11:40:00Z — text` — the separator is an em-dash in practice, but
// accept a hyphen too so a hand-edited diary still parses.
const BULLET_RE = /^[-*]\s+(?:(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*[—-]\s*)?(.*)$/;
const PLACEHOLDER_RE = /^(?:none|n\/a|not applicable|없음|해당 없음)[.!。]?$/i;
const RESOLVED_RE =
  /^\s*(?:\[\s*)?(?:\(\s*)?(?:해소됨|해결됨|resolved|closed)(?:\s|\)|\]|:|—|-|$)/i;
const FOLLOW_UP_RE =
  /\?\s*$|(?:확인|확정|결정|정합|합류|처리|적용|구현|추가|재검토)\s*필요|필요(?:함|하다|할|가| 여부|$)|미결|미정(?!의)|이월|후속|남아|대기 중|해야\s*함|\b(?:todo|tbd|pending)\b/i;

function emptyCounts(): Record<DiaryAxis, number> {
  return { interpretations: 0, deviations: 0, tradeoffs: 0, openQuestions: 0 };
}

function axisFromHeading(raw: string): DiaryAxis | undefined {
  const heading = raw.trim().toLowerCase();
  for (const [canonical, axis] of Object.entries(HEADING_TO_AXIS) as [string, DiaryAxis][]) {
    if (heading === canonical || heading.startsWith(`${canonical} (`)) return axis;
  }
  return undefined;
}

function questionStatus(text: string): DiaryQuestionStatus {
  if (RESOLVED_RE.test(text)) return "resolved";
  if (FOLLOW_UP_RE.test(text)) return "followUp";
  return "note";
}

/**
 * Parse a memory.md body into entries. Exported for tests — the heading/bullet
 * contract lives here alone.
 *
 * Bullets outside any known heading are ignored (the file's own preamble is a
 * blockquote, but a stray list there must not inflate a count).
 */
export function parseDiary(text: string): DiaryEntry[] {
  const out: DiaryEntry[] = [];
  let axis: DiaryAxis | undefined;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = H2_RE.exec(line);
    if (h) {
      axis = axisFromHeading(h[1]!);
      continue;
    }
    if (!axis) continue;
    const b = BULLET_RE.exec(line);
    if (!b) continue;
    const body = (b[2] ?? "").trim();
    if (body.length === 0 || PLACEHOLDER_RE.test(body)) continue;
    out.push({
      axis,
      ts: b[1],
      text: body,
      questionStatus: axis === "openQuestions" ? questionStatus(body) : undefined,
    });
  }
  return out;
}

function recordKey(record: DiaryRecord, includeUnit: boolean): string {
  const text = record.text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return [
    record.axis,
    record.stage.toLocaleLowerCase(),
    includeUnit ? (record.unit ?? "") : "",
    text,
  ].join("\u0000");
}

/**
 * Prefer the per-unit source when a stage-major fan-in repeats it, then collapse
 * exact duplicates within the same source context.
 */
function normalizeRecords(stages: StageDiary[]): DiaryRecord[] {
  const all = stages.flatMap((stage) =>
    stage.entries.map((entry) => ({
      ...entry,
      rel: stage.rel,
      phase: stage.phase,
      stage: stage.stage,
      unit: stage.unit,
    })),
  );
  const unitKeys = new Set(
    all.filter((record) => record.unit).map((record) => recordKey(record, false)),
  );
  const unique = new Map<string, DiaryRecord>();
  for (const record of all) {
    if (!record.unit && unitKeys.has(recordKey(record, false))) continue;
    const key = recordKey(record, true);
    const previous = unique.get(key);
    if (!previous || (record.ts ?? "") > (previous.ts ?? "")) unique.set(key, record);
  }
  return [...unique.values()].sort((a, b) => {
    const byTime = (a.ts ?? "").localeCompare(b.ts ?? "");
    if (byTime !== 0) return byTime;
    return `${a.stage}/${a.unit ?? ""}/${a.text}`.localeCompare(
      `${b.stage}/${b.unit ?? ""}/${b.text}`,
    );
  });
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read one memory.md into a StageDiary, or undefined when absent/empty. */
function readOne(
  recordDir: string,
  relParts: string[],
  phase: string,
  stage: string,
  unit: string | undefined,
): StageDiary | undefined {
  const abs = path.join(recordDir, ...relParts, "memory.md");
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
  const entries = parseDiary(text);
  const counts = emptyCounts();
  for (const e of entries) counts[e.axis]++;
  return {
    rel: [...relParts, "memory.md"].join("/"),
    phase,
    stage,
    unit,
    counts,
    total: entries.length,
    entries,
  };
}

/**
 * Walk the record's phase dirs collecting every stage diary, at both
 * `<phase>/<stage>/` and `construction/<unit>/<stage>/` depths. Never throws.
 */
export function readDiaries(recordDir: string): DiaryReport {
  const stages: StageDiary[] = [];

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

      // Same unit-vs-stage disambiguation as questions.ts: a unit dir contains
      // stage dirs, a stage dir contains files.
      let grandchildren: string[] = [];
      try {
        grandchildren = fs.readdirSync(childAbs);
      } catch {
        // fall through
      }
      const stageSubdirs = grandchildren.filter((g) => isDir(path.join(childAbs, g)));

      if (stageSubdirs.length > 0) {
        for (const stage of stageSubdirs.sort()) {
          const d = readOne(recordDir, [phase, child, stage], phase, stage, child);
          if (d) stages.push(d);
        }
      }
      // A dir can hold BOTH stage subdirs and its own memory.md (the stage-major
      // layout writes construction/<stage>/memory.md), so always check it too.
      const own = readOne(recordDir, [phase, child], phase, child, undefined);
      if (own) stages.push(own);
    }
  }

  const records = normalizeRecords(stages);
  const totals = emptyCounts();
  for (const record of records) totals[record.axis]++;

  return {
    stages,
    records,
    totals,
    totalEntries: records.length,
  };
}
