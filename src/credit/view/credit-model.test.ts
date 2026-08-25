// CreditModelAssembler 유닛 테스트 — u3-credit-view (Step 5).
//
// 러너: bun:test. now 주입으로 stale 10분 경계를 결정적으로 검증한다. store 는 읽기 전용
// {latest, readAll} 스텁을 주입(실제 저장소·네트워크 미접근). 상태와 독립 신선도,
// loading/none/ok/partial/failure + lastSuccessAt 파생을 커버한다.

import { describe, expect, test } from "bun:test";
import type { CreditSnapshot, ParsedUsage } from "../types";
import { assembleCredit } from "./credit-model";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const TEN_MIN = 10 * 60 * 1000;

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

function ok(sequence: number, capturedAt: string, data: ParsedUsage = usage()): CreditSnapshot {
  return { sequence, capturedAt, source: "auto", ok: true, data };
}

function fail(sequence: number, capturedAt: string): CreditSnapshot {
  return {
    sequence,
    capturedAt,
    source: "manual",
    ok: false,
    raw: "some non-contract /usage output",
    reason: "parse-failure",
  };
}

/** 읽기 전용 store 스텁. latest=최대 sequence, readAll=capturedAt→sequence 정렬 전제. */
function stubStore(snaps: CreditSnapshot[]): {
  latest(): CreditSnapshot | null;
  readAll(): CreditSnapshot[];
} {
  const sorted = [...snaps].sort((a, b) => {
    if (a.capturedAt < b.capturedAt) return -1;
    if (a.capturedAt > b.capturedAt) return 1;
    return a.sequence - b.sequence;
  });
  const bySeq = [...snaps].sort((a, b) => a.sequence - b.sequence);
  return {
    latest: () => bySeq[bySeq.length - 1] ?? null,
    readAll: () => sorted,
  };
}

/** now 기준 minutesAgo 분 전 ISO. */
function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60 * 1000).toISOString();
}

describe("assembleCredit 상태 판정", () => {
  test("none: 스냅샷 0개 → status 'none', current/lastSuccessAt null", () => {
    const model = assembleCredit(stubStore([]), NOW, "30d");
    expect(model.status).toBe("none");
    expect(model.current).toBeNull();
    expect(model.lastSuccessAt).toBeNull();
    expect(model.warning).toBeNull();
    expect(model.freshness.stale).toBe(false);
    expect(model.trend.summary.count).toBe(0);
  });

  test("loading: 첫 수집 중이고 스냅샷 0개 → status 'loading'", () => {
    const model = assembleCredit(stubStore([]), NOW, "30d", true);
    expect(model.status).toBe("loading");
    expect(model.current).toBeNull();
  });

  test("ok: 최신 성공·신선(<10분) → status 'ok', current 채움", () => {
    const model = assembleCredit(stubStore([ok(1, minutesAgo(2))]), NOW, "30d");
    expect(model.status).toBe("ok");
    expect(model.current?.planName).toBe("Pro");
    expect(model.lastSuccessAt).toBe(minutesAgo(2));
    expect(model.warning).toBeNull();
  });

  test("partial: 최신 성공이 partial → status 'partial'", () => {
    const partialUsage = usage({ remainingAmount: null, partial: true });
    const model = assembleCredit(stubStore([ok(1, minutesAgo(3), partialUsage)]), NOW, "30d");
    expect(model.status).toBe("partial");
    expect(model.current?.partial).toBe(true);
  });

  test("stale: 마지막 성공 나이>10분 → 상태는 유지하고 freshness.stale=true", () => {
    const model = assembleCredit(stubStore([ok(1, minutesAgo(20))]), NOW, "30d");
    expect(model.status).toBe("ok");
    expect(model.freshness.stale).toBe(true);
    expect(model.current?.planName).toBe("Pro"); // 마지막 성공값 유지
  });

  test("failure: 최신이 실패 → status 'failure', warning{raw,reason}, 마지막 성공값 유지", () => {
    const model = assembleCredit(
      stubStore([ok(1, minutesAgo(3)), fail(2, minutesAgo(1))]),
      NOW,
      "30d",
    );
    expect(model.status).toBe("failure");
    expect(model.warning).toEqual({
      raw: "some non-contract /usage output",
      reason: "parse-failure",
    });
    expect(model.current?.planName).toBe("Pro"); // 마지막 성공값 유지
    expect(model.lastSuccessAt).toBe(minutesAgo(3));
  });

  test("최신 실패 + 마지막 성공 10분 초과 → failure와 stale을 동시에 보존", () => {
    const model = assembleCredit(
      stubStore([ok(1, minutesAgo(20)), fail(2, minutesAgo(1))]),
      NOW,
      "30d",
    );
    expect(model.status).toBe("failure");
    expect(model.freshness.stale).toBe(true);
  });
});

describe("assembleCredit 경계·파생", () => {
  test("10분 경계: 정확히 10분 → fresh, 10분 초과 → stale", () => {
    const atBoundary = new Date(NOW.getTime() - TEN_MIN).toISOString();
    const justOver = new Date(NOW.getTime() - TEN_MIN - 1000).toISOString();
    expect(assembleCredit(stubStore([ok(1, atBoundary)]), NOW, "30d").freshness.stale).toBe(false);
    expect(assembleCredit(stubStore([ok(1, justOver)]), NOW, "30d").freshness.stale).toBe(true);
  });

  test("lastSuccessAt: ok=true 최신에서 파생(실패가 더 최신이어도 마지막 성공 기준)", () => {
    const model = assembleCredit(
      stubStore([ok(1, minutesAgo(5)), ok(2, minutesAgo(3)), fail(3, minutesAgo(1))]),
      NOW,
      "30d",
    );
    expect(model.lastSuccessAt).toBe(minutesAgo(3));
    expect(model.current?.planName).toBe("Pro");
  });

  test("실패만 존재(성공 이력 없음) → status 'failure', current/lastSuccessAt null", () => {
    const model = assembleCredit(stubStore([fail(1, minutesAgo(2))]), NOW, "30d");
    expect(model.status).toBe("failure");
    expect(model.current).toBeNull();
    expect(model.lastSuccessAt).toBeNull();
    expect(model.warning?.reason).toBe("parse-failure");
  });

  test("trend 는 주입 창으로 집계된다", () => {
    const model = assembleCredit(stubStore([ok(1, minutesAgo(3))]), NOW, "7d");
    expect(model.trend.window).toBe("7d");
    expect(model.trend.summary.count).toBe(1);
  });
});
