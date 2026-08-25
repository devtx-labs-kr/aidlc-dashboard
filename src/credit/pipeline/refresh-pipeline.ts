/**
 * RefreshPipeline — 수집→파싱→저장의 단일 진입점(BR3.1, FR5.3).
 *
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본. PollingScheduler(자동)와 수동 새로고침이
 * 모두 이 파이프라인을 재사용하므로 두 경로의 로직 표류(drift)가 없다.
 *
 * 핵심 조정(u1 정합): u1 SnapshotStore는 **동기 API**다(`init(): void`, `append(): void`,
 * `maxSequence(): number`). 기존 async store 전제를 걷어내고 `init()`을 동기로, `append`·
 * `maxSequence` 호출에서 `await`를 제거했다. 수집(collect)은 여전히 async이므로 `run`은
 * `Promise<RefreshResult>`를 유지한다.
 *
 * 식별자(BR3.2): 각 스냅샷에 캡처 시각(capturedAt)에 더해 단조 증가 sequence와
 * source(auto/manual)를 부여한다. sequence는 collect await 이전에 동기적으로 할당되므로
 * 자동+수동 동시 실행에서도 충돌하지 않는다(pre-await sequence).
 *
 * 타입 소유(producer-owned): `RefreshResult`는 u2 소유로 이 모듈에서 정의·export한다.
 * `CreditSnapshot`·`CaptureSource`는 u1 소유(`../types`)에서 import한다.
 */

import { type CollectResult, type CollectorDeps, collectUsage } from "../collector/usage-collector";
import { parseUsage } from "../parser/usage-parser";
import type { CaptureSource, CreditSnapshot } from "../types";

/** 파이프라인이 소비하는 저장소 최소 표면(u1 SnapshotStore가 구조적으로 충족). */
export interface PipelineStore {
  /** 저장된 최대 sequence(재시작 연속성 시드). 레코드 없으면 0. */
  maxSequence(): number;
  /** 스냅샷 하나를 append-only 저장한다. 계약 위반·I/O 오류는 동기 throw로 표면화한다. */
  append(snapshot: CreditSnapshot): void;
}

/** 한 번의 새로고침 결과. u2 소유 타입. */
export interface RefreshResult {
  snapshot: CreditSnapshot;
  /** 저장 성공 여부. */
  persisted: boolean;
  /** 저장 실패 시 사유(있으면). */
  persistError?: string;
}

/** 파이프라인 의존성(테스트 주입 가능). */
export interface PipelineDeps {
  store: PipelineStore;
  /** 수집 함수(기본 collectUsage). 테스트에서 주입해 실제 CLI 미호출. */
  collect?: (deps?: CollectorDeps) => Promise<CollectResult>;
  /** 수집기 하위 옵션(타임아웃/spawn 등). */
  collectorDeps?: CollectorDeps;
  /** 시각 소스(테스트 주입). */
  now?: () => Date;
}

export class RefreshPipeline {
  private readonly store: PipelineStore;
  private readonly collect: (deps?: CollectorDeps) => Promise<CollectResult>;
  private readonly collectorDeps: CollectorDeps | undefined;
  private readonly now: () => Date;
  private sequence = -1;

  constructor(deps: PipelineDeps) {
    this.store = deps.store;
    this.collect = deps.collect ?? collectUsage;
    this.collectorDeps = deps.collectorDeps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 저장소의 기존 최대 sequence로 단조 카운터를 시드한다(재시작 후 연속성). u1 동기 API를
   * 소비하므로 동기 메서드다(await 없음).
   */
  init(): void {
    this.sequence = this.store.maxSequence();
  }

  /**
   * 수집→파싱→저장을 한 번 실행한다. 예외를 던지지 않는다(실패도 스냅샷으로 보존).
   * auto/manual을 공유하는 단일 진입점(BR3.1).
   */
  async run(source: CaptureSource): Promise<RefreshResult> {
    const capturedAt = this.now().toISOString();
    // sequence는 collect await 이전에 동기적으로 확정 → 동시 실행에서도 유일(BR3.2).
    const sequence = ++this.sequence;

    const snapshot = await this.buildSnapshot(capturedAt, sequence, source);

    try {
      // u1 동기 store — await 없이 호출한다.
      this.store.append(snapshot);
      return { snapshot, persisted: true };
    } catch (err) {
      // append 계약 위반·I/O 오류는 삼키지 않고 결과로 표면화한다(무예외 반환, BR3.4).
      const persistError = err instanceof Error ? err.message : String(err);
      console.warn(`[RefreshPipeline] 스냅샷 저장 실패: ${persistError}`);
      return { snapshot, persisted: false, persistError };
    }
  }

  /** 수집·파싱 결과를 CreditSnapshot으로 조립한다. */
  private async buildSnapshot(
    capturedAt: string,
    sequence: number,
    source: CaptureSource,
  ): Promise<CreditSnapshot> {
    const collected = await this.collect(this.collectorDeps);
    if (!collected.ok) {
      // 수집 실패: 진단 detail을 원문으로 보존.
      return {
        capturedAt,
        sequence,
        source,
        ok: false,
        raw: collected.detail,
        reason: collected.reason,
      };
    }

    const parsed = parseUsage(collected.raw);
    if (parsed.ok) {
      // 성공: 원문(raw)은 보존하지 않는다(휘발성, BR3.3). 구조화 데이터만 저장.
      return { capturedAt, sequence, source, ok: true, data: parsed.data };
    }
    // 파싱 실패: 원문·사유 보존 — "원문 보기"·결측 구분에 사용.
    return { capturedAt, sequence, source, ok: false, raw: parsed.raw, reason: parsed.reason };
  }
}
