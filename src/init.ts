import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config, Diagnostic } from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { isValidId, loadConfig } from "./config.ts";
import { isUnder } from "./contain.ts";
import { pathExists } from "./fsutil.ts";
import { OWNER_MARKER, STATE_DIR } from "./layout.ts";
import { emitLines, emitReport } from "./report.ts";
import { unifiedDiff } from "./diff.ts";
import { CLI_REL, SETTINGS_REL, settingsStep } from "./settings.ts";
import type { InitStep } from "./steps.ts";
import {
  applyStep,
  firstSymlinkComponent,
  isSamePath,
  refuseSymlinkedPath,
  refuseUnwritablePath,
  unreadableRefusal,
} from "./steps.ts";
import { dominantEol, readIfPresent } from "./textfile.ts";

export const CONFIG_REL = "composable-skills.jsonc";
export const GITIGNORE_REL = ".gitignore";
export const WORKTREEINCLUDE_REL = ".worktreeinclude";

/** Yarn 2 wrote `.pnp.js`; Yarn 3+ writes `.pnp.cjs`. Either one means there is no `node_modules`. */
export const PNP_FILENAMES = [".pnp.cjs", ".pnp.js"] as const;

/** The `sources` entry a fresh config points at. A suggestion; the developer owns the layout. */
export const DEFAULT_SOURCE_ENTRY = "./skills/templates";

export interface InitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Diff-first: without this nothing is written, whatever the plan says. */
  write?: boolean;
}

export interface InitPlan {
  steps: InitStep[];
  diagnostics: Diagnostic[];
  /** Advice that is not a file change — printed, never written. */
  notes: string[];
}

export function runInit(options: InitOptions = {}): number {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const write = options.write ?? false;

  const loaded = loadConfig(cwd, env);
  if ("fatal" in loaded) {
    emitReport(
      [
        ...loaded.diagnostics,
        error(loaded.fatal),
        error("init needs a config it can read to know what to ignore — fix it and re-run"),
      ],
      [],
      null,
    );
    return 1;
  }

  const { config } = loaded;
  const repoRoot = config.repoRoot;
  const gitRoot = findGitRoot(repoRoot);

  /**
   * `findRepoRoot` falls back to the working directory where no `.git` is found, which in `$HOME`
   * makes `.claude/settings.json` Claude Code's *user-level* settings file. Merging a hook that
   * only makes sense for one repo into the file that governs every session in every repo is not a
   * thing to warn about and then do anyway.
   */
  if (isSamePath(repoRoot, os.homedir())) {
    emitReport(
      [
        error(
          `${repoRoot} is your home directory rather than a repository — ` +
            "init is refusing to write anything",
        ),
        error(
          `${SETTINGS_REL} there is Claude Code's user-level settings file, so a hook written ` +
            "into it would run in every session in every repo, and the config and .gitignore " +
            "would land in your home directory too. Run init from inside the repo you want " +
            "wired up.",
        ),
      ],
      [],
      null,
    );
    return 1;
  }

  const preflight: Diagnostic[] = [];

  if (gitRoot === null) {
    preflight.push(
      warning(
        `no .git was found at or above ${repoRoot}, so this is not a checkout — "the repo" here ` +
          "is that one directory, and every path below is relative to it. Check it is the one " +
          "you meant before applying this.",
      ),
    );
  }

  /**
   * Searched up to the git root rather than at the repo root alone: a config in `packages/api`
   * puts the repo root there, while the `.pnp.cjs` that decides whether `node_modules` exists at
   * all sits at the top of the checkout.
   */
  const pnp = findPnpFile(repoRoot, gitRoot);
  if (pnp !== null) {
    emitReport(
      [
        error(
          `${pnp} exists, so this repo uses Yarn Plug'n'Play — init is refusing to write anything`,
        ),
        error(
          "Yarn PnP has no node_modules, so every path-based invocation of this tool breaks: the " +
            "SessionStart hook would be written, would silently never run, and no session would " +
            "ever report it. Yarn PnP is out of scope by decision, not by oversight. Use the " +
            "node-modules linker (`nodeLinker: node-modules` in .yarnrc.yml) and re-run.",
        ),
      ],
      [],
      null,
    );
    return 1;
  }

  /**
   * The same failure the PnP refusal exists to prevent — a hook that is written, never runs, and
   * is never reported — reached by the ordinary route of not having installed yet, or of being in
   * a `git worktree` made by hand, which has no `node_modules` of its own. A warning rather than a
   * refusal, because unlike PnP this is a state that ends by itself, and it changes nothing about
   * the command string: that must stay byte-stable whatever is on disk today. It now names a
   * remedy, because the `.worktreeinclude` step below is one for the worktree half of it.
   */
  if (!pathExists(path.join(repoRoot, ...CLI_REL.split("/")))) {
    preflight.push(
      warning(
        `${path.join(repoRoot, ...CLI_REL.split("/"))} does not exist, so the SessionStart hook ` +
          "would fail at every session start — silently, because the hook is fail-soft. Install " +
          "this package here and it starts working. In a worktree Claude Code created, the " +
          ".worktreeinclude below carries the main checkout's install across instead, so that is " +
          "the install to do; one made by hand with `git worktree add` is copied into by nothing " +
          "and needs its own. The hook string is written the same either way, since it must stay " +
          "stable.",
      ),
    );
  }

  const plan = planInit(config, loaded.diagnostics);
  emitReport([...preflight, ...plan.diagnostics], [], null);
  emitLines(renderPlan(plan, repoRoot, write));

  if (!write) return plan.steps.some((step) => step.refused === true) ? 1 : 0;

  let failed = false;
  const applied: Diagnostic[] = [];
  for (const step of plan.steps) {
    if (step.after === null || step.after === step.before) continue;
    try {
      applyStep(step, repoRoot);
    } catch (cause) {
      failed = true;
      applied.push(error(`cannot write ${step.path}: ${describe(cause)}`));
    }
  }
  emitReport(applied, [], null);
  return failed || plan.steps.some((step) => step.refused === true) ? 1 : 0;
}

function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findPnpFile(repoRoot: string, gitRoot: string | null): string | null {
  const stop = gitRoot === null ? path.resolve(repoRoot) : path.resolve(gitRoot);
  let dir = path.resolve(repoRoot);
  for (;;) {
    for (const name of PNP_FILENAMES) {
      const candidate = path.join(dir, name);
      if (pathExists(candidate)) return candidate;
    }
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function planInit(config: Config, configDiagnostics: Diagnostic[] = []): InitPlan {
  const repoRoot = config.repoRoot;
  const diagnostics: Diagnostic[] = [];

  /**
   * A config that does not exist yet has no diagnostics worth reporting — "no usable source roots"
   * is the state `init` is here to end, and reporting it describes the world before the diff
   * rather than after it. A config that *does* exist is a file the developer wrote, so what the
   * loader made of it is theirs to see.
   */
  if (config.configPath !== null) diagnostics.push(...configDiagnostics);

  const steps = [
    configStep(config),
    gitignoreStep(config, diagnostics),
    settingsStep(repoRoot, diagnostics),
    worktreeincludeStep(config, diagnostics),
  ]
    .map((step) => refuseSymlinkedPath(step, repoRoot, diagnostics))
    .map((step) => refuseUnwritablePath(step, diagnostics));

  return { steps, diagnostics, notes: postinstallNote() };
}

/**
 * Deliberately advice rather than a step. The reasons, in the order they bite:
 *
 * - `package.json` is a repo's identity, and merging a `scripts` key that may already hold a
 *   chained `postinstall` is a far worse thing to get wrong than a settings file — the tool's
 *   riskiest write, bought for no matching payoff.
 * - Many consuming repos are not npm packages at all, and have no `package.json` to add it to.
 * - It is a mitigation, never a guarantee: `--ignore-scripts` skips it entirely, which is the
 *   configuration the motivating repo's Docker builds are one flag away from.
 * - A consuming repo that is *itself* published would run this inside its own dependents'
 *   `node_modules`. It does not compile into their trees: a package shipping its own config
 *   anchors `repoRoot` at that config's directory and stays inside `node_modules/<pkg>`, and the
 *   ordinary `files: ["dist"]` shape resolves the dependent's root with zero source roots and so
 *   compiles nothing. What it does leave is a stray `.composable-skills/` state directory at the
 *   dependent's repo root — invariant 7, breached by a line `init` wrote.
 */
function postinstallNote(): string[] {
  return [
    "",
    "Not written, on purpose: a `postinstall` script. A fresh clone has no compiled skills until",
    "the first session, because Claude Code does not watch a skills directory that did not exist",
    "at session start. If this repo is an application rather than a published package, adding one",
    "yourself closes that window:",
    "",
    '    "postinstall": "node node_modules/composable-skills/dist/cli.js build || true"',
    "",
    "It must stay fail-soft (`|| true`): it runs inside image builds. init does not write it,",
    "because `package.json` is a repo's identity and a riskier merge than a settings file, many",
    "repos are not npm packages at all, and `--ignore-scripts` voids it anyway — a mitigation,",
    "never a guarantee. A repo that is itself published would also leave a stray",
    "`.composable-skills/` directory in every repo that depends on it.",
  ];
}

function configStep(config: Config): InitStep {
  const target = path.join(config.repoRoot, CONFIG_REL);
  if (config.configPath !== null) {
    return {
      path: config.configPath,
      before: config.configText,
      after: null,
      note: "a config already exists — left exactly as it is",
    };
  }
  return {
    path: target,
    before: null,
    after: configTemplate(deriveId(config.repoRoot)),
    note: `"id" is derived from the directory name to get you started — it is yours to change`,
  };
}

/**
 * A starting point, not a derivation: `id` is declared by invariant 5 precisely because a path
 * cannot say it. A worktree at `.claude/worktrees/feat-x` and its main checkout must resolve one
 * set of overrides, and two unrelated clones both named `api` must not collide — neither of which
 * a directory name can settle. The written config says so beside the value.
 */
export function deriveId(repoRoot: string): string {
  const base = path.basename(path.resolve(repoRoot));
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned !== "" && isValidId(cleaned) ? cleaned : "repo";
}

function configTemplate(id: string): string {
  return `// composable-skills — locations only, never content.
{
  // Stable identity for this repo, declared and never derived from its path: a worktree and the
  // main checkout are one repo and must resolve the same overrides, and two unrelated clones both
  // called "api" must not collide. Derived from the directory name only to get you started —
  // change it to whatever names this repo, and keep it stable afterwards.
  "id": ${JSON.stringify(id)},

  // Template roots. A path, or an installed package. Later entries replace an earlier entry's
  // skill of the same name wholesale. Nothing compiles until this directory holds a skill
  // directory with a SKILL.md.tmpl in it. Until the directory exists at all, every build reports
  // it as an error and build --check exits non-zero: create it, or repoint this entry at an
  // installed package.
  //
  // The trailing comma is deliberate and is not a typo: this file is JSONC, the loader strips a
  // trailing comma, and without one the very next thing this file invites you to do — uncomment a
  // line below — would produce a config that cannot be parsed. A fatal config exits 0 under the
  // session hook, so the only place that failure would surface is the build log.
  "sources": [${JSON.stringify(DEFAULT_SOURCE_ENTRY)}],

  // The defaults for the other two lists, shown rather than set. Uncomment either, or both.
  // "overrides": ["\${home}/global", "./.claude/skills-local", "\${home}/repos/\${id}"],
  // "targets": ["./.claude/skills"],
}
`;
}

function gitignoreStep(config: Config, diagnostics: Diagnostic[]): InitStep {
  const target = path.join(config.repoRoot, GITIGNORE_REL);
  const read = readIfPresent(target);
  /**
   * A symlinked path keeps the symlink verdict — `refuseSymlinkedPath` gives it — whatever verdict
   * its contents would otherwise earn, which includes a link this process cannot read through.
   */
  if (read.kind === "unreadable" && firstSymlinkComponent(config.repoRoot, target) === null) {
    return unreadableRefusal(target, read.cause, diagnostics);
  }
  const before = read.kind === "present" ? read.text : null;

  const wanted = [`/${STATE_DIR}/`];
  for (const root of config.targets) {
    // A target outside the repo — `~/.claude/skills` is the blessed one — is nothing this repo's
    // .gitignore can speak about.
    if (!isUnder(config.repoRoot, root.path)) continue;
    wanted.push(`/${path.relative(config.repoRoot, root.path).split(path.sep).join("/")}/`);
  }

  const covered = new Set((before ?? "").split("\n").filter(statesAPattern).map(ignoreKey));
  const missing = [...new Set(wanted)].filter((entry) => !covered.has(ignoreKey(entry)));

  /**
   * `wanted` always holds the state directory, so a file that covers everything had to exist to
   * cover it — there is no "nothing generated to ignore" case to describe.
   */
  if (missing.length === 0) {
    return {
      path: target,
      before,
      after: null,
      note: "every generated path is already ignored — no line was touched",
    };
  }

  const eol = before === null ? "\n" : dominantEol(before);
  const block = [
    "# composable-skills — compiled skills and build state, generated, never tracked",
    ...missing,
  ];
  const appended = `${block.join(eol)}${eol}`;
  const after =
    before === null ? appended : `${before}${before.endsWith("\n") ? "" : eol}${eol}${appended}`;

  return {
    path: target,
    before,
    after,
    note: before === null ? "created" : "appended — no existing line is rewritten",
  };
}

/**
 * Claude Code copies a file into a worktree it creates only where the file matches a
 * `.worktreeinclude` pattern **and** git ignores it, so this file can speak about nothing but
 * generated paths — which is every path that has to arrive by some route other than the checkout.
 * Two of them:
 *
 * - the tool's own package directory, because `HOOK_COMMAND` names a literal path under the
 *   project directory and walks no chain of its own. Absent there, the hook fails at every
 *   session start, silently, because it is fail-soft.
 * - every in-repo target, because a skills directory that was not there when the session started
 *   is not picked up. A worktree whose targets arrive only when its own first build creates them
 *   spends that entire first session with no skills, hook or no hook.
 *
 * Deliberately not a third: a package named in `sources` resolves in these worktrees already.
 * `findPackageRoot` walks `node_modules` upward from the repo root, and every worktree this file
 * governs is nested under the main checkout at `.claude/worktrees/`, so the walk reaches the main
 * checkout's install. The one arrangement that puts a worktree somewhere else is a
 * `WorktreeCreate` hook, which is also the one case where `.worktreeinclude` is not read at all —
 * so there is no case in which copying a source package would help.
 */
function worktreeincludeStep(config: Config, diagnostics: Diagnostic[]): InitStep {
  const target = path.join(config.repoRoot, WORKTREEINCLUDE_REL);
  const read = readIfPresent(target);
  /** The symlink verdict outranks this one, exactly as it does for the `.gitignore`. */
  if (read.kind === "unreadable" && firstSymlinkComponent(config.repoRoot, target) === null) {
    return unreadableRefusal(target, read.cause, diagnostics);
  }
  const before = read.kind === "present" ? read.text : null;

  /**
   * The whole package directory rather than `dist/` alone. The shipped bundle is ESM, and what
   * makes node read it as ESM is the `"type": "module"` in the `package.json` beside it — copy
   * `dist/` on its own and node throws `Cannot use import statement outside a module` before the
   * build does anything at all.
   *
   * Taken by dropping `dist/cli.js` from the tail rather than by keeping the first two segments,
   * which would be `node_modules/@acme` if this package were ever published under a scope — and
   * would copy a whole npm scope into every worktree.
   */
  const wanted = [`/${CLI_REL.split("/").slice(0, -2).join("/")}/**`];
  for (const root of config.targets) {
    // A target outside the repo — `~/.claude/skills` is the blessed one — is not a path a worktree
    // copy can reach, and not one this repo's .worktreeinclude can speak about.
    if (!isUnder(config.repoRoot, root.path)) continue;
    const rel = path.relative(config.repoRoot, root.path).split(path.sep).join("/");
    /**
     * The ownership marker gets a pattern of its own beside the contents. A skill directory that
     * arrives without its marker is one this tool may never write to or prune again — every build
     * in that worktree warns that it was not written by this tool and leaves it exactly as it is,
     * so a stale skill sits in front of the model forever.
     *
     * The line is redundant today: `**` was measured matching the marker on Claude Code 2.1.263.
     * It is kept because that behaviour is undocumented, and this copier's treatment of a
     * wholly-ignored directory already changed once, at 2.1.239. So the line is insurance against
     * drift rather than cover for ignorance, and what it insures against is permanent.
     */
    wanted.push(`/${rel}/**`, `/${rel}/**/${OWNER_MARKER}`);
  }

  const covered = new Set(
    (before ?? "").split("\n").filter(statesAPattern).map(worktreeIncludeKey),
  );
  const missing = [...new Set(wanted)].filter((entry) => !covered.has(worktreeIncludeKey(entry)));

  /**
   * `wanted` always holds the package directory, so a file that covers everything had to exist to
   * cover it — there is no "nothing to carry across" case to describe.
   */
  if (missing.length === 0) {
    return {
      path: target,
      before,
      after: null,
      note: "a worktree already gets the tool and the compiled skills — no line was touched",
    };
  }

  const eol = before === null ? "\n" : dominantEol(before);
  const block = [
    "# composable-skills — the tool and its compiled skills, so a worktree Claude Code creates",
    "# has both in its first session. Only gitignored files are copied, which is all of these.",
    ...missing,
  ];
  const appended = `${block.join(eol)}${eol}`;
  const after =
    before === null ? appended : `${before}${before.endsWith("\n") ? "" : eol}${eol}${appended}`;

  return {
    path: target,
    before,
    after,
    note: before === null ? "created" : "appended — no existing line is rewritten",
  };
}

/** A comment or a blank states no pattern, so it covers nothing. */
function statesAPattern(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
}

/** The anchoring `/` is not part of what a line matches. */
function ignoreKey(line: string): string {
  return line.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Deliberately stricter than `ignoreKey`, which is why it is a second function rather than an
 * argument to that one. Both files are in gitignore syntax, but only one of them is read by git:
 * a `.worktreeinclude` is read by Claude Code's copier, so `dir/` covering `dir/**` is a claim
 * about a matcher this repo does not own and has never tested. Git's own equivalence comes from
 * pruning the tree during traversal; a copier that enumerates candidate files and tests each path
 * could just as reasonably read `dir/` as naming the directory alone.
 *
 * The failure modes decide it. A key that is too strict costs a redundant line in a file nobody
 * reads twice. A key that is too loose omits a line the worktree needs, and the result is a
 * worktree quietly missing its tool or its skills — which is the exact silent breakage this whole
 * feature exists to end.
 */
function worktreeIncludeKey(line: string): string {
  return line.trim().replace(/^\/+/, "");
}

/**
 * The diff is the *dry run's* contract — "prints exactly what it would do". Under `--write` the
 * doing has happened, and reprinting forty lines of `+` after the fact buries the notes and the
 * refusals under a description of a file the developer can now simply read.
 */
export function renderPlan(plan: InitPlan, repoRoot: string, write: boolean): string[] {
  const out: string[] = [
    write ? `init: writing into ${repoRoot}` : `init: dry run in ${repoRoot}`,
    "",
  ];

  for (const step of plan.steps) {
    const shown = path.relative(repoRoot, step.path) || step.path;
    if (step.after === null || step.after === step.before) {
      const mark =
        step.refused === true ? "refused" : step.blocked === true ? "not done" : "unchanged";
      out.push(`  ${mark}  ${shown} — ${step.note}`);
      continue;
    }
    const verb = step.before === null ? "create" : "update";
    out.push(`  ${write ? verb : `would ${verb}`}  ${shown} — ${step.note}`);
    if (write) continue;
    out.push(...unifiedDiff(step.before ?? "", step.after).map((line) => `    ${line}`));
    out.push("");
  }

  if (write) out.push("");
  const changes = plan.steps.filter((step) => step.after !== null && step.after !== step.before);
  const stuck = plan.steps.filter((step) => step.refused === true || step.blocked === true);
  if (changes.length === 0) {
    out.push(
      stuck.length === 0
        ? "Nothing to do — this repo is already wired up."
        : `Nothing was applied: ${stuck.length} step${stuck.length === 1 ? " is" : "s are"} yours ` +
            "to resolve by hand — see above.",
    );
  } else if (!write) {
    out.push("Nothing was written. Re-run with --write to apply this.");
  }
  out.push(...plan.notes);
  return out;
}
