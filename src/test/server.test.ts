// u4-host-integration wiring tests (Step 8).
//
// Covers the host↔credit seam that assemble/model tests cannot: the credit slot
// in `assemble`, the request handler's routing and the ONE write exception
// (manual refresh POST), the `?cw=` window thread, and the boot/shutdown
// lifecycle. No real kiro-cli and no real SQLite are touched — every dependency
// is an injected stub, and the one live server is bound to 127.0.0.1:0 (an
// ephemeral loopback port) purely to prove the binding and routing over HTTP.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { type Options, parseArgs } from "../cli";
import type { Pollable } from "../credit/pipeline/polling-scheduler";
import type { RefreshResult } from "../credit/pipeline/refresh-pipeline";
import type { CaptureSource, CreditSnapshot, ParsedUsage } from "../credit/types";
import type { CreditReadStore, CreditViewModel } from "../credit/view/credit-model";
import { type UsageContext, assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { type CreditRuntime, bootCredit, handle, shutdownCredit } from "../server";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const OPTS: Options = parseArgs(["--root", FIXTURE]);

function usage(overrides: Partial<ParsedUsage> = {}): ParsedUsage {
  return {
    planName: "Pro",
    usedAmount: 120,
    remainingAmount: 380,
    planLimit: 500,
    usageRatio: 0.24,
    resetDate: "2026-09-01",
    partial: false,
    ...overrides,
  };
}

/** A success snapshot captured "now", so assembleCredit sees it as fresh (ok). */
function freshOkSnapshot(): CreditSnapshot {
  return {
    sequence: 1,
    capturedAt: new Date().toISOString(),
    source: "auto",
    ok: true,
    data: usage(),
  };
}

/** A read store stub returning the given snapshots. Never touches SQLite. */
function stubStore(snapshots: CreditSnapshot[]): CreditReadStore {
  return {
    readAll: () => snapshots,
    latest: () => (snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null),
  };
}

/** A read store whose reads throw — drives the assemble degrade path (BR1.4). */
function throwingStore(): CreditReadStore {
  return {
    readAll: () => {
      throw new Error("store boom");
    },
    latest: () => {
      throw new Error("store boom");
    },
  };
}

/**
 * Narrow `model.usage` to the Kiro credit view. The reference fixture ships a
 * `.kiro` harness dir, so `auto` resolves to the credit panel — asserting the
 * discriminant here keeps that assumption honest instead of casting past it.
 */
function creditOf(m: DashboardModel): CreditViewModel {
  if (m.usage.kind !== "kiro")
    throw new Error(`expected the kiro usage panel, got ${m.usage.kind}`);
  return m.usage.credit;
}

// ── assemble usage slot (kiro side) ─────────────────────────────────────────

describe("assemble credit slot", () => {
  test("no usageCtx → status 'none' (existing callers unaffected)", () => {
    const m = assemble(FIXTURE);
    expect(creditOf(m).status).toBe("none");
    expect(creditOf(m).current).toBeNull();
    // The rest of the model still assembles.
    expect(m.identity.record).toBe("260101-demo-migration");
  });

  test("creditCtx with a fresh success snapshot → status reflects the store", () => {
    const ctx: UsageContext = { store: stubStore([freshOkSnapshot()]), window: "30d" };
    const m = assemble(FIXTURE, undefined, ctx);
    expect(creditOf(m).status).toBe("ok");
    expect(creditOf(m).current).not.toBeNull();
    expect(creditOf(m).current?.planName).toBe("Pro");
    expect(creditOf(m).trend.window).toBe("30d");
  });

  test("store throw → degrade to none + warning, rest of model intact (BR1.4)", () => {
    const ctx: UsageContext = { store: throwingStore(), window: "7d" };
    const m = assemble(FIXTURE, undefined, ctx);
    expect(creditOf(m).status).toBe("none");
    expect(creditOf(m).trend.window).toBe("7d"); // degrade preserves the asked window
    expect(m.warnings.some((w) => w.includes("크레딧 조립 실패"))).toBe(true);
    // Non-credit sections are unharmed.
    expect(m.state.overallPct).toBe(80);
  });

  test("the ?cw window is threaded into the assembled trend", () => {
    const ctx: UsageContext = { store: stubStore([freshOkSnapshot()]), window: "all" };
    expect(creditOf(assemble(FIXTURE, undefined, ctx)).trend.window).toBe("all");
  });
});

// ── request handler routing & the single write exception ─────────────────────

describe("handle routing", () => {
  const get = (p: string, credit?: CreditRuntime) =>
    handle(new Request(`http://127.0.0.1${p}`), OPTS, credit);

  test("non-GET/HEAD (POST/PUT/DELETE) on a normal path → 405 read-only", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await handle(new Request("http://127.0.0.1/api/body", { method }), OPTS);
      expect(res.status).toBe(405);
      expect(await res.text()).toBe("read-only");
    }
  });

  test("manual refresh POST → pipeline.run('manual') exactly once, then redirects", async () => {
    const calls: CaptureSource[] = [];
    const pipeline: Pollable = {
      run: (source) => {
        calls.push(source);
        return Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult);
      },
    };
    const res = await handle(
      new Request("http://127.0.0.1/api/credit/refresh", { method: "POST" }),
      OPTS,
      { pipeline },
    );
    expect(calls).toEqual(["manual"]);
    expect(res.status).toBe(303); // redirect back so the no-JS form re-renders
  });

  test("manual refresh POST with ?cw preserves the window on the redirect", async () => {
    const pipeline: Pollable = {
      run: () => Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult),
    };
    const res = await handle(
      new Request("http://127.0.0.1/api/credit/refresh?cw=7d", { method: "POST" }),
      OPTS,
      { pipeline },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?cw=7d");
  });

  test("manual refresh POST is safe when the subsystem is degraded (no pipeline)", async () => {
    const res = await handle(
      new Request("http://127.0.0.1/api/credit/refresh", { method: "POST" }),
      OPTS,
      {},
    );
    expect(res.status).toBe(303); // still redirects; simply nothing to re-collect
  });

  test("POST /api/refresh returns the refresh result as JSON", async () => {
    const calls: CaptureSource[] = [];
    let collecting = true;
    const pipeline: Pollable = {
      run: (source) => {
        calls.push(source);
        return Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult);
      },
    };
    const res = await handle(
      new Request("http://127.0.0.1/api/refresh", { method: "POST" }),
      OPTS,
      {
        pipeline,
        isCollecting: () => collecting,
        markCollectionDone: () => {
          collecting = false;
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(calls).toEqual(["manual"]);
    expect(collecting).toBe(false);
    expect((await res.json()) as RefreshResult).toMatchObject({ persisted: true });
  });

  test("GET /api/current exposes loading and GET /api/trend honors the window", async () => {
    const store = stubStore([]);
    const runtime: CreditRuntime = { store, isCollecting: () => true };
    const current = await get("/api/current", runtime);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      state: "loading",
      status: "loading",
      freshness: { stale: false, lastSuccessAt: null },
    });

    const trend = await get("/api/trend?window=7d", runtime);
    expect(trend.status).toBe(200);
    expect(await trend.json()).toMatchObject({ window: "7d", points: [] });
  });

  test("credit JSON APIs return 503 when the subsystem is unavailable", async () => {
    expect((await get("/api/current")).status).toBe(503);
    expect((await get("/api/trend")).status).toBe(503);
    expect(
      (await handle(new Request("http://127.0.0.1/api/refresh", { method: "POST" }), OPTS)).status,
    ).toBe(503);
  });

  test("GET /browse serves the primary folder explorer", async () => {
    const res = await get(`/browse?dir=${encodeURIComponent(FIXTURE)}`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("폴더 탐색");
    expect(body).toContain('aria-label="탐색 루트"');
    expect(body).toContain('aria-label="현재 경로"');
    expect(body).toContain('id="directory-filter"');
  });

  test("?cw=7d threads the window through to the rendered credit view", async () => {
    // Select the fixture workspace first so /api/body has something to render.
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get("/api/body?cw=7d", { store: stubStore([]) });
    const body = await res.text();
    expect(body).toContain('aria-checked="true" href="?cw=7d"');
    expect(body).toContain('aria-checked="false" href="?cw=30d"');
  });

  test("?cw invalid → 30d fallback in the rendered view", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get("/api/body?cw=bogus", { store: stubStore([]) });
    const body = await res.text();
    expect(body).toContain('aria-checked="true" href="?cw=30d"');
  });

  test("/api/model includes the wired credit model", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get("/api/model", { store: stubStore([freshOkSnapshot()]) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      usage: { kind: "kiro", credit: { status: "ok", current: { planName: "Pro" } } },
    });
  });

  test("the /open record-dir jail is preserved (traversal rejected)", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get(`/open?rel=${encodeURIComponent("../../../../etc/passwd")}`);
    expect(res.status).toBe(403);
  });
});

// ── boot & shutdown lifecycle ────────────────────────────────────────────────

describe("credit subsystem lifecycle", () => {
  test("bootCredit wires store→pipeline→scheduler and starts immediately", () => {
    const events: string[] = [];
    const sub = bootCredit({
      createStore: () => ({
        init: () => events.push("store.init"),
        latest: () => null,
        readAll: () => [],
        maxSequence: () => 0,
        append: () => {},
      }),
      createPipeline: () => ({
        init: () => events.push("pipeline.init"),
        run: () =>
          Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult),
      }),
      createScheduler: () => ({
        start: (runImmediately: boolean) => events.push(`scheduler.start(${runImmediately})`),
        stop: () => events.push("scheduler.stop"),
      }),
    });
    expect(sub.degraded).toBe(false);
    expect(events).toEqual(["store.init", "pipeline.init", "scheduler.start(true)"]);
  });

  test("bootCredit passes the configured collection interval to the scheduler", () => {
    let receivedInterval: number | undefined;
    const sub = bootCredit({
      intervalMs: 12_345,
      createStore: () => ({
        init: () => {},
        latest: () => null,
        readAll: () => [],
        maxSequence: () => 0,
        append: () => {},
      }),
      createPipeline: () => ({
        init: () => {},
        run: () =>
          Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult),
      }),
      createScheduler: (_pipeline, onSettled, intervalMs) => {
        receivedInterval = intervalMs;
        return {
          start: () => onSettled(),
          stop: () => {},
        };
      },
    });
    expect(receivedInterval).toBe(12_345);
    expect(sub.isCollecting()).toBe(false);
  });

  test("a boot init failure is isolated → degraded, no store, server still starts", () => {
    const sub = bootCredit({
      createStore: () => {
        throw new Error("sqlite open failed");
      },
    });
    expect(sub.degraded).toBe(true);
    expect(sub.store).toBeUndefined();
    expect(sub.pipeline).toBeUndefined();
    expect(sub.scheduler).toBeUndefined();
  });

  test("shutdownCredit stops the scheduler (SIGINT/SIGTERM path) and tolerates absence", () => {
    let stopped = 0;
    shutdownCredit({ stop: () => stopped++ });
    expect(stopped).toBe(1);
    expect(() => shutdownCredit(undefined)).not.toThrow();
  });
});

// ── loopback binding + routing over real HTTP ────────────────────────────────

describe("server binds loopback and routes over HTTP", () => {
  test("127.0.0.1:0 serves /healthz and rejects non-GET with 405", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => handle(req, OPTS, {}),
    });
    try {
      expect(server.hostname).toBe("127.0.0.1");
      const base = `http://127.0.0.1:${server.port}`;

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { ok: boolean };
      expect(healthBody.ok).toBe(true);

      const rejected = await fetch(`${base}/api/body`, { method: "DELETE" });
      expect(rejected.status).toBe(405);
    } finally {
      server.stop(true);
    }
  });
});
