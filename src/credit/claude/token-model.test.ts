/**
 * token-model 단위 테스트. 순수 함수이므로 파일 I/O 없이 집계 리터럴만 넣는다.
 */

import { describe, expect, test } from "bun:test";
import { assembleTokens } from "./token-model";
import type { TranscriptAggregate } from "./transcript-reader";

function agg(over: Partial<TranscriptAggregate> = {}): TranscriptAggregate {
  return {
    dir: "/home/.claude/projects/-ws",
    triedPath: "/home/.claude/projects/-ws",
    totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
    byModel: [
      {
        model: "claude-opus-5",
        totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
        messages: 1,
      },
    ],
    daily: [
      { date: "2026-08-24", total: 500 },
      { date: "2026-08-25", total: 660 },
    ],
    messages: 1,
    sidechainMessages: 0,
    sessions: 1,
    firstAt: "2026-08-24T10:00:00Z",
    lastAt: "2026-08-25T10:00:00Z",
    filesRead: 1,
    filesSkipped: 0,
    filesCapped: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    ...over,
  };
}

describe("assembleTokens", () => {
  test("정상 집계 → ok, 총량은 thinking 을 제외한 4종 합", () => {
    const m = assembleTokens(agg(), "30d");
    expect(m.status).toBe("ok");
    expect(m.grandTotal).toBe(1160);
    expect(m.notes).toEqual([]);
    expect(m.lastActivityAt).toBe("2026-08-25T10:00:00Z");
  });

  test("메시지가 없으면 none", () => {
    const m = assembleTokens(agg({ messages: 0, daily: [], byModel: [] }), "7d");
    expect(m.status).toBe("none");
    expect(m.trend.summary.count).toBe(0);
  });

  test("디렉터리 미발견 → 시도한 경로를 note 로 밝힌다", () => {
    const m = assembleTokens(agg({ dir: null, messages: 0, triedPath: "/home/x/-ws" }), "30d");
    expect(m.status).toBe("none");
    expect(m.notes.join(" ")).toContain("/home/x/-ws");
  });

  test("바이트 상한에 걸리면 partial + 과소 집계임을 밝힌다", () => {
    const m = assembleTokens(agg({ filesCapped: 3 }), "all");
    expect(m.status).toBe("partial");
    expect(m.notes.join(" ")).toContain("과소 집계");
  });

  test("전량 상한에 걸려 메시지가 0 이어도 none 이 아니라 partial 이다", () => {
    // 단일 파일이 128MB 를 넘으면 filesRead 0·messages 0 이 된다. 여기서 none 을 내면 화면이
    // "사용량이 없습니다. 기간을 넓혀 보세요" 를 띄우는데, 사용량은 있고 기간을 넓히면 상한에
    // 더 걸린다 — 조용한 절단 금지 규율이 깨지는 자리다.
    const m = assembleTokens(
      agg({ messages: 0, filesRead: 0, filesCapped: 1, daily: [], byModel: [] }),
      "30d",
    );
    expect(m.status).toBe("partial");
    expect(m.notes.join(" ")).toContain("과소 집계");
  });

  test("깨진 줄만 있고 메시지가 0 이어도 partial 이다", () => {
    const m = assembleTokens(
      agg({ messages: 0, malformedLines: 5, daily: [], byModel: [] }),
      "30d",
    );
    expect(m.status).toBe("partial");
  });

  test("깨진 줄·읽기 실패도 partial 로 드러난다", () => {
    expect(assembleTokens(agg({ malformedLines: 2 }), "30d").status).toBe("partial");
    expect(assembleTokens(agg({ unreadableFiles: 1 }), "30d").status).toBe("partial");
  });

  test("일별 집계가 차트용 TrendSeries 로 변환된다", () => {
    const m = assembleTokens(agg(), "30d");
    expect(m.trend.window).toBe("30d");
    expect(m.trend.points.map((p) => p.value)).toEqual([500, 660]);
    expect(m.trend.summary).toEqual({ latest: 660, min: 500, max: 660, count: 2 });
    // 모든 지점이 실측값이므로 결측(ok=false)이 없다.
    expect(m.trend.points.every((p) => p.ok)).toBe(true);
  });
});
