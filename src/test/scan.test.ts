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
import { buildRework } from "../scan/rework";
import { parseSensorDetail, readSensorReport } from "../scan/sensors";
import { type CatalogStage, expectedArtifacts } from "../scan/stage-catalog";
import { type GapSplit, buildTiming, buildWorkers, classifyGaps, shardLabel } from "../scan/timing";

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

  test("a kind the stage contracts nothing for is n/a, not absent", () => {
    // Real shape: functional-design scopes every artifact to service/spec/ui/library,
    // so a `packaging` unit is contracted nothing — "미착수" would be a lie.
    const kindScoped = {
      ...catalog,
      bySlug: new Map<string, CatalogStage>([
        [
          "code-generation",
          {
            ...catalog.bySlug.get("code-generation")!,
            producesKinds: { "code-generation-plan": ["ui"], "code-summary": ["ui"] },
          },
        ],
      ]),
    };
    const mx = buildConstructionMatrix(dag, stages, () => [], kindScoped)!;
    // PU-A is `service` here → nothing contracted; PU-B is `ui` → absent for real.
    expect(mx.stages[0]?.cells.map((c) => c.state)).toEqual(["n/a", "absent"]);
    expect(mx.stages[0]?.notApplicable).toBe(1);
    // The n/a unit leaves the denominator: 0 of 1 applicable, not 0 of 2.
    expect(mx.stages[0]!.total - mx.stages[0]!.notApplicable).toBe(1);
  });

  test("'nothing expected' stays binary when the kind or the catalogue row is missing", () => {
    // Unknown kind → we do not know what was contracted, so no n/a claim.
    const kindless: BoltDag = {
      units: [{ name: "PU-A", display: "Pu A", dependsOn: [] }],
      batches: [["PU-A"]],
    };
    const kindScoped = {
      ...catalog,
      bySlug: new Map<string, CatalogStage>([
        [
          "code-generation",
          {
            ...catalog.bySlug.get("code-generation")!,
            producesKinds: { "code-generation-plan": ["ui"], "code-summary": ["ui"] },
          },
        ],
      ]),
    };
    const unknownKind = buildConstructionMatrix(kindless, stages, () => [], kindScoped)!.stages[0]!;
    expect(unknownKind.cells[0]?.state).toBe("absent");
    expect(unknownKind.notApplicable).toBe(0);
    // No catalogue row at all → likewise binary.
    const noRow = { ...catalog, bySlug: new Map<string, CatalogStage>() };
    expect(buildConstructionMatrix(dag, stages, () => [], noRow)!.stages[0]?.cells[0]?.state).toBe(
      "absent",
    );
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

  // The id shapes below all come from one long real run; see the header comment
  // in scan/questions.ts for the measured counts per shape.
  test("the id may be bracketed, an F follow-up, or suffixed", () => {
    const qs = parseQuestions(`## [Q1] 컴포넌트 경계를 무엇으로 가르는가

[Answer]: B

## [F2] 서버 플래그 판정은 어느 컴포넌트의 일인가

[Answer]: C

## F1. 판정 대상 6건 중 진입이 차단된 기획전이 있으면?

[Answer]: A

## Q6-a. (후속) 그 차수 기한은 언제입니까?

[Answer]:
`);
    expect(qs.map((q) => q.heading.split(/\s/)[0])).toEqual(["[Q1]", "[F2]", "F1.", "Q6-a."]);
    expect(qs.map((q) => q.answered)).toEqual([true, true, true, false]);
  });

  test("a blank placeholder followed by a real answer reads as answered", () => {
    // The engine writes the blank marker; a human answers underneath it.
    const qs = parseQuestions("## [F2] x\n\n[Answer]:\n\n\n[Answer]: C. 넷으로 늘린다\n");
    expect(qs.length).toBe(1);
    expect(qs[0]?.answered).toBe(true);
    expect(qs[0]?.answer).toBe("C. 넷으로 늘린다");
  });

  test("a heading with no [Answer]: marker in its span is prose, not an ask", () => {
    // Real shape: a narrative section reusing an answered question's id. Counting
    // it would put a permanent blocker on the screen.
    const qs = parseQuestions(`## [Q5] 확인되지 않은 필드 둘을 어떻게 적어 둘까?

[Answer]: D

## [Q5] 후속 — 원문에서 확인한 것

### mgtMnbdCd — 근거를 찾았다

prose only, no marker
`);
    expect(qs.length).toBe(1);
    expect(qs[0]?.answered).toBe(true);
  });

  test("a prose heading that merely starts with a letter+digit is not a question", () => {
    expect(parseQuestions("## U1의 완료는 무엇으로 판정하나\n\n[Answer]: 판정 기준\n")).toEqual([]);
  });

  test("a non-question heading closes the span, so its [Answer] attaches to nothing", () => {
    const qs = parseQuestions("## Q1 — x\n[Answer]:\n\n## Consolidated Summary\n[Answer]: yes\n");
    expect(qs.length).toBe(1);
    expect(qs[0]?.answered).toBe(false);
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

  test("a failure from another clone keeps its count and is reported as body-less", () => {
    // `audit/` is sharded per clone but `.aidlc-sensors/` is not, so a record that
    // merges two developers' shards holds only one machine's finding bodies.
    // Measured on a real two-developer run: 84 failures, 54 bodies, split exactly
    // by shard (30 / 0 and 54 / 54).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-sens-"));
    try {
      const stageDir = path.join(dir, ".aidlc-sensors", "code-generation");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(
        path.join(stageDir, "type-check-local111.md"),
        '**Fire id**: local111\n**Pass**: false\n\n## Findings\n\n```json\n{ "findings_count": 2 }\n```\n',
      );
      const ev = (ts: string, event: string, shard: string, fireId: string): AuditEvent => ({
        ts,
        event,
        fields: { "Fire id": fireId, "Sensor ID": "type-check" },
        shard,
        stage: "code-generation",
      });
      const events: AuditEvent[] = [
        ev("2026-01-01T00:00:00Z", "SENSOR_FIRED", "local.md", "local111"),
        ev("2026-01-01T00:00:01Z", "SENSOR_FAILED", "local.md", "local111"),
        // Same sensor, other machine — its body never travelled with the copy.
        ev("2026-01-01T00:00:02Z", "SENSOR_FIRED", "other.md", "remote99"),
        ev("2026-01-01T00:00:03Z", "SENSOR_FAILED", "other.md", "remote99"),
      ];
      const r = readSensorReport(dir, {
        events,
        counts: new Map(),
        shards: ["local.md", "other.md"],
      });
      expect(r.totalFailed).toBe(2); // the audit counts both
      expect(r.failuresWithoutBody).toBe(1); // only one body is present
      expect(r.orphanDetailFiles).toBe(0); // and no file is unclaimed
      const bodyless = r.failures.find((f) => f.fireId === "remote99")!;
      expect(bodyless.detailFile).toBeUndefined();
      expect(bodyless.errors).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  // A shard that has not started, or has already gone quiet, is ABSENT — not
  // working. Comparing against the whole ledger's shard set made "every clone is
  // parked" unreachable on a sequential handover: measured on a real 3-shard run it
  // fired for 0 gaps and discarded all 80.31h the ledger marks as parked.
  test("a clone that has finished is absent, so the remaining clone's park counts", () => {
    const at = (ts: string, event: string, shard: string): AuditEvent => ({
      ts,
      event,
      fields: {},
      shard,
    });
    // THE DISCRIMINATING CASE: A leaves WITHOUT parking. Against the whole ledger's
    // shard set, "every clone parked" then needs A — which never happens — so B's
    // explicit park was discarded. This is the sequential-handover shape that made a
    // real run report 0.00h of explicit park out of 80.31h marked.
    const g = classifyGaps([
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "a.md"),
      at("2026-01-01T00:10:00Z", "STAGE_COMPLETED", "a.md"), // A's last event
      at("2026-01-01T00:20:00Z", "SENSOR_FIRED", "b.md"),
      at("2026-01-01T00:30:00Z", "WORKFLOW_PARKED", "b.md"),
      at("2026-01-01T01:30:00Z", "HUMAN_TURN", "b.md"),
    ]);
    expect(g.parkedSec).toBe(3600); // B's marked hour, counted
    expect(g.inferredParkSec).toBe(0); // from the explicit marker, not a session guess
  });

  test("a parked clone does not stop the team while another clone is still present", () => {
    const at = (ts: string, event: string, shard: string): AuditEvent => ({
      ts,
      event,
      fields: {},
      shard,
    });
    const g = classifyGaps([
      at("2026-01-01T00:00:00Z", "SENSOR_FIRED", "a.md"),
      at("2026-01-01T00:10:00Z", "WORKFLOW_PARKED", "a.md"),
      // A is alone and parked for this hour → the team really is stopped.
      at("2026-01-01T01:10:00Z", "SENSOR_FIRED", "b.md"),
      // Now BOTH are present (A still has an event to come) and only A is parked,
      // so this stretch is not a team stop.
      at("2026-01-01T01:20:00Z", "SENSOR_PASSED", "a.md"),
      at("2026-01-01T01:30:00Z", "SENSOR_PASSED", "b.md"),
    ]);
    expect(g.parkedSec).toBe(3600); // only the hour A was the sole clone present
    // The stretch with A parked and B present is not park — it stays unclassified
    // rather than being credited to either side.
    expect(g.suspect.some((s) => s.at === "2026-01-01T01:10:00Z" && s.seconds === 600)).toBe(true);
    expect(g.unknownSec).toBe(1800); // that stretch plus the two 10-minute edges
  });

  // `REVIEW_REQUESTED` is followed by the artifacts the reviewer writes, so the
  // close is several events later. Measured on a real run, 52 of 61 delegation gaps
  // closed on `ARTIFACT_UPDATED`, so an adjacency test saw 0.31h of a real 14.4h.
  test("delegation spans the whole open→close window, not just the adjacent pair", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "REVIEW_REQUESTED"),
      ev("2026-01-01T00:20:00Z", "ARTIFACT_UPDATED"),
      ev("2026-01-01T00:40:00Z", "ARTIFACT_UPDATED"),
      ev("2026-01-01T01:00:00Z", "REVIEW_COMPLETED"),
      // After the close, an equally long gap is NOT delegation.
      ev("2026-01-01T01:20:00Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.delegatedSec).toBe(3600); // the full hour under review
    expect(g.observedSec).toBe(3600); // delegation is inside work
    expect(g.unknownSec).toBe(1200); // the post-close gap stays unclassified
  });

  test("an unclosed delegation marks nothing, so a dangling open cannot swallow the run", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "REVIEW_REQUESTED"),
      ev("2026-01-01T00:20:00Z", "ARTIFACT_UPDATED"),
      ev("2026-01-01T00:40:00Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.delegatedSec).toBe(0);
    expect(g.unknownSec).toBe(2400);
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
    expect(t.personElapsedSec).toBe(t.elapsedSec);
    // One clone has nothing to be parallel WITH, so the ratio is not reported —
    // reporting 1.00× would invite reading it as a measurement of concurrency.
    expect(t.overlapSec).toBe(0);
    expect(t.parallelism).toBeUndefined();
  });

  test("non-overlapping shards are a handover, not parallel development", () => {
    // Real shape: 3 shards / 2 developers whose windows do not overlap at all. The
    // old reading called that 병렬 개발 with parallelism 0.985.
    const events = [
      at("2026-01-01T00:00:00Z", "SENSOR_FIRED", "a-aaaaaaaaaaaa.md"),
      at("2026-01-01T01:00:00Z", "SENSOR_PASSED", "a-aaaaaaaaaaaa.md"),
      // 30 minutes of handover, then the second clone picks it up.
      at("2026-01-01T01:30:00Z", "SENSOR_FIRED", "b-bbbbbbbbbbbb.md"),
      at("2026-01-01T02:30:00Z", "SENSOR_PASSED", "b-bbbbbbbbbbbb.md"),
      // A third shard sharing the SECOND clone's id — same working copy, other host.
      at("2026-01-01T03:00:00Z", "SENSOR_FIRED", "host2-bbbbbbbbbbbb.md"),
      at("2026-01-01T03:30:00Z", "SENSOR_PASSED", "host2-bbbbbbbbbbbb.md"),
    ];
    const t = buildTiming({ events, counts: new Map(), shards: [] });
    expect(t.workers.length).toBe(3);
    expect(t.clones).toBe(2); // two working copies, not three
    expect(t.overlapSec).toBe(0);
    expect(t.parallelism).toBeUndefined();
    expect(t.handoverSec).toBe(3600); // 30min + 30min between the three windows
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

  test("an open run separates the last event from the window end, and names the silence", () => {
    // A tree copied mid-run (or simply parked) keeps a fixed last event while the
    // window keeps ending at "now". Measured on such a copy: the window read 130.3h
    // at the read and 562.1h 18 days later while the classified total stayed 130.3h.
    //
    // TWO SHARDS ON PURPOSE. The first version of this test used one shard, and that
    // is why it passed against a build where the trailing silence WAS classified: a
    // lone shard is trivially "all parked" after a park marker, so the silence went
    // to `parkedSec` while the test only watched `unknownSec`. With two shards the
    // silence lands in `unknownSec` unless it is excluded from classification, so
    // this fixture actually holds the invariant its assertions claim.
    const events = [
      at("2026-01-01T00:00:00Z", "WORKFLOW_STARTED", "a.md"),
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "a.md", { stage: "nfr-design" }),
      at("2026-01-01T00:30:00Z", "SENSOR_FIRED", "b.md", { stage: "nfr-design" }),
      at("2026-01-01T01:00:00Z", "WORKFLOW_PARKED", "a.md", { stage: "nfr-design" }),
    ];
    const ledger = { events, counts: new Map(), shards: ["a.md", "b.md"] };
    const atRead = buildTiming(ledger, "2026-01-01T01:00:00Z");
    const muchLater = buildTiming(ledger, "2026-01-04T01:00:00Z");

    // The last EVENT does not move; only the window does.
    expect(atRead.lastEventTs).toBe("2026-01-01T01:00:00Z");
    expect(muchLater.lastEventTs).toBe("2026-01-01T01:00:00Z");
    expect(muchLater.lastTs).toBe("2026-01-04T01:00:00Z");
    expect(atRead.sinceLastEventSec).toBe(0);
    expect(muchLater.sinceLastEventSec).toBe(3 * 24 * 3600);
    expect(muchLater.elapsedSec).toBe(atRead.elapsedSec + 3 * 24 * 3600);

    // Every bucket is untouched by the clock, and no synthetic event is invented.
    for (const pick of [
      (g: GapSplit) => g.humanWaitSec,
      (g: GapSplit) => g.parkedSec,
      (g: GapSplit) => g.observedSec,
      (g: GapSplit) => g.unknownSec,
    ]) {
      expect(pick(muchLater.total)).toBe(pick(atRead.total));
    }
    expect(muchLater.total.unknown.some((u) => u.toEvent === "ANALYSIS_NOW")).toBe(false);
    // The buckets account for the window MINUS the silence, exactly.
    const bucketSum =
      muchLater.total.humanWaitSec +
      muchLater.total.parkedSec +
      muchLater.total.observedSec +
      muchLater.total.unknownSec;
    expect(bucketSum).toBe(muchLater.elapsedSec - muchLater.sinceLastEventSec);
    // And an unfinished stage stops at its last event rather than following the clock.
    const stage = muchLater.stages.find((s) => s.stage === "nfr-design")!;
    expect(stage.endedAt).toBe("2026-01-01T01:00:00Z");
    expect(stage.elapsedSec).toBe(atRead.stages[0]!.elapsedSec);
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

  test("a segment closed by re-entry is superseded, never 'in-flight'", () => {
    // Measured symptom: two blue "진행중" bars sitting five days in the past, because a
    // re-entry closed the earlier attempt with the state it happened to be in.
    const events = [
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "reqs" }),
      at("2026-01-01T01:00:00Z", "STAGE_AWAITING_APPROVAL", "solo.md", { stage: "reqs" }),
      at("2026-01-01T02:00:00Z", "GATE_REJECTED", "solo.md", { stage: "reqs" }),
      // Re-entered after the rejection: the first attempt is over.
      at("2026-01-01T03:00:00Z", "STAGE_STARTED", "solo.md", { stage: "reqs" }),
      at("2026-01-01T04:00:00Z", "STAGE_COMPLETED", "solo.md", { stage: "reqs" }),
    ];
    const t = buildTiming({ events, counts: new Map(), shards: ["solo.md"] });
    const reqs = t.stages.find((s) => s.stage === "reqs")!;
    expect(reqs.segments.map((s) => s.endKind)).toEqual(["superseded", "completed"]);
    // The stage as a whole ended completed — the superseded kind never leaks upward.
    expect(reqs.endKind).toBe("completed");
  });

  test("an empty ledger yields a well-formed, non-parallel report", () => {
    const t = buildTiming({ events: [], counts: new Map(), shards: [] });
    expect(t.parallel).toBe(false);
    expect(t.workers).toEqual([]);
    expect(t.personIdleSec).toBe(0);
    expect(t.parallelism).toBeUndefined();
  });
});

// Rework: the ledger's richest signal, and the one the panel used to be silent about.
describe("rework", () => {
  const at = (ts: string, event: string, stage: string, fields: Record<string, string> = {}) =>
    ({ ts, event, fields, shard: "s.md", stage }) as AuditEvent;
  const ledger = (events: AuditEvent[]) => {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    return { events, counts, shards: ["s.md"] };
  };

  test("pairs the first rejection with the last approval and keeps the human reason", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", "reqs"),
        at("2026-01-01T01:00:00Z", "GATE_REJECTED", "reqs", { Feedback: "근거가 빠졌다" }),
        at("2026-01-01T01:00:00Z", "STAGE_REVISING", "reqs", {
          "Revision count": "2",
          Feedback: "근거가 빠졌다",
        }),
        at("2026-01-01T02:00:00Z", "STAGE_AWAITING_APPROVAL", "reqs"),
        at("2026-01-01T03:00:00Z", "GATE_APPROVED", "reqs"),
      ]),
    );
    expect(r.stages.length).toBe(1);
    const s = r.stages[0]!;
    expect(s.stage).toBe("reqs");
    expect(s.submissions).toBe(2);
    expect(s.rejections).toBe(1);
    expect(s.revisions).toBe(1);
    expect(s.revisionHigh).toBe(2);
    expect(s.reworkSec).toBe(7200); // 01:00 rejection → 03:00 approval
    expect(s.settled).toBe(true);
    // The same text on both events is one reason, not two.
    expect(s.feedback.map((f) => f.text)).toEqual(["근거가 빠졌다"]);
    expect(r.reworkSec).toBe(7200);
    expect(r.provisional).toBe(false);
  });

  test("two rejections span the whole stretch, including the approval in between", () => {
    // "Time this stage spent not yet accepted" — a revision has no close marker of its
    // own, so per-round spans are not available and must not be invented.
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "d", { Feedback: "1차" }),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "d"),
        at("2026-01-01T02:00:00Z", "GATE_REJECTED", "d", { Feedback: "2차" }),
        at("2026-01-01T04:00:00Z", "GATE_APPROVED", "d"),
      ]),
    );
    expect(r.stages[0]?.reworkSec).toBe(4 * 3600);
    expect(r.stages[0]?.rejections).toBe(2);
    expect(r.stages[0]?.feedback.map((f) => f.text)).toEqual(["2차", "1차"]); // newest first
  });

  test("an unapproved rejection stays provisional instead of reading as zero", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "open", { Feedback: "고쳐라" }),
        at("2026-01-01T02:00:00Z", "ARTIFACT_UPDATED", "open"),
      ]),
    );
    expect(r.stages[0]?.settled).toBe(false);
    expect(r.stages[0]?.reworkSec).toBe(7200); // measured to its last event so far
    expect(r.provisional).toBe(true);
  });

  test("a clean run reports no rework stages", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", "x"),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "x"),
      ]),
    );
    expect(r.stages).toEqual([]);
    expect(r.reworkSec).toBe(0);
    expect(r.rejected).toBe(0);
    expect(r.approved).toBe(1);
  });
});
