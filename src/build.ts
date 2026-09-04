import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  CompiledSkill,
  Config,
  Diagnostic,
  DiscoveredSkill,
  ExtraFile,
  Root,
  SlotBlock,
  SlotResolution,
} from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { loadConfig } from "./config.ts";
import {
  OWNER_MARKER,
  STAMP_FILENAME,
  TEMPLATE_FILENAME,
  stateDir,
  toolVersion,
} from "./layout.ts";
import { normaliseEol, normaliseEolBytes } from "./text.ts";
import { frontmatterFields, splitFrontmatter } from "./frontmatter.ts";
import type { ContainmentFailure, LineOrigin, SourceLine } from "./directives.ts";
import {
  expandIncludes,
  parseSlots,
  renderSlots,
  resolveContainedFile,
  trimBlockEdges,
} from "./directives.ts";
import { crashStateDir, emitReport } from "./report.ts";
import {
  checkFrontmatterIdentity,
  findConflictMarkers,
  findLeftoverDirectives,
  findSlotsInFrontmatter,
  findStrayOverrides,
  findUnsupportedFields,
} from "./validate.ts";

const TMP_PREFIX = ".composable-skills-tmp-";
const OLD_PREFIX = ".composable-skills-old-";

/** The files the compiler writes itself. A source skill directory may not supply either. */
const OUTPUT_FILENAME = "SKILL.md";
const OWNED_OUTPUT_NAMES = [OUTPUT_FILENAME.toLowerCase(), OWNER_MARKER.toLowerCase()];

const LOCK_DIRNAME = "lock";
const LOCK_INFO_FILENAME = "info.json";
/** A build that has held the lock this long is assumed dead; the machine reboots mid-build too. */
const LOCK_STALE_MS = 5 * 60 * 1000;
/** Scratch directories younger than this may belong to a build running right now. */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

export interface BuildOptions {
  cwd?: string;
  check?: boolean;
  /** Overrides the tool's own version in the stamp. For tests; a real run reads it itself. */
  version?: string;
  env?: NodeJS.ProcessEnv;
}

export function runBuild(options: BuildOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const check = options.check ?? false;
  const loaded = loadConfig(cwd, options.env ?? process.env);

  if ("fatal" in loaded) {
    /**
     * The three-channel rule has exactly two documented exceptions — `--check` and an interactive
     * terminal — and a fatal config error is neither. It is also the likeliest real failure, in
     * the context the file channel exists for, so it gets the log like everything else.
     */
    let fatalLogDir: string | null = null;
    if (!check) {
      try {
        fatalLogDir = crashStateDir(cwd);
      } catch {
        fatalLogDir = null;
      }
    }
    emitReport([error(loaded.fatal)], [], fatalLogDir);
    return check ? 1 : 0;
  }

  const { config } = loaded;
  /** `--check` writes nothing, and that includes the log file. */
  const logDir = check ? null : stateDir(config.repoRoot);
  const discovery = discoverSkills(config);
  /** Recomputed every run, so a gated run must not replay them from the stamp as well. */
  const live: Diagnostic[] = [...loaded.diagnostics, ...discovery.diagnostics];
  const skills = discovery.skills;

  const stamp = computeStamp(config, options.version ?? toolVersion());
  const stored = readStamp(config);
  const fresh = stored !== null && stored.stamp === stamp && outputsVerified(config, skills, stored);

  if (check) {
    if (!fresh) {
      emitReport(
        [...live, error("compiled output is stale — run `composable-skills build`")],
        [],
        logDir,
      );
      return 1;
    }
    const replayed = [...live, ...asReplayed(stored!.diagnostics)];
    // A live error is an error the next real build would hit too, so it fails `--check` exactly
    // as a replayed one does. Only the replayed half is recorded in the stamp.
    const broken = replayed.some((entry) => entry.severity === "error");
    emitReport(replayed, broken ? [] : ["compiled output is up to date"], logDir);
    return broken ? 1 : 0;
  }

  if (fresh) {
    emitReport([...live, ...asReplayed(stored!.diagnostics)], [], logDir);
    return 0;
  }

  const diagnostics: Diagnostic[] = [];
  const lock = acquireBuildLock(config);
  if (lock.kind === "busy") {
    // Nothing was compiled, so the last real build's diagnostics are still the truth about this
    // tree — dropping them would hide a permanently broken template for as long as the lock holds.
    const replayed = stored === null ? [] : asReplayed(stored.diagnostics);
    emitReport([...live, ...replayed, warning(lock.message)], [], logDir);
    return 0;
  }
  if (lock.kind === "unavailable") diagnostics.push(warning(lock.message));

  /**
   * Read before anything writes, because `emitSkill` creates the target itself. A target that was
   * not there when the session started is the fresh-clone case ADR-0001 records: the harness does
   * not watch a skills directory that appeared mid-session, so this build's output is on disk and
   * invisible until the next one, with no error and no signal. `build` runs at `SessionStart` and
   * its stdout reaches the model, which makes it the only channel that reaches the person who
   * cloned — the advice `init` prints reaches the maintainer who ran it, once.
   */
  const absentTargets = config.targets.filter((target) => !pathExists(target.path));

  let built = 0;
  const failed: string[] = [];
  const outputs: Record<string, string | null> = {};
  let pruned = 0;
  try {
    for (const skill of skills) {
      /** A skill that fails keeps its previous output, so its previous hash stays the truth. */
      const carried = stored?.outputs[skill.name] ?? null;
      try {
        const result = compileSkill(skill, config);
        diagnostics.push(...result.diagnostics);
        if (result.compiled === null) {
          failed.push(skill.name);
          outputs[skill.name] = carried;
          continue;
        }
        let written = false;
        for (const target of config.targets) {
          if (emitSkill(target, result.compiled, config, diagnostics)) written = true;
        }
        outputs[skill.name] = written ? hashContent(result.compiled.content) : carried;
        if (written) built++;
      } catch (cause) {
        failed.push(skill.name);
        outputs[skill.name] = carried;
        diagnostics.push(
          error(`skill failed unexpectedly: ${describe(cause)}`, {
            skill: skill.name,
            file: skill.templatePath,
          }),
        );
      }
    }

    const keep = new Set(skills.map((skill) => skill.name));
    if (!discovery.complete) {
      diagnostics.push(
        warning("a configured source root could not be read in full — nothing was pruned this run"),
      );
    } else {
      const orphaned = previouslyCompiled(stored).filter((name) => !keep.has(name));
      /**
       * An empty corpus and a config that lost its `sources` key look identical from here, and
       * one of them means deleting every compiled skill. The last stamp tells them apart: a
       * corpus that was genuinely emptied one template at a time never reaches zero *roots*.
       */
      if (config.sources.length === 0 && orphaned.length > 0) {
        diagnostics.push(
          warning(
            `no usable source roots, but the last build compiled ${orphaned.length} skill(s) ` +
              `(${orphaned.join(", ")}) — refusing to prune; check the "sources" key`,
          ),
        );
      } else {
        for (const target of config.targets) {
          pruned += pruneTarget(target, keep, config, diagnostics);
        }
      }
    }

    writeStamp(config, { stamp, failed, outputs, diagnostics });
  } finally {
    if (lock.kind === "held") lock.release();
  }

  const summary: string[] = [];
  const targetWord = config.targets.length === 1 ? "target" : "targets";
  const parts = [`${built} skill${built === 1 ? "" : "s"} → ${config.targets.length} ${targetWord}`];
  if (failed.length > 0) parts.push(`${failed.length} kept previous output`);
  if (pruned > 0) parts.push(`${pruned} pruned`);
  summary.push(parts.join(", "));

  const created = absentTargets.filter((target) => pathExists(target.path));
  if (built > 0 && created.length > 0) {
    summary.push(
      `${created.map((target) => target.spec).join(", ")} did not exist before this build — a ` +
        `skills directory that was not there when the session started is not picked up, so these ` +
        `skills become available in the next session`,
    );
  }
  emitReport([...live, ...diagnostics], summary, logDir);

  return 0;
}

export interface Discovery {
  skills: DiscoveredSkill[];
  diagnostics: Diagnostic[];
  /**
   * True only when every configured source root resolved *and* was enumerated end to end.
   * Prune eligibility hangs on this: a root the build could not read is indistinguishable from
   * a root whose skills were all deleted upstream.
   */
  complete: boolean;
}

export function discoverSkills(config: Config): Discovery {
  const diagnostics: Diagnostic[] = [];
  const bySkill = new Map<string, DiscoveredSkill>();
  let complete = !config.sourcesIncomplete;

  for (const root of config.sources) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch (cause) {
      diagnostics.push(warning(`cannot read source root ${root.path}: ${describe(cause)}`));
      complete = false;
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const dir = path.join(root.path, entry.name);
      /**
       * `isDirectory()` is false for a symlink dirent, so a symlinked skill directory is
       * invisible to discovery while being perfectly readable — and its compiled output would be
       * pruned as a skill that no longer exists. Refused, because following it would read a
       * template from outside every configured source root, but never silently.
       */
      if (entry.isSymbolicLink()) {
        if (probeFile(path.join(dir, TEMPLATE_FILENAME)) === "file" || looksLikeSkill(dir) === "yes") {
          diagnostics.push(
            warning(`skill directory is a symlink — not followed`, { skill: entry.name, file: dir }),
          );
          complete = false;
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      const templatePath = path.join(dir, TEMPLATE_FILENAME);
      const template = probeFile(templatePath);
      if (template === "unreadable") {
        diagnostics.push(
          warning(`cannot read ${templatePath}: permission or I/O error — skipped`, {
            skill: entry.name,
            file: dir,
          }),
        );
        complete = false;
        continue;
      }
      if (template !== "file") {
        const probe = looksLikeSkill(dir);
        if (probe === "yes") {
          diagnostics.push(
            warning(`no ${TEMPLATE_FILENAME} — skipped`, { skill: entry.name, file: dir }),
          );
        } else if (probe === "unreadable") {
          diagnostics.push(
            warning(`cannot read ${dir}: permission or I/O error — skipped`, { skill: entry.name }),
          );
          complete = false;
        }
        continue;
      }
      if (bySkill.has(entry.name)) {
        diagnostics.push(
          warning(`skill name collides across sources — "${root.spec}" wins`, { skill: entry.name }),
        );
      }
      bySkill.set(entry.name, {
        name: entry.name,
        dir,
        sourceRoot: root.path,
        templatePath,
      });
    }
  }

  return {
    skills: [...bySkill.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    diagnostics,
    complete,
  };
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The stamp is a cache hint, never an authority: a matching input hash says only that the *inputs*
 * are unchanged, so the outputs are checked by content. Only `SKILL.md` is hashed — a `references/`
 * tree dominates corpus bytes and hashing it would put the gated path's cost back where the stamp
 * exists to avoid, and `SKILL.md` is the file that reaches the model as instructions.
 *
 * A record entry of `null` is a skill that produced no output. It is honoured only when no output
 * is actually there, so a `failed` list cannot hide a file from the check.
 */
function outputsVerified(config: Config, skills: DiscoveredSkill[], stored: StampRecord): boolean {
  let verified = 0;
  for (const skill of skills) {
    if (!(skill.name in stored.outputs)) return false;
    const expected = stored.outputs[skill.name] ?? null;
    for (const target of config.targets) {
      const actual = readOutput(path.join(target.path, skill.name, OUTPUT_FILENAME));
      if (expected === null) {
        if (actual !== null) return false;
        continue;
      }
      if (actual === null || hashContent(actual) !== expected) return false;
    }
    if (expected !== null) verified++;
  }
  // A gate may only skip work it can prove was done. A record that verifies nothing proves
  // nothing — which is also the shape a forged stamp takes, since claiming every skill failed is
  // the cheapest way to claim there is nothing to check.
  return verified > 0 || skills.length === 0;
}

function readOutput(candidate: string): string | null {
  try {
    return fs.readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

/** Every skill the last stamp record knew about, whether it compiled or failed. */
function previouslyCompiled(stored: StampRecord | null): string[] {
  if (stored === null) return [];
  return [...new Set([...Object.keys(stored.outputs), ...stored.failed])].sort();
}

/**
 * Stored text is not this run's report. Marking it says so on the one channel the SessionStart
 * hook feeds to the model, so a replayed line can never pass for something the tool just observed.
 */
function asReplayed(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map((entry) => ({ ...entry, message: `[last build] ${entry.message}` }));
}

type Probe = "yes" | "no" | "unreadable";

function looksLikeSkill(dir: string): Probe {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const found = entries.some(
      (entry) => entry.isFile() && (entry.name === "SKILL.md" || entry.name.endsWith(".tmpl")),
    );
    return found ? "yes" : "no";
  } catch (cause) {
    return isMissing(cause) ? "no" : "unreadable";
  }
}

type FileProbe = "file" | "other" | "missing" | "unreadable";

/**
 * `ENOENT` is "there is no skill here" and every other errno is "this build cannot see whether
 * there is one". Collapsing the two is what let an unreadable skill directory drop out of `keep`
 * with no diagnostic and have its compiled output pruned.
 */
function probeFile(candidate: string): FileProbe {
  try {
    return fs.statSync(candidate).isFile() ? "file" : "other";
  } catch (cause) {
    return isMissing(cause) ? "missing" : "unreadable";
  }
}

function isMissing(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

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
  const fail = (message: string, extra: Partial<Diagnostic> = {}) => {
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
    fail(finding.message, { line: finding.line === undefined ? undefined : finding.line + bodyOffset });
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
  const attribute = (origin: LineOrigin | null | undefined): Partial<Diagnostic> => {
    if (origin === undefined || origin === null) return {};
    if (origin.file === null) return { line: origin.line + bodyOffset };
    return { file: origin.file, line: origin.line };
  };
  const inBody = (lines: SourceLine[], line: number | undefined): Partial<Diagnostic> =>
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
  for (const finding of findUnsupportedFields(frontmatterFields(split.frontmatter), config.targets)) {
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
  const body = `${rendered.map((line) => line.text).join("\n").trimEnd()}\n`;
  const content = `${split.frontmatter}${body}`;

  /** The scan runs on the output, whose first `bodyOffset` lines are the template's frontmatter. */
  const inOutput = (line: number | undefined): Partial<Diagnostic> => {
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
  for (let i = config.overrides.length - 1; i >= 0; i--) {
    const root = config.overrides[i]!;
    const file = path.join(root.path, skillName, `${block.name}.md`);

    const resolved = resolveContainedFile(root.path, [skillName, `${block.name}.md`], {
      rejectSymlinkedRoot: true,
    });
    if ("failure" in resolved) {
      const failure = resolved.failure;
      if (failure.kind === "root" || failure.kind === "missing") continue;
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

function overrideContainmentMessage(
  failure: Exclude<ContainmentFailure, { kind: "root" } | { kind: "missing" }>,
  root: string,
): string {
  if (failure.kind === "root-symlink") {
    return `override root ${root} is itself a symlink — containment is asserted against the resolved root, so overrides are not read through it; point the entry at a real directory`;
  }
  if (failure.kind === "symlink") {
    return `override traverses a symlink at "${failure.part}" — refusing to splice a file from outside ${root}`;
  }
  if (failure.kind === "outside") return `override resolves outside its override root ${root}`;
  return `override is not a regular file`;
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

function emitSkill(
  target: Root,
  skill: CompiledSkill,
  config: Config,
  diagnostics: Diagnostic[],
): boolean {
  const destination = path.join(target.path, skill.name);
  try {
    fs.mkdirSync(target.path, { recursive: true });
  } catch (cause) {
    diagnostics.push(
      error(`cannot create target ${target.path}: ${describe(cause)}`, { skill: skill.name }),
    );
    return false;
  }

  if (pathExists(destination) && !isOwned(destination)) {
    diagnostics.push(
      warning(`${destination} exists and was not written by this tool — left untouched`, {
        skill: skill.name,
      }),
    );
    return false;
  }

  const staging = path.join(target.path, `${TMP_PREFIX}${skill.name}-${uniqueSuffix()}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const extra of skill.extras) {
      const to = path.join(staging, ...extra.rel.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(extra.from, to);
    }
    fs.writeFileSync(path.join(staging, OUTPUT_FILENAME), skill.content, "utf8");
    fs.writeFileSync(path.join(staging, OWNER_MARKER), markerContent(skill.name, config), "utf8");
    swapIntoPlace(staging, destination, target.path);
    return true;
  } catch (cause) {
    diagnostics.push(
      error(`cannot write ${destination}: ${describe(cause)}`, { skill: skill.name }),
    );
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

function swapIntoPlace(staging: string, destination: string, targetDir: string): void {
  if (!pathExists(destination)) {
    fs.renameSync(staging, destination);
    return;
  }
  const parked = path.join(targetDir, `${OLD_PREFIX}${path.basename(destination)}-${uniqueSuffix()}`);
  fs.renameSync(destination, parked);
  try {
    fs.renameSync(staging, destination);
  } catch (cause) {
    fs.renameSync(parked, destination);
    throw cause;
  }
  fs.rmSync(parked, { recursive: true, force: true });
}

function pruneTarget(
  target: Root,
  keep: Set<string>,
  config: Config,
  diagnostics: Diagnostic[],
): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target.path, { withFileTypes: true });
  } catch {
    return 0;
  }

  let pruned = 0;
  for (const entry of entries) {
    const full = path.join(target.path, entry.name);
    if (entry.name.startsWith(TMP_PREFIX) || entry.name.startsWith(OLD_PREFIX)) {
      // A young scratch directory may be a concurrent build's staging area, or the only copy of
      // another build's last good output while its swap is in flight. Leave those alone.
      if (isStaleScratch(full)) removeQuietly(full);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (keep.has(entry.name) || !ownedByThisBuild(full, config)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      pruned++;
    } catch (cause) {
      diagnostics.push(warning(`cannot remove stale ${full}: ${describe(cause)}`));
    }
  }
  return pruned;
}

function isStaleScratch(directory: string): boolean {
  try {
    return Date.now() - fs.lstatSync(directory).mtimeMs > STALE_SCRATCH_MS;
  } catch {
    return false;
  }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // leftover scratch costs nothing but a directory entry
  }
}

interface OwnerRecord {
  skill: string;
  id: string | null;
  repo: string;
}

function markerContent(skill: string, config: Config): string {
  const record: OwnerRecord & { tool: string } = {
    tool: "composable-skills",
    skill,
    id: config.id,
    repo: config.repoRoot,
  };
  return `${JSON.stringify(record)}\n`;
}

function readMarker(directory: string): OwnerRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(directory, OWNER_MARKER), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record["tool"] !== "composable-skills") return null;
  /**
   * The contract sells the marker as what makes a shared `~/.claude/skills` safe, so it must name
   * something. `{"tool":"composable-skills"}` alone would otherwise make an unmarked directory
   * overwritable, and a `skill` that does not match the directory it sits in is a marker that was
   * copied rather than written here.
   */
  const skill = typeof record["skill"] === "string" ? record["skill"] : "";
  if (skill === "" || skill !== path.basename(directory)) return null;
  const id = typeof record["id"] === "string" && record["id"] !== "" ? record["id"] : null;
  const repo = typeof record["repo"] === "string" ? record["repo"] : "";
  if (id === null && repo === "") return null;
  return { skill, id, repo };
}

/** Written by this tool, for anybody. Governs whether a directory may be overwritten. */
function isOwned(directory: string): boolean {
  return readMarker(directory) !== null;
}

/**
 * Written by *this* repo's build. Governs deletion: a target may be shared — `~/.claude/skills`
 * is a blessed one — and another repo's skills are not this build's to prune.
 */
function ownedByThisBuild(directory: string, config: Config): boolean {
  const marker = readMarker(directory);
  if (marker === null) return false;
  if (config.id !== null && marker.id !== null) return marker.id === config.id;
  return marker.repo !== "" && marker.repo === config.repoRoot;
}

type LockResult =
  | { kind: "held"; release: () => void }
  | { kind: "busy"; message: string }
  | { kind: "unavailable"; message: string };

interface LockInfo {
  token: string;
  pid: number;
  host: string;
  at: number;
}

/**
 * `mkdir` is the atomic primitive available on every platform this tool supports (`flock` is
 * absent on macOS). A build that dies takes its lock with it, so the lock always carries enough
 * to be broken: the holder's pid and host recover a crash immediately, and a timestamp recovers
 * the cases pid liveness cannot see — a reboot, or a holder on another machine.
 */
function acquireBuildLock(config: Config): LockResult {
  const directory = path.join(stateDir(config.repoRoot), LOCK_DIRNAME);
  const token = uniqueSuffix();

  /**
   * Kept apart from the lock `mkdir` on purpose. A recursive `mkdir` throws `EEXIST` when the path
   * exists as a *regular file*, so a `.composable-skills` file made the state directory's failure
   * indistinguishable from "the lock is held" — and every session then reported a lock that did
   * not exist and compiled nothing, forever. Any state-dir failure means the lock cannot be taken
   * at all, which the contract answers by building unlocked.
   */
  try {
    fs.mkdirSync(stateDir(config.repoRoot), { recursive: true });
  } catch (cause) {
    return { kind: "unavailable", message: `building without a lock: ${describe(cause)}` };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        return { kind: "unavailable", message: `building without a lock: ${describe(cause)}` };
      }
      if (attempt === 0 && lockIsStale(directory)) {
        removeQuietly(directory);
        continue;
      }
      return { kind: "busy", message: `${describeLockHolder(directory)} — nothing was built this run` };
    }

    const info: LockInfo = { token, pid: process.pid, host: os.hostname(), at: Date.now() };
    try {
      fs.writeFileSync(path.join(directory, LOCK_INFO_FILENAME), `${JSON.stringify(info)}\n`, "utf8");
    } catch {
      // the directory is the lock; its contents only make the lock breakable
    }
    return { kind: "held", release: () => releaseBuildLock(directory, token) };
  }

  return { kind: "busy", message: "another build holds the lock — nothing was built this run" };
}

function releaseBuildLock(directory: string, token: string): void {
  const holder = readLockInfo(directory);
  if (holder !== null && holder.token !== token) return;
  removeQuietly(directory);
}

function readLockInfo(directory: string): LockInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(directory, LOCK_INFO_FILENAME), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["token"] !== "string" || typeof record["host"] !== "string") return null;
  if (typeof record["pid"] !== "number" || typeof record["at"] !== "number") return null;
  return { token: record["token"], pid: record["pid"], host: record["host"], at: record["at"] };
}

/**
 * The lock directory's own mtime is the reading the holder does not write, so it is what a forged
 * or clock-skewed `at` is checked against. A timestamp in the future would otherwise never age
 * out — a lock that survives a reboot is exactly what "a build can never wedge permanently"
 * forbids — so `at` is clamped to now and either clock alone may declare the lock dead.
 */
function lockIsStale(directory: string): boolean {
  const byDirectory = directoryLooksStale(directory);
  const holder = readLockInfo(directory);
  if (holder === null) return byDirectory;
  if (holder.host === os.hostname() && !processAlive(holder.pid)) return true;
  return Date.now() - Math.min(holder.at, Date.now()) > LOCK_STALE_MS || byDirectory;
}

function directoryLooksStale(directory: string): boolean {
  let age: number;
  try {
    age = Date.now() - fs.lstatSync(directory).mtimeMs;
  } catch {
    return true;
  }
  // A future mtime is a clock that jumped or a file that was written to lie; either way the
  // directory dates nothing, and refusing to break it is the failure with no recovery.
  return age > LOCK_STALE_MS || age < -LOCK_STALE_MS;
}

function describeLockHolder(directory: string): string {
  const holder = readLockInfo(directory);
  if (holder === null) return "another build holds the lock";
  return `another build holds the lock (pid ${holder.pid} on ${holder.host})`;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function uniqueSuffix(): string {
  return `${process.pid.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function pathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

export function computeStamp(config: Config, version: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(`composable-skills\0${version}\0id\0${config.id ?? ""}\0`);
  const rootSets: [string, Root[]][] = [
    ["source", config.sources],
    ["override", config.overrides],
    ["target", config.targets],
  ];
  for (const [label, roots] of rootSets) {
    for (const root of roots) hash.update(`${label}\0${root.spec}\0${root.path}\0`);
  }
  hash.update(`config\0${config.configText === null ? "" : normaliseEol(config.configText)}\0`);
  for (const root of [...config.sources, ...config.overrides]) {
    hash.update(`tree\0${root.path}\0`);
    for (const entry of listEntries(root.path)) {
      hash.update(`${entry.rel}\0`);
      if (entry.link) {
        let destination: string;
        try {
          destination = fs.readlinkSync(entry.abs);
        } catch {
          destination = "\0unreadable";
        }
        hash.update(`symlink\0${destination}`);
      } else {
        updateWithFile(hash, entry.abs);
      }
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

interface ListedEntry {
  rel: string;
  abs: string;
  link: boolean;
}

function listEntries(root: string): ListedEntry[] {
  const found: ListedEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // A symlink is never followed, but retargeting one changes what the build refuses to do,
      // so its destination belongs in the hash.
      if (entry.isSymbolicLink()) found.push({ rel, abs, link: true });
      else if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) found.push({ rel, abs, link: false });
    }
  };
  walk(root, "");
  return found;
}

function updateWithFile(hash: crypto.Hash, file: string): void {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    hash.update("\0unreadable");
    return;
  }
  hash.update(normaliseEolBytes(raw));
}

/**
 * The stamp is a record rather than a bare hash so a gated run can replay what the last real
 * build said. Without it, one permanently broken template would suppress the stamp for the whole
 * repo and recompile every healthy skill at every session start, forever.
 */
export interface StampRecord {
  stamp: string;
  /** Skills that produced no output last time. Recorded for reporting, not trusted by the gate. */
  failed: string[];
  /**
   * Per-skill sha256 of the `SKILL.md` this build left in every target, or null for a skill with
   * no output at all. Inputs hashing to the same stamp says nothing about what is on disk, so the
   * gate checks these against the files themselves.
   */
  outputs: Record<string, string | null>;
  diagnostics: Diagnostic[];
}

function stampPath(config: Config): string {
  return path.join(stateDir(config.repoRoot), STAMP_FILENAME);
}

function readStamp(config: Config): StampRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(stampPath(config), "utf8").trim();
  } catch {
    return null;
  }
  if (text === "") return null;
  // A stamp from before the record carried output hashes verifies nothing, so it gates nothing.
  if (!text.startsWith("{")) return { stamp: text, failed: [], outputs: {}, diagnostics: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["stamp"] !== "string" || record["stamp"] === "") return null;
  const failed = record["failed"];
  const diagnostics = record["diagnostics"];
  return {
    stamp: record["stamp"],
    failed: Array.isArray(failed) ? failed.filter((name): name is string => typeof name === "string") : [],
    outputs: readOutputHashes(record["outputs"]),
    diagnostics: Array.isArray(diagnostics) ? diagnostics.filter(isDiagnostic) : [],
  };
}

function readOutputHashes(value: unknown): Record<string, string | null> {
  const outputs: Record<string, string | null> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return outputs;
  for (const [name, hash] of Object.entries(value as Record<string, unknown>)) {
    if (hash === null) outputs[name] = null;
    else if (typeof hash === "string" && hash !== "") outputs[name] = hash;
  }
  return outputs;
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["severity"] !== "error" && record["severity"] !== "warning") return false;
  return typeof record["message"] === "string";
}

function writeStamp(config: Config, record: StampRecord): void {
  try {
    fs.mkdirSync(stateDir(config.repoRoot), { recursive: true });
    fs.writeFileSync(stampPath(config), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // a stamp that cannot be written only costs a rebuild next session
  }
}
