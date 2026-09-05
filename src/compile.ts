import fs from "node:fs";
import path from "node:path";

import type {
  CompiledSkill,
  Config,
  Diagnostic,
  DiagnosticLocation,
  DiscoveredSkill,
  ExtraFile,
  Root,
  SlotBlock,
  SlotResolution,
} from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { OWNED_OUTPUT_NAMES, TEMPLATE_FILENAME } from "./layout.ts";
import { normaliseEol } from "./text.ts";
import { frontmatterFields, splitFrontmatter } from "./frontmatter.ts";
import type { ContainmentFailure } from "./contain.ts";
import { resolveContainedFile } from "./contain.ts";
import type { LineOrigin, SourceLine } from "./directives.ts";
import { expandIncludes, parseSlots, renderSlots, trimBlockEdges } from "./directives.ts";
import {
  checkFrontmatterIdentity,
  findConflictMarkers,
  findLeftoverDirectives,
  findSlotsInFrontmatter,
  findStrayOverrides,
  findUnsupportedFields,
} from "./validate.ts";

export interface CompileResult {
  compiled: CompiledSkill | null;
  diagnostics: Diagnostic[];
  /** The slots the template declared, and what each one resolved to. Reporting only. */
  slots: SlotBlock[];
  resolutions: SlotResolution[];
}

export function compileSkill(skill: DiscoveredSkill, config: Config): CompileResult {
  const diagnostics: Diagnostic[] = [];
  let slots: SlotBlock[] = [];
  const resolutions: SlotResolution[] = [];
  const abort = (): CompileResult => ({ compiled: null, diagnostics, slots, resolutions });
  const fail = (message: string, extra: DiagnosticLocation = {}) => {
    diagnostics.push(error(message, { skill: skill.name, file: skill.templatePath, ...extra }));
  };

  let raw: string;
  try {
    raw = normaliseEol(fs.readFileSync(skill.templatePath, "utf8"));
  } catch (cause) {
    fail(`cannot read template: ${describe(cause)}`);
    return abort();
  }

  for (const finding of findConflictMarkers(raw)) {
    fail(finding.message, { line: finding.line });
  }

  const split = splitFrontmatter(raw);
  if (!split.ok) {
    fail(split.message);
    return abort();
  }

  for (const finding of findSlotsInFrontmatter(split.frontmatter)) {
    fail(finding.message, { line: finding.line });
  }

  const bodyOffset = split.bodyOffset;
  const included = expandIncludes(split.body.split("\n"), skill.sourceRoot);
  for (const finding of included.errors) {
    fail(finding.message, {
      line: finding.line === undefined ? undefined : finding.line + bodyOffset,
    });
  }
  for (const fragment of included.fragments) {
    for (const finding of findConflictMarkers(fragment.text, fragment.path)) {
      fail(finding.message, { file: fragment.path, line: finding.line });
    }
  }

  /**
   * A diagnostic found in the expanded body is numbered in the expanded body's coordinates, which
   * are nobody's file. Every line knows where it came from, so the diagnostic names that file and
   * a line number that exists in it — the template's own lines counted from the top of the file,
   * not from the top of the body.
   */
  const attribute = (origin: LineOrigin | null | undefined): DiagnosticLocation => {
    if (origin === undefined || origin === null) return {};
    if (origin.file === null) return { line: origin.line + bodyOffset };
    return { file: origin.file, line: origin.line };
  };
  const inBody = (lines: SourceLine[], line: number | undefined): DiagnosticLocation =>
    line === undefined ? {} : attribute(lines[line - 1]?.origin);

  const parsed = parseSlots(included.lines);
  slots = parsed.blocks;
  for (const finding of parsed.errors) {
    fail(finding.message, inBody(included.lines, finding.line));
  }

  const declared = new Set(parsed.blocks.map((block) => block.name));
  for (const finding of findStrayOverrides(config.overrides, skill.name, declared)) {
    diagnostics.push(warning(finding.message, { skill: skill.name, file: finding.file }));
  }
  for (const finding of findUnsupportedFields(
    frontmatterFields(split.frontmatter),
    config.targets,
  )) {
    diagnostics.push(warning(finding.message, { skill: skill.name, file: skill.templatePath }));
  }

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return abort();
  }

  const rendered = renderSlots(included.lines, parsed.blocks, (block) => {
    const resolved = resolveSlot(block, skill.name, config, diagnostics);
    resolutions.push({
      name: block.name,
      mode: block.mode,
      from: resolved.from,
      override: resolved.override,
    });
    return resolved.lines;
  });
  const body = `${rendered
    .map((line) => line.text)
    .join("\n")
    .trimEnd()}\n`;
  const content = `${split.frontmatter}${body}`;

  /** The scan runs on the output, whose first `bodyOffset` lines are the template's frontmatter. */
  const inOutput = (line: number | undefined): DiagnosticLocation => {
    if (line === undefined) return {};
    if (line <= bodyOffset) return { line };
    return inBody(rendered, line - bodyOffset);
  };

  for (const finding of findLeftoverDirectives(content)) {
    fail(finding.message, inOutput(finding.line));
  }
  const identity = checkFrontmatterIdentity(split.frontmatter, content);
  if (identity !== null) fail(identity.message);

  if (diagnostics.some((entry) => entry.severity === "error")) {
    return abort();
  }

  const extras = collectExtras(skill, diagnostics);
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return abort();
  }

  return { compiled: { name: skill.name, content, extras }, diagnostics, slots, resolutions };
}

/**
 * A slot's resolved text, and the override root that produced it. The root is the only thing this
 * computation knows that nothing else can cheaply recover, and both `override` and `explain` need
 * it — so it is returned rather than discarded.
 */
export interface ResolvedSlot {
  lines: SourceLine[];
  /** Null where the template's own default won, including where a containment error fell back. */
  from: Root | null;
  /**
   * The winning override file's own lines, kept apart from `lines` because `append` composes the
   * two and only this half is a slot's override text. Null where no override root filled the slot.
   */
  override: SourceLine[] | null;
}

export function resolveSlot(
  block: SlotBlock,
  skillName: string,
  config: Config,
  diagnostics: Diagnostic[],
): ResolvedSlot {
  const fromDefault = (): ResolvedSlot => ({
    lines: block.defaultBlock,
    from: null,
    override: null,
  });

  let override: SourceLine[] | null = null;
  let from: Root | null = null;
  for (const root of config.overrides.toReversed()) {
    const file = path.join(root.path, skillName, `${block.name}.md`);

    const resolved = resolveContainedFile(root.path, [skillName, `${block.name}.md`], {
      rejectSymlinkedRoot: true,
    });
    if ("failure" in resolved) {
      const failure = resolved.failure;
      if (failure.kind === "root" || failure.kind === "missing") continue;
      if (failure.kind === "root-unreadable" || failure.kind === "unreadable") {
        diagnostics.push(
          warning(unreadableOverrideMessage(failure, root.path), { skill: skillName, file }),
        );
        // `continue`, not `fromDefault()`: a root this build cannot look into says nothing about
        // what the roots below it hold, and abandoning them would silently swap a lower root's
        // override for the template default on the strength of a `chmod` somewhere above it.
        continue;
      }
      diagnostics.push(
        error(overrideContainmentMessage(failure, root.path), { skill: skillName, file }),
      );
      return fromDefault();
    }

    let text: string;
    try {
      text = normaliseEol(fs.readFileSync(resolved.path, "utf8"));
    } catch (cause) {
      diagnostics.push(
        warning(`cannot read override: ${describe(cause)}`, { skill: skillName, file }),
      );
      continue;
    }

    const conflicts = findConflictMarkers(text, file);
    if (conflicts.length > 0) {
      for (const finding of conflicts) {
        diagnostics.push(error(finding.message, { skill: skillName, file, line: finding.line }));
      }
      return fromDefault();
    }

    override = trimBlockEdges(text, file);
    from = root;
    break;
  }

  if (override === null) return fromDefault();
  if (block.mode === "replace") return { lines: override, from, override };
  if (block.defaultBlock.length === 0) return { lines: override, from, override };
  // An empty append override adds nothing, but the root still won the slot — `explain` must be
  // able to say so, and a `replace` slot filled from an empty file reports the same way.
  if (override.length === 0) return { lines: block.defaultBlock, from, override };
  return {
    lines: [...block.defaultBlock, { text: "", origin: null }, ...override],
    from,
    override,
  };
}

function unreadableOverrideMessage(
  failure: Extract<ContainmentFailure, { kind: "root-unreadable" } | { kind: "unreadable" }>,
  root: string,
): string {
  if (failure.kind === "root-unreadable") {
    return `cannot read override root ${root}: ${describe(failure.cause)}`;
  }
  return `cannot read override: ${describe(failure.cause)}`;
}

function overrideContainmentMessage(
  failure: Exclude<
    ContainmentFailure,
    { kind: "root" } | { kind: "missing" } | { kind: "root-unreadable" } | { kind: "unreadable" }
  >,
  root: string,
): string {
  switch (failure.kind) {
    case "root-symlink":
      return `override root ${root} is itself a symlink — containment is asserted against the resolved root, so overrides are not read through it; point the entry at a real directory`;
    case "symlink":
      return `override traverses a symlink at "${failure.part}" — refusing to splice a file from outside ${root}`;
    case "outside":
      return `override resolves outside its override root ${root}`;
    case "not-file":
    case "not-directory":
      return `override is not a regular file`;
  }
}

function collectExtras(skill: DiscoveredSkill, diagnostics: Diagnostic[]): ExtraFile[] {
  const extras: ExtraFile[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (cause) {
      diagnostics.push(warning(`cannot read ${dir}: ${describe(cause)}`, { skill: skill.name }));
      return;
    }
    for (const entry of entries) {
      const from = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        diagnostics.push(warning(`symlink not copied: ${rel}`, { skill: skill.name, file: from }));
        continue;
      }
      if (prefix === "" && OWNED_OUTPUT_NAMES.includes(entry.name.toLowerCase())) {
        diagnostics.push(
          error(
            `"${entry.name}" in the source skill directory would overwrite what the compiler ` +
              `writes — remove it; the template is ${TEMPLATE_FILENAME}`,
            { skill: skill.name, file: from },
          ),
        );
        continue;
      }
      if (entry.isDirectory()) {
        walk(from, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (prefix === "" && entry.name === TEMPLATE_FILENAME) continue;
      extras.push({ from, rel });
    }
  };
  walk(skill.dir, "");
  return extras;
}
