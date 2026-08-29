/**
 * SnapshotStore — CreditSnapshot을 `bun:sqlite`에 append-only로 영속화하고 시간순 조회한다.
 *
 * aidlc-dashboard의 네이티브 구성요소(흡수 대상). 기존 credit-dashboard의 JSONL·async 구현을
 * bun:sqlite 동기 API로 재구현한 것이다.
 *
 * 계층 경계(team.md ## Code Style, functional-spec):
 * - 파싱 로직을 알지 못한다. 이미 조립된 CreditSnapshot을 받아 저장/조회만 한다(단방향 계층).
 * - `data` JSON을 직렬화/역직렬화만 하고 필드 의미를 해석하지 않는다(u2 파서 소관).
 *
 * 계약(rules.md BR1.1~BR1.6, security-design NFR1.x·NFR4.x):
 * - append-only INSERT. UPDATE/DELETE API를 노출하지 않는다(BR1.1).
 * - sequence는 상위(u2)가 단조 유일 할당한 값을 신뢰해 저장한다(INTEGER PRIMARY KEY, BR1.2).
 * - 조회(readAll/latest/maxSequence)는 예외를 던지지 않는다. 데이터 없음은 빈 배열/null/0으로
 *   표현하고, 손상 레코드는 조회 시점에 비파괴적으로 skip한다(BR1.4·BR1.5).
 * - 무예외 보장은 조회 경로에 한정한다(contract-summary C1 error_behavior). append의 계약
 *   위반(중복 PK)·저장 I/O 오류는 삼키지 않고 표면화한다(silent failure 금지).
 * - 모든 SQL은 정적 리터럴, 값은 바인드 파라미터만(인젝션 방지 NFR1.2). 역직렬화는
 *   JSON.parse만(코드 실행 경로 없음 NFR4.2).
 */

import { Database } from "bun:sqlite";
import type { CaptureSource, CreditSnapshot, ParsedUsage } from "../types";

const VALID_SOURCES: readonly CaptureSource[] = ["auto", "manual"];

/** DB 행 형태(역직렬화 이전 원시 표현). */
interface SnapshotRow {
  sequence: number;
  capturedAt: string;
  source: string;
  ok: number;
  data: string | null;
  raw: string | null;
  reason: string | null;
}

/** 알 수 없는 값이 유효한 CreditSnapshot 형태인지 방어적으로 검증한다(NFR4.2). */
export function isValidSnapshot(value: unknown): value is CreditSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.sequence !== "number" || !Number.isFinite(o.sequence)) return false;
  if (typeof o.capturedAt !== "string" || o.capturedAt.length === 0) return false;
  if (typeof o.source !== "string" || !VALID_SOURCES.includes(o.source as CaptureSource)) {
    return false;
  }
  if (typeof o.ok !== "boolean") return false;
  if (o.ok === true) {
    return typeof o.data === "object" && o.data !== null;
  }
  return typeof o.raw === "string" && typeof o.reason === "string";
}

/**
 * DB 행 하나를 CreditSnapshot으로 역직렬화한다. data JSON 파싱 실패·필수 메타 결손 등
 * 손상 행은 `null`을 반환해 조회 계층이 비파괴 skip하게 한다(예외 미방출).
 */
function toSnapshot(row: SnapshotRow): CreditSnapshot | null {
  try {
    const source = row.source;
    if (source !== "auto" && source !== "manual") return null;
    if (typeof row.capturedAt !== "string" || row.capturedAt.length === 0) return null;
    if (typeof row.sequence !== "number" || !Number.isFinite(row.sequence)) return null;

    if (row.ok === 1) {
      if (row.data === null) return null;
      const data = JSON.parse(row.data) as ParsedUsage;
      const candidate: CreditSnapshot = {
        sequence: row.sequence,
        capturedAt: row.capturedAt,
        source,
        ok: true,
        data,
      };
      return isValidSnapshot(candidate) ? candidate : null;
    }

    if (row.raw === null || row.reason === null) return null;
    const candidate: CreditSnapshot = {
      sequence: row.sequence,
      capturedAt: row.capturedAt,
      source,
      ok: false,
      raw: row.raw,
      reason: row.reason,
    };
    return isValidSnapshot(candidate) ? candidate : null;
  } catch {
    // 손상 행(잘못된 JSON 등) → skip(삭제하지 않음).
    return null;
  }
}

export class SnapshotStore {
  private readonly db: Database;

  /**
   * @param dbPath bun:sqlite DB 경로. 기본값은 실행 디렉터리 상대 `./data/usage.db`(FR5.4).
   *   테스트는 `:memory:` 또는 임시 파일 경로를 주입해 실제 파일에 접근하지 않는다(NFR5).
   */
  constructor(dbPath = "./data/usage.db") {
    this.db = new Database(dbPath);
  }

  /**
   * 테이블을 idempotent 보장한다(CREATE TABLE IF NOT EXISTS). 재시작 이전 이력은 그대로
   * 유지된다(마이그레이션 없음, BR1.3). 카운터 시드는 maxSequence()로 소비자(u2)가 조회한다.
   */
  init(): void {
    // WAL: 폴링이 append 하는 동안 조회(렌더 경로)가 막히지 않고 fsync 횟수도 준다. 파일 DB에만
    // 적용되며 `:memory:`에서는 journal_mode 가 "memory"로 남는다 — 던지지 않으므로 테스트
    // 경로도 그대로다(실측 확인). WAL 을 켰으므로 종료 시 close()로 체크포인트한다.
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS credit_snapshots (sequence INTEGER PRIMARY KEY, capturedAt TEXT NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL, data TEXT, raw TEXT, reason TEXT)",
    );
  }

  /**
   * DB 핸들을 닫는다(종료 경로 전용). 닫으면 SQLite 가 WAL 을 본 파일로 체크포인트한다 — 실측:
   * `-wal` 파일 자체는 남지만 크기가 0으로 접히고 내용은 DB 파일에 들어간다. `close(true)`나
   * 명시적 `PRAGMA wal_checkpoint(TRUNCATE)`도 결과가 같아서, 던지지 않는 `close(false)`를 쓴다.
   */
  close(): void {
    this.db.close(false);
  }

  /**
   * 스냅샷 하나를 단일 INSERT로 append한다(append-only, BR1.1). 성공 스냅샷은
   * data=JSON, raw/reason=null; 실패 스냅샷은 data=null, raw/reason 보존(라운드트립 BR1.6).
   *
   * 조회 경로와 달리 무예외를 보장하지 않는다 — 계약 위반(중복 PK)·저장 I/O 오류는 삼키지
   * 않고 표면화한다(silent failure 금지, contract-summary C1 error_behavior).
   */
  append(snapshot: CreditSnapshot): void {
    const insert = this.db.query(
      "INSERT INTO credit_snapshots (sequence, capturedAt, source, ok, data, raw, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    if (snapshot.ok) {
      insert.run(
        snapshot.sequence,
        snapshot.capturedAt,
        snapshot.source,
        1,
        JSON.stringify(snapshot.data),
        null,
        null,
      );
    } else {
      insert.run(
        snapshot.sequence,
        snapshot.capturedAt,
        snapshot.source,
        0,
        null,
        snapshot.raw,
        snapshot.reason,
      );
    }
  }

  /**
   * 저장된 최대 sequence 값(재시작 연속성 시드). 레코드가 없으면 결정적 `0`(BR1.3·NFR1.4).
   * 예외를 던지지 않는다.
   */
  maxSequence(): number {
    const row = this.db.query("SELECT MAX(sequence) AS max FROM credit_snapshots").get() as {
      max: number | null;
    } | null;
    return row?.max ?? 0;
  }

  /**
   * sequence 최대 1건을 역직렬화해 반환한다(성공/실패 무관). 없으면 null. 최상단 행이
   * 손상이면 skip 후 다음 유효 행을 반환한다(WF3.2). 예외를 던지지 않는다.
   *
   * 한 행만 쓸 것이므로 한 행씩 내려간다. 이전 구현은 전량을 `.all()`로 받아 전부 역직렬화한
   * 뒤 첫 유효 행만 돌려줬는데, `assembleCredit`이 `readAll()` 직후에 이걸 부르므로 렌더마다
   * 같은 테이블을 두 번 훑었다 — 실패 스냅샷은 `raw`를 최대 512KB 들고 있어(MAX_STDOUT_BYTES)
   * 이력에 비례해 커지는 비용이다. 손상 행은 드물어 대개 첫 조회 1행에서 끝난다.
   *
   * `.iterate()`로 조기 이탈하지 않는 이유(실측): `db.query()`는 컴파일된 statement를 SQL
   * 문자열 기준으로 캐시하는데, 순회를 끝까지 돌지 않고 break하면 커서가 리셋되지 않아 **다음
   * 호출이 그 다음 행에서 이어진다**(같은 DB에 latest()를 4번 부르면 v5·v4·v3·v2가 나왔다).
   * `LIMIT 1 OFFSET ?`는 매 호출이 커서를 남기지 않아 그 함정이 없다.
   */
  latest(): CreditSnapshot | null {
    const row = this.db.query(
      "SELECT sequence, capturedAt, source, ok, data, raw, reason FROM credit_snapshots ORDER BY sequence DESC LIMIT 1 OFFSET ?",
    );
    for (let offset = 0; ; offset++) {
      const candidate = row.get(offset) as SnapshotRow | null;
      if (candidate === null) return null;
      const snap = toSnapshot(candidate);
      if (snap !== null) return snap;
    }
  }

  /**
   * 전량을 시간순(capturedAt, 동률 sequence)으로 반환한다. 손상 레코드(잘못된 data JSON·필수
   * 메타 결손)는 행 단위로 비파괴 skip한다(BR1.4·BR1.5·NFR4.2). 예외를 던지지 않는다.
   */
  readAll(): CreditSnapshot[] {
    const rows = this.db
      .query(
        "SELECT sequence, capturedAt, source, ok, data, raw, reason FROM credit_snapshots ORDER BY capturedAt, sequence",
      )
      .all() as SnapshotRow[];
    const snapshots: CreditSnapshot[] = [];
    for (const row of rows) {
      const snap = toSnapshot(row);
      if (snap !== null) snapshots.push(snap);
    }
    return snapshots;
  }
}
