# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**This file is the design record.** `README.md` is end-user documentation only — how to install, run
and read the dashboard — so don't put rationale, measured facts or invariants there; they belong here.
Before changing anything in `src/scan/` or `src/model/`, read **Data contracts and traps** below: it
records measured facts about the AI-DLC tree that most of this code exists to work around.

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

**B′. Claude token reader (read-only sibling of B).** `credit/claude/transcript-reader →
token-model → token-view` aggregates `~/.claude/projects/<slug>/*.jsonl`. It has no spawn, no
network, no storage and no polling — the transcripts *are* the history. It fills the same card slot
as B, and `model.usage` is a discriminated union so exactly one of the two renders. See **Usage
panel** below before changing either.

`server.ts` wires them: `handle(req, opts, credit)` is a pure-ish function over an injected
`CreditRuntime`, and `bootCredit()` builds that runtime behind injectable factories. `cli.ts` owns
argument parsing and startup validation. Filesystem readers belong in `src/scan/`, model assembly and
shared types in `src/model/`, HTML in `src/render/`. Treat `__backup/` as ignored historical
material, not source.

### Repository layout

```
start.sh             macOS/Linux launcher
start.cmd            Windows launcher (execution-policy bypass wrapper → start.ps1)
start.ps1            Windows launcher proper
src/
  server.ts          Bun.serve — re-reads the tree per request (~10ms total, no cache)
                     + the ONE mutable variable, the selected root (for folder switching)
  cli.ts             argument parsing + startup validation + ~ expansion
  scan/              disk → typed model (never throws)
    browse.ts        directory listing for the picker + workspace detection
    explorer.ts      per-OS root adapters + POSIX/Windows breadcrumbs
    workspaces.ts    bounded auto-discovery under home / dev locations
    resolve.ts       [copied] active-space/active-intent cursor resolution
    parser.ts        [copied] aidlc-state.md (+ Revision Count added)
    matrix.ts        [copied+modified] 3-state unit matrix
    stage-catalog.ts harness discovery (open set) + stage-graph.json + per-kind expectations
    audit.ts         merge every shard → time-ordered events
    sensors.ts       audit correlation + failure bodies
    questions.ts     unanswered-question detection
    memory-diary.ts  stage diary normalisation + decision/follow-up classification
    hooks-health.ts  heartbeat / drops / stop guard
    timing.ts        stage spans + IDLE/AGENT/WORK
  credit/            usage — the only write path (Kiro side) and its read-only sibling
    collector/       runs kiro-cli /usage (argv array, minimal env, 15s timeout)
    parser/          /usage text → metrics (defensive fallbacks, raw not retained)
    pipeline/        polling scheduler + refresh pipeline
    storage/         data/usage.db snapshots (bun:sqlite) ← not the workspace
    trend/           snapshot series → per-window trend
    view/            credit view-model + HTML + dependency-free SVG chart/gauge
    claude/          Claude Code tokens — no spawn, no network, no storage, read-only
      transcript-reader.ts  find ~/.claude/projects/<slug>/*.jsonl + window aggregate + memo
      token-model.ts        aggregate → view-model (incomplete passes surface as notes)
      token-view.ts         token table + per-model breakdown + daily trend HTML
  model/             scan/* → DashboardModel + provenance/freshness
                     the usage slot is a kiro|claude union — exactly one renders
  render/            HTML strings (no framework, <details> for collapsing)
    picker.ts        direct path + auto-discovery + OS-neutral unified explorer
fixtures/reference/  synthetic minimal workspace (for tests, not real run data)
```

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
identical output — with one deliberate exception, the usage panel (below).
`scan/stage-catalog.ts` *discovers* the harness dir as an open set — any
dot-directory containing `tools/data/stage-graph.json`, probing `.claude`/`.kiro`/`.aidlc`
first — so a harness that does not exist yet works without a code change. Don't turn this into a
fixed list. Without a catalogue, the Construction unit matrix degrades from 3-state
(absent/partial/complete) to 2-state, which hides blocked units; that degradation must stay visible
(warning + badge + matrix footnote), never silent.

Measured by renaming only the harness dir on one real run tree:

| tree | harness | result |
|---|---|---|
| original | `.kiro` | 85% · audit 4228 · blockers 2 · codegen 3c+1p/9 · warnings 0 |
| copy | `.claude` | **identical** |
| copy | `.aidlc` | **identical** |
| `aidlc/` only | none found | 85% · audit 4228 · blockers 2 · **codegen 4c+0p/9** · warnings 1 |

The last row is why the degradation has to be loud: with no catalogue a blocked unit (PU-3) is
reported complete, so the number gets *better* as information is lost. The engine's own
`aidlc-lib.ts` (`deriveHarnessDir()` / `KNOWN_HARNESS_DIRS`) documents its list as a probe-order hint
rather than the set of harnesses that exist — this module mirrors that.

### Usage panel — the one harness-specific card

The two harnesses expose usage through different mechanisms **and report different metrics**, so this
panel is a union, not a shared table. Kiro gives a remote *quota* (plan / limit / remaining / ratio /
reset date) via `kiro-cli /usage`; Claude Code has no non-interactive equivalent and instead leaves
*measured tokens* in local transcripts (input, output, cache read/create, thinking).

- **Never synthesise the missing quota.** Claude Code exposes no limit locally, so there is no
  denominator — no gauge, no usage %, no "remaining". Taking a configured limit and rendering a
  percentage would put a non-measured number where the dashboard promises a measured one. Same rule
  as `Provenance`: a new source gets its own honest shape, not a borrowed one.
- **`thinking` is a subset of `output`**, not an additional bucket. Never add it into a total; the
  table label says `(출력 내 포함)` for that reason.
- **`model.usage` is a discriminated union** (`{kind:"kiro"|"claude"}`). Both branches carry a
  `trend` with the same `TrendWindow`, so the `?cw=` contract and the chart are shared. Add a
  provider → extend the union, never add a parallel optional field.
- **`auto` follows the harness dir**, `--usage kiro|claude` overrides. When `.kiro` and `.claude`
  coexist, catalogue probe order would silently pick the panel, so `assemble` emits a warning naming
  both dirs and the flag — same "degradation must stay visible" rule as the matrix.
- **Bounded reads, loudly.** The reader filters files by mtime against the window and caps a single
  pass at `MAX_TOTAL_BYTES` (128MB, newest first). A capped pass reports `filesCapped`, which becomes
  a `부분 집계` badge plus an explicit under-count note. Never let a cap read as completeness — without
  the cap this cost grows without bound as transcripts accumulate.

  | transcripts | 7d | 30d | all |
  |---|---|---|---|
  | small (2 files / 493 msgs) | 20ms | 6ms | 5ms |
  | real run `word-book-claude` (8 files / 720 msgs) | 23ms | 10ms | 9ms |
  | worst (41 files read / 19,203 msgs / 18 capped) | 66ms | **268ms** | 196ms |

  Those are cold (unmemoised) figures, and the first call in a process carries JIT warm-up — which is
  why 7d can read slower than 30d on the same tree. **Memoised re-reads are ~0ms across every row**,
  and that is what the 60s poll actually pays. The worst tree's 30d pass hits the 128MB cap and drops
  18 old files, which is the case the badge exists for. Whole-page render on the real run tree stayed
  10–22ms.
- **Never read a transcript whole.** `readFileSync(f, "utf-8")` costs RSS in proportion to file size
  (measured: a 105MB file → +101MB), and the byte cap is a *sum*, so it does not bound a single file's
  peak. `readLines()` reads fixed 1MB chunks through a streaming `TextDecoder` (chunk boundaries split
  UTF-8 sequences) and hands over one line at a time; the same 105MB file lands at +71MB. Be honest
  about the size of that win: at 26MB it is +78MB → +73MB, because what remains is the retained
  aggregate and unreturned pages, not the buffer. What the change removes is peak scaling *linearly*
  with file size. Directory-level wall-clock is unchanged — most of the time is `JSON.parse`, not I/O.
- **`fs.readSync`, not `Bun.file().stream()`.** The Bun APIs are more idiomatic but async, and
  `assemble` is synchronous with every render path standing on it. Don't turn the whole model layer
  async for this one module.
- **The transcript memo is not a cache.** `server.ts` holds one `createMemo()` for the process. Every
  key carries file identity, never a clock: `files` is keyed `(path, size, mtimeMs)`, and transcripts
  are append-only so any change moves the key and misses the memo. It therefore cannot serve a stale
  value, which is why it does not violate the no-cache invariant. Two details are load-bearing:
  - `keyByPath` evicts the previous key for a path on every set. Without it an active session appends
    once per poll, each append mints a new key, and dead entries fill the 512-entry bound.
  - `dirs` memoises directory resolution **including the miss** (`null`). A slug miss is the normal
    case, not an exception — the workspace simply was never driven by Claude Code — and resolving it
    scans every project dir. Measured before memoising: 121ms and 64MB read per poll, always
    returning `undefined`. Reading only each file's 16KB head cut the scan itself to ~30ms; memoising
    the miss took the repeat cost to 0.005ms. The key includes the `projects` dir mtime so adding or
    removing a project invalidates it.

### Rendering

Server-rendered HTML strings, no framework and no build step. `renderPage` emits the shell (CSS +
poll script); `renderBody` emits just the region `/api/body` swaps in — the manual button, the timer
and `visibilitychange` all call the same client `refresh()` so the paths can't drift. Collapsing is
native `<details>`. Interpolate untrusted values through `esc()` from `render/common.ts`.

### Copied modules — watch for drift

`scan/parser.ts`, `scan/resolve.ts` and `scan/matrix.ts` were copied from `companion-extension/src/`
(matrix.ts also modified for 3-state). The extension is a separate release track; if its parser
changes, these must be diffed and reconciled by hand. The trees were deliberately separated so this
dashboard cannot break the extension's release; the price is drift, paid by hand-diffing.

### Settled decisions — don't re-litigate without new evidence

- **Polling, not a filesystem watcher.** Target trees are usually sync copies, and sync tools update
  atomically by writing a temp file and renaming — which kqueue/FSEvents can miss. Polling cannot miss
  it, and one read costs ~10ms (including 7.5ms to parse 4,228 audit blocks), so it is cheap enough.
- **No incremental audit parsing.** Offset tracking was considered and rejected: reading everything is
  already fast, and a shard replaced wholesale breaks the incremental assumption outright.
- **A server-side folder picker, not the OS dialog.** The browser cannot give a server-readable
  absolute path — `<input webkitdirectory>` yields file lists, the File System Access API yields
  sandboxed handles. So a local server does bounded discovery and directory listing instead. It
  exposes only folder name / type / is-a-workspace, never file contents, and only a path the server
  validated itself becomes the root.
- **The manual refresh button stays even with polling on.** Polling is late, not lossy: it is skipped
  while the tab is hidden (`document.hidden` guard, with `visibilitychange` catching the return), and
  editing `— SKIP` ↔ `— EXECUTE` by hand changes the *denominator* of the completion percentage (SKIP
  is excluded from both numerator and denominator), which the reader wants to see at once. Button,
  timer and tab-return all call the same `refresh()` so they cannot diverge.

## Data contracts and traps

Most of this code exists to work around the facts below. All measured on a real run tree (9 units,
4,228 events) unless stated otherwise.

### `runtime-graph.json` is not current

Recompilation only fires when the last 3 blocks of the audit tail match a transition regex
(`GATE_APPROVED|STAGE_STARTED|STAGE_AWAITING_APPROVAL|AUDIT_MERGED|WORKFLOW_COMPLETED`, per
`hooks/aidlc-runtime-compile.ts`). **Mid-stage the audit grows and the graph does not** — so it lags
systematically during exactly the window someone wants to watch.

Measured: the graph was **19.2 hours** behind the audit; the in-flight stage's `sensor_firings` was
`[]` while the audit held 178; counting stages that were re-run, **6 stages were under-reported**
(feasibility 64 vs an actual 120).

So sensor tallies treat **the audit as authoritative** and the graph as cross-check only, with a
freshness badge on screen. `bolt_dag` (unit roster, kind, topology) comes only from the graph, but it
is structural and therefore insensitive to the lag.

### Unit cells need three states, not two

Treating a non-empty segment directory as "present" **over-reports**. A unit parked at a plan-approval
question has `code-generation-plan.md` + `-questions.md` but no `code-summary.md`, and gets counted
complete — so the one unit that is actually blocked disappears from the screen.

Instead, expected artifacts come from `stage-graph.json`'s `produces` ∪ `optional_produces`, filtered
through `produces_kinds` by the unit's `kind`, then intersected with disk to yield **absent / partial
/ complete**. Verified against 4 stages × 9 units = 31 measured cells: **30 matched exactly**, and the
single mismatch was the real blocker.

### `**Context**` has two different 4-segment shapes

```
inception   > practices-discovery > contributions       > x.md   ← slot2 = subdirectory, stage = slot1
construction > PU-1-walking-skeleton > functional-design > x.md   ← slot2 = stage, slot1 = unit
```

`ARTIFACT_CREATED` / `ARTIFACT_UPDATED` carry no `**Stage**` field, so `Context` is the only source of
the stage — and **position alone cannot tell the two shapes apart.** Always taking slot1 loses per-unit
stages wholesale (`harness_timing_report.py` does this); always taking slot2 on 4 segments
mis-attributes stages that have subdirectories. Hence the `isStage` oracle from the workspace's own
stage catalogue. Corrections measured: practices-discovery 21→24, functional-design 50 (both then
correct). This is why the catalogue must load before the audit.

### `block-count.json`'s `count` is a no-progress counter

It resets to 0 on progress and only rises while nothing advances (`hooks/aidlc-stop.ts`). **A high
value means stuck, not busy** — reading it as a heartbeat inverts the diagnosis. The model preserves
that meaning, and the default screen does not surface raw hook state.

### Other contracts

- **The audit is sharded per clone** — `audit/<host>-<clone12hex>.md`. Read every shard and merge in
  time order; reading only the largest one silently drops another developer's work.
- **Only failed sensors leave a detail file** — all 46 files had `Pass: false`, and the audit's
  `SENSOR_FAILED` count was exactly 46. Pass counts exist only in the audit.
- **park/unpark cannot yield IDLE** — measured PARKED 50 vs UNPARKED 32, SESSION_STARTED 13 vs
  SESSION_ENDED 246. The pairs do not match, so timing classifies gaps between events instead of
  pairing spans.
- **A 0-second stage is normal** — the three bootstrap stages stamp STARTED/COMPLETED in the same
  second. Filtering on `elapsed > 0` flips completed stages to incomplete.
- **`state.md` lagging is not a fault** — `Last Updated` is stamped at transitions, so mid-stage it
  always trails. It is therefore not flagged stale; training the reader to ignore the badge would kill
  the `runtime-graph` warning that needs it.

## Verification status

What was actually exercised, so a future change knows which claims rest on measurement:

- **Measured on real run trees** — the data contracts above; harness neutrality across `.kiro` /
  `.claude` / `.aidlc`; the Claude token panel end to end on `word-book-claude` (`.claude` harness,
  audit 197, transcripts 16MB/8 files → 720 messages, 7 sessions, 139,872,131 tokens, 0 warnings,
  full page render 10–22ms, 0 workspace writes, and `--usage kiro` flipping the same tree to the
  credit panel).
- **Live-refresh behaviour is confirmed on Kiro IDE runs only.** On static copies only "values change
  after a sync" was verified.
- **Not verified on a real tree: the coexisting-`.kiro`-and-`.claude` warning path** — unit tests
  cover it; no real run tree had both.
- **Windows launchers (`start.cmd` / `start.ps1`) have never been executed on Windows** (dev machine
  is macOS). Syntax balance, automatic-variable collisions and `errorlevel` expansion timing were
  corrected from documentation, but a real run is still owed. macOS launchers are verified including
  the bash 3.2 double-click path.

## Style

Biome enforces two-space indent, 100-column lines, double quotes, semicolons, trailing commas, and
organized imports. TypeScript is strict with `noUncheckedIndexedAccess` and `noUnusedLocals` — no
unused values, no unchecked index access. kebab-case filenames (`stage-catalog.ts`), camelCase
functions and variables, PascalCase types and classes. `.gitattributes` pins LF for shell scripts and
CRLF for the Windows launchers; preserve both.

**Comment language is per-subsystem.** `scan/`, `model/`, `render/`, `cli.ts`, `server.ts` are
commented in English; `credit/**` is commented in Korean and cites the AI-DLC spec it was built from
(`BR1.2`, `NFR1.5`, unit ids `u1`–`u4`). Match the file you're editing, and keep those requirement
ids when touching credit code — they're the traceability link back to the spec. `credit/claude/**` is
Korean too but carries no `BR`/`NFR` ids on purpose: it was not built from that spec, so it cites the
measured facts and the host invariants it answers to instead. Don't invent ids for it. All
user-facing strings (HTML, console, error pages) are Korean.

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
credentials, or real workspace contents. `.gitignore` covers `node_modules`, `__backup` and `/data/` —
note the leading slash on the last one: an unanchored `data/` would also swallow
`fixtures/reference/.kiro/tools/data/stage-graph.json`, which the tests need.

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
