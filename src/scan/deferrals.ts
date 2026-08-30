// The deferral ledger — decisions the run put off, and where each one is
// scheduled to be asked again.
//
// WHY THIS IS A PANEL OF ITS OWN, separate from the stage diary. The diary
// (`memory.md`, scan/memory-diary.ts) records what the orchestrator thought while
// it worked; this records what the *human* declined to decide. Those are different
// ledgers with different readers, and the second one is invisible today: a run can
// answer every one of its questions — zero blank `[Answer]:` markers, so the blocker
// panel reads clean — while carrying 230 unresolved items that later stages are
// contracted to ask about again. Measured on one completed real run (137.5h, 4,679
// audit blocks): **194 asks, 0 unanswered, 0 blockers — and 230 open items.**
// The two counts are independent, which is the whole reason for a second panel.
//
// THE CONTRACT. `## Assumptions & Open Questions` is mandated in every artifact by
// the engine's own stage protocol, which also states the consequence:
//
//     "When downstream work needs an unresolved item, ask a follow-up and record
//      the answer in the current stage's questions file."
//                              — .kiro/aidlc-common/protocols/stage-protocol.md
//
// So the re-ask is not a defect, it is the contract. What the run never shows is
// the ledger behind it, which is why "why are you asking me this again?" has no
// answer on screen.
//
// TWO SHAPES, SPLIT CLEANLY BY PHASE. Measured across 51 sections in one run:
//
//   structured  39  `### Assumptions` (bullets) + `### Open questions` (a table)
//   flat        12  bullets directly under the H2, each tagged `[assumption]`
//
// Every structured section was in `inception/` or `construction/`; every flat one
// in `ideation/`. The structured table's header was `| 항목 | 배정 |` in 38 of 39,
// giving 245 rows / 230 unique items. That table IS the deferral ledger: the last
// column names the stage where the decision gets made.
//
// THREE RULES THAT KEEP THE READ HONEST:
//
//   1. Only a KNOWN slug becomes an owner. The 배정 cell is full of backticked
//      tokens that are not stages — `[F5]`, `P-1`, `U-7`, `NEW-헤더-목록`,
//      `C22`. Every candidate token is tested against this run's state.md slugs
//      first and the stage catalogue second, so an unrecognised cell reports
//      `unassigned` rather than inventing a stage. This is the same reason
//      scan/audit.ts consults the catalogue for `**Context**` attribution.
//   2. Owner status comes from the checkbox, not from phase order. `passed` means
//      every occurrence of that slug in state.md is `[x]`/`[S]`; `current` means one
//      is active/awaiting/revising. No ordering is inferred, so a run with a
//      hand-edited or unusual stage set is read as written.
//   3. The prose is not parsed for owners. A flat-shape bullet often names its
//      decision site in prose ("그 결정 단계는 `contract-design`이다") and on the one
//      tree measured it was right — 3 of 4 sampled bullets. Four samples is not a
//      contract, so assumptions are carried ownerless and the panel says so.
//
// WHAT WAS DELIBERATELY NOT PARSED. `stories.md` marks blocked acceptance criteria
// inline as `⏸ 판정 보류 — 선행 결정: <항목>`, 26 of them. It looks like a third
// shape, but 37 of the 40 `⏸` glyphs in the whole record are in user-stories files:
// it is one stage's local convention, not something the engine writes. Reading it
// would make this module depend on a shape the next run may not use.
//
// OWNER STATUS IS PER SLUG, NOT PER UNIT. Nine assignments on the measured run read
// `U4의 \`nfr-requirements\`` — the same stage slug in a different unit. The unit
// label in that cell (`U3`, `U4`) is not the unit dir name (`u3-plan-detail-server-
// render`), so pairing them would be guesswork; the slug's statuses are aggregated
// instead, and `passed` requires EVERY occurrence to be done or skipped. On this run
// all four units' copies were done, so the answer is the same either way — but a run
// parked mid-Construction would read one unit's open stage as `current`, which is the
// safe direction.
//
// WHAT IT COST TO READ. Every `.md` under the phase dirs is read whole, because
// whether an artifact carries the section is not knowable from its name: 115
// artifacts, 2.16MB, **~50ms warm** on the measured run — the same order as the rest
// of the scan put together, taking a full `assemble` on that tree to **~155ms**.
// Against a 60s poll that is still not worth a cache, but quote 155ms when judging a
// change here, not the 10ms figure from the smaller reference run.
//
// MEASURED OUTCOME on that run, for regression: 50 sections across 49 artifacts
// (one artifact carries two), 245 table rows → **230 unique items** after fan-in,
// 177 assumptions. Owners resolved to passed 88 · current 47 · ahead 50 ·
// nextCycle 13 · unassigned 32 · outOfScope 0.
//
// THERE IS NO CLOSE MARKER. When a later stage settles an item, the row simply
// stops appearing in that stage's artifacts — nothing is written to say "closed".
// So `passed` means "the stage this was assigned to has finished and we cannot see
// it being answered", never "this was dropped". The panel states that limit rather
// than presenting the count as a defect tally. Same reasoning as the unclosed
// rejection in scan/rework.ts: measure what the ledger says and name what it omits.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import type { StageStatus } from "./parser";

/** Where the decision an item was deferred to actually sits. */
export type OwnerStatus =
  /** The assigned stage is finished (or skipped) — no answer is visible. */
  | "passed"
  /** The assigned stage is the one the run is on right now. */
  | "current"
  /** The assigned stage has not started yet. */
  | "ahead"
  /** A real stage, but not one this run executes (absent from state.md). */
  | "outOfScope"
  /** Explicitly pushed past this run ("다음 차수" / "이후 차수"). */
  | "nextCycle"
  /** No stage could be resolved from the 배정 cell. */
  | "unassigned";

export const OWNER_STATUSES: OwnerStatus[] = [
  "passed",
  "current",
  "ahead",
  "outOfScope",
  "nextCycle",
  "unassigned",
];

/** One row of a `### Open questions` table. */
export interface DeferralItem {
  /** The 항목 cell, verbatim. */
  item: string;
  /** The 배정 cell, verbatim — kept whole because it carries registry ids too. */
  assignment: string;
  /** Stage slug resolved out of `assignment`, when one is known. */
  ownerStage?: string;
  ownerStatus: OwnerStatus;
  /** Phase / stage / unit of the artifact that recorded it. */
  phase: string;
  stage: string;
  unit?: string;
  /** Record-relative POSIX path of that artifact, for the 원문 link. */
  rel: string;
  /** Every artifact carrying this same item (fan-in), `rel` included. */
  sources: string[];
  /** Earliest mtime among `sources` — how long it has been outstanding. */
  since: string;
  /** Seconds outstanding at read time. Undefined when `since` is unparseable. */
  ageSec?: number;
}

/** One `[assumption]` bullet — unresolved, but with no assigned owner. */
export interface DeferralAssumption {
  text: string;
  phase: string;
  stage: string;
  unit?: string;
  rel: string;
  since: string;
}

export interface DeferralReport {
  /** Deduplicated open items, most-urgent owner status first. */
  items: DeferralItem[];
  /** Deduplicated assumptions. */
  assumptions: DeferralAssumption[];
  counts: Record<OwnerStatus, number>;
  /** Per-owner rollup, highest count first. */
  byOwner: { stage: string; status: OwnerStatus; count: number }[];
  /** Artifacts read. */
  artifacts: number;
  /** Artifacts carrying the mandated section. */
  sections: number;
  /** Sections whose body held only `None.` — an explicit "nothing open". */
  emptySections: number;
  /** Table rows read before fan-in dedup. */
  rows: number;
  /** True when no stage catalogue widened the slug oracle beyond state.md. */
  catalogMissing: boolean;
}

/** The phase dirs a record can hold (mirrors PHASES in the engine's lib). */
const PHASE_DIRS = ["initialization", "ideation", "inception", "construction", "operation"];

/** `## Assumptions & Open Questions`, at H2 or H3 (both observed). */
const SECTION_RE = /^(#{2,3})\s+Assumptions\s*&\s*Open\s*Questions\s*$/i;
/** Any subsection heading inside it. */
const SUB_RE = /^#{3,4}\s+(.*?)\s*$/;
const OPEN_SUB_RE = /open\s*questions?/i;
const ASSUMPTIONS_SUB_RE = /^assumptions?$/i;
/** A markdown table's `| --- | --- |` separator, which is what ends the header. */
const TABLE_SEP_RE = /^\s*\|[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|(.*?)\|?\s*$/;
/** An explicit "nothing open" body. */
const NONE_RE = /^(?:none|n\/a|not applicable|없음|해당\s*없음)[.!。]?$/i;
/** The engine writes the tag inside backticks (`` `[assumption]` ``); accept both. */
const ASSUMPTION_TAG_RE = /`?\[assumption\]`?/i;
/** A kebab-case stage slug: at least two lowercase segments. */
const SLUG_TOKEN_RE = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;
const NEXT_CYCLE_RE = /(?:다음|이후|차기)\s*차수|next\s+cycle|이번\s*차수\s*밖/i;

/** One artifact's parsed sections, before they are placed in the record tree. */
interface ParsedSection {
  rows: { item: string; assignment: string }[];
  assumptions: string[];
  /** How many sections the artifact held — one artifact can carry two. */
  sections: number;
  /**
   * True when a section was present and said only `None.` — the engine's explicit
   * "nothing open here". Worth keeping distinct from "no section at all", which is
   * silence rather than a claim.
   */
  declaredNone: boolean;
}

function splitRow(line: string): string[] {
  const m = TABLE_ROW_RE.exec(line);
  if (!m) return [];
  return (m[1] ?? "").split("|").map((c) => c.trim());
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse every `## Assumptions & Open Questions` section in one artifact's text.
 * Exported for tests: both shapes and all three honesty rules are checkable from
 * a string, with no filesystem involved.
 *
 * A section ends at the next heading of its own level or higher, so an H3
 * subsection stays inside it. Inside a `### Open questions` subsection, table rows
 * are taken only AFTER the `|---|` separator — without that guard the header row
 * itself becomes an open item called "항목".
 */
export function parseDeferralSections(text: string): ParsedSection {
  const out: ParsedSection = { rows: [], assumptions: [], sections: 0, declaredNone: false };
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const head = SECTION_RE.exec(lines[i] ?? "");
    if (!head) continue;
    out.sections++;
    const level = (head[1] ?? "##").length;
    const endRe = new RegExp(`^#{1,${level}}\\s`);

    let sub: "open" | "assumptions" | "other" | undefined;
    let pastSeparator = false;
    let bullet: string | undefined;
    /** Non-blank body lines, and how many of them were an explicit "nothing". */
    let bodyLines = 0;
    let noneLines = 0;
    const rowsBefore = out.rows.length;
    const assumptionsBefore = out.assumptions.length;

    const flushBullet = () => {
      if (bullet !== undefined && ASSUMPTION_TAG_RE.test(bullet)) {
        const t = tidy(bullet.replace(ASSUMPTION_TAG_RE, ""));
        if (t.length > 0) out.assumptions.push(t);
      }
      bullet = undefined;
    };

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (endRe.test(line)) {
        i = j - 1;
        break;
      }
      const s = SUB_RE.exec(line);
      // Count content lines only — a subsection heading is structure, so a section
      // whose every content line is `None.` still reads as an explicit "nothing
      // open" even when the two mandated subsections are present.
      if (!s && line.trim().length > 0) {
        bodyLines++;
        if (NONE_RE.test(tidy(line.replace(/^\s*[-*]\s+/, "")))) noneLines++;
      }
      if (s) {
        flushBullet();
        const name = (s[1] ?? "").trim();
        sub = OPEN_SUB_RE.test(name)
          ? "open"
          : ASSUMPTIONS_SUB_RE.test(name)
            ? "assumptions"
            : "other";
        pastSeparator = false;
        continue;
      }

      // A table row. Only the open-questions subsection contributes items; a table
      // under `### Assumptions` or an unrecognised subsection is left alone.
      if (line.trim().startsWith("|")) {
        flushBullet();
        if (sub !== "open") continue;
        if (TABLE_SEP_RE.test(line)) {
          pastSeparator = true;
          continue;
        }
        if (!pastSeparator) continue;
        const cells = splitRow(line);
        // First cell is the item, LAST is the assignment: the mandated shape has
        // two columns, but a stage that adds a "why can't we judge it" column in
        // the middle still names the decision site last.
        const item = tidy(cells[0] ?? "");
        const assignment = tidy(cells[cells.length - 1] ?? "");
        if (item.length === 0 || cells.length < 2) continue;
        out.rows.push({ item, assignment });
        continue;
      }

      // Bullets. Only tagged `[assumption]` ones are kept, and a bullet's
      // continuation lines are folded in so a wrapped sentence stays whole.
      const b = /^\s*[-*]\s+(.*)$/.exec(line);
      if (b) {
        flushBullet();
        bullet = b[1] ?? "";
        continue;
      }
      if (bullet !== undefined && /^\s+\S/.test(line)) {
        bullet = `${bullet} ${line.trim()}`;
        continue;
      }
      flushBullet();
    }
    flushBullet();
    if (
      out.rows.length === rowsBefore &&
      out.assumptions.length === assumptionsBefore &&
      bodyLines > 0 &&
      noneLines === bodyLines
    ) {
      out.declaredNone = true;
    }
  }
  return out;
}

/**
 * Resolve the 배정 cell to a stage and a status. Only a slug the run itself knows
 * (state.md) or the catalogue lists becomes an owner — see rule 1 in the header.
 */
export function resolveOwner(
  assignment: string,
  stageStatuses: Map<string, StageStatus[]>,
  catalogSlugs?: Set<string>,
): { ownerStage?: string; ownerStatus: OwnerStatus } {
  const tokens = assignment.match(SLUG_TOKEN_RE) ?? [];
  for (const token of tokens) {
    const inState = stageStatuses.get(token);
    if (inState && inState.length > 0) {
      if (inState.some((s) => s === "active" || s === "awaiting" || s === "revising")) {
        return { ownerStage: token, ownerStatus: "current" };
      }
      if (inState.every((s) => s === "done" || s === "skipped")) {
        return { ownerStage: token, ownerStatus: "passed" };
      }
      return { ownerStage: token, ownerStatus: "ahead" };
    }
    if (catalogSlugs?.has(token)) return { ownerStage: token, ownerStatus: "outOfScope" };
  }
  if (NEXT_CYCLE_RE.test(assignment)) return { ownerStatus: "nextCycle" };
  return { ownerStatus: "unassigned" };
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

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readDir(p: string): string[] {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return [];
  }
}

/** One artifact location in the record tree. */
interface Located {
  relParts: string[];
  phase: string;
  stage: string;
  unit?: string;
}

/**
 * Collect every `.md` artifact under the record's phase dirs, tagged with the
 * stage that wrote it.
 *
 * A stage dir can hold a subdirectory of its own (`practices-discovery/
 * contributions/`), which is the same two-shapes-per-depth problem
 * `**Context**` attribution has in scan/audit.ts — so when a catalogue is
 * available its `isStage` oracle decides, and only without one does the reader
 * fall back to "a dir with subdirs is a unit".
 */
function locateArtifacts(recordDir: string, isStage?: (slug: string) => boolean): Located[] {
  const out: Located[] = [];
  const scanFiles = (
    relParts: string[],
    phase: string,
    stage: string,
    unit: string | undefined,
    descend: boolean,
  ) => {
    for (const f of readDir(path.join(recordDir, ...relParts))) {
      const abs = path.join(recordDir, ...relParts, f);
      if (f.endsWith(".md")) {
        out.push({ relParts: [...relParts, f], phase, stage, unit });
        continue;
      }
      // One level of stage-owned subdirectory (`contributions/`), same stage. Only
      // from a stage dir: descending from a UNIT dir would collect every stage's
      // files a second time, which double-counts the whole ledger.
      if (descend && isDir(abs)) {
        for (const g of readDir(abs)) {
          if (g.endsWith(".md")) out.push({ relParts: [...relParts, f, g], phase, stage, unit });
        }
      }
    }
  };

  for (const phase of PHASE_DIRS) {
    const phaseAbs = path.join(recordDir, phase);
    if (!isDir(phaseAbs)) continue;
    for (const child of readDir(phaseAbs)) {
      const childAbs = path.join(phaseAbs, child);
      if (!isDir(childAbs)) continue;
      const subdirs = readDir(childAbs).filter((g) => isDir(path.join(childAbs, g)));
      const childIsStage = isStage ? isStage(child) : subdirs.length === 0;
      if (!childIsStage && subdirs.length > 0) {
        // Unit dir: its stage children are stages.
        for (const stage of subdirs) scanFiles([phase, child, stage], phase, stage, child, true);
        scanFiles([phase, child], phase, child, undefined, false);
      } else {
        scanFiles([phase, child], phase, child, undefined, true);
      }
    }
  }
  return out;
}

/** Sort key: the statuses a reader has to act on first. */
const STATUS_RANK: Record<OwnerStatus, number> = {
  passed: 0,
  current: 1,
  ahead: 2,
  unassigned: 3,
  outOfScope: 4,
  nextCycle: 5,
};

export interface DeferralOptions {
  /** Per-slug checkbox states from state.md — how owner status is decided. */
  stageStatuses?: Map<string, StageStatus[]>;
  /** Stage slugs the catalogue lists, for recognising out-of-scope owners. */
  catalogSlugs?: Set<string>;
  /** `isStage` oracle for the unit-vs-stage depth ambiguity. */
  isStage?: (slug: string) => boolean;
  /** Read clock, for ages. Defaults to now. */
  now?: string;
}

/**
 * Read the record's deferral ledger. Never throws: an unreadable artifact is
 * skipped, and a record with no such sections yields an empty report rather than
 * an error.
 */
export function readDeferrals(recordDir: string, opts: DeferralOptions = {}): DeferralReport {
  const stageStatuses = opts.stageStatuses ?? new Map<string, StageStatus[]>();
  const nowMs = Date.parse(opts.now ?? new Date().toISOString());

  const located = locateArtifacts(recordDir, opts.isStage);
  let sections = 0;
  let emptySections = 0;
  let rows = 0;

  // Fan-in: the same item is often restated by a downstream artifact. Keyed on the
  // item text so the ledger counts decisions, not mentions; the earliest source
  // wins `since`, because that is when the deferral actually started.
  const byItem = new Map<string, DeferralItem>();
  const assumptions = new Map<string, DeferralAssumption>();

  for (const loc of located) {
    const abs = path.join(recordDir, ...loc.relParts);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    // Cheap reject before the line walk: most artifacts do not carry the section.
    if (!/Assumptions\s*&\s*Open\s*Questions/i.test(text)) continue;
    const parsed = parseDeferralSections(text);
    const found = parsed.rows.length > 0 || parsed.assumptions.length > 0;
    if (!found && !parsed.declaredNone) continue;
    sections += parsed.sections;
    if (!found) {
      emptySections++;
      continue;
    }
    const rel = loc.relParts.join("/");
    const since = statMtime(abs);

    for (const row of parsed.rows) {
      rows++;
      const key = row.item.toLowerCase();
      const existing = byItem.get(key);
      if (existing) {
        existing.sources.push(rel);
        if (since && (!existing.since || since < existing.since)) existing.since = since;
        continue;
      }
      const owner = resolveOwner(row.assignment, stageStatuses, opts.catalogSlugs);
      byItem.set(key, {
        item: row.item,
        assignment: row.assignment,
        ownerStage: owner.ownerStage,
        ownerStatus: owner.ownerStatus,
        phase: loc.phase,
        stage: loc.stage,
        unit: loc.unit,
        rel,
        sources: [rel],
        since,
      });
    }

    for (const text2 of parsed.assumptions) {
      const key = text2.toLowerCase();
      if (assumptions.has(key)) continue;
      assumptions.set(key, {
        text: text2,
        phase: loc.phase,
        stage: loc.stage,
        unit: loc.unit,
        rel,
        since,
      });
    }
  }

  const items = [...byItem.values()];
  for (const it of items) {
    const parsedTs = Date.parse(it.since);
    it.ageSec = Number.isFinite(parsedTs) ? Math.max(0, (nowMs - parsedTs) / 1000) : undefined;
  }
  items.sort(
    (a, b) =>
      STATUS_RANK[a.ownerStatus] - STATUS_RANK[b.ownerStatus] ||
      (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) ||
      a.item.localeCompare(b.item),
  );

  const counts = Object.fromEntries(OWNER_STATUSES.map((s) => [s, 0])) as Record<
    OwnerStatus,
    number
  >;
  for (const it of items) counts[it.ownerStatus]++;

  const ownerRollup = new Map<string, { stage: string; status: OwnerStatus; count: number }>();
  for (const it of items) {
    const stage = it.ownerStage ?? `(${it.ownerStatus})`;
    const row = ownerRollup.get(stage);
    if (row) row.count++;
    else ownerRollup.set(stage, { stage, status: it.ownerStatus, count: 1 });
  }

  return {
    items,
    assumptions: [...assumptions.values()],
    counts,
    byOwner: [...ownerRollup.values()].sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        b.count - a.count ||
        a.stage.localeCompare(b.stage),
    ),
    artifacts: located.length,
    sections,
    emptySections,
    rows,
    catalogMissing: opts.catalogSlugs === undefined,
  };
}
