/**
 * UsageParser 테스트 — team.md ## Testing Posture의 5축 골든 픽스처로 커버한다:
 *  (1) 정상 포맷 다수 변형  (2) 완전 파싱 실패  (3) 부분 파싱
 *  (4) 경계값               (5) 폴백 트리거(원문·사유 보존)
 * CLI를 호출하지 않는다(순수 함수, 문자열 입력). aidlc-dashboard 네이티브 트리로 흡수한 포팅본.
 */

import { describe, expect, test } from "bun:test";
import { parseUsage } from "./usage-parser";

const FIXTURE_DIR = `${import.meta.dir}/fixtures`;

async function loadFixture(name: string): Promise<string> {
  return await Bun.file(`${FIXTURE_DIR}/${name}`).text();
}

describe("UsageParser — 축1: 정상 포맷 다수 변형", () => {
  test("한국어 라벨 + 천단위 콤마 + % 를 모두 정상 추출", async () => {
    const result = parseUsage(await loadFixture("normal-ko.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Pro");
    expect(result.data.usedAmount).toBe(4553.86);
    expect(result.data.remainingAmount).toBe(5446.14);
    expect(result.data.planLimit).toBe(10000);
    expect(result.data.usageRatio).toBeCloseTo(0.455, 5);
    expect(result.data.resetDate).toBe("2026-09-01");
    expect(result.data.partial).toBe(false);
  });

  test("영어 라벨 콜론 구분 포맷도 동일하게 추출", async () => {
    const result = parseUsage(await loadFixture("normal-en.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Pro");
    expect(result.data.usedAmount).toBe(4553.86);
    expect(result.data.planLimit).toBe(10000);
    expect(result.data.partial).toBe(false);
  });

  test("등호 구분 + 정렬 공백 + 'Usage rate' 별칭 변형 추출", async () => {
    const result = parseUsage(await loadFixture("normal-spaced.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Team");
    expect(result.data.usedAmount).toBe(120.5);
    expect(result.data.remainingAmount).toBe(9879.5);
    // "1.205 %" → 0.01205
    expect(result.data.usageRatio).toBeCloseTo(0.01205, 6);
    expect(result.data.resetDate).toBe("2026-12-31");
    expect(result.data.partial).toBe(false);
  });

  test("실제 KIRO 패널 포맷(파이프 헤더 + '(X of Y)' + 진행 막대 %)을 휴리스틱으로 추출", async () => {
    const result = parseUsage(await loadFixture("kiro-power-panel.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("KIRO POWER");
    expect(result.data.usedAmount).toBe(4553);
    expect(result.data.planLimit).toBe(10000);
    // 진행 막대의 "45%"를 우선 사용.
    expect(result.data.usageRatio).toBeCloseTo(0.45, 5);
    // 잔량은 명시되지 않았으나 limit - used로 파생.
    expect(result.data.remainingAmount).toBe(5447);
    expect(result.data.resetDate).toBe("9-1-2026");
    expect(result.data.partial).toBe(false);
  });
});

describe("UsageParser — 축2: 완전 파싱 실패", () => {
  test("빈/공백 출력은 실패이며 사유를 담는다", async () => {
    const result = parseUsage(await loadFixture("fail-empty.txt"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("빈 출력");
  });

  test("빈 문자열 직접 입력도 실패", () => {
    const result = parseUsage("");
    expect(result.ok).toBe(false);
  });

  test("CLI 에러 메시지는 지표가 없어 실패로 분류", async () => {
    const raw = await loadFixture("fail-cli-error.txt");
    const result = parseUsage(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.raw).toBe(raw);
  });

  test("예상치 못한 헤더(도움말 텍스트)는 실패로 분류", async () => {
    const result = parseUsage(await loadFixture("fail-unexpected-header.txt"));
    expect(result.ok).toBe(false);
  });
});

describe("UsageParser — 축3: 부분 파싱", () => {
  test("플랜명·리셋일 누락 시 획득 필드만 채우고 partial=true", async () => {
    const result = parseUsage(await loadFixture("partial-missing-reset-plan.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBe(800);
    expect(result.data.remainingAmount).toBe(9200);
    expect(result.data.planLimit).toBe(10000);
    // 사용률은 used/limit로 보강된다.
    expect(result.data.usageRatio).toBeCloseTo(0.08, 5);
    expect(result.data.planName).toBeNull();
    expect(result.data.resetDate).toBeNull();
    expect(result.data.partial).toBe(true);
  });
});

describe("UsageParser — 축4: 경계값", () => {
  test("0 크레딧을 null이 아닌 0으로 보존", async () => {
    const result = parseUsage(await loadFixture("zero-credits.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBe(0);
    expect(result.data.usageRatio).toBe(0);
    expect(result.data.partial).toBe(false);
  });

  test("매우 큰 값을 정밀도 손실 없이 추출", async () => {
    const result = parseUsage(await loadFixture("large-values.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBe(987654321.99);
    expect(result.data.planLimit).toBe(1000000000);
  });

  test("비수치 토큰은 null, 음수는 그대로 보존", async () => {
    const result = parseUsage(await loadFixture("boundary-nonnumeric-negative.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBeNull(); // "N/A"
    expect(result.data.remainingAmount).toBe(-50); // 음수 보존
    expect(result.data.usageRatio).toBeNull(); // "not available" + used 없음 → 보강 불가
    expect(result.data.resetDate).toBe("unknown");
    expect(result.data.partial).toBe(true);
  });
});

describe("UsageParser — 축5: 폴백 트리거(원문·사유 보존) & 무예외", () => {
  test("실패 시 원문(raw)과 사유(reason)를 함께 보존한다", () => {
    const raw = "완전히 알 수 없는 포맷 blah blah";
    const result = parseUsage(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.raw).toBe(raw);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("ANSI 색상 코드가 섞여도 크래시 없이 파싱", () => {
    const raw = "\x1b[32mPlan: Pro\x1b[0m\nUsed: 100\nLimit: 200\n";
    const result = parseUsage(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Pro");
    expect(result.data.usedAmount).toBe(100);
    expect(result.data.usageRatio).toBeCloseTo(0.5, 5);
  });

  test("어떤 입력에도 예외를 던지지 않는다(값으로만 반환)", () => {
    // @ts-expect-error 의도적으로 잘못된 타입 주입 — 방어 확인.
    expect(() => parseUsage(null)).not.toThrow();
    // @ts-expect-error 의도적으로 잘못된 타입 주입 — 방어 확인.
    expect(() => parseUsage(undefined)).not.toThrow();
    // @ts-expect-error 의도적으로 잘못된 타입 주입 — 방어 확인.
    expect(() => parseUsage(12345)).not.toThrow();
  });
});
