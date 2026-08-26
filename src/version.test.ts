// The version is a shipped fact: it names the customer archive, it is printed at
// startup and it is rendered in the footer. These pin the two things that matter —
// it agrees with package.json, and it is the same string the page shows.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { assemble } from "./model/assemble";
import { renderPage } from "./render/page";
import { VERSION } from "./version";

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "reference");

describe("VERSION", () => {
  test("matches package.json — the single source of truth", () => {
    const raw = fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8");
    const declared = (JSON.parse(raw) as { version: string }).version;
    expect(VERSION).toBe(declared);
  });

  test("is a semver-shaped string, never empty", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("reaches the rendered footer, escaped", () => {
    const html = renderPage(assemble(FIXTURE), 0);
    expect(html).toContain(`v${VERSION}`);
    // The footer is the one place a customer can read it off a screenshot.
    expect(html).toMatch(/<footer>[^<]*v\d+\.\d+\.\d+[^<]*<\/footer>/);
  });
});
