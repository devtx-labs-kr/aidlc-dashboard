import { describe, expect, test } from "bun:test";
import { explorerBreadcrumbs, explorerRoots } from "./explorer";

function fakeFilesystem(paths: string[], listings: Record<string, string[]> = {}) {
  const normalized = new Set(paths.map((value) => value.toLowerCase()));
  return {
    directoryExists: (dir: string) => normalized.has(dir.toLowerCase()),
    listDirectories: (dir: string) => listings[dir] ?? [],
  };
}

describe("workspace explorer roots", () => {
  test("builds macOS home, filesystem, and volume roots without duplicates", () => {
    const fs = fakeFilesystem(["/Users/me", "/", "/Volumes/Team", "/Users/me/current"], {
      "/Volumes": ["Team"],
    });
    const roots = explorerRoots("/Volumes/Team/project", {
      platform: "darwin",
      homeDir: "/Users/me",
      activeRoot: "/Users/me/current",
      ...fs,
    });

    expect(roots.map(({ label, path, kind }) => ({ label, path, kind }))).toEqual([
      { label: "홈", path: "/Users/me", kind: "home" },
      { label: "현재", path: "/Users/me/current", kind: "current" },
      { label: "/", path: "/", kind: "filesystem" },
      { label: "볼륨 Team", path: "/Volumes/Team", kind: "volume" },
    ]);
    expect(roots.find((root) => root.active)?.path).toBe("/Volumes/Team");
  });

  test("finds Linux mount and media roots", () => {
    const fs = fakeFilesystem(["/home/me", "/", "/mnt/shared", "/media/me", "/media/me/USB"], {
      "/mnt": ["shared"],
      "/media": ["me"],
      "/media/me": ["USB"],
    });
    const roots = explorerRoots("/media/me/USB/repo", {
      platform: "linux",
      homeDir: "/home/me",
      ...fs,
    });

    expect(roots.map((root) => root.path)).toEqual([
      "/home/me",
      "/",
      "/mnt/shared",
      "/media/me",
      "/media/me/USB",
    ]);
    expect(roots.find((root) => root.active)?.path).toBe("/media/me/USB");
  });

  test("probes Windows drives and de-duplicates OneDrive case-insensitively", () => {
    const fs = fakeFilesystem(["C:\\Users\\me", "C:\\", "D:\\", "C:\\Users\\me\\OneDrive"], {
      "C:\\Users\\me": ["OneDrive"],
    });
    const roots = explorerRoots("D:\\work", {
      platform: "win32",
      homeDir: "C:\\Users\\me",
      env: {
        USERPROFILE: "C:\\Users\\me",
        OneDrive: "C:\\Users\\me\\OneDrive",
        OneDriveCommercial: "c:\\users\\me\\onedrive",
      },
      ...fs,
    });

    expect(roots.map((root) => root.path)).toEqual([
      "C:\\Users\\me",
      "C:\\",
      "D:\\",
      "C:\\Users\\me\\OneDrive",
    ]);
    expect(roots.find((root) => root.active)?.path).toBe("D:\\");
  });
});

describe("workspace explorer breadcrumbs", () => {
  test("builds POSIX root and segment links", () => {
    expect(explorerBreadcrumbs("/Users/me/project", "darwin")).toEqual([
      { label: "/", path: "/", current: false },
      { label: "Users", path: "/Users", current: false },
      { label: "me", path: "/Users/me", current: false },
      { label: "project", path: "/Users/me/project", current: true },
    ]);
  });

  test("keeps the Windows drive root intact", () => {
    expect(explorerBreadcrumbs("C:\\Users\\me\\project", "win32")).toEqual([
      { label: "C:\\", path: "C:\\", current: false },
      { label: "Users", path: "C:\\Users", current: false },
      { label: "me", path: "C:\\Users\\me", current: false },
      { label: "project", path: "C:\\Users\\me\\project", current: true },
    ]);
  });
});
