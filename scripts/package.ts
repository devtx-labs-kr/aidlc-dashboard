// Build the customer-facing archive: `bun run package`.
//
// WHY THIS IS A SCRIPT AND NOT A CHECKLIST. The first archive was assembled by
// hand and shipped `data/usage.db` — a smoke test had been run inside the staging
// dir and left the operator's real credit history there. The version was typed
// twice too (into the trimmed package.json and into the zip name), which is two
// sources of truth for one fact. Both failures are the kind a script removes and
// a checklist does not.
//
// What ships is the RUN-ONLY surface: implementation, README, launchers, and a
// package.json with the dev tooling stripped. The dashboard has zero runtime
// dependencies (everything is `bun:*` or `node:*`), so a customer's first run
// installs nothing — keeping devDependencies would make them fetch ~53MB of biome
// and typescript they never invoke.
//
// The version comes from package.json and nowhere else: it names the archive, it
// goes into the trimmed manifest, and `src/version.ts` reads the same field at
// runtime so the footer and startup log agree with the filename.
//
// Refuses to write an archive that fails the leak audit. That check is the point
// of the script, so it is not skippable.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CREDENTIALS, MACHINE, customerNames } from "./leak-patterns";

const ROOT = path.join(import.meta.dir, "..");

/** Files and dirs the archive carries, relative to the repo root. */
const INCLUDE = ["README.md", "start.sh", "start.cmd", "start.ps1"] as const;

/** Launchers that must ship with CRLF — a batch file with LF can mis-parse labels. */
const CRLF_FILES = ["start.cmd", "start.ps1"] as const;

/**
 * Anything matching these must NOT appear in the archive. Named rather than
 * inferred so a new leak has to be added here deliberately.
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /(^|\/)data\//, why: "수집된 크레딧 DB — 운영자의 실제 사용 이력" },
  { pattern: /\.db$/, why: "SQLite 파일" },
  { pattern: /(^|\/)\.git\//, why: "커밋 이력·작성자 정보" },
  { pattern: /(^|\/)__backup\//, why: "과거 자료" },
  { pattern: /(^|\/)node_modules\//, why: "재생성 가능" },
  { pattern: /\.test\.ts$/, why: "실행에 불필요" },
  { pattern: /(^|\/)fixtures\//, why: "테스트 입력" },
  { pattern: /(^|\/)CLAUDE\.md$/, why: "내부 설계 문서 (로컬 경로·미검증 항목 포함)" },
  { pattern: /(^|\/)biome\.json$/, why: "dev 도구 설정" },
  { pattern: /(^|\/)tsconfig\.json$/, why: "dev 도구 설정" },
  { pattern: /(^|\/)bun\.lock$/, why: "의존성 0개라 불필요" },
  { pattern: /\.DS_Store$/, why: "macOS 잔여물" },
];

/**
 * Content patterns come from `leak-patterns.ts`, shared with the repository-wide
 * audit (`bun run audit`). They used to be defined here and only here, which meant
 * the two surfaces could drift: the archive check was the stricter one for a while
 * and the repository had no check at all. One definition, two callers.
 *
 * The customer names are read from outside the repository at build time, so this
 * check is only as good as the machine it runs on — hence the count in the summary
 * line and the warning when none loaded.
 */
const customers = customerNames();
const SECRETS: readonly { pattern: RegExp; why: string }[] = [
  ...MACHINE,
  ...CREDENTIALS,
  ...customers.names.map((n) => ({
    pattern: new RegExp(
      `(^|[^a-z0-9가-힣])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i",
    ),
    why: "고객사 식별자",
  })),
];

function read(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Every file under `dir`, as paths relative to `dir`. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out.sort();
}

/** Copy `src/`, dropping tests and test fixtures. */
function copyImplementation(from: string, to: string): number {
  let copied = 0;
  for (const rel of walk(from)) {
    if (rel.endsWith(".test.ts")) continue;
    if (rel.split(path.sep).includes("fixtures")) continue;
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
    copied++;
  }
  return copied;
}

/**
 * Derive the shipped manifest from the real one. Deriving rather than hand-writing
 * is what keeps the version single-sourced: the field is copied, never retyped.
 */
function trimManifest(full: Record<string, unknown>): string {
  const keepScripts = ["start", "dev"] as const;
  const scripts = (full.scripts ?? {}) as Record<string, string>;
  const trimmed: Record<string, unknown> = {
    name: full.name,
    description: full.description,
    version: full.version,
    private: full.private,
    type: full.type,
    scripts: Object.fromEntries(
      keepScripts.filter((k) => scripts[k] !== undefined).map((k) => [k, scripts[k]]),
    ),
  };
  return `${JSON.stringify(trimmed, null, 2)}\n`;
}

/** Drop the README's pointer at CLAUDE.md — that file does not ship. */
function trimReadme(text: string): string {
  return text.replace(/\n---\n\n개발·설계 문서는[\s\S]*$/, "\n");
}

function toCrlf(p: string): void {
  const body = fs.readFileSync(p);
  const normalised = body.toString("binary").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  fs.writeFileSync(p, Buffer.from(normalised, "binary"));
}

// ---- build ------------------------------------------------------------------

const manifest = JSON.parse(read(path.join(ROOT, "package.json"))) as Record<string, unknown>;
const version = manifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  fail(`package.json 의 version 이 유효하지 않다: ${String(version)}`);
}

const name = `aidlc-dashboard-${version}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pkg-"));
const stage = path.join(work, "aidlc-dashboard");
fs.mkdirSync(stage, { recursive: true });

const implFiles = copyImplementation(path.join(ROOT, "src"), path.join(stage, "src"));
for (const rel of INCLUDE) fs.copyFileSync(path.join(ROOT, rel), path.join(stage, rel));
fs.writeFileSync(path.join(stage, "package.json"), trimManifest(manifest));
fs.writeFileSync(path.join(stage, "README.md"), trimReadme(read(path.join(stage, "README.md"))));
for (const rel of CRLF_FILES) toCrlf(path.join(stage, rel));
fs.chmodSync(path.join(stage, "start.sh"), 0o755);

// ---- audit (before writing anything the operator might send) ----------------

const staged = walk(stage);
const violations: string[] = [];
for (const rel of staged) {
  const posix = rel.split(path.sep).join("/");
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(posix)) violations.push(`${posix} — ${why}`);
  }
}
for (const rel of staged) {
  const body = read(path.join(stage, rel));
  // The reason is named; the match is redacted to three characters. A build log that
  // prints the secret in full to prove it found one has published it again.
  for (const { pattern, why } of SECRETS) {
    const m = pattern.exec(body);
    if (m) violations.push(`${rel} — ${why} [${(m[0] ?? "").trim().slice(0, 3)}…]`);
  }
}
if (violations.length > 0) {
  console.error("✗ 유출 감사 실패 — 아카이브를 만들지 않았다:");
  for (const v of violations) console.error(`    ${v}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// ---- archive ----------------------------------------------------------------

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "dist");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${name}.zip`);
fs.rmSync(out, { force: true });

const zip = spawnSync("zip", ["-rq", out, "aidlc-dashboard", "-x", "*.DS_Store"], { cwd: work });
if (zip.status !== 0) {
  fs.rmSync(work, { recursive: true, force: true });
  fail(`zip 실패: ${zip.stderr?.toString() ?? `exit ${zip.status}`}`);
}
fs.rmSync(work, { recursive: true, force: true });

const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✓ ${out}`);
console.log(`  v${version} · ${staged.length}개 파일 (구현 ${implFiles}) · ${kb}KB`);
console.log(
  `  유출 감사: 경로 ${FORBIDDEN.length}개 + 내용 ${SECRETS.length}개 통과${customers.rootsFound.length === 0 ? " ⚠ 고객사 목록 원천 없음 — 이름은 미검사" : ""}`,
);
console.log("  저장소 전체 감사는 별도다 — `bun run audit`");
