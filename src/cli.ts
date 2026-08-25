// Command-line surface: `bun run src/server.ts --root <path> [--port N]`.
//
// The root is required and validated up front rather than on first request: a
// typo'd path should fail at startup with a usable message, not render an empty
// dashboard that looks like a finished run.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve a path, expanding a leading `~`. The shell does this for a typed
 * command, but the picker's text field reaches us verbatim, so both entry points
 * go through here to behave the same way.
 */
export function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.resolve(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export interface Options {
  /**
   * Absolute path of the workspace holding the `aidlc/` tree. Undefined when the
   * user did not pass one — the server then opens the folder picker instead of
   * refusing to start.
   */
  root?: string;
  port: number;
  /** Milliseconds between browser polls; 0 disables auto-refresh. */
  pollMs: number;
  /** Milliseconds between credit collection runs. */
  intervalMs: number;
  /**
   * Harness dir to read the stage catalogue from (e.g. ".claude"). Normally
   * discovered — set this only when a tree holds several harness dirs and the
   * probe order would pick the wrong one.
   */
  harnessDir?: string;
}

export const DEFAULT_PORT = 4321;
// Screen refresh cadence, unified to 1 minute across the integrated tree (BR4.1).
// This is the browser poll interval for /api/body; credit COLLECTION runs on its
// own 5-minute schedule (u2 PollingScheduler) and is deliberately separate.
export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const HOST = "127.0.0.1";
export const ENV_PORT = "AIDLC_DASHBOARD_PORT";
export const ENV_INTERVAL_MS = "AIDLC_DASHBOARD_INTERVAL_MS";

export const USAGE = `aidlc-dashboard — AI-DLC v2 run dashboard + credit usage

usage:
  bun run src/server.ts [--root <workspace>] [--port ${DEFAULT_PORT}] [--poll <ms>] [--interval <ms>]

  --root <path>     workspace holding the aidlc/ tree. OPTIONAL — omit it and the
                    browser opens a folder picker instead
  --port <n>        HTTP port (default ${DEFAULT_PORT}, env ${ENV_PORT})
  --poll <ms>       browser refresh interval, 0 to disable (default ${DEFAULT_POLL_MS})
  --interval <ms>   credit collection interval (default ${DEFAULT_INTERVAL_MS},
                    env ${ENV_INTERVAL_MS})
  --harness <dir>   harness dir for the stage catalogue (e.g. .kiro / .claude /
                    .aidlc). Auto-discovered; pass this only when a tree holds
                    several and the probe picks the wrong one.
  --help            this message

Harness-agnostic: the dashboard reads the aidlc/ docs tree, which is identical
across Kiro CLI, Kiro IDE and Claude Code. The workspace is read-only;
credit snapshots are stored separately under data/.`;

export class UsageError extends Error {}

function intArg(raw: string | undefined, flag: string): number {
  if (raw === undefined) throw new UsageError(`${flag} 에 값 필요`);
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} 는 숫자여야 함: ${raw}`);
  return Number(raw);
}

function intEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Parse argv (without the runtime/script entries). Throws UsageError with a
 * human message; the caller prints USAGE and exits.
 */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Options {
  let root: string | undefined;
  let port = intEnv(env[ENV_PORT]) ?? DEFAULT_PORT;
  let pollMs = DEFAULT_POLL_MS;
  let intervalMs = intEnv(env[ENV_INTERVAL_MS]) ?? DEFAULT_INTERVAL_MS;
  let harnessDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--root":
        root = argv[++i];
        if (root === undefined) throw new UsageError("--root 에 경로 필요");
        break;
      case "--port":
        port = intArg(argv[++i], "--port");
        break;
      case "--poll":
        pollMs = intArg(argv[++i], "--poll");
        break;
      case "--interval":
        intervalMs = intArg(argv[++i], "--interval");
        if (intervalMs < 1) throw new UsageError("--interval 는 1 이상이어야 함");
        break;
      case "--harness":
        harnessDir = argv[++i];
        if (harnessDir === undefined) throw new UsageError("--harness 에 디렉터리 이름 필요");
        break;
      case "--help":
      case "-h":
        throw new UsageError("");
      default:
        throw new UsageError(`알 수 없는 인자: ${a}`);
    }
  }

  // No --root: start anyway and let the user pick in the browser.
  if (root === undefined) return { root: undefined, port, pollMs, intervalMs, harnessDir };

  const abs = expandHome(root);
  if (!fs.existsSync(abs)) throw new UsageError(`경로 없음: ${abs}`);
  // `aidlc/` is the ONLY hard requirement — the harness dir is optional, because
  // the docs tree is what this dashboard reads and it is identical on every
  // harness.
  if (!fs.existsSync(path.join(abs, "aidlc"))) {
    throw new UsageError(`aidlc/ 디렉터리 없음 — AI-DLC 워크스페이스 루트가 아님: ${abs}`);
  }
  if (harnessDir !== undefined && !fs.existsSync(path.join(abs, harnessDir))) {
    throw new UsageError(`--harness 로 지정한 디렉터리 없음: ${path.join(abs, harnessDir)}`);
  }

  return { root: abs, port, pollMs, intervalMs, harnessDir };
}
