import fs from "node:fs";
import path from "node:path";

import type { Root, Severity } from "./types.ts";
import { resolveContainedFile } from "./contain.ts";
import { LEFTOVER_RE } from "./directives.ts";
import { splitFrontmatter } from "./frontmatter.ts";

export interface Finding {
  message: string;
  line?: number;
  file?: string;
  /**
   * Absent where the finding is unconditionally fatal, which is all but one of them — the callers
   * that turn findings into diagnostics read it only to demote the one kind that is not.
   */
  severity?: Severity;
}

/**
 * A conflict always opens with `<<<<<<<`, and `|||||||` is diff3's base marker. Neither line
 * spells anything in Markdown, so either one is a marker wherever it appears.
 */
const CONFLICT_OPENING_RE = /^<{7}([ \t]|$)/;
const CONFLICT_BASE_RE = /^\|{7}([ \t]|$)/;

/**
 * The separator and closing lines, which ordinary Markdown does spell: a setext H1 underlined
 * with exactly seven `=`, and a seven-deep blockquote such as `>>>>>>> deeply quoted`.
 */
const CONFLICT_TAIL_RE = /^(={7}|>{7})([ \t]|$)/;

/**
 * Git writes an opening line above every separator and closing line, and this scan runs per file
 * — on a whole template, a whole fragment, a whole override — so for a conflict git itself left
 * behind, the opening is always in the same text. A tail with no opening above it is therefore
 * either legal Markdown or a hand-resolved conflict: the "accept theirs" mistake, where the author
 * deleted from `<<<<<<<` through `=======` and forgot the trailing `>>>>>>>`.
 *
 * Reading those two apart is not possible from the line alone, so the severity splits the
 * difference rather than the detection: fatal where an opening was seen, a warning where none was.
 * The trade that buys — a setext H1 under exactly seven `=` now draws a warning it does not
 * deserve — is the right way round, because the two costs are not comparable. The warning costs
 * its author one line of noise on a build that still succeeds and still emits the heading. Saying
 * nothing costs the other author a conflict marker shipped silently into the model's instructions,
 * which is the one thing the contract promises never happens unremarked. Nine `=` or six, or any
 * underline of a heading longer than seven characters, says nothing at all.
 *
 * What the warning says about the consequence is conditional because the scan cannot know it: it
 * runs per file and before slots resolve, so a warned line sitting in a slot default that an
 * override goes on to replace never reaches the emitted skill at all.
 */
function unopenedMarkerMessage(line: string): string {
  return (
    `merge-conflict marker "${line.trim()}" with no "<<<<<<<" line opening it: if this is a setext ` +
    "heading underline or a deep blockquote, nothing is wrong and the build was not broken — it " +
    "compiled as written. If a conflict here was resolved by hand, this line is what the " +
    "resolution left behind, and it reaches the emitted skill unless an override replaces the " +
    "block it sits in."
  );
}

export function findConflictMarkers(text: string, file?: string): Finding[] {
  const findings: Finding[] = [];
  let opened = false;
  for (const [index, line] of text.split("\n").entries()) {
    const at = { line: index + 1, file };
    const marker: Finding = { message: `merge-conflict marker "${line.trim()}"`, ...at };
    if (CONFLICT_OPENING_RE.test(line)) {
      opened = true;
      findings.push(marker);
    } else if (CONFLICT_BASE_RE.test(line)) {
      findings.push(marker);
    } else if (CONFLICT_TAIL_RE.test(line)) {
      findings.push(
        opened ? marker : { severity: "warning", message: unopenedMarkerMessage(line), ...at },
      );
    }
  }
  return findings;
}

export function findLeftoverDirectives(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (LEFTOVER_RE.test(line)) {
      findings.push({
        message: `directive syntax left in the output: ${line.trim()}`,
        line: index + 1,
      });
    }
  }
  return findings;
}

const SLOT_ANYWHERE_RE = /<!--\s*\/?\s*slot\b/i;

export function findSlotsInFrontmatter(frontmatter: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of frontmatter.split("\n").entries()) {
    if (SLOT_ANYWHERE_RE.test(line)) {
      findings.push({
        message: "a slot may not be declared in the frontmatter region",
        line: index + 1,
      });
    }
  }
  return findings;
}

export function checkFrontmatterIdentity(
  templateFrontmatter: string,
  output: string,
): Finding | null {
  const split = splitFrontmatter(output);
  if (!split.ok) return { message: `emitted frontmatter is malformed: ${split.message}` };
  if (split.frontmatter !== templateFrontmatter) {
    return { message: "emitted frontmatter is not byte-identical to the template's" };
  }
  return null;
}

const CODEX_FIELDS = ["name", "description"];

const SPEC_SEPARATOR_RE = path.sep === "\\" ? /[\\/]+/ : /\/+/;

/**
 * Classified from the directory the config names, never from the resolved absolute path: a repo
 * checked out beneath a directory called `.agents` — a worktree under `.claude/worktrees/` is the
 * mirror case — still writes claude skills to its own `./.claude/skills`.
 */
export function targetsCodex(target: Root): boolean {
  const segments = target.spec.split(SPEC_SEPARATOR_RE);
  if (segments.includes(".claude")) return false;
  return segments.includes(".agents") || segments.includes(".codex");
}

export function findUnsupportedFields(fields: string[], targets: Root[]): Finding[] {
  const codexTargets = targets.filter(targetsCodex);
  if (codexTargets.length === 0) return [];

  const where = codexTargets.map((target) => target.spec).join(", ");
  const findings: Finding[] = [];
  for (const field of fields) {
    if (!CODEX_FIELDS.includes(field)) {
      findings.push({
        message: `frontmatter field "${field}" is not supported by codex (${where})`,
      });
    }
  }
  return findings;
}

/**
 * Enumerated through the same containment check `resolveSlot` reads a slot with, not with a bare
 * `readdir` of the joined path: for a symlinked override root the two otherwise disagree about
 * the same tree, one warning that a file matches no declared slot and the other refusing to read
 * anything under that root at all. Advice about a file the build will not read is worse than no
 * advice. The reported path stays the unresolved one, which is the path the developer configured.
 */
export function findStrayOverrides(
  overrideRoots: Root[],
  skill: string,
  declaredSlots: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const root of overrideRoots) {
    const dir = path.join(root.path, skill);
    const contained = resolveContainedFile(root.path, [skill], {
      rejectSymlinkedRoot: true,
      expect: "directory",
    });
    if ("failure" in contained) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(contained.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const slot = entry.name.slice(0, -3);
      if (!declaredSlots.has(slot)) {
        findings.push({
          message: `override file matches no declared slot "${slot}" in skill "${skill}"`,
          file: path.join(dir, entry.name),
        });
      }
    }
  }
  return findings;
}
