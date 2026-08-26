/**
 * ClaudeTokenModel — 트랜스크립트 집계를 표시용 뷰모델 `TokenViewModel`로 조립한다.
 *
 * Kiro 경로의 `assembleCredit`(u3)과 같은 자리를 차지하되, 신선도 개념이 다르다.
 *
 * Kiro는 원격 `/usage`를 폴링하므로 "마지막 성공이 10분 넘게 지났으면 stale"이 성립한다.
 * 반면 이 경로는 assemble마다 로컬 파일을 다시 읽으므로 **표시값이 구조적으로 항상
 * 최신**이다(host provenance의 `disk`가 정의상 fresh인 것과 같다). 마지막 활동이 오래됐다는
 * 것은 데이터가 낡았다는 뜻이 아니라 그동안 Claude Code를 쓰지 않았다는 사실이므로,
 * stale 배지 대신 `lastActivityAt`을 그대로 보여준다. 의미 없는 경고로 배지를 마비시키지
 * 않는다는 host 규율(freshness.ts의 state.md 판단과 동일한 논리)을 따른다.
 *
 * 순수 함수 — 파일 읽기는 transcript-reader가 하고, 이 모듈은 집계를 뷰모델로 옮긴다.
 */

import type { TrendSeries, TrendWindow } from "../trend/trend";
import {
  type ModelBreakdown,
  type TokenTotals,
  type TranscriptAggregate,
  totalOf,
} from "./transcript-reader";

/** 표시 상태. `partial`은 집계가 불완전하다는 뜻이다(상한·손상 줄·읽기 실패). */
export type TokenStatus = "none" | "partial" | "ok";

/** Claude Code 토큰 사용량 뷰모델. Kiro의 `CreditViewModel`과 대응하는 자리를 채운다. */
export interface TokenViewModel {
  status: TokenStatus;
  totals: TokenTotals;
  /** 토큰 총량(= input + output + cacheRead + cacheCreate). thinking은 output에 포함. */
  grandTotal: number;
  byModel: ModelBreakdown[];
  messages: number;
  sidechainMessages: number;
  sessions: number;
  /** 일별 토큰 총량 시계열. host `renderLineChart`가 그대로 소비한다. */
  trend: TrendSeries;
  /** 마지막 메시지 시각(ISO). 활동이 없으면 null. */
  lastActivityAt: string | null;
  /** 창 내 첫 메시지 시각(ISO). */
  firstActivityAt: string | null;
  /** 읽은 트랜스크립트 디렉터리. 못 찾으면 null. */
  dir: string | null;
  /** 디렉터리를 못 찾았을 때 시도한 경로 — 화면에서 무엇을 찾았는지 밝힌다. */
  triedPath: string;
  /** 집계가 불완전한 사유. 비어 있지 않으면 화면에 그대로 표시한다. */
  notes: string[];
}

/** 일별 집계를 host 차트가 소비하는 TrendSeries로 변환한다. */
function toTrend(daily: { date: string; total: number }[], window: TrendWindow): TrendSeries {
  const points = daily.map((d) => ({
    // 로컬 자정 기준. 차트는 x축에 Date.parse 결과만 쓰므로 하루 단위 등간격이 유지된다.
    ts: `${d.date}T00:00:00`,
    value: d.total,
    ok: true,
  }));
  const values = daily.map((d) => d.total);
  return {
    window,
    points,
    summary: {
      latest: values.length > 0 ? (values[values.length - 1] ?? null) : null,
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
      count: values.length,
    },
  };
}

/**
 * 집계 → 뷰모델. 상태 판정은 `none`(데이터 없음) → `partial`(불완전) → `ok` 순이다.
 *
 * @param agg    transcript-reader 산출 집계.
 * @param window 현재 창(창 토글 표시용).
 */
export function assembleTokens(agg: TranscriptAggregate, window: TrendWindow): TokenViewModel {
  const notes: string[] = [];

  if (agg.dir === null) {
    notes.push(
      `Claude Code 트랜스크립트를 찾지 못했습니다 (${agg.triedPath}). 이 워크스페이스에서 Claude Code로 실행한 이력이 없거나, 다른 경로에서 실행되었습니다.`,
    );
  }
  if (agg.filesCapped > 0) {
    notes.push(
      `트랜스크립트가 커서 오래된 ${agg.filesCapped.toLocaleString("ko-KR")}개 파일을 읽지 않았습니다 — 아래 수치는 그만큼 과소 집계입니다.`,
    );
  }
  if (agg.unreadableFiles > 0) {
    notes.push(`읽지 못한 트랜스크립트 파일 ${agg.unreadableFiles.toLocaleString("ko-KR")}개.`);
  }
  if (agg.malformedLines > 0) {
    notes.push(`형식이 깨진 줄 ${agg.malformedLines.toLocaleString("ko-KR")}개를 건너뛰었습니다.`);
  }

  const incomplete = agg.filesCapped > 0 || agg.unreadableFiles > 0 || agg.malformedLines > 0;
  // `none` 은 **정말로 사용량이 없을 때만**이다. 집계가 불완전하면 메시지 0 이어도 `partial`이다 —
  // 단일 파일이 상한을 넘으면 filesRead 0·messages 0 이 되는데, 그때 `none` 을 내면 화면이
  // "이 기간에 사용량이 없습니다. 기간을 넓혀 보세요" 를 띄운다. 사용량은 있고, 기간을 넓히면
  // 상한에 더 걸린다. 조용한 절단 금지 규율이 여기서 깨지는 자리였다.
  const status: TokenStatus =
    agg.messages === 0 && !incomplete ? "none" : incomplete ? "partial" : "ok";

  return {
    status,
    totals: agg.totals,
    grandTotal: totalOf(agg.totals),
    byModel: agg.byModel,
    messages: agg.messages,
    sidechainMessages: agg.sidechainMessages,
    sessions: agg.sessions,
    trend: toTrend(agg.daily, window),
    lastActivityAt: agg.lastAt,
    firstActivityAt: agg.firstAt,
    dir: agg.dir,
    triedPath: agg.triedPath,
    notes,
  };
}
