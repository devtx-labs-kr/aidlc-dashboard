/**
 * 추이 집계 — 스냅샷 시계열을 창(7일/30일/전체)별 TrendSeries로 변환한다(BR3.1·BR3.4).
 *
 * 순수 함수. u4(host 배선)가 저장소에서 읽은 스냅샷을 조회용으로 집계한다(저장소는 집계를
 * 모른다, 단방향 계층). 실패/부분 스냅샷은 value=null 결측 지점으로 표현해 정상 값과
 * 구분한다. 기존 credit-dashboard `src/server/trend.ts`의 충실 포팅이며, 추이 타입(TrendWindow·
 * TrendPoint·TrendSummary·TrendSeries)의 소유·정의를 u3로 이관한다(producer-owned).
 */

import type { CreditSnapshot } from "../types";

/** 추이 그래프의 시간 창(BR3.2). u3 소유 타입. */
export type TrendWindow = "7d" | "30d" | "all";

/** 추이 그래프의 단일 지점. 결측(실패/부분)을 정상 값과 구분한다(BR3.4). u3 소유 타입. */
export interface TrendPoint {
  /** 캡처 시각(ISO 8601). */
  ts: string;
  /** 누적 사용량 값. 실패/결측이면 null(선 끊김으로 표현). */
  value: number | null;
  /** 이 지점이 정상(값 있음) 스냅샷인지 여부. */
  ok: boolean;
}

/** 추이 차트에 병기하는 텍스트 요약(접근성 — 최신/최소/최대). u3 소유 타입. */
export interface TrendSummary {
  latest: number | null;
  min: number | null;
  max: number | null;
  /** 창 내 정상(값 있음) 지점 수. */
  count: number;
}

/** 창별 집계 결과. u3 소유 타입(u4가 import 해 배선). */
export interface TrendSeries {
  window: TrendWindow;
  points: TrendPoint[];
  summary: TrendSummary;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 창별 룩백 기간(ms). "all"은 무제한. */
const WINDOW_MS: Record<Exclude<TrendWindow, "all">, number> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

/** 라인 차트에 그릴 최대 지점 수. 초과 시 균등 다운샘플링한다(NFR3.2). */
const DEFAULT_MAX_POINTS = 500;

/** 스냅샷 하나를 추이 지점으로 변환. 값이 없는(실패/부분) 지점은 value=null. */
function toPoint(s: CreditSnapshot): TrendPoint {
  if (s.ok && s.data.usedAmount !== null) {
    return { ts: s.capturedAt, value: s.data.usedAmount, ok: true };
  }
  return { ts: s.capturedAt, value: null, ok: false };
}

/**
 * 균등 다운샘플링. 첫·마지막 지점은 항상 유지한다. maxPoints 이하이면 원본 그대로.
 */
function downsample(points: TrendPoint[], maxPoints: number): TrendPoint[] {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const result: TrendPoint[] = [];
  const stride = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * stride);
    const p = points[Math.min(idx, points.length - 1)];
    if (p !== undefined) result.push(p);
  }
  return result;
}

/**
 * 스냅샷 배열 → 창별 TrendSeries.
 * @param snapshots 저장소에서 읽은 스냅샷(시간순 가정, 방어적으로 재정렬).
 * @param window    7일/30일/전체.
 * @param now       기준 시각(테스트 주입 가능).
 * @param maxPoints 다운샘플 상한(기본 500).
 */
export function buildTrend(
  snapshots: CreditSnapshot[],
  window: TrendWindow,
  now: Date = new Date(),
  maxPoints: number = DEFAULT_MAX_POINTS,
): TrendSeries {
  const nowMs = now.getTime();

  const filtered = snapshots.filter((s) => {
    if (window === "all") return true;
    const t = Date.parse(s.capturedAt);
    if (Number.isNaN(t)) return false; // 파싱 불가한 타임스탬프는 창 필터에서 제외
    return nowMs - t <= WINDOW_MS[window];
  });

  // 방어적 시간순 정렬(저장소가 정렬을 보장하지만 순수 함수 독립성 유지).
  filtered.sort((a, b) => {
    if (a.capturedAt < b.capturedAt) return -1;
    if (a.capturedAt > b.capturedAt) return 1;
    return a.sequence - b.sequence;
  });

  const allPoints = filtered.map(toPoint);
  const points = downsample(allPoints, maxPoints);

  const values: number[] = [];
  for (const p of points) {
    if (p.value !== null) values.push(p.value);
  }

  const summary: TrendSummary = {
    latest: values.length > 0 ? (values[values.length - 1] ?? null) : null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    count: values.length,
  };

  return { window, points, summary };
}
