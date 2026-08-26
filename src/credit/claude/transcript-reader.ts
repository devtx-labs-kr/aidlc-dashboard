/**
 * ClaudeTranscriptReader — Claude Code 로컬 트랜스크립트에서 토큰 사용량을 집계한다.
 *
 * Kiro 경로(u2 UsageCollector)와 데이터 성질이 다르다는 점이 이 모듈의 존재 이유다.
 * `kiro-cli chat --no-interactive /usage`는 **할당량**(플랜·한도·잔량·리셋일)을 원격에서
 * 받아오지만, Claude Code에는 그에 대응하는 비대화형 명령이 없다(`/usage`는 대화형 전용).
 * 대신 `~/.claude/projects/<slug>/*.jsonl`에 메시지별 **실사용 토큰**이 남는다. 그래서
 * 이쪽은 할당량 표가 아니라 토큰 표가 되며, 아래 성질이 Kiro 경로와 정반대다.
 *
 * - **spawn·네트워크 없음.** 로컬 파일만 읽는다(NFR1.1의 argv 규율이 애초에 적용되지 않음).
 * - **저장 없음.** sqlite 스냅샷·폴링이 필요 없다. 트랜스크립트 자체가 타임스탬프를 들고
 *   있어 일별 추이가 원본에서 직접 나온다(u1 저장소보다 이력이 정확하다).
 * - **워크스페이스에 쓰지 않는다.** 읽기 전용이고 홈 디렉터리만 본다.
 *
 * 던지지 않는다: 트랜스크립트가 없거나 깨져도 빈 집계 + 카운터로 degrade 한다(scan 계층의
 * no-throw 규율과 동일). 어느 파일이 몇 줄 깨졌는지는 카운터로 남겨 화면에 표시한다.
 *
 * 성능 실측(이 기계, cold = 메모 없음 / warm = 메모 있음):
 *
 *   작은 트리   2파일   493 msg   7d 20ms  30d  6ms  all   5ms  cold  →  warm 전부 0ms
 *   실런 트리   8파일   720 msg   7d 23ms  30d 10ms  all   9ms  cold  →  warm 전부 0ms
 *   최악 트리  41파일 19,203 msg  7d 66ms  30d 268ms all 196ms  cold  →  warm 전부 0ms
 *
 * **폴링이 실제로 내는 비용은 warm 쪽이다**(0ms). cold 는 프로세스 첫 읽기 한 번뿐이고, 첫
 * 호출에는 JIT 워밍업이 섞여 있어 같은 트리에서 7d 가 30d 보다 느리게 나오기도 한다.
 * 그래서 (1) 파일 mtime 으로 창을 먼저 걸러 오래된 파일은 열지 않고, (2) `MAX_TOTAL_BYTES`로
 * 상한을 두고, (3) 파일 단위 집계를 메모한다.
 *
 * **전량 읽기를 쓰지 않는다.** `readFileSync(f, "utf-8")`은 UTF-16 문자열 때문에 파일 크기에
 * 비례하는 RSS 를 쓴다(실측: 105MB 파일 → +101MB). `MAX_TOTAL_BYTES` 상한은 *합계* 기준이라
 * 단일 파일의 peak 를 제어하지 못한다. 그래서 `readLines()`가 고정 버퍼로 청크를 읽어 줄 단위로
 * 넘긴다 — 같은 105MB 파일이 +71MB 로 내려간다.
 *
 * 개선 폭은 파일이 클 때만 의미가 있다. 26MB 파일에서는 +78MB → +73MB 로 7% 뿐이다. 남는 양은
 * 청크 버퍼가 아니라 유지되는 집계 구조체(날짜 버킷·세션 Set)와 OS 로 즉시 반납되지 않은 페이지다.
 * 즉 이 변경이 없앤 것은 **peak 가 파일 크기에 선형으로 따라 오르는 성질**이고, 상수 오버헤드는
 * 남는다. 디렉터리 단위 wall-clock 은 거의 그대로다 — 시간의 대부분이 읽기가 아니라 `JSON.parse`다.
 *
 * `fs.readSync` 기반인 이유: `Bun.file().stream()`·`.slice().text()`가 더 관용적이지만 async다.
 * `assemble`은 동기 함수이고 모든 렌더 경로가 그 위에 서 있으므로, 이 한 모듈 때문에 전체를
 * async로 물들이지 않는다.
 *
 * 메모가 host의 "캐시 없음" 불변식과 충돌하지 않는 이유: 키가 시각이 아니라 파일 정체성이다.
 * 트랜스크립트는 append-only이므로 내용이 바뀌면 size·mtime이 반드시 함께 바뀐다 — 즉 이 메모는
 * stale 값을 낼 수 없고, 같은 입력에 대한 재계산만 건너뛴다. 시간 기반 TTL 캐시가 아니다.
 * 디렉터리 해석 결과도 같은 규율로 메모한다(`TranscriptMemo` 주석 참조).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TrendWindow } from "../trend/trend";

/** 토큰 5종. `thinking`은 `output`의 부분집합이므로 합계에 더하지 않는다. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** output_tokens_details.thinking_tokens — output에 이미 포함된 값. */
  thinking: number;
}

/** 모델 단위 분해. 모델마다 단가가 달라 합계만으로는 해석이 안 된다. */
export interface ModelBreakdown {
  model: string;
  totals: TokenTotals;
  messages: number;
}

/** 일별 토큰 총량(= input + output + cacheRead + cacheCreate). */
export interface DailyPoint {
  /** `YYYY-MM-DD` (로컬 타임존 기준). */
  date: string;
  total: number;
}

/** 트랜스크립트 집계 결과. 실패는 예외가 아니라 카운터로 드러난다. */
export interface TranscriptAggregate {
  /** 읽은 트랜스크립트 디렉터리(절대 경로). 못 찾으면 null. */
  dir: string | null;
  /** 디렉터리 탐색에 사용한 slug 후보 경로 — 못 찾았을 때 화면에 무엇을 찾았는지 밝힌다. */
  triedPath: string;
  totals: TokenTotals;
  byModel: ModelBreakdown[];
  daily: DailyPoint[];
  /** usage를 들고 있는 메시지(assistant) 수. */
  messages: number;
  /** 그중 서브에이전트(isSidechain) 메시지 수. 토큰은 합계에 포함된다. */
  sidechainMessages: number;
  /** 서로 다른 sessionId 수. */
  sessions: number;
  firstAt: string | null;
  lastAt: string | null;
  filesRead: number;
  /** 창(mtime) 밖이라 열지 않은 파일 수. */
  filesSkipped: number;
  /** 바이트 상한에 걸려 읽지 못한 파일 수(0이 아니면 집계가 불완전하다). */
  filesCapped: number;
  /** JSON 파싱에 실패한 줄 수. */
  malformedLines: number;
  /** 열지 못한 파일 수(권한·삭제 경합 등). */
  unreadableFiles: number;
}

/** 파일 하나의 집계(메모 단위). 창 필터는 병합 시점에 적용한다. */
interface FileAggregate {
  /** `YYYY-MM-DD` → 모델 → 합계. 창 필터를 날짜 단위로 적용하기 위해 버킷으로 둔다. */
  days: Map<string, Map<string, TokenTotals & { messages: number }>>;
  /** 날짜 → 그 날짜에 등장한 sessionId. 창 필터 후 세션 수를 세기 위해 필요하다. */
  sessionsByDay: Map<string, Set<string>>;
  /** 날짜 → sidechain 메시지 수. */
  sidechainByDay: Map<string, number>;
  /** 날짜 → 그 날짜의 최소·최대 타임스탬프(ISO). */
  boundsByDay: Map<string, { first: string; last: string }>;
  malformedLines: number;
}

/**
 * 프로세스 수명 메모. 세 지도 모두 키에 파일 정체성을 담아 stale 값을 낼 수 없다.
 *
 * - `files`: 키 `path|size|mtimeMs` → 파일 단위 집계.
 * - `keyByPath`: path → 그 path의 현재 `files` 키. append-only 트랜스크립트는 폴링마다 새 키를
 *   만들므로, 이 역인덱스로 같은 path의 옛 엔트리를 O(1)에 지운다(죽은 키 적재 방지).
 * - `dirs`: 키 `root|projectsMtimeMs` → 해석된 디렉터리, **또는 미검출을 뜻하는 `null`**.
 *   미검출도 메모하는 것이 요점이다 — slug 미스는 예외가 아니라 정상 케이스이고(그 워크스페이스에서
 *   Claude Code를 돌린 적이 없음), 그때마다 전 디렉터리를 훑으면 폴링마다 헛일을 반복한다.
 */
export interface TranscriptMemo {
  files: Map<string, FileAggregate>;
  keyByPath: Map<string, string>;
  dirs: Map<string, string | null>;
}

/** 빈 메모를 만든다. `FileAggregate`를 외부에 노출하지 않기 위한 팩토리. */
export function createMemo(): TranscriptMemo {
  return { files: new Map(), keyByPath: new Map(), dirs: new Map() };
}

export interface ReaderDeps {
  /** 홈 디렉터리(테스트 주입). 기본 os.homedir(). */
  home?: string;
  /** 기준 시각(테스트 주입 — 창 경계 결정). */
  now?: Date;
  /** 파일 단위 집계 메모(호출자가 프로세스 수명 동안 재사용). */
  memo?: TranscriptMemo;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const WINDOW_MS: Record<Exclude<TrendWindow, "all">, number> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

/**
 * 한 번의 집계에서 읽는 최대 바이트. 최신 파일부터 읽으므로 상한에 걸리면 오래된 파일이
 * 떨어진다. 이 상한이 걸리는 최악 트리의 30일 창이 실측 268ms(41파일 읽고 18파일 탈락)이므로
 * 프로세스 첫 읽기 1회 예산으로 잡았다 — 이후 폴링은 메모가 받아 0ms다. 상한에 걸린 파일
 * 수는 `filesCapped`로 노출해 조용히 잘리지 않게 한다.
 */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/** 메모 상한(엔트리 수). 초과 시 가장 먼저 들어온 것부터 버린다. */
const MAX_MEMO_ENTRIES = 512;

/** `readLines`의 청크 크기. 줄 하나가 평균 12KB라 1MB면 청크당 수십 줄이 담긴다. */
const CHUNK_BYTES = 1024 * 1024;

/** `firstCwd`가 읽는 머리 크기. 첫 레코드 하나만 필요하다. */
const HEAD_BYTES = 16 * 1024;

/**
 * 워크스페이스 경로를 Claude Code 트랜스크립트 디렉터리 이름으로 변환한다.
 *
 * 규칙은 실측으로 확인했다(`/`·`.`·`_` → `-`, 대문자 보존):
 *   /Users/me/Development/ai-dlc/_accounts/AcmeCorp/x
 *   → -Users-me-Development-ai-dlc--accounts-AcmeCorp-x
 */
export function projectSlug(root: string): string {
  return root.replace(/[/._]/g, "-");
}

/**
 * 파일을 고정 버퍼로 청크 읽어 줄 단위로 넘긴다. 전량을 문자열로 만들지 않으므로 peak 메모리가
 * 청크 + 가장 긴 한 줄로 묶인다. 던지지 않고 성공 여부만 반환한다.
 *
 * `TextDecoder({stream:true})`로 디코드하는 이유: 청크 경계가 UTF-8 멀티바이트 시퀀스를 가를 수
 * 있는데, stream 모드가 잘린 꼬리를 다음 호출까지 들고 있어준다.
 */
function readLines(file: string, onLine: (line: string) => void): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let carry = "";
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      carry += decoder.decode(buf.subarray(0, n), { stream: true });
      // 인덱스를 옮겨가며 훑고 청크당 slice 는 한 번만 한다(줄마다 재slice 하면 O(n²)).
      let start = 0;
      let nl = carry.indexOf("\n", start);
      while (nl !== -1) {
        onLine(carry.slice(start, nl));
        start = nl + 1;
        nl = carry.indexOf("\n", start);
      }
      if (start > 0) carry = carry.slice(start);
    }
    carry += decoder.decode();
    if (carry.length > 0) onLine(carry);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 이미 닫혔거나 닫을 수 없으면 할 일이 없다.
    }
  }
}

/**
 * 트랜스크립트가 스스로 기록한 `cwd`를 읽는다. **머리 부분만 읽는다** — 첫 레코드만 필요한데
 * 전량을 읽으면 디렉터리 훑기 한 번에 수십 MB를 문자열로 만든다(실측: 102개 디렉터리 64MB).
 *
 * 첫 줄이 `HEAD_BYTES`보다 길어 잘리면 `JSON.parse`가 실패하므로, 그때는 머리에서 `cwd` 필드를
 * 정규식으로 긁는다. 잘린 레코드에서도 값을 얻기 위한 폴백이다.
 */
function firstCwd(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  let head: string;
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    if (n === 0) return undefined;
    head = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, n));
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 위와 같다.
    }
  }

  for (const line of head.split("\n")) {
    if (line.length === 0) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      // 잘린 줄일 수 있다 — 정규식 폴백으로.
    }
  }
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (m?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function jsonlFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * `root`에 대응하는 트랜스크립트 디렉터리를 찾는다.
 *
 * 1차는 slug 규칙(stat 한 번). 실패하면 프로젝트 디렉터리들을 훑어 트랜스크립트가 스스로
 * 기록한 `cwd` 필드가 `root`와 일치하는 곳을 찾는다 — slug 규칙이 미래에 바뀌어도 이
 * 2차 경로가 흡수한다(harness 탐색을 고정 목록이 아닌 open set으로 둔 것과 같은 이유).
 */
export function findTranscriptDir(
  root: string,
  home: string,
  memo?: TranscriptMemo,
): string | undefined {
  const base = path.join(home, ".claude", "projects");
  const bySlug = path.join(base, projectSlug(root));
  try {
    if (fs.statSync(bySlug).isDirectory()) return bySlug;
  } catch {
    // 2차 탐색으로.
  }

  // 여기부터가 비싼 경로다(실측: 102개 디렉터리 64MB 훑기 → 121ms). 결과를 메모하되 키에
  // projects 디렉터리의 mtime 을 넣어, 프로젝트 디렉터리가 생기거나 사라지면 자동 무효화된다.
  let baseMtime: number;
  try {
    baseMtime = fs.statSync(base).mtimeMs;
  } catch {
    return undefined;
  }
  const dirKey = `${root}|${baseMtime}`;
  if (memo?.dirs.has(dirKey)) return memo.dirs.get(dirKey) ?? undefined;

  const resolved = scanForCwdMatch(base, root);
  if (memo !== undefined) {
    if (memo.dirs.size >= MAX_MEMO_ENTRIES) {
      const oldest = memo.dirs.keys().next();
      if (!oldest.done) memo.dirs.delete(oldest.value);
    }
    // 미검출(`null`)도 저장한다 — 이게 이 메모의 존재 이유다.
    memo.dirs.set(dirKey, resolved ?? null);
  }
  return resolved;
}

/** 프로젝트 디렉터리들을 훑어 트랜스크립트가 기록한 `cwd` 가 `root` 와 같은 곳을 찾는다. */
function scanForCwdMatch(base: string, root: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    const files = jsonlFiles(dir);
    if (files.length === 0) continue;
    // 가장 최근 파일 하나만 확인한다(디렉터리당 1파일).
    let newest = files[0] as string;
    let newestMs = -1;
    for (const f of files) {
      try {
        const ms = fs.statSync(f).mtimeMs;
        if (ms > newestMs) {
          newestMs = ms;
          newest = f;
        }
      } catch {
        // 건너뛴다.
      }
    }
    if (firstCwd(newest) === root) return dir;
  }
  return undefined;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 };
}

function addTotals(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreate += from.cacheCreate;
  into.thinking += from.thinking;
}

/** 토큰 총량 = 실제로 이동한 토큰. thinking은 output의 부분집합이라 제외한다. */
export function totalOf(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheCreate;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** ISO 타임스탬프 → 로컬 `YYYY-MM-DD`. 파싱 불가면 undefined. */
function dayKey(ts: string): string | undefined {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return undefined;
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 파일 하나를 날짜 버킷으로 집계한다. 던지지 않는다. 열 수 없으면 undefined. */
function parseFile(file: string): FileAggregate | undefined {
  const agg: FileAggregate = {
    days: new Map(),
    sessionsByDay: new Map(),
    sidechainByDay: new Map(),
    boundsByDay: new Map(),
    malformedLines: 0,
  };

  const ok = readLines(file, (line) => {
    // 값싼 사전 필터 — usage가 없는 줄(user 메시지·요약 등)은 JSON.parse까지 가지 않는다.
    if (line.length === 0 || !line.includes('"usage"')) return;

    let rec: {
      timestamp?: unknown;
      sessionId?: unknown;
      isSidechain?: unknown;
      message?: { model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      agg.malformedLines++;
      return;
    }

    const usage = rec.message?.usage;
    if (typeof usage !== "object" || usage === null) return;
    if (typeof rec.timestamp !== "string") return;
    const day = dayKey(rec.timestamp);
    if (day === undefined) return;

    const details = usage.output_tokens_details;
    const totals: TokenTotals = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      thinking:
        typeof details === "object" && details !== null
          ? num((details as Record<string, unknown>).thinking_tokens)
          : 0,
    };

    const model = typeof rec.message?.model === "string" ? rec.message.model : "(unknown)";
    let byModel = agg.days.get(day);
    if (byModel === undefined) {
      byModel = new Map();
      agg.days.set(day, byModel);
    }
    let slot = byModel.get(model);
    if (slot === undefined) {
      slot = { ...emptyTotals(), messages: 0 };
      byModel.set(model, slot);
    }
    addTotals(slot, totals);
    slot.messages++;

    if (typeof rec.sessionId === "string") {
      let seen = agg.sessionsByDay.get(day);
      if (seen === undefined) {
        seen = new Set();
        agg.sessionsByDay.set(day, seen);
      }
      seen.add(rec.sessionId);
    }

    if (rec.isSidechain === true) {
      agg.sidechainByDay.set(day, (agg.sidechainByDay.get(day) ?? 0) + 1);
    }

    const bounds = agg.boundsByDay.get(day);
    if (bounds === undefined) {
      agg.boundsByDay.set(day, { first: rec.timestamp, last: rec.timestamp });
    } else {
      if (rec.timestamp < bounds.first) bounds.first = rec.timestamp;
      if (rec.timestamp > bounds.last) bounds.last = rec.timestamp;
    }
  });

  return ok ? agg : undefined;
}

function memoGet(memo: TranscriptMemo | undefined, key: string): FileAggregate | undefined {
  return memo?.files.get(key);
}

/**
 * 집계를 메모한다. 같은 path 의 옛 키를 먼저 지운다 — append-only 트랜스크립트는 폴링마다 새
 * 키를 만들므로 이걸 안 하면 죽은 엔트리가 상한까지 쌓여 살아있는 엔트리를 밀어낸다.
 */
function memoSet(
  memo: TranscriptMemo | undefined,
  path: string,
  key: string,
  value: FileAggregate,
): void {
  if (memo === undefined) return;
  const previous = memo.keyByPath.get(path);
  if (previous !== undefined && previous !== key) memo.files.delete(previous);
  if (memo.files.size >= MAX_MEMO_ENTRIES) {
    const oldest = memo.files.keys().next();
    if (!oldest.done) memo.files.delete(oldest.value);
  }
  memo.files.set(key, value);
  memo.keyByPath.set(path, key);
}

/**
 * 워크스페이스의 Claude Code 토큰 사용량을 창별로 집계한다.
 *
 * @param root   대시보드가 보고 있는 워크스페이스 절대 경로.
 * @param window 집계 창(7d/30d/all).
 */
export function readTranscripts(
  root: string,
  window: TrendWindow = "30d",
  deps: ReaderDeps = {},
): TranscriptAggregate {
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? new Date();
  const triedPath = path.join(home, ".claude", "projects", projectSlug(root));

  const empty: TranscriptAggregate = {
    dir: null,
    triedPath,
    totals: emptyTotals(),
    byModel: [],
    daily: [],
    messages: 0,
    sidechainMessages: 0,
    sessions: 0,
    firstAt: null,
    lastAt: null,
    filesRead: 0,
    filesSkipped: 0,
    filesCapped: 0,
    malformedLines: 0,
    unreadableFiles: 0,
  };

  const dir = findTranscriptDir(root, home, deps.memo);
  if (dir === undefined) return empty;

  const cutoffMs = window === "all" ? Number.NEGATIVE_INFINITY : now.getTime() - WINDOW_MS[window];

  // 최신 파일부터 — 바이트 상한에 걸리면 오래된 쪽이 떨어져야 한다.
  const stated: { file: string; size: number; mtimeMs: number }[] = [];
  let unreadableFiles = 0;
  for (const file of jsonlFiles(dir)) {
    try {
      const st = fs.statSync(file);
      stated.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      unreadableFiles++;
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const merged: TranscriptAggregate = { ...empty, dir, totals: emptyTotals(), unreadableFiles };
  const dayTotals = new Map<string, number>();
  const modelTotals = new Map<string, ModelBreakdown>();
  const sessions = new Set<string>();
  let bytes = 0;

  for (const { file, size, mtimeMs } of stated) {
    // mtime은 마지막 append 시각이므로, 그보다 오래된 파일의 모든 줄은 창 밖이다.
    if (mtimeMs < cutoffMs) {
      merged.filesSkipped++;
      continue;
    }
    if (bytes + size > MAX_TOTAL_BYTES) {
      merged.filesCapped++;
      continue;
    }

    const key = `${file}|${size}|${mtimeMs}`;
    let agg = memoGet(deps.memo, key);
    if (agg === undefined) {
      const parsed = parseFile(file);
      if (parsed === undefined) {
        merged.unreadableFiles++;
        continue;
      }
      agg = parsed;
      memoSet(deps.memo, file, key, agg);
    }
    bytes += size;
    merged.filesRead++;
    merged.malformedLines += agg.malformedLines;

    for (const [day, byModel] of agg.days) {
      const bounds = agg.boundsByDay.get(day);
      // 파일 mtime보다 정밀한 2차 필터. 경계는 날짜 단위다 — 그 날의 마지막 메시지가 창
      // 안이면 하루를 통째로 포함한다. 일별 막대를 반쪽으로 자르지 않기 위한 선택이며,
      // 그래서 창 경계일의 값은 창 시작 이전 몇 시간을 포함할 수 있다.
      if (bounds !== undefined && Date.parse(bounds.last) < cutoffMs) continue;

      for (const [model, slot] of byModel) {
        let row = modelTotals.get(model);
        if (row === undefined) {
          row = { model, totals: emptyTotals(), messages: 0 };
          modelTotals.set(model, row);
        }
        addTotals(row.totals, slot);
        row.messages += slot.messages;
        addTotals(merged.totals, slot);
        merged.messages += slot.messages;
        dayTotals.set(day, (dayTotals.get(day) ?? 0) + totalOf(slot));
      }

      merged.sidechainMessages += agg.sidechainByDay.get(day) ?? 0;
      for (const s of agg.sessionsByDay.get(day) ?? []) sessions.add(s);
      if (bounds !== undefined) {
        if (merged.firstAt === null || bounds.first < merged.firstAt) merged.firstAt = bounds.first;
        if (merged.lastAt === null || bounds.last > merged.lastAt) merged.lastAt = bounds.last;
      }
    }
  }

  merged.sessions = sessions.size;
  merged.byModel = [...modelTotals.values()].sort((a, b) => totalOf(b.totals) - totalOf(a.totals));
  merged.daily = [...dayTotals.entries()]
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return merged;
}
