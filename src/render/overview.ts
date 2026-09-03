// Panel (a) — the overview: where the run is, how far along, and the per-unit
// Construction picture.
//
// The overall percentage comes from state.md's flat checkbox count, deliberately
// matching what the engine's own status line reports. Deriving a "truer" number
// from disk would make this dashboard disagree with the terminal and leave the
// reader unsure which to believe.

import type { DashboardModel } from "../model/types";
import type { StageArtifact } from "../scan/artifacts";
import type { CellState, ConstructionMatrix } from "../scan/matrix";
import type { AidlcState, StageStatus } from "../scan/parser";
import { bar, esc, pill, section, shortTs } from "./common";

/** Glyph per stage status, matching the state file's checkbox vocabulary. */
const STAGE_GLYPH: Record<StageStatus, string> = {
  done: "✔",
  active: "▶",
  awaiting: "⏸",
  revising: "↻",
  skipped: "⊘",
  pending: "·",
};

function hero(state: AidlcState, identity: DashboardModel["identity"]): string {
  const meta = [identity.scope ?? state.scope, state.projectType, identity.status]
    .filter((x) => x && x.length > 0)
    .join(" · ");
  const now = state.complete
    ? "완료"
    : `${state.currentStageDisplay || "—"}${
        state.activeAgentDisplay ? ` · ${state.activeAgentDisplay}` : ""
      }`;
  return `<div class="hero">
  <div class="hero-top">
    <span class="hero-phase">${esc(state.lifecyclePhase || "—")}</span>
    <span class="hero-pct">${state.overallPct}%</span>
  </div>
  ${bar(state.overallPct, "bar-overall")}
  <div class="hero-meta">${esc(meta)}</div>
  <div class="hero-now"><span class="k">현재</span> ${esc(now)}
    <span class="hero-count">${state.overallDone}/${state.overallTotal} stage</span></div>
  <div class="hero-meta small">${esc(identity.record)} · 갱신 ${esc(shortTs(state.lastUpdated))}</div>
</div>`;
}

/** Badge + title per artifact kind. Questions and the diary are not contract
 *  deliverables, so they are marked rather than hidden — a stalled run is
 *  usually sitting on a question file. */
const KIND_MARK: Record<StageArtifact["kind"], { mark: string; title: string }> = {
  artifact: { mark: "📄", title: "산출물" },
  questions: { mark: "💬", title: "질문/응답" },
  diary: { mark: "📓", title: "stage 일지" },
};

function fileSize(n: number): string {
  if (n <= 0) return "0";
  if (n < 1024) return `${n}B`;
  return `${Math.round(n / 1024)}K`;
}

/** One stage row. Files present → a <details> the user can expand; none →
 *  a plain row, so an empty toggle never invites a dead click. */
function stageRow(
  s: AidlcState["phases"][number]["stages"][number],
  files: StageArtifact[],
): string {
  const head = `<span class="glyph">${STAGE_GLYPH[s.status]}</span>${esc(s.display)}${
    s.execute ? "" : ' <span class="skip">SKIP</span>'
  }`;
  if (files.length === 0) {
    return `<li class="stage s-${esc(s.status)} no-art">${head}</li>`;
  }
  const items = files
    .map((f) => {
      const k = KIND_MARK[f.kind];
      // Unit prefix is required, not cosmetic: a merged Construction row carries
      // one `code-generation-plan.md` per unit, so the basename alone is ambiguous.
      const unit = f.unit ? `<span class="art-unit">${esc(f.unit)}</span>` : "";
      return `<li class="art a-${f.kind}"><a href="/open?rel=${encodeURIComponent(
        f.rel,
      )}" class="art-link" title="${esc(f.rel)} — 기본 편집기로 열기"><span class="art-mark" title="${
        k.title
      }">${k.mark}</span>${unit}<span class="art-name">${esc(f.name)}</span><span class="art-size">${esc(
        fileSize(f.size),
      )}</span></a></li>`;
    })
    .join("");
  return `<li class="stage s-${esc(s.status)}"><details class="art-box">
    <summary>${head}<span class="art-count">${files.length}</span></summary>
    <ul class="arts">${items}</ul>
  </details></li>`;
}

function phaseBlocks(state: AidlcState, artifacts: DashboardModel["artifacts"]): string {
  const rows = state.phases.map((p) => {
    const count = p.skipped ? "skipped" : `${p.done}/${p.total}`;
    const stages = p.stages
      .map((s) => {
        const key = s.bolt ? `construction/${s.bolt}/${s.slug}` : `${p.key}/${s.slug}`;
        return stageRow(s, artifacts[key] ?? []);
      })
      .join("");
    return `<details class="phase"${p.declaredStatus === "Active" ? " open" : ""}>
  <summary><span class="phase-name">${esc(p.display)}</span>
    <span class="phase-count">${esc(count)}</span>
    <span class="phase-declared">${esc(p.declaredStatus)}</span></summary>
  ${p.skipped ? "" : bar(p.pct)}
  <ul class="stages">${stages}</ul>
</details>`;
  });
  return rows.join("\n");
}

/** Cell glyph + tooltip. The tooltip is where `missing` earns its keep. */
function cellHtml(state: CellState, missing: string[], present: string[]): string {
  const glyph =
    state === "complete"
      ? "█"
      : state === "unsettled"
        ? "▩"
        : state === "unverified"
          ? "▤"
          : state === "partial"
            ? "▨"
            : state === "n/a"
              ? "–"
              : "·";
  const tip =
    state === "partial"
      ? `미완: ${missing.join(", ")}`
      : state === "complete"
        ? `완료: ${present.join(", ")}`
        : state === "unsettled"
          ? // Artifacts met, receipt missing. The engine treats this as UNCOVERED, so
            // the cell must not read as done — a paused/stale/reopened unit lands here.
            `산출물은 다 있으나 완료 수령증(UNIT_COMPLETED)이 없습니다 — 일시중지·재개 대기·미승인 상태일 수 있습니다 (파일: ${present.join(", ")})`
          : state === "unverified"
            ? // Not "not done" — "cannot be checked here". Merging this into unsettled put
              // a red cell over every gap in this reader's reproduction of the engine.
              `산출물은 다 있고, 완료 수령증은 감사 기록만으로 판정할 수 없습니다 — team 소유(claim 파일이 결정)·wave 모드(산출물 지문이 결정)·동시각 경계·Run floor 이전 원장 중 하나입니다 (파일: ${present.join(", ")})`
            : state === "n/a"
              ? `이 유닛 kind 에 계약된 산출물 없음${present.length ? ` (있는 파일: ${present.join(", ")})` : ""}`
              : "미착수";
  // `n/a` needs a class the CSS can target, and "/" is not usable in one.
  return `<td class="mx-cell c-${state === "n/a" ? "na" : state}" title="${esc(tip)}">${glyph}</td>`;
}

function matrixTable(mx: ConstructionMatrix): string {
  const head = mx.units
    .map(
      (u) =>
        `<th class="mx-unit" title="${esc(u.name)}${u.kind ? ` (${u.kind})` : ""}${
          u.dependsOn.length ? ` ← ${u.dependsOn.join(", ")}` : ""
        }">${esc(u.name.replace(/^PU-/, ""))}</th>`,
    )
    .join("");

  const rows = mx.stages
    .map((s) => {
      if (!s.execute) {
        return `<tr class="mx-skip"><th>${esc(s.display)}</th><td colspan="${mx.units.length}">SKIP</td><td class="mx-n">—</td></tr>`;
      }
      const cells = s.cells.map((c) => cellHtml(c.state, c.missing, c.present)).join("");
      // The denominator counts only units the stage actually contracts something
      // for; n/a units would otherwise read as outstanding work.
      const applicable = s.total - s.notApplicable;
      const n = `${s.complete}${s.unsettled ? `+${s.unsettled}▩` : ""}${
        s.unverified ? `+${s.unverified}▤` : ""
      }${s.partial ? `+${s.partial}▨` : ""}/${applicable}${
        s.notApplicable ? ` (–${s.notApplicable})` : ""
      }`;
      return `<tr><th>${esc(s.display)}${s.provisional ? '<span class="prov-mark" title="진행 중 — 수치는 계속 늘어남">~</span>' : ""}</th>${cells}<td class="mx-n">${esc(n)}</td></tr>`;
    })
    .join("");

  const anyNa = mx.stages.some((s) => s.notApplicable > 0);
  const anyUnsettled = mx.stages.some((s) => s.unsettled > 0);
  const anyUnverified = mx.stages.some((s) => s.unverified > 0);
  const note = mx.contractAware
    ? `<p class="note">█ 완료(수령증 확인) · ▨ 착수했으나 산출물 미완(칸에 마우스를 올리면 무엇이 빠졌는지 표시) · · 미착수${
        anyUnsettled
          ? " · ▩ 산출물은 다 있으나 완료 수령증(UNIT_COMPLETED) 없음 — 엔진도 이 유닛을 미완으로 봅니다"
          : ""
      }${
        anyUnverified
          ? " · ▤ 수령증을 감사 기록만으로 판정할 수 없음 — 미완이라는 뜻이 아닙니다"
          : ""
      }${anyNa ? " · – 이 유닛 kind 에 계약된 산출물 없음(계 열의 괄호는 그 수)" : ""}</p>${
        mx.stateCompat === "verified"
          ? ""
          : '<p class="note warn">state.md 와 harness 의 State Version 을 대조하지 못해 <b>확인되지 않은 계약</b>입니다 — 계약 내용은 그대로 보여주지만, 엔진과 같은 완료 판정이라고 보증하지 않습니다</p>'
      }`
    : `<p class="note warn">stage-graph.json 부재로 계약 판정 불가 — 칸은 파일 유무${
        // Receipts come from the audit, not the catalogue, so ▩ can appear with no
        // catalogue at all. Claiming "file presence only" was wrong whenever it did.
        mx.receiptAware ? "와 완료 수령증" : ""
      }만 뜻함</p>`;

  const batches = mx.batches.length
    ? `<div class="dag">${mx.batches
        .map(
          (b, i) =>
            `<div class="batch"><span class="batch-label">B${i + 1}</span>${b
              .map((u) => `<span class="batch-unit">${esc(u.replace(/^PU-/, ""))}</span>`)
              .join("")}</div>`,
        )
        .join('<span class="batch-arrow">→</span>')}</div>
      <p class="note">배치 안의 유닛은 병렬 가능 — 의존 순서대로 묶인 위상 배치.</p>`
    : "";

  return `<div class="mx-wrap"><table class="mx">
  <thead><tr><th></th>${head}<th class="mx-n">계</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
${note}
${batches}`;
}

/**
 * The state's own `## Unit Progress` table, when there is one. This is the AUTHORITY in
 * team/unit-major — an engine-owned projection of receipts, reviews and gates — so it is
 * shown before the disk matrix and labelled as such, rather than being reconstructed.
 */
function unitProgressTable(up: NonNullable<AidlcState["unitProgress"]>): string {
  const head = up.stageColumns.map((c) => `<th>${esc(c)}</th>`).join("");
  const rows = up.rows
    .map((r) => {
      const cells = up.stageColumns
        .map((c) => {
          const st = r.stages[c];
          return `<td class="mx-cell">${st ? esc(STAGE_GLYPH[st] ?? "·") : "·"}</td>`;
        })
        .join("");
      const owner = r.owner && r.owner !== "-" ? esc(r.owner) : '<span class="mute">미배정</span>';
      return `<tr><th>${esc(r.unit)}</th><td>${owner}</td>${cells}<td class="mx-cell">${
        r.gate ? esc(STAGE_GLYPH[r.gate] ?? "·") : "·"
      }</td>${r.merged ? `<td>${esc(r.merged)}</td>` : ""}</tr>`;
    })
    .join("");
  const mergedCol = up.rows.some((r) => r.merged !== undefined);
  return `<div class="mx-wrap"><table class="mx">
  <thead><tr><th>unit</th><th>owner</th>${head}<th>gate</th>${
    mergedCol ? "<th>merged</th>" : ""
  }</tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">state.md 의 <code>## Unit Progress</code> — 엔진이 수령증·리뷰·게이트를 반영해 매 <code>next</code> 마다 다시 쓰는
  <b>권위 있는 값</b>입니다. 손으로 고친 내용은 라우팅·완료 근거가 되지 않습니다. 아래 매트릭스는 디스크에서 재구성한 별개의 진단입니다.</p>`;
}

export function renderOverview(m: DashboardModel): string {
  const parts: string[] = [];

  parts.push(section("진행 개요", hero(m.state, m.identity)));
  parts.push(section("Phase · Stage", phaseBlocks(m.state, m.artifacts)));

  const up = m.state.unitProgress;
  if (up && !up.malformed && up.rows.length > 0) {
    parts.push(section("유닛 진행 (state.md 권위)", unitProgressTable(up), "unit-progress"));
  }
  if (m.matrix) {
    parts.push(section("Construction 유닛 매트릭스", matrixTable(m.matrix), "matrix"));
  } else {
    parts.push(
      section(
        "Construction 유닛 매트릭스",
        // The absent node is runtime-graph.json's `bolt_dag` (a legacy name for
        // what is really the Unit-of-Work DAG). The field name is kept out of the
        // note: it names a concept — Bolt — that this dashboard never shows.
        `<p class="note">유닛 정보 없음 — units-generation 미진입. ${pill(
          "해당 없음",
          "mute",
        )}</p>`,
      ),
    );
  }

  return parts.join("\n");
}
