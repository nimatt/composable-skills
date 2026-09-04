import fs from "node:fs";
import path from "node:path";

import type { Config, Diagnostic, Root, SlotBlock, SlotResolution, SourceLine } from "./types.ts";
import { describe, error } from "./types.ts";
import { loadConfig } from "./config.ts";
import { compileSkill, discoverSkills } from "./build.ts";
import { emitLines, emitReport } from "./report.ts";

export interface OverrideOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  skill: string;
  slot: string;
  /** Print the path and what would be seeded into it; write nothing. */
  dryRun?: boolean;
}

export function runOverride(options: OverrideOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? false;
  const loaded = loadConfig(cwd, options.env ?? process.env);
  if ("fatal" in loaded) {
    emitReport([error(loaded.fatal)], [], null);
    return 1;
  }

  const { config } = loaded;
  const diagnostics: Diagnostic[] = [...loaded.diagnostics];

  const discovery = discoverSkills(config);
  diagnostics.push(...discovery.diagnostics);
  const skill = discovery.skills.find((candidate) => candidate.name === options.skill);
  if (skill === undefined) {
    diagnostics.push(error(unknownSkillMessage(options.skill, discovery.skills.map((s) => s.name))));
    emitReport(diagnostics, [], null);
    return 1;
  }

  const result = compileSkill(skill, config);
  diagnostics.push(...result.diagnostics);
  if (result.compiled === null) {
    /**
     * The seed is the template's own text, so a template the compiler rejected is a text this verb
     * cannot vouch for — and the slot list it would list alternatives from may never have been
     * parsed at all. Refusing is the honest answer; the diagnostics above say what to fix.
     */
    diagnostics.push(
      error(`"${skill.name}" does not compile, so there is no current default to seed from`, {
        skill: skill.name,
        file: skill.templatePath,
      }),
    );
    emitReport(diagnostics, [], null);
    return 1;
  }

  const block = result.slots.find((candidate) => candidate.name === options.slot);
  if (block === undefined) {
    diagnostics.push(
      error(unknownSlotMessage(skill.name, options.slot, result.slots.map((s) => s.name)), {
        skill: skill.name,
        file: skill.templatePath,
      }),
    );
    emitReport(diagnostics, [], null);
    return 1;
  }

  /** The reverse scan makes the last usable entry the one that wins every slot it fills. */
  const root = config.overrides[config.overrides.length - 1];
  if (root === undefined) {
    diagnostics.push(error(noOverrideRootMessage(config)));
    emitReport(diagnostics, [], null);
    return 1;
  }

  const resolution = result.resolutions.find((candidate) => candidate.name === block.name);
  const target = path.join(root.path, skill.name, `${block.name}.md`);
  const lines: string[] = [];

  if (exists(target)) {
    lines.push(
      `${target}`,
      "",
      row("slot", `${block.name} (mode=${block.mode}) in skill "${skill.name}"`),
      row("resolves", describeResolution(resolution)),
      "",
      "This file already exists, so nothing was written — edit it in place.",
    );
    emitReport(diagnostics, [], null);
    emitLines(lines);
    return 0;
  }

  const seed = seedLines(block, resolution);
  if (!dryRun) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, seedText(seed), "utf8");
    } catch (cause) {
      diagnostics.push(error(`cannot write ${target}: ${describe(cause)}`, { skill: skill.name }));
      emitReport(diagnostics, [], null);
      return 1;
    }
  }

  lines.push(
    `${target}`,
    "",
    row("slot", `${block.name} (mode=${block.mode}) in skill "${skill.name}"`),
    row("root", `${root.spec} — the highest-precedence override root configured`),
    row("resolves", describeResolution(resolution)),
    row(dryRun ? "would seed" : "seeded", describeSeed(block, seed, resolution?.from ?? null)),
  );
  /**
   * The chain's highest entry is normally personal and outside the working tree, but
   * `${home}/repos/${id}` goes inert where the config declares no `id` — and then the file lands
   * in the repo, where git will offer it to the whole team. The only other signal is a config
   * warning that a *root* was skipped, which says nothing about where this file went.
   */
  if (insideRepo(config.repoRoot, root.path)) {
    lines.push(
      "",
      "  This root is inside the repo, so the file lands in the working tree and git will see it",
      "  unless it is ignored — an override committed from here is the whole team's, not yours.",
    );
    if (config.id === null) {
      lines.push(
        '  (The personal ${home}/repos/${id} root is inert until the config declares an "id".)',
      );
    }
  }
  if (block.mode === "append" && block.defaultBlock.length > 0) {
    lines.push("", "  The default this override will be appended to:", "");
    lines.push(...block.defaultBlock.map((line) => `      ${line.text}`));
  }
  lines.push(
    "",
    dryRun
      ? "Nothing was written. Re-run without --dry-run to create it."
      : "Edit it, then run `composable-skills build` (or start a new session) to compile it in.",
  );

  emitReport(diagnostics, [], null);
  emitLines(lines);
  return 0;
}

/** One value per row, so `would seed` lines up with `seeded` and every other label. */
function row(label: string, value: string): string {
  return `  ${label.padEnd(10)}  ${value}`;
}

/**
 * The seed is what the slot resolves to *today*, so a developer who edits nothing changes nothing:
 * writing into the highest-precedence root shadows whatever filled the slot before, and seeding
 * anything else would silently discard it. That is what defuses replace-by-default, and it holds
 * whether the text being shadowed is the template's default or a lower-precedence override — a
 * tracked root is how a repo fills a slot for everyone who builds there, so it is exactly the text
 * a developer must be made to edit rather than drop.
 *
 * `append` composes the default with the override, so only the override half belongs in the file:
 * seeding the default there would emit it twice. With nothing overriding the slot yet that half is
 * empty, which is why an `append` slot is normally created empty and its default printed instead.
 */
function seedLines(block: SlotBlock, resolution: SlotResolution | undefined): SourceLine[] {
  const override = resolution?.override ?? null;
  if (override !== null) return override;
  return block.mode === "append" ? [] : block.defaultBlock;
}

function seedText(seed: SourceLine[]): string {
  if (seed.length === 0) return "";
  return `${seed.map((line) => line.text).join("\n")}\n`;
}

function describeSeed(block: SlotBlock, seed: SourceLine[], from: Root | null): string {
  if (seed.length > 0) {
    const count = `${seed.length} line${seed.length === 1 ? "" : "s"}`;
    if (from === null) return `the template's current default (${count})`;
    if (block.mode === "append") {
      return `the text "${from.spec}" currently adds here (${count}) — mode=append re-adds it after the default`;
    }
    return `the text that currently resolves, from "${from.spec}" (${count})`;
  }
  /** Emptiness first: a slot with an empty default behaves identically under either mode. */
  if (block.defaultBlock.length === 0) {
    return "empty — the slot declares no default, so there is nothing to replace";
  }
  if (block.mode === "append") {
    return "empty — mode=append adds this file after the default, so seeding it would emit the default twice";
  }
  return `empty — "${from?.spec ?? "a lower-precedence root"}" currently fills this slot with nothing`;
}

/**
 * `explain` does not exist yet, so this is the only place a developer is told where a slot's text
 * comes from today — and it is the fact that decides whether they are about to shadow the team's
 * default or someone else's lower-precedence override.
 */
function describeResolution(resolution: SlotResolution | undefined): string {
  if (resolution === undefined || resolution.from === null) return "the template's default";
  return `the override root "${resolution.from.spec}" (${resolution.from.path})`;
}

function unknownSkillMessage(name: string, known: string[]): string {
  if (known.length === 0) {
    return `unknown skill "${name}" — no configured source root holds any skill`;
  }
  return `unknown skill "${name}" — this repo compiles: ${known.join(", ")}`;
}

function unknownSlotMessage(skill: string, slot: string, known: string[]): string {
  if (known.length === 0) {
    return `skill "${skill}" declares no slots at all, so "${slot}" cannot be overridden`;
  }
  return `skill "${skill}" declares no slot "${slot}" — it declares: ${known.join(", ")}`;
}

function noOverrideRootMessage(config: Config): string {
  const why =
    config.id === null
      ? ' (the default `${home}/repos/${id}` root is inert until the config declares an "id")'
      : "";
  return `no usable override root is configured, so there is nowhere to write${why}`;
}

/** Text-level containment, the same test `config.ts` applies to a `${home}` entry. */
function insideRepo(repoRoot: string, candidate: string): boolean {
  const relative = path.relative(repoRoot, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function exists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}
