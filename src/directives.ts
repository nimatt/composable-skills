import fs from "node:fs";
import path from "node:path";

import type { SlotBlock, SlotMode, SourceLine } from "./types.ts";
import { describe } from "./types.ts";
import { isUnder } from "./contain.ts";
import { isMissing } from "./discover.ts";
import { normaliseEol } from "./text.ts";

export type { LineOrigin, SourceLine } from "./types.ts";

export const SLOT_OPEN_RE = /^[ \t]*<!--[ \t]*slot:[ \t]*([^\s>]+)((?:[ \t][^>]*)?)-->[ \t]*$/;
export const SLOT_CLOSE_RE = /^[ \t]*<!--[ \t]*\/slot[ \t]*-->[ \t]*$/;
export const INCLUDE_RE = /^[ \t]*<!--[ \t]*include:[ \t]*([^\s>]+)[ \t]*-->[ \t]*$/;
export const LOOKALIKE_RE = /<!--\s*\/?\s*(slot|include|slots|includes|endslot|end-slot)\b/i;
export const LEFTOVER_RE = /<!--\s*\/?\s*(slot|include)\b/i;
export const SLOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface DirectiveError {
  message: string;
  line?: number;
}

export interface IncludedFragment {
  path: string;
  text: string;
}

export class LineWriter {
  readonly lines: SourceLine[] = [];
  private skipBlank = false;

  push(line: SourceLine): void {
    if (this.skipBlank) {
      this.skipBlank = false;
      if (line.text.trim() === "") return;
    }
    this.lines.push(line);
  }

  block(content: SourceLine[]): void {
    if (content.length > 0) {
      this.skipBlank = false;
      for (const line of content) this.lines.push(line);
      return;
    }
    const last = this.lines[this.lines.length - 1];
    if (this.lines.length === 0 || (last !== undefined && last.text.trim() === "")) {
      this.skipBlank = true;
    }
  }
}

/** Splits `text` into located lines and drops its blank edges, keeping each line's own number. */
export function trimBlockEdges(text: string, file: string | null): SourceLine[] {
  const lines = normaliseEol(text)
    .split("\n")
    .map((line, index): SourceLine => ({ text: line, origin: { file, line: index + 1 } }));
  return trimEdges(lines);
}

function trimEdges(lines: SourceLine[]): SourceLine[] {
  const isContent = (line: SourceLine): boolean => line.text.trim() !== "";
  const start = lines.findIndex(isContent);
  if (start === -1) return [];
  return lines.slice(start, lines.findLastIndex(isContent) + 1);
}

export interface IncludeResolution {
  path: string;
}

/**
 * `root`/`missing` mean the path is not there; `root-unreadable`/`unreadable` mean it is there and
 * this process cannot see it. Collapsing the two is what let a `chmod`'d override root revert a
 * slot to its template default with nothing said — the same distinction `discover.ts` draws
 * between an absent skill and one the build cannot look at.
 */
export type ContainmentFailure =
  | { kind: "root" }
  | { kind: "root-symlink" }
  | { kind: "root-unreadable"; cause: unknown }
  | { kind: "missing"; part: string }
  | { kind: "unreadable"; part: string; cause: unknown }
  | { kind: "symlink"; part: string }
  | { kind: "outside" }
  | { kind: "not-file" };

function rootFailure(cause: unknown): ContainmentFailure {
  return isMissing(cause) ? { kind: "root" } : { kind: "root-unreadable", cause };
}

function partFailure(cause: unknown, part: string): ContainmentFailure {
  return isMissing(cause) ? { kind: "missing", part } : { kind: "unreadable", part, cause };
}

export type ContainedFile = { path: string } | { failure: ContainmentFailure };

export interface ContainmentOptions {
  /**
   * Refuse a root whose own last component is a symlink. Containment is asserted against the
   * *resolved* root, so `ln -s <outside> <root>` otherwise reads outside it cleanly and the
   * config's `${home}` check — which runs on unresolved path text — does not see it either.
   * Off for source roots, where a symlinked package directory is ordinary (pnpm, workspaces).
   */
  rejectSymlinkedRoot?: boolean;
}

/**
 * Resolve `<root>/<...parts>` under the containment discipline the spec requires of every path
 * the compiler reads: the root is `realpath`'d once, every component is `lstat`'d with any
 * symlink hop refused, the result is asserted contained, and only a regular file is accepted.
 */
export function resolveContainedFile(
  root: string,
  parts: string[],
  options: ContainmentOptions = {},
): ContainedFile {
  const last = parts[parts.length - 1] ?? "";

  if (options.rejectSymlinkedRoot === true) {
    let rootStats: fs.Stats;
    try {
      rootStats = fs.lstatSync(root);
    } catch (cause) {
      return { failure: rootFailure(cause) };
    }
    if (rootStats.isSymbolicLink()) return { failure: { kind: "root-symlink" } };
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch (cause) {
    return { failure: rootFailure(cause) };
  }

  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (cause) {
      return { failure: partFailure(cause, part) };
    }
    if (stats.isSymbolicLink()) return { failure: { kind: "symlink", part } };
  }

  let real: string;
  try {
    real = fs.realpathSync(current);
  } catch (cause) {
    return { failure: partFailure(cause, last) };
  }
  if (!isUnder(realRoot, real)) return { failure: { kind: "outside" } };

  let stats: fs.Stats;
  try {
    stats = fs.statSync(real);
  } catch (cause) {
    return { failure: partFailure(cause, last) };
  }
  if (!stats.isFile()) return { failure: { kind: "not-file" } };
  return { path: real };
}

export function resolveIncludePath(
  spec: string,
  sourceRoot: string,
): IncludeResolution | DirectiveError {
  if (spec.trim() === "") return { message: "include: has an empty path" };
  if (
    path.isAbsolute(spec) ||
    /^[A-Za-z]:/.test(spec) ||
    spec.startsWith("\\") ||
    spec.startsWith("/")
  ) {
    return { message: `include: "${spec}" is an absolute path` };
  }
  const parts = spec.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return { message: `include: "${spec}" names no file` };
  if (parts.includes(".."))
    return { message: `include: "${spec}" escapes its source root with ".."` };

  const resolved = resolveContainedFile(sourceRoot, parts);
  if (!("failure" in resolved)) return { path: resolved.path };

  const failure = resolved.failure;
  switch (failure.kind) {
    case "root":
      return {
        message: `include: "${spec}" cannot be resolved — source root ${sourceRoot} does not exist`,
      };
    case "root-unreadable":
      return {
        message: `include: "${spec}" cannot be resolved — source root ${sourceRoot} cannot be read: ${describe(failure.cause)}`,
      };
    case "unreadable":
      return { message: `include: "${spec}" cannot be read: ${describe(failure.cause)}` };
    case "symlink":
      return { message: `include: "${spec}" traverses a symlink at ${failure.part}` };
    case "outside":
      return { message: `include: "${spec}" resolves outside its source root` };
    case "not-file":
      return { message: `include: "${spec}" is not a file` };
    default:
      return { message: `include: "${spec}" not found under ${sourceRoot}` };
  }
}

export interface IncludeExpansion {
  lines: SourceLine[];
  fragments: IncludedFragment[];
  errors: DirectiveError[];
}

/**
 * Splices each fragment into the body — one level, as the spec describes it. A fragment's own
 * `<!-- include: -->` line is copied through unexpanded, where the leftover-directive check
 * rejects the skill by name and line. Splicing shifts every line after it, so each line carries
 * the file and line number it actually came from: that is what lets a diagnostic name a line
 * that exists in the file it names.
 */
export function expandIncludes(lines: string[], sourceRoot: string): IncludeExpansion {
  const fragments: IncludedFragment[] = [];
  const errors: DirectiveError[] = [];
  const writer = new LineWriter();

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const spec = INCLUDE_RE.exec(line)?.[1];
    if (spec === undefined) {
      writer.push({ text: line, origin: { file: null, line: lineNumber } });
      continue;
    }
    const resolved = resolveIncludePath(spec, sourceRoot);
    if ("message" in resolved) {
      errors.push({ message: resolved.message, line: lineNumber });
      continue;
    }
    let text: string;
    try {
      text = normaliseEol(fs.readFileSync(resolved.path, "utf8"));
    } catch {
      errors.push({ message: `include: "${spec}" could not be read`, line: lineNumber });
      continue;
    }
    fragments.push({ path: resolved.path, text });
    writer.block(trimBlockEdges(text, resolved.path));
  }

  return { lines: writer.lines, fragments, errors };
}

export interface SlotParse {
  blocks: SlotBlock[];
  errors: DirectiveError[];
}

export function parseSlotOpen(line: string): { name: string; mode: SlotMode } | DirectiveError {
  const match = SLOT_OPEN_RE.exec(line);
  if (match === null) return { message: `malformed slot directive: ${line.trim()}` };
  const [, name = "", attributes = ""] = match;
  const rest = attributes.trim();
  if (!SLOT_NAME_RE.test(name)) {
    return { message: `invalid slot name "${name}" — use letters, digits, "-", "_" or "."` };
  }
  if (rest === "") return { name, mode: "replace" };
  const attribute = /^mode=(replace|append)$/.exec(rest);
  if (attribute === null) {
    return {
      message: `unknown slot attribute "${rest}" on slot "${name}" — only mode=replace|append is defined`,
    };
  }
  return { name, mode: attribute[1] as SlotMode };
}

export function parseSlots(lines: SourceLine[]): SlotParse {
  const blocks: SlotBlock[] = [];
  const errors: DirectiveError[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    // biome-ignore lint/style/noNonNullAssertion: the cursor jumps a whole slot block, not one line
    const line = lines[i]!.text;
    if (SLOT_OPEN_RE.test(line)) {
      const parsed = parseSlotOpen(line);
      if ("message" in parsed) {
        errors.push({ message: parsed.message, line: i + 1 });
        i++;
        continue;
      }
      if (seen.has(parsed.name)) {
        errors.push({ message: `duplicate slot name "${parsed.name}"`, line: i + 1 });
      }
      seen.add(parsed.name);

      let end = i;
      let defaultBlock: SourceLine[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        // biome-ignore lint/style/noNonNullAssertion: `j` starts at `i + 1` and indexes `lines`
        const candidate = lines[j]!.text;
        if (SLOT_CLOSE_RE.test(candidate)) {
          end = j;
          defaultBlock = trimEdges(lines.slice(i + 1, j));
          break;
        }
        if (SLOT_OPEN_RE.test(candidate)) break;
      }
      blocks.push({ name: parsed.name, mode: parsed.mode, defaultBlock, start: i, end });
      i = end + 1;
      continue;
    }
    if (SLOT_CLOSE_RE.test(line)) {
      errors.push({ message: "stray <!-- /slot --> closing no slot", line: i + 1 });
      i++;
      continue;
    }
    if (LOOKALIKE_RE.test(line) && !INCLUDE_RE.test(line)) {
      errors.push({ message: `unknown or malformed directive: ${line.trim()}`, line: i + 1 });
      i++;
      continue;
    }
    i++;
  }

  return { blocks, errors };
}

export function renderSlots(
  lines: SourceLine[],
  blocks: SlotBlock[],
  resolve: (block: SlotBlock) => SourceLine[],
): SourceLine[] {
  const byStart = new Map<number, SlotBlock>();
  for (const block of blocks) byStart.set(block.start, block);

  const writer = new LineWriter();
  let i = 0;
  while (i < lines.length) {
    const block = byStart.get(i);
    if (block === undefined) {
      // biome-ignore lint/style/noNonNullAssertion: the cursor jumps a whole slot block, not one line
      writer.push(lines[i]!);
      i++;
      continue;
    }
    writer.block(resolve(block));
    i = block.end + 1;
  }
  return writer.lines;
}
