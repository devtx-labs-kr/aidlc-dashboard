/**
 * CreditView — `CreditViewModel`을 host 룩앤필의 서버사이드 HTML 문자열로 렌더한다(BR2.x·
 * BR3.2·BR4.1·NFR1.1·NFR1.2·NFR7).
 *
 * 기존 credit-dashboard `src/ui/app.ts`의 클라이언트 fetch(`/api/current`·`/api/trend`) +
 * DOM 조작 렌더를 **서버사이드 문자열 렌더**로 전환한 것이다. 신규 JSON 엔드포인트를 두지
 * 않고, 추이 창 전환은 `?cw=7d|30d|all` 링크(radiogroup)로 서버 재렌더한다.
 *
 * 이스케이프 규율: HTML 컨텍스트 외부 텍스트는 host `esc()`(`../../render/common`), SVG
 * 컨텍스트는 `escapeXml`(svg-chart). 비계약 외부 텍스트(`planName`·`warning.raw`·`reason`)를
 * 반드시 이스케이프한다. 결측은 `"—"`로 치환해 `undefined`/`NaN`/`[object Object]` 누출을 막는다.
 * 읽기 전용: 저장·쓰기 부수효과 없음(NFR1.4).
 */

import { bar, esc, pill, section, shortTs } from "../../render/common";
import type { TrendWindow } from "../trend/trend";
import type { ParsedUsage } from "../types";
import type { CreditStatus, CreditViewModel } from "./credit-model";
import { buildAriaLabel, renderGauge, renderLineChart } from "./svg-chart";

const WINDOW_LABEL: Record<TrendWindow, string> = {
  "7d": "최근 7일",
  "30d": "최근 30일",
  all: "전체 기간",
};

/** 창 토글 라디오 정의(표시 순서). */
const WINDOWS: readonly { w: TrendWindow; label: string }[] = [
  { w: "7d", label: "7일" },
  { w: "30d", label: "30일" },
  { w: "all", label: "전체" },
];

/** 상태별 배지. host `pill()` 재사용. */
const STATUS_PILL: Record<CreditStatus, string> = {
  loading: pill("수집 중", "mute"),
  ok: pill("정상", "ok"),
  partial: pill("부분 데이터", "warn"),
  failure: pill("수집 실패", "bad"),
  none: pill("데이터 없음", "mute"),
};

/** 숫자 포맷(결측·NaN 은 em dash). */
function fmtNumber(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

/** 사용률 포맷(0~1 비율 → %). 결측·NaN 은 em dash. */
function fmtRatio(r: number | null): string {
  if (r === null || Number.isNaN(r)) return "—";
  return `${(r * 100).toFixed(1)}%`;
}

/**
 * `?cw` 쿼리값을 허용 창으로 무해화한다(NFR1.3). `7d`/`30d`/`all` 만 수용하고 무효·주입·
 * 부재는 `30d` 로 폴백한다.
 */
export function resolveWindow(cw: string | null | undefined): TrendWindow {
  if (cw === "7d" || cw === "30d" || cw === "all") return cw;
  return "30d";
}

/**
 * 현재 지표 5종을 표로 렌더한다. 결측은 "—". 외부 텍스트(planName)는 esc.
 *
 * `resetDate`는 파싱은 하되 표에 싣지 않는다 — 화면에서 뺀 필드이므로 `ParsedUsage`·저장·추이
 * 에는 그대로 남아 있다.
 */
function metricsTable(current: ParsedUsage): string {
  const rows: [string, string][] = [
    ["플랜", esc(current.planName ?? "—")],
    ["누적 사용량", fmtNumber(current.usedAmount)],
    ["잔량", fmtNumber(current.remainingAmount)],
    ["플랜 한도", fmtNumber(current.planLimit)],
    ["사용률", fmtRatio(current.usageRatio)],
  ];
  const body = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="g-n">${v}</td></tr>`)
    .join("");
  return `<table class="tbl"><tbody>${body}</tbody></table>`;
}

/** 사용률 진행 막대 + 접근성 progressbar. 계산 불가(null)는 빈 트랙 + 안내. */
function progressBlock(ratio: number | null): string {
  const pct = ratio === null ? null : Math.max(0, Math.min(100, ratio * 100));
  const label = ratio === null ? "사용률 계산 불가" : `사용률 ${fmtRatio(ratio)}`;
  const valueNow = pct === null ? "" : ` aria-valuenow="${pct.toFixed(1)}"`;
  return `<div class="credit-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"${valueNow} aria-label="${esc(label)}">
  ${bar(pct)}
  <p class="note">${esc(label)}</p>
</div>`;
}

/** 실패 경고 배너(role=alert). 사유·원문 모두 esc. */
function warningBanner(warning: { raw: string; reason: string }): string {
  return `<div class="warnbox" role="alert">
  최신 데이터를 가져오지 못했습니다 (${esc(warning.reason)}). 아래는 마지막 성공값입니다.
  <details><summary>실패 원문 보기</summary><pre>${esc(warning.raw || "(원문 없음)")}</pre></details>
</div>`;
}

/**
 * 추이 창 토글(radiogroup). 현재 창만 aria-checked="true". `?cw=` 링크로 서버 재렌더.
 *
 * 칩 모양은 `.window-toggle a` CSS가 전담한다 — 예전에 붙어 있던 `pickbtn` 클래스는
 * `header.top nav` 스코프라 이 자리에서는 아무 스타일도 주지 않았고, 그래서 세 창이
 * 맨 링크 세 개로 붙어 "7월 30일"처럼 읽혔다.
 */
function windowToggle(current: TrendWindow): string {
  const radios = WINDOWS.map(
    ({ w, label }) =>
      `<a role="radio" aria-checked="${w === current ? "true" : "false"}" href="?cw=${w}">${esc(label)}</a>`,
  ).join("");
  return `<div class="window-toggle" role="radiogroup" aria-label="추이 기간 선택">${radios}</div>`;
}

/** 추이 패널: 창 토글 + 라인차트(SVG) + 텍스트 요약(접근성 병기). */
function trendPanel(model: CreditViewModel, window: TrendWindow): string {
  const chart = renderLineChart(model.trend);
  const summaryText = buildAriaLabel(model.trend, WINDOW_LABEL[model.trend.window]);
  return `<div class="credit-trend">
  ${windowToggle(window)}
  <div class="credit-chart">${chart}</div>
  <p class="note">${esc(summaryText)}</p>
</div>`;
}

/**
 * 크레딧 뷰를 host 룩앤필 HTML 문자열로 렌더한다. host `section()` 카드로 감싼다.
 * 최상단 배치(병목 패널 치환)는 u4가 host 페이지에 배선한다.
 *
 * @param model  u3 소유 뷰모델(assembleCredit 산출).
 * @param window 현재 추이 창(창 토글 aria-checked 표시용).
 */
export function renderCredit(model: CreditViewModel, window: TrendWindow): string {
  const parts: string[] = [];

  const stalePill = model.freshness.stale ? ` ${pill("오래된 데이터", "warn")}` : "";
  parts.push(`<div class="credit-head">${STATUS_PILL[model.status]}${stalePill}</div>`);

  if (model.status === "loading") {
    parts.push(`<p class="note" role="status">크레딧 사용량을 처음 수집하고 있습니다.</p>`);
  }

  if (model.status === "none") {
    parts.push(
      `<p class="note">아직 수집된 크레딧 데이터가 없습니다. 수집이 진행되면 이 자리에 표시됩니다.</p>`,
    );
  }

  if (model.status === "failure" && model.warning !== null) {
    parts.push(warningBanner(model.warning));
  }

  if (model.freshness.stale) {
    parts.push(
      `<p class="note warn">마지막 성공 이후 10분 이상 경과 — 표시값이 최신이 아닐 수 있습니다.</p>`,
    );
  }

  if (model.current !== null) {
    parts.push(`<div class="credit-current">
  <div class="credit-gauge">${renderGauge(model.current.usageRatio)}</div>
  ${metricsTable(model.current)}
</div>`);
    parts.push(progressBlock(model.current.usageRatio));
    parts.push(
      `<p class="note">마지막 성공: ${esc(shortTs(model.lastSuccessAt ?? undefined))}</p>`,
    );
  }

  parts.push(trendPanel(model, window));

  return section("크레딧", parts.join("\n"), "credit");
}
