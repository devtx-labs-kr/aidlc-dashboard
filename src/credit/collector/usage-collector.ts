/**
 * UsageCollector — `kiro-cli chat --no-interactive "/usage"`를 실행해 원시 출력을
 * 획득한다(BR1.1~BR1.5). 파싱 로직은 포함하지 않는다.
 *
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본. `CollectResult`·`SpawnFn`·`buildMinimalEnv`·
 * `USAGE_ARGV`는 u2 소유이며 이 모듈에서 정의·export한다.
 *
 * 하드 계약(security-design NFR1.x / 확정 규칙):
 * - 셸 문자열 보간 없이 **인자 배열(argv)**로 spawn한다(`shell: true` 금지, NFR1.1).
 * - 하위 프로세스에는 **최소 환경변수만** 전달한다(least privilege, NFR1.2).
 * - **타임아웃**(15s)을 적용하고, 타임아웃·비정상(non-zero) 종료·빈 출력을 실패로 분류해
 *   방어적 파싱 폴백 경로로 넘긴다(BR1.3·BR1.4).
 * - `/usage` 원문을 영구 로그/파일로 기록하지 않는다(휘발성) — 이 모듈은 값을 반환만 하며
 *   어떤 파일에도 쓰지 않는다.
 * - stdout을 read한 뒤 **512KB 지점에서 절단**해 파서로 넘긴다(NFR1.4).
 *
 * 타임아웃은 `Bun.spawn`의 네이티브 `timeout`·`killSignal`로 강제한다(직접 setTimeout으로
 * `proc.kill()`을 부르던 구현을 대체). 손으로 걸던 쪽에는 두 결함이 있었다 — (1) SIGTERM을
 * 무시하는 자식이 있으면 파이프가 닫히지 않아 시한과 무관하게 영구 대기했고, (2) 정상 종료와
 * 타이머 발화가 겹치면 완전한 출력을 갖고도 타임아웃으로 분류될 수 있었다.
 *
 * 절단을 `maxBuffer`(상한 초과 시 Bun이 프로세스를 죽이는 네이티브 옵션)로 옮기지 않은 것은
 * 의도적이다. `/usage` 패널은 출력 머리에 있어 **512KB 앞부분만으로도 파싱이 성립**하는데,
 * 상한에서 죽이면 그 앞부분까지 실패로 떨어진다. 대신 상한 초과 출력은 절단해 파서로 넘긴다.
 *
 * 테스트 가능성: spawn 실행기를 주입 가능(SpawnFn)하게 하여 실제 CLI를 호출하지 않고
 * 성공/타임아웃/비정상 종료/빈 출력/실행 오류/512KB 절단을 격리 검증한다(NFR5).
 */

/** 수집 결과 판별 유니언. 실패 시 진단용 detail을 함께 전달한다. */
export type CollectResult =
  | { ok: true; raw: string }
  | { ok: false; reason: string; detail: string };

/** 주입 가능한 spawn 실행기가 반환하는 저수준 결과. */
export interface SpawnOutcome {
  /** 프로세스 종료 코드. 미확정(강제 종료 등)이면 null. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 타임아웃으로 강제 종료되었는지 여부. */
  timedOut: boolean;
}

/** spawn 실행기 시그니처. 기본 구현은 Bun.spawn을 사용한다. */
export type SpawnFn = (
  argv: string[],
  opts: { timeoutMs: number; env: Record<string, string> },
) => Promise<SpawnOutcome>;

/** 수집기 의존성(테스트에서 주입). */
export interface CollectorDeps {
  spawn?: SpawnFn;
  /** 하위 프로세스 타임아웃(ms). 기본 15s (CLI 콜드 스타트 + 네트워크 여유). */
  timeoutMs?: number;
  /** 환경변수 소스(테스트 주입용). 기본 process.env. */
  envSource?: Record<string, string | undefined>;
}

/** `/usage` 조회에 사용하는 고정 argv. 절대 문자열 보간하지 않는다. */
export const USAGE_ARGV: readonly string[] = ["kiro-cli", "chat", "--no-interactive", "/usage"];

const DEFAULT_TIMEOUT_MS = 15_000;
/** 진단 detail 최대 길이(과도한 블롭 방지). */
const MAX_DETAIL_LEN = 4_000;
/** 파서로 넘기는 stdout 원문의 최대 바이트 상한(512KB, security-design NFR1.4). */
export const MAX_STDOUT_BYTES = 512 * 1024;

/**
 * 최소 환경변수 집합을 구성한다(least privilege). kiro-cli가 자기 자신과 설정·인증을
 * 찾는 데 필요한 최소 키만 통과시킨다.
 */
export function buildMinimalEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const allow = ["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/**
 * 문자열을 UTF-8 기준 maxBytes로 절단한다. 상한 이하이면 원본 그대로 반환한다.
 * 상한을 넘으면 앞에서부터 maxBytes만큼 잘라 반환한다(불완전 멀티바이트 꼬리는 디코더가
 * 안전하게 처리). ASCII 입력에서는 바이트 상한이 곧 문자 상한이다.
 */
function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const sliced = Buffer.from(s, "utf8").subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(sliced);
}

/**
 * 프로세스가 죽은 뒤 파이프가 닫히기를 기다리는 유예. 자식이 죽어도 손자 프로세스가 stdout을
 * 물고 있으면 읽기가 끝나지 않으므로, 그 경우를 시한 안에서 포기하기 위한 상한이다.
 */
const DRAIN_GRACE_MS = 2_000;

/** 기본 spawn 구현 — Bun.spawn을 argv로 실행하고 네이티브 타임아웃을 건다. */
export const defaultSpawn: SpawnFn = async (argv, { timeoutMs, env }) => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) {
    return { exitCode: null, stdout: "", stderr: "빈 argv", timedOut: false };
  }
  const proc = Bun.spawn([cmd, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    // 기본 SIGTERM이 아니라 SIGKILL을 쓴다 — 시그널을 무시하는 자식이 있으면 아래 파이프
    // 읽기가 풀리지 않는다. `/usage` 조회는 정리할 상태가 없는 읽기라 즉시 종료로 잃는 게 없다.
    killSignal: "SIGKILL",
  });

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
    new Promise<null>((resolve) => {
      drainTimer = setTimeout(() => resolve(null), timeoutMs + DRAIN_GRACE_MS);
      drainTimer.unref();
    }),
  ]);
  clearTimeout(drainTimer);

  if (drained === null) {
    // 프로세스는 네이티브 타임아웃이 이미 죽였는데 파이프가 닫히지 않았다. 여기서 더 기다리면
    // 폴링 tick이 끝나지 않고 쌓이므로, 읽던 출력을 버리고 타임아웃으로 확정한다.
    //
    // 버린 읽기는 취소하지 않는다 — 스트림이 `Response`에 잠겨 있어 `cancel()`이 던진다. 그래서
    // 이 경로를 한 번 타면 대기 중인 리더가 이벤트 루프를 붙잡고 있어 프로세스가 스스로 끝나지
    // 않는다(실측 확인). 서버는 SIGINT/SIGTERM에서 `process.exit`으로 내려가므로 영향이 없다.
    return { exitCode: null, stdout: "", stderr: "", timedOut: true };
  }

  await proc.exited;
  const [stdout, stderr] = drained;
  return {
    // 시그널 종료면 null(SpawnOutcome 계약). `await proc.exited`의 반환값은 시그널을 128+n으로
    // 접어 주므로 쓰지 않는다.
    exitCode: proc.exitCode,
    stdout,
    stderr,
    // SIGKILL은 위에서 건 시한으로만 발생한다. 외부에서 온 SIGKILL이라도 출력은 불완전하므로
    // 실패로 분류하는 쪽이 맞다.
    timedOut: proc.signalCode === "SIGKILL",
  };
};

function truncateDetail(s: string): string {
  return s.length > MAX_DETAIL_LEN ? `${s.slice(0, MAX_DETAIL_LEN)}…(생략)` : s;
}

/**
 * `/usage`를 수집한다. 예외를 던지지 않고 CollectResult를 반환한다.
 */
export async function collectUsage(deps: CollectorDeps = {}): Promise<CollectResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildMinimalEnv(deps.envSource ?? process.env);

  let outcome: SpawnOutcome;
  try {
    outcome = await spawn([...USAGE_ARGV], { timeoutMs, env });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "수집 실패: 프로세스 실행 오류", detail: truncateDetail(detail) };
  }

  if (outcome.timedOut) {
    return {
      ok: false,
      reason: `수집 실패: 타임아웃(${timeoutMs}ms 초과)`,
      detail: truncateDetail(outcome.stderr || outcome.stdout),
    };
  }

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      reason: `수집 실패: 비정상 종료(exit ${outcome.exitCode})`,
      detail: truncateDetail(outcome.stderr || outcome.stdout),
    };
  }

  // 일부 CLI 빌드는 /usage 패널을 stderr로 렌더한다(exit 0). stdout이 비어 있으면
  // stderr를 원문 소스로 사용한다. 둘 다 비어 있을 때만 빈 출력 실패로 분류한다.
  const source = outcome.stdout.trim().length > 0 ? outcome.stdout : outcome.stderr;
  if (source.trim().length === 0) {
    return {
      ok: false,
      reason: "수집 실패: 빈 출력",
      detail: "",
    };
  }

  // stdout을 read한 뒤 512KB 지점에서 절단해 파서로 넘긴다(NFR1.4).
  const raw = truncateBytes(source, MAX_STDOUT_BYTES);
  return { ok: true, raw };
}
