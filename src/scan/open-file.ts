// Open one record artifact in the user's default editor.
//
// WHY THE SERVER DOES THIS. A browser cannot launch a local application — that
// is the sandbox working as designed. But this server is a local bun process the
// user started themselves, so it can. The click therefore travels
// browser → GET /open?rel=... → this module → OS "open with default app".
//
// THE PATH IS NEVER TRUSTED. `rel` arrives from the page, so it is treated as
// hostile input and must survive three checks before anything is spawned:
//
//   1. resolve it under the record dir and confirm the result is still inside
//      (blocks `../../../etc/passwd` and absolute paths alike),
//   2. confirm it is a regular file — realpath'd, so a symlink pointing outside
//      the record is rejected even though step 1 passed on the link itself,
//   3. confirm the extension is allowed (.md only today).
//
// The command is spawned with an ARGUMENT ARRAY, never a shell string, so a file
// name containing shell metacharacters cannot become a command. That is why this
// is safe despite handling a user-supplied path.
//
// Never throws: every failure is a typed result the caller renders.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type OpenResult =
  | { ok: true; abs: string }
  | { ok: false; reason: string; status: 400 | 403 | 404 | 500 };

/** Extensions we are willing to hand to the OS — the artifact kinds a record
 *  actually holds: markdown, the html the visual-mockups plugin writes at the
 *  mockup stages, and the json the engine writes for `traceability`, which 8
 *  stages contract as a deliverable. Keeping the set closed means the engine's
 *  bookkeeping files (`.last`, `.drops`) and any stray binary can never be
 *  launched. Must stay in sync with LISTED_EXT in scan/artifacts.ts: a file the
 *  page lists but this refuses would be a dead link.
 *
 *  ⚠️ html opens in the default BROWSER, which is the point for a mockup — but
 *  it also means the opened file can run its own scripts. That is acceptable
 *  only because the path is jailed to the record the user chose to view. json is
 *  inert by comparison — it opens in the user's text editor. */
const ALLOWED_EXT = new Set([".md", ".html", ".json"]);

/** Per-platform "open with the default application" command. */
function opener(): { cmd: string; pre: string[] } | undefined {
  if (process.platform === "darwin") return { cmd: "open", pre: [] };
  if (process.platform === "win32") return { cmd: "cmd", pre: ["/c", "start", ""] };
  if (process.platform === "linux") return { cmd: "xdg-open", pre: [] };
  return undefined;
}

/**
 * Validate `rel` against `recordDir` and, if it holds up, ask the OS to open it.
 * `recordDir` must be absolute (assemble derives it from the state file path).
 */
export function openArtifact(recordDir: string, rel: string): OpenResult {
  if (!rel || rel.length > 512)
    return { ok: false, reason: "경로가 비었거나 너무 김", status: 400 };
  // NUL byte would truncate the path at the syscall boundary.
  if (rel.includes("\0"))
    return { ok: false, reason: "경로에 허용되지 않는 문자 포함", status: 400 };

  const base = path.resolve(recordDir);
  const abs = path.resolve(base, rel);
  // Compare with a trailing separator so `/record-evil` cannot pass as `/record`.
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, reason: "record 폴더 밖의 경로는 열기 불가", status: 403 };
  }
  if (!ALLOWED_EXT.has(path.extname(abs).toLowerCase())) {
    return {
      ok: false,
      reason: `이 확장자는 열기 불가 (${[...ALLOWED_EXT].join(" / ")} 만 허용)`,
      status: 403,
    };
  }

  // realpath AFTER the prefix check: resolves symlinks, so a link inside the
  // record that points outside it is caught here rather than followed.
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { ok: false, reason: "파일 없음", status: 404 };
  }
  const realBase = (() => {
    try {
      return fs.realpathSync(base);
    } catch {
      return base;
    }
  })();
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    return { ok: false, reason: "symlink 가 record 폴더 밖을 가리킴", status: 403 };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return { ok: false, reason: "파일 정보 읽기 불가", status: 404 };
  }
  if (!st.isFile()) return { ok: false, reason: "일반 파일이 아님", status: 403 };

  const o = opener();
  if (!o) {
    return { ok: false, reason: `이 플랫폼(${process.platform})은 열기 미지원`, status: 500 };
  }
  try {
    // Argument array (never a shell string) + detached so the editor outlives
    // this request, and stdio ignored so a chatty opener cannot block us.
    const child = spawn(o.cmd, [...o.pre, real], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    return {
      ok: false,
      reason: `열기 실패: ${err instanceof Error ? err.message : String(err)}`,
      status: 500,
    };
  }
  return { ok: true, abs: real };
}
