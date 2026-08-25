# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is the authoritative design document (Korean). Its **데이터 계약과 함정** section
records measured facts about the AI-DLC tree that most of this code exists to work around — read it
before changing anything in `src/scan/` or `src/model/`.

## Commands

```bash
bun install                                   # pinned deps from bun.lock
bun run dev                                   # watch-mode server
bun run start -- --root /path/to/workspace    # port 4321
bun run verify                                # typecheck + lint + tests — run before submitting
bun run typecheck                             # strict tsc, no emit
bun run lint                                  # Biome check on src/
bun run format                                # Biome write on src/
bun test                                      # all tests
bun test src/scan/explorer.test.ts            # one file
bun test --test-name-pattern "audit shard"    # one describe/test by name
bun run src/server.ts --root ~/ws --harness .kiro --poll 0
```

There is no compilation step for normal development. `start.sh` / `start.cmd` / `start.ps1` are the
end-user launchers (bun detection, first-run install, browser open) — not the dev path.

## Architecture

Two subsystems share one Bun process:

**A. Workspace observer (read-only).** `scan/ → model/ → render/`, strictly one-directional.
`model/assemble.ts::assemble(root, harnessDir?, creditCtx?)` is the *only* entry point that turns a
workspace into a `DashboardModel`; every route that renders or serves JSON calls it. There is no
cache — a full read is ~10ms, and caching would only add staleness to a dashboard whose purpose is
not being stale.

**B. Credit usage collector (the only writer).** `credit/collector → parser → pipeline → storage`,
with `trend/` and `view/` on the read side. It shells out to `kiro-cli chat --no-interactive /usage`
and appends snapshots to `data/usage.db` (bun:sqlite). Nothing here touches the workspace.

`server.ts` wires them: `handle(req, opts, credit)` is a pure-ish function over an injected
`CreditRuntime`, and `bootCredit()` builds that runtime behind injectable factories. `cli.ts` owns
argument parsing and startup validation. Filesystem readers belong in `src/scan/`, model assembly and
shared types in `src/model/`, HTML in `src/render/`. Treat `__backup/` as ignored historical
material, not source.

### Invariants that shape the code

- **Never write to the workspace.** Only two POST routes exist (`/api/refresh`,
  `/api/credit/refresh`); every other non-GET/HEAD returns 405. The server binds `127.0.0.1` only.
  `/open` spawns the user's editor, so it jails the client-supplied `rel` under the record dir first
  (`scan/open-file.ts`).
- **No scan module throws.** A partially-synced or malformed tree degrades to a thinner page plus a
  string in `model.warnings`. `NoRunError` (no resolvable intent record) is the single exception, and
  the server renders it as a 404 page naming the path it tried.
- **Credit failure never takes the dashboard down.** `bootCredit` catches everything and returns
  `{degraded: true}`; `assemble` isolates credit assembly and falls back to a `none` view. Preserve
  this when adding to the credit path.
- **Provenance is a first-class field, not a nicety.** The four sources read (disk, audit, `state.md`,
  `runtime-graph.json`) have genuinely different freshness — `runtime-graph.json` was measured 19h
  behind the audit mid-stage. Every panel carries a `Provenance` (`model/freshness.ts`) and staleness
  is stated on screen instead of being averaged away. New data → new `SourceKind`, not an unlabelled
  number.
- **One mutable variable in the process:** `activeRoot` in `server.ts`, written only by `/select`,
  and only with a path the server itself validated via `resolveWorkspace`. A client string never
  becomes the root.
- **Read order matters in exactly one place:** the stage catalogue loads before the audit, because
  audit `**Context**` attribution needs the catalogue's `isStage` oracle to disambiguate the two
  4-segment `Context` shapes.

### Harness neutrality

The dashboard reads only the `aidlc/` docs tree, so Kiro CLI/IDE and Claude Code runs both produce
identical output. `scan/stage-catalog.ts` *discovers* the harness dir as an open set — any
dot-directory containing `tools/data/stage-graph.json`, probing `.claude`/`.kiro`/`.aidlc`
first — so a harness that does not exist yet works without a code change. Don't turn this into a
fixed list. Without a catalogue, the Construction unit matrix degrades from 3-state
(absent/partial/complete) to 2-state, which hides blocked units; that degradation must stay visible
(warning + badge + matrix footnote), never silent.

### Rendering

Server-rendered HTML strings, no framework and no build step. `renderPage` emits the shell (CSS +
poll script); `renderBody` emits just the region `/api/body` swaps in — the manual button, the timer
and `visibilitychange` all call the same client `refresh()` so the paths can't drift. Collapsing is
native `<details>`. Interpolate untrusted values through `esc()` from `render/common.ts`.

### Copied modules — watch for drift

`scan/parser.ts`, `scan/resolve.ts` and `scan/matrix.ts` were copied from `companion-extension/src/`
(matrix.ts also modified for 3-state). The extension is a separate release track; if its parser
changes, these must be diffed and reconciled by hand.

## Style

Biome enforces two-space indent, 100-column lines, double quotes, semicolons, trailing commas, and
organized imports. TypeScript is strict with `noUncheckedIndexedAccess` and `noUnusedLocals` — no
unused values, no unchecked index access. kebab-case filenames (`stage-catalog.ts`), camelCase
functions and variables, PascalCase types and classes. `.gitattributes` pins LF for shell scripts and
CRLF for the Windows launchers; preserve both.

**Comment language is per-subsystem.** `scan/`, `model/`, `render/`, `cli.ts`, `server.ts` are
commented in English; `credit/**` is commented in Korean and cites the AI-DLC spec it was built from
(`BR1.2`, `NFR1.5`, unit ids `u1`–`u4`). Match the file you're editing, and keep those requirement
ids when touching credit code — they're the traceability link back to the spec. All user-facing
strings (HTML, console, error pages) are Korean.

**Replies to the user are always in Korean** — polite (`해요`/`합니다`체) and naturally written, not
translated-sounding. This applies to chat responses, plans, and summaries regardless of the language
of the code or comments being discussed. Keep code identifiers, file paths, and CLI commands as-is;
don't translate them.

## Testing

`bun:test` with `describe` / `test` / `expect`. Name files `*.test.ts`; colocate them beside narrowly
scoped modules (as `credit/**` does) and put cross-module behaviour in `src/test/`. Prefer
deterministic fixtures and injected stubs over real I/O: `SpawnFn` for the collector, `CreditBootDeps`
factories for boot, `now()` for clocks. No test may invoke a real CLI or touch a real workspace.
`fixtures/reference/` is a synthetic minimal workspace (`aidlc/` + `.kiro/tools/data/`) — extend it
rather than pointing a test at real run data; parser samples live in `src/credit/parser/fixtures/`.
Add regression coverage for parsing fallbacks and degraded states.

## Commits & PRs

No commit history exists yet, so no convention is established. Use short imperative subjects (`Add
credit freshness warning`) and keep commits focused. PRs should explain behaviour changes, list
verification performed, and include screenshots for rendered UI changes. Never stage `data/usage.db`,
credentials, or real workspace contents — note that `data/` is **not** currently in `.gitignore`
despite the README calling it gitignored, so `git add -A` would pick the DB up.

## Agent memory

The `agent-memory` MCP server is registered at local scope for this project (stdio; the binary path
lives in the local MCP config, not in this repo) — use it as disk-backed persistent memory via
`mem_write` / `mem_recall`.

- **Always pass `project` and `session` explicitly.** Never rely on the server's `active_session`, and
  don't lean on the `project` default either — it is just `basename(cwd)`. Use `project:
  "aidlc-dashboard"` and a stable topic-scoped session name like `aidlc-dashboard-time-analysis`.
- **Search the same `project` + `session` before changing or duplicating an existing decision.**
- **Older records may be cold memory** — one DB at `~/.agent-memory/memory.db` (registered per
  project) that predates the current Claude Code setup, so early entries can be stale.
- **Hot memory is this project's Claude Code memory dir**
  (`~/.claude/projects/<slugified-cwd>/memory/`), auto-derived from cwd — no env vars are set. Don't
  assume it's current; check the source file when it matters. Never point
  `AGENT_MEMORY_HOT_PATHS` at another project's memory dir — that relabels their sections under this
  project's name and silently corrupts `project=` filtering.
- Store durable decisions, rationale, outcomes, and canonical references only. Never store
  credentials or bulk raw data.
