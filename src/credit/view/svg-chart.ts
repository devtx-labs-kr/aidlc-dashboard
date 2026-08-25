/**
 * 무의존성 인라인 SVG 렌더러(BR2.1·BR3.1·BR3.3·NFR7). 순수 문자열 빌더 — DOM에 직접
 * 접근하지 않으므로 결정적이며 테스트 가능하다. 차트 라이브러리를 도입하지 않는다(무의존성).
 *
 * 기존 credit-dashboard `src/ui/svg-chart.ts`의 포팅. 색상 토큰을 host CSS 토큰으로 alias
 * 한다(BR2.4): `--color-accent`→`--accent`, `--color-track`→`--line`, `--color-muted`→
 * `--mute`, `--color-fg`→`--fg`. SVG 컨텍스트 이스케이프는 `escapeXml`을 유지한다(HTML
 * 컨텍스트의 host `esc()`와 구분, 신규 이스케이프 함수 발명 아님).
 */

import type { TrendSeries, TrendWindow } from "../trend/trend";

const WINDOW_LABEL: Record<TrendWindow, string> = {
  "7d": "최근 7일",
  "30d": "최근 30일",
  all: "전체 기간",
};

/** XML/SVG 텍스트 이스케이프(속성·본문 안전). SVG 컨텍스트 전용. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

export interface ChartOptions {
  width?: number;
  height?: number;
}

/** 추이 라인 차트를 SVG 문자열로 렌더한다. 결측(value=null)은 선을 끊는다. */
export function renderLineChart(series: TrendSeries, opts: ChartOptions = {}): string {
  const width = opts.width ?? 720;
  const height = opts.height ?? 260;
  const pad = { top: 16, right: 16, bottom: 28, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const windowLabel = WINDOW_LABEL[series.window];
  const valued = series.points.filter((p) => p.value !== null);

  const ariaLabel = buildAriaLabel(series, windowLabel);

  if (valued.length === 0) {
    // 값 있는 지점이 없으면 축만 그리고 안내.
    return wrapSvg(
      width,
      height,
      ariaLabel,
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--mute)" font-size="13">표시할 데이터가 없습니다</text>`,
    );
  }

  const times = valued.map((p) => Date.parse(p.ts)).filter((t) => !Number.isNaN(t));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const values = valued.map((p) => p.value as number);
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  if (vMin === vMax) {
    // 평평한 시계열: 위아래 여백을 준다.
    vMin -= 1;
    vMax += 1;
  }

  const xOf = (ts: string): number => {
    const t = Date.parse(ts);
    if (tMax === tMin) return pad.left + plotW / 2;
    return pad.left + ((t - tMin) / (tMax - tMin)) * plotW;
  };
  const yOf = (v: number): number => pad.top + plotH - ((v - vMin) / (vMax - vMin)) * plotH;

  // 결측에서 선을 끊어 연속 구간별 polyline을 만든다.
  const segments: string[] = [];
  let current: string[] = [];
  for (const p of series.points) {
    if (p.value === null) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${xOf(p.ts).toFixed(1)},${yOf(p.value).toFixed(1)}`);
  }
  if (current.length > 0) segments.push(current.join(" "));

  const polylines = segments
    .map(
      (pts) => `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts}" />`,
    )
    .join("");

  // 지점 마커(정상=채움).
  const markers = series.points
    .map((p) => {
      if (p.value === null) return "";
      return `<circle cx="${xOf(p.ts).toFixed(1)}" cy="${yOf(p.value).toFixed(1)}" r="2.5" fill="var(--accent)" />`;
    })
    .join("");

  // y축 최소/최대 눈금 라벨.
  const axis =
    `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="var(--line)" stroke-width="1" />` +
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="var(--line)" stroke-width="1" />` +
    `<text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end" fill="var(--mute)" font-size="11">${escapeXml(fmt(vMax))}</text>` +
    `<text x="${pad.left - 6}" y="${pad.top + plotH}" text-anchor="end" fill="var(--mute)" font-size="11">${escapeXml(fmt(vMin))}</text>`;

  return wrapSvg(width, height, ariaLabel, axis + polylines + markers);
}

/** 접근성 텍스트 요약(그래프 대체 텍스트). */
export function buildAriaLabel(series: TrendSeries, windowLabel: string): string {
  const { summary } = series;
  if (summary.count === 0) {
    return `${windowLabel} 누적 사용량 추이: 표시할 데이터 없음`;
  }
  return `${windowLabel} 누적 사용량 추이, 최소 ${fmt(summary.min)}, 최대 ${fmt(summary.max)}, 최신 ${fmt(summary.latest)}`;
}

function wrapSvg(width: number, height: number, ariaLabel: string, inner: string): string {
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
    `aria-label="${escapeXml(ariaLabel)}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`
  );
}

/** 사용률 원형(도넛) 게이지를 SVG 문자열로 렌더한다. 수치를 병기한다(색 비의존, BR2.1). */
export function renderGauge(ratio: number | null, size = 160): string {
  const stroke = 14;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  if (ratio === null) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="사용률 계산 불가"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}" /><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="var(--mute)" font-size="14">계산 불가</text></svg>`;
  }

  const clamped = Math.max(0, Math.min(1, ratio));
  const dash = circumference * clamped;
  const percentText = `${(clamped * 100).toFixed(1)}%`;

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="사용률 ${escapeXml(percentText)}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}" /><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})" /><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="var(--fg)" font-size="26" font-weight="700">${escapeXml(percentText)}</text></svg>`;
}
