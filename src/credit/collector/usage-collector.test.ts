/**
 * UsageCollector 테스트 — 주입 가능한 spawn으로 성공/타임아웃/비정상 종료/빈 출력/실행 오류/
 * 512KB 절단/argv 정확성/env allowlist를 격리 검증한다. 실제 kiro-cli를 절대 호출하지 않는다(NFR5).
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본.
 *
 * 맨 아래 `defaultSpawn` 블록만 실제 프로세스를 띄운다. 띄우는 대상은 **테스트를 돌리고 있는
 * bun 자신**(`process.execPath`)이라 외부 CLI·네트워크·워크스페이스에 의존하지 않는다 —
 * 네이티브 타임아웃이 실제로 무는지는 스텁으로는 검증할 수 없고, 여기서 회귀한 결함(SIGTERM을
 * 무시하는 자식에서 영구 대기)이 정확히 이 경로에 있었다.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_STDOUT_BYTES,
  type SpawnFn,
  type SpawnOutcome,
  USAGE_ARGV,
  buildMinimalEnv,
  collectUsage,
  defaultSpawn,
} from "./usage-collector";

/** 고정 결과를 돌려주는 스텁 spawn 생성기. 호출 인자를 기록한다. */
function stubSpawn(outcome: SpawnOutcome): {
  fn: SpawnFn;
  calls: Array<{ argv: string[]; env: Record<string, string> }>;
} {
  const calls: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const fn: SpawnFn = async (argv, opts) => {
    calls.push({ argv, env: opts.env });
    return outcome;
  };
  return { fn, calls };
}

describe("UsageCollector", () => {
  test("정상 출력이면 ok:true 와 원문 raw 반환", async () => {
    const { fn } = stubSpawn({
      exitCode: 0,
      stdout: "Plan: Pro\nUsed: 100\n",
      stderr: "",
      timedOut: false,
    });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.raw).toContain("Plan: Pro");
  });

  test("정확한 argv로 호출하고 셸 보간을 쓰지 않는다", async () => {
    const { fn, calls } = stubSpawn({
      exitCode: 0,
      stdout: "Used: 1\n",
      stderr: "",
      timedOut: false,
    });
    await collectUsage({ spawn: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([...USAGE_ARGV]);
    // "/usage"가 하나의 인자 토큰으로 전달되는지(문자열로 조립되지 않음) 확인.
    expect(calls[0]?.argv).toContain("/usage");
    expect(calls[0]?.argv).toContain("--no-interactive");
  });

  test("타임아웃은 실패로 분류하고 사유에 타임아웃 표기", async () => {
    const { fn } = stubSpawn({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const result = await collectUsage({ spawn: fn, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("타임아웃");
  });

  test("비정상 종료(non-zero exit)는 실패로 분류하고 stderr를 detail로 보존", async () => {
    const { fn } = stubSpawn({
      exitCode: 1,
      stdout: "",
      stderr: "not authenticated",
      timedOut: false,
    });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("비정상 종료");
    expect(result.detail).toContain("not authenticated");
  });

  test("빈 출력은 실패로 분류", async () => {
    const { fn } = stubSpawn({ exitCode: 0, stdout: "   \n", stderr: "", timedOut: false });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("빈 출력");
  });

  test("stdout이 비고 stderr에 패널이 있으면(exit 0) stderr를 원문으로 사용", async () => {
    // 일부 kiro-cli 빌드는 /usage 패널을 stderr로 렌더한다.
    const { fn } = stubSpawn({
      exitCode: 0,
      stdout: "",
      stderr:
        "Estimated Usage | resets on 9-1-2026 | KIRO POWER\nCredits (1 of 2 covered in plan)\n",
      timedOut: false,
    });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.raw).toContain("KIRO POWER");
  });

  test("spawn이 throw해도 예외를 삼키고 실패 결과로 반환", async () => {
    const fn: SpawnFn = async () => {
      throw new Error("ENOENT: kiro-cli not found");
    };
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("프로세스 실행 오류");
    expect(result.detail).toContain("ENOENT");
  });

  test("512KB를 초과하는 stdout은 512KB 지점에서 절단한다(security-design NFR1.4)", async () => {
    // 512KB + 여분의 ASCII 문자를 stdout으로 반환하는 스텁.
    const oversized = "A".repeat(MAX_STDOUT_BYTES + 4096);
    const { fn } = stubSpawn({ exitCode: 0, stdout: oversized, stderr: "", timedOut: false });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // ASCII 1바이트=1문자이므로 바이트 상한이 곧 문자 상한. 512KB로 절단됨.
    expect(Buffer.byteLength(result.raw, "utf8")).toBe(MAX_STDOUT_BYTES);
    expect(result.raw.length).toBe(MAX_STDOUT_BYTES);
  });

  test("buildMinimalEnv는 허용 키만 통과시킨다(least privilege)", () => {
    const env = buildMinimalEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      AWS_SECRET_ACCESS_KEY: "leak-me",
      SOME_TOKEN: "secret",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
  });

  test("env allowlist: 비허용 키를 담은 envSource로도 전달 env에 그 키가 없다", async () => {
    const { fn, calls } = stubSpawn({
      exitCode: 0,
      stdout: "Used: 1\n",
      stderr: "",
      timedOut: false,
    });
    await collectUsage({
      spawn: fn,
      envSource: {
        PATH: "/usr/bin",
        HOME: "/home/u",
        XDG_CONFIG_HOME: "/home/u/.config",
        AWS_SECRET_ACCESS_KEY: "leak-me",
        GITHUB_TOKEN: "secret",
      },
    });
    const passedEnv = calls[0]?.env ?? {};
    expect(passedEnv.PATH).toBe("/usr/bin");
    expect(passedEnv.HOME).toBe("/home/u");
    expect(passedEnv.XDG_CONFIG_HOME).toBe("/home/u/.config");
    expect(passedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(passedEnv.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("defaultSpawn(네이티브 타임아웃)", () => {
  /** bun 자신을 인라인 스크립트로 띄운다. 절대 경로라 PATH도 필요 없다(env는 빈 집합). */
  function bunScript(source: string): string[] {
    return [process.execPath, "-e", source];
  }

  test("정상 종료면 stdout을 그대로 돌려주고 timedOut=false", async () => {
    const outcome = await defaultSpawn(bunScript('process.stdout.write("Used: 1\\n");'), {
      timeoutMs: 5_000,
      env: {},
    });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("Used: 1\n");
  });

  test("비정상 종료면 exitCode와 stderr를 보존한다", async () => {
    const outcome = await defaultSpawn(
      bunScript('process.stderr.write("not authenticated\\n"); process.exit(3);'),
      { timeoutMs: 5_000, env: {} },
    );
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderr).toContain("not authenticated");
  });

  test("SIGTERM을 무시하는 자식도 시한 안에 종료되고 timedOut=true", async () => {
    // 손으로 걸던 타임아웃은 SIGTERM만 보냈으므로 이 자식에서 영구 대기했다(회귀 방어).
    const started = Date.now();
    const outcome = await defaultSpawn(
      bunScript('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'),
      { timeoutMs: 300, env: {} },
    );
    expect(outcome.timedOut).toBe(true);
    // 시그널 종료이므로 exitCode는 계약대로 null이다.
    expect(outcome.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("collectUsage는 defaultSpawn의 타임아웃을 실패 사유로 승격한다", async () => {
    const result = await collectUsage({
      spawn: (_argv, opts) =>
        defaultSpawn(bunScript('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'), {
          ...opts,
          timeoutMs: 300,
        }),
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("타임아웃");
  });
});
