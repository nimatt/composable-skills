import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config, Diagnostic } from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { isValidId, loadConfig, parseJsonc } from "./config.ts";
import { STATE_DIR } from "./layout.ts";
import { emitLines, emitReport } from "./report.ts";

/**
 * Written literally and byte-stably. Codex pins hook trust to the hash of the command string, so
 * a string that changes spontaneously re-prompts every developer on the team; that is also why no
 * behaviour is expressed as a flag here — all logic lives in the tool. `$CLAUDE_PROJECT_DIR` is
 * expanded by Claude Code, which keeps the string identical in every clone and every worktree.
 */
export const HOOK_COMMAND =
  'node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build';

export const SETTINGS_REL = ".claude/settings.json";
export const CONFIG_REL = "composable-skills.jsonc";
export const GITIGNORE_REL = ".gitignore";

/**
 * Read for detection and never written. Claude Code merges hooks from the project file, this one,
 * and the user-level file, so a hook already present in either of the other two is a hook this
 * repo does not need a second copy of.
 */
export const LOCAL_SETTINGS_REL = ".claude/settings.local.json";

/** Yarn 2 wrote `.pnp.js`; Yarn 3+ writes `.pnp.cjs`. Either one means there is no `node_modules`. */
export const PNP_FILENAMES = [".pnp.cjs", ".pnp.js"] as const;

/** What `HOOK_COMMAND` will resolve to at session start, once `$CLAUDE_PROJECT_DIR` is expanded. */
export const CLI_REL = "node_modules/composable-skills/dist/cli.js";

/** The `sources` entry a fresh config points at. A suggestion; the developer owns the layout. */
export const DEFAULT_SOURCE_ENTRY = "./skills/templates";

/** U+FEFF, spelled rather than written, since the character itself is invisible in this file. */
const BOM = "\uFEFF";

export interface InitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Diff-first: without this nothing is written, whatever the plan says. */
  write?: boolean;
}

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
        error(`${pnp} exists, so this repo uses Yarn Plug'n'Play — init is refusing to write anything`),
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
   * a fresh `git worktree`, which has no `node_modules` of its own. A warning rather than a
   * refusal, because unlike PnP this is a state that ends by itself, and it changes nothing about
   * the command string: that must stay byte-stable whatever is on disk today.
   */
  if (!fileExists(path.join(repoRoot, ...CLI_REL.split("/")))) {
    preflight.push(
      warning(
        `${path.join(repoRoot, ...CLI_REL.split("/"))} does not exist, so the SessionStart hook ` +
          "would fail at every session start — silently, because the hook is fail-soft. Install " +
          "this package in this repo (a fresh git worktree needs its own install) and it starts " +
          "working; the hook string is written the same either way, since it must stay stable.",
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

/**
 * Every path `init` writes is derived from the repo root it resolved, never from anything a
 * config or a template said, and this asserts it once more before the write — invariant 7 is the
 * one property of this verb that a bug must not be able to break quietly.
 */
function applyStep(step: InitStep, repoRoot: string): void {
  if (!isInsideRepo(repoRoot, step.path)) throw new Error(`refusing to write outside ${repoRoot}`);
  const hop = firstSymlinkComponent(repoRoot, step.path);
  if (hop !== null) throw new Error(`refusing to write through the symlink at ${hop}`);
  fs.mkdirSync(path.dirname(step.path), { recursive: true });
  const staging = `${step.path}.composable-skills-tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(staging, step.after ?? "", "utf8");
  try {
    /**
     * A rename replaces the inode, so the mode of the file being edited is not carried over by
     * anything but this. A `600` settings file is a decision, and a merge that silently widens it
     * to the umask default is a permission change nobody asked for and nobody would see.
     */
    const mode = fileMode(step.path);
    if (mode !== null) fs.chmodSync(staging, mode);
    fs.renameSync(staging, step.path);
  } catch (cause) {
    fs.rmSync(staging, { force: true });
    throw cause;
  }
}

/**
 * Invariant 7's predicate, once. It was written out at three call sites, which is three chances
 * for one of them to drift into a text comparison that a `..` component walks straight out of.
 */
function isInsideRepo(repoRoot: string, candidate: string): boolean {
  const relative = path.relative(repoRoot, candidate);
  return relative !== "" && !path.isAbsolute(relative) && !relative.split(path.sep).includes("..");
}

/**
 * Compared by real path as well as by text, because a home directory is so often reached through
 * one — an automount, a `/home` symlink — and this is the one comparison whose false negative
 * writes a per-repo hook into every session on the machine.
 */
function isSamePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
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
      if (fileExists(candidate)) return candidate;
    }
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function fileMode(candidate: string): number | null {
  try {
    return fs.statSync(candidate).mode & 0o7777;
  } catch {
    return null;
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

  const steps = [configStep(config), gitignoreStep(config), settingsStep(repoRoot, diagnostics)]
    .map((step) => refuseSymlinkedPath(step, repoRoot, diagnostics))
    .map((step) => refuseUnwritablePath(step, diagnostics));

  return { steps, diagnostics, notes: postinstallNote() };
}

/**
 * Invariant 7 stated in paths rather than in path *text*: `ln -s ~/dotfiles/claude .claude` makes
 * `.claude/settings.json` a name inside the repo for a file outside it, and writing through it
 * would edit a file `init` was never pointed at. Refused rather than followed, per invariant 8,
 * and refused in the plan so a dry run says so instead of a `--write` discovering it.
 */
function refuseSymlinkedPath(step: InitStep, repoRoot: string, diagnostics: Diagnostic[]): InitStep {
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
function symlinkRefusal(
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
 * A mode that denies writing is a decision somebody made about that file. `rename(2)` does not
 * consult it — the staging swap replaces a `444` file without complaint — so the mode has to be
 * read and honoured here or it means nothing at all.
 */
function refuseUnwritablePath(step: InitStep, diagnostics: Diagnostic[]): InitStep {
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
function firstSymlinkComponent(repoRoot: string, target: string): string | null {
  if (!isInsideRepo(repoRoot, target)) return null;
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
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
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
  // directory with a SKILL.md.tmpl in it.
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

function gitignoreStep(config: Config): InitStep {
  const target = path.join(config.repoRoot, GITIGNORE_REL);
  const before = readIfPresent(target);

  const wanted = [`/${STATE_DIR}/`];
  for (const root of config.targets) {
    // A target outside the repo — `~/.claude/skills` is the blessed one — is nothing this repo's
    // .gitignore can speak about.
    if (!isInsideRepo(config.repoRoot, root.path)) continue;
    wanted.push(`/${path.relative(config.repoRoot, root.path).split(path.sep).join("/")}/`);
  }

  const covered = new Set(
    (before ?? "").split("\n").map(ignoreKey).filter((key): key is string => key !== null),
  );
  const missing = [...new Set(wanted)].filter((entry) => !covered.has(ignoreKey(entry)!));

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
  const block = ["# composable-skills — compiled skills and build state, generated, never tracked", ...missing];
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

/** Comments, blanks and the anchoring `/` are not part of what a line matches. */
function ignoreKey(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function settingsStep(repoRoot: string, diagnostics: Diagnostic[]): InitStep {
  const target = path.join(repoRoot, SETTINGS_REL);

  /**
   * Before the file is read rather than after, so that every verdict below is a verdict about a
   * file inside this repo. Reading through `.claude -> ~/dotfiles/claude` and then reporting on
   * what was found there describes — and offers remedies for — someone else's file.
   */
  const hop = firstSymlinkComponent(repoRoot, target);
  if (hop !== null) return symlinkRefusal(target, hop, repoRoot, diagnostics);

  warnAboutMergedSettings(repoRoot, diagnostics);

  const raw = readIfPresent(target);
  if (raw === null) {
    return {
      path: target,
      before: raw,
      after: `${JSON.stringify({ hooks: { SessionStart: [hookGroup()] } }, null, 2)}\n`,
      note: "created",
    };
  }

  const before = raw;
  /**
   * A BOM is stripped and re-emitted rather than rejected, the same way the frontmatter rule
   * treats one: a Windows editor or a PowerShell redirect writes it invisibly, and the file the
   * developer sees is the file this should read.
   */
  const bom = before.startsWith(BOM) ? BOM : "";
  const body = before.slice(bom.length);
  const eol = dominantEol(body);
  const emit = (value: unknown): string => `${bom}${applyEol(stringifyLike(body, value), eol)}`;

  /**
   * `touch .claude/settings.json` produces a file with nothing in it to preserve, so there is
   * nothing for a refusal to protect.
   */
  if (body.trim() === "") {
    return {
      path: target,
      before,
      after: `${bom}${applyEol(`${JSON.stringify({ hooks: { SessionStart: [hookGroup()] } }, null, 2)}\n`, eol)}`,
      note: "was empty — written with only our hook",
    };
  }

  const refuse = (why: string): InitStep => {
    diagnostics.push(
      error(
        `${target} ${why} — init will not rewrite it. Add this to hooks.SessionStart by hand: ` +
          JSON.stringify(hookGroup()),
      ),
    );
    return { path: target, before, after: null, note: why, refused: true };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    /**
     * A settings file with comments in it parses under our JSONC reader and would round-trip
     * through `JSON.stringify` with every comment deleted. Silently destroying a developer's
     * annotations is exactly the first-contact damage this verb must not do, so it is refused
     * with the same finality as a syntax error.
     */
    if (parsesAsJsonc(body)) {
      return refuse("contains comments or trailing commas, which a rewrite would delete");
    }
    return refuse(`is not valid JSON (${describe(cause)})`);
  }
  if (!isPlainObject(parsed)) return refuse("does not contain a JSON object");

  const rawHooks = parsed["hooks"];
  if (rawHooks !== undefined && !isPlainObject(rawHooks)) return refuse('has a "hooks" key that is not an object');
  const hooks = isPlainObject(rawHooks) ? rawHooks : {};

  const rawSessionStart = hooks["SessionStart"];
  if (rawSessionStart !== undefined && !Array.isArray(rawSessionStart)) {
    return refuse('has a "hooks.SessionStart" key that is not an array');
  }
  const sessionStart = Array.isArray(rawSessionStart) ? rawSessionStart : [];
  if (!sessionStart.every(isHookGroup)) {
    return refuse('has a "hooks.SessionStart" entry this tool does not recognise');
  }

  const commands = sessionStart.flatMap((group) =>
    (group["hooks"] as Record<string, unknown>[]).map((entry) => entry["command"]),
  );
  if (commands.includes(HOOK_COMMAND)) {
    return { path: target, before, after: null, note: "the SessionStart hook is already there" };
  }
  /**
   * A near-miss is not an absence. A hook that runs this tool under a different string — an older
   * `init`'s resolved path, a hand-written entry — already rebuilds every session, and appending
   * ours beside it would build twice per session forever. Reported, and left to the developer,
   * because only they know which string they meant to keep.
   */
  const existing = commands.find((command) => typeof command === "string" && invokesThisTool(command));
  if (typeof existing === "string") {
    diagnostics.push(
      warning(
        `${target} already runs this tool at SessionStart under a different command string ` +
          `(${existing}) — left alone rather than adding a second hook that would build twice ` +
          `every session. The string init writes is: ${HOOK_COMMAND}`,
      ),
    );
    return {
      path: target,
      before,
      after: null,
      blocked: true,
      note: "NOT installed — this repo already runs the tool under another command string",
    };
  }

  const next: Record<string, unknown> = { ...parsed };
  next["hooks"] = { ...hooks, SessionStart: [...sessionStart, hookGroup()] };
  return {
    path: target,
    before,
    after: emit(next),
    note: "the SessionStart hook is appended; every other key is preserved",
  };
}

/**
 * Whether a command line *runs this tool*, as opposed to merely containing its name. The two are
 * easy to confuse and expensive to confuse: matching the bare name anywhere in the string makes
 * `echo building composable-skills docs` — or any path under a directory of that name — look like
 * an installed hook, which silently cancels the one thing this verb exists to do.
 */
export function invokesThisTool(command: string): boolean {
  const tokens = tokenise(command).map((token) => token.replaceAll("\\", "/"));
  return tokens.some((token, index) => {
    if (token.endsWith(INSTALLED_TAIL)) return true;
    const segments = token.split("/");
    const base = segments[segments.length - 1] ?? "";
    /**
     * The bin shim, or this tool's entry point reached by some other path — always with the verb
     * after it, because a bare word is a word and only an argv position makes it a program.
     */
    const runsIt =
      base === "composable-skills" ||
      base === "composable-skills.cmd" ||
      (base === "cli.js" && segments.slice(0, -1).includes("composable-skills"));
    return runsIt && tokens[index + 1] === "build";
  });
}

/** `composable-skills/dist/cli.js` — the tail of `CLI_REL` that identifies an installed copy. */
const INSTALLED_TAIL = CLI_REL.split("/").slice(-3).join("/");

/** Enough shell to tell one argv word from the next; quoting is all this needs to survive. */
function tokenise(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let open = false;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) tokens.push(current);
      current = "";
      open = false;
      continue;
    }
    current += ch;
    open = true;
  }
  if (open) tokens.push(current);
  return tokens;
}

/**
 * Claude Code merges `hooks` from the project settings, the untracked local settings, and the
 * user-level file. `init` writes only the first, but a hook already present in either of the
 * others builds twice at every session start, and nothing else would ever say so. Read-only, in
 * both directions: neither file is ever written, and neither one stops the project file's merge.
 */
function warnAboutMergedSettings(repoRoot: string, diagnostics: Diagnostic[]): void {
  const elsewhere = [
    {
      path: path.join(repoRoot, ...LOCAL_SETTINGS_REL.split("/")),
      whose: "this repo's untracked personal settings",
    },
    { path: path.join(os.homedir(), ".claude", "settings.json"), whose: "your user-level settings" },
  ];
  for (const candidate of elsewhere) {
    const text = readIfPresent(candidate.path);
    if (text === null) continue;
    if (!sessionStartCommands(text).some(invokesThisTool)) continue;
    diagnostics.push(
      warning(
        `${candidate.path} — ${candidate.whose} — already runs this tool at SessionStart. Claude ` +
          "Code merges hooks from every settings file it reads, so wiring this repo up as well " +
          "builds twice at every session start. init only read that file and will never write it.",
      ),
    );
  }
}

/** Every SessionStart command string a settings file holds, or none where it cannot be read. */
function sessionStartCommands(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text.startsWith(BOM) ? text.slice(BOM.length) : text);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const hooks = parsed["hooks"];
  if (!isPlainObject(hooks)) return [];
  const sessionStart = hooks["SessionStart"];
  if (!Array.isArray(sessionStart)) return [];
  return sessionStart.flatMap((group) => {
    if (!isPlainObject(group)) return [];
    const entries = group["hooks"];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      if (!isPlainObject(entry)) return [];
      const command = entry["command"];
      return typeof command === "string" ? [command] : [];
    });
  });
}

/** No matcher: a SessionStart hook with none runs for every session source, which is the intent. */
function hookGroup(): Record<string, unknown> {
  return { hooks: [{ type: "command", command: HOOK_COMMAND }] };
}

function isHookGroup(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const entries = value["hooks"];
  return Array.isArray(entries) && entries.every(isPlainObject);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsesAsJsonc(text: string): boolean {
  try {
    parseJsonc(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Round-tripping JSON is the most a merge can preserve, so it preserves what it can: the file's
 * own indentation and whether it ended with a newline. Key order survives `JSON.parse` for every
 * key that is not an array index, which covers a settings file.
 */
function stringifyLike(original: string, value: unknown): string {
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? "  ";
  const text = JSON.stringify(value, null, indent);
  return original.endsWith("\n") ? `${text}\n` : text;
}

/**
 * Sniffed the way the indent is, and for the same reason: a merge that rewrites every line ending
 * in the file shows up in the diff as every line changed, rendered by a terminal as every line
 * identical — the developer sees their whole file replaced and is given no way to see why.
 */
function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** Applies to text this tool generated, which is LF-only; it is not a normaliser. */
function applyEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replaceAll("\n", eol);
}

function readIfPresent(candidate: string): string | null {
  try {
    return fs.readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

function fileExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * The diff is the *dry run's* contract — "prints exactly what it would do". Under `--write` the
 * doing has happened, and reprinting forty lines of `+` after the fact buries the notes and the
 * refusals under a description of a file the developer can now simply read.
 */
export function renderPlan(plan: InitPlan, repoRoot: string, write: boolean): string[] {
  const out: string[] = [write ? `init: writing into ${repoRoot}` : `init: dry run in ${repoRoot}`, ""];

  for (const step of plan.steps) {
    const shown = path.relative(repoRoot, step.path) || step.path;
    if (step.after === null || step.after === step.before) {
      const mark = step.refused === true ? "refused" : step.blocked === true ? "not done" : "unchanged";
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

const MAX_DIFF_LINES = 2000;

/**
 * A unified-ish diff, because "prints exactly what it would do" is the whole contract of this verb
 * and a summary of a change to someone's settings file is not that. Three lines of context, and a
 * plain before/after dump past the size where the LCS table stops being cheap.
 */
export function unifiedDiff(before: string, after: string, context = 3): string[] {
  const a = splitKeepingShape(before);
  const b = splitKeepingShape(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return windowedDiff(a, b, context);
  }

  const marked = markChanges(a, b);
  const keep = new Set<number>();
  for (let i = 0; i < marked.length; i++) {
    if (marked[i]!.mark === " ") continue;
    for (let j = Math.max(0, i - context); j <= Math.min(marked.length - 1, i + context); j++) {
      keep.add(j);
    }
  }

  const out: string[] = [];
  let skipped = 0;
  for (let i = 0; i < marked.length; i++) {
    if (!keep.has(i)) {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      out.push(elision(skipped, "unchanged"));
      skipped = 0;
    }
    out.push(`${marked[i]!.mark} ${marked[i]!.text}`);
  }
  if (skipped > 0) out.push(elision(skipped, "unchanged"));
  return out;
}

function elision(count: number, kind: string): string {
  return `  … ${count} ${kind} line${count === 1 ? "" : "s"}`;
}

/**
 * The fallback past the size where the LCS table stops being cheap. It used to dump both whole
 * files, which for a 3000-line settings file is 6000 lines describing a four-line insertion. The
 * insertion point does not need an LCS to find: matching lines at each end are matching lines, and
 * what is left between them is the change.
 */
function windowedDiff(a: string[], b: string[], context: number): string[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const leading = Math.min(context, head);
  const trailing = Math.min(context, tail);
  const out: string[] = [];
  if (head - leading > 0) out.push(elision(head - leading, "unchanged"));
  for (const line of a.slice(head - leading, head)) out.push(`  ${line}`);
  out.push(
    ...capped(
      a.slice(head, a.length - tail).map((line) => `- ${line}`),
      b.slice(head, b.length - tail).map((line) => `+ ${line}`),
    ),
  );
  for (const line of a.slice(a.length - tail, a.length - tail + trailing)) out.push(`  ${line}`);
  if (tail - trailing > 0) out.push(elision(tail - trailing, "unchanged"));
  return out;
}

/** A change big enough to fill this budget is one nobody reads to the end of either. */
function capped(removed: string[], added: string[]): string[] {
  if (removed.length + added.length <= MAX_DIFF_LINES) return [...removed, ...added];
  const half = Math.floor(MAX_DIFF_LINES / 2);
  const shown = (lines: string[], kind: string): string[] =>
    lines.length <= half ? lines : [...lines.slice(0, half), elision(lines.length - half, kind)];
  return [...shown(removed, "further removed"), ...shown(added, "further added")];
}

function splitKeepingShape(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface MarkedLine {
  mark: " " | "-" | "+";
  text: string;
}

function markChanges(a: string[], b: string[]): MarkedLine[] {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: MarkedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ mark: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ mark: "-", text: a[i]! });
      i++;
    } else {
      out.push({ mark: "+", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ mark: "-", text: a[i++]! });
  while (j < b.length) out.push({ mark: "+", text: b[j++]! });
  return out;
}
