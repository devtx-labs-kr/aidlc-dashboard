// Unit tests for the scan layer's format contracts. Each parser is exercised from
// a string where possible, so a format change fails here rather than silently
// producing a plausible-but-wrong number on the page.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAuditShard, parseContext } from "../scan/audit";
import type { AuditEvent } from "../scan/audit";
import { parseDrops } from "../scan/hooks-health";
import { type BoltDag, buildConstructionMatrix, parseBoltDag } from "../scan/matrix";
import { parseDiary, readDiaries } from "../scan/memory-diary";
import type { StageInfo } from "../scan/parser";
import { parseQuestions } from "../scan/questions";
import { parseSensorDetail } from "../scan/sensors";
import { type CatalogStage, expectedArtifacts } from "../scan/stage-catalog";
import { buildTiming, buildWorkers, classifyGaps, shardLabel } from "../scan/timing";

describe("audit shard", () => {
  const SHARD = `# AI-DLC Audit Log

## Stage Start
**Timestamp**: 2026-01-01T00:00:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: orchestrator

---

## Sensor Fired
**Timestamp**: 2026-01-01T00:01:00Z
**Event**: SENSOR_FIRED
**Fire id**: abcd1234
**Sensor ID**: type-check
**Stage slug**: code-generation

---
`;

  test("parses blocks and keeps every field", () => {
    const ev = parseAuditShard(SHARD, "s.md");
    expect(ev.length).toBe(2);
    expect(ev[0]?.event).toBe("STAGE_STARTED");
    expect(ev[0]?.stage).toBe("intent-capture");
    expect(ev[0]?.fields.Agent).toBe("orchestrator");
    expect(ev[0]?.shard).toBe("s.md");
  });

  test("reads `Stage slug` for sensor rows", () => {
    const ev = parseAuditShard(SHARD, "s.md");
    expect(ev[1]?.stage).toBe("code-generation");
    expect(ev[1]?.fields["Fire id"]).toBe("abcd1234");
  });

  test("skips the title block (no Timestamp/Event)", () => {
    expect(parseAuditShard("# Title\n\n---\n", "s.md")).toEqual([]);
  });

  test("tolerates CRLF", () => {
    const ev = parseAuditShard(SHARD.replace(/\n/g, "\r\n"), "s.md");
    expect(ev.length).toBe(2);
    expect(ev[0]?.stage).toBe("intent-capture");
  });
});

describe("Context attribution", () => {
  // The whole point of the isStage oracle: these two 4-segment forms mean
  // different things and position alone cannot separate them.
  const isStage = (s: string) => ["practices-discovery", "functional-design"].includes(s);

  test("4 segments where slot2 is a SUBDIR → stage is slot1, no unit", () => {
    const r = parseContext("inception > practices-discovery > contributions > x.md", isStage);
    expect(r.stage).toBe("practices-discovery");
    expect(r.unit).toBeUndefined();
  });

  test("4 segments where slot2 is a STAGE → stage is slot2, unit is slot1", () => {
    const r = parseContext("construction > PU-1 > functional-design > x.md", isStage);
    expect(r.stage).toBe("functional-design");
    expect(r.unit).toBe("PU-1");
  });

  test("3 segments → stage is slot1", () => {
    expect(parseContext("inception > practices-discovery > x.md", isStage).stage).toBe(
      "practices-discovery",
    );
  });

  test("no known stage in the path → unattributed, not guessed", () => {
    expect(parseContext("verification > phase-check-ideation.md", isStage).stage).toBeUndefined();
    expect(parseContext("codekb > repo > architecture.md", isStage).stage).toBeUndefined();
  });

  test("without the oracle, falls back to position", () => {
    expect(parseContext("construction > PU-1 > functional-design > x.md").stage).toBe(
      "functional-design",
    );
    // And is wrong on the subdir shape — the documented cost of no catalogue.
    expect(parseContext("inception > practices-discovery > contributions > x.md").stage).toBe(
      "contributions",
    );
  });
});

describe("stage catalogue expectations", () => {
  const stage: CatalogStage = {
    slug: "functional-design",
    number: "3.1",
    name: "Functional Design",
    phase: "construction",
    produces: ["business-logic-model", "business-rules"],
    optionalProduces: ["frontend-components"],
    producesKinds: {
      "business-rules": ["service", "spec", "library"],
      "frontend-components": ["ui"],
    },
    sensors: [],
  };

  test("kind-agnostic artifacts apply to every unit", () => {
    expect(expectedArtifacts(stage, "ui")).toContain("business-logic-model");
    expect(expectedArtifacts(stage, "library")).toContain("business-logic-model");
  });

  test("kind-scoped artifacts apply only to their kinds", () => {
    expect(expectedArtifacts(stage, "ui")).toEqual(["business-logic-model", "frontend-components"]);
    expect(expectedArtifacts(stage, "library")).toEqual(["business-logic-model", "business-rules"]);
  });

  test("unknown kind keeps only the kind-agnostic ones (under-claim, never over)", () => {
    expect(expectedArtifacts(stage, undefined)).toEqual(["business-logic-model"]);
  });
});

describe("construction matrix", () => {
  const dag: BoltDag = {
    units: [
      { name: "PU-A", display: "Pu A", kind: "library", dependsOn: [] },
      { name: "PU-B", display: "Pu B", kind: "ui", dependsOn: ["PU-A"] },
    ],
    batches: [["PU-A"], ["PU-B"]],
  };
  const stages: StageInfo[] = [
    { slug: "code-generation", display: "Code Generation", status: "active", execute: true },
  ];
  const catalog = {
    stages: [],
    bySlug: new Map<string, CatalogStage>([
      [
        "code-generation",
        {
          slug: "code-generation",
          number: "3.5",
          name: "Code Generation",
          phase: "construction",
          produces: ["code-generation-plan", "code-summary"],
          optionalProduces: [],
          producesKinds: {},
          sensors: [],
        },
      ],
    ]),
    sourcePath: "/demo/.kiro/tools/data/stage-graph.json",
    harnessDir: ".kiro",
  };

  test("three states: complete / partial / absent", () => {
    const mx = buildConstructionMatrix(
      dag,
      stages,
      (unit) =>
        unit === "PU-A" ? ["code-generation-plan", "code-summary"] : ["code-generation-plan"],
      catalog,
    )!;
    const cells = mx.stages[0]!.cells;
    expect(cells[0]!.state).toBe("complete");
    expect(cells[1]!.state).toBe("partial");
    expect(cells[1]!.missing).toEqual(["code-summary"]);
    expect(mx.stages[0]!.complete).toBe(1);
    expect(mx.stages[0]!.partial).toBe(1);
    expect(mx.contractAware).toBe(true);
  });

  test("empty segment is absent", () => {
    const mx = buildConstructionMatrix(dag, stages, () => [], catalog)!;
    expect(mx.stages[0]?.cells.every((c) => c.state === "absent")).toBe(true);
    expect(mx.stages[0]?.complete).toBe(0);
  });

  test("no catalogue degrades to binary (never 'partial')", () => {
    const mx = buildConstructionMatrix(dag, stages, () => ["code-generation-plan"], undefined)!;
    expect(mx.stages[0]?.cells.map((c) => c.state)).toEqual(["complete", "complete"]);
    expect(mx.contractAware).toBe(false);
  });

  test("in-flight stage is provisional", () => {
    const mx = buildConstructionMatrix(dag, stages, () => [], catalog)!;
    expect(mx.stages[0]?.provisional).toBe(true);
  });

  test("bolt_dag parse keeps kind, depends_on and batches", () => {
    const dag2 = parseBoltDag(
      JSON.stringify({
        bolt_dag: {
          units: [{ name: "PU-A", depends_on: [], kind: "library" }],
          batches: [["PU-A"]],
        },
      }),
    )!;
    expect(dag2.units[0]?.kind).toBe("library");
    expect(dag2.batches).toEqual([["PU-A"]]);
  });

  test("no bolt_dag → undefined (keeps the flat render)", () => {
    expect(parseBoltDag("{}")).toBeUndefined();
    expect(parseBoltDag("not json")).toBeUndefined();
  });
});

describe("questions", () => {
  test("blank [Answer]: is unanswered, filled is answered", () => {
    const qs = parseQuestions(`## Q1 — Plan Approval

text

[Answer]: A (approved)

## Q2 — Scope

text

[Answer]:
`);
    expect(qs.length).toBe(2);
    expect(qs[0]?.answered).toBe(true);
    expect(qs[0]?.answer).toBe("A (approved)");
    expect(qs[1]?.answered).toBe(false);
  });

  test("whitespace-only answer counts as unanswered", () => {
    expect(parseQuestions("## Q1 — x\n\n[Answer]:    \n")[0]?.answered).toBe(false);
  });

  test("an [Answer] before any heading is ignored", () => {
    expect(parseQuestions("[Answer]: stray\n")).toEqual([]);
  });

  test("the first [Answer] in a span wins", () => {
    const qs = parseQuestions("## Q1 — x\n[Answer]: first\n[Answer]: second\n");
    expect(qs[0]?.answer).toBe("first");
  });
});

describe("memory diary", () => {
  test("counts bullets per axis and strips the timestamp", () => {
    const e = parseDiary(`# Diary

## Interpretations

- 2026-01-01T00:00:00Z — first
- 2026-01-01T00:01:00Z — second

## Deviations

## Tradeoffs

- no timestamp here

## Open questions

- 2026-01-02T00:00:00Z — still open
`);
    expect(e.filter((x) => x.axis === "interpretations").length).toBe(2);
    expect(e.filter((x) => x.axis === "deviations").length).toBe(0);
    expect(e.filter((x) => x.axis === "tradeoffs")[0]?.text).toBe("no timestamp here");
    expect(e.filter((x) => x.axis === "openQuestions")[0]?.ts).toBe("2026-01-02T00:00:00Z");
    expect(e[0]?.text).toBe("first");
  });

  test("bullets outside a known heading are ignored", () => {
    expect(parseDiary("> preamble\n\n- stray bullet\n")).toEqual([]);
  });

  test("accepts suffixed headings, removes placeholders, and classifies questions conservatively", () => {
    const entries = parseDiary(`## Deviations (추가)
- changed after review

## Open questions (u4)
- None.
- (해소됨 2026-01-02) route fixed.
- API route 정합 확인 필요.
- historical context only.
- RefreshResult.persisted? is already fixed.
`);
    expect(entries.length).toBe(5);
    expect(entries[0]?.axis).toBe("deviations");
    expect(entries[1]?.questionStatus).toBe("resolved");
    expect(entries[2]?.questionStatus).toBe("followUp");
    expect(entries[3]?.questionStatus).toBe("note");
    expect(entries[4]?.questionStatus).toBe("note");
  });

  test("deduplicates stage-major fan-in in favor of the per-unit source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-diary-"));
    const parent = path.join(root, "construction", "functional-design");
    const unit = path.join(root, "construction", "u1", "functional-design");
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(unit, { recursive: true });
    const repeated = `## Interpretations
- 2026-01-01T00:00:00Z — shared decision
`;
    fs.writeFileSync(path.join(parent, "memory.md"), repeated);
    fs.writeFileSync(path.join(unit, "memory.md"), repeated);
    try {
      const report = readDiaries(root);
      expect(report.stages.length).toBe(2);
      expect(report.records.length).toBe(1);
      expect(report.records[0]?.unit).toBe("u1");
      expect(report.totals.interpretations).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sensor detail", () => {
  test("parses header fields and the JSON findings block", () => {
    const b = parseSensorDetail(
      `# type-check finding — code-generation

**Timestamp**: 2026-01-01T00:00:00Z
**Fire id**: bbbb2222
**Output path**: /demo/src/x.ts
**Pass**: false

## Findings

\`\`\`json
{ "pass": false, "errors": [{ "file": "src/x.ts", "line": 3, "message": "boom" }], "findings_count": 1 }
\`\`\`
`,
      "type-check-bbbb2222.md",
      "code-generation",
    )!;
    expect(b.sensorId).toBe("type-check");
    expect(b.fireId).toBe("bbbb2222");
    expect(b.findingsCount).toBe(1);
    expect(b.errors[0]?.line).toBe(3);
    expect(b.outputPath).toBe("/demo/src/x.ts");
  });

  test("upstream-coverage carries unreferenced artifacts", () => {
    const b = parseSensorDetail(
      `**Fire id**: cccc3333\n\n## Findings\n\n\`\`\`json\n{ "unreferenced": ["technology-stack"], "findings_count": 1 }\n\`\`\`\n`,
      "upstream-coverage-cccc3333.md",
      "nfr-requirements",
    )!;
    expect(b.sensorId).toBe("upstream-coverage");
    expect(b.unreferenced).toEqual(["technology-stack"]);
  });

  test("a truncated body keeps the header", () => {
    const b = parseSensorDetail(
      `**Fire id**: dddd4444\n\n## Findings\n\n\`\`\`json\n{ "pass": fal\n`,
      "linter-dddd4444.md",
      "code-generation",
    )!;
    expect(b.fireId).toBe("dddd4444");
    expect(b.errors).toEqual([]);
  });
});

describe("hook drops", () => {
  test("splits TSV and keeps a tabless line as the reason", () => {
    const rows = parseDrops("2026-01-01T00:00:00Z\treason one\nmalformed line\n\n");
    expect(rows.length).toBe(2);
    expect(rows[0]?.ts).toBe("2026-01-01T00:00:00Z");
    expect(rows[0]?.reason).toBe("reason one");
    expect(rows[1]?.ts).toBe("");
    expect(rows[1]?.reason).toBe("malformed line");
  });
});

describe("gap classification", () => {
  const ev = (ts: string, event: string): AuditEvent => ({ ts, event, fields: {}, shard: "s" });

  test("gate → HUMAN_TURN is IDLE", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "DECISION_RECORDED"),
      ev("2026-01-01T01:00:00Z", "HUMAN_TURN"),
    ]);
    expect(g.idleSec).toBe(3600);
    expect(g.workSec).toBe(0);
  });

  test("delegation counts as AGENT and inside WORK", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "REVIEW_REQUESTED"),
      ev("2026-01-01T00:10:00Z", "SUBAGENT_COMPLETED"),
    ]);
    expect(g.agentSec).toBe(600);
    expect(g.workSec).toBe(600);
    expect(g.idleSec).toBe(0);
  });

  test("a gap ending in a session resume is IDLE even with no gate before it", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "SENSOR_PASSED"),
      ev("2026-01-01T00:40:00Z", "SESSION_STARTED"),
    ]);
    expect(g.idleSec).toBe(2400);
    expect(g.parkedSec).toBe(2400);
    expect(g.inferredParkSec).toBe(2400);
  });

  test("WORKFLOW_PARKED → UNPARKED stays paused even with events in between", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "WORKFLOW_PARKED"),
      ev("2026-01-01T00:30:00Z", "HUMAN_TURN"),
      ev("2026-01-01T01:00:00Z", "WORKFLOW_UNPARKED"),
      ev("2026-01-01T01:00:30Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.parkedSec).toBe(3600);
    expect(g.observedSec).toBe(30);
    expect(g.unknownSec).toBe(0);
  });

  test("STAGE_AWAITING_APPROVAL → HUMAN_TURN is user wait", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL"),
      ev("2026-01-01T00:20:00Z", "HUMAN_TURN"),
    ]);
    expect(g.humanWaitSec).toBe(1200);
  });

  test("short gate gaps stay WORK (below the 60s floor)", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "DECISION_RECORDED"),
      ev("2026-01-01T00:00:30Z", "HUMAN_TURN"),
    ]);
    expect(g.idleSec).toBe(0);
    expect(g.workSec).toBe(30);
  });

  test("long unclassified gaps are surfaced as suspect", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "SENSOR_PASSED"),
      ev("2026-01-01T00:20:00Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.suspect.length).toBe(1);
    expect(g.suspect[0]?.seconds).toBe(1200);
    expect(g.unknownSec).toBe(1200);
    expect(g.observedSec).toBe(0);
    expect(g.workSec).toBe(1200);
  });
});

// Parallel development: each developer's machine writes its own audit shard, and
// gap classification is only meaningful WITHIN a shard.
describe("per-worker decomposition", () => {
  const at = (
    ts: string,
    event: string,
    shard: string,
    extra: Partial<AuditEvent> = {},
  ): AuditEvent => ({
    ts,
    event,
    fields: {},
    shard,
    ...extra,
  });

  test("shardLabel strips the clone id and machine token, keeps a human name", () => {
    expect(shardLabel("jiho-kim-c02dw4rrmd6r-0c1b20ca004a.md")).toBe("jiho-kim");
    expect(shardLabel("hyeongjun-kim-c02g53bjmd6t-890e6b5a6b4e.md")).toBe("hyeongjun-kim");
    // No machine token — a pure hostname must survive intact.
    expect(shardLabel("macbook-pro-8-local-a444271ccd58.md")).toBe("macbook-pro-8-local");
    // Unrecognised shape keeps its basename rather than being mangled.
    expect(shardLabel("plain.md")).toBe("plain");
  });

  test("classifies each shard on its OWN timeline, not the merged one", () => {
    // A waits at a gate 07:00→08:00 while B works right through the same hour.
    // Merged, B's events fill A's wait and the idle vanishes; per shard it stands.
    const events = [
      at("2026-01-01T07:00:00Z", "DECISION_RECORDED", "a.md"),
      at("2026-01-01T07:20:00Z", "SENSOR_FIRED", "b.md"),
      at("2026-01-01T07:40:00Z", "SENSOR_PASSED", "b.md"),
      at("2026-01-01T08:00:00Z", "HUMAN_TURN", "a.md"),
    ].sort((x, y) => (x.ts < y.ts ? -1 : 1));

    // Merged: the gate→HUMAN_TURN pair is no longer adjacent, so idle is 0.
    expect(classifyGaps(events).idleSec).toBe(0);

    // Per worker: A's full hour of waiting is recovered.
    const workers = buildWorkers(events);
    const a = workers.find((w) => w.shard === "a.md")!;
    expect(a.idleSec).toBe(3600);
    expect(workers.find((w) => w.shard === "b.md")?.idleSec).toBe(0);
  });

  test("ranks workers by event count and flags the gate-driving clone", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:01:00Z", "SENSOR_FIRED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:02:00Z", "GATE_APPROVED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:03:00Z", "STAGE_COMPLETED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:04:00Z", "SENSOR_FIRED", "helper.md", { stage: "code-generation" }),
    ];
    const workers = buildWorkers(events);
    expect(workers[0]?.shard).toBe("lead.md"); // busiest first
    expect(workers[0]?.gatesApproved).toBe(1);
    expect(workers[0]?.stagesCompleted).toBe(1);
    expect(workers[1]?.gatesApproved).toBe(0);
  });

  test("collects the stages and units each worker touched", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "ARTIFACT_CREATED", "a.md", {
        stage: "code-generation",
        unit: "PU-1",
      }),
      at("2026-01-01T00:01:00Z", "ARTIFACT_CREATED", "a.md", {
        stage: "code-generation",
        unit: "PU-2",
      }),
      at("2026-01-01T00:02:00Z", "SENSOR_FIRED", "a.md", { stage: "nfr-design" }),
    ];
    const w = buildWorkers(events)[0]!;
    expect(w.stages).toContain("code-generation");
    expect(w.stages).toContain("nfr-design");
    expect(w.units.sort()).toEqual(["PU-1", "PU-2"]);
  });

  test("a single-clone run is not parallel and person-time equals wall-clock", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "s" }),
      at("2026-01-01T01:00:00Z", "STAGE_COMPLETED", "solo.md", { stage: "s" }),
    ];
    const t = buildTiming({
      events,
      counts: new Map(),
      shards: ["solo.md"],
      firstTs: events[0]?.ts,
      lastTs: events[1]?.ts,
    });
    expect(t.parallel).toBe(false);
    expect(t.workers.length).toBe(1);
    expect(t.parallelism).toBeCloseTo(1, 5);
  });

  test("parallelism exceeds 1 when shards overlap in time", () => {
    // Two shards, each spanning the same hour → 2 person-hours in 1 wall-hour.
    const events = [
      at("2026-01-01T00:00:00Z", "SENSOR_FIRED", "a.md"),
      at("2026-01-01T00:00:30Z", "SENSOR_FIRED", "b.md"),
      at("2026-01-01T01:00:00Z", "SENSOR_PASSED", "a.md"),
      at("2026-01-01T01:00:00Z", "SENSOR_PASSED", "b.md"),
    ];
    const t = buildTiming({
      events,
      counts: new Map(),
      shards: ["a.md", "b.md"],
      firstTs: events[0]?.ts,
      lastTs: "2026-01-01T01:00:00Z",
    });
    expect(t.parallel).toBe(true);
    expect(t.parallelism!).toBeGreaterThan(1.9);
  });

  test("workflow completion closes wall time and STAGE_SKIPPED closes its segment", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "WORKFLOW_STARTED", "solo.md"),
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "optional" }),
      at("2026-01-01T00:00:10Z", "STAGE_SKIPPED", "solo.md", { stage: "optional" }),
      at("2026-01-01T00:00:20Z", "WORKFLOW_COMPLETED", "solo.md"),
      at("2026-01-01T01:00:00Z", "HUMAN_TURN", "solo.md"),
    ];
    const t = buildTiming(
      {
        events,
        counts: new Map(),
        shards: ["solo.md"],
        firstTs: events[0]?.ts,
        lastTs: events.at(-1)?.ts,
      },
      "2026-01-01T02:00:00Z",
    );
    expect(t.elapsedSec).toBe(20);
    expect(t.lastTs).toBe("2026-01-01T00:00:20Z");
    expect(t.stages[0]?.endKind).toBe("skipped");
    expect(t.stages[0]?.elapsedSec).toBe(10);
  });

  test("stage re-entry sums entered segments instead of spanning unrelated work", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "WORKFLOW_STARTED", "solo.md"),
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:10Z", "STAGE_COMPLETED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:10Z", "STAGE_STARTED", "solo.md", { stage: "other" }),
      at("2026-01-01T00:00:20Z", "STAGE_COMPLETED", "solo.md", { stage: "other" }),
      at("2026-01-01T00:00:20Z", "STAGE_STARTED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:30Z", "STAGE_COMPLETED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:30Z", "WORKFLOW_COMPLETED", "solo.md"),
    ];
    const t = buildTiming({ events, counts: new Map(), shards: ["solo.md"] });
    const rework = t.stages.find((stage) => stage.stage === "rework");
    expect(rework?.segments.length).toBe(2);
    expect(rework?.elapsedSec).toBe(20);
  });

  test("an empty ledger yields a well-formed, non-parallel report", () => {
    const t = buildTiming({ events: [], counts: new Map(), shards: [] });
    expect(t.parallel).toBe(false);
    expect(t.workers).toEqual([]);
    expect(t.personIdleSec).toBe(0);
    expect(t.parallelism).toBeUndefined();
  });
});
