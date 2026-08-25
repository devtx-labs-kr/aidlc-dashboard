// svg-chart 유닛 테스트 — u3-credit-view (Step 3).
//
// 러너: bun:test. 순수 문자열 빌더이므로 DOM 없이 문자열 단언으로 검증한다. 게이지(비율·
// null)·라인차트(결측 선끊김·빈 상태)·host 토큰 사용·escapeXml 을 커버한다.

import { describe, expect, test } from "bun:test";
import type { TrendSeries } from "../trend/trend";
import { escapeXml, renderGauge, renderLineChart } from "./svg-chart";

function series(points: TrendSeries["points"]): TrendSeries {
  const values = points.filter((p) => p.value !== null).map((p) => p.value as number);
  return {
    window: "30d",
    points,
    summary: {
      latest: values.length > 0 ? (values[values.length - 1] ?? null) : null,
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
      count: values.length,
    },
  };
}

describe("renderGauge", () => {
  test("ratio → % 텍스트 병기, role/aria-label 포함", () => {
    const svg = renderGauge(0.25);
    expect(svg).toContain('role="img"');
    expect(svg).toContain("25.0%");
    expect(svg).toContain("aria-label=");
  });

  test("ratio=null → '계산 불가'", () => {
    const svg = renderGauge(null);
    expect(svg).toContain("계산 불가");
    expect(svg).toContain('aria-label="사용률 계산 불가"');
  });

  test("host 토큰 사용(--accent/--line/--fg), 하드코딩 --color-* 부재", () => {
    const svg = renderGauge(0.5);
    expect(svg).toContain("var(--accent)");
    expect(svg).toContain("var(--line)");
    expect(svg).not.toContain("--color-");
  });

  test("ratio 범위를 0~1 로 clamp", () => {
    expect(renderGauge(1.5)).toContain("100.0%");
    expect(renderGauge(-0.3)).toContain("0.0%");
  });
});

describe("renderLineChart", () => {
  test("결측 지점에서 선 끊김(polyline 분할)", () => {
    const s = series([
      { ts: "2026-08-14T00:00:00.000Z", value: 100, ok: true },
      { ts: "2026-08-15T00:00:00.000Z", value: null, ok: false },
      { ts: "2026-08-16T00:00:00.000Z", value: 300, ok: true },
    ]);
    const svg = renderLineChart(s);
    // 값 지점이 2개지만 결측으로 끊겨 polyline 이 2개(각 1점)로 분할된다.
    const polylines = svg.match(/<polyline/g) ?? [];
    expect(polylines.length).toBe(2);
  });

  test("값 없음 → '표시할 데이터가 없습니다' + role/aria", () => {
    const s = series([{ ts: "2026-08-16T00:00:00.000Z", value: null, ok: false }]);
    const svg = renderLineChart(s);
    expect(svg).toContain("표시할 데이터가 없습니다");
    expect(svg).toContain('role="img"');
    expect(svg).toContain("aria-label=");
  });

  test("host 토큰 사용(--accent/--line/--mute), 하드코딩 --color-* 부재", () => {
    const s = series([
      { ts: "2026-08-15T00:00:00.000Z", value: 100, ok: true },
      { ts: "2026-08-16T00:00:00.000Z", value: 200, ok: true },
    ]);
    const svg = renderLineChart(s);
    expect(svg).toContain("var(--accent)");
    expect(svg).toContain("var(--line)");
    expect(svg).not.toContain("--color-");
  });
});

describe("escapeXml", () => {
  test("위험 문자 이스케이프", () => {
    expect(escapeXml("<script>\"&'")).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });

  test("빈 상태 라벨은 mute 토큰 사용", () => {
    const s = series([]);
    const svg = renderLineChart(s);
    expect(svg).toContain("var(--mute)");
  });
});
