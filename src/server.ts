// HTTP entry point.
//
// Every request re-reads the workspace. That is deliberate: the whole read costs
// ~10ms on a real run (4,228 audit blocks across 2 shards), so caching would only
// add a staleness window to a dashboard whose entire purpose is not being stale.
//
// The selected workspace lives in ONE mutable variable here. That is the only
// mutable state in the process, and it is the price of letting the user pick a
// folder in the browser instead of restarting with a different --root. It holds a
// path the server validated itself (see /select), never a raw client string.
//
// Read-only with respect to the workspace: no route writes to it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOST, type Options, USAGE, UsageError, expandHome, parseArgs } from "./cli";
import { type Pollable, PollingScheduler } from "./credit/pipeline/polling-scheduler";
import { type PipelineStore, RefreshPipeline } from "./credit/pipeline/refresh-pipeline";
import { SnapshotStore } from "./credit/storage/snapshot-store";
import { type CreditReadStore, assembleCredit } from "./credit/view/credit-model";
import { resolveWindow } from "./credit/view/credit-view";
import { type CreditContext, NoRunError, assemble } from "./model/assemble";
import { esc } from "./render/common";
import { renderBody, renderPage } from "./render/page";
import { renderPicker } from "./render/picker";
import { browse, resolveWorkspace } from "./scan/browse";
import { buildExplorer } from "./scan/explorer";
import { openArtifact } from "./scan/open-file";
import { discoverWorkspaces } from "./scan/workspaces";

/** Path the u3 credit view's no-JS refresh form POSTs to (must match verbatim). */
const REFRESH_PATH = "/api/credit/refresh";

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function json(value: unknown, status = 200): Response {
  // Map is not JSON-serialisable; the scan layer uses it for per-stage tallies,
  // so convert on the way out rather than distorting the internal types.
  const body = JSON.stringify(value, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

/** An error page that still says which workspace was being read. */
function errorPage(root: string, message: string): string {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<title>AI-DLC dashboard</title>
<style>body{font:14px/1.6 ui-sans-serif,-apple-system,sans-serif;margin:40px auto;max-width:640px;
padding:0 18px;color:#1b1f2a}code{background:#eef0f4;padding:1px 5px;border-radius:4px}
h1{font-size:17px}a{color:#2f6fd0}</style></head>
<body><h1>워크플로 표시 불가</h1>
<p>${esc(message)}</p>
<p>읽으려던 경로: <code>${esc(root)}</code></p>
<p>확인할 것: <code>&lt;root&gt;/aidlc/active-space</code> 와
<code>&lt;root&gt;/aidlc/spaces/&lt;space&gt;/intents/active-intent</code> 커서가 실재하는 record 를 가리키는지.</p>
<p><a href="/pick">다른 폴더 선택</a></p>
</body></html>`;
}

/** The workspace currently being shown. Mutated only by /select. */
let activeRoot: string | undefined;

/**
 * The credit subsystem the request handler sees. Both fields are optional: when
 * the subsystem failed to boot the dashboard still serves everything else, and
 * the credit slot degrades to a `none` view (NFR1.5). `store` is read by
 * `assemble` (u1 read contract); `pipeline` is triggered by the manual refresh
 * POST (u2 run contract). Injected explicitly so `handle` stays testable.
 */
export interface CreditRuntime {
  store?: CreditReadStore;
  pipeline?: Pollable;
  isCollecting?: () => boolean;
  markCollectionDone?: () => void;
}

export async function handle(
  req: Request,
  opts: Options,
  credit: CreditRuntime = {},
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/refresh") {
    if (req.method !== "POST") return new Response("read-only", { status: 405 });
    if (!credit.pipeline) return json({ error: "credit runtime unavailable" }, 503);
    try {
      return json(await credit.pipeline.run("manual"));
    } catch (err) {
      return json(
        {
          error: "credit refresh failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    } finally {
      credit.markCollectionDone?.();
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    // The ONE write exception to the read-only policy: the manual credit refresh
    // POST triggers a single re-collection, then redirects back so the no-JS
    // form re-renders the full page with the fresh snapshot (BR3.1, BR6.2,
    // NFR1.2). Every other non-GET/HEAD request stays 405.
    if (req.method === "POST" && url.pathname === REFRESH_PATH) {
      if (credit.pipeline) {
        try {
          await credit.pipeline.run("manual");
        } catch (err) {
          // Collection failures are already captured as failure snapshots by u2;
          // a throw here would only be an unexpected defect. Isolate it — the
          // refresh must never 500 the page.
          console.warn(
            `[aidlc-dashboard] 수동 새로고침 실패(격리됨): ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          credit.markCollectionDone?.();
        }
      }
      const cw = url.searchParams.get("cw");
      return redirect(cw ? `/?cw=${encodeURIComponent(cw)}` : "/");
    }
    return new Response("read-only", { status: 405 });
  }

  const showHidden = url.searchParams.get("hidden") === "1";

  // Credit context for the two rendering routes: the store plus the sanitised
  // trend window from `?cw=` (invalid/absent → 30d, BR5.2). Undefined when the
  // subsystem is not wired, which makes `assemble` produce a `none` credit view.
  const creditCtx: CreditContext | undefined = credit.store
    ? {
        store: credit.store,
        window: resolveWindow(url.searchParams.get("cw")),
        collecting: credit.isCollecting?.() ?? false,
      }
    : undefined;

  try {
    switch (url.pathname) {
      // ---- folder picker ----------------------------------------------------
      case "/pick":
      case "/browse": {
        // Default to the parent of the active workspace so the picker opens
        // somewhere useful rather than at the home dir every time.
        const dirParam = url.searchParams.get("dir");
        const fallback = activeRoot ? path.dirname(activeRoot) : os.homedir();
        const dir = dirParam ? expandHome(dirParam) : expandHome(fallback);
        const listing = browse(dir, showHidden);
        return html(
          renderPicker(
            listing,
            showHidden,
            activeRoot,
            discoverWorkspaces(),
            buildExplorer(listing.dir, { activeRoot }),
          ),
        );
      }

      case "/select": {
        const raw = url.searchParams.get("dir");
        if (!raw) return redirect("/pick");
        // Validate on the SERVER: accept only a path that really is a workspace
        // (or the `aidlc/` dir inside one). A client string never becomes the
        // active root unvalidated.
        const picked = resolveWorkspace(expandHome(raw));
        if (!picked) {
          const dir = expandHome(raw);
          const listing = browse(dir, showHidden);
          return html(
            renderPicker(
              { ...listing, error: `${dir} 에 aidlc/ 폴더 없음 — 워크스페이스가 아님.` },
              showHidden,
              activeRoot,
              discoverWorkspaces(),
              buildExplorer(listing.dir, { activeRoot }),
            ),
            400,
          );
        }
        activeRoot = picked;
        return redirect("/");
      }

      // ---- dashboard -------------------------------------------------------
      case "/": {
        // No workspace chosen yet → the picker IS the landing page.
        if (!activeRoot) {
          const listing = browse(os.homedir(), showHidden);
          return html(
            renderPicker(
              listing,
              showHidden,
              undefined,
              discoverWorkspaces(),
              buildExplorer(listing.dir),
            ),
          );
        }
        return html(renderPage(assemble(activeRoot, opts.harnessDir, creditCtx), opts.pollMs));
      }

      case "/api/body": {
        if (!activeRoot) return html('<p class="note">워크스페이스 미선택.</p>');
        // Just the refreshable region — what the browser poll swaps in.
        return html(renderBody(assemble(activeRoot, opts.harnessDir, creditCtx)));
      }

      case "/api/current": {
        if (!credit.store) return json({ error: "credit runtime unavailable" }, 503);
        const model = assembleCredit(
          credit.store,
          new Date(),
          "30d",
          credit.isCollecting?.() ?? false,
        );
        const state =
          model.status === "loading"
            ? "loading"
            : model.current !== null || model.warning !== null
              ? "populated"
              : "empty";
        return json({
          state,
          status: model.status,
          current: model.current,
          warning: model.warning,
          freshness: model.freshness,
        });
      }

      case "/api/trend": {
        if (!credit.store) return json({ error: "credit runtime unavailable" }, 503);
        const window = resolveWindow(url.searchParams.get("window"));
        return json(assembleCredit(credit.store, new Date(), window).trend);
      }

      case "/api/model": {
        if (!activeRoot) return json({ error: "no workspace selected" }, 409);
        return json(assemble(activeRoot, opts.harnessDir, creditCtx));
      }

      // ---- open an artifact in the user's editor ----------------------------
      // The browser cannot launch a local app; this server can, because the user
      // started it. `rel` is hostile input — openArtifact jails it under the
      // record dir before anything is spawned (see scan/open-file.ts).
      case "/open": {
        if (!activeRoot) return json({ error: "no workspace selected" }, 409);
        const rel = url.searchParams.get("rel");
        if (!rel) return json({ error: "rel 파라미터 없음" }, 400);
        const model = assemble(activeRoot, opts.harnessDir);
        const res = openArtifact(model.identity.recordDir, rel);
        if (!res.ok) return json({ error: res.reason, rel }, res.status);
        // 204: the click opened an editor, so the page must NOT navigate away.
        return new Response(null, { status: 204 });
      }

      case "/healthz":
        return json({ ok: true, root: activeRoot ?? null });

      default:
        return new Response("not found", { status: 404 });
    }
  } catch (err) {
    const root = activeRoot ?? "(선택 없음)";
    if (err instanceof NoRunError) {
      return html(errorPage(root, err.message), 404);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[aidlc-dashboard] ${url.pathname} 실패:`, err);
    return html(errorPage(root, `읽기 중 오류: ${message}`), 500);
  }
}

// ---- credit subsystem boot & lifecycle ------------------------------------

/** The booted credit subsystem, or a degraded shell when boot failed. */
export interface CreditSubsystem extends CreditRuntime {
  store?: CreditReadStore;
  pipeline?: Pollable;
  scheduler?: { stop(): void };
  degraded: boolean;
  isCollecting: () => boolean;
  markCollectionDone: () => void;
}

/** Minimal shapes the boot sequence needs, so tests can inject failing seams. */
interface StoreForBoot extends CreditReadStore, PipelineStore {
  init(): void;
}
interface PipelineForBoot extends Pollable {
  init(): void;
}
interface SchedulerForBoot {
  start(runImmediately: boolean): void;
  stop(): void;
}

/** Injectable factories — real constructors by default, stubs in tests. */
export interface CreditBootDeps {
  intervalMs?: number;
  createStore?: () => StoreForBoot;
  createPipeline?: (store: StoreForBoot) => PipelineForBoot;
  createScheduler?: (
    pipeline: PipelineForBoot,
    onSettled: () => void,
    intervalMs: number | undefined,
  ) => SchedulerForBoot;
}

/**
 * Boot the credit subsystem: open the store, seed the pipeline's sequence
 * counter, and start the 5-minute polling scheduler with an immediate first
 * collection (BR2.1). ANY failure here is isolated — the dashboard must start
 * regardless, with credit degraded (NFR1.5). Factories are injectable so a test
 * can drive the init-failure path without a real SQLite handle.
 */
export function bootCredit(deps: CreditBootDeps = {}): CreditSubsystem {
  let collecting = true;
  const markCollectionDone = () => {
    collecting = false;
  };
  const isCollecting = () => collecting;

  try {
    const store = (
      deps.createStore ??
      (() => {
        // bun:sqlite (unlike the former JSONL writer) does NOT create the parent
        // directory, so ensure the default `./data` dir exists before opening the
        // DB. This is part of the credit snapshot-storage write path — the one
        // write exception the read-only dashboard allows (BR6.4).
        fs.mkdirSync("data", { recursive: true });
        return new SnapshotStore();
      })
    )();
    store.init();
    const pipeline = (deps.createPipeline ?? ((s) => new RefreshPipeline({ store: s })))(store);
    pipeline.init();
    const scheduler = (
      deps.createScheduler ??
      ((p, onSettled, intervalMs) =>
        new PollingScheduler({
          pipeline: p,
          intervalMs,
          onTick: onSettled,
          onError: onSettled,
        }))
    )(pipeline, markCollectionDone, deps.intervalMs);
    scheduler.start(true);
    return {
      store,
      pipeline,
      scheduler,
      degraded: false,
      isCollecting,
      markCollectionDone,
    };
  } catch (err) {
    console.error(
      `[aidlc-dashboard] 크레딧 서브시스템 부팅 실패(대시보드는 계속 기동): ${err instanceof Error ? err.message : String(err)}`,
    );
    markCollectionDone();
    return { degraded: true, isCollecting, markCollectionDone };
  }
}

/** Stop the polling scheduler's timer on shutdown (BR2.2). No-op when degraded. */
export function shutdownCredit(scheduler?: { stop(): void }): void {
  scheduler?.stop();
}

// ---- process entry point --------------------------------------------------

if (import.meta.main) {
  let opts: Options;
  try {
    opts = parseArgs(Bun.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) console.error(`error: ${err.message}\n`);
      console.error(USAGE);
      process.exit(err.message ? 2 : 0);
    }
    throw err;
  }

  activeRoot = opts.root;

  // With a --root, fail loudly at startup rather than on first request. Without
  // one, there is nothing to validate yet — the picker will do it.
  if (activeRoot) {
    try {
      const m = assemble(activeRoot, opts.harnessDir);
      console.log(
        `[aidlc-dashboard] ${m.identity.slug ?? m.identity.record} · ${m.state.lifecyclePhase} ${m.state.overallPct}% · ` +
          `blockers ${m.blockers.length} · audit ${m.totalEvents}건 · harness ${m.identity.harnessDir ?? "미검출"}`,
      );
      for (const w of m.warnings) console.warn(`[warn] ${w}`);
    } catch (err) {
      console.error(`[aidlc-dashboard] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    console.log("[aidlc-dashboard] --root 없음 — 브라우저에서 폴더 선택");
  }

  // Boot credit AFTER the workspace check so a --root typo still fails fast, and
  // isolate it so a credit boot failure never blocks the server (NFR1.5).
  const credit = bootCredit({ intervalMs: opts.intervalMs });

  // Clean up the polling timer on termination (BR2.2). The timer is unref'd, so
  // the process can exit on its own; stopping is explicit belt-and-braces.
  process.on("SIGINT", () => {
    shutdownCredit(credit.scheduler);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdownCredit(credit.scheduler);
    process.exit(0);
  });

  const server = Bun.serve({
    hostname: HOST, // loopback-only bind (BR6.1, NFR1.1) — never 0.0.0.0
    port: opts.port,
    fetch: (req) => handle(req, opts, credit),
  });

  console.log(
    `[aidlc-dashboard] http://${HOST}:${server.port}  (poll ${opts.pollMs}ms, collect ${opts.intervalMs}ms, workspace read-only${credit.degraded ? ", credit degraded" : ""})`,
  );
}
