# aidlc-dashboard

AI-DLC v2 실런의 **현황·진행·사용량을 한 화면에서 보는 웹 대시보드.** 워크스페이스의
`aidlc/` 문서 트리를 파싱해서 서버가 HTML 을 만들어 준다. bun 만 있으면 돈다. 추가 런타임이나
빌드 단계는 없다.

**워크스페이스에는 쓰지 않는다.** 게이트 승인·stage 전이는 실행 도구의 몫이고 이 대시보드는
관측만 한다. 서버는 `localhost` 에만 바인딩된다. 유일하게 쓰는 파일은 크레딧 이력을 담는
`data/usage.db` 이며 워크스페이스 밖에 있다.

## 실행

### 실행 스크립트 (가장 쉬운 방법)

터미널에서 실행한다.

| OS | 실행 |
|---|---|
| macOS / Linux | `./start.sh` |
| Windows | `.\start.cmd` (또는 `.\start.ps1`) |

스크립트가 bun 을 찾고 최초 1회 의존성을 설치하고 서버를 띄운 뒤 **브라우저를 자동으로 연다.**
경로를 주면 그 워크스페이스로 바로 열리고 안 주면 폴더 선택 화면이 뜬다. 서버 플래그도 그대로
전달된다.

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

⚠️Windows 에서 `.\start.ps1` 이 "running scripts is disabled on this system" 으로 막히면
`.\start.cmd` 를 쓴다 — 그 호출에만 실행 정책을 우회하고 시스템 설정은 바꾸지 않는다.

### 직접 실행

```bash
bun install
bun run src/server.ts                        # 폴더 선택 화면으로 시작
bun run src/server.ts --root ~/path/to/ws    # 바로 그 워크스페이스로 시작
# → http://localhost:4321
```

## 플래그

| 플래그 | 뜻 | 기본값 |
|---|---|---|
| `--root <path>` | `aidlc/` 를 품은 워크스페이스 루트. **생략 가능**(생략 시 폴더 선택 화면) | — |
| `--port <n>` | HTTP 포트. `AIDLC_DASHBOARD_PORT`로도 설정 가능 | `4321` |
| `--poll <ms>` | 브라우저 자동 갱신 주기, `0` 이면 끔(수동 새로고침은 계속 동작) | `60000` |
| `--interval <ms>` | 크레딧 자동 수집 주기. `AIDLC_DASHBOARD_INTERVAL_MS`로도 설정 가능 | `300000` |
| `--harness <dir>` | stage 카탈로그를 읽을 harness 디렉터리. **보통 불필요**(자동 탐색) | 자동 |
| `--usage <mode>` | 사용량 패널: `auto`·`kiro`·`claude`. `auto` 는 harness 디렉터리를 따른다 | `auto` |

`--root` 는 `aidlc/` 만 있으면 통과한다. harness 디렉터리(`.claude`·`.kiro` 등)는 필수가 아니지만
없으면 유닛 매트릭스 판정이 근사값으로 떨어지며, 그때는 화면에 경고가 뜨고 `--harness` 로 지정하라고
안내한다.

## 워크스페이스 선택

`--root` 를 빼면 **브라우저에서 폴더를 골라** 시작한다. 헤더의 **📁 폴더 변경** 으로 실행 중에도
다른 워크스페이스로 갈아탈 수 있다(재시작 불필요).

선택 화면을 열면 사용자 홈과 `Development`·`Developer`·`Projects`·`Code` 같은 개발 위치에서
`aidlc/` 를 품은 워크스페이스를 자동으로 찾는다. Windows 에서는 `USERPROFILE`과
`OneDrive`·`OneDriveConsumer`·`OneDriveCommercial` 위치도 함께 찾는다.

첫 작업 영역인 **폴더 탐색**은 사용자 홈에서 시작한다. 폴더 이름을 눌러 이동하고 `aidlc/`를 품은
폴더에는 **열기** 동작이 표시된다. 모든 OS가 동일한 루트 탭, 클릭 가능한 breadcrumb, 현재 폴더의
디렉터리 목록, 이름 필터를 사용한다. macOS는 홈·파일시스템·`/Volumes` 볼륨, Linux는
홈·파일시스템·`/mnt`·`/media` 마운트, Windows는 홈·사용 가능한 드라이브·OneDrive를 루트로
제공한다.

탐색기 아래에는 경로 직접 입력과 자동 검색 결과가 보조 선택 수단으로 유지된다. 직접 경로는 `~`로
시작해도 되며 워크스페이스가 아닌 경로는 사유와 함께 거부한다. `aidlc` 폴더 자체를 골라도 부모를
워크스페이스로 잡는다.

## 무엇을 보여주나

- **사용량** — harness 에 따라 둘 중 하나. 7일/30일/전체 창 토글은 양쪽 공통이다.
  - Kiro → **크레딧**: 현재 사용량·잔량·한도·리셋일, 누적 사용량 추이, 수집 실패와 신선도.
  - Claude Code → **토큰**: 총 토큰과 input·output·cache read/create·thinking 내역, 세션·응답
    메시지 수, 모델별 분해(총 토큰·출력·메시지·비중), 일별 토큰 추이, 집계 구간.
- **진행** — 전체 % · phase 5개 · stage 체크박스 · **Construction 유닛 매트릭스**(3-state) ·
  bolt DAG 배치.
- **시간** — stage 별 gantt + **IDLE/AGENT/WORK 3분해**.
- **결정과 이슈** — 후속 확인 후보 · 최근 결정 · 계획 변경 · 해결 기록.

패널마다 **어느 파일에서 온 값인지와 얼마나 낡았는지**가 함께 표시된다. 읽는 소스들의 신선도가
실제로 다르기 때문이고, 낡은 값은 낡았다고 화면에 적힌다.

## 갱신

헤더의 **⟳ 새로고침**(단축키 `r`)이 즉시 다시 읽는다. 자동 폴링은 기본 60초이며 `--poll 0` 으로
끌 수 있다(끄더라도 수동 버튼은 동작한다). 탭이 백그라운드면 폴링을 건너뛰고, 탭으로 돌아오는
순간 갱신한다.

갱신에 실패하면 시각 표시가 빨갛게 "갱신 실패 — 재시도 중"으로 바뀐다. 낡은 화면이 최신인 척하지
않게 하려는 것이다.

## 라우트

`/` (대시보드 · 미선택 시 폴더 선택) · `/pick`·`/browse` (폴더 선택) · `/select` (선택 확정)
· `/api/body` (갱신용 본문) · `/api/model` (조립된 JSON) · `/api/current` (현재 크레딧)
· `/api/trend?window=7d|30d|all` (크레딧 추이) · `POST /api/refresh` (즉시 수집) · `/healthz`.

`/api/current`·`/api/trend`·`POST /api/refresh` 는 **Kiro 크레딧 전용**이다. 화면이 토큰 패널일
때도 그대로 동작하지만 응답은 크레딧 데이터이며 수집기가 뜨지 않았으면 `503` 이다. 토큰 수치는
별도 엔드포인트 없이 `/api/model` 의 `usage` 슬롯에 들어 있다 — `usage.kind` 가 `"kiro"` 면
`usage.credit`, `"claude"` 면 `usage.tokens` 다.

## 알아둘 제약

- **단일 워크스페이스 전용.** 병렬 개발 여러 브랜치를 한 화면에 모으는 집계는 범위 밖이다.
- **진행 중 stage 의 유닛 셀은 잠정값이다**(`~` 표시). 게이트가 열릴 때까지 계속 늘어난다.
- **Claude 토큰 패널은 워크스페이스 경로로 트랜스크립트를 찾는다.** 즉 Claude Code 를 그
  워크스페이스를 cwd 로 두고 실행했을 때만 잡힌다. 다른 디렉터리에서 실행했거나 워크스페이스를
  옮긴 뒤면 `데이터 없음` 이 되며, 이때는 찾으려던 경로를 화면에 밝힌다.
- ⚠️**Windows 런처(`start.cmd`/`start.ps1`)는 Windows 에서 실행 검증하지 못했다**(개발 기계가
  macOS). macOS 런처는 bash 3.2 더블클릭 경로까지 확인했다.

---

개발·설계 문서는 [`CLAUDE.md`](CLAUDE.md) 에 있다 — 아키텍처와 불변식, 이 코드가 우회하려고
존재하는 **AI-DLC 트리의 실측 데이터 계약과 함정**, 개발 명령, 스타일·테스트 규약.
