import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config, Diagnostic, Root } from "./types.ts";
import { describe, error, warning } from "./types.ts";
import type { ContainmentFailure } from "./contain.ts";
import { isAtOrUnder, isUnder, resolveContainedFile } from "./contain.ts";
import { isMissing, pathExists } from "./fsutil.ts";
import { stateDir } from "./layout.ts";

export const CONFIG_FILENAMES = ["composable-skills.jsonc", "composable-skills.json"] as const;

export const DEFAULT_SOURCES: string[] = [];
export const DEFAULT_OVERRIDES = [
  "${home}/global",
  "./.claude/skills-local",
  "${home}/repos/${id}",
];
export const DEFAULT_TARGETS = ["./.claude/skills"];

export interface LoadedConfig {
  config: Config;
  diagnostics: Diagnostic[];
  /**
   * Observations that bear on a build and on nothing else. Detection belongs here, where all
   * three root lists resolve; delivery does not. `override --dry-run` and `init` load the same
   * config and have no stamp whose freshness could be at stake, so `runBuild` folds these into
   * its report and the other verbs drop them.
   */
  buildAdvice: Diagnostic[];
}

export interface ConfigFailure {
  fatal: string;
  /**
   * Everything observed before the load gave up — including the per-key error that says *which*
   * key is wrong. `fatal` alone only says the file is unusable, which on its own leaves a developer
   * with three keys to guess between.
   */
  diagnostics: Diagnostic[];
}

export function homeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const relocated = env.COMPOSABLE_SKILLS_HOME;
  if (relocated && relocated.trim() !== "") return path.resolve(expandTilde(relocated.trim()));
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg && xdg.trim() !== "" ? expandTilde(xdg.trim()) : path.join(os.homedir(), ".config");
  return path.resolve(path.join(base, "composable-skills"));
}

export function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * JSONC is reduced to JSON by *blanking* what JSON cannot hold rather than deleting it: comments
 * become spaces (newlines kept as newlines) and a trailing comma becomes a space. The reduced text
 * therefore has the same length and the same line breaks as the file on disk, so the `position`,
 * `line` and `column` a parser reports for a syntax error address the developer's own file.
 * Deleting instead would shift every offset after the first comment.
 */
export function blankJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    // The cursor advances by an escape pair or a whole comment run, not one unit at a time.
    // biome-ignore lint/style/noNonNullAssertion: `i < text.length` is the bound, on the line above
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length) out += "  ";
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function blankTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    // The cursor skips the unit after a backslash, so this is not a per-element walk.
    // biome-ignore lint/style/noNonNullAssertion: `i < text.length` is the bound, on the line above
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      // biome-ignore lint/style/noNonNullAssertion: `j < text.length` bounds it in this condition
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const next = text[j];
      if (next === "}" || next === "]") {
        out += " ";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(blankTrailingCommas(blankJsonComments(text)));
}

export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  fallback: string[],
  diagnostics: Diagnostic[],
  configPath: string | null,
): string[] | null {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    diagnostics.push(
      error(`"${key}" must be an array of strings`, { file: configPath ?? undefined }),
    );
    return null;
  }
  return value as string[];
}

function isPathLike(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("~") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

const ID_CHARSET = /^[A-Za-z0-9._-]+$/;

export function isValidId(value: string): boolean {
  if (value === "." || value === "..") return false;
  return ID_CHARSET.test(value);
}

type RootKind = "source" | "override" | "target";

function expandVariables(
  spec: string,
  home: string,
  id: string | null,
  kind: RootKind,
  diagnostics: Diagnostic[],
): string | null {
  if (spec.includes("${id}") && id === null) {
    const message = `${kind} "${spec}" uses \${id} but the config declares no "id" — skipped`;
    // A source named this way is a source the tool cannot use. An override or target is not:
    // `${home}/repos/${id}` ships in DEFAULT_OVERRIDES, where being inert without an `id` is the
    // designed behaviour rather than a mistake.
    diagnostics.push(kind === "source" ? error(message) : warning(message));
    return null;
  }
  /**
   * Replacer functions, not replacement strings: `String.prototype.replaceAll` expands `$$`, `$&`,
   * `` $` ``, `$'` and `$1` inside a *string* replacement, so a `$` anywhere in the home path — a
   * path this tool takes from the environment and never chose — would rewrite the substitution
   * instead of being inserted literally, and the resulting root then fails its own `${home}`
   * containment check.
   */
  const expanded = spec.replaceAll("${home}", () => home).replaceAll("${id}", () => id ?? "");
  return expandTilde(expanded);
}

/**
 * Both separators, because win32 `path.join` treats `\` as one: splitting on `/` alone would let
 * `pack\templates` through as a bare package name, so its subpath would never be resolved under
 * the containment discipline at all.
 */
const SPEC_SEPARATOR = /[\\/]/;

/**
 * A NUL in a segment is refused here rather than at a `stat`: `fs.statSync` throws
 * `ERR_INVALID_ARG_VALUE` for one, which carries no errno, so every errno test downstream reads a
 * malformed spec as a path this process was not allowed to look at.
 */
function isPackageSpec(spec: string): boolean {
  const usable = (segment: string): boolean =>
    segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\0");
  return spec.split(SPEC_SEPARATOR).every(usable);
}

/**
 * One level of the upward walk that the walk took no answer from: a `node_modules` or scope
 * directory that is a symlink or that this process cannot see into, or a package root that is
 * there and is not a usable package — a dangling link after `rm -rf node_modules/.pnpm`, a branch
 * switch that removed a linked workspace package, a half-restored cache. Each is a place a copy of
 * the package could be sitting unseen, which is the only reason any of them is worth recording.
 *
 * `candidate` is where the package would have been at that level, which is what a confirming
 * `stat` needs and the level itself does not say: a symlinked `node_modules` and a symlinked scope
 * directory sit at different depths above it.
 */
type SkippedLevel =
  | { kind: "symlink"; part: string; candidate: string }
  | { kind: "unreadable"; part: string; cause: unknown }
  | { kind: "not-a-package"; part: string; inRepoModules: boolean };

/** The kinds the walk could not look *through*, as against one it looked at and found unusable. */
type OpaqueLevel = Extract<SkippedLevel, { kind: "symlink" | "unreadable" }>;

/**
 * `spec` names no package name at all; the package is in no `node_modules` from the repo root
 * upward; a level of that chain could not be read, so whether it is installed there is not a
 * question this process was allowed to ask; or the package resolved and its subpath did not,
 * carrying the containment discipline's own reason. A skills package has no entry point, so
 * `main` and `exports` are never consulted — this asks the filesystem for a directory rather than
 * node for a module.
 *
 * `absent` and `unreadable` are siblings rather than one kind for the reason `contain.ts` gives
 * for keeping `missing` and `root` apart from `unreadable`: "is it installed?" is the wrong
 * question to put to a developer about a directory the build was refused entry to.
 *
 * Every walk-shaped kind carries the levels that were skipped past, which are context and never
 * the headline — a symlinked `node_modules` in some unrelated ancestor must not turn every
 * missing-package error in every repo underneath into a report about that ancestor.
 */
type PackageFailure =
  | { kind: "spec" }
  | { kind: "absent"; name: string; skipped: SkippedLevel[] }
  | { kind: "unreadable"; name: string; part: string; cause: unknown; skipped: SkippedLevel[] }
  | {
      kind: "subpath";
      packageRoot: string;
      subpath: string;
      failure: ContainmentFailure;
      skipped: SkippedLevel[];
    };

type ResolvedPackage = { path: string; skipped: SkippedLevel[] } | { failure: PackageFailure };

/**
 * Where the walk ended, and what it had to step over to get there. A skipped level does not end
 * the walk — a link at one level says nothing about the level above — so `path` may be set with
 * `skipped` non-empty, and every entry then sits *below* the level that resolved: each is a place
 * a nearer copy of the package could have been and was not seen. Invariant 8 asks that no symlink
 * ever be followed silently; one that is refused and then walked past is just as silent, so the
 * list survives the walk rather than being discarded by a later success.
 *
 * Recorded unjudged. Whether any of it is worth a word is decided later, by `confirmSkippedLevel`,
 * which may look through a level the walk would not resolve through.
 */
interface PackageRootLookup {
  path: string | null;
  skipped: SkippedLevel[];
}

/**
 * The `node_modules` chain from `repoRoot` upward, and nothing else. `require.resolve.paths()`
 * appends `~/.node_modules`, `~/.node_libraries` and `/usr/lib/node`; walking the chain by hand
 * makes a globally installed pack structurally unable to become a source root rather than a
 * policy to maintain. A directory that exists but carries no `package.json` is not a package, so
 * the walk continues past it — and records it, because something that is there and is not a
 * package is a broken install rather than an absence.
 *
 * Every component of the name path is `lstat`'d bar the last, which is the one exemption
 * invariant 8 grants: npm and pnpm both create a real `node_modules/` and a real
 * `node_modules/@scope/`, and only the package directory itself is ever a link.
 */
function findPackageRoot(nameParts: string[], repoRoot: string): PackageRootLookup {
  const skipped: SkippedLevel[] = [];
  const start = path.resolve(repoRoot);
  let dir = start;
  for (;;) {
    const modules = path.join(dir, "node_modules");
    const candidate = path.join(modules, ...nameParts);
    const blocked = firstBlockedComponent(modules, nameParts.slice(0, -1), candidate);
    if (blocked === null) {
      const manifest = packageManifest(candidate);
      if (manifest.kind === "found") return { path: candidate, skipped };
      if (manifest.kind === "unreadable") {
        skipped.push({ kind: "unreadable", part: candidate, cause: manifest.cause });
      } else if (pathExists(candidate)) {
        /**
         * `missing` collapses "nothing is here" with "something is here that is not a usable
         * package", and the second is a broken install rather than an absence: the entry this
         * repo's own install left behind is being walked past, and an ancestor's copy compiles.
         * One `lstat`, taken only where the manifest was missing and the walk is continuing anyway.
         */
        skipped.push({ kind: "not-a-package", part: candidate, inRepoModules: dir === start });
      }
    } else {
      skipped.push(blocked);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { path: null, skipped };
    dir = parent;
  }
}

function firstBlockedComponent(
  modules: string,
  scopeParts: string[],
  candidate: string,
): OpaqueLevel | null {
  let current = modules;
  const blocked = componentBlock(current, candidate);
  if (blocked !== null) return blocked;
  for (const part of scopeParts) {
    current = path.join(current, part);
    const level = componentBlock(current, candidate);
    if (level !== null) return level;
  }
  return null;
}

/**
 * Three answers where a bare `isSymlink` has two: it is a link, it is fine to look through, or
 * this process cannot tell. A `catch {}` here reads an `EACCES` as "not a symlink", the walk then
 * reads the same `EACCES` as "no package.json", and the two together report a directory the build
 * was not allowed to open as a package the developer never installed.
 */
function componentBlock(part: string, candidate: string): OpaqueLevel | null {
  try {
    return fs.lstatSync(part).isSymbolicLink() ? { kind: "symlink", part, candidate } : null;
  } catch (cause) {
    return isMissing(cause) ? null : { kind: "unreadable", part, cause };
  }
}

type ManifestLookup =
  | { kind: "found" }
  | { kind: "missing" }
  | { kind: "unreadable"; cause: unknown };

/** A node that is there but is not a regular file is not a manifest, and so not a package. */
function packageManifest(candidate: string): ManifestLookup {
  try {
    return fs.statSync(path.join(candidate, "package.json")).isFile()
      ? { kind: "found" }
      : { kind: "missing" };
  } catch (cause) {
    return isMissing(cause) ? { kind: "missing" } : { kind: "unreadable", cause };
  }
}

/**
 * `absent` unless a level the walk could not read is what stands between the config and an answer,
 * in which case that level is the headline and the rest stay context. A symlink refusal never
 * takes the headline: it is a rule this tool chose, it fires on ancestors that have nothing to do
 * with the repo, and "no such package — is it installed?" is both the near-certain truth and the
 * only one of the two that names a remedy.
 */
function unresolvedFailure(name: string, skipped: SkippedLevel[]): PackageFailure {
  const level = skipped.find((entry) => entry.kind === "unreadable");
  if (level === undefined) return { kind: "absent", name, skipped };
  return {
    kind: "unreadable",
    name,
    part: level.part,
    cause: level.cause,
    skipped: skipped.filter((entry) => entry !== level),
  };
}

function resolvePackageRoot(spec: string, repoRoot: string): ResolvedPackage {
  if (!isPackageSpec(spec)) return { failure: { kind: "spec" } };
  const segments = spec.split(SPEC_SEPARATOR);
  const nameLength = spec.startsWith("@") ? 2 : 1;
  if (segments.length < nameLength) return { failure: { kind: "spec" } };
  const nameParts = segments.slice(0, nameLength);
  const subpathParts = segments.slice(nameLength);

  /**
   * Refusing every "." and ".." segment is an argument about having enumerated the separators,
   * which decays. This one asks whether the path built from the parts still lands under the
   * `node_modules` it was joined to, which stays answered however `path.join` reads them. The
   * answer does not depend on which level of the chain is being looked at, so it is asked once,
   * before anything is stat'd.
   */
  const modules = path.join(repoRoot, "node_modules");
  if (!isUnder(modules, path.join(modules, ...nameParts))) return { failure: { kind: "spec" } };

  const found = findPackageRoot(nameParts, repoRoot);
  const skipped = found.skipped;
  if (found.path === null) return { failure: unresolvedFailure(nameParts.join("/"), skipped) };
  const packageRoot = found.path;
  /** No directory check: the walk only returns a root whose own `package.json` stat'd as a file. */
  if (subpathParts.length === 0) return { path: packageRoot, skipped };

  // `rejectSymlinkedRoot` stays off: a symlinked package root is ordinary under pnpm, and is the
  // one exemption invariant 8 grants. The subpath inside the package is not exempt.
  const contained = resolveContainedFile(packageRoot, subpathParts, { expect: "directory" });
  if ("failure" in contained) {
    return {
      failure: {
        kind: "subpath",
        packageRoot,
        subpath: subpathParts.join("/"),
        failure: contained.failure,
        skipped,
      },
    };
  }
  return { path: contained.path, skipped };
}

/**
 * Why one level of the walk was not looked through, as a clause the callers below share. The rule
 * it names is named-versus-derived: a root a config entry names — a path, or a package — is the
 * destination and is not `lstat`'d, while every component this tool derived by joining names onto
 * a root it must vouch for is checked in full.
 */
function skipReason(level: OpaqueLevel): string {
  return level.kind === "symlink"
    ? "it is a symlink, and only the root a config entry names may be one"
    : `it cannot be read: ${describe(level.cause)}`;
}

/**
 * Context beside a primary error, never instead of one. Every one of these is a place the answer
 * the developer is being given could be wrong, which is worth a line and is worth nothing more.
 * Nothing here is confirmed by a `stat` through the level, and nothing here needs to be: the entry
 * failed, so "a copy behind this was not considered" is true whether or not one is there.
 */
function skippedLevelNote(spec: string, level: SkippedLevel): Diagnostic {
  if (level.kind === "not-a-package") {
    return warning(
      `source "${spec}": ${level.part} is there but is not a usable package — it has no readable ` +
        `package.json, so the walk stepped over it.`,
    );
  }
  return warning(
    `source "${spec}": ${level.part} was not looked through — ${skipReason(level)}. A copy of ` +
      `the package installed behind it was not considered.`,
  );
}

/**
 * What a skipped level turned out to mean, decided by one `stat` *through* it. Resolution still
 * refuses to look through such a level; asking whether a package sits behind one opens no compile
 * path — the answer picks a diagnostic and nothing else — so invariant 8, which governs what a
 * build reads into its output, is untouched. Asked only where a level was skipped *and* the walk
 * went on to resolve elsewhere, so an ordinary install pays for none of it.
 */
type LevelVerdict =
  | { kind: "harmless" }
  | { kind: "shadowed"; level: OpaqueLevel; copy: string }
  | { kind: "unchecked"; level: OpaqueLevel }
  | { kind: "broken"; part: string };

function confirmSkippedLevel(level: SkippedLevel): LevelVerdict {
  switch (level.kind) {
    case "symlink": {
      const manifest = packageManifest(level.candidate);
      if (manifest.kind === "found") return { kind: "shadowed", level, copy: level.candidate };
      return manifest.kind === "unreadable" ? { kind: "unchecked", level } : { kind: "harmless" };
    }
    /** The level itself is what cannot be read, so nothing behind it can be checked either. */
    case "unreadable":
      return { kind: "unchecked", level };
    /**
     * Confirmed by construction: something is there and it is not a package. Worth saying only
     * where this repo's own install put it there — a broken entry in an ancestor's `node_modules`
     * is governed by no lockfile this developer controls and names them no action.
     */
    case "not-a-package":
      return level.inRepoModules ? { kind: "broken", part: level.part } : { kind: "harmless" };
  }
}

/**
 * The build produced skills and may have produced the wrong ones. Shadowing is asserted only where
 * a `stat` saw the shadowing copy; where the level turned out to shadow nothing there is no
 * diagnostic at all, and where the level was closed to that `stat` the line says so rather than
 * claiming a copy that was never seen.
 */
function doubtfulPackageWarning(
  spec: string,
  used: string,
  verdict: Exclude<LevelVerdict, { kind: "harmless" }>,
): Diagnostic {
  switch (verdict.kind) {
    case "shadowed":
      return warning(
        `source "${spec}" resolved to ${used}, but a package is installed nearer the repo at ` +
          `${verdict.copy}: ${verdict.level.part} was not looked through — ` +
          `${skipReason(verdict.level)}. The nearer copy would have won, so this build is not ` +
          `compiling the one installed for this repo.`,
      );
    case "unchecked":
      return warning(
        `source "${spec}" resolved to ${used}, but ${verdict.level.part} was not looked through ` +
          `— ${skipReason(verdict.level)}, so whether a nearer copy of the package is installed ` +
          `behind it could not be checked; this build may not be compiling the one installed for ` +
          `this repo.`,
      );
    case "broken":
      return warning(
        `source "${spec}" resolved to ${used}, but ${verdict.part} is this repo's own install of ` +
          `it and is not a usable package — it has no readable package.json, so it was stepped ` +
          `over; reinstall to repair it.`,
      );
  }
}

/**
 * A list, because a walk-shaped failure has one thing to say about the source and possibly several
 * about the chain it searched. The head is always the failure itself.
 */
function packageFailureDiagnostic(
  spec: string,
  repoRoot: string,
  failure: PackageFailure,
): Diagnostic[] {
  switch (failure.kind) {
    case "spec":
      return [
        error(
          `source "${spec}" could not be resolved as a package — not a package name: a scoped ` +
            `name is "@scope/name", and no segment may be empty, ".", ".." or contain a NUL ` +
            `— skipped`,
        ),
      ];
    case "absent":
      return [
        error(
          `source "${spec}" could not be resolved as a package — no "${failure.name}" in any ` +
            `node_modules from ${repoRoot} upward; is it installed? — skipped`,
        ),
        ...failure.skipped.map((level) => skippedLevelNote(spec, level)),
      ];
    case "unreadable":
      return [
        error(
          `source "${spec}" could not be resolved as a package — ${failure.part} cannot be read: ` +
            `${describe(failure.cause)}, so whether "${failure.name}" is installed there is not ` +
            `something this build can tell; no node_modules it could read from ${repoRoot} ` +
            `upward holds it — skipped`,
        ),
        ...failure.skipped.map((level) => skippedLevelNote(spec, level)),
      ];
    case "subpath":
      return [
        subpathFailureDiagnostic(spec, failure),
        ...failure.skipped.map((level) => skippedLevelNote(spec, level)),
      ];
  }
}

function subpathFailureDiagnostic(
  spec: string,
  outer: { packageRoot: string; subpath: string; failure: ContainmentFailure },
): Diagnostic {
  const { packageRoot, subpath, failure } = outer;
  switch (failure.kind) {
    case "missing":
      return error(
        `source "${spec}" could not be resolved — the package resolves to ${packageRoot}, ` +
          `which has no "${subpath}" directory — skipped`,
      );
    case "symlink":
      return error(
        `source "${spec}" was refused — "${subpath}" traverses a symlink at "${failure.part}" ` +
          `under ${packageRoot}, and no symlink is followed — skipped`,
      );
    case "not-directory":
      return error(
        `source "${spec}" could not be resolved — ${path.join(packageRoot, subpath)} exists but ` +
          `is not a directory — skipped`,
      );
    case "unreadable":
      return error(
        `source "${spec}" could not be read — "${failure.part}" under ${packageRoot} cannot be ` +
          `read: ${describe(failure.cause)} — skipped`,
      );
    /**
     * Unreachable from this call site as it stands: `isPackageSpec` leaves no ".." for `outside`
     * to catch, the walk only returns a root whose own `package.json` stat'd, `rejectSymlinkedRoot`
     * is off and `expect` is `"directory"`. Named rather than dropped, and carrying its own kind,
     * so a case that becomes possible reads as itself instead of as "could not be resolved as a
     * package". There is no `default`, so a new kind is a compile error and not a vague message.
     */
    case "root":
    case "root-symlink":
    case "root-unreadable":
    case "outside":
    case "not-file": {
      const cause = "cause" in failure ? `: ${describe(failure.cause)}` : "";
      return error(
        `source "${spec}" could not be resolved — the package resolves to ${packageRoot}, and ` +
          `"${subpath}" under it failed containment (${failure.kind})${cause} — skipped`,
      );
    }
  }
}

interface ResolvedRoots {
  roots: Root[];
  /**
   * Entries that named something and could not be used: a package that did not resolve, a
   * `${home}` escape, a `${id}` with no `id` declared, a path root that is not there. Counted
   * rather than derived from `specs.length - roots.length`, because an **empty** entry is not one
   * of these — it names nothing that could be unusable, so there is no source to have lost, and
   * deriving the count would let a single `""` in `sources` suppress pruning for the life of the
   * config while reporting a root that could not be read.
   *
   * **Meaningful for `sources` only.** `loadConfig` takes nothing but `.roots` off the `overrides`
   * and `targets` calls, and deliberately: a `${id}` entry with no `id` declared increments this,
   * while for those two lists it is a warning and nothing more. Wiring this up for them would turn
   * a warn-only case into one that suppresses pruning for the life of the config.
   */
  unusable: number;
  /**
   * A source resolved, and to a place this build cannot vouch for: it stepped over a level holding
   * a package, or one it was not allowed to check. Pruning hangs on this for the reason an
   * unreadable root does — the corpus that resolved may not be the corpus that exists, and a
   * substitution that empties the target must not take the compiled skills with it. A level
   * confirmed harmless sets nothing, so the ordinary pnpm and shared-`node_modules` layouts prune
   * exactly as before.
   */
  doubtful: boolean;
}

function resolveRoots(
  specs: string[],
  kind: RootKind,
  repoRoot: string,
  home: string,
  id: string | null,
  diagnostics: Diagnostic[],
): ResolvedRoots {
  const roots: Root[] = [];
  let unusable = 0;
  let doubtful = false;
  for (const spec of specs) {
    if (spec.trim() === "") {
      diagnostics.push(warning(`empty ${kind} entry ignored`));
      continue;
    }
    const expanded = expandVariables(spec, home, id, kind, diagnostics);
    if (expanded === null) {
      unusable++;
      continue;
    }

    let resolved: string;
    if (kind === "source" && !isPathLike(expanded)) {
      const resolvedPackage = resolvePackageRoot(expanded, repoRoot);
      if ("failure" in resolvedPackage) {
        diagnostics.push(...packageFailureDiagnostic(spec, repoRoot, resolvedPackage.failure));
        unusable++;
        continue;
      }
      resolved = resolvedPackage.path;
      for (const level of resolvedPackage.skipped) {
        const verdict = confirmSkippedLevel(level);
        if (verdict.kind === "harmless") continue;
        diagnostics.push(doubtfulPackageWarning(spec, resolved, verdict));
        doubtful = true;
      }
    } else {
      resolved = path.resolve(repoRoot, expanded);
    }

    if (spec.includes("${home}")) {
      const verdict = homeContainment(home, resolved);
      if (verdict.kind === "escape") {
        diagnostics.push(error(`${kind} "${spec}" ${verdict.message} — skipped`));
        unusable++;
        continue;
      }
      if (verdict.kind === "unverifiable") {
        diagnostics.push(warning(`${kind} "${spec}" ${verdict.message}`));
      }
    }

    if (kind === "source" && !isDirectory(resolved)) {
      // The remedy is the same for every caller, and this line is also the only place a reader
      // who has only ever written paths learns that the package form exists at all.
      diagnostics.push(
        error(
          `source root "${spec}" does not exist at ${resolved} — skipped; create it, or point ` +
            `"sources" at an installed package`,
        ),
      );
      unusable++;
      continue;
    }
    roots.push({ spec, path: resolved });
  }
  return { roots, unusable, doubtful };
}

/**
 * Both questions the `${home}` promise needs: of the resolved text, which catches a `..` that walks
 * out lexically, and of the real path, which catches a link that walks out at the first read. Text
 * alone is what `rejectSymlinkedRoot` exists to cover for an override root at read time; asked here
 * it covers a source root, which is exempt from that option because a symlinked package root is
 * ordinary, and a target root, which is written through before anything `lstat`s it.
 *
 * The third verdict is the one `contain.ts` draws everywhere else: *outside* and *cannot be seen*
 * are different answers. A path this process may not traverse is also one it may not read a
 * template from, splice an override out of, or write a target into — every consumer resolves it
 * again and fails closed with a message naming itself — so rejecting the root here would trade
 * that precise diagnostic for a config error, and would fail `build --check` over a `chmod`
 * standing above a root rather than over anything stale.
 */
type HomeVerdict =
  | { kind: "contained" }
  | { kind: "escape"; message: string }
  | { kind: "unverifiable"; message: string };

function homeContainment(home: string, resolved: string): HomeVerdict {
  if (!isAtOrUnder(home, resolved)) {
    return { kind: "escape", message: `resolves to ${resolved}, outside ${home}` };
  }
  try {
    const real = canonicalPath(resolved);
    if (isAtOrUnder(canonicalPath(home), real)) return { kind: "contained" };
    return {
      kind: "escape",
      message: `resolves to ${resolved}, which leads through a symlink to ${real}, outside ${home}`,
    };
  } catch (cause) {
    if (cause instanceof Indeterminate && cause.reason === "unreadable") {
      return {
        kind: "unverifiable",
        message:
          `resolves to ${resolved}, which this build cannot check against ${home}: ` +
          `${cause.message} — kept, and re-checked wherever it is read or written`,
      };
    }
    return {
      kind: "escape",
      message:
        `resolves to ${resolved}, which leads through a symlink whose destination is not there ` +
        `yet, so it cannot be shown to stay under ${home}`,
    };
  }
}

/**
 * Why a real location could not be established, which is two answers rather than one. A link whose
 * destination is not there yet may come to point anywhere, so containment is undecided in a way
 * only the config can refuse. A component this process may not traverse leaves containment equally
 * undecided, but is also a component nothing can be read from or written through, so every
 * consumer that touches the root resolves it again and fails closed naming itself.
 */
class Indeterminate extends Error {
  constructor(
    readonly reason: "dangling" | "unreadable",
    cause: unknown,
  ) {
    super(describe(cause));
  }
}

/** Resolve existing ancestors before appending missing components of a first-run target. */
function canonicalPath(candidate: string): string {
  let ancestor = path.resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(ancestor), ...missing);
    } catch (cause) {
      if (!isMissing(cause)) throw new Indeterminate("unreadable", cause);
      // A dangling link is not a missing directory: its eventual destination is unknown.
      let stats: fs.Stats | undefined;
      try {
        stats = fs.lstatSync(ancestor, { throwIfNoEntry: false });
      } catch (probeCause) {
        if (!isMissing(probeCause)) throw new Indeterminate("unreadable", probeCause);
      }
      if (stats) throw new Indeterminate("dangling", cause);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Indeterminate("dangling", cause);
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * Asked both ways, either answer sufficing: a source root reached through a symlinked parent is
 * only comparable by real path, and a target that does not exist yet is only comparable by text.
 */
function rootContains(root: string, candidate: string): boolean {
  if (isAtOrUnder(path.resolve(root), path.resolve(candidate))) return true;
  try {
    return isAtOrUnder(canonicalPath(root), canonicalPath(candidate));
  } catch {
    return false;
  }
}

function firstOutputInside(root: Root, config: Config): string | null {
  const state = stateDir(config.repoRoot);
  const outputs = [
    ...config.targets.map((target) => ({
      path: target.path,
      label: `target root "${target.spec}" at ${target.path}`,
    })),
    { path: state, label: `the build state directory ${state}` },
  ];
  return outputs.find((output) => rootContains(root.path, output.path))?.label ?? null;
}

/**
 * Compiled output and build state sitting inside a hashed root are inputs to the next run's stamp:
 * `computeStamp` walks every source *and* override root with no exclusions, so a build changes the
 * hash that was supposed to say nothing had changed. How badly depends on what is inside. A target
 * alone settles after one extra rebuild, since the stamp is computed before anything is written and
 * the output is byte-stable; the build state directory never settles at all, because the stamp file
 * and `build.log` are rewritten every run — `--check` is then stale forever. Both are worth saying,
 * and neither is worth failing over, so this warns once per root, naming the first thing found
 * inside it.
 *
 * Both lists, because the stamp hashes both: an override root holding a target or the state
 * directory is the identical failure, and covering only `sources` left it undiagnosed.
 */
function outputsInsideHashedRoots(config: Config): Diagnostic[] {
  const advice: Diagnostic[] = [];
  const hashed: { kind: "source" | "override"; root: Root }[] = [
    ...config.sources.map((root) => ({ kind: "source" as const, root })),
    ...config.overrides.map((root) => ({ kind: "override" as const, root })),
  ];
  for (const { kind, root } of hashed) {
    const offender = firstOutputInside(root, config);
    if (offender === null) continue;
    advice.push(
      warning(
        `${kind} root "${root.spec}" at ${root.path} contains ${offender}, which the next ` +
          `build's stamp hashes as an input — so a build recompiles when nothing changed, and ` +
          `where the build state is inside such a root "build --check" reports stale forever. ` +
          `Keep compiled output and build state outside the ${kind} roots.`,
      ),
    );
  }
  return advice;
}

export function loadConfig(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig | ConfigFailure {
  const diagnostics: Diagnostic[] = [];
  const configPath = findConfigFile(cwd);
  const repoRoot = configPath === null ? findRepoRoot(cwd) : path.dirname(configPath);

  let raw: Record<string, unknown> = {};
  let configText: string | null = null;
  if (configPath !== null) {
    try {
      configText = fs.readFileSync(configPath, "utf8");
    } catch (cause) {
      return { fatal: `cannot read ${configPath}: ${describe(cause)}`, diagnostics };
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(configText);
    } catch (cause) {
      return { fatal: `cannot parse ${configPath}: ${describe(cause)}`, diagnostics };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { fatal: `${configPath} must contain a JSON object`, diagnostics };
    }
    raw = parsed as Record<string, unknown>;
  }

  for (const key of Object.keys(raw)) {
    if (!["id", "sources", "overrides", "targets"].includes(key)) {
      diagnostics.push(
        warning(`unknown config key "${key}" ignored`, { file: configPath ?? undefined }),
      );
    }
  }

  let id: string | null = null;
  const rawId = raw["id"];
  if (rawId !== undefined) {
    if (typeof rawId !== "string" || rawId.trim() === "") {
      return { fatal: `${configPath}: "id" must be a non-empty string`, diagnostics };
    }
    id = rawId.trim();
    if (!isValidId(id)) {
      return {
        fatal:
          `${configPath}: "id" must be a single path segment of letters, digits, ".", "-" or "_" ` +
          `— got ${JSON.stringify(id)}`,
        diagnostics,
      };
    }
  }

  const sourceSpecs = readStringArray(raw, "sources", DEFAULT_SOURCES, diagnostics, configPath);
  const overrideSpecs = readStringArray(
    raw,
    "overrides",
    DEFAULT_OVERRIDES,
    diagnostics,
    configPath,
  );
  const targetSpecs = readStringArray(raw, "targets", DEFAULT_TARGETS, diagnostics, configPath);
  if (sourceSpecs === null || overrideSpecs === null || targetSpecs === null) {
    return { fatal: `${configPath} is invalid; nothing was built`, diagnostics };
  }
  if (targetSpecs.length === 0) {
    diagnostics.push(warning("no targets configured — nothing will be written"));
  }

  const home = homeRoot(env);
  const sources = resolveRoots(sourceSpecs, "source", repoRoot, home, id, diagnostics);
  const config: Config = {
    id,
    repoRoot,
    configPath,
    configText,
    sources: sources.roots,
    overrides: resolveRoots(overrideSpecs, "override", repoRoot, home, id, diagnostics).roots,
    targets: resolveRoots(targetSpecs, "target", repoRoot, home, id, diagnostics).roots,
    sourcesIncomplete: sources.unusable > 0 || sources.doubtful,
  };

  if (config.sources.length === 0) {
    diagnostics.push(warning("no usable source roots — no skills to compile"));
  }
  return { config, diagnostics, buildAdvice: outputsInsideHashedRoots(config) };
}
