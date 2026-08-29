// Directory listing for the folder picker.
//
// WHY A SERVER-SIDE BROWSER AND NOT THE BROWSER'S OWN PICKER. A file input with
// `webkitdirectory` hands back a FileList of the folder's CONTENTS, never the
// folder's absolute path — browsers withhold it deliberately. The server needs a
// path it can read, so the picker has to be a server-rendered listing. The
// showDirectoryPicker() File System Access API has the same problem: it yields a
// handle scoped to the browser sandbox, not a path.
//
// SAFETY. The dashboard binds to loopback only, so this listing is reachable
// only from this machine — it exposes no more than a local shell already can.
// That bind is NOT a default to be relied on: `Bun.serve` defaults to `0.0.0.0`
// (all interfaces), and the only thing narrowing it is the explicit
// `hostname: HOST` in `server.ts`. Dropping that line exposes this listing to the
// network, so it stays. Even so, the listing is deliberately narrow: names,
// types and an "is this an AI-DLC workspace" flag, never file contents. Symlinks
// are not followed into (a link to / would make the walk unbounded), and dotfiles
// are hidden unless the caller asks, so the common case is a short list.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One row of a directory listing. */
export interface BrowseEntry {
  name: string;
  /** Absolute path, for the next hop. */
  fullPath: string;
  /** True when the entry holds an `aidlc/` dir — a selectable workspace. */
  isWorkspace: boolean;
  /** True when the entry is itself named `aidlc` — the tree, not its parent. */
  isAidlcDir: boolean;
  /** True when we could not read into it (permissions); still shown, not hidden. */
  unreadable: boolean;
}

export interface BrowseResult {
  /** The directory listed, absolute and resolved. */
  dir: string;
  /** Parent dir, or undefined at the filesystem root. */
  parent?: string;
  /** Subdirectories, workspaces first then alphabetical. */
  entries: BrowseEntry[];
  /** True when `dir` itself is a selectable workspace. */
  isWorkspace: boolean;
  /** Set when the requested path could not be listed. */
  error?: string;
}

/** True when `dir` holds an `aidlc/` subdirectory — i.e. is a workspace root. */
export function isWorkspaceDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "aidlc")).isDirectory();
  } catch {
    return false;
  }
}

function canRead(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * List the subdirectories of `dir`. `showHidden` includes dot-dirs (off by
 * default so the listing stays short; the picker offers a toggle because an
 * `aidlc/` tree can sit beside `.kiro`).
 *
 * Never throws: an unreadable or missing path comes back as `error` with the
 * home directory listed instead, so the picker always renders something usable.
 */
export function browse(dir: string, showHidden = false): BrowseResult {
  const resolved = path.resolve(dir);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const home = os.homedir();
    // Fall back to home rather than returning nothing — but only once, and never
    // if home is what already failed.
    if (resolved !== home) {
      const fallback = browse(home, showHidden);
      return { ...fallback, error: `${resolved} 열기 불가: ${message}` };
    }
    return {
      dir: resolved,
      parent: undefined,
      entries: [],
      isWorkspace: false,
      error: message,
    };
  }

  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    // isDirectory() is false for a symlink; that is intended — following links
    // can loop or escape into system trees, and a workspace is a real dir.
    if (!d.isDirectory()) continue;
    if (!showHidden && d.name.startsWith(".")) continue;
    const fullPath = path.join(resolved, d.name);
    entries.push({
      name: d.name,
      fullPath,
      isWorkspace: isWorkspaceDir(fullPath),
      isAidlcDir: d.name === "aidlc",
      unreadable: !canRead(fullPath),
    });
  }

  // Workspaces first (that is what the reader is hunting for), then by name.
  entries.sort((a, b) => {
    if (a.isWorkspace !== b.isWorkspace) return a.isWorkspace ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(resolved);
  return {
    dir: resolved,
    parent: parent === resolved ? undefined : parent,
    entries,
    isWorkspace: isWorkspaceDir(resolved),
  };
}

/**
 * Resolve what the user picked into a workspace root.
 *
 * Accepts either the workspace itself or its `aidlc/` dir — picking the folder
 * you are looking at is the obvious move, and it would be a poor experience to
 * reject it with "select the parent instead". Returns undefined when neither
 * interpretation holds.
 */
export function resolveWorkspace(picked: string): string | undefined {
  const abs = path.resolve(picked);
  if (isWorkspaceDir(abs)) return abs;
  if (path.basename(abs) === "aidlc") {
    const parent = path.dirname(abs);
    if (isWorkspaceDir(parent)) return parent;
  }
  return undefined;
}
