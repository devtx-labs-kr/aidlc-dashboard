// End-to-end tests against the checked-in synthetic workspace under
// fixtures/reference/. These assert the whole pipeline — resolve → scan →
// assemble → render — on a tree small enough to reason about by hand.
//
// The fixture deliberately encodes the situations that were hard to get right on
// a real run: a stale runtime-graph, a per-unit segment stopped mid-contract, an
// unanswered question, two audit shards, and both Context shapes.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UsageError, expandHome, parseArgs } from "../cli";
import { NoRunError, assemble } from "../model/assemble";
import { renderBody, renderPage } from "../render/page";
import { renderPicker } from "../render/picker";
import { listStageArtifacts } from "../scan/artifacts";
import { browse, resolveWorkspace } from "../scan/browse";
import { openArtifact } from "../scan/open-file";
import { findHarnessDir } from "../scan/stage-catalog";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");

describe("assemble on the fixture workspace", () => {
  const m = assemble(FIXTURE);

  test("resolves the active intent through the cursors", () => {
    expect(m.identity.space).toBe("default");
    expect(m.identity.record).toBe("260101-demo-migration");
    expect(m.identity.slug).toBe("demo-migration"); // from intents.json
    expect(m.identity.status).toBe("in-flight");
  });

  test("reads state.md progress", () => {
    expect(m.state.lifecyclePhase).toBe("CONSTRUCTION");
    expect(m.state.currentStage).toBe("code-generation");
    expect(m.state.overallDone).toBe(4);
    expect(m.state.overallTotal).toBe(5);
    expect(m.state.overallPct).toBe(80);
    expect(m.state.revisionCount).toBe("2");
  });

  test("phase roll-up matches the checkbox grid", () => {
    const byKey = new Map(m.state.phases.map((p) => [p.key, p]));
    expect(byKey.get("construction")?.done).toBe(1); // functional-design only
    expect(byKey.get("construction")?.total).toBe(2); // infra-design is SKIP
    expect(byKey.get("operation")?.skipped).toBe(true);
  });

  test("merges BOTH audit shards in time order", () => {
    const shards = new Set(m.recentEvents.map((e) => e.shard));
    expect(shards.size).toBe(2);
    expect(m.totalEvents).toBe(33); // 30 in the main shard + 3 in the second
    // The second shard's events are later, so they sort last overall.
    expect(m.recentEvents[0]?.ts).toBe("2026-01-02T09:58:00Z");
  });

  test("attributes both Context shapes correctly", () => {
    // Per-unit write: unit in slot 1, stage in slot 2.
    const perUnit = m.recentEvents.find(
      (e) => e.unit === "PU-A-core" && e.event === "ARTIFACT_CREATED",
    );
    expect(perUnit?.stage).toBe("code-generation");
    // Ordinary write: stage in slot 1, no unit.
    const plain = m.recentEvents.find(
      (e) => e.stage === "intent-capture" && e.event === "ARTIFACT_CREATED",
    );
    expect(plain?.unit).toBeUndefined();
  });

  test("three-state matrix separates started from finished", () => {
    const cg = m.matrix?.stages.find((s) => s.slug === "code-generation")!;
    expect(m.matrix?.contractAware).toBe(true);
    expect(cg.complete).toBe(1); // PU-A-core: plan + summary
    expect(cg.partial).toBe(1); // PU-B-ui: plan only, summary missing
    const partial = cg.cells.find((c) => c.state === "partial")!;
    expect(partial.unit).toBe("PU-B-ui");
    expect(partial.missing).toEqual(["code-summary"]);
  });

  test("kind-scoped expectations hold per unit", () => {
    const fd = m.matrix?.stages.find((s) => s.slug === "functional-design")!;
    // library gets business-rules, ui gets frontend-components — both complete.
    expect(fd.complete).toBe(2);
    expect(fd.partial).toBe(0);
  });

  test("skipped stage keeps a row with no cells", () => {
    const infra = m.matrix?.stages.find((s) => s.slug === "infrastructure-design")!;
    expect(infra.execute).toBe(false);
    expect(infra.cells).toEqual([]);
    expect(infra.total).toBe(0);
  });

  test("bolt batches carry the topological order", () => {
    expect(m.matrix?.batches).toEqual([["PU-A-core"], ["PU-B-ui"]]);
  });

  test("finds the unanswered question and marks it current-stage", () => {
    expect(m.blockers.length).toBe(1);
    const b = m.blockers[0]!;
    expect(b.unit).toBe("PU-B-ui");
    expect(b.stage).toBe("code-generation");
    expect(b.isCurrentStage).toBe(true);
    expect(b.heading).toContain("Q1");
  });

  test("sensor counts come from the audit, bodies from disk", () => {
    expect(m.sensors.totalFired).toBe(3);
    expect(m.sensors.totalPassed).toBe(2);
    expect(m.sensors.totalFailed).toBe(1);
    expect(m.sensors.orphanDetailFiles).toBe(0);
    const f = m.sensors.failures[0]!;
    expect(f.id).toBe("type-check");
    expect(f.errors.length).toBe(2);
    expect(f.errors[0]?.message).toContain("not assignable");
  });

  test("sensor, gate, and hook health data stay diagnostic without dedicated cards", () => {
    const html = renderBody(m);
    expect(html).not.toContain("<h2>Sensor");
    expect(html).not.toContain('id="sensors"');
    expect(html).not.toContain("not assignable");
    expect(html).not.toContain("<h2>승인 게이트</h2>");
    expect(html).not.toContain("Revision 은 게이트 반려");
    expect(html).not.toContain("<h2>Hook 헬스</h2>");
    expect(html).not.toContain('id="health"');
  });

  test("gate ledger spans both shards", () => {
    expect(m.gates.approved).toBe(2);
    expect(m.gates.rejected).toBe(1); // only in the second shard
    expect(m.gates.revisionCount).toBe(2);
  });

  test("diary counts every axis", () => {
    expect(m.diaries.totals.interpretations).toBe(3);
    expect(m.diaries.totals.deviations).toBe(1);
    expect(m.diaries.totals.openQuestions).toBe(2);
    expect(m.diaries.records.length).toBe(6);
  });

  test("hook health reads heartbeats, drops and the stop guard", () => {
    // 7 distinct hooks: 6 with a .last, plus kiro-adapter which only has .drops.
    // `stop` has both files and must not be counted twice.
    expect(m.health.hooks.length).toBe(7);
    const stop = m.health.hooks.find((h) => h.name === "stop")!;
    expect(stop.drops).toBe(2);
    expect(stop.topDropReasons[0]?.count).toBe(2);
    const adapter = m.health.hooks.find((h) => h.name === "kiro-adapter")!;
    expect(adapter.lastFired).toBeUndefined(); // dropped but never fired
    expect(adapter.degradedDrops).toBe(1);
    expect(m.health.stopGuard).toEqual({ signature: "code-generation::19", count: 1 });
  });

  test("treats the 2-shard fixture as parallel and reports both time axes", () => {
    // The fixture has a main shard plus a short second-clone shard.
    expect(m.timing.parallel).toBe(true);
    expect(m.timing.workers.length).toBe(2);
    // Person-time is the sum of the shards' own spans, so it differs from the
    // team wall-clock whenever the shards do not cover the same window.
    expect(m.timing.personElapsedSec).not.toBe(m.timing.elapsedSec);
    expect(m.timing.parallelism).toBeDefined();
    // Only the busier shard drove gates.
    expect(m.timing.workers[0]?.gatesApproved).toBe(2);
    expect(m.timing.workers[1]?.gatesApproved).toBe(0);
  });

  test("merged and per-worker idle measure DIFFERENT things, either can be larger", () => {
    // Both directions are real, so neither may be asserted as a bound:
    //  - merged is smaller when clones overlap (another's events fill a wait);
    //  - merged is LARGER at a handoff (A ends, B starts 45 min later — a team-wide
    //    pause that belongs to no single shard's timeline).
    // The fixture is the handoff case, so here merged > per-worker.
    expect(m.timing.total.idleSec).toBeGreaterThan(m.timing.personIdleSec);
    // What must always hold: per-worker figures never exceed their own span.
    for (const w of m.timing.workers) {
      expect(w.idleSec + w.workSec).toBeLessThanOrEqual(w.elapsedSec + 1);
    }
  });

  test("timing spans every entered stage, including the in-flight one", () => {
    const slugs = m.timing.stages.map((s) => s.stage);
    expect(slugs).toContain("code-generation");
    const cg = m.timing.stages.find((s) => s.stage === "code-generation")!;
    expect(cg.endKind).toBe("in-flight");
    // Zero-second bootstrap stages must still be counted as completed.
    const scaffold = m.timing.stages.find((s) => s.stage === "workspace-scaffold")!;
    expect(scaffold.elapsedSec).toBe(0);
    expect(scaffold.endKind).toBe("completed");
  });

  test("intent-capture's 1h gate wait lands in IDLE, not WORK", () => {
    const ic = m.timing.stages.find((s) => s.stage === "intent-capture")!;
    expect(ic.idleSec).toBe(3600);
  });

  test("flags the stale runtime-graph and quantifies the drift", () => {
    const g = m.provenance["runtime-graph"];
    expect(g.stale).toBe(true);
    expect(g.staleReason).toContain("뒤처짐");
    // The graph holds 1 firing; the audit holds 3 → 2 missing.
    expect(g.staleReason).toContain("2건");
  });

  test("does NOT flag state.md merely for lagging the audit", () => {
    expect(m.provenance["state.md"].stale).toBe(false);
    expect(m.provenance["stage-graph"].stale).toBe(false);
    expect(m.provenance.audit.stale).toBe(false);
  });

  test("no warnings on a complete fixture", () => {
    expect(m.warnings).toEqual([]);
  });
});

describe("render", () => {
  const m = assemble(FIXTURE);

  test("page is self-contained and leaks no placeholders", () => {
    const html = renderPage(m, 10_000);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("[object Object]");
  });

  test("surfaces the blocker and the partial cell, with the provenance badge removed", () => {
    const body = renderBody(m);
    expect(body).toContain('class="col primary-col"');
    expect(body).toContain('class="col secondary-col"');
    expect(body).not.toContain('class="full"');
    expect(body).toContain("PU-B-ui");
    expect(body).toContain("code-summary");
    // 회귀 검증: 출처 배지/팝업은 화면에서 완전히 사라져야 한다 (stale·fresh 모두).
    expect(body).not.toContain("prov stale");
    expect(body).not.toContain('class="prov"');
    expect(body).toContain("c-partial");
  });

  test("places decisions below credit and overview cards above timing", () => {
    const body = renderBody(m);
    const primaryStart = body.indexOf('<div class="col primary-col">');
    const secondaryStart = body.indexOf('<div class="col secondary-col">');
    const primary = body.slice(primaryStart, secondaryStart);
    const secondary = body.slice(secondaryStart);

    expect(primary.indexOf('id="credit"')).toBeLessThan(primary.indexOf('id="decisions"'));
    expect(primary).not.toContain(">진행 개요</h2>");

    const overview = secondary.indexOf(">진행 개요</h2>");
    const phases = secondary.indexOf(">Phase · Stage</h2>");
    const matrix = secondary.indexOf('id="matrix"');
    const timeline = secondary.indexOf('id="timeline"');
    expect(overview).toBeLessThan(phases);
    expect(phases).toBeLessThan(matrix);
    expect(matrix).toBeLessThan(timeline);
    expect(secondary).not.toContain('id="decisions"');
  });

  test("turns the stage diary into actionable decisions and issues", () => {
    const body = renderBody(m);
    expect(body).toContain("결정과 이슈");
    expect(body).toContain("후속 확인 후보");
    expect(body).toContain("최근 결정");
    expect(body).toContain("최근 계획 변경");
    expect(body).toContain("Stage별 전체 기록");
    expect(body).toContain('class="pill mute has-help"');
    expect(body).toContain('title="모호한 요구나 지시를 어떤 의미로 이해했는지 기록한 항목"');
    expect(body).toContain('title="실행 중 원래 계획에서 달라진 내용과 그 이유를 기록한 항목"');
    expect(body).toContain('title="아직 확인하거나 결정해야 할 작업이 남은 항목"');
    expect(body).not.toContain(">Stage 일지<");
  });

  test("escapes HTML from run content (credit warning)", () => {
    // Re-anchored (team.md ## Testing Posture): the removed top blocker card is
    // replaced by the credit view, which now sits at the top and carries the ONE
    // non-contract external text this dashboard shows — kiro-cli /usage output
    // (warning.raw / warning.reason). Hostile markup there must be escaped by
    // renderBody just as the blocker heading used to be.
    const hostile = {
      ...m,
      credit: {
        ...m.credit,
        status: "failure" as const,
        warning: {
          raw: '<script>alert("x")</script>',
          reason: '<img src=x onerror="alert(1)">',
        },
      },
    };
    const body = renderBody(hostile as typeof m);
    expect(body).not.toContain("<script>alert");
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;script&gt;");
  });

  test("renders with auto-polling disabled", () => {
    expect(renderPage(m, 0)).toContain("auto-poll disabled");
  });

  test("shows the per-worker table and explains the merged/per-worker split", () => {
    const body = renderBody(m);
    expect(body).toContain("작업자별 분해");
    expect(body).toContain("실효 병렬도");
    expect(body).toContain("팀 벽시계"); // merged KPI relabelled
    expect(body).toContain("팀 단위"); // merged row is labelled as team-wide
    expect(body).toContain("사용자 대기");
    expect(body).toContain("일시중지");
    expect(body).toContain("관측 실행");
    expect(body).toContain("미분류");
    expect(body).toContain("주도"); // the gate-driving clone is flagged
    // The fixture is the handoff case (merged idle > per-worker), so the note
    // must explain THAT direction rather than claiming under-reporting.
    expect(body).toContain("인계 공백");
    expect(body).not.toContain("과소계상");
  });

  test("hides the per-worker table for a single-clone run", () => {
    const solo = {
      ...m,
      timing: { ...m.timing, parallel: false, workers: [m.timing.workers[0]] },
    };
    const body = renderBody(solo as typeof m);
    expect(body).not.toContain("작업자별 분해");
    expect(body).not.toContain("과소계상");
  });
});

describe("degradation", () => {
  test("a tree with no aidlc/ raises NoRunError", () => {
    expect(() => assemble(path.join(import.meta.dir, "does-not-exist"))).toThrow(NoRunError);
  });
});

// The dashboard reads the `aidlc/` docs tree, which is byte-identical across
// harnesses — so it must not care WHICH harness produced the run. These build
// throwaway trees that rename the harness dir and assert the model is unchanged.
describe("harness-agnostic", () => {
  /** Copy the fixture into a temp dir, renaming its harness dir. */
  function treeWithHarness(harness: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dash-"));
    fs.cpSync(path.join(FIXTURE, "aidlc"), path.join(dir, "aidlc"), { recursive: true });
    if (harness) {
      fs.cpSync(path.join(FIXTURE, ".kiro"), path.join(dir, harness), { recursive: true });
    }
    return dir;
  }

  const baseline = assemble(FIXTURE);

  for (const harness of [".kiro", ".claude", ".aidlc", ".futureharness"]) {
    test(`discovers the catalogue in ${harness} and reads identically`, () => {
      const dir = treeWithHarness(harness);
      try {
        const m = assemble(dir);
        expect(m.identity.harnessDir).toBe(harness);
        expect(m.warnings).toEqual([]);
        // The verdicts that DEPEND on the catalogue must match the baseline.
        expect(m.matrix?.contractAware).toBe(true);
        const cg = m.matrix?.stages.find((s) => s.slug === "code-generation")!;
        expect([cg.complete, cg.partial]).toEqual([1, 1]);
        expect(m.blockers.length).toBe(baseline.blockers.length);
        expect(m.totalEvents).toBe(baseline.totalEvents);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("`.claude` wins the probe order when several harness dirs coexist", () => {
    const dir = treeWithHarness(".kiro");
    try {
      fs.cpSync(path.join(FIXTURE, ".kiro"), path.join(dir, ".claude"), { recursive: true });
      expect(assemble(dir).identity.harnessDir).toBe(".claude");
      // ...and --harness overrides that choice.
      expect(assemble(dir, ".kiro").identity.harnessDir).toBe(".kiro");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aidlc/ ALONE still reports everything except the artifact contract", () => {
    const dir = treeWithHarness(null);
    try {
      const m = assemble(dir);
      expect(m.identity.harnessDir).toBeUndefined();
      // Everything not derived from the catalogue is unaffected.
      expect(m.state.overallPct).toBe(baseline.state.overallPct);
      expect(m.totalEvents).toBe(baseline.totalEvents);
      expect(m.blockers.length).toBe(baseline.blockers.length);
      expect(m.sensors.totalFailed).toBe(baseline.sensors.totalFailed);
      expect(m.timing.stages.length).toBe(baseline.timing.stages.length);
      // The contract-dependent parts degrade LOUDLY, not silently.
      expect(m.matrix?.contractAware).toBe(false);
      expect(m.warnings.length).toBe(1);
      expect(m.warnings[0]).toContain("stage 카탈로그");
      expect(m.provenance["stage-graph"].stale).toBe(true);
      // And the page says so rather than showing a confident matrix.
      expect(renderBody(m)).toContain("계약 판정 불가");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("findHarnessDir returns undefined when no dir carries a catalogue", () => {
    const dir = treeWithHarness(null);
    try {
      fs.mkdirSync(path.join(dir, ".kiro", "tools"), { recursive: true }); // present but empty
      expect(findHarnessDir(dir)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli", () => {
  test("accepts a valid root and applies defaults", () => {
    const o = parseArgs(["--root", FIXTURE]);
    expect(o.port).toBe(4321);
    expect(o.pollMs).toBe(60_000); // unified 1-minute screen poll (BR4.1)
    expect(o.intervalMs).toBe(300_000);
    expect(path.isAbsolute(o.root!)).toBe(true);
  });

  test("overrides port, browser poll, and collection interval", () => {
    const o = parseArgs([
      "--root",
      FIXTURE,
      "--port",
      "9999",
      "--poll",
      "0",
      "--interval",
      "15000",
    ]);
    expect(o.port).toBe(9999);
    expect(o.pollMs).toBe(0);
    expect(o.intervalMs).toBe(15_000);
  });

  test("port/interval env를 지원하고 명시 플래그가 우선한다", () => {
    const env = {
      AIDLC_DASHBOARD_PORT: "5000",
      AIDLC_DASHBOARD_INTERVAL_MS: "45000",
    };
    expect(parseArgs([], env)).toMatchObject({ port: 5000, intervalMs: 45_000 });
    expect(parseArgs(["--port", "6000", "--interval", "90000"], env)).toMatchObject({
      port: 6000,
      intervalMs: 90_000,
    });
  });

  test("무효 env는 기본값으로 폴백하고 --interval 0은 거부한다", () => {
    const env = {
      AIDLC_DASHBOARD_PORT: "nope",
      AIDLC_DASHBOARD_INTERVAL_MS: "0",
    };
    expect(parseArgs([], env)).toMatchObject({ port: 4321, intervalMs: 300_000 });
    expect(() => parseArgs(["--interval", "0"], {})).toThrow(UsageError);
  });

  test("rejects a bad path and a non-workspace when --root IS given", () => {
    expect(() => parseArgs(["--root", "/nope/nope"])).toThrow(UsageError);
    // A real dir that holds no aidlc/ tree.
    expect(() => parseArgs(["--root", import.meta.dir])).toThrow(UsageError);
  });

  test("rejects a non-numeric port and unknown flags", () => {
    expect(() => parseArgs(["--root", FIXTURE, "--port", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["--root", FIXTURE, "--bogus"])).toThrow(UsageError);
  });

  test("--harness is optional, accepted when real, rejected when absent", () => {
    expect(parseArgs(["--root", FIXTURE]).harnessDir).toBeUndefined();
    expect(parseArgs(["--root", FIXTURE, "--harness", ".kiro"]).harnessDir).toBe(".kiro");
    expect(() => parseArgs(["--root", FIXTURE, "--harness", ".nope"])).toThrow(UsageError);
  });

  test("a harness dir is NOT required — only aidlc/ is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-cli-"));
    try {
      fs.mkdirSync(path.join(dir, "aidlc"));
      expect(parseArgs(["--root", dir]).root).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--root is OPTIONAL — omitting it starts the picker instead of failing", () => {
    const o = parseArgs([]);
    expect(o.root).toBeUndefined();
    expect(o.port).toBe(4321);
  });

  test("expands a leading ~ (the picker's text field bypasses the shell)", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/Documents")).toBe(path.join(os.homedir(), "Documents"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("  ~/x  ")).toBe(path.join(os.homedir(), "x")); // trims
  });
});

// The workspace picker combines direct entry, bounded discovery, and a
// cross-platform server-side directory explorer.
describe("folder picker", () => {
  test("flags the workspace among sibling dirs and sorts it first", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pick-"));
    try {
      fs.mkdirSync(path.join(parent, "zzz-plain"));
      fs.mkdirSync(path.join(parent, "aaa-plain"));
      const ws = path.join(parent, "mmm-workspace");
      fs.mkdirSync(path.join(ws, "aidlc"), { recursive: true });

      const b = browse(parent);
      expect(b.dir).toBe(parent);
      expect(b.entries[0]?.name).toBe("mmm-workspace"); // workspaces first
      expect(b.entries[0]?.isWorkspace).toBe(true);
      expect(b.entries.filter((e) => e.isWorkspace).length).toBe(1);
      // ...and the rest keep alphabetical order.
      expect(b.entries.slice(1).map((e) => e.name)).toEqual(["aaa-plain", "zzz-plain"]);
      expect(b.isWorkspace).toBe(false); // the parent itself is not one
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("hides dot-dirs unless asked", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pick-"));
    try {
      fs.mkdirSync(path.join(dir, ".kiro"));
      fs.mkdirSync(path.join(dir, "visible"));
      expect(browse(dir).entries.map((e) => e.name)).toEqual(["visible"]);
      expect(browse(dir, true).entries.map((e) => e.name)).toEqual([".kiro", "visible"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable path falls back to home and reports the error", () => {
    const b = browse("/definitely/not/a/real/path");
    expect(b.error).toBeDefined();
    expect(b.dir).toBe(os.homedir()); // still renders something usable
  });

  test("the filesystem root has no parent link", () => {
    expect(browse("/").parent).toBeUndefined();
  });

  test("resolveWorkspace accepts the workspace OR its aidlc/ dir", () => {
    expect(resolveWorkspace(FIXTURE)).toBe(path.resolve(FIXTURE));
    // Picking the aidlc/ folder itself is the obvious mistake — accept it.
    expect(resolveWorkspace(path.join(FIXTURE, "aidlc"))).toBe(path.resolve(FIXTURE));
  });

  test("resolveWorkspace rejects a non-workspace", () => {
    expect(resolveWorkspace(os.tmpdir())).toBeUndefined();
    expect(resolveWorkspace("/definitely/not/real")).toBeUndefined();
  });

  test("renders the picker with select links and escapes names", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pick-"));
    try {
      const hostile = path.join(parent, "we<ird&name");
      fs.mkdirSync(path.join(hostile, "aidlc"), { recursive: true });
      const html = renderPicker(browse(parent), false);
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain("/select?dir=");
      expect(html).toContain("AI-DLC 워크스페이스");
      expect(html).not.toContain("we<ird&name"); // raw form must not survive
      expect(html).toContain("we&lt;ird&amp;name");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("offers '이 폴더 열기' only when the listed dir IS a workspace", () => {
    // The fixture root holds aidlc/, so listing it offers the shortcut...
    expect(renderPicker(browse(FIXTURE), false)).toContain("이 폴더 열기");
    // ...and its parent, which does not, must not.
    expect(renderPicker(browse(path.dirname(FIXTURE)), false)).not.toContain("이 폴더 열기");
  });

  test("makes folder exploration primary and keeps direct and discovered paths below it", () => {
    const html = renderPicker(browse(FIXTURE), false, undefined, {
      workspaces: [{ name: "reference", path: FIXTURE }],
      searchedRoots: [path.dirname(FIXTURE)],
      scannedDirectories: 12,
      truncated: false,
    });

    expect(html).toContain("1</strong>개 발견");
    expect(html).toContain(`href="/select?dir=${encodeURIComponent(FIXTURE)}"`);
    expect(html.indexOf("폴더 탐색")).toBeLessThan(html.indexOf("경로로 열기"));
    expect(html.indexOf("경로로 열기")).toBeLessThan(html.indexOf("찾은 워크스페이스"));
    expect(html).toContain('aria-label="탐색 루트"');
    expect(html).toContain('aria-label="현재 경로"');
    expect(html).toContain('id="directory-filter"');
    expect(html).toContain('class="directory-viewport"');
    expect(html).toContain("열기&nbsp;›");
    expect(html).not.toContain("<details");
  });

  test("does not prefill a non-workspace browse location as a workspace path", () => {
    const html = renderPicker(browse(path.dirname(FIXTURE)), false);
    expect(html).toContain('value=""');
  });

  test("escapes explorer roots and breadcrumbs and ships local directory filtering", () => {
    const html = renderPicker(browse(FIXTURE), false, undefined, undefined, {
      roots: [
        {
          label: 'bad"><root',
          path: '/tmp/a&b"',
          kind: "volume",
          active: true,
        },
      ],
      breadcrumbs: [
        { label: "/", path: "/", current: false },
        { label: "<project>", path: "/<project>", current: true },
      ],
    });

    expect(html).toContain("bad&quot;&gt;&lt;root");
    expect(html).toContain("&lt;project&gt;");
    expect(html).not.toContain('bad"><root');
    expect(html).toContain('row.dataset.dirName || ""');
    expect(html).toContain('event.key !== "Escape"');
    expect(html).toContain('id="directory-filter-empty"');
  });

  test("spins the rescan icon while workspace discovery is running", () => {
    const html = renderPicker(browse(FIXTURE), false);

    expect(html).toContain('id="rescan-link"');
    expect(html).toContain("@keyframes picker-rescan-spin");
    expect(html).toContain('rescan.classList.add("scanning")');
    expect(html).toContain('rescan.setAttribute("aria-busy", "true")');
    expect(html).toContain("@media (prefers-reduced-motion:reduce)");
  });
});

// The reload control. A change the poll cannot anticipate — a stage flipped
// between SKIP and EXECUTE, a hand-edited state file — must be observable on
// demand, so the page ships a button and the server re-reads on every request.
describe("manual reload", () => {
  test("the page renders a reload button and a single refresh path", () => {
    const html = renderPage(assemble(FIXTURE), 10_000);
    expect(html).toContain('id="reload-btn"');
    expect(html).toContain("function refresh");
    expect(html).toContain("fetch('/api/refresh'");
    expect(html.match(/id="reload-btn"/g)).toHaveLength(1);
    expect(html).toContain("@keyframes reload-spin");
    expect(html).toContain('class="reload-icon"');
    expect(html).toContain("btn.setAttribute('aria-busy', 'true')");
    // Button, timer and tab-focus must all route through the same function so
    // they cannot drift apart.
    expect(html).toContain("refresh(true)");
    expect(html).toContain("refresh(false)");
    expect(html).toContain("visibilitychange");
  });

  test("the reload button survives --poll 0 (auto-refresh off)", () => {
    const html = renderPage(assemble(FIXTURE), 0);
    expect(html).toContain('id="reload-btn"');
    expect(html).toContain("function refresh");
    expect(html).not.toContain("setInterval");
  });

  test("re-assembling picks up a SKIP→EXECUTE edit made after the first read", () => {
    // This is the reported symptom, reproduced at the model layer: flipping the
    // scope marker changes the DENOMINATOR, so a stale page shows a stale %.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-skip-"));
    try {
      fs.cpSync(path.join(FIXTURE, "aidlc"), path.join(dir, "aidlc"), { recursive: true });
      fs.cpSync(path.join(FIXTURE, ".kiro"), path.join(dir, ".kiro"), { recursive: true });
      const statePath = path.join(
        dir,
        "aidlc/spaces/default/intents/260101-demo-migration/aidlc-state.md",
      );

      const before = assemble(dir);
      expect(before.state.overallTotal).toBe(5);
      expect(before.state.overallPct).toBe(80);

      fs.writeFileSync(
        statePath,
        fs
          .readFileSync(statePath, "utf-8")
          .replace("- [ ] infrastructure-design — SKIP", "- [ ] infrastructure-design — EXECUTE"),
      );

      // No caching anywhere, so the very next assemble reflects the edit.
      const after = assemble(dir);
      expect(after.state.overallTotal).toBe(6); // denominator grew
      expect(after.state.overallDone).toBe(4); // numerator unchanged
      expect(after.state.overallPct).toBe(67);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The artifact listing + the open endpoint's path jail. The jail is the reason
// these tests exist: `rel` arrives from the page, so a regression that lets it
// escape the record dir would turn a dashboard click into arbitrary-file-open.
describe("stage artifacts", () => {
  function stageTree(): { root: string; record: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-art-"));
    const record = path.join(root, "record");
    const dir = path.join(record, "ideation", "intent-capture");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "intent-statement.md"), "x".repeat(10));
    fs.writeFileSync(path.join(dir, "stakeholder-map.md"), "y");
    fs.writeFileSync(path.join(dir, "intent-capture-questions.md"), "q");
    fs.writeFileSync(path.join(dir, "memory.md"), "d");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored"); // not a listed ext
    fs.writeFileSync(path.join(dir, "state.last"), "ignored"); // engine bookkeeping
    fs.mkdirSync(path.join(dir, "subdir")); // not a file
    return { root, record };
  }

  test("lists md + html, classifies kinds, and orders deliverables first", () => {
    const { root, record } = stageTree();
    try {
      // html is a real deliverable (the visual-mockups plugin's HTML path), so a
      // markdown-only filter would hide what the mockup stages exist to produce.
      fs.writeFileSync(
        path.join(record, "ideation", "intent-capture", "a-mockup.html"),
        "<html></html>",
      );
      const got = listStageArtifacts(record, "ideation", "intent-capture");
      expect(got.map((a) => a.name)).toEqual([
        "a-mockup.html",
        "intent-statement.md",
        "stakeholder-map.md",
        "intent-capture-questions.md",
        "memory.md",
      ]);
      expect(got.map((a) => a.kind)).toEqual([
        "artifact",
        "artifact",
        "artifact",
        "questions",
        "diary",
      ]);
      expect(got.some((a) => a.name.endsWith(".txt") || a.name.endsWith(".last"))).toBe(false);
      const statement = got.find((a) => a.name === "intent-statement.md")!;
      expect(statement.rel).toBe("ideation/intent-capture/intent-statement.md");
      expect(statement.size).toBe(10);
      expect(statement.unit).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absent stage dir is an empty list, not a throw", () => {
    const { root, record } = stageTree();
    try {
      expect(listStageArtifacts(record, "operation", "never-ran")).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a per-unit stage carries its unit and the construction path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-art-"));
    try {
      const dir = path.join(root, "construction", "PU-1-skeleton", "code-generation");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "code-summary.md"), "s");
      const got = listStageArtifacts(root, "construction", "code-generation", "PU-1-skeleton");
      expect(got).toHaveLength(1);
      expect(got[0]?.unit).toBe("PU-1-skeleton");
      expect(got[0]?.rel).toBe("construction/PU-1-skeleton/code-generation/code-summary.md");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // openArtifact spawns the OS opener on success, so only the REJECTION paths are
  // asserted here — every one of them returns before any spawn.
  test("the open jail rejects traversal, absolute paths, and bad extensions", () => {
    const { root, record } = stageTree();
    try {
      expect(openArtifact(record, "../../../../etc/passwd").ok).toBe(false);
      expect(openArtifact(record, "/etc/passwd")).toMatchObject({ ok: false, status: 403 });
      expect(openArtifact(record, "ideation/intent-capture/notes.txt")).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(openArtifact(record, "ideation/intent-capture/state.last")).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(openArtifact(record, "ideation/intent-capture/absent.md")).toMatchObject({
        ok: false,
        status: 404,
      });
      expect(openArtifact(record, "ideation/intent-capture/subdir")).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(openArtifact(record, "")).toMatchObject({ ok: false, status: 400 });
      expect(openArtifact(record, "a\0b.md")).toMatchObject({ ok: false, status: 400 });
      // A sibling dir sharing the record's prefix must not pass as inside it.
      fs.mkdirSync(path.join(root, "record-evil"));
      fs.writeFileSync(path.join(root, "record-evil", "x.md"), "z");
      expect(openArtifact(record, "../record-evil/x.md")).toMatchObject({
        ok: false,
        status: 403,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlink pointing outside the record is refused", () => {
    const { root, record } = stageTree();
    try {
      const outside = path.join(root, "outside.md");
      fs.writeFileSync(outside, "secret");
      const link = path.join(record, "ideation", "intent-capture", "link.md");
      fs.symlinkSync(outside, link);
      expect(openArtifact(record, "ideation/intent-capture/link.md")).toMatchObject({
        ok: false,
        status: 403,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the reference fixture assembles an artifact index keyed by phase/slug", () => {
    const m = assemble(FIXTURE);
    expect(Object.keys(m.artifacts).length).toBeGreaterThan(0);
    // Every key is <phase>/<slug> or construction/<unit>/<slug>, and every entry
    // is a rel path that starts with its key's first segment.
    for (const [key, files] of Object.entries(m.artifacts)) {
      expect(key.split("/").length).toBeGreaterThanOrEqual(2);
      for (const f of files) expect(f.rel.endsWith(f.name)).toBe(true);
    }
    expect(path.isAbsolute(m.identity.recordDir)).toBe(true);
  });
});
