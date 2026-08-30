// Shared render helpers. Every renderer builds HTML strings, so escaping is the
// one thing that must never be skipped: artifact paths, question headings and
// sensor messages all come from a run's files and can contain `<`, `&`, quotes.

/** HTML-escape text for element content and quoted attribute values. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minutes, one decimal — the unit the timing panels read in. */
export function mins(sec: number): string {
  return (sec / 60).toFixed(1);
}

/**
 * Compact duration for an AGE — how long ago something happened, or how long a
 * question has been waiting: 45s / 12m / 3.4h / 2.1d. Calendar days are the right
 * unit here because that is what the reader is asking ("this has sat for 4 days").
 *
 * NOT for the timing panel — use `hours()` there. See the note on it.
 */
export function dur(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

/**
 * The same, but a duration NEVER rolls up past hours: 45s / 12m / 139.5h.
 *
 * WHY THE DAY UNIT IS BANNED FROM THE TIMING PANEL. `d` there means a 24-hour
 * calendar day, and a reader spends it as a *working* day of roughly eight hours.
 * On one real run the KPI row read `5.8d 팀 벽시계 · 3.4d 일시중지 · 1.2d 관측 실행`
 * — so the run looked like it had worked about one day, when 1.2d is 28.8 hours, or
 * well over three working days. The error is a factor of three and it lands on the
 * one number the panel exists to convey.
 *
 * A single unit also makes the row comparable at a glance: `139.5h / 81.9h / 28.8h`
 * can be read against each other, `5.8d / 3.4d / 18.4h` cannot.
 *
 * Sub-hour values keep `m` and `s`. The confusion this fixes is specific to the
 * day/work-day collision — nobody reads `25m` as a unit of effort — and `0.4h`
 * would be worse, with `45s` becoming a misleading `0.0h`.
 *
 * Working days are deliberately NOT derived here. An 8-hour day is a configured
 * convention, not something the ledger measured, and this dashboard does not put a
 * synthesised number where it promises a measured one (same rule as the missing
 * usage quota).
 */
export function hours(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/** `2026-07-30T05:26:20Z` → `07-30 05:26`. Empty input yields an em dash. */
export function shortTs(ts: string | undefined): string {
  if (!ts) return "—";
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}

/** A percentage bar. `pct` null (fully skipped phase) renders an empty track. */
export function bar(pct: number | null, cls = ""): string {
  const w = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return `<div class="bar ${esc(cls)}"><div class="bar-fill" style="width:${w}%"></div></div>`;
}

/** A small labelled pill. `tone` picks the colour class. */
export function pill(
  label: string,
  tone: "ok" | "warn" | "bad" | "mute" = "mute",
  tooltip?: string,
): string {
  const help = tooltip
    ? ` title="${esc(tooltip)}" aria-label="${esc(`${label}: ${tooltip}`)}"`
    : "";
  return `<span class="pill ${tone}${tooltip ? " has-help" : ""}"${help}>${esc(label)}</span>`;
}

/** Section wrapper with a heading. */
export function section(title: string, body: string, id?: string): string {
  return `<section class="card"${id ? ` id="${esc(id)}"` : ""}>
  <h2>${esc(title)}</h2>
  ${body}
</section>`;
}
