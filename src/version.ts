// The single source of truth for the build's version: `package.json`.
//
// Read from disk at import rather than imported as JSON. Importing the JSON would
// need `resolveJsonModule` in tsconfig and an import attribute, and would bake the
// value into the module graph; reading it keeps the packaged copy and the repo copy
// honest with one file. It is read once at startup, so the cost is a single stat.
//
// Never throws. A build whose package.json is missing or malformed still serves the
// dashboard — it just reports `unknown`, which is a truthful answer and better than
// a boot failure over a display string.

import * as fs from "node:fs";
import * as path from "node:path";

/** Version reported on screen, in the startup log and by the packaging script. */
export const VERSION: string = readVersion();

function readVersion(): string {
  const p = path.join(import.meta.dir, "..", "package.json");
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return "unknown";
  }
  try {
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : "unknown";
  } catch {
    return "unknown";
  }
}
