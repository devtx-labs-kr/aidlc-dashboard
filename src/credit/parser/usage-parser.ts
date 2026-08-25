/**
 * UsageParser — `/usage` 원시 문자열을 방어적으로 파싱하는 순수 함수(BR2.1~BR2.4).
 *
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본. 기존 credit-dashboard 파서 로직을 그대로
 * 옮겼다(새 파싱/이스케이프 유틸을 발명하지 않는다). `ParsedUsage`는 u1 소유 타입이므로
 * `../types`에서 import하고, u2 소유의 폴백 계약 타입 `ParseResult`는 이 모듈에서 정의·export한다.
 *
 * 하드 계약:
 * - CLI를 spawn하지 않는다(순수 함수, 문자열 입력만).
 * - 예외를 절대 던지지 않는다. 판별 유니언 `ParseResult`를 반환한다(BR2.1).
 * - `/usage`는 비계약적 텍스트라 포맷이 언제든 바뀔 수 있다. 라벨 별칭 다수와 유연한
 *   숫자 추출로 방어하고, 포맷 변경에도 크래시하지 않는다.
 *
 * 판정 규칙:
 * - 빈/공백 입력           → `{ ok: false }` (완전 실패)
 * - 6개 필드 중 0개 추출    → `{ ok: false }` (인식 불가, 완전 실패)
 * - 일부만 추출            → `{ ok: true, partial: true }` (부분 파싱, BR2.3)
 * - 6개 모두 추출          → `{ ok: true, partial: false }` (정상)
 */

import type { ParsedUsage } from "../types";

/** 파서 폴백 계약: 예외 대신 값으로 성공/실패를 표현하는 판별 유니언(BR2.1). u2 소유. */
export type ParseResult =
  | { ok: true; data: ParsedUsage }
  | { ok: false; raw: string; reason: string };

/** ANSI escape 시퀀스 제거(CLI 색상 코드 방어). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape(\x1b) 제거가 목적이다.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** 필드별 라벨 별칭(한국어/영어, 대소문자 무시). 앞쪽일수록 우선. */
const FIELD_LABELS = {
  planName: ["플랜명", "플랜", "plan name", "plan", "subscription", "tier"],
  usedAmount: [
    "누적 사용량",
    "누적사용량",
    "사용량",
    "credits used",
    "used credits",
    "used",
    "usage total",
  ],
  remainingAmount: [
    "남은 잔량",
    "잔량",
    "남은",
    "remaining credits",
    "remaining",
    "balance",
    "left",
  ],
  planLimit: ["플랜 한도", "한도", "credit limit", "limit", "quota", "total credits", "total"],
  usageRatio: ["사용률", "usage rate", "usage", "percent used", "percentage"],
  resetDate: [
    "리셋일",
    "리셋",
    "reset date",
    "resets on",
    "resets",
    "reset",
    "renews on",
    "renews",
  ],
} as const;

/**
 * 라벨 뒤에 오는 값 토큰을 추출한다. `라벨[:=]\s*<값>` 형태를 우선 시도하되,
 * 콜론 없는 공백 구분(`라벨   값`)도 허용한다. 값은 줄 끝까지 캡처한 뒤 정제한다.
 */
function extractRawValue(text: string, labels: readonly string[]): string | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 라벨은 줄 시작(불릿/공백 허용) 근처에서만 인식한다. 이렇게 하면 헤더나 단어
    // 내부 부분 일치("Credit Usage" 안의 "usage" 등)를 피할 수 있다.
    const re = new RegExp(`(?:^|[\\n\\r])[\\t >*•\\-]*${escaped}\\s*[:=]?\\s*([^\\n\\r]+)`, "i");
    const m = text.match(re);
    if (m?.[1] !== undefined) {
      const value = m[1].trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

/**
 * 문자열에서 첫 번째 숫자(부호·천단위 콤마·소수 허용)를 추출한다.
 * 실패 시 null. 매우 큰 값과 음수, 0을 모두 허용한다(경계값).
 */
function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  // 콤마(천단위)를 제거한 뒤 부호+소수 숫자 매칭.
  const cleaned = raw.replace(/,/g, "");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 사용률 문자열("45.5%" 또는 "0.455")을 0~1 비율로 정규화한다. */
function parseRatio(raw: string | null): number | null {
  if (raw === null) return null;
  const hasPercent = raw.includes("%");
  const n = parseNumber(raw);
  if (n === null) return null;
  if (hasPercent) return n / 100;
  // % 없이 1보다 큰 값이면 퍼센트로 간주(예: "45.5"), 아니면 이미 비율(0~1).
  return n > 1 ? n / 100 : n;
}

/** 플랜명 값 정제: 첫 토큰(공백 전까지)을 취하되 과도한 꼬리를 제거. */
function cleanPlanName(raw: string | null): string | null {
  if (raw === null) return null;
  // 괄호/추가 설명 이전의 핵심 토큰만.
  const token = raw.split(/[()]/)[0]?.trim();
  if (!token) return null;
  // 순수 숫자만 있으면 플랜명이 아님.
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return null;
  return token;
}

/** 리셋일 값 정제: 날짜 유사 토큰을 추출(YYYY-MM-DD / MM-DD / 자유 문자열 허용). */
function cleanResetDate(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // ISO/부분 날짜 우선 추출, 없으면 정제된 원문 그대로.
  const dateMatch = trimmed.match(
    /\d{4}-\d{2}-\d{2}|\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|\d{1,2}-\d{1,2}/,
  );
  return dateMatch ? dateMatch[0] : trimmed;
}

/**
 * `/usage` 원시 문자열 → 구조화 결과. 절대 예외를 던지지 않는다.
 */
export function parseUsage(rawInput: string): ParseResult {
  try {
    if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
      return { ok: false, raw: rawInput ?? "", reason: "빈 출력 — 파싱할 내용이 없습니다." };
    }

    const text = rawInput.replace(ANSI_PATTERN, "");

    let planName = cleanPlanName(extractRawValue(text, FIELD_LABELS.planName));
    let usedAmount = parseNumber(extractRawValue(text, FIELD_LABELS.usedAmount));
    let remainingAmount = parseNumber(extractRawValue(text, FIELD_LABELS.remainingAmount));
    let planLimit = parseNumber(extractRawValue(text, FIELD_LABELS.planLimit));
    let usageRatio = parseRatio(extractRawValue(text, FIELD_LABELS.usageRatio));
    let resetDate = cleanResetDate(extractRawValue(text, FIELD_LABELS.resetDate));

    // ── 포맷별 휴리스틱: 라벨:값 패턴이 아닌 실제 CLI 패널 포맷을 방어적으로 보강한다.
    // 예) "Credits (4553 of 10000 covered in plan)" / "resets on 9-1-2026" /
    //     "Estimated Usage | ... | KIRO POWER" / 진행 막대 뒤 "45%".

    // "(X of Y ...)" — 누적/한도.
    if (usedAmount === null || planLimit === null) {
      const m = text.match(/\(\s*([\d,]+(?:\.\d+)?)\s+of\s+([\d,]+(?:\.\d+)?)/i);
      if (m) {
        if (usedAmount === null) usedAmount = parseNumber(m[1] ?? null);
        if (planLimit === null) planLimit = parseNumber(m[2] ?? null);
      }
    }

    // "resets on <M-D-Y | Y-M-D>" — 리셋일.
    if (resetDate === null) {
      const m = text.match(/resets?\s+on\s+(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})/i);
      if (m?.[1] !== undefined) resetDate = m[1].trim();
    }

    // "Estimated Usage | ... | <PLAN>" — 파이프 구분 라인의 마지막 세그먼트를 플랜명으로.
    if (planName === null) {
      for (const line of text.split(/[\n\r]+/)) {
        if (!/estimated usage|usage summary/i.test(line)) continue;
        const segs = line
          .split("|")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const last = segs[segs.length - 1];
        if (last !== undefined && !/estimated usage|usage summary|resets?/i.test(last)) {
          planName = cleanPlanName(last);
        }
        break;
      }
    }

    // 진행 막대 뒤 백분율 — 사용률.
    if (usageRatio === null) {
      const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
      const n = parseNumber(m?.[1] ?? null);
      if (n !== null) usageRatio = n / 100;
    }

    // ── 파생값 보강.
    // 사용률이 여전히 없으면 used/limit로 계산.
    if (usageRatio === null && usedAmount !== null && planLimit !== null && planLimit > 0) {
      usageRatio = usedAmount / planLimit;
    }
    // 잔량이 명시되지 않았고 used·limit를 알면 파생.
    if (remainingAmount === null && usedAmount !== null && planLimit !== null) {
      remainingAmount = planLimit - usedAmount;
    }

    const fields = [planName, usedAmount, remainingAmount, planLimit, usageRatio, resetDate];
    const obtained = fields.filter((v) => v !== null).length;

    if (obtained === 0) {
      return {
        ok: false,
        raw: rawInput,
        reason: "인식 가능한 크레딧 지표를 찾지 못했습니다 (포맷 변경 가능성).",
      };
    }

    const data: ParsedUsage = {
      planName,
      usedAmount,
      remainingAmount,
      planLimit,
      usageRatio,
      resetDate,
      partial: obtained < fields.length,
    };
    return { ok: true, data };
  } catch (err) {
    // 방어: 어떤 예상 못 한 오류도 값으로 흘려보낸다.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      raw: typeof rawInput === "string" ? rawInput : "",
      reason: `파서 내부 오류: ${reason}`,
    };
  }
}
