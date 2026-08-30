/**
 * ClaudeTokenView — `TokenViewModel`을 host 룩앤필 HTML 문자열로 렌더한다.
 *
 * Kiro의 `renderCredit`과 같은 카드 자리를 차지하고 같은 host 프리미티브(`section`·`pill`·
 * `esc`·`bar`)와 같은 차트(`renderLineChart`)를 쓴다 — 두 패널이 시각적으로 형제로 보여야
 * 하기 때문이다. 다른 점은 표의 내용뿐이다: 할당량(플랜·한도·잔량·사용률)이 아니라 실사용
 * 토큰이다.
 *
 * 게이지(`renderGauge`)는 쓰지 않는다. 게이지는 0~1 사용률을 전제하는데 Claude Code 로컬
 * 데이터에는 한도가 없어 분모가 존재하지 않는다. 한도를 설정값으로 받아 %를 만들 수도
 * 있지만 그러면 실측이 아닌 값이 실측 자리에 앉는다(host의 "라벨 없는 숫자 금지" 규율).
 *
 * 이스케이프 규율: 외부 텍스트(모델명·경로·집계 note)는 반드시 `esc()`. 결측은 `"—"`.
 * 읽기 전용 — 부수효과 없음.
 */

import { bar, esc, pill, section, shortTs } from "../../render/common";
import type { TrendWindow } from "../trend/trend";
import { renderLineChart } from "../view/svg-chart";
import type { TokenStatus, TokenViewModel } from "./token-model";
import { totalOf } from "./transcript-reader";

const WINDOW_LABEL: Record<TrendWindow, string> = {
  "7d": "최근 7일",
  "30d": "최근 30일",
  all: "전체 기간",
};

/** 창 토글 라디오 정의(표시 순서). Kiro 패널과 동일한 `?cw=` 계약을 공유한다. */
const WINDOWS: readonly { w: TrendWindow; label: string }[] = [
  { w: "7d", label: "7일" },
  { w: "30d", label: "30일" },
  { w: "all", label: "전체" },
];

const STATUS_PILL: Record<TokenStatus, string> = {
  ok: pill("정상", "ok"),
  partial: pill("부분 집계", "warn"),
  none: pill("데이터 없음", "mute"),
};

function fmtNumber(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR");
}

/** 토큰 5종 + 세션·메시지 표. thinking이 output의 부분집합임을 라벨에 명시한다. */
function totalsTable(m: TokenViewModel): string {
  const rows: [string, string][] = [
    ["총 토큰", fmtNumber(m.grandTotal)],
    ["입력", fmtNumber(m.totals.input)],
    ["출력", fmtNumber(m.totals.output)],
    ["사고 토큰 (출력 내 포함)", fmtNumber(m.totals.thinking)],
    ["캐시 읽기", fmtNumber(m.totals.cacheRead)],
    ["캐시 생성", fmtNumber(m.totals.cacheCreate)],
    ["세션", fmtNumber(m.sessions)],
    ["응답 메시지", fmtNumber(m.messages)],
  ];
  const body = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="g-n">${v}</td></tr>`)
    .join("");
  return `<table class="tbl"><tbody>${body}</tbody></table>`;
}

/** 모델별 분해 표. 비중은 총 토큰 대비 막대로 병기한다(색 비의존 — 수치도 함께). */
function modelTable(m: TokenViewModel): string {
  if (m.byModel.length === 0) return "";
  const rows = m.byModel
    .map((row) => {
      const total = totalOf(row.totals);
      const share = m.grandTotal > 0 ? (total / m.grandTotal) * 100 : null;
      return `<tr>
  <td>${esc(row.model)}</td>
  <td class="g-n">${fmtNumber(total)}</td>
  <td class="g-n">${fmtNumber(row.totals.output)}</td>
  <td class="g-n">${fmtNumber(row.messages)}</td>
  <td class="token-share">${bar(share)}<span class="note">${share === null ? "—" : `${share.toFixed(1)}%`}</span></td>
</tr>`;
    })
    .join("");
  return `<table class="tbl token-models">
  <thead><tr><th>모델</th><th>총 토큰</th><th>출력</th><th>메시지</th><th>비중</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/** 창 토글(radiogroup). Kiro 패널과 같은 `?cw=` 링크로 서버 재렌더한다. */
function windowToggle(current: TrendWindow): string {
  const radios = WINDOWS.map(
    ({ w, label }) =>
      `<a role="radio" aria-checked="${w === current ? "true" : "false"}" href="?cw=${w}" class="pickbtn">${esc(label)}</a>`,
  ).join("");
  return `<div class="window-toggle" role="radiogroup" aria-label="집계 기간 선택">${radios}</div>`;
}

/** 일별 토큰 추이 + 접근성 텍스트 요약. */
function trendPanel(m: TokenViewModel, window: TrendWindow): string {
  const label = WINDOW_LABEL[m.trend.window];
  const { summary } = m.trend;
  const summaryText =
    summary.count === 0
      ? `${label} 일별 토큰 추이: 표시할 데이터 없음`
      : `${label} 일별 토큰 추이, ${summary.count}일, 최소 ${fmtNumber(summary.min)}, 최대 ${fmtNumber(summary.max)}, 최근 ${fmtNumber(summary.latest)}`;
  const chart = renderLineChart(m.trend, { ariaLabel: summaryText });
  return `<div class="credit-trend">
  ${windowToggle(window)}
  <div class="credit-chart">${chart}</div>
  <p class="note">${esc(summaryText)}</p>
</div>`;
}

/**
 * 토큰 사용량 카드를 렌더한다. host `section()`으로 감싸 Kiro 패널과 같은 자리에 놓인다.
 *
 * @param m      뷰모델(assembleTokens 산출).
 * @param window 현재 창(창 토글 aria-checked 표시용).
 */
export function renderTokens(m: TokenViewModel, window: TrendWindow): string {
  const parts: string[] = [];

  parts.push(
    `<div class="credit-head">${STATUS_PILL[m.status]}${pill("Claude Code", "mute")}</div>`,
  );

  for (const note of m.notes) {
    parts.push(`<p class="note warn">${esc(note)}</p>`);
  }

  if (m.status === "none" && m.dir !== null) {
    parts.push(
      `<p class="note">이 기간에 기록된 Claude Code 토큰 사용량이 없습니다. 기간을 넓혀 보세요.</p>`,
    );
  }

  if (m.messages > 0) {
    parts.push(`<div class="credit-current">${totalsTable(m)}</div>`);
    parts.push(modelTable(m));

    const span =
      m.firstActivityAt !== null && m.lastActivityAt !== null
        ? `${esc(shortTs(m.firstActivityAt))} — ${esc(shortTs(m.lastActivityAt))}`
        : "—";
    parts.push(`<p class="note">집계 구간: ${span}</p>`);

    if (m.sidechainMessages > 0) {
      parts.push(
        `<p class="note">서브에이전트 응답 ${fmtNumber(m.sidechainMessages)}건이 위 합계에 포함되어 있습니다.</p>`,
      );
    }
  }

  parts.push(trendPanel(m, window));

  return section("토큰 사용량", parts.join("\n"), "credit");
}
