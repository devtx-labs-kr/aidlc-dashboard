import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverWorkspaces } from "./workspaces";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dashboard-workspaces-"));
  tempDirs.push(dir);
  return dir;
}

function createWorkspace(root: string): string {
  fs.mkdirSync(path.join(root, "aidlc"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("discoverWorkspaces", () => {
  test("finds workspaces under common development locations and the home tree", () => {
    const home = tempDir();
    const development = createWorkspace(path.join(home, "Development", "team", "alpha"));
    const homeTree = createWorkspace(path.join(home, "clients", "beta"));

    const result = discoverWorkspaces({ homeDir: home });

    expect(result.workspaces.map((workspace) => workspace.path)).toEqual([development, homeTree]);
    expect(result.truncated).toBe(false);
  });

  test("searches USERPROFILE and OneDrive locations on Windows", () => {
    const root = tempDir();
    const profile = path.join(root, "profile");
    const oneDrive = path.join(root, "OneDrive - Example");
    fs.mkdirSync(profile, { recursive: true });
    const workspace = createWorkspace(path.join(oneDrive, "Documents", "Projects", "gamma"));

    const result = discoverWorkspaces({
      homeDir: profile,
      platform: "win32",
      env: { USERPROFILE: profile, OneDriveCommercial: oneDrive },
    });

    expect(result.workspaces).toEqual([{ name: "gamma", path: workspace }]);
    expect(result.searchedRoots).toContain(oneDrive);
  });

  test("does not descend into hidden, dependency, or symlink directories", () => {
    const home = tempDir();
    const external = createWorkspace(path.join(tempDir(), "external"));
    createWorkspace(path.join(home, ".secret", "hidden"));
    createWorkspace(path.join(home, "__backup", "archived"));
    createWorkspace(path.join(home, "node_modules", "package"));
    fs.symlinkSync(external, path.join(home, "linked"), "dir");

    const result = discoverWorkspaces({ homeDir: home });

    expect(result.workspaces).toEqual([]);
  });

  test("reports when the directory ceiling truncates discovery", () => {
    const home = tempDir();
    for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(home, name), { recursive: true });

    const result = discoverWorkspaces({ homeDir: home, maxDirectories: 1 });

    expect(result.scannedDirectories).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
