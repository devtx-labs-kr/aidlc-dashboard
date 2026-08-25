// COPIED VERBATIM from companion-extension/src/resolve.ts (vsix 2.0.4) — see the
// copy-provenance note in parser.ts for why the trees stay independent.
//
// Locate the active intent's aidlc-state.md inside the AI-DLC workspace layout
// introduced in v2.1.1 and unchanged through v2.2.0 (the engine this panel
// targets). Each intent owns its own record dir and state file:
//
//   aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md
//
// and which one is "active" is decided by two cursors, not by globbing — a
// workspace can hold several intents at once, so a glob would pick an arbitrary
// (possibly wrong) workflow. The resolution rule here is a verbatim transcript
// of the engine's own (aidlc-lib.ts: activeSpace / activeIntent / listIntentDirs),
// so the panel resolves the SAME intent the engine considers active.
//
// Node fs only (local FS) — no vscode import — so it stays unit-testable headless
// the way parser.ts / render.ts are.

import * as fs from "node:fs";
import * as path from "node:path";

const ACTIVE_SPACE_POINTER = "active-space";
const ACTIVE_INTENT_POINTER = "active-intent";
const DEFAULT_SPACE = "default";
const STATE_FILE = "aidlc-state.md";

export type ResolveResult =
  | { kind: "ok"; rel: string } // POSIX rel path under the root to aidlc-state.md
  | { kind: "ambiguous" } // 2+ intent records, no valid active-intent cursor
  | { kind: "none" }; // no aidlc/ tree, or a space with 0 records

/** Watcher patterns (POSIX rel) whose change can flip the active intent. */
export const ACTIVE_SPACE_GLOB = `aidlc/${ACTIVE_SPACE_POINTER}`;
export const ACTIVE_INTENT_GLOB = `aidlc/spaces/*/intents/${ACTIVE_INTENT_POINTER}`;

function readCursor(file: string): string {
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    return raw;
  } catch {
    return "";
  }
}

/** aidlc/active-space cursor; "default" when absent/empty. Never throws. */
function activeSpace(rootFs: string): string {
  const raw = readCursor(path.join(rootFs, "aidlc", ACTIVE_SPACE_POINTER));
  return raw.length > 0 ? raw : DEFAULT_SPACE;
}

function hasState(recordDir: string): boolean {
  try {
    return fs.existsSync(path.join(recordDir, STATE_FILE));
  } catch {
    return false;
  }
}

/** Record dir names (those holding an aidlc-state.md) in an intents dir, sorted. */
function listIntentDirs(intentsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(intentsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => hasState(path.join(intentsDir, name))).sort();
}

/**
 * Resolve the active intent's state file under `rootFs`. Mirrors the engine's
 * precedence: active-intent cursor (pointing at a real record) > lone intent >
 * (0 records → none / 2+ records with no cursor → ambiguous).
 */
export function resolveState(rootFs: string): ResolveResult {
  const space = activeSpace(rootFs);
  const intentsDir = path.join(rootFs, "aidlc", "spaces", space, "intents");

  const rel = (record: string): string => `aidlc/spaces/${space}/intents/${record}/${STATE_FILE}`;

  // Cursor hit: the active-intent pointer names a directory that has a state file.
  const cursor = readCursor(path.join(intentsDir, ACTIVE_INTENT_POINTER));
  if (cursor.length > 0 && hasState(path.join(intentsDir, cursor))) {
    return { kind: "ok", rel: rel(cursor) };
  }

  // No valid cursor: lone intent wins; 0 → none; 2+ → ambiguous (don't guess).
  const records = listIntentDirs(intentsDir);
  if (records.length === 1) return { kind: "ok", rel: rel(records[0]!) };
  if (records.length === 0) return { kind: "none" };
  return { kind: "ambiguous" };
}
