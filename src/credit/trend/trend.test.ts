// TrendAggregator 유닛 테스트 — u3-credit-view (Step 1).
//
// 러너: bun:test. 순수 함수 buildTrend 를 now 주입으로 결정적으로 검증한다. 실제
// 저장소·네트워크 미접근. 창 필터·정렬·결측 보존·다운샘플·summary·빈 입력을 커버한다.

import { describe, expect, test } from "bun:test";
import type { CreditSnapshot, ParsedUsage } from "../types";
import { buildTrend } from "./trend";

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** 성공 스냅샷 팩토리. usedAmount 를 추이 값으로 싣는다. */
function ok(sequence: number, capturedAt: string, usedAmount: number | null): CreditSnapshot {
  const data: ParsedUsage = {
    planName: "Pro",
    usedAmount,
    remainingAmount: usedAmount === null ? null : 500 - usedAmount,
    planLimit: 500,
    usageRatio: usedAmount === null ? null : usedAmount / 500,
    resetDate: "2026-09-01",
    partial: usedAmount === null,
  };
  return { sequence, capturedAt, source: "auto", ok: true, data };
}

/** 실패 스냅샷 팩토리 — 추이에서는 결측(value=null) 지점이 되어야 한다. */
function fail(sequence: number, capturedAt: string): CreditSnapshot {
  return {
    sequence,
    capturedAt,
    source: "manual",
    ok: false,
    raw: "some non-contract output",
    reason: "parse-failure",
  };
}

/** now 기준 daysAgo 일 전 ISO 문자열. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("buildTrend 창 필터", () => {
  test("7d: 7일 밖 스냅샷 제외(now 주입)", () => {
    const snaps = [ok(1, daysAgo(10), 100), ok(2, daysAgo(3), 200), ok(3, daysAgo(1), 300)];
    const series = buildTrend(snaps, "7d", NOW);
    expect(series.points.map((p) => p.value)).toEqual([200, 300]);
    expect(series.summary.count).toBe(2);
  });

  test("30d: 30일 밖 스냅샷 제외", () => {
    const snaps = [ok(1, daysAgo(40), 100), ok(2, daysAgo(20), 200)];
    const series = buildTrend(snaps, "30d", NOW);
    expect(series.points.map((p) => p.value)).toEqual([200]);
  });

  test("all: 기간 제한 없이 전부 포함", () => {
    const snaps = [ok(1, daysAgo(400), 100), ok(2, daysAgo(1), 200)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points).toHaveLength(2);
  });
});

describe("buildTrend 정렬·결측·summary", () => {
  test("시간순 정렬: 뒤섞인 입력을 capturedAt→sequence 로 정렬", () => {
    const snaps = [ok(3, daysAgo(1), 300), ok(1, daysAgo(3), 100), ok(2, daysAgo(2), 200)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.map((p) => p.value)).toEqual([100, 200, 300]);
  });

  test("동시 캡처: 동일 capturedAt 은 sequence 로 안정 정렬", () => {
    const at = daysAgo(1);
    const snaps = [ok(6, at, 600), ok(5, at, 500)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.map((p) => p.value)).toEqual([500, 600]);
  });

  test("결측 보존: 실패/부분(usedAmount null) 스냅샷은 value=null 지점", () => {
    const snaps = [ok(1, daysAgo(3), 100), fail(2, daysAgo(2)), ok(3, daysAgo(1), null)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.map((p) => p.value)).toEqual([100, null, null]);
    expect(series.points.map((p) => p.ok)).toEqual([true, false, false]);
  });

  test("summary: latest/min/max/count 정확(값 있는 지점만 집계)", () => {
    const snaps = [ok(1, daysAgo(3), 100), fail(2, daysAgo(2)), ok(3, daysAgo(1), 300)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.summary).toEqual({ latest: 300, min: 100, max: 300, count: 2 });
  });
});

describe("buildTrend 다운샘플·빈 입력", () => {
  test("다운샘플: >500 지점 → ≤500, 첫·마지막 보존", () => {
    const snaps: CreditSnapshot[] = [];
    const total = 1200;
    for (let i = 0; i < total; i++) {
      // 과거→현재 순으로 촘촘히(value=i 오름차순, 시간도 오름차순).
      snaps.push(ok(i + 1, new Date(NOW.getTime() - (total - i) * 60_000).toISOString(), i));
    }
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.length).toBeLessThanOrEqual(500);
    expect(series.points.length).toBeGreaterThan(1);
    // 정렬 후 첫 지점(value 0)·마지막 지점(value 1199) 보존.
    expect(series.points[0]?.value).toBe(0);
    expect(series.points[series.points.length - 1]?.value).toBe(1199);
  });

  test("빈 입력: points=[], summary count=0, 나머지 null", () => {
    const series = buildTrend([], "30d", NOW);
    expect(series.points).toEqual([]);
    expect(series.summary).toEqual({ latest: null, min: null, max: null, count: 0 });
    expect(series.window).toBe("30d");
  });
});
