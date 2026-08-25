// CreditView 유닛 테스트 — u3-credit-view (Step 7).
//
// 러너: bun:test. 서버사이드 문자열 렌더이므로 DOM 없이 문자열 단언으로 검증한다.
// 팀 규범(team.md ## Testing Posture)에 따라 상태별 렌더 + 적대적 입력 이스케이프 +
// placeholder 누출 금지를 필수로 포함한다. 창 토글 radiogroup·resolveWindow 폴백·무JS 컨트롤도 커버.

import { describe, expect, test } from "bun:test";
import type { TrendSeries } from "../trend/trend";
import type { ParsedUsage } from "../types";
import type { CreditStatus, CreditViewModel } from "./credit-model";
import { renderCredit, resolveWindow } from "./credit-view";

function usage(overrides: Partial<ParsedUsage> = {}): ParsedUsage {
  return {
    planName: "Pro",
    usedAmount: 120,
    remainingAmount: 380,
    planLimit: 500,
    usageRatio: 0.24,
    resetDate: "2026-09-01",
    partial: false,
    ...overrides,
  };
}

function emptyTrend(): TrendSeries {
  return { window: "30d", points: [], summary: { latest: null, min: null, max: null, count: 0 } };
}

function filledTrend(): TrendSeries {
  return {
    window: "30d",
    points: [
      { ts: "2026-08-15T00:00:00.000Z", value: 100, ok: true },
      { ts: "2026-08-16T00:00:00.000Z", value: 200, ok: true },
    ],
    summary: { latest: 200, min: 100, max: 200, count: 2 },
  };
}

function model(status: CreditStatus, overrides: Partial<CreditViewModel> = {}): CreditViewModel {
  const base: CreditViewModel = {
    status,
    current: status === "none" || status === "loading" ? null : usage(),
    lastSuccessAt: status === "none" || status === "loading" ? null : "2026-08-16T11:57:00.000Z",
    freshness: {
      stale: false,
      lastSuccessAt: status === "none" || status === "loading" ? null : "2026-08-16T11:57:00.000Z",
    },
    trend: status === "none" || status === "loading" ? emptyTrend() : filledTrend(),
    warning: null,
  };
  return { ...base, ...overrides };
}

describe("renderCredit 상태별 렌더", () => {
  test("loading: 첫 수집 진행 상태를 알린다", () => {
    const html = renderCredit(model("loading"), "30d");
    expect(html).toContain("수집 중");
    expect(html).toContain('role="status"');
  });

  test("none: '데이터 없음' 자리표시, 게이지·경고 배너 없음", () => {
    const html = renderCredit(model("none"), "30d");
    expect(html).toContain("아직 수집된 크레딧 데이터가 없습니다");
    expect(html).not.toContain("최신 데이터를 가져오지 못했습니다");
  });

  test("ok: 게이지(role=img)·플랜명·사용률 렌더, 경고 배너 없음", () => {
    const html = renderCredit(model("ok"), "30d");
    expect(html).toContain('role="img"');
    expect(html).toContain("Pro");
    expect(html).toContain("24.0%");
    expect(html).not.toContain("최신 데이터를 가져오지 못했습니다");
  });

  test("partial: 부분 데이터 배지 + 결측 '—'", () => {
    const partial = model("partial", {
      current: usage({ remainingAmount: null, usageRatio: null, partial: true }),
    });
    const html = renderCredit(partial, "30d");
    expect(html).toContain("부분 데이터");
    expect(html).toContain("—");
  });

  test("stale: 상태와 독립된 배지 + 마지막 성공값 유지", () => {
    const html = renderCredit(
      model("ok", {
        freshness: {
          stale: true,
          lastSuccessAt: "2026-08-16T11:30:00.000Z",
        },
      }),
      "30d",
    );
    expect(html).toContain("오래된 데이터");
    expect(html).toContain("Pro");
  });

  test("failure: 경고 배너 + reason 표시 + 마지막 성공값 유지", () => {
    const failure = model("failure", {
      warning: { raw: "raw usage dump", reason: "timeout" },
    });
    const html = renderCredit(failure, "30d");
    expect(html).toContain("최신 데이터를 가져오지 못했습니다");
    expect(html).toContain("timeout");
    expect(html).toContain("Pro");
  });

  test("failure + stale: 실패 배너와 오래된 값 경고를 함께 표시", () => {
    const html = renderCredit(
      model("failure", {
        warning: { raw: "raw usage dump", reason: "timeout" },
        freshness: {
          stale: true,
          lastSuccessAt: "2026-08-16T11:30:00.000Z",
        },
      }),
      "30d",
    );
    expect(html).toContain("최신 데이터를 가져오지 못했습니다");
    expect(html).toContain("10분 이상 경과");
  });
});

describe("renderCredit 적대적 입력 이스케이프(NFR1.1)", () => {
  test("planName 의 <script>·따옴표·꺾쇠 이스케이프(원시 마크업 미주입)", () => {
    const evil = '<script>alert("x")</script>';
    const html = renderCredit(model("ok", { current: usage({ planName: evil }) }), "30d");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("warning.raw/warning.reason 의 마크업 이스케이프", () => {
    const html = renderCredit(
      model("failure", {
        warning: { raw: '<img src=x onerror="alert(1)">', reason: "<b>파싱실패</b>" },
      }),
      "30d",
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>파싱실패</b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("renderCredit placeholder 누출 금지(NFR1.2)", () => {
  test("none 렌더에 undefined/NaN/[object Object] 부재", () => {
    const html = renderCredit(model("none"), "30d");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("[object Object]");
  });

  test("partial(결측 다수) 렌더에 undefined/NaN/[object Object] 부재", () => {
    const partial = model("partial", {
      current: usage({
        planName: null,
        usedAmount: null,
        remainingAmount: null,
        planLimit: null,
        usageRatio: null,
        resetDate: null,
        partial: true,
      }),
    });
    const html = renderCredit(partial, "30d");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("[object Object]");
  });
});

describe("renderCredit 창 토글·컨트롤·접근성", () => {
  test("창 토글: ?cw=7d|30d|all 링크 + 현재 창 aria-checked='true'", () => {
    const html = renderCredit(model("ok"), "7d");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("?cw=7d");
    expect(html).toContain("?cw=30d");
    expect(html).toContain("?cw=all");
    // 현재 창(7d)이 aria-checked=true, 나머지는 false.
    expect(html).toMatch(/aria-checked="true" href="\?cw=7d"/);
    expect(html).toMatch(/aria-checked="false" href="\?cw=30d"/);
  });

  test("크레딧 카드에는 중복 새로고침 컨트롤을 렌더하지 않는다", () => {
    const html = renderCredit(model("ok"), "30d");
    expect(html).not.toContain("새로고침");
    expect(html).not.toContain("/api/credit/refresh");
  });

  test("host 룩앤필: section(.card) 래퍼·host 토큰 사용", () => {
    const html = renderCredit(model("ok"), "30d");
    expect(html).toContain('class="card"');
    expect(html).toContain("var(--accent)");
  });
});

describe("resolveWindow 화이트리스트(NFR1.3)", () => {
  test("유효값은 그대로 수용", () => {
    expect(resolveWindow("7d")).toBe("7d");
    expect(resolveWindow("30d")).toBe("30d");
    expect(resolveWindow("all")).toBe("all");
  });

  test("무효/주입/부재 → 30d 폴백", () => {
    expect(resolveWindow(undefined)).toBe("30d");
    expect(resolveWindow(null)).toBe("30d");
    expect(resolveWindow("")).toBe("30d");
    expect(resolveWindow("90d")).toBe("30d");
    expect(resolveWindow("7d'; DROP TABLE--")).toBe("30d");
    expect(resolveWindow("<script>")).toBe("30d");
  });
});
