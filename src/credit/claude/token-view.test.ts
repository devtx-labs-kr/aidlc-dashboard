/**
 * token-view 단위 테스트. 문자열 렌더러이므로 DOM 없이 출력 문자열만 검사한다.
 *
 * 이스케이프 검사가 핵심이다 — 모델명·경로·note 는 트랜스크립트에서 온 외부 텍스트이고,
 * 이 카드가 그것을 화면에 올리는 유일한 지점이다(Kiro 쪽 `warning.raw` 와 같은 위치).
 */

import { describe, expect, test } from "bun:test";
import type { TokenViewModel } from "./token-model";
import { renderTokens } from "./token-view";

function vm(over: Partial<TokenViewModel> = {}): TokenViewModel {
  return {
    status: "ok",
    totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
    grandTotal: 1160,
    byModel: [
      {
        model: "claude-opus-5",
        totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
        messages: 1,
      },
    ],
    messages: 1,
    sidechainMessages: 0,
    sessions: 1,
    trend: {
      window: "30d",
      points: [{ ts: "2026-08-25T00:00:00", value: 1160, ok: true }],
      summary: { latest: 1160, min: 1160, max: 1160, count: 1 },
    },
    lastActivityAt: "2026-08-25T10:00:00Z",
    firstActivityAt: "2026-08-25T09:00:00Z",
    dir: "/home/.claude/projects/-ws",
    triedPath: "/home/.claude/projects/-ws",
    notes: [],
    ...over,
  };
}

describe("renderTokens", () => {
  test("토큰 5종과 세션·메시지를 표로 렌더한다", () => {
    const html = renderTokens(vm(), "30d");
    expect(html).toContain("토큰 사용량");
    expect(html).toContain("총 토큰");
    expect(html).toContain("1,160");
    expect(html).toContain("캐시 읽기");
    // thinking 이 output 에 포함된 값이라는 사실을 라벨이 말해야 한다.
    expect(html).toContain("출력 내 포함");
  });

  test("모델별 분해 표와 비중을 렌더한다", () => {
    const html = renderTokens(vm(), "30d");
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("100.0%");
  });

  test("적대적 모델명을 이스케이프한다", () => {
    const html = renderTokens(
      vm({
        byModel: [
          {
            model: '<script>alert("x")</script>',
            totals: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, thinking: 0 },
            messages: 1,
          },
        ],
      }),
      "30d",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("적대적 note(경로) 도 이스케이프한다", () => {
    const html = renderTokens(vm({ notes: ['<img src=x onerror="alert(1)">'] }), "30d");
    expect(html).not.toContain("<img src=x");
  });

  test("데이터 없음 상태는 배지와 안내를 낸다 — 표는 그리지 않는다", () => {
    const html = renderTokens(
      vm({ status: "none", messages: 0, byModel: [], grandTotal: 0 }),
      "7d",
    );
    expect(html).toContain("데이터 없음");
    expect(html).not.toContain("총 토큰");
  });

  test("부분 집계는 배지로 드러난다", () => {
    expect(renderTokens(vm({ status: "partial" }), "30d")).toContain("부분 집계");
  });

  test("상한에 걸려 수치가 0 일 때 '사용량 없음' 안내를 띄우지 않는다", () => {
    // 이 안내는 "기간을 넓혀 보세요" 라고 조언하는데, 상한에 걸린 상태에서는 기간을 넓히면
    // 상황이 나빠진다. 그래서 partial 에는 나오면 안 된다.
    const html = renderTokens(
      vm({
        status: "partial",
        messages: 0,
        byModel: [],
        grandTotal: 0,
        notes: ["트랜스크립트가 커서 오래된 1개 파일을 읽지 않았습니다 — 과소 집계입니다."],
      }),
      "30d",
    );
    expect(html).not.toContain("기간을 넓혀 보세요");
    expect(html).toContain("과소 집계");
  });

  test("창 토글은 현재 창만 aria-checked 로 표시한다", () => {
    const html = renderTokens(vm(), "7d");
    expect(html).toContain('aria-checked="true" href="?cw=7d"');
    expect(html).toContain('aria-checked="false" href="?cw=30d"');
  });

  test("차트 접근성 라벨은 토큰 문구를 쓴다 (누적 사용량 문구 재사용 금지)", () => {
    const html = renderTokens(vm(), "30d");
    expect(html).toContain("일별 토큰 추이");
    expect(html).not.toContain("누적 사용량 추이");
  });

  test("서브에이전트 응답이 있으면 합계 포함 사실을 밝힌다", () => {
    expect(renderTokens(vm({ sidechainMessages: 4 }), "30d")).toContain("서브에이전트 응답 4");
  });
});
