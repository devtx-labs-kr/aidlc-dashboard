/**
 * PollingScheduler 테스트 — 즉시1회·tick 실패 격리·중복 start 무시·start/stop 정리를 검증한다.
 * 실제 시각·CLI를 호출하지 않도록 pipeline 스텁과 짧은 intervalMs를 주입한다(NFR5).
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본.
 */

import { describe, expect, test } from "bun:test";
import type { CaptureSource } from "../types";
import { type Pollable, PollingScheduler } from "./polling-scheduler";
import type { RefreshResult } from "./refresh-pipeline";

function fakeResult(): RefreshResult {
  return {
    snapshot: {
      capturedAt: "2026-08-01T00:00:00.000Z",
      sequence: 0,
      source: "auto",
      ok: false,
      raw: "",
      reason: "x",
    },
    persisted: true,
  };
}

/** 다음 마이크로태스크/타이머 큐를 비우기 위한 짧은 지연. */
function tickDelay(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PollingScheduler", () => {
  test("tick은 파이프라인을 source='auto'로 호출한다", async () => {
    const calls: CaptureSource[] = [];
    const pipeline: Pollable = {
      run: async (source) => {
        calls.push(source);
        return fakeResult();
      },
    };
    const scheduler = new PollingScheduler({ pipeline });
    await scheduler.tick();
    expect(calls).toEqual(["auto"]);
  });

  test("start(runImmediately=true)는 즉시 1회 tick을 실행한다", async () => {
    let count = 0;
    const pipeline: Pollable = {
      run: async () => {
        count += 1;
        return fakeResult();
      },
    };
    // 즉시 실행만 관측하도록 주기는 크게 잡는다.
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    scheduler.start(true);
    await tickDelay();
    scheduler.stop();
    expect(count).toBe(1);
  });

  test("파이프라인이 throw해도 tick은 예외를 격리한다(onError 호출, 다음 주기 지속)", async () => {
    let errored = false;
    const pipeline: Pollable = {
      run: async () => {
        throw new Error("boom");
      },
    };
    const scheduler = new PollingScheduler({
      pipeline,
      onError: () => {
        errored = true;
      },
    });
    // tick 자체가 reject하지 않아야 한다.
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(errored).toBe(true);
  });

  test("중복 start는 무시된다(단일 타이머, stop 한 번으로 정지)", () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    scheduler.start();
    scheduler.start(); // 무시되어야 함
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    // 중복 타이머가 남아있지 않으므로 stop 한 번으로 정지.
    expect(scheduler.running).toBe(false);
  });

  test("start/stop이 running 상태를 토글한다", () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  test("onTick 콜백이 성공 결과를 받는다", async () => {
    let received: RefreshResult | null = null;
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({
      pipeline,
      onTick: (r) => {
        received = r;
      },
    });
    await scheduler.tick();
    expect(received).not.toBeNull();
  });
});
