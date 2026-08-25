/**
 * RefreshPipeline 테스트 — 수집→파싱→저장 단일 진입점의 조립 규칙을 검증한다.
 * 실제 CLI를 호출하지 않도록 collect를 주입하고, 저장은 u1 동기 SnapshotStore(":memory:")로
 * 라운드트립한다. aidlc-dashboard 네이티브 트리로 흡수한 포팅본(핵심 조정: 동기 store).
 */

import { describe, expect, test } from "bun:test";
import type { CollectResult } from "../collector/usage-collector";
import { SnapshotStore } from "../storage/snapshot-store";
import type { CreditSnapshot } from "../types";
import { type PipelineStore, RefreshPipeline } from "./refresh-pipeline";

/** init 까지 마친 in-memory 스토어. */
function memStore(): SnapshotStore {
  const store = new SnapshotStore(":memory:");
  store.init();
  return store;
}

const constCollect = (r: CollectResult) => async () => r;

describe("RefreshPipeline", () => {
  test("수집+파싱 성공 → 성공 스냅샷 저장, 원문은 보존하지 않음(휘발성)", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "Plan: Pro\nUsed: 100\nLimit: 200\n" }),
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    pipeline.init();
    const result = await pipeline.run("manual");

    expect(result.persisted).toBe(true);
    expect(result.snapshot.ok).toBe(true);
    expect(result.snapshot.source).toBe("manual");
    // 성공 스냅샷에는 raw 필드가 없다.
    expect((result.snapshot as unknown as Record<string, unknown>).raw).toBeUndefined();

    const stored = store.readAll();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.ok).toBe(true);
  });

  test("수집 실패 → 실패 스냅샷에 진단 detail을 원문으로 보존", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({
        ok: false,
        reason: "수집 실패: 타임아웃(15000ms 초과)",
        detail: "stderr blob",
      }),
    });
    pipeline.init();
    const result = await pipeline.run("auto");

    expect(result.snapshot.ok).toBe(false);
    if (result.snapshot.ok === false) {
      expect(result.snapshot.reason).toContain("타임아웃");
      expect(result.snapshot.raw).toBe("stderr blob");
    }
  });

  test("파싱 실패 → 실패 스냅샷에 원문(raw)과 사유 보존", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "완전히 알 수 없는 포맷" }),
    });
    pipeline.init();
    const result = await pipeline.run("auto");

    expect(result.snapshot.ok).toBe(false);
    if (result.snapshot.ok === false) {
      expect(result.snapshot.raw).toBe("완전히 알 수 없는 포맷");
      expect(result.snapshot.reason.length).toBeGreaterThan(0);
    }
  });

  test("append 예외는 삼키지 않고 persisted:false·persistError로 표면화(무예외 반환)", async () => {
    // 동기 append가 throw하는 최소 스텁 store.
    const throwingStore: PipelineStore = {
      maxSequence: () => 0,
      append: () => {
        throw new Error("disk full");
      },
    };
    const pipeline = new RefreshPipeline({
      store: throwingStore,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    // run 자체는 reject하지 않는다(무예외).
    const result = await pipeline.run("auto");
    expect(result.persisted).toBe(false);
    expect(result.persistError).toContain("disk full");
    // 스냅샷 자체는 조립되어 반환된다.
    expect(result.snapshot.ok).toBe(true);
  });

  test("init(): u1 maxSequence로 시드되어 다음 run의 sequence가 연속한다", async () => {
    const store = memStore();
    // 기존 스냅샷을 미리 저장(sequence 4)하여 시드 확인.
    store.append({
      capturedAt: "2026-07-01T00:00:00.000Z",
      sequence: 4,
      source: "auto",
      ok: false,
      raw: "x",
      reason: "seed",
    });
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    const r1 = await pipeline.run("auto");
    const r2 = await pipeline.run("manual");
    expect(r1.snapshot.sequence).toBe(5);
    expect(r2.snapshot.sequence).toBe(6);
  });

  test("pre-await sequence: 동시 실행(자동+수동)도 서로 다른 sequence를 받는다", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    const [a, b] = await Promise.all([pipeline.run("auto"), pipeline.run("manual")]);
    expect(a.snapshot.sequence).not.toBe(b.snapshot.sequence);
  });

  test("run은 auto/manual을 공유하는 단일 진입점이다(source 전파)", async () => {
    const seen: CreditSnapshot["source"][] = [];
    const recordingStore: PipelineStore = {
      maxSequence: () => 0,
      append: (snap) => seen.push(snap.source),
    };
    const pipeline = new RefreshPipeline({
      store: recordingStore,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    await pipeline.run("auto");
    await pipeline.run("manual");
    expect(seen).toEqual(["auto", "manual"]);
  });
});
