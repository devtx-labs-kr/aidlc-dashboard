/**
 * PollingScheduler — 기본 5분 주기로 새로고침 파이프라인을 자동 실행한다(BR4.1~BR4.4, FR5.1).
 *
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본. 파이프라인은 수동 새로고침과 공유한다(FR5.3).
 *
 * 실패 격리: 한 주기의 수집/저장이 실패해도 예외를 삼켜 다음 주기를 계속 유지한다(BR4.2).
 * `Pollable`·`SchedulerDeps`·`DEFAULT_INTERVAL_MS`는 u2 소유로 이 모듈에서 정의·export한다.
 */

import type { CaptureSource } from "../types";
import type { RefreshResult } from "./refresh-pipeline";

/** 기본 폴링 주기: 5분(FR5.1). */
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** 파이프라인의 최소 표면(테스트 주입 용이). */
export interface Pollable {
  run(source: CaptureSource): Promise<RefreshResult>;
}

export interface SchedulerDeps {
  pipeline: Pollable;
  /** 폴링 주기(ms). 기본 5분. */
  intervalMs?: number;
  /** 각 성공 tick 후 콜백(선택). */
  onTick?: (result: RefreshResult) => void;
  /** tick 중 예상 못 한 오류 콜백(선택). */
  onError?: (err: unknown) => void;
}

export class PollingScheduler {
  private readonly pipeline: Pollable;
  private readonly intervalMs: number;
  private readonly onTick: ((result: RefreshResult) => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerDeps) {
    this.pipeline = deps.pipeline;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onTick = deps.onTick;
    this.onError = deps.onError;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 폴링을 시작한다. runImmediately=true면 즉시 1회 실행 후 주기 반복. */
  start(runImmediately = false): void {
    if (this.timer !== null) return; // 중복 시작 방지(BR4.4)
    if (runImmediately) void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // 타이머가 프로세스 종료를 막지 않도록(서버 수명에 종속) unref.
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** 폴링을 중지한다. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 한 주기 실행. 실패를 격리해 다음 주기가 계속되도록 예외를 삼킨다(BR4.2).
   */
  async tick(): Promise<void> {
    try {
      const result = await this.pipeline.run("auto");
      this.onTick?.(result);
    } catch (err) {
      console.warn(`[PollingScheduler] 폴링 tick 오류(격리됨): ${String(err)}`);
      this.onError?.(err);
    }
  }
}
