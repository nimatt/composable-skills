import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Diagnostic } from "./types.ts";
import { describe, error } from "./types.ts";
import { isUnder } from "./contain.ts";

/**
 * One file `init` has an opinion about. `after === null` means "nothing to write" — either it is
 * already right, or the file is one this tool refuses to touch. Every step carries both sides, so
 * printing the plan and applying it read the same data and cannot disagree.
 */
export interface InitStep {
  path: string;
  before: string | null;
  after: string | null;
  note: string;
  refused?: boolean;
  /**
   * Nothing was written and nothing is wrong with the file — but what `init` came to do was not
   * done either, so the run must not describe the repo as wired up.
   */
  blocked?: boolean;
}

/**
 * Every path `init` writes is derived from the repo root it resolved, never from anything a
 * config or a template said, and this asserts it once more before the write — invariant 7 is the
 * one property of this verb that a bug must not be able to break quietly.
 */
export function applyStep(step: InitStep, repoRoot: string): void {
  if (!isUnder(repoRoot, step.path)) throw new Error(`refusing to write outside ${repoRoot}`);
  const hop = firstSymlinkComponent(repoRoot, step.path);
  if (hop !== null) throw new Error(`refusing to write through the symlink at ${hop}`);
  fs.mkdirSync(path.dirname(step.path), { recursive: true });
  const staging = `${step.path}.composable-skills-tmp-${crypto.randomBytes(4).toString("hex")}`;
  /**
   * A rename replaces the inode, so the mode of the file being edited is not carried over by
   * anything but this. A `600` settings file is a decision — these can carry `env` values — and a
   * merge that silently widens it to the umask default is a permission change nobody asked for
   * and nobody would see.
   *
   * The mode is read *before* the staging file is written and passed to its creation, so the
   * merged content never exists at a wider mode than the file it is replacing, not even for the
   * instant between a write and a `chmod`. The `chmod` below still runs, because a creation mode
   * is masked by the umask and so can only come out narrower than asked for.
   */
  const mode = fileMode(step.path);
  fs.writeFileSync(staging, step.after ?? "", {
    encoding: "utf8",
    mode: mode ?? 0o666,
    flag: "wx",
  });
  try {
    if (mode !== null) fs.chmodSync(staging, mode);
    fs.renameSync(staging, step.path);
  } catch (cause) {
    fs.rmSync(staging, { force: true });
    throw cause;
  }
}

/**
 * Compared by real path as well as by text, because a home directory is so often reached through
 * one — an automount, a `/home` symlink — and this is the one comparison whose false negative
 * writes a per-repo hook into every session on the machine.
 */
export function isSamePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function fileMode(candidate: string): number | null {
  try {
    return fs.statSync(candidate).mode & 0o7777;
  } catch {
    return null;
  }
}

/**
 * Invariant 7 stated in paths rather than in path *text*: `ln -s ~/dotfiles/claude .claude` makes
 * `.claude/settings.json` a name inside the repo for a file outside it, and writing through it
 * would edit a file `init` was never pointed at. Refused rather than followed, per invariant 8,
 * and refused in the plan so a dry run says so instead of a `--write` discovering it.
 */
export function refuseSymlinkedPath(
  step: InitStep,
  repoRoot: string,
  diagnostics: Diagnostic[],
): InitStep {
  if (step.after === null || step.after === step.before) return step;
  const hop = firstSymlinkComponent(repoRoot, step.path);
  if (hop === null) return step;
  return symlinkRefusal(step.path, hop, repoRoot, diagnostics);
}

/**
 * The one verdict a symlinked path gets, whatever verdict its *contents* would otherwise have
 * earned — which is why `settingsStep` asks for it before it reads anything. With
 * `.claude -> ~/dotfiles/claude`, "is not valid JSON" is a statement about somebody else's file,
 * and the remedy printed beside it would send the developer to hand-edit it.
 */
export function symlinkRefusal(
  target: string,
  hop: string,
  repoRoot: string,
  diagnostics: Diagnostic[],
): InitStep {
  diagnostics.push(
    error(
      `${hop} is a symlink, so writing ${target} would write outside ${repoRoot} — init follows ` +
        "no symlink and has not read the file it points at. Replace it with a real directory and " +
        "re-run; init will not edit anything through the link.",
    ),
  );
  return {
    path: target,
    before: null,
    after: null,
    note: `${hop} is a symlink — not followed`,
    refused: true,
  };
}

/**
 * The verdict for a file that is there but could not be read. Nothing below can tell a rewrite
 * from a destruction without the previous contents, and `rename(2)` will happily replace a file
 * this process was never allowed to open — so the one safe move is to write nothing and say why.
 */
export function unreadableRefusal(
  target: string,
  cause: unknown,
  diagnostics: Diagnostic[],
): InitStep {
  diagnostics.push(
    error(
      `${target} exists but could not be read (${describe(cause)}) — init will not replace a file ` +
        "it has not seen. Fix the permissions, or make the edit by hand, and re-run.",
    ),
  );
  return {
    path: target,
    before: null,
    after: null,
    note: "exists but could not be read — left exactly as it is",
    refused: true,
  };
}

/**
 * A mode that denies writing is a decision somebody made about that file. `rename(2)` does not
 * consult it — the staging swap replaces a `444` file without complaint — so the mode has to be
 * read and honoured here or it means nothing at all.
 */
export function refuseUnwritablePath(step: InitStep, diagnostics: Diagnostic[]): InitStep {
  if (step.after === null || step.after === step.before || step.before === null) return step;
  if (isWritable(step.path)) return step;
  const mode = fileMode(step.path);
  diagnostics.push(
    error(
      `${step.path} is not writable${mode === null ? "" : ` (mode ${(mode & 0o777).toString(8)})`}` +
        " — init will not rewrite it. Change the mode if that was not deliberate, or make the " +
        "edit by hand.",
    ),
  );
  return { ...step, after: null, note: "not writable — left exactly as it is", refused: true };
}

function isWritable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repo root itself is deliberately not checked: a checkout is often reached through one
 * (`/tmp` on macOS, an automounted home), and that is the caller's own working directory rather
 * than a hop this verb took.
 */
export function firstSymlinkComponent(repoRoot: string, target: string): string | null {
  if (!isUnder(repoRoot, target)) return null;
  const relative = path.relative(repoRoot, target);
  let current = repoRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink()) return current;
  }
  return null;
}
