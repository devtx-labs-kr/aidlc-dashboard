// Unit tests for the scan layer's format contracts. Each parser is exercised from
// a string where possible, so a format change fails here rather than silently
// producing a plausible-but-wrong number on the page.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAuditShard, parseContext } from "../scan/audit";
import type { AuditEvent } from "../scan/audit";
import { parseDeferralSections, readDeferrals, resolveOwner } from "../scan/deferrals";
import { parseDrops } from "../scan/hooks-health";
import {
  type BoltDag,
  type LifecycleEvent,
  buildConstructionMatrix,
  parseBoltDag,
  readUnitLifecycle,
} from "../scan/matrix";
import { parseDiary, readDiaries } from "../scan/memory-diary";
import { type StageInfo, parseUnitProgress } from "../scan/parser";
import { parseQuestions } from "../scan/questions";
import { buildRework } from "../scan/rework";
import { parseSensorDetail, readSensorReport } from "../scan/sensors";
import {
  type CatalogStage,
  expectedArtifacts,
  requiredArtifacts,
  vacuouslyCovered,
} from "../scan/stage-catalog";
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

  test("a direct `Unit` field beats Context, and works with no Context at all", () => {
    // UNIT_* rows carry `Timestamp, Stage, Unit, Run floor` and NO Context, so reading
    // only Context left event.unit undefined on exactly the events that say which unit
    // finished — which is also what the completion receipts are.
    const ev = parseAuditShard(
      `## Unit Complete
**Timestamp**: 2026-01-01T00:00:00Z
**Event**: UNIT_COMPLETED
**Stage**: code-generation
**Unit**: api

---
`,
      "s.md",
    );
    expect(ev[0]?.unit).toBe("api");
    expect(ev[0]?.stage).toBe("code-generation");
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
    // `for_each: "unit-of-work"` is what makes a stage per-unit — the matrix reads this
    // now rather than a hardcoded slug list, so a fixture without it is not per-unit.
    forEach: "unit-of-work",
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

  test("optional_produces is NOT required — the engine does not check it either", () => {
    // `unitCovered` in aidlc-orchestrate.ts: "node.optional_produces entries are
    // DELIBERATELY not checked here ... their absence never blocks coverage." Unioning
    // them made a ui unit that wrote everything required read `partial`.
    expect(requiredArtifacts(stage, "ui")).toEqual(["business-logic-model"]);
    expect(expectedArtifacts(stage, "ui")).toEqual(["business-logic-model", "frontend-components"]);
    expect(requiredArtifacts(stage, "library")).toEqual(["business-logic-model", "business-rules"]);
  });

  test("vacuously covered mirrors the engine's two-step, unfiltered guard first", () => {
    // A kind no REQUIRED artifact applies to is n/a...
    const uiOnly: CatalogStage = {
      ...stage,
      produces: ["business-rules"],
      optionalProduces: [],
      producesKinds: { "business-rules": ["service"] },
    };
    expect(vacuouslyCovered(uiOnly, "ui")).toBe(true);
    expect(vacuouslyCovered(uiOnly, "service")).toBe(false);
    // ...but a stage declaring NO required artifact at all can never be proven covered,
    // so it is not n/a either — it is unknown.
    expect(vacuouslyCovered({ ...stage, produces: [] }, "ui")).toBe(false);
  });
});

describe("unit progress table", () => {
  const TABLE = `## Unit Progress

| unit | owner | functional-design | code-generation | gate | merged |
| --- | --- | --- | --- | --- | --- |
| api | jiho | [x] | [-] | [?] | no |
| web | - | [x] | [x] | [x] | yes |

## Current Status
`;

  test("reads columns by HEADER, so an added merged column does not shift anything", () => {
    const up = parseUnitProgress(TABLE)!;
    expect(up.stageColumns).toEqual(["functional-design", "code-generation"]);
    expect(up.rows[0]).toEqual({
      unit: "api",
      owner: "jiho",
      stages: { "functional-design": "done", "code-generation": "active" },
      gate: "awaiting",
      merged: "no",
    });
    expect(up.rows[1]?.owner).toBe("-"); // verbatim; the engine means "unclaimed"
  });

  test("absent section is undefined, not an empty table", () => {
    expect(
      parseUnitProgress("## Stage Progress\n- [x] intent-capture — EXECUTE\n"),
    ).toBeUndefined();
  });

  test("the engine's two header guards are the ones enforced", () => {
    // aidlc-state.ts refuses when header[0] !== "unit" or the separator width differs.
    expect(parseUnitProgress("## Unit Progress\n\n| x | y |\n| --- | --- |\n")?.malformed).toBe(
      true,
    );
    expect(parseUnitProgress("## Unit Progress\n\n| unit | gate |\n| --- |\n")?.malformed).toBe(
      true,
    );
    expect(parseUnitProgress("## Unit Progress\n\nprose only\n")?.malformed).toBe(true);
    // The engine uses `line.startsWith("|")` with NO trim, so an indented table is one it
    // refuses — accepting it here would label a rejected table "authoritative".
    expect(
      parseUnitProgress("## Unit Progress\n\n  | unit | gate |\n  | --- | --- |\n  | api | [x] |\n")
        ?.malformed,
    ).toBe(true);
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
          forEach: "unit-of-work",
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

  test("a cell missing ONLY a conditional artifact is complete, not partial", () => {
    const withOptional = {
      ...catalog,
      bySlug: new Map(catalog.bySlug).set("code-generation", {
        ...catalog.bySlug.get("code-generation")!,
        optionalProduces: ["frontend-components"],
        producesKinds: { "frontend-components": ["ui"] },
      }),
    };
    // PU-B is `ui`, so frontend-components is in its contract — but conditionally.
    const mx = buildConstructionMatrix(
      dag,
      stages,
      () => ["code-generation-plan", "code-summary"],
      withOptional,
    )!;
    const ui = mx.stages[0]!.cells[1]!;
    expect(ui.state).toBe("complete");
    expect(ui.missing).toEqual([]);
    // The contract is still shown in full, so the reader sees what MAY be written here.
    expect(ui.expected).toContain("frontend-components");
  });

  test("artifacts met but no receipt is UNSETTLED, not complete", () => {
    // aidlc-orchestrate.ts::unitLedgerFor — "receipts become the completion authority
    // and artifact existence degrades to evidence — a paused or partially-written unit
    // has artifacts but no receipt and stays uncovered (issue: artifact presence was
    // mistaken for completion)."
    const all = () => ["code-generation-plan", "code-summary"];
    // Rows must carry the current `Run floor`, or the engine (and this reader) cannot place
    // them in the current attempt — a ledger without the field reads `unverified`, not ▩.
    const f = { "Run floor": "unstarted#0" };
    const lifecycle = readUnitLifecycle([
      { event: "UNIT_STARTED", stage: "code-generation", unit: "PU-A", fields: f },
      { event: "UNIT_COMPLETED", stage: "code-generation", unit: "PU-A", fields: f },
      { event: "UNIT_PAUSED", stage: "code-generation", unit: "PU-B", fields: f },
    ]);
    const mx = buildConstructionMatrix(dag, stages, all, catalog, lifecycle)!;
    const row = mx.stages[0]!;
    expect(row.cells.map((c) => c.state)).toEqual(["complete", "unsettled"]);
    expect(row.complete).toBe(1);
    expect(row.unsettled).toBe(1);
    // Nothing is MISSING — that is exactly why this is not `partial`.
    expect(row.cells[1]!.missing).toEqual([]);
  });

  test("a later non-completion event REVOKES the receipt", () => {
    // aidlc-lib.ts::unitLifecycleSnapshot, verbatim:
    //   if (row.event !== "UNIT_COMPLETED") { receipts.delete(row.unit);
    // A set that only ever grew read `UNIT_COMPLETED → UNIT_PAUSED` as settled, which is
    // exactly the state the engine calls uncovered.
    const all = () => ["code-generation-plan", "code-summary"];
    const f = { "Run floor": "unstarted#0" };
    for (const later of ["UNIT_PAUSED", "UNIT_STARTED", "UNIT_RESUMED"]) {
      const lc = readUnitLifecycle([
        { event: "UNIT_COMPLETED", stage: "code-generation", unit: "PU-A", fields: f },
        { event: later, stage: "code-generation", unit: "PU-A", fields: f },
      ]);
      expect({ later, state: lc.state("PU-A", "code-generation").state }).toEqual({
        later,
        state: "unsettled",
      });
      const mx = buildConstructionMatrix(dag, stages, all, catalog, lc)!;
      expect(mx.stages[0]!.cells[0]!.state).toBe("unsettled");
    }
    // And a re-completion after the pause settles it again — order decides, not presence.
    const reopened = readUnitLifecycle(
      ["UNIT_COMPLETED", "UNIT_PAUSED", "UNIT_RESUMED", "UNIT_COMPLETED"].map((event) => ({
        event,
        stage: "code-generation",
        unit: "PU-A",
        fields: f,
      })),
    );
    expect(reopened.state("PU-A", "code-generation").state).toBe("settled");
  });

  describe("unit receipts", () => {
    const S = "code-generation";
    const T = "2026-01-01T00:00:00Z";
    const FLOOR = `STAGE_STARTED:${T}#1`;
    const E = (event: string, ts: string, o: Partial<LifecycleEvent> = {}): LifecycleEvent => ({
      event,
      ts,
      stage: S,
      shard: "a.md",
      fields: {},
      ...o,
    });
    /** A UNIT_* row on the CURRENT attempt: the engine requires an exact `Run floor` match. */
    const U = (event: string, ts: string, o: Partial<LifecycleEvent> = {}): LifecycleEvent =>
      E(event, ts, { ...o, fields: { "Run floor": FLOOR, ...(o.fields ?? {}) } });
    const st = (evs: LifecycleEvent[], unit = "api", opts = {}) =>
      readUnitLifecycle(evs, opts).state(unit, S).state;
    /** Why a cell is unverifiable — only `no-run-floor` has a known engine verdict. */
    const why = (evs: LifecycleEvent[], unit = "api", opts = {}) =>
      readUnitLifecycle(evs, opts).state(unit, S).reason;

    test("the `Run floor` FIELD is compared exactly, not just 'after the last boundary'", () => {
      // `if (auditBlockField(row.block, "Run floor") !== floorFor(unit)) continue;` — the
      // engine rebuilds `<event>:<timestamp>#<ordinal>` and demands an exact match. Asking
      // only "is this row later than the boundary?" accepted a stale floor outright.
      expect(
        st([E("STAGE_STARTED", T), U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" })]),
      ).toBe("settled");
      expect(
        st([
          E("STAGE_STARTED", T),
          E("UNIT_COMPLETED", "2026-01-01T01:00:00Z", {
            unit: "api",
            fields: { "Run floor": "STAGE_STARTED:1999-01-01T00:00:00Z#1" },
          }),
        ]),
      ).toBe("unsettled");
      // The ordinal counts occurrences of the event name, so a second STAGE_STARTED in the
      // same second is a different floor — invisible to a timestamp comparison.
      expect(
        st([E("STAGE_STARTED", T), E("STAGE_STARTED", T), U("UNIT_COMPLETED", T, { unit: "api" })]),
      ).toBe("unsettled");
      expect(
        st([
          E("STAGE_STARTED", T),
          E("STAGE_STARTED", T),
          E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": `STAGE_STARTED:${T}#2` } }),
        ]),
      ).toBe("settled");
      // No boundary at all → the engine's `unstarted#0` sentinel.
      expect(
        st([E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": "unstarted#0" } })]),
      ).toBe("settled");
    });

    test("each unverifiable cause is carried, because they disagree on the ENGINE's verdict", () => {
      // Only `no-run-floor` has a known engine answer — the exact-match test fails, so the
      // engine re-fans the unit. The other three could settle or not, and neither is
      // derivable here. One blanket "cannot check — not incomplete" label was wrong for the
      // first case, which is why the cause travels with the cell.
      const noFloor = [
        E("STAGE_STARTED", T),
        E("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
      ];
      expect(st(noFloor)).toBe("unverifiable");
      expect(why(noFloor)).toBe("no-run-floor");

      expect(
        why([E("STAGE_STARTED", T), U("UNIT_COMPLETED", T, { unit: "api" })], "api", {
          teamOwnership: true,
        }),
      ).toBe("team-claim");

      expect(
        why([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", T, { unit: "api", fields: { Mode: "wave" } }),
        ]),
      ).toBe("wave-fingerprint");

      // Two shards writing a boundary in the same second → the engine's `AMBIGUOUS:` floor.
      expect(
        why([
          E("STAGE_STARTED", T, { shard: "a.md" }),
          E("STAGE_STARTED", T, { shard: "b.md" }),
          U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
        ]),
      ).toBe("ambiguous-floor");

      // A settled cell carries no reason at all.
      expect(
        why([E("STAGE_STARTED", T), U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" })]),
      ).toBeUndefined();
    });

    test("cross-shard rows in one second reduce by the engine's safety rank", () => {
      // rank PAUSED(2) > STARTED/RESUMED(1) > COMPLETED(0), highest wins: "a possible pause
      // blocks all progress … only unanimous terminal candidates settle it". Both orderings
      // are asserted — a one-direction fixture passed by luck of the ordering.
      const pair = (first: string, second: string) => [
        E("STAGE_STARTED", T),
        U(first, "2026-01-01T01:00:00Z", { unit: "api", shard: "a.md" }),
        U(second, "2026-01-01T01:00:00Z", { unit: "api", shard: "b.md" }),
      ];
      expect(st(pair("UNIT_PAUSED", "UNIT_COMPLETED"))).toBe("unsettled");
      expect(st(pair("UNIT_COMPLETED", "UNIT_PAUSED"))).toBe("unsettled");
      expect(st(pair("UNIT_COMPLETED", "UNIT_COMPLETED"))).toBe("settled");
    });

    test("wave mode is judged on THIS attempt's rows only", () => {
      // Checking it before the floor filter let one old wave row block every later attempt
      // for good. The engine filters to the current floor first.
      expect(
        st([
          E("UNIT_COMPLETED", T, {
            unit: "api",
            fields: { Mode: "wave", "Run floor": "unstarted#0" },
          }),
          E("STAGE_STARTED", "2026-01-02T00:00:00Z"),
          E("UNIT_COMPLETED", "2026-01-03T00:00:00Z", {
            unit: "api",
            fields: { "Run floor": "STAGE_STARTED:2026-01-02T00:00:00Z#1" },
          }),
        ]),
      ).toBe("settled");
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", T, { unit: "api", fields: { Mode: "wave" } }),
        ]),
      ).toBe("unverifiable");
    });

    test("team ownership is unverifiable — the claim FILE decides, not the audit", () => {
      // `eventMatchesClaimAttempt` compares the row's `Attempt Generation` with the claim
      // file's: with an active stamp a MISSING field is a mismatch and a matching value is a
      // pass. Neither verdict is derivable here, so both must not be guessed. Reporting
      // "gen present → false, gen absent → true" was wrong in both directions at once.
      for (const fields of [{}, { "Attempt Generation": "3" }] as Record<string, string>[]) {
        expect(
          st([E("STAGE_STARTED", T), U("UNIT_COMPLETED", T, { unit: "api", fields })], "api", {
            teamOwnership: true,
          }),
        ).toBe("unverifiable");
      }
      // Outside team ownership the check is a no-op, so a declared generation changes nothing.
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", T, { unit: "api", fields: { "Attempt Generation": "3" } }),
        ]),
      ).toBe("settled");
    });

    test("a GATE_REJECTED is a boundary only when it matches this stage and unit", () => {
      // `gateRejectionMatchesAttempt`: `Gate Stages` (else `Stage`) must name the slug, and a
      // row carrying `Unit` matches only that unit — with `unit === undefined`, which is what
      // non-team ownership passes, it matches NOTHING. Reading `e.stage === stage` alone let
      // one unit's rejection invalidate another's finished work. Per-unit floor SCOPING
      // (`key = teamOwnership ? unit : ""`) cannot be observed through `state()` while team
      // ownership is unverifiable for the claim-file reason, so what is asserted here is the
      // boundary filter that scoping feeds.
      const withRejection = (fields: Record<string, string>) => [
        E("STAGE_STARTED", T),
        U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "B" }),
        E("GATE_REJECTED", "2026-01-02T00:00:00Z", { fields }),
      ];
      // Names another unit → not this unit's boundary, so B's receipt stands.
      expect(st(withRejection({ Unit: "A", "Gate Stages": S }), "B")).toBe("settled");
      // Names no unit → everyone's boundary, so B's receipt is behind it.
      expect(st(withRejection({ "Gate Stages": S }), "B")).toBe("unsettled");
      // Names another stage → not a boundary at all.
      expect(st(withRejection({ "Gate Stages": "other-stage" }), "B")).toBe("settled");
      // No `Gate Stages` → the engine falls back to the `Stage` field.
      expect(st(withRejection({}), "B")).toBe("unsettled");
    });

    test("unit-major: GATE_REJECTED raises the floor, STAGE_STARTED does not", () => {
      const thenBoundary = (event: string) => [
        E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": "unstarted#0" } }),
        E(event, "2026-01-02T00:00:00Z", { fields: { "Gate Stages": S } }),
      ];
      expect(st(thenBoundary("GATE_REJECTED"), "api", { unitMajor: true })).toBe("unsettled");
      expect(st(thenBoundary("STAGE_STARTED"), "api", { unitMajor: true })).toBe("settled");
      // And a `single-stage:` re-run is not a new attempt outside unit-major either.
      expect(
        st([
          E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": "unstarted#0" } }),
          E("STAGE_STARTED", "2026-01-02T00:00:00Z", {
            fields: { Workflow: "single-stage:code-generation" },
          }),
        ]),
      ).toBe("settled");
    });

    test("order decides: a pause revokes, a re-completion settles again", () => {
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
          U("UNIT_PAUSED", "2026-01-01T02:00:00Z", { unit: "api" }),
        ]),
      ).toBe("unsettled");
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
          U("UNIT_PAUSED", "2026-01-01T02:00:00Z", { unit: "api" }),
          U("UNIT_COMPLETED", "2026-01-01T03:00:00Z", { unit: "api" }),
        ]),
      ).toBe("settled");
    });
  });

  test("a stage with no unit lifecycle stays artifact-driven (the engine's own branch)", () => {
    // "When NOT in use (a genuinely ledger-free legacy flow), coverage stays
    // artifact-driven, so in-flight upgrades do not break."
    const lifecycle = readUnitLifecycle([
      { event: "UNIT_COMPLETED", stage: "some-other-stage", unit: "PU-A" },
    ]);
    const mx = buildConstructionMatrix(
      dag,
      stages,
      () => ["code-generation-plan", "code-summary"],
      catalog,
      lifecycle,
    )!;
    expect(mx.stages[0]!.cells.map((c) => c.state)).toEqual(["complete", "complete"]);
  });

  test("per-unit rows come from for_each, not a hardcoded slug list", () => {
    const notPerUnit = {
      ...catalog,
      bySlug: new Map(catalog.bySlug).set("code-generation", {
        ...catalog.bySlug.get("code-generation")!,
        forEach: undefined,
      }),
    };
    // The catalogue says this stage is not per-unit, so it is not a matrix row — even
    // though its slug is in PER_UNIT_STAGE_SLUGS, which is only the no-catalogue path.
    expect(buildConstructionMatrix(dag, stages, () => [], notPerUnit)).toBeUndefined();
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

  // The four id SHAPES below come from one long real run — see the header comment in
  // scan/questions.ts for the measured counts. The prose carrying them is synthetic;
  // only the shape is under test, and this repository is public.
  test("the id may be bracketed, an F follow-up, or suffixed", () => {
    const qs = parseQuestions(`## [Q1] 컴포넌트 경계를 무엇으로 가르는가

[Answer]: B

## [F2] 서버 플래그 판정은 어느 컴포넌트의 일인가

[Answer]: C

## F1. 판정 대상 6건 중 진입이 차단된 항목이 있으면?

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

  test("a suffix without a hyphen is still an id (`Q6a`, not just `Q6-a`)", () => {
    // Real follow-up heading; requiring the hyphen dropped it and understated the
    // ask count, and a blank one would have been an invisible blocker.
    const qs = parseQuestions("## Q6a. (후속) 다이어그램 대안은?\n\n[Answer]: A — 계속 붙인다\n");
    expect(qs.map((q) => q.heading)).toEqual(["Q6a. (후속) 다이어그램 대안은?"]);
    expect(qs[0]?.kind).toBe("question");
  });

  test("the three id-less gate headings are asks, and a blank one is a blocker", () => {
    // `stage-protocol.md`: the run may not proceed while these are blank. The id
    // regex alone reported zero blockers over a hard-stopped run.
    const qs = parseQuestions(`## Consolidated Summary Confirmation

- Looks correct
- Request changes

[Answer]:

## Assumption Confirmation

[Answer]: A. Accept assumptions

## Requested Changes Feedback

[Answer]: 판정 표를 먼저 확정해 주세요
`);
    expect(qs.map((q) => [q.heading, q.kind, q.answered])).toEqual([
      ["Consolidated Summary Confirmation", "confirmation", false],
      ["Assumption Confirmation", "confirmation", true],
      ["Requested Changes Feedback", "confirmation", true],
    ]);
  });

  test("a gate heading still needs an [Answer] marker, and a near-miss title is prose", () => {
    // Same guard as the id path: the marker is what makes a heading an ask.
    expect(parseQuestions("## Assumption Confirmation\n\n확인 절차 설명\n")).toEqual([]);
    expect(parseQuestions("## Assumption Confirmation 재확인\n\n[Answer]: x\n")).toEqual([]);
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

  test("a gate closes on any of the engine's answer receipts, not just HUMAN_TURN", () => {
    // audit-format.md lists all of these as authority-bearing receipts only their
    // owning tool may emit — each one means a human acted. Reading HUMAN_TURN alone
    // left an approved gate, a summary confirmation and an answered question in
    // UNKNOWN; the approval case is the least ambiguous wait the engine produces.
    for (const close of [
      "GATE_APPROVED",
      "GATE_REJECTED",
      "SUMMARY_CONFIRMATION_RECORDED",
      "QUESTION_ANSWERED",
    ]) {
      const g = classifyGaps([
        ev("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL"),
        ev("2026-01-01T01:00:00Z", close),
      ]);
      expect({ close, human: g.humanWaitSec, unknown: g.unknownSec }).toEqual({
        close,
        human: 3600,
        unknown: 0,
      });
    }
  });

  test("a receipt with no gate in front of it is CONVERSATION, not a wait", () => {
    // The gate widening is about what CLOSES a wait. `HUMAN_TURN → HUMAN_TURN` holds
    // both the engine's unaudited chat reply and the human's reading time, and the
    // ledger records no boundary — so it goes to neither side, and to neither of the
    // two compatibility aggregates.
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "HUMAN_TURN"),
      ev("2026-01-01T01:00:00Z", "HUMAN_TURN"),
    ]);
    expect(g.conversationSec).toBe(3600);
    expect(g.humanWaitSec).toBe(0);
    expect(g.unknownSec).toBe(0);
    expect(g.observedSec).toBe(0);
    expect(g.idleSec).toBe(0);
    expect(g.workSec).toBe(0);
  });

  test("conversation has no duration floor, but does need the same clone", () => {
    // No floor: the rule reads the marker, not the clock, so a 3-second exchange is
    // the same phenomenon as a 40-minute one. Before this bucket existed, the 300s
    // cut split one phenomenon across `observed` and `unknown` — 1.77h and 2.95h of
    // it on the measured run.
    const short = classifyGaps([
      ev("2026-01-01T00:00:00Z", "HUMAN_TURN"),
      ev("2026-01-01T00:00:03Z", "HUMAN_TURN"),
    ]);
    expect(short.conversationSec).toBe(3);
    expect(short.observedSec).toBe(0);
    // Two clones' human turns adjacent in the merged ledger are two developers.
    const cross = classifyGaps([
      { ts: "2026-01-01T00:00:00Z", event: "HUMAN_TURN", fields: {}, shard: "a" },
      { ts: "2026-01-01T01:00:00Z", event: "HUMAN_TURN", fields: {}, shard: "b" },
    ]);
    expect(cross.conversationSec).toBe(0);
    expect(cross.unknownSec).toBe(3600);
  });

  test("SESSION_RESUMED closes a gap like SESSION_STARTED does", () => {
    // audit-format.md: "Existing Claude Code session resumed (source=resume)". Its
    // sibling was in the resume set and it was not, so a 40-minute break closed by it
    // went to 미분류 — the one event name where that misfiling is unambiguous.
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "SENSOR_PASSED"),
      ev("2026-01-01T00:40:00Z", "SESSION_RESUMED"),
    ]);
    expect(g.parkedSec).toBe(2400);
    expect(g.inferredParkSec).toBe(2400);
    expect(g.unknownSec).toBe(0);
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
    // A CONVERSATION GAP ON PURPOSE, for the same reason: the bucket-sum assertion
    // below is only a real check of the five-way split if the fixture actually visits
    // every bucket. Without these two human turns it passed while summing four.
    const events = [
      at("2026-01-01T00:00:00Z", "WORKFLOW_STARTED", "a.md"),
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "a.md", { stage: "nfr-design" }),
      at("2026-01-01T00:10:00Z", "HUMAN_TURN", "a.md"),
      at("2026-01-01T00:20:00Z", "HUMAN_TURN", "a.md"),
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
      (g: GapSplit) => g.conversationSec,
      (g: GapSplit) => g.unknownSec,
    ]) {
      expect(pick(muchLater.total)).toBe(pick(atRead.total));
    }
    expect(muchLater.total.conversationSec).toBe(600);
    expect(muchLater.total.unknown.some((u) => u.toEvent === "ANALYSIS_NOW")).toBe(false);
    // The buckets account for the window MINUS the silence, exactly.
    const bucketSum =
      muchLater.total.humanWaitSec +
      muchLater.total.parkedSec +
      muchLater.total.observedSec +
      muchLater.total.conversationSec +
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

describe("deferral ledger", () => {
  const STRUCTURED = `# Requirements

## Functional Requirements

irrelevant

## Assumptions & Open Questions

### Assumptions

- \`[assumption]\` 배포 대상이 하나라는 전제. 확인 절차가 없다.
- 태그가 없는 불릿은 전제가 아니다.

### Open questions

| 항목 | 배정 |
| --- | --- |
| 공통 타입의 자리 | \`functional-design\` |
| 회귀 기준선 | \`build-and-test\` (\`C22\`) |

## Review

- 이 절은 대장 밖이다.
`;

  test("reads the mandated table and only the tagged assumptions", () => {
    const p = parseDeferralSections(STRUCTURED);
    expect(p.sections).toBe(1);
    expect(p.rows).toEqual([
      { item: "공통 타입의 자리", assignment: "`functional-design`" },
      { item: "회귀 기준선", assignment: "`build-and-test` (`C22`)" },
    ]);
    expect(p.assumptions).toEqual(["배포 대상이 하나라는 전제. 확인 절차가 없다."]);
    expect(p.declaredNone).toBe(false);
  });

  test("the header row is not an item — the |---| separator is what admits rows", () => {
    // Without the separator guard the header itself becomes an open item called
    // "항목", which then reads as a permanent unresolved decision on the page.
    const p = parseDeferralSections(STRUCTURED);
    expect(p.rows.map((r) => r.item)).not.toContain("항목");
  });

  test("the LAST cell is the assignment, so a 3-column variant still resolves", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

| 항목 | 무엇이 없어서 못 정하는가 | 배정 |
| --- | --- | --- |
| 격리 경계 | 환경 정보 없음 | \`infrastructure-design\` |
`);
    expect(p.rows).toEqual([{ item: "격리 경계", assignment: "`infrastructure-design`" }]);
  });

  test("a section ends at the next same-level heading", () => {
    const p = parseDeferralSections(STRUCTURED);
    // "이 절은 대장 밖이다." lives under ## Review and must not become an assumption.
    expect(p.assumptions.some((a) => a.includes("대장 밖"))).toBe(false);
  });

  test("flat shape: bullets straight under the H2, no subsections", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

- \`[assumption]\` 한 문장이 두 줄로
  줄바꿈되어도 하나의 전제다.
`);
    expect(p.rows).toEqual([]);
    expect(p.assumptions).toEqual(["한 문장이 두 줄로 줄바꿈되어도 하나의 전제다."]);
  });

  test("`None.` is an explicit nothing-open, distinct from no section at all", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

None.
`);
    expect(p.rows).toEqual([]);
    expect(p.assumptions).toEqual([]);
    expect(p.declaredNone).toBe(true);
    // Both mandated subsections present and both empty still counts as declared.
    const q = parseDeferralSections(`## Assumptions & Open Questions

### Assumptions

None.

### Open questions

None.
`);
    expect(q.declaredNone).toBe(true);
  });

  test("bullet-shape open questions are items — a run may write no table at all", () => {
    // One real run wrote 24 sections and zero table rows, so a table-only read
    // reported "미결 0건" over 15 open questions. A bold `**OQ**`/`**AS**` id and the
    // `### Open questions` heading are both engine-written markers, so both classify.
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Assumptions

- **AS1** 검사가 비동기로 분리 실행되므로 요청 처리 성능을 훼손하지 않는다.
- 태그도 id 도 없는 불릿은 전제가 아니다.

### Open questions

- **OQ1** 다중 선택 묶음을 하나의 논리 요청으로 다시 묶을지 — 이후 설계 [Q2f].
- id 가 없어도 이 절 안이면 미결이다.
`);
    expect(p.rows).toEqual([
      {
        item: "OQ1 다중 선택 묶음을 하나의 논리 요청으로 다시 묶을지 — 이후 설계 [Q2f].",
        assignment: "",
      },
      { item: "id 가 없어도 이 절 안이면 미결이다.", assignment: "" },
    ]);
    expect(p.assumptions).toEqual([
      "AS1 검사가 비동기로 분리 실행되므로 요청 처리 성능을 훼손하지 않는다.",
    ]);
  });

  test("flat `**OQ-xx**` bullets are items, and `[assumption]` still outranks the id", () => {
    // 9 of the flat bullets on that run carried an OQ id and no tag (invisible before);
    // 5 carried both, and those stay assumptions rather than being reclassified.
    const p = parseDeferralSections(`## Assumptions & Open Questions

- **OQ-US1** 판정기의 입력 자료 구조가 확정되지 않았다 [mob: quality].
- **OQ-DM1** 이력 항목의 표시 문자열이 미정이다. \`[assumption]\`
- 산문 불릿은 어느 쪽도 아니다.
`);
    expect(p.rows.map((r) => r.item)).toEqual([
      "OQ-US1 판정기의 입력 자료 구조가 확정되지 않았다 [mob: quality].",
    ]);
    expect(p.assumptions).toEqual(["**OQ-DM1** 이력 항목의 표시 문자열이 미정이다."]);
  });

  test("a `- None.` bullet is still a declaration of emptiness, not an item", () => {
    // Admitting it as a row invents a decision named "None." AND makes the section
    // non-empty, which suppresses the very declaration the engine was making.
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

- None.
`);
    expect(p.rows).toEqual([]);
    expect(p.declaredNone).toBe(true);
  });

  test("a ledger id needs a digit — bold prose starting with AS/OQ is not an entry", () => {
    // `(OQ|AS)[-.A-Za-z0-9]*` case-insensitively swallowed ordinary bold-led prose
    // and invented one assumption per bullet. The engine numbers its ids.
    const p = parseDeferralSections(`## Assumptions & Open Questions

- **ASSUMPTIONS** 아래 목록은 참고용이다.
- **AS-IS** 흐름은 그대로 둔다.
- **Asset** 목록은 별도 문서에 있다.
`);
    expect(p.rows).toEqual([]);
    expect(p.assumptions).toEqual([]);
  });

  test("a no-owner rollup row carries no stage name — the model invents no label", () => {
    // `(${status})` used to stand in for a missing stage and reached the screen as a
    // row called `(unassigned)`, a raw enum name in a Korean UI. The scan layer must
    // not build display strings; the render layer owns the Korean labels.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dfr-"));
    const stage = path.join(root, "inception", "requirements-analysis");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(
      path.join(stage, "requirements.md"),
      `## Assumptions & Open Questions

### Open questions

| 항목 | 배정 |
| --- | --- |
| 오너가 있는 항목 | \`code-generation\` |
| 오너가 없는 항목 | 이후 설계에서 정한다 |
`,
    );
    try {
      const r = readDeferrals(root, {
        stageStatuses: new Map([["code-generation", ["active"] as StageInfo["status"][]]]),
      });
      expect(r.byOwner).toEqual([
        { stage: "code-generation", status: "current", count: 1 },
        { stage: undefined, status: "unassigned", count: 1 },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nested bullet is detail, not a separate decision", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

- 인증 수단을 무엇으로 할지.
  - fakeLogin 은 후보에서 제외
  - 서비스 계정은 검토 중
`);
    expect(p.rows.map((r) => r.item)).toEqual(["인증 수단을 무엇으로 할지."]);
  });

  test("an ordered list is a list — the marker is not part of the contract", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

1. 첫 미결.
2) 둘째 미결.
`);
    expect(p.rows.map((r) => r.item)).toEqual(["첫 미결.", "둘째 미결."]);
  });

  test("a table under ### Assumptions contributes no items", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Assumptions

| 전제 | 근거 |
| --- | --- |
| 하나 | 없음 |
`);
    expect(p.rows).toEqual([]);
  });

  describe("owner resolution", () => {
    const statuses = (m: Record<string, StageInfo["status"][]>) => new Map(Object.entries(m));
    const catalog = new Set(["functional-design", "code-generation", "build-and-test", "operate"]);

    test("every occurrence done or skipped → passed", () => {
      const r = resolveOwner(
        "`functional-design`",
        statuses({ "functional-design": ["done", "skipped"] }),
        catalog,
      );
      expect(r).toEqual({ ownerStage: "functional-design", ownerStatus: "passed" });
    });

    test("any occurrence in flight → current, even beside a finished copy", () => {
      // A Construction slug repeats once per unit; one unit still working means the
      // question can still be asked, which is the safe direction to err in.
      const r = resolveOwner(
        "`code-generation`",
        statuses({ "code-generation": ["done", "active"] }),
        catalog,
      );
      expect(r).toEqual({ ownerStage: "code-generation", ownerStatus: "current" });
    });

    test("not started → ahead", () => {
      expect(
        resolveOwner("`build-and-test`", statuses({ "build-and-test": ["pending"] }), catalog),
      ).toEqual({ ownerStage: "build-and-test", ownerStatus: "ahead" });
    });

    test("in the catalogue but not in this run → outOfScope", () => {
      expect(resolveOwner("`build-and-test` (`C22`)", statuses({}), catalog)).toEqual({
        ownerStage: "build-and-test",
        ownerStatus: "outOfScope",
      });
    });

    test("a registry id is NOT a stage — never invent one", () => {
      // `NEW-...`, `P-1`, `[F5]`, `C22` are all registry ids that appear in real
      // 배정 cells. Only a slug the run or the catalogue knows becomes an owner.
      for (const cell of ["`NEW-헤더-목록`", "`P-1`·`P-2`", "`[F5]`", "`C22`", "외부 팀"]) {
        expect(resolveOwner(cell, statuses({ "code-generation": ["active"] }), catalog)).toEqual({
          ownerStatus: "unassigned",
        });
      }
    });

    test("explicitly pushed past this run → nextCycle", () => {
      for (const cell of ["다음 차수", "이후 차수 (`NEW-x`)", "next cycle"]) {
        expect(resolveOwner(cell, statuses({}), catalog).ownerStatus).toBe("nextCycle");
      }
    });

    test("without a catalogue an out-of-scope stage degrades to unassigned, not to a guess", () => {
      expect(resolveOwner("`build-and-test`", statuses({}), undefined)).toEqual({
        ownerStatus: "unassigned",
      });
    });
  });
});
