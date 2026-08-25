/**
 * CreditModelAssembler — 저장소 스냅샷을 표시용 뷰모델 `CreditViewModel`로 조립한다(BR1.1~BR1.5).
 *
 * u3 소유 뷰모델. host `DashboardModel["credit"]`의 인덱스드 액세스를 따르지 않고 독립 명명
 * 타입으로 정의해 u3→u4 역참조·순환을 회피한다(functional-design 리뷰 Finding #1). u4가
 * `CreditViewModel`을 import 해 `DashboardModel.credit` 슬롯에 배선한다(u4→u3 단방향).
 *
 * 읽기 전용: 저장소의 `latest()`/`readAll()`(동기)만 읽고 쓰기 부수효과가 없다(NFR1.4).
 * u2(수집)를 직접 호출하지 않는다(단방향 계층).
 */

import { type TrendSeries, type TrendWindow, buildTrend } from "../trend/trend";
import type { CreditSnapshot, ParsedUsage } from "../types";

/** 마지막 성공 나이가 이 값을 초과하면 stale(신선도 상실)로 본다(AC7.1.2). */
const STALE_MS = 10 * 60 * 1000;

/** assembleCredit 이 읽는 저장소의 최소 읽기 인터페이스(u1 SnapshotStore 가 충족). */
export interface CreditReadStore {
  latest(): CreditSnapshot | null;
  readAll(): CreditSnapshot[];
}

/** 크레딧 표시 상태. 신선도는 상태와 독립적으로 표현한다. */
export type CreditStatus = "loading" | "none" | "partial" | "failure" | "ok";

/**
 * u3 소유 표시용 뷰모델. u4가 이 타입을 import 해 host 모델에 배선한다.
 * u3는 host `DashboardModel`을 절대 참조하지 않는다.
 */
export interface CreditViewModel {
  /** 표시 상태(loading/none/partial/failure/ok). */
  status: CreditStatus;
  /** 마지막 성공 스냅샷의 지표. 성공 이력이 없으면 null. failure에서도 유지한다. */
  current: ParsedUsage | null;
  /** 마지막 성공 캡처 시각(ISO). 성공 이력이 없으면 null. */
  lastSuccessAt: string | null;
  /** 마지막 성공값의 신선도. 실패 상태와 동시에 stale일 수 있다. */
  freshness: { stale: boolean; lastSuccessAt: string | null };
  /** 주입 창으로 집계된 추이. */
  trend: TrendSeries;
  /** 최신 스냅샷이 실패일 때 그 원문·사유. 아니면 null. */
  warning: { raw: string; reason: string } | null;
}

/**
 * 저장소 스냅샷을 `CreditViewModel`로 조립한다.
 *
 * 상태 판정 순서: loading/none → failure(최신이 실패) → partial → ok. 마지막 성공의
 * 신선도는 별도 필드이므로 failure와 stale을 동시에 표현할 수 있다.
 *
 * @param store 읽기 전용 저장소(latest/readAll 동기).
 * @param now   기준 시각(테스트 주입 — 10분 경계 결정).
 * @param window 추이 집계 창(기본 30d).
 * @param collecting 첫 수집 진행 여부.
 */
export function assembleCredit(
  store: CreditReadStore,
  now: Date = new Date(),
  window: TrendWindow = "30d",
  collecting = false,
): CreditViewModel {
  const all = store.readAll();
  const trend = buildTrend(all, window, now);

  // 마지막 성공 스냅샷(sequence 최대의 ok=true). readAll 은 capturedAt→sequence 정렬이므로
  // 뒤에서부터 첫 성공을 찾으면 최신 성공이다.
  let lastSuccess: CreditSnapshot | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if (s?.ok) {
      lastSuccess = s;
      break;
    }
  }

  const current: ParsedUsage | null = lastSuccess?.ok ? lastSuccess.data : null;
  const lastSuccessAt = lastSuccess?.capturedAt ?? null;

  const latest = store.latest();
  const warning =
    latest !== null && latest.ok === false ? { raw: latest.raw, reason: latest.reason } : null;

  const stale = isStale(lastSuccessAt, now);
  const status = resolveStatus(all.length, lastSuccess, latest, collecting);

  return {
    status,
    current,
    lastSuccessAt,
    freshness: { stale, lastSuccessAt },
    trend,
    warning,
  };
}

function isStale(lastSuccessAt: string | null, now: Date): boolean {
  if (lastSuccessAt === null) return false;
  const capturedAt = Date.parse(lastSuccessAt);
  return !Number.isNaN(capturedAt) && now.getTime() - capturedAt > STALE_MS;
}

/** 상태 판정 순수 함수. 최신 수집 결과가 신선도보다 우선한다. */
function resolveStatus(
  total: number,
  lastSuccess: CreditSnapshot | null,
  latest: CreditSnapshot | null,
  collecting: boolean,
): CreditStatus {
  if (total === 0) return collecting ? "loading" : "none";

  // failure: 최신 스냅샷이 실패.
  if (latest !== null && latest.ok === false) return "failure";

  // partial: 최신 성공이 부분 파싱.
  if (lastSuccess?.ok && lastSuccess.data.partial) return "partial";

  return "ok";
}
