// SnapshotStore 유닛 테스트 — u1-credit-storage.
//
// 러너: bun:test. 격리: DB 경로 주입(":memory:" 또는 mkdtemp 임시 파일)으로 실제
// ./data/usage.db에 절대 접근하지 않는다(security-design 테스트 격리, NFR5). 실제
// kiro-cli·네트워크 미접근(u1은 저장만).
//
// 손상 레코드 케이스는 저수준 bun:sqlite Database로 손상 행을 직접 INSERT해 방어 경로를
// 자극한다(unit-test-instructions.md #5).

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CreditSnapshot, FailureSnapshot, SuccessSnapshot } from "../types";
import { SnapshotStore, isValidSnapshot } from "./snapshot-store";

/** 각 테스트가 만든 임시 디렉터리 정리 목록. */
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 임시 파일 DB 경로를 만든다(재오픈 연속성 테스트용). */
function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u1-snap-"));
  tmpDirs.push(dir);
  return path.join(dir, "usage.db");
}

/** init 까지 마친 in-memory 스토어를 만든다. */
function memStore(): SnapshotStore {
  const store = new SnapshotStore(":memory:");
  store.init();
  return store;
}

function success(
  sequence: number,
  capturedAt: string,
  overrides: Partial<SuccessSnapshot["data"]> = {},
): SuccessSnapshot {
  return {
    sequence,
    capturedAt,
    source: "auto",
    ok: true,
    data: {
      planName: "Pro",
      usedAmount: 120,
      remainingAmount: 380,
      planLimit: 500,
      usageRatio: 0.24,
      resetDate: "2026-09-01",
      partial: false,
      ...overrides,
    },
  };
}

function failure(sequence: number, capturedAt: string): FailureSnapshot {
  return {
    sequence,
    capturedAt,
    source: "manual",
    ok: false,
    raw: "some non-contract /usage output",
    reason: "parse-failure",
  };
}

describe("SnapshotStore append/readAll 라운드트립", () => {
  test("case1: 성공 스냅샷 라운드트립 — data 보존, raw/reason 부재", () => {
    const store = memStore();
    const snap = success(1, "2026-08-16T10:00:00.000Z");
    store.append(snap);

    const all = store.readAll();
    expect(all).toHaveLength(1);
    const [got] = all;
    expect(got).toEqual(snap);
    expect(got?.ok).toBe(true);
    // 성공 스냅샷은 raw/reason 필드를 싣지 않는다(휘발성 라운드트립 BR1.6).
    expect(got && "raw" in got).toBe(false);
    expect(got && "reason" in got).toBe(false);
  });

  test("case2: 실패 스냅샷 라운드트립 — ok=false·raw·reason 보존, data 부재", () => {
    const store = memStore();
    const snap = failure(1, "2026-08-16T10:00:00.000Z");
    store.append(snap);

    const [got] = store.readAll();
    expect(got).toEqual(snap);
    expect(got?.ok).toBe(false);
    expect(got && "data" in got).toBe(false);
    if (got && got.ok === false) {
      expect(got.raw).toBe("some non-contract /usage output");
      expect(got.reason).toBe("parse-failure");
    }
  });
});

describe("SnapshotStore 정렬·연속성", () => {
  test("case3: 시간순 정렬 — 뒤섞어 저장해도 capturedAt→sequence 오름차순", () => {
    const store = memStore();
    store.append(success(3, "2026-08-16T12:00:00.000Z"));
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(2, "2026-08-16T11:00:00.000Z"));

    const seqs = store.readAll().map((s) => s.sequence);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test("case4: 동시 캡처 — 동일 capturedAt·다른 sequence 두 건이 sequence로 구별·정렬", () => {
    const store = memStore();
    const at = "2026-08-16T10:00:00.000Z";
    // auto 폴링과 manual 새로고침이 같은 순간에 캡처된 상황.
    store.append(success(6, at));
    store.append(failure(5, at));

    const all = store.readAll();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.sequence)).toEqual([5, 6]);
    expect(all[0]?.ok).toBe(false);
    expect(all[1]?.ok).toBe(true);
  });

  test("case8: 재시작 연속성 — 같은 파일 재오픈 후 이력 유지·maxSequence 시드 정확", () => {
    const dbPath = tmpDbPath();

    const first = new SnapshotStore(dbPath);
    first.init();
    first.append(success(1, "2026-08-16T10:00:00.000Z"));
    first.append(failure(2, "2026-08-16T10:05:00.000Z"));

    // 새 커넥션으로 재오픈(서버 재시작 시뮬레이션).
    const second = new SnapshotStore(dbPath);
    second.init();
    expect(second.readAll()).toHaveLength(2);
    expect(second.maxSequence()).toBe(2);
    expect(second.latest()?.sequence).toBe(2);
  });
});

describe("SnapshotStore 조회 계약", () => {
  test("case6: latest() = sequence 최대 1건(성공/실패 무관), 없으면 null", () => {
    const store = memStore();
    expect(store.latest()).toBeNull();

    store.append(success(1, "2026-08-16T12:00:00.000Z"));
    store.append(failure(2, "2026-08-16T10:00:00.000Z")); // 더 이른 시각이나 더 큰 sequence
    const latest = store.latest();
    expect(latest?.sequence).toBe(2);
    expect(latest?.ok).toBe(false);
  });

  test("case7: maxSequence() = MAX(sequence), 빈 DB는 결정적 0", () => {
    const store = memStore();
    expect(store.maxSequence()).toBe(0);

    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(7, "2026-08-16T11:00:00.000Z"));
    expect(store.maxSequence()).toBe(7);
  });
});

describe("SnapshotStore 방어적 역직렬화", () => {
  test("case5: 손상 레코드 방어 skip — 잘못된 JSON·필수 메타 결손 행을 직접 INSERT해도 정상 행만, 무예외", () => {
    const dbPath = tmpDbPath();
    const store = new SnapshotStore(dbPath);
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(4, "2026-08-16T13:00:00.000Z"));

    // 저수준 커넥션으로 손상 행을 직접 심는다.
    const raw = new Database(dbPath);
    const insert = raw.query(
      "INSERT INTO credit_snapshots (sequence, capturedAt, source, ok, data, raw, reason) VALUES (?,?,?,?,?,?,?)",
    );
    // (a) 성공 표기인데 data JSON 이 손상.
    insert.run(2, "2026-08-16T11:00:00.000Z", "auto", 1, "{not valid json", null, null);
    // (b) 필수 메타(capturedAt) 결손.
    insert.run(3, "", "auto", 1, JSON.stringify({ planName: "Pro" }), null, null);
    raw.close();

    let all: CreditSnapshot[] = [];
    expect(() => {
      all = store.readAll();
    }).not.toThrow();
    // 정상 행 2건(sequence 1, 4)만 남고 손상 2건은 비파괴 skip.
    expect(all.map((s) => s.sequence)).toEqual([1, 4]);

    // 손상 행은 물리 삭제되지 않는다(append-only 비파괴) — 저수준 카운트로 확인.
    const check = new Database(dbPath);
    const row = check.query("SELECT COUNT(*) AS n FROM credit_snapshots").get() as { n: number };
    check.close();
    expect(row.n).toBe(4);
  });

  test("case5b: latest()도 손상 최상단 행을 skip하고 다음 유효 행 반환, 무예외", () => {
    const dbPath = tmpDbPath();
    const store = new SnapshotStore(dbPath);
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));

    const raw = new Database(dbPath);
    raw
      .query(
        "INSERT INTO credit_snapshots (sequence, capturedAt, source, ok, data, raw, reason) VALUES (?,?,?,?,?,?,?)",
      )
      .run(2, "2026-08-16T11:00:00.000Z", "auto", 1, "{broken", null, null);
    raw.close();

    expect(() => store.latest()).not.toThrow();
    const latest = store.latest();
    expect(latest?.sequence).toBe(1);
  });

  test("case5d: 파일 DB는 WAL 로 열리고 close() 가 WAL 을 본 파일로 접는다", () => {
    const dbPath = tmpDbPath();
    const store = new SnapshotStore(dbPath);
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));

    const check = new Database(dbPath);
    const mode = check.query("PRAGMA journal_mode").get() as { journal_mode: string };
    check.close();
    expect(mode.journal_mode).toBe("wal");

    store.close();
    // 실측: `-wal` 파일은 남지만 체크포인트로 0바이트가 되고 내용은 DB 파일로 들어간다.
    // 파일의 존재가 아니라 "미반영 로그가 남지 않았다"가 확인 대상이다.
    if (fs.existsSync(`${dbPath}-wal`)) {
      expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
    }
    // 그래서 닫은 뒤 재오픈으로 데이터가 읽힌다(BR1.3 재시작 연속성).
    const reopened = new SnapshotStore(dbPath);
    reopened.init();
    expect(reopened.readAll()).toHaveLength(1);
    reopened.close();
  });

  test("case5c: latest()를 거듭 불러도 같은 행을 돌려준다(한 행씩 내려가는 조회의 회귀 방어)", () => {
    // bun:sqlite는 `db.query()`의 statement를 캐시하므로, 커서를 남기는 조회를 조기 이탈하면
    // 다음 호출이 그 다음 행에서 이어진다. 렌더마다 부르는 함수라 그 함정이 곧 오답이 된다.
    const store = new SnapshotStore(":memory:");
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(2, "2026-08-16T11:00:00.000Z"));
    store.append(success(3, "2026-08-16T12:00:00.000Z"));

    expect(store.latest()?.sequence).toBe(3);
    expect(store.latest()?.sequence).toBe(3);
    expect(store.latest()?.sequence).toBe(3);
    // readAll()과 섞어 불러도 서로 간섭하지 않는다(assembleCredit의 실제 호출 순서).
    expect(store.readAll()).toHaveLength(3);
    expect(store.latest()?.sequence).toBe(3);
  });
});

describe("isValidSnapshot 형태 방어", () => {
  test("case9: 형태 위반 거부 — 누락 필드·잘못된 source·null/문자열", () => {
    // 정상 스냅샷은 통과.
    expect(isValidSnapshot(success(1, "2026-08-16T10:00:00.000Z"))).toBe(true);
    expect(isValidSnapshot(failure(1, "2026-08-16T10:00:00.000Z"))).toBe(true);

    // 비객체.
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot("snapshot")).toBe(false);
    expect(isValidSnapshot(42)).toBe(false);

    // 잘못된 source.
    expect(
      isValidSnapshot({
        sequence: 1,
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "cron",
        ok: true,
        data: {},
      }),
    ).toBe(false);

    // capturedAt 결손.
    expect(
      isValidSnapshot({ sequence: 1, capturedAt: "", source: "auto", ok: true, data: {} }),
    ).toBe(false);

    // 성공 표기인데 data 없음.
    expect(
      isValidSnapshot({
        sequence: 1,
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "auto",
        ok: true,
      }),
    ).toBe(false);

    // 실패 표기인데 raw/reason 없음.
    expect(
      isValidSnapshot({
        sequence: 1,
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "auto",
        ok: false,
      }),
    ).toBe(false);

    // sequence 가 숫자가 아님.
    expect(
      isValidSnapshot({
        sequence: "1",
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "auto",
        ok: true,
        data: {},
      }),
    ).toBe(false);
  });
});

describe("SnapshotStore append-only 무결", () => {
  test("case10: UPDATE/DELETE API 미노출(설계상 변경 경로 없음)", () => {
    const store = memStore();
    const surface = store as unknown as Record<string, unknown>;
    expect(surface.update).toBeUndefined();
    expect(surface.delete).toBeUndefined();
    expect(surface.remove).toBeUndefined();
    // 노출 메서드는 저장·조회·초기화로 한정.
    expect(typeof store.append).toBe("function");
    expect(typeof store.readAll).toBe("function");
    expect(typeof store.latest).toBe("function");
    expect(typeof store.maxSequence).toBe("function");
    expect(typeof store.init).toBe("function");
  });

  test("case10b: 중복 sequence(PK 위반)는 삼키지 않고 표면화(silent failure 금지)", () => {
    const store = memStore();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    // u2 계약 위반(중복 sequence) 시 append는 조회 경로와 달리 오류를 전파한다.
    expect(() => store.append(success(1, "2026-08-16T11:00:00.000Z"))).toThrow();
  });
});
