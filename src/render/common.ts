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

/** Compact duration for badges: 45s / 12m / 3.4h / 2.1d. */
export function dur(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
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
