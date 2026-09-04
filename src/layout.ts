import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The one file in a source skill directory that is compiled rather than copied. */
export const TEMPLATE_FILENAME = "SKILL.md.tmpl";

export const STATE_DIR = ".composable-skills";
export const STAMP_FILENAME = "stamp";
export const LOG_FILENAME = "build.log";

/** Written beside every emitted `SKILL.md` to mark the directory as the compiler's to replace. */
export const OWNER_MARKER = ".composable-skills-owner";

/** The files the compiler writes itself. A source skill directory may not supply either. */
export const OUTPUT_FILENAME = "SKILL.md";
export const OWNED_OUTPUT_NAMES = [OUTPUT_FILENAME.toLowerCase(), OWNER_MARKER.toLowerCase()];

/**
 * Takes the root rather than a `Config` so this module depends on nothing else in `src/` — the
 * state layout is the same fact whether a build, a crash report or `init` is asking for it, and
 * only one of those has a `Config` to hand.
 */
export function stateDir(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR);
}

/**
 * The tool's own version is a stamp input: a build compiled by a different version must not be
 * reported fresh. It therefore lives with the other things the stamp is derived from, not in the
 * CLI, so that every route into `runBuild` — a hook, a test, a later verb — reads the same value
 * instead of each remembering to pass one.
 *
 * `..` from this module resolves to the package root in both layouts that ship: `src/layout.ts`
 * during development, and the bundled `dist/cli.js` this file is folded into for release.
 */
export function toolVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}
