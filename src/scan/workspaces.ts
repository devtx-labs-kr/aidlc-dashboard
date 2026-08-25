// Bounded workspace discovery for the picker.
//
// The scan is intentionally synchronous: it runs only when the picker is
// rendered, and a directory-count ceiling keeps a large home directory from
// delaying the server indefinitely. Common development locations are searched
// first and more deeply than the rest of the home directory.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isWorkspaceDir } from "./browse";

const COMMON_DIRS = [
  "Development",
  "Developer",
  "Projects",
  "Project",
  "Code",
  "Repos",
  "Repositories",
  "Source",
  "Sources",
  "workspace",
  "workspaces",
] as const;

const SKIP_DIRS = new Set([
  "$recycle.bin",
  "__backup",
  ".git",
  ".hg",
  ".svn",
  "appdata",
  "applications",
  "build",
  "coverage",
  "data",
  "dist",
  "library",
  "movies",
  "music",
  "node_modules",
  "pictures",
  "target",
  "vendor",
]);

export interface WorkspaceMatch {
  name: string;
  path: string;
}

export interface WorkspaceDiscovery {
  workspaces: WorkspaceMatch[];
  searchedRoots: string[];
  scannedDirectories: number;
  truncated: boolean;
}

export interface DiscoveryOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Maximum number of directories read across all roots. */
  maxDirectories?: number;
}

interface SearchRoot {
  path: string;
  maxDepth: number;
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function oneDriveRoots(home: string, env: Record<string, string | undefined>): string[] {
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial, env.ONEDRIVE].filter(
    (value): value is string => Boolean(value?.trim()),
  );

  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith("onedrive")) {
        roots.push(path.join(home, entry.name));
      }
    }
  } catch {
    // The home root itself will be reported as unavailable by the main scan.
  }
  return roots;
}

function searchRoots(
  home: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): SearchRoot[] {
  const bases = platform === "win32" ? [home, ...oneDriveRoots(home, env)] : [home];
  const candidates: SearchRoot[] = [];

  // Search likely project containers first. A global visited set prevents the
  // later home scan from reading them twice.
  for (const base of bases) {
    for (const name of COMMON_DIRS) {
      candidates.push({ path: path.join(base, name), maxDepth: 5 });
    }
    candidates.push({ path: path.join(base, "Documents"), maxDepth: 4 });
  }
  for (const base of bases) candidates.push({ path: base, maxDepth: 3 });

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = pathKey(candidate.path, platform);
    if (seen.has(key) || !directoryExists(candidate.path)) return false;
    seen.add(key);
    return true;
  });
}

function shouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name.toLowerCase());
}

/**
 * Find directories that directly contain an `aidlc/` directory.
 *
 * Discovery never follows symlinks. It searches common development locations
 * to depth five and the remaining home/OneDrive roots to depth three.
 */
export function discoverWorkspaces(options: DiscoveryOptions = {}): WorkspaceDiscovery {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home =
    options.homeDir ??
    (platform === "win32" && env.USERPROFILE ? env.USERPROFILE : undefined) ??
    os.homedir();
  const maxDirectories = Math.max(1, options.maxDirectories ?? 5_000);
  const roots = searchRoots(path.resolve(home), env, platform);
  const visited = new Set<string>();
  const found = new Map<string, WorkspaceMatch>();
  let scannedDirectories = 0;
  let truncated = false;

  for (const root of roots) {
    const queue: { dir: string; depth: number }[] = [{ dir: root.path, depth: 0 }];

    for (let index = 0; index < queue.length; index++) {
      if (scannedDirectories >= maxDirectories) {
        truncated = true;
        break;
      }

      const item = queue[index]!;
      const key = pathKey(item.dir, platform);
      if (visited.has(key)) continue;
      visited.add(key);
      scannedDirectories++;

      if (isWorkspaceDir(item.dir)) {
        found.set(key, { name: path.basename(item.dir), path: path.resolve(item.dir) });
        continue;
      }
      if (item.depth >= root.maxDepth) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || shouldSkip(entry.name)) continue;
        queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
      }
    }

    if (truncated) break;
  }

  return {
    workspaces: [...found.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
    ),
    searchedRoots: roots.map((root) => path.resolve(root.path)),
    scannedDirectories,
    truncated,
  };
}
