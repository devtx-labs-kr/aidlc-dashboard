// Parse the audit ledger into one time-ordered event list.
//
// LAYOUT. The ledger is per-clone SHARDED: <record>/audit/<host>-<clone12hex>.md,
// one file per machine/clone that ran the workflow. A parallel run therefore has
// several shards and no single file holds the whole story, so every shard is read
// and the merged blocks re-sorted by timestamp. Reading only the biggest shard
// would silently drop another developer's work.
//
// BLOCK FORMAT (aidlc-audit.ts: renderAuditBlock). Blocks are separated by a bare
// `---` line; each is a `## Human Heading` followed by `**Key**: value` lines, of
// which `**Timestamp**` (ISO, second precision, UTC) and `**Event**` are always
// present. The remaining keys vary per event type and are kept verbatim in a map
// rather than typed per event — 72 event types exist and the dashboard reads a
// handful of keys off a few of them.
//
// WHY FULL RE-PARSE, NO INCREMENTAL OFFSETS. Measured on a real run: 2 shards
// (1.1MB + 792B), 4,228 blocks, parse + sort in 7.5ms. Tracking byte offsets to
// append-parse would add mutable cross-request state for no perceptible gain, and
// would be unsound here anyway — the inspected tree is typically a SYNCED copy,
// so a shard can be replaced wholesale rather than appended to.
//
// STAGE ATTRIBUTION. Most stage-scoped events carry `**Stage**` (or `**Stage
// slug**` for sensors), but ARTIFACT_CREATED/ARTIFACT_UPDATED carry NO stage
// field — the stage is only recoverable from `**Context**`. Ignoring that zeroes
// out per-stage artifact counts (a defect the Python reader hit first time).
//
// ⚠️ Context has FOUR-SEGMENT forms that mean DIFFERENT things, and position
// alone cannot tell them apart:
//
//   inception > practices-discovery > contributions > x.md    stage=slot1, slot2=SUBDIR
//   construction > PU-1-walking-skeleton > functional-design > x.md
//                                                             stage=slot2, slot1=UNIT
//
// Taking slot1 always (what harness_timing_report.py does) undercounts every
// per-unit Construction stage; taking slot2 whenever there are four segments
// mis-attributes a stage that merely has a subdirectory. So the segment is
// resolved against the workspace's own stage catalogue — `isStage` below — and
// only falls back to position when no catalogue was supplied.
//
// Node fs only, never throws: an unreadable shard is skipped, not fatal.

import * as fs from "node:fs";
import * as path from "node:path";

/** One audit block. */
export interface AuditEvent {
  /** ISO 8601, second precision, UTC — verbatim from the ledger. */
  ts: string;
  /** Canonical event type, e.g. "STAGE_COMPLETED". */
  event: string;
  /** Stage slug when attributable (direct field, else parsed from Context). */
  stage?: string;
  /** Unit of work, only when a per-unit Context named one. */
  unit?: string;
  /** Every `**Key**: value` line of the block, keys verbatim. */
  fields: Record<string, string>;
  /** Basename of the shard this block came from — which clone did it. */
  shard: string;
}

export interface AuditLedger {
  /** All blocks from all shards, ascending by timestamp. */
  events: AuditEvent[];
  /** event type → count, for the stream filter and the health panel. */
  counts: Map<string, number>;
  /** Shard basenames read, for provenance ("2 clones"). */
  shards: string[];
  /** Earliest / latest timestamp seen, undefined for an empty ledger. */
  firstTs?: string;
  lastTs?: string;
}

const FIELD_RE = /^\*\*([^*]+)\*\*:[ \t]*(.*)$/;

/**
 * Tells whether a Context segment is a real stage slug. Supply
 * `(s) => catalog.bySlug.has(s)`; omit to fall back to positional guessing.
 */
export type IsStage = (slug: string) => boolean;

/**
 * Resolve `**Context**` into { stage, unit }.
 *
 * With an `isStage` oracle the shape is read rather than guessed: scan the
 * segments (skipping the leading phase) for the first that is a known stage; a
 * segment before it is the unit of work. Without the oracle, fall back to
 * position — 4 segments means unit at slot 1 and stage at slot 2, which is right
 * for per-unit Construction writes and wrong for a stage with a subdirectory.
 */
export function parseContext(ctx: string, isStage?: IsStage): { stage?: string; unit?: string } {
  const segs = ctx
    .split(">")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segs.length < 2) return {};

  if (isStage) {
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i]!;
      if (!isStage(seg)) continue;
      // Anything between the phase and the stage is the unit of work.
      return { stage: seg, unit: i > 1 ? segs[i - 1] : undefined };
    }
    // No known stage in the path (e.g. `verification > phase-check-ideation.md`,
    // a phase-level write). Leave unattributed rather than guess.
    return {};
  }

  if (segs.length >= 4) return { stage: segs[2], unit: segs[1] };
  if (segs.length === 3) return { stage: segs[1] };
  return {};
}

/**
 * Parse one shard's text into blocks. Exported for tests: it is the whole format
 * contract in one function, testable from a string with no filesystem.
 */
export function parseAuditShard(text: string, shard: string, isStage?: IsStage): AuditEvent[] {
  const out: AuditEvent[] = [];
  // Normalise CRLF first so the `---` split and the line regex both hold on a
  // shard that travelled through a Windows clone.
  for (const block of text.replace(/\r\n/g, "\n").split("\n---\n")) {
    const fields: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const m = FIELD_RE.exec(line);
      if (m) fields[m[1]!] = (m[2] ?? "").trim();
    }
    const ts = fields.Timestamp;
    const event = fields.Event;
    // A block without both is not an event block (the file's `# AI-DLC Audit Log`
    // title, or a trailing fragment).
    if (!ts || !event) continue;

    // Sensors use `Stage slug`; everything else `Stage`. ARTIFACT_* has neither.
    let stage = fields.Stage || fields["Stage slug"] || undefined;
    // A DIRECT `Unit` field beats anything inferred from `Context`, and dropping it lost
    // a whole class of event. `audit-format.md` gives `UNIT_STARTED` / `UNIT_PAUSED` /
    // `UNIT_RESUMED` / `UNIT_COMPLETED` the fields `Timestamp, Stage, Unit, Run floor`
    // — no `Context` at all — and team gate rows carry `Unit` the same way. Reading only
    // `Context` therefore left `event.unit` undefined on exactly the events that say
    // which unit finished, which is also what the completion receipts are (see
    // scan/matrix.ts): the ledger was carrying the answer and this parser threw it away.
    let unit = fields.Unit || undefined;

    const ctx = fields.Context;
    if (ctx) {
      const resolved = parseContext(ctx, isStage);
      if (!unit) unit = resolved.unit;
      if (!stage) stage = resolved.stage;
    }

    out.push({ ts, event, stage, unit, fields, shard });
  }
  return out;
}

/** Absolute paths of the audit shards in a record dir, sorted for determinism. */
function shardPaths(recordDir: string): string[] {
  const dir = path.join(recordDir, "audit");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Read every shard under `recordDir/audit/` and return the merged, time-ordered
 * ledger. Pass `isStage` (from the workspace's stage catalogue) so Context-only
 * events attribute to the right stage; without it attribution falls back to
 * positional guessing. An unreadable shard is skipped. Never throws; an absent
 * audit dir yields an empty ledger.
 */
export function readAuditLedger(recordDir: string, isStage?: IsStage): AuditLedger {
  const events: AuditEvent[] = [];
  const shards: string[] = [];

  for (const p of shardPaths(recordDir)) {
    let text: string;
    try {
      text = fs.readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    const base = path.basename(p);
    shards.push(base);
    events.push(...parseAuditShard(text, base, isStage));
  }

  // ISO second-precision UTC strings sort lexicographically == chronologically.
  // Ties keep insertion order (shard-sorted), which is stable in V8's sort.
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);

  return {
    events,
    counts,
    shards,
    firstTs: events.length > 0 ? events[0]?.ts : undefined,
    lastTs: events.length > 0 ? events[events.length - 1]?.ts : undefined,
  };
}
