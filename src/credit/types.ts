/**
 * 크레딧 서브시스템 공유 타입 — u1-credit-storage 소유.
 *
 * 설계 근거:
 * - `CreditSnapshot`은 저장·집계·표시가 소비하는 스냅샷 표현이다(contract-summary C1/C2).
 *   식별자는 `capturedAt` 단일 필드가 아니라 `capturedAt` + 단조 `sequence` + `source`
 *   조합으로 두어 동시(자동+수동) 캡처의 충돌을 방지한다(entities.md, BR1.2).
 * - 성공 스냅샷은 원문(raw)을 보존하지 않는다(휘발성 계약 BR1.6, project.md ## Forbidden).
 *   실패 스냅샷만 진단·경고 노출을 위해 원문·사유를 보존한다.
 * - `ParsedUsage`는 별도 엔티티가 아니라 `CreditSnapshot`의 값 객체다. 값 생산은 u2
 *   CreditParser이나 타입 소유는 엔티티와 함께 u1(순환 회피, contract-summary Finding #2).
 *
 * 이 파일은 u1 소유 타입만 정의한다. `ParseResult`(u2)·`TrendSeries`(u3) 등 다른 유닛이
 * 생산·소유하는 타입은 여기서 정의하지 않는다(producer-owned, Q3=A).
 */

/** 파싱이 정상 획득한 크레딧 지표. 부분 파싱 시 획득 못 한 필드는 `null`이다. */
export interface ParsedUsage {
  /** 플랜명 (예: "Pro"). 획득 실패 시 null. */
  planName: string | null;
  /** 누적 사용량. */
  usedAmount: number | null;
  /** 남은 잔량. */
  remainingAmount: number | null;
  /** 플랜 한도. */
  planLimit: number | null;
  /** 사용률(0~1 정규화). 수치 병기를 위해 % 가 아닌 비율로 보관한다. */
  usageRatio: number | null;
  /** 리셋일 (원문에서 추출한 문자열, 예: "2026-09-01"). */
  resetDate: string | null;
  /** 6개 필드 중 하나라도 null이면 true (부분 파싱 여부). */
  partial: boolean;
}

/** 스냅샷 캡처를 트리거한 경로. 동시 캡처 식별자 타이브레이크에도 사용한다. */
export type CaptureSource = "auto" | "manual";

/** 모든 스냅샷이 공유하는 캡처 메타데이터(식별). */
export interface SnapshotMeta {
  /** 캡처 시각(ISO 8601 UTC). readAll 정렬의 1차 키. */
  capturedAt: string;
  /** 단조 증가 시퀀스(INTEGER PRIMARY KEY). 동일 순간 캡처 충돌 방지 타이브레이크. */
  sequence: number;
  /** 캡처 트리거 경로(auto=폴링, manual=수동 새로고침). */
  source: CaptureSource;
}

/** 파싱 성공 스냅샷. 원문은 보존하지 않는다(휘발성, BR1.6). */
export interface SuccessSnapshot extends SnapshotMeta {
  ok: true;
  data: ParsedUsage;
}

/** 파싱/수집 실패 스냅샷. 진단·경고 노출을 위해 원문·사유를 보존한다. */
export interface FailureSnapshot extends SnapshotMeta {
  ok: false;
  /** 실패 시 보존하는 원문(raw). 성공 스냅샷에는 없다. */
  raw: string;
  /** 실패 분류·사유(타임아웃/비정상종료/빈출력/파싱실패 등). */
  reason: string;
}

/** 저장·조회·표시가 소비하는 스냅샷 표현. 성공/실패를 `ok`로 판별하는 판별 유니언. */
export type CreditSnapshot = SuccessSnapshot | FailureSnapshot;
