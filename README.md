# aidlc-dashboard

AI-DLC v2 실런의 **현황·진행·크레딧 사용량을 한 화면에서 보는 웹 대시보드.** 워크스페이스의
`aidlc/` 문서 트리를 파싱해서 서버가 HTML 을 만들어 준다. bun 만 있으면 돌고, 추가 런타임이나
빌드 단계가 없다.

워크스페이스에는 쓰지 않는다. 게이트 승인·stage 전이는 실행 도구의 몫이고, 이 대시보드는
관측만 한다. 크레딧 이력만 별도 SQLite 파일(`data/usage.db`, gitignored)에 저장한다.

### 가장 쉬운 방법 — 실행 스크립트

터미널에서 실행한다.

| OS | 실행 |
|---|---|
| macOS / Linux | `./start.sh` |
| Windows | `.\start.cmd` (또는 `.\start.ps1`) |

스크립트가 bun 을 찾고, 최초 1회 의존성을 설치하고, 서버를 띄운 뒤 **브라우저를 자동으로 연다.**
경로를 주면 그 워크스페이스로 바로 열리고, 안 주면 폴더 선택 화면이 뜬다. 서버 플래그도 그대로
전달된다.

⚠️Windows 에서 `.\start.ps1` 이 "running scripts is disabled on this system" 으로 막히면
`.\start.cmd` 를 쓴다 — 그 호출에만 실행 정책을 우회하고 시스템 설정은 바꾸지 않는다.

```bash
./start.sh                                   # 폴더 선택 화면
./start.sh ~/path/to/workspace               # 바로 그 트리로 (--root 생략 가능)
./start.sh ~/path/to/workspace --port 5000   # 플래그는 그대로 전달
```
```powershell
.\start.cmd
.\start.cmd C:\path\to\workspace
.\start.cmd --port 5000
```

bun 이 없으면 설치 명령을 안내하고 멈춘다(더블클릭한 창은 읽을 수 있게 대기한다).

### 직접 실행

```bash
bun install
bun run src/server.ts                        # 폴더 선택 화면으로 시작
bun run src/server.ts --root ~/path/to/ws    # 바로 그 워크스페이스로 시작
# → http://localhost:4321
```

`--root` 를 빼면 **브라우저에서 폴더를 골라** 시작한다. 헤더의 **📁 폴더 변경** 으로 실행 중에도
다른 워크스페이스로 갈아탈 수 있다(재시작 불필요).

### 폴더 선택 화면

선택 화면을 열면 사용자 홈과 `Development`·`Developer`·`Projects`·`Code` 같은 개발 위치에서
`aidlc/` 를 품은 워크스페이스를 자동으로 찾는다. Windows 에서는 `USERPROFILE`과
`OneDrive`·`OneDriveConsumer`·`OneDriveCommercial` 위치도 함께 찾는다. 검색은 심볼릭 링크,
숨김 폴더, `node_modules`·빌드 출력 등을 따라가지 않고 최대 5,000개 디렉터리에서 멈춘다.

첫 작업 영역인 **폴더 탐색**은 사용자 홈에서 시작한다. 폴더 이름을 눌러 이동하고, `aidlc/`를 품은
폴더에는 **열기** 동작이 표시된다. 모든 OS가 동일한 루트 탭, 클릭 가능한 breadcrumb, 현재 폴더의
디렉터리 목록, 이름 필터를 사용한다. macOS는 홈·파일시스템·`/Volumes` 볼륨, Linux는
홈·파일시스템·`/mnt`·`/media` 마운트, Windows는 홈·사용 가능한 드라이브·OneDrive를 루트로
제공한다.

탐색기 아래에는 경로 직접 입력과 자동 검색 결과가 보조 선택 수단으로 유지된다. 직접 경로는 `~`로
시작해도 되며, 워크스페이스가 아닌 경로는 사유와 함께 거부한다. `aidlc` 폴더 자체를 골라도 부모를
워크스페이스로 잡는다.

> **왜 OS 폴더 선택창이 아닌가.** 브라우저의 `<input webkitdirectory>` 와 File System Access API
> 는 **절대 경로를 주지 않는다**(전자는 파일 목록만, 후자는 샌드박스 핸들만). 서버가 읽을 경로가
> 필요하므로 로컬 서버가 제한적으로 검색하고 디렉터리를 나열한다. 서버는 `localhost` 에만
> 바인딩되고 목록은 **폴더 이름·타입·워크스페이스 여부만** 노출하며 파일 내용은 읽지 않는다.
> 선택된 경로는 **서버가 직접 검증**한 것만 활성화된다(클라이언트 문자열이 그대로 root 가
> 되지 않는다).

| 플래그 | 뜻 | 기본값 |
|---|---|---|
| `--root <path>` | `aidlc/` 를 품은 워크스페이스 루트. **생략 가능**(생략 시 폴더 선택 화면) | — |
| `--port <n>` | HTTP 포트. `AIDLC_DASHBOARD_PORT`로도 설정 가능 | `4321` |
| `--poll <ms>` | 브라우저 자동 갱신 주기, `0` 이면 끔(수동 새로고침은 계속 동작) | `60000` |
| `--interval <ms>` | 크레딧 자동 수집 주기. `AIDLC_DASHBOARD_INTERVAL_MS`로도 설정 가능 | `300000` |
| `--harness <dir>` | stage 카탈로그를 읽을 harness 디렉터리. **보통 불필요**(자동 탐색) | 자동 |

라우트: `/` (대시보드 · 미선택 시 폴더 선택) · `/pick`·`/browse` (폴더 선택) · `/select` (선택 확정)
· `/api/body` (갱신용 본문) · `/api/model` (조립된 JSON) · `/api/current` (현재 크레딧)
· `/api/trend?window=7d|30d|all` (크레딧 추이) · `POST /api/refresh` (즉시 수집) · `/healthz`.

## harness 중립 — Kiro CLI/IDE/Claude Code 무관

**대시보드는 `aidlc/` 문서 트리만 본다.** 이 트리는 harness 와 무관하게 동일하므로 어느 harness 로
돌린 실런이든 같은 판정이 나온다. 실측(같은 실런 트리의 harness 디렉터리만 바꿔서 대조):

| 트리 | harness | 결과 |
|---|---|---|
| 원본 | `.kiro` | 85% · audit 4228 · 블로커 2 · codegen 3c+1p/9 · 경고 0 |
| 복사 | `.claude` | **동일** |
| 복사 | `.aidlc` | **동일** |
| `aidlc/` 만 | 미검출 | 85% · audit 4228 · 블로커 2 · **codegen 4c+0p/9** · 경고 1 |

`--root` 는 `aidlc/` 만 있으면 통과한다(harness 디렉터리는 필수가 아니다). 단 마지막 줄이 보여주듯
**stage 카탈로그가 없으면 유닛 매트릭스가 2-state 로 떨어져 막힌 유닛이 complete 로 보인다**
(PU-3 이 사라진다). 그래서 이 열화는 조용히 넘어가지 않고 화면 최상단 경고 + 배지 + 매트릭스
각주로 세 곳에 표시되며, `--harness` 로 지정하라고 안내한다.

harness 디렉터리는 **고정 목록 매칭이 아니라 탐색**이다: `tools/data/stage-graph.json` 을 품은
dot-디렉터리를 찾는다. `.claude`·`.kiro`·`.aidlc` 를 먼저 보고(여러 개 공존하는 dev 트리에서
`.claude` 가 이기는 엔진 규칙과 동일) 없으면 나머지 dot-디렉터리를 훑으므로, **아직 없는 harness 도
코드 수정 없이 잡힌다**. 근거=엔진 자신의 `aidlc-lib.ts` `deriveHarnessDir()`/`KNOWN_HARNESS_DIRS`
(그 목록도 "존재하는 harness 집합이 아니라 probe 순서 힌트"라고 주석에 명시).

```bash
bun run verify        # 타입 검사 + Biome + 전체 테스트
bun run dev           # 파일 변경 감지 개발 서버
```

---

## 무엇을 보여주나

- **크레딧** — 현재 사용량·잔량·한도·리셋일, 7일/30일/전체 추이, 수집 실패와 신선도.
- **진행** — 전체 % · phase 5개 · stage 체크박스 · **Construction 유닛 매트릭스**(3-state) ·
  bolt DAG 배치.
- **시간** — stage 별 gantt + **IDLE/AGENT/WORK 3분해**.
- **결정과 이슈** — 후속 확인 후보 · 최근 결정 · 계획 변경 · 해결 기록.

---

## 데이터 계약과 함정 (읽기 전 필수)

이 대시보드의 설계 대부분은 아래 사실들에서 나왔다. 실런 트리(9 unit·4,228 이벤트) 실측이다.

### ⚠️ `runtime-graph.json` 은 최신이 아니다

재컴파일이 감사 기록 꼬리 3블록의 transition 정규식
(`GATE_APPROVED|STAGE_STARTED|STAGE_AWAITING_APPROVAL|AUDIT_MERGED|WORKFLOW_COMPLETED`,
`hooks/aidlc-runtime-compile.ts`)에 걸려야 발동한다. **stage 중간에는 감사 기록만 자라고 그래프는
멈춰 있다** — 즉 사람이 실제로 지켜보고 싶은 구간에서 체계적으로 뒤처진다.

실측: 그래프가 감사 기록보다 **19.2시간** 뒤처지고, 진행 중 stage 의 `sensor_firings` 가 `[]` 인데
감사 기록에는 178건이 있었다. 되돌아간 stage 까지 합쳐 **6개 stage 를 과소 보고**했다
(예: feasibility 64 vs 실제 120).

그래서 sensor 집계는 **감사 기록이 정본**이고 그래프는 교차검증용이며, 화면에는 신선도 배지가
붙는다. `bolt_dag`(유닛 명부·kind·위상)는 그래프에서만 오지만 구조 정보라 지연에 둔감하다.

### 유닛 셀은 2-state 로는 부족하다

세그먼트 디렉터리가 비어 있지 않으면 "있음"으로 보는 방식은 **과대 보고**한다. 계획 승인 질문에서
멈춘 유닛은 `code-generation-plan.md` + `-questions.md` 만 있고 `code-summary.md` 가 없는데도
완료로 잡혀서, 정작 막힌 유닛이 화면에서 사라진다.

그래서 `stage-graph.json` 의 `produces` ∪ `optional_produces` 를 유닛 `kind` 로 `produces_kinds`
필터를 걸어 기대 산출물을 구하고, 디스크와 교집합해 **absent / partial / complete** 로 나눈다.
검증: 4 stage × 9 unit = 31개 실측 셀 중 **30개 정확 일치**, 유일한 불일치가 곧 실제 블로커였다.
카탈로그가 없으면 2-state 로 degrade 하되 그 사실을 화면에 표시한다(위 harness 절 참조).

### `**Context**` 4-segment 형태가 두 가지다

```
inception   > practices-discovery > contributions       > x.md   ← slot2=하위디렉터리, stage=slot1
construction > PU-1-walking-skeleton > functional-design > x.md   ← slot2=stage, slot1=유닛
```

`ARTIFACT_CREATED`/`ARTIFACT_UPDATED` 에는 `**Stage**` 필드가 없어 `Context` 로만 stage 를 알 수
있는데, **위치만으로는 두 형태를 구분할 수 없다.** 항상 slot1 을 쓰면 per-unit stage 를 통째로
놓치고(참고: `harness_timing_report.py` 가 이 쪽), 4-segment 면 항상 slot2 를 쓰면 하위 디렉터리를
가진 stage 를 오귀속한다. 그래서 **워크스페이스의 stage 카탈로그에 물어본다**(`isStage` 오라클).
실측 교정: practices-discovery 21→24, functional-design 50 (양쪽 다 정답).

### `block-count.json` 의 `count` 는 무진척 카운터다

전진하면 0으로 리셋되고 연속으로 진척이 없을 때만 오른다(`hooks/aidlc-stop.ts`). **값이 크면
"활발"이 아니라 "막힘"** 이다 — heartbeat 로 읽으면 진단이 정반대가 된다. 진단 모델은 이 의미로
값을 보존하지만 기본 화면에는 원시 Hook 상태를 노출하지 않는다.

### 그 밖의 계약

- **audit 은 clone 별 샤딩** — `audit/<host>-<clone12hex>.md`. 전 shard 를 읽어 시간순 병합한다.
  큰 shard 하나만 읽으면 다른 개발자의 작업이 조용히 사라진다.
- **실패한 sensor 만 상세 파일을 남긴다** — 46개 파일 전부 `Pass: false`, 감사 기록의
  `SENSOR_FAILED` 도 정확히 46. 통과 건수는 감사 기록에서만 나온다.
- **park/unpark 로 IDLE 을 못 계산한다** — 실측 PARKED 50 vs UNPARKED 32, SESSION_STARTED 13 vs
  SESSION_ENDED 246 으로 짝이 맞지 않는다. 그래서 구간 페어링이 아니라 이벤트 간 공백 분류를 쓴다.
- **0초 stage 는 정상이다** — bootstrap 3종은 STARTED/COMPLETED 가 같은 초에 찍힌다.
  `elapsed > 0` 로 걸러내면 완료 stage 가 미완으로 뒤집힌다.
- **`state.md` 지연은 결함이 아니다** — `Last Updated` 는 전이 시점 스탬프라 stage 중에는 항상
  뒤처진다. 그래서 stale 로 표시하지 않는다(배지를 무시하게 만들면 runtime-graph 경고가 죽는다).

---

## 구조

```
start.sh             macOS/Linux 런처
start.cmd            Windows 런처 (실행 정책 우회 래퍼 → start.ps1)
start.ps1            Windows 런처 본체
src/
  server.ts          Bun.serve — 요청마다 트리를 다시 읽는다 (전체 ~10ms, 캐시 없음)
                     + 선택된 root 를 담은 유일한 가변 상태(폴더 변경용)
  cli.ts             인자 파싱 + 기동 시 검증 + ~ 확장
  scan/              디스크 → 타입 모델 (throw 하지 않는다)
    browse.ts        폴더 선택용 디렉터리 나열 + 워크스페이스 판정
    explorer.ts      OS별 탐색 루트 어댑터 + POSIX/Windows breadcrumb
    workspaces.ts    홈/개발 위치의 제한적 워크스페이스 자동 검색
    resolve.ts       [복사] active-space/active-intent 커서 해석
    parser.ts        [복사] aidlc-state.md (+ Revision Count 추가)
    matrix.ts        [복사+개조] 3-state 유닛 매트릭스
    stage-catalog.ts harness 탐색(open-set) + stage-graph.json + kind별 기대 산출물
    audit.ts         shard 전량 병합 → 시간순 이벤트
    sensors.ts       감사 기록 상관 + 실패 본문
    questions.ts     미답변 질문 탐지
    memory-diary.ts  stage 일지 정규화 + 결정/후속 이슈 분류
    hooks-health.ts  heartbeat/drops/stop guard
    timing.ts        stage 구간 + IDLE/AGENT/WORK
  model/             scan/* → DashboardModel + 출처·신선도
  render/            HTML 문자열 (프레임워크 없음, <details> 접힘)
    picker.ts        직접 입력 + 자동 검색 + OS 중립 통합 탐색 선택 화면
fixtures/reference/  합성 최소 워크스페이스 (테스트용, 실런 데이터 아님)
```

`parser.ts` · `resolve.ts` · `matrix.ts` 는 `companion-extension/src/` 에서 **복사**했다
(vsix 2.0.4, `vscode` 의존 없음). 확장은 별개 릴리스 트랙이라 이 대시보드가 깨뜨릴 수 없게 트리를
독립시켰고, 대가는 drift 다 — 확장 쪽 파서가 바뀌면 diff 해서 맞춰야 한다.

### 갱신 — 자동 폴링 + 수동 새로고침

헤더의 **⟳ 새로고침**(단축키 `r`)이 즉시 다시 읽는다. 자동 폴링(기본 60초)이 있어도 수동 버튼이
필요한 이유는, 폴링이 **놓치는 게 아니라 늦기** 때문이다:

- 탭이 백그라운드면 폴링을 건너뛴다(`document.hidden` 가드). 그래서 탭으로 돌아오는
  순간에도 즉시 갱신하도록 `visibilitychange` 를 걸었지만, 화면을 보면서 파일을 고치는
  경우엔 설정한 폴링 주기만큼 기다려야 한다.
- `— SKIP` ↔ `— EXECUTE` 를 손으로 고치면 **완료율의 분모가 바뀐다**(SKIP 은 분자·분모
  양쪽에서 제외되므로). 이런 편집은 사용자가 방금 한 일이라 즉시 확인하고 싶다.

버튼·타이머·탭복귀가 **모두 같은 `refresh()` 를 호출**하므로 동작이 갈라지지 않는다.
갱신에 실패하면 시각 표시가 빨갛게 "갱신 실패 — 재시도 중"으로 바뀐다 — 낡은 화면이
최신인 척하지 않게 하려는 것이다.

### 왜 폴링인가

대상 트리는 보통 **동기화 사본**이고, 동기화 도구는 임시 파일에 쓰고 rename 하는 식으로 원자적
갱신을 하는데 이걸 kqueue/FSEvents 가 놓칠 수 있다. 폴링은 놓치지 않고, 한 번 읽는 비용이
~10ms(4,228 블록 파싱 7.5ms 포함)라 충분히 싸다. 감사 기록 증분 파싱(offset 추적)은 넣지 않았다 —
전량이 이미 빠르고, shard 가 통째로 교체되면 증분 가정 자체가 깨진다.

---

## 한계

- **실런 중 갱신 동작은 Kiro IDE 실런에서만 확인된다.** 정적 사본으로는 "동기화 후 값이 바뀐다"
  까지만 검증했다.
- 단일 워크스페이스 전용. 병렬 개발 4브랜치를 한 화면에 모으는 집계는 범위 밖이다.
- 진행 중 stage 의 유닛 셀은 잠정값이다(`~` 표시). 게이트가 열릴 때까지 계속 늘어난다.
- harness 중립은 **`.kiro`·`.claude`·`.aidlc` 3종을 같은 실런 트리로 실측**해 확인했다. 실제
  Claude Code 실런으로 만들어진 트리를 돌려본 것은 아니지만, `aidlc/` 문서 계약이 같으므로
  차이가 생길 지점은 stage 카탈로그뿐이고 그건 탐색으로 흡수한다.
- ⚠️**Windows 런처(`start.cmd`/`start.ps1`)는 Windows 에서 실행 검증하지 못했다**(개발 기계가
  macOS). 문법 균형·자동 변수 충돌·`errorlevel` 확장 시점은 문서 근거로 교정했으나, 실제 동작은
  Windows 에서 한 번 확인이 필요하다. macOS 런처는 bash 3.2(더블클릭 경로) 포함 실측 완료.
