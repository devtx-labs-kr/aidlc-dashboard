// What must never appear in anything this repository publishes.
//
// ⚠️ THIS FILE IS EXEMPT FROM THE AUDIT THAT USES IT. A denylist of the things you
// are hiding is itself the secret, so `audit-repo.ts` skips this path by name — which
// means this is the ONE file no automated check reads. A human has to. Never put a
// real customer name, hostname or token in here as a literal: names come from outside
// the repository at runtime (see `customerNames()`), and everything below is either a
// shape (`AKIA…`) or this codebase's own operator, which is already public in the
// commit history and is here only so a fresh path leak is caught.
//
// WHY THIS EXISTS SEPARATELY FROM THE ARCHIVE AUDIT. `package.ts` inspects the staged
// zip, which by design excludes `*.test.ts` and `fixtures/`. That is correct for the
// archive and wrong for the repository: the repo is a second exposure surface and had
// nothing checking it. Measured cost of the gap — a real customer name once survived
// in `transcript-reader.test.ts` after being removed from the module beside it, and
// four run-specific strings (a retail domain noun, a registry id, a team name, a
// project name) reached test fixtures and this module's own header comments before
// anyone looked. The archive audit passed every time, and passing was read as clean.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LeakPattern {
  pattern: RegExp;
  why: string;
}

/**
 * Strings that would leak the operator's machine.
 *
 * `/Users/me/` is exempt because it is this codebase's documented placeholder (the
 * picker's input hint, the slug example). Exempting it matters: an audit that cries
 * wolf on every intended example gets silenced wholesale, and then it catches
 * nothing. It earned its keep by flagging a real customer name sitting in a slug
 * example — so read every hit, never blanket-suppress one.
 */
export const MACHINE: readonly LeakPattern[] = [
  { pattern: /\b<operator>\b/i, why: "운영자 계정명" },
  {
    pattern: /\/Users\/(?!me\/)[a-z0-9._-]+\/(Development|Desktop|Documents)\//i,
    why: "다른 사람의 홈 경로",
  },
];

/**
 * Credential SHAPES, not values. Cheap to check and the one class of leak that is
 * immediately exploitable rather than merely embarrassing.
 */
export const CREDENTIALS: readonly LeakPattern[] = [
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, why: "GitHub personal access token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, why: "GitHub fine-grained token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS access key id" },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, why: "API 키" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, why: "사설 키" },
];

/** Where customer work trees live. Machine-local; absent on a fresh clone. */
const ACCOUNT_ROOTS = [
  path.join(os.homedir(), "Development", "ai-dlc", "_accounts"),
  path.join(os.homedir(), "Documents", "AI-DLC", "_accounts"),
];

/**
 * Names too short or generic to match on without drowning the report in noise.
 *
 * The list is short on purpose. The real defence against noise is matching only the
 * FULL directory name — see the note in `customerNames()` about the stem split that
 * had to be removed.
 */
const TOO_GENERIC = new Set(["update", "schema", "word-book", "aidlc-faq", "aidlc-demo-showcase"]);

/**
 * A trailing version or qualifier segment, stripped so a name written without it is
 * still caught: `bookclub-3.0` → `bookclub`. Deliberately narrow — it fires on digits
 * and on `old`, never on a second word, because `table-order` must not become `table`.
 */
const VERSION_SUFFIX = /[-_](?:v?\d[\d.]*|old)$/i;

export interface CustomerSource {
  /** Directory names found, lower-cased and de-duplicated. NEVER printed. */
  names: string[];
  /** Roots that existed. Empty means the audit is running blind. */
  rootsFound: string[];
  /** Roots probed but missing, so the report can say what it could not read. */
  rootsMissing: string[];
}

/**
 * Read customer names from the work-tree roots rather than from a literal list.
 *
 * The list cannot live in this repository: it is public, and an inventory of
 * customer names is precisely the thing being protected. So the audit is only as
 * complete as the machine it runs on — which is why `audit-repo.ts` prints the
 * COUNT it loaded and says loudly when it loaded none. A blind pass is not a pass.
 *
 * ONLY FULL DIRECTORY NAMES MATCH. The first version also added each name's stem
 * before the first `-`/`_`, so that a document writing `woongjin` would be caught
 * alongside `woongjin_thinkbig`. That turned a real account dir named `table-order`
 * into the pattern `table`, which hit **57 lines** of ordinary HTML and CSS on the
 * first run — the exact "audit that cries wolf gets silenced" failure the note on
 * `/Users/me/` above warns about, walked into within the hour. The stem was also
 * unnecessary: every account whose stem mattered (`armiq`, `woongjin`) already has a
 * bare directory of its own, so the full-name match covers it. Only a trailing
 * version segment is stripped.
 */
export function customerNames(): CustomerSource {
  const names = new Set<string>();
  const rootsFound: string[] = [];
  const rootsMissing: string[] = [];
  for (const root of ACCOUNT_ROOTS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      rootsMissing.push(root);
      continue;
    }
    rootsFound.push(root);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const n = e.name.toLowerCase();
      if (n.startsWith(".") || TOO_GENERIC.has(n) || n.length < 4) continue;
      names.add(n);
      const base = n.replace(VERSION_SUFFIX, "");
      if (base !== n && base.length >= 4 && !TOO_GENERIC.has(base)) names.add(base);
    }
  }
  return { names: [...names].sort(), rootsFound, rootsMissing };
}
