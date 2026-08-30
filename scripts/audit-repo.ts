// Leak audit for the REPOSITORY, not the archive: `bun run audit` (part of `verify`).
//
// WHY A SECOND AUDIT. `package.ts` inspects the staged zip and refuses to write one
// that fails. That is the right check for the archive, and the archive deliberately
// excludes `*.test.ts` and `fixtures/` — so it never reads them. The repository is
// public and carries both. Nothing checked that, and the gap has been paid for twice:
// a real customer name survived in a test file after being removed from the module
// next to it, and four run-specific strings reached fixtures and header comments.
// Both times the archive audit passed, and passing was read as "clean".
//
// WHAT IT SCANS. Exactly the public surface — `git ls-files` plus untracked files git
// would not ignore. Not the working tree by walk: that would sweep in `data/`,
// `__backup/` and `dist/`, which are gitignored precisely because they never ship,
// and their hits would train the reader to skim past the report.
//
// WHAT IT CANNOT DO. Two limits, both stated in the output rather than left implied:
//
//   1. **The customer list is machine-local.** It is read from the work-tree roots at
//      runtime, never from a literal in this repo — an inventory of customer names
//      cannot live in a public repository. On a machine without those roots the audit
//      still runs the static patterns but is blind to names, and says so. The count is
//      printed; the names never are, because this output ends up in terminals, CI logs
//      and pasted snippets.
//   2. **History is out of scope by default.** Force-pushing does not purge GitHub's
//      unreachable objects (measured: an old commit stayed readable by SHA after
//      `filter-repo` + force push, and only deleting and recreating the repository
//      returned 404). So a hit in history is a different, heavier problem than a hit in
//      the working tree, and mixing them would blur the remedy. `--history` scans every
//      blob in the object database when you actually want that answer.
//
// Exit 0 clean, 1 on any hit. Non-skippable inside `verify` for the same reason the
// archive audit is not skippable in `package.ts`.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CREDENTIALS, MACHINE, customerNames } from "./leak-patterns";

const ROOT = path.join(import.meta.dir, "..");

/**
 * The pattern list exempts itself — see the warning at the top of leak-patterns.ts.
 * Also exempt: this file, which names the exemption and would match on the mention.
 */
const EXEMPT = new Set(["scripts/leak-patterns.ts", "scripts/audit-repo.ts"]);

/**
 * Every file is read; only a NUL byte (or an absurd size) excuses one.
 *
 * An extension allowlist was tried first and skipped 15 of 122 files — including
 * `fixtures/**\/active-space`, `active-intent` and the hook-health `.last`/`.drops`
 * state files, which have no extension at all and are exactly the kind of place a
 * hostname or a real path hides. A skipped file is an unchecked file, so the filter
 * is on the CONTENT now, not the name.
 */
const MAX_BYTES = 4 * 1024 * 1024;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    console.error(`✗ git ${args.join(" ")} 실패: ${r.stderr?.trim() ?? `exit ${r.status}`}`);
    process.exit(1);
  }
  return r.stdout;
}

/** Tracked + untracked-but-not-ignored: the set a push would publish. */
function publicFiles(): string[] {
  const tracked = git("ls-files").split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked])].filter((f) => f.length > 0).sort();
}

interface Hit {
  file: string;
  line: number;
  why: string;
  /** The matched text, redacted to its first 3 chars — enough to find, not to leak. */
  redacted: string;
  excerpt: string;
}

function redact(s: string): string {
  return s.length <= 3 ? `${s[0] ?? ""}…` : `${s.slice(0, 3)}…(${s.length}자)`;
}

function scanText(
  file: string,
  body: string,
  patterns: readonly { pattern: RegExp; why: string }[],
  hits: Hit[],
): void {
  const lines = body.split("\n");
  for (const { pattern, why } of patterns) {
    // Fresh regex per file: a caller-supplied /g would carry lastIndex between files.
    const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const m = re.exec(line);
      if (!m) continue;
      hits.push({
        file,
        line: i + 1,
        why,
        redacted: redact(m[0]),
        excerpt: line.trim().slice(0, 110),
      });
    }
  }
}

// ---- build the pattern set --------------------------------------------------

const customers = customerNames();
const customerPatterns = customers.names.map((n) => ({
  // Word-ish boundary: `lotteon` must match `LotteOn` and `lotteon-mo-next` but not a
  // longer unrelated word. Korean text has no \b, hence the explicit class.
  pattern: new RegExp(
    `(^|[^a-z0-9가-힣])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
    "i",
  ),
  why: "고객사 식별자",
}));

const ALL = [...MACHINE, ...CREDENTIALS, ...customerPatterns];

// ---- scan -------------------------------------------------------------------

const wantHistory = process.argv.includes("--history");
const files = publicFiles();
const hits: Hit[] = [];
let scanned = 0;
const skipped: string[] = [];

for (const file of files) {
  if (EXEMPT.has(file)) continue;
  const abs = path.join(ROOT, file);
  let body: string;
  try {
    if (fs.statSync(abs).size > MAX_BYTES) {
      skipped.push(`${file} (크기 초과)`);
      continue;
    }
    body = fs.readFileSync(abs, "utf-8");
  } catch {
    continue; // deleted between listing and read
  }
  if (body.includes("\u0000")) {
    skipped.push(`${file} (바이너리)`);
    continue;
  }
  scanned++;
  scanText(file, body, ALL, hits);
}

// ---- history (opt-in) -------------------------------------------------------

let historyHits = 0;
if (wantHistory) {
  const objects = git("rev-list", "--objects", "--all").split("\n");
  // BLOBS ONLY. `rev-list --objects` also yields trees and tag objects, and a tag's
  // `tagger` line carries the author's name and email — as does every commit, by
  // construction. That is not removable without rewriting the entire history, it is
  // public in any git repository, and reporting it on every run is how an audit trains
  // its reader to skim. File CONTENT is the question here.
  const types = new Map<string, string>();
  const shas = objects.map((r) => r.split(" ")[0] ?? "").filter((x) => x.length > 0);
  const check = spawnSync("git", ["cat-file", "--batch-check"], {
    cwd: ROOT,
    input: `${shas.join("\n")}\n`,
    encoding: "utf-8",
    maxBuffer: 1 << 28,
  }).stdout;
  for (const line of (check ?? "").split("\n")) {
    const [sha, type] = line.split(" ");
    if (sha && type) types.set(sha, type);
  }
  for (const row of objects) {
    const sp = row.indexOf(" ");
    if (sp < 0) continue;
    const sha = row.slice(0, sp);
    const name = row.slice(sp + 1);
    if (types.get(sha) !== "blob") continue;
    if (EXEMPT.has(name)) continue;
    const body = spawnSync("git", ["cat-file", "-p", sha], {
      cwd: ROOT,
      encoding: "utf-8",
      maxBuffer: 1 << 26,
    }).stdout;
    if (!body || body.includes("\u0000")) continue;
    const found: Hit[] = [];
    scanText(`${name}@${sha.slice(0, 8)}`, body, ALL, found);
    if (found.length > 0) {
      historyHits += found.length;
      hits.push(...found);
    }
  }
}

// ---- report -----------------------------------------------------------------

const blind = customers.rootsFound.length === 0;
if (blind) {
  console.warn(
    "⚠ 고객사 목록 원천을 찾지 못했다 — 정적 패턴만 검사했다. 이름 유출은 이 실행에서 검출되지 않는다.",
  );
  for (const r of customers.rootsMissing) console.warn(`    없음: ${r}`);
}

if (hits.length > 0) {
  console.error("✗ 저장소 유출 감사 실패:");
  for (const h of hits) {
    console.error(`    ${h.file}:${h.line} — ${h.why} [${h.redacted}]`);
    console.error(`      ${h.excerpt}`);
  }
  if (historyHits > 0) {
    console.error(
      `\n  이력에서 ${historyHits}건. force push 로는 지워지지 않는다 — 원격의 도달 불가 객체가\n  SHA 직접 조회로 계속 읽힌다. 저장소 삭제·재생성만이 실제로 없앤다.`,
    );
  }
  process.exit(1);
}

const scope = wantHistory ? "작업 트리 + 이력" : "작업 트리";
console.log(`✓ 저장소 유출 감사 통과 (${scope})`);
console.log(
  `  파일 ${scanned}/${files.length}개 검사 · 패턴 ${MACHINE.length}개(머신) + ${CREDENTIALS.length}개(자격증명) + ` +
    `${customerPatterns.length}개(고객사${blind ? ", 원천 없음" : ""})`,
);
// A skipped file is an unchecked file, so it is named rather than folded into a count.
for (const s of skipped) console.log(`  건너뜀: ${s}`);
if (!wantHistory) console.log("  이력은 검사하지 않았다 — 필요하면 `bun run audit -- --history`");
