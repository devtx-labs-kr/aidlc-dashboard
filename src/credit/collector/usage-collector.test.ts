/**
 * UsageCollector 테스트 — 주입 가능한 spawn으로 성공/타임아웃/비정상 종료/빈 출력/실행 오류/
 * 512KB 절단/argv 정확성/env allowlist를 격리 검증한다. 실제 kiro-cli를 절대 호출하지 않는다(NFR5).
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_STDOUT_BYTES,
  type SpawnFn,
  type SpawnOutcome,
  USAGE_ARGV,
  buildMinimalEnv,
  collectUsage,
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
