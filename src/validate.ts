import fs from "node:fs";
import path from "node:path";

import type { Root } from "./types.ts";
import { LEFTOVER_RE } from "./directives.ts";
import { splitFrontmatter } from "./frontmatter.ts";

export interface Finding {
  message: string;
  line?: number;
  file?: string;
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7}|\|{7})([ \t]|$)/;

export function findConflictMarkers(text: string, file?: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (CONFLICT_MARKER_RE.test(lines[i]!)) {
      findings.push({ message: `merge-conflict marker "${lines[i]!.trim()}"`, line: i + 1, file });
    }
  }
  return findings;
}

export function findLeftoverDirectives(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (LEFTOVER_RE.test(lines[i]!)) {
      findings.push({ message: `directive syntax left in the output: ${lines[i]!.trim()}`, line: i + 1 });
    }
  }
  return findings;
}

const SLOT_ANYWHERE_RE = /<!--\s*\/?\s*slot\b/i;

export function findSlotsInFrontmatter(frontmatter: string): Finding[] {
  const findings: Finding[] = [];
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (SLOT_ANYWHERE_RE.test(lines[i]!)) {
      findings.push({ message: "a slot may not be declared in the frontmatter region", line: i + 1 });
    }
  }
  return findings;
}

export function checkFrontmatterIdentity(templateFrontmatter: string, output: string): Finding | null {
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
      findings.push({ message: `frontmatter field "${field}" is not supported by codex (${where})` });
    }
  }
  return findings;
}

export function findStrayOverrides(
  overrideRoots: Root[],
  skill: string,
  declaredSlots: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const root of overrideRoots) {
    const dir = path.join(root.path, skill);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
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
