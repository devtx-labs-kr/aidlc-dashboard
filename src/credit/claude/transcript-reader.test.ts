/**
 * transcript-reader 단위 테스트.
 *
 * 실제 `~/.claude/projects`를 절대 읽지 않는다 — `home`을 주입해 임시 디렉터리에 합성
 * 트랜스크립트를 만들고, `now`를 주입해 창 경계를 결정론적으로 고정한다.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMemo,
  findTranscriptDir,
  projectSlug,
  readTranscripts,
  totalOf,
} from "./transcript-reader";

const NOW = new Date("2026-08-26T12:00:00Z");

interface LineOpts {
  ts: string;
  session?: string;
  model?: string;
  sidechain?: boolean;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  thinking?: number;
  cwd?: string;
}

/** usage를 들고 있는 assistant 줄 하나. */
function line(o: LineOpts): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: o.ts,
    sessionId: o.session ?? "s1",
    cwd: o.cwd ?? "/ws",
    isSidechain: o.sidechain ?? false,
    message: {
      model: o.model ?? "claude-opus-5",
      usage: {
        input_tokens: o.input ?? 10,
        output_tokens: o.output ?? 100,
        cache_read_input_tokens: o.cacheRead ?? 1000,
        cache_creation_input_tokens: o.cacheCreate ?? 50,
        output_tokens_details: { thinking_tokens: o.thinking ?? 40 },
      },
    },
  });
}

/** usage가 없는 줄(user 메시지 등) — 사전 필터가 걸러야 한다. */
function userLine(ts: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "hi" } });
}

interface Tree {
  home: string;
  root: string;
  dir: string;
  /** 파일을 쓰고 mtime을 고정한다. */
  write(name: string, lines: string[], mtime?: Date): string;
}

/** 임시 홈 + 워크스페이스 루트 + 그에 대응하는 트랜스크립트 디렉터리. */
function tree(rootName = "ws"): Tree {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-tr-"));
  const home = path.join(base, "home");
  const root = path.join(base, rootName);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(home, ".claude", "projects", projectSlug(root));
  fs.mkdirSync(dir, { recursive: true });
  return {
    home,
    root,
    dir,
    write(name, lines, mtime) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, `${lines.join("\n")}\n`);
      if (mtime) fs.utimesSync(p, mtime, mtime);
      return p;
    },
  };
}

describe("projectSlug", () => {
  test("`/`·`.`·`_` 를 `-` 로 바꾸고 대문자는 보존한다", () => {
    expect(projectSlug("/Users/me/Development/aidlc-dashboard")).toBe(
      "-Users-me-Development-aidlc-dashboard",
    );
    // 실측한 케이스: `_accounts` 가 `--accounts` 로 접힌다.
    expect(projectSlug("/Users/me/Development/ai-dlc/_accounts/AcmeCorp/x")).toBe(
      "-Users-me-Development-ai-dlc--accounts-AcmeCorp-x",
    );
    expect(projectSlug("/a/.hidden/b")).toBe("-a--hidden-b");
  });
});

describe("findTranscriptDir", () => {
  test("slug 규칙으로 1차 발견", () => {
    const t = tree();
    t.write("a.jsonl", [line({ ts: "2026-08-25T10:00:00Z" })]);
    expect(findTranscriptDir(t.root, t.home)).toBe(t.dir);
  });

  test("slug 가 어긋나도 트랜스크립트의 cwd 로 2차 발견", () => {
    const t = tree();
    // slug 디렉터리를 엉뚱한 이름으로 옮겨 1차 탐색을 실패시킨다.
    const renamed = path.join(path.dirname(t.dir), "-totally-different-name");
    fs.renameSync(t.dir, renamed);
    fs.writeFileSync(
      path.join(renamed, "a.jsonl"),
      `${line({ ts: "2026-08-25T10:00:00Z", cwd: t.root })}\n`,
    );
    expect(findTranscriptDir(t.root, t.home)).toBe(renamed);
  });

  test("어디에도 없으면 undefined", () => {
    const t = tree();
    fs.rmSync(t.dir, { recursive: true, force: true });
    expect(findTranscriptDir(t.root, t.home)).toBeUndefined();
  });
});

describe("readTranscripts", () => {
  test("토큰·세션·메시지를 집계한다", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [
        userLine("2026-08-25T09:00:00Z"),
        line({ ts: "2026-08-25T10:00:00Z", session: "s1" }),
        line({ ts: "2026-08-25T11:00:00Z", session: "s2" }),
      ],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });

    expect(agg.dir).toBe(t.dir);
    expect(agg.messages).toBe(2);
    expect(agg.sessions).toBe(2);
    expect(agg.totals).toEqual({
      input: 20,
      output: 200,
      cacheRead: 2000,
      cacheCreate: 100,
      thinking: 80,
    });
    // thinking 은 output 의 부분집합이므로 총량에 더하지 않는다.
    expect(totalOf(agg.totals)).toBe(2320);
    expect(agg.filesRead).toBe(1);
    expect(agg.malformedLines).toBe(0);
  });

  test("모델별로 분해하고 총량 내림차순으로 정렬한다", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [
        line({ ts: "2026-08-25T10:00:00Z", model: "claude-haiku-4-5", output: 10, cacheRead: 0 }),
        line({ ts: "2026-08-25T10:05:00Z", model: "claude-opus-5", output: 900, cacheRead: 5000 }),
      ],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.byModel.map((m) => m.model)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
    expect(agg.byModel[0]?.totals.output).toBe(900);
    expect(agg.byModel[1]?.messages).toBe(1);
  });

  test("일별 시계열을 날짜 오름차순으로 만든다", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [
        line({ ts: "2026-08-24T10:00:00Z", output: 100 }),
        line({ ts: "2026-08-25T10:00:00Z", output: 200 }),
        line({ ts: "2026-08-25T12:00:00Z", output: 300 }),
      ],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.daily.length).toBe(2);
    expect((agg.daily[0]?.date ?? "") < (agg.daily[1]?.date ?? "")).toBe(true);
    // 총량은 input+output+cacheRead+cacheCreate 의 합이다.
    expect(agg.daily.reduce((s, d) => s + d.total, 0)).toBe(totalOf(agg.totals));
  });

  test("서브에이전트 메시지를 따로 세면서 합계에는 포함한다", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [line({ ts: "2026-08-25T10:00:00Z" }), line({ ts: "2026-08-25T10:01:00Z", sidechain: true })],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.messages).toBe(2);
    expect(agg.sidechainMessages).toBe(1);
    expect(agg.totals.output).toBe(200);
  });

  test("창(mtime) 밖의 파일은 열지 않는다", () => {
    const t = tree();
    t.write("recent.jsonl", [line({ ts: "2026-08-25T10:00:00Z" })], NOW);
    t.write("old.jsonl", [line({ ts: "2026-01-01T10:00:00Z" })], new Date("2026-01-01T10:00:00Z"));

    const win7 = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(win7.filesRead).toBe(1);
    expect(win7.filesSkipped).toBe(1);
    expect(win7.messages).toBe(1);

    const all = readTranscripts(t.root, "all", { home: t.home, now: NOW });
    expect(all.filesRead).toBe(2);
    expect(all.filesSkipped).toBe(0);
    expect(all.messages).toBe(2);
  });

  test("깨진 줄은 세고 넘어간다 — 던지지 않는다", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      ['{"usage": broken json', line({ ts: "2026-08-25T10:00:00Z" }), '{"usage":'],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.malformedLines).toBe(2);
    expect(agg.messages).toBe(1);
  });

  test("트랜스크립트 디렉터리가 없으면 빈 집계 + 시도한 경로를 남긴다", () => {
    const t = tree();
    fs.rmSync(t.dir, { recursive: true, force: true });
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.dir).toBeNull();
    expect(agg.messages).toBe(0);
    expect(agg.triedPath).toContain(projectSlug(t.root));
  });

  test("음수·비정상 토큰 값은 0 으로 무해화한다", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [line({ ts: "2026-08-25T10:00:00Z", input: -5, output: Number.NaN, cacheRead: 7 })],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.totals.input).toBe(0);
    expect(agg.totals.output).toBe(0);
    expect(agg.totals.cacheRead).toBe(7);
  });

  test("메모는 (path,size,mtime) 가 같은 파일을 재파싱하지 않는다", () => {
    const t = tree();
    const p = t.write("a.jsonl", [line({ ts: "2026-08-25T10:00:00Z", output: 100 })], NOW);
    const memo = createMemo();

    const first = readTranscripts(t.root, "30d", { home: t.home, now: NOW, memo });
    expect(first.totals.output).toBe(100);
    expect(memo.files.size).toBe(1);

    // 내용을 바꾸되 바이트 길이와 mtime 을 그대로 복원한다 — 메모 키가 같으므로 이전
    // 집계가 재사용되어야 한다. 이것이 이 메모가 "시각 기반 캐시"가 아니라는 증거다.
    const before = fs.statSync(p);
    const replaced = line({ ts: "2026-08-25T10:00:00Z", output: 999 });
    fs.writeFileSync(p, `${replaced.padEnd(before.size - 1, " ")}\n`);
    fs.utimesSync(p, before.mtime, before.mtime);
    expect(fs.statSync(p).size).toBe(before.size);

    const second = readTranscripts(t.root, "30d", { home: t.home, now: NOW, memo });
    expect(second.totals.output).toBe(100);
    expect(memo.files.size).toBe(1);

    // mtime 이 움직이면 메모를 비껴가 새 내용이 읽힌다.
    const later = new Date(before.mtimeMs + 60_000);
    fs.utimesSync(p, later, later);
    const third = readTranscripts(t.root, "30d", { home: t.home, now: NOW, memo });
    expect(third.totals.output).toBe(999);
    // 그리고 같은 path 의 옛 엔트리는 지워진다 — 안 지우면 append 마다 죽은 키가 쌓여
    // 상한까지 차고 살아있는 엔트리를 밀어낸다.
    expect(memo.files.size).toBe(1);
  });

  test("디렉터리 미검출도 메모한다 — 미스가 정상 케이스이므로", () => {
    const t = tree();
    fs.rmSync(t.dir, { recursive: true, force: true });
    // 훑을 대상이 있어야 폴백 경로가 실제로 돈다.
    const decoy = path.join(t.home, ".claude", "projects", "-somewhere-else");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(
      path.join(decoy, "a.jsonl"),
      `${line({ ts: "2026-08-25T10:00:00Z", cwd: "/other/ws" })}\n`,
    );

    const memo = createMemo();
    expect(findTranscriptDir(t.root, t.home, memo)).toBeUndefined();
    expect(memo.dirs.size).toBe(1);
    expect([...memo.dirs.values()]).toEqual([null]); // 미스를 null 로 기억한다
    // 두 번째 호출은 메모에서 답한다(같은 결과).
    expect(findTranscriptDir(t.root, t.home, memo)).toBeUndefined();
    expect(memo.dirs.size).toBe(1);
  });

  test("청크 경계를 넘는 멀티바이트·장문 줄을 정확히 읽는다", () => {
    const t = tree();
    // 1MB 청크를 여러 번 넘기도록 큰 한글 패딩을 넣는다. 경계가 UTF-8 시퀀스를 가르면
    // 스트리밍 디코드가 아니면 글자가 깨지고 JSON.parse 가 실패한다.
    const padding = "한글패딩".repeat(90_000); // 약 1.4MB (UTF-8 3바이트/글자)
    const fat = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-25T10:00:00Z",
      sessionId: "s1",
      cwd: t.root,
      note: padding,
      message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 7 } },
    });
    t.write("big.jsonl", [fat, line({ ts: "2026-08-25T11:00:00Z", output: 3 })], NOW);

    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.messages).toBe(2);
    expect(agg.malformedLines).toBe(0);
    expect(agg.totals.output).toBe(10); // 7 + 3 — 두 줄 모두 온전히 파싱됐다
  });

  test("첫 레코드가 머리 크기를 넘어도 cwd 를 찾아낸다 (정규식 폴백)", () => {
    const t = tree();
    const renamed = path.join(path.dirname(t.dir), "-slug-does-not-match");
    fs.renameSync(t.dir, renamed);
    // cwd 는 앞쪽에 두고, 뒤에 16KB 를 넘는 본문을 붙여 첫 줄을 머리에서 잘리게 만든다.
    const huge = JSON.stringify({
      cwd: t.root,
      type: "assistant",
      timestamp: "2026-08-25T10:00:00Z",
      body: "x".repeat(40_000),
    });
    fs.writeFileSync(path.join(renamed, "a.jsonl"), `${huge}\n`);
    expect(findTranscriptDir(t.root, t.home)).toBe(renamed);
  });
});
