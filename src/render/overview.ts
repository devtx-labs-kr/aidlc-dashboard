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
    state === "complete" ? "█" : state === "partial" ? "▨" : state === "n/a" ? "–" : "·";
  const tip =
    state === "partial"
      ? `미완: ${missing.join(", ")}`
      : state === "complete"
        ? `완료: ${present.join(", ")}`
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
      const n = `${s.complete}${s.partial ? `+${s.partial}▨` : ""}/${applicable}${
        s.notApplicable ? ` (–${s.notApplicable})` : ""
      }`;
      return `<tr><th>${esc(s.display)}${s.provisional ? '<span class="prov-mark" title="진행 중 — 수치는 계속 늘어남">~</span>' : ""}</th>${cells}<td class="mx-n">${esc(n)}</td></tr>`;
    })
    .join("");

  const anyNa = mx.stages.some((s) => s.notApplicable > 0);
  const note = mx.contractAware
    ? `<p class="note">█ 계약 충족 · ▨ 착수했으나 산출물 미완(칸에 마우스를 올리면 무엇이 빠졌는지 표시) · · 미착수${
        anyNa ? " · – 이 유닛 kind 에 계약된 산출물 없음(계 열의 괄호는 그 수)" : ""
      }</p>`
    : '<p class="note warn">stage-graph.json 부재로 계약 판정 불가 — 칸은 파일 유무만 뜻함</p>';

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

export function renderOverview(m: DashboardModel): string {
  const parts: string[] = [];

  parts.push(section("진행 개요", hero(m.state, m.identity)));
  parts.push(section("Phase · Stage", phaseBlocks(m.state, m.artifacts)));

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
