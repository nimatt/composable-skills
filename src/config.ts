import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import type { Config, Diagnostic, Root } from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { isAtOrUnder } from "./contain.ts";

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

function expandVariables(
  spec: string,
  home: string,
  id: string | null,
  kind: string,
  diagnostics: Diagnostic[],
): string | null {
  if (spec.includes("${id}") && id === null) {
    diagnostics.push(
      warning(`${kind} "${spec}" uses \${id} but the config declares no "id" — skipped`),
    );
    return null;
  }
  const expanded = spec.replaceAll("${home}", home).replaceAll("${id}", id ?? "");
  return expandTilde(expanded);
}

function isPackageSpec(spec: string): boolean {
  return spec.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function resolvePackageRoot(spec: string, repoRoot: string): string | null {
  if (!isPackageSpec(spec)) return null;
  try {
    const require = createRequire(path.join(repoRoot, "package.json"));
    return path.dirname(require.resolve(`${spec}/package.json`));
  } catch {
    // A package whose exports map does not expose "./package.json" fails the line above. Fall
    // back to the repo's own node_modules only — never a walk above it — and accept a directory
    // only if it is a package by node's own rule.
  }
  const candidate = path.join(repoRoot, "node_modules", ...spec.split("/"));
  return isFile(path.join(candidate, "package.json")) ? candidate : null;
}

function resolveRoots(
  specs: string[],
  kind: "source" | "override" | "target",
  repoRoot: string,
  home: string,
  id: string | null,
  diagnostics: Diagnostic[],
): Root[] {
  const roots: Root[] = [];
  for (const spec of specs) {
    if (spec.trim() === "") {
      diagnostics.push(warning(`empty ${kind} entry ignored`));
      continue;
    }
    const expanded = expandVariables(spec, home, id, kind, diagnostics);
    if (expanded === null) continue;

    let resolved: string | null;
    if (kind === "source" && !isPathLike(expanded)) {
      resolved = resolvePackageRoot(expanded, repoRoot);
      if (resolved === null) {
        diagnostics.push(warning(`source "${spec}" could not be resolved as a package — skipped`));
        continue;
      }
    } else {
      resolved = path.resolve(repoRoot, expanded);
    }

    if (spec.includes("${home}") && !isAtOrUnder(home, resolved)) {
      diagnostics.push(
        error(`${kind} "${spec}" resolves to ${resolved}, outside ${home} — skipped`),
      );
      continue;
    }

    if (kind === "source" && !isDirectory(resolved)) {
      diagnostics.push(warning(`source root "${spec}" does not exist at ${resolved} — skipped`));
      continue;
    }
    roots.push({ spec, path: resolved });
  }
  return roots;
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
    sources,
    overrides: resolveRoots(overrideSpecs, "override", repoRoot, home, id, diagnostics),
    targets: resolveRoots(targetSpecs, "target", repoRoot, home, id, diagnostics),
    sourcesIncomplete: sources.length < sourceSpecs.length,
  };

  if (config.sources.length === 0) {
    diagnostics.push(warning("no usable source roots — no skills to compile"));
  }

  return { config, diagnostics };
}
