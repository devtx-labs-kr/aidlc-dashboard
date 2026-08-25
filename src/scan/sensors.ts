// Sensor outcomes: how many fired, how many failed, and what the failures say.
//
// TWO SOURCES, DELIBERATELY. Neither alone is sufficient:
//
//   - the audit ledger has EVERY firing (SENSOR_FIRED, then a terminal
//     SENSOR_PASSED / SENSOR_FAILED / SENSOR_BUDGET_OVERRIDE correlated by
//     `Fire id`) but no finding bodies;
//   - `.aidlc-sensors/<stage>/<sensorId>-<fireId>.md` has the finding bodies but
//     ONLY for failures — a passing fire writes no file (verified: 46 detail
//     files, all `**Pass**: false`, matching 46 SENSOR_FAILED exactly).
//
// So counts come from audit and bodies from disk, joined on fire id. Note we do
// NOT use runtime-graph.json's pre-aggregated `sensor_firings`: it is only
// recompiled at stage transitions, so for the in-flight stage — the one being
// looked at — it is empty while audit already holds hundreds of firings.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditLedger } from "./audit";

/** A type-check finding row from the detail file's JSON block. */
export interface TypeCheckError {
  file: string;
  line?: number;
  column?: number;
  message: string;
}

/** One failed firing, with its finding body when the detail file was readable. */
export interface SensorFailure {
  /** Sensor id, e.g. "type-check" / "upstream-coverage". */
  id: string;
  stage: string;
  fireId: string;
  ts: string;
  /** The artifact/file the sensor judged, absolute as recorded by the engine. */
  outputPath?: string;
  /** `findings_count` from the JSON block. */
  findingsCount?: number;
  /** type-check / linter: the individual errors. */
  errors: TypeCheckError[];
  /** upstream-coverage: consumed artifacts never referenced by the output. */
  unreferenced: string[];
  /** Detail-file basename, or undefined when no body was found on disk. */
  detailFile?: string;
}

/** Per-stage roll-up of firings. */
export interface SensorStageSummary {
  stage: string;
  fired: number;
  passed: number;
  failed: number;
  budgetOverride: number;
  /** Firings with no terminal event yet — in flight at read time. */
  pending: number;
  /** sensor id → firing count, so a stage shows which sensors dominate. */
  byId: Map<string, number>;
}

export interface SensorReport {
  /** In stage-first-seen order (audit is time-ordered, so run order). */
  stages: SensorStageSummary[];
  /** Every failure, newest first. */
  failures: SensorFailure[];
  totalFired: number;
  totalPassed: number;
  totalFailed: number;
  /** Detail files found on disk that no audit failure claimed — a drift signal. */
  orphanDetailFiles: number;
}

interface DetailBody {
  fireId: string;
  sensorId: string;
  stage: string;
  ts?: string;
  outputPath?: string;
  findingsCount?: number;
  errors: TypeCheckError[];
  unreferenced: string[];
  file: string;
}

const FIELD_RE = /^\*\*([^*]+)\*\*:[ \t]*(.*)$/;

/**
 * Parse one `.aidlc-sensors/**` detail file. Exported for tests — the format
 * contract (header fields + a fenced JSON findings block) lives here alone.
 */
export function parseSensorDetail(
  text: string,
  fileName: string,
  stage: string,
): DetailBody | undefined {
  const fields: Record<string, string> = {};
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = FIELD_RE.exec(line);
    if (m) fields[m[1]!] = (m[2] ?? "").trim();
    // Header fields all precede the findings block; stop before parsing JSON.
    if (line.startsWith("## Findings")) break;
  }
  // `<sensorId>-<fireId8>.md` — the id may itself contain hyphens, so split on
  // the LAST one rather than the first.
  const base = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const cut = base.lastIndexOf("-");
  if (cut <= 0) return undefined;
  const sensorId = base.slice(0, cut);
  const fireId = fields["Fire id"] || base.slice(cut + 1);

  const errors: TypeCheckError[] = [];
  const unreferenced: string[] = [];
  let findingsCount: number | undefined;

  const fence = /```json\n([\s\S]*?)\n```/.exec(text);
  if (fence) {
    try {
      const j = JSON.parse(fence[1] ?? "") as Record<string, unknown>;
      if (typeof j.findings_count === "number") findingsCount = j.findings_count;
      if (Array.isArray(j.errors)) {
        for (const e of j.errors) {
          if (typeof e !== "object" || e === null) continue;
          const r = e as Record<string, unknown>;
          if (typeof r.file !== "string" || typeof r.message !== "string") continue;
          errors.push({
            file: r.file,
            line: typeof r.line === "number" ? r.line : undefined,
            column: typeof r.column === "number" ? r.column : undefined,
            message: r.message,
          });
        }
      }
      if (Array.isArray(j.unreferenced)) {
        for (const u of j.unreferenced) if (typeof u === "string") unreferenced.push(u);
      }
    } catch {
      // A truncated/partially-synced body: keep the header, drop the findings.
    }
  }

  return {
    fireId,
    sensorId,
    stage,
    ts: fields.Timestamp,
    outputPath: fields["Output path"],
    findingsCount,
    errors,
    unreferenced,
    file: fileName,
  };
}

/** Read every detail file under `.aidlc-sensors/`, keyed by fire id. */
function readDetailBodies(recordDir: string): Map<string, DetailBody> {
  const out = new Map<string, DetailBody>();
  const root = path.join(recordDir, ".aidlc-sensors");
  let stageDirs: string[];
  try {
    stageDirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const stage of stageDirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(root, stage));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(root, stage, f), "utf-8");
      } catch {
        continue;
      }
      const body = parseSensorDetail(text, f, stage);
      if (body) out.set(body.fireId, body);
    }
  }
  return out;
}

/**
 * Join the audit ledger's firings with the on-disk finding bodies.
 * `recordDir` is only read for the bodies, so a ledger-only call still yields
 * correct counts with empty failure details.
 */
export function readSensorReport(recordDir: string, ledger: AuditLedger): SensorReport {
  const bodies = readDetailBodies(recordDir);
  const claimed = new Set<string>();

  const perStage = new Map<string, SensorStageSummary>();
  const stageOf = (stage: string): SensorStageSummary => {
    let s = perStage.get(stage);
    if (!s) {
      s = { stage, fired: 0, passed: 0, failed: 0, budgetOverride: 0, pending: 0, byId: new Map() };
      perStage.set(stage, s);
    }
    return s;
  };

  // Terminal events per fire id, so a FIRED with no terminal counts as pending.
  const terminal = new Map<string, string>();
  for (const e of ledger.events) {
    if (
      e.event === "SENSOR_PASSED" ||
      e.event === "SENSOR_FAILED" ||
      e.event === "SENSOR_BUDGET_OVERRIDE"
    ) {
      const fid = e.fields["Fire id"];
      if (fid) terminal.set(fid, e.event);
    }
  }

  const failures: SensorFailure[] = [];
  for (const e of ledger.events) {
    if (e.event === "SENSOR_FIRED") {
      const stage = e.stage ?? "(unattributed)";
      const s = stageOf(stage);
      s.fired++;
      const id = e.fields["Sensor ID"] ?? "(unknown)";
      s.byId.set(id, (s.byId.get(id) ?? 0) + 1);
      const fid = e.fields["Fire id"];
      const t = fid ? terminal.get(fid) : undefined;
      if (t === "SENSOR_PASSED") s.passed++;
      else if (t === "SENSOR_FAILED") s.failed++;
      else if (t === "SENSOR_BUDGET_OVERRIDE") s.budgetOverride++;
      else s.pending++;
      continue;
    }
    if (e.event !== "SENSOR_FAILED") continue;

    const fireId = e.fields["Fire id"] ?? "";
    const body = fireId ? bodies.get(fireId) : undefined;
    if (body) claimed.add(fireId);
    const countRaw = e.fields["Findings count"];
    failures.push({
      id: e.fields["Sensor ID"] ?? body?.sensorId ?? "(unknown)",
      stage: e.stage ?? body?.stage ?? "(unattributed)",
      fireId,
      ts: e.ts,
      outputPath: body?.outputPath,
      findingsCount:
        body?.findingsCount ?? (countRaw && /^\d+$/.test(countRaw) ? Number(countRaw) : undefined),
      errors: body?.errors ?? [],
      unreferenced: body?.unreferenced ?? [],
      detailFile: body?.file,
    });
  }

  failures.reverse(); // ledger is ascending; failures read newest-first

  const stages = [...perStage.values()];
  return {
    stages,
    failures,
    totalFired: stages.reduce((n, s) => n + s.fired, 0),
    totalPassed: stages.reduce((n, s) => n + s.passed, 0),
    totalFailed: stages.reduce((n, s) => n + s.failed, 0),
    orphanDetailFiles: [...bodies.keys()].filter((k) => !claimed.has(k)).length,
  };
}
