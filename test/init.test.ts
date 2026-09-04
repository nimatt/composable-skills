import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { HOOK_COMMAND, deriveId, invokesThisTool, unifiedDiff } from "../src/init.ts";
import { parseJsonc } from "../src/config.ts";
import {
  chmod,
  cleanup,
  exists,
  mkdir,
  modeOf,
  occurrences,
  symlink,
  hasError,
  hasWarning,
  init,
  lines,
  read,
  snapshot,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

/** A repo `init` has never touched: a git checkout with no config of ours in it. */
function freshRepo(repoFiles: Record<string, string> = {}) {
  return workspace({ config: null, git: true, repoFiles });
}

function settingsOf(ws: { repo: string }): unknown {
  return JSON.parse(read(ws.repo, ".claude/settings.json"));
}

/** Every SessionStart command string, so an assertion reads the value rather than its escaping. */
function commandsOf(settings: unknown): unknown[] {
  const hooks = (settings as { hooks?: { SessionStart?: { hooks?: { command?: unknown }[] }[] } }).hooks;
  return (hooks?.SessionStart ?? []).flatMap((group) => (group.hooks ?? []).map((entry) => entry.command));
}

describe("init — diff first", () => {
  test("a dry run writes nothing at all", () => {
    const ws = freshRepo();
    const before = snapshot(ws.root);

    const run = init(ws);

    expect(run.code).toBe(0);
    expect(snapshot(ws.root)).toEqual(before);
    expect(run.stdout).toContain("would create  composable-skills.jsonc");
    expect(run.stdout).toContain("would create  .claude/settings.json");
    expect(run.stdout).toContain("Nothing was written. Re-run with --write to apply this.");
  });

  test("the dry run prints the file contents it would write, line for line", () => {
    const ws = freshRepo();
    const dry = init(ws);
    init(ws, { write: true });

    for (const line of read(ws.repo, ".claude/settings.json").trimEnd().split("\n")) {
      expect(dry.stdout).toContain(`+ ${line}`);
    }
  });

  test("--write creates the config, the ignore lines and the hook", () => {
    const ws = freshRepo();
    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(true);
    expect(read(ws.repo, ".gitignore")).toContain("/.composable-skills/");
    expect(read(ws.repo, ".gitignore")).toContain("/.claude/skills/");
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
  });

  test("running it twice changes nothing the second time", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    const after = snapshot(ws.root);

    const second = init(ws, { write: true });

    expect(second.code).toBe(0);
    expect(snapshot(ws.root)).toEqual(after);
    expect(second.stdout).toContain("Nothing to do — this repo is already wired up.");
  });

  test("the config it writes is one the tool can load", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    const reloaded = init(ws);

    expect(hasError(reloaded)).toBe(false);
    expect(read(ws.repo, "composable-skills.jsonc")).toContain('"id": "repo"');
  });
});

describe("init — the hook command string", () => {
  test("is written literally, byte for byte", () => {
    expect(HOOK_COMMAND).toBe(
      'node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build',
    );

    const ws = freshRepo();
    init(ws, { write: true });
    const settings = settingsOf(ws) as {
      hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] };
    };

    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0]!.hooks).toEqual([
      { type: "command", command: HOOK_COMMAND },
    ]);
  });

  test("carries no flags — every decision belongs to the tool", () => {
    expect(HOOK_COMMAND.endsWith(" build")).toBe(true);
    expect(HOOK_COMMAND).not.toContain("--");
  });
});

describe("init — settings.json merge safety", () => {
  test("absent: the file is created with only our hook", () => {
    const ws = freshRepo();
    init(ws, { write: true });

    expect(settingsOf(ws)).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
    });
  });

  test("present with no hooks key: every unrelated key survives", () => {
    const ws = freshRepo({
      ".claude/settings.json": `${JSON.stringify(
        { permissions: { allow: ["Bash(git status)"] }, model: "opus" },
        null,
        2,
      )}\n`,
    });
    init(ws, { write: true });

    const settings = settingsOf(ws) as Record<string, unknown>;
    expect(settings["permissions"]).toEqual({ allow: ["Bash(git status)"] });
    expect(settings["model"]).toBe("opus");
    expect(commandsOf(settings)).toEqual([HOOK_COMMAND]);
  });

  test("present with other SessionStart hooks: ours is appended, theirs is untouched", () => {
    const theirs = { matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] };
    const ws = freshRepo({
      ".claude/settings.json": `${JSON.stringify(
        { hooks: { SessionStart: [theirs], PreToolUse: [] } },
        null,
        2,
      )}\n`,
    });
    init(ws, { write: true });

    const settings = settingsOf(ws) as {
      hooks: { SessionStart: unknown[]; PreToolUse: unknown[] };
    };
    expect(settings.hooks.SessionStart[0]).toEqual(theirs);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.PreToolUse).toEqual([]);
  });

  test("present with our hook already: the file is not rewritten at all", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    const written = read(ws.repo, ".claude/settings.json");

    const second = init(ws, { write: true });

    expect(read(ws.repo, ".claude/settings.json")).toBe(written);
    expect(second.stdout).toContain("the SessionStart hook is already there");
  });

  test("a hook that runs this tool under a different string is left alone, not duplicated", () => {
    const ws = freshRepo({
      ".claude/settings.json": `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "node ./node_modules/composable-skills/dist/cli.js build" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    });
    const before = read(ws.repo, ".claude/settings.json");

    const run = init(ws, { write: true });

    expect(read(ws.repo, ".claude/settings.json")).toBe(before);
    expect(run.stdout).toContain("already runs this tool at SessionStart under a different command string");
  });

  test("malformed: refused, left byte-identical, and the run exits non-zero", () => {
    const broken = '{ "permissions": { "allow": [ }\n';
    const ws = freshRepo({ ".claude/settings.json": broken });

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(read(ws.repo, ".claude/settings.json")).toBe(broken);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("is not valid JSON");
    expect(run.stdout).toContain("refused  .claude/settings.json");
    // …and it prints what to paste in, since it will not do it itself.
    expect(run.stdout).toContain("$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js");
  });

  test("a refused settings file does not block the config and the ignore lines", () => {
    const ws = freshRepo({ ".claude/settings.json": "{ oops\n" });

    expect(init(ws, { write: true }).code).toBe(1);
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(true);
    expect(read(ws.repo, ".gitignore")).toContain("/.composable-skills/");
  });

  test("comments and trailing commas are refused rather than silently deleted", () => {
    const annotated = '{\n  // keep this\n  "model": "opus",\n}\n';
    const ws = freshRepo({ ".claude/settings.json": annotated });

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(read(ws.repo, ".claude/settings.json")).toBe(annotated);
    expect(run.stdout).toContain("contains comments or trailing commas, which a rewrite would delete");
  });

  test("a settings file that is not an object is refused", () => {
    const ws = freshRepo({ ".claude/settings.json": "[1, 2, 3]\n" });

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(read(ws.repo, ".claude/settings.json")).toBe("[1, 2, 3]\n");
    expect(run.stdout).toContain("does not contain a JSON object");
  });

  test('a "hooks" key that is not an object is refused', () => {
    const ws = freshRepo({ ".claude/settings.json": '{ "hooks": "none" }\n' });

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('has a "hooks" key that is not an object');
  });

  test('a "SessionStart" key that is not an array is refused', () => {
    const ws = freshRepo({ ".claude/settings.json": '{ "hooks": { "SessionStart": {} } }\n' });

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('has a "hooks.SessionStart" key that is not an array');
  });

  test("a SessionStart entry of an unrecognised shape is refused rather than merged over", () => {
    const ws = freshRepo({ ".claude/settings.json": '{ "hooks": { "SessionStart": ["echo hi"] } }\n' });

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("entry this tool does not recognise");
  });

  test("the file's own indentation is preserved", () => {
    const ws = freshRepo({ ".claude/settings.json": '{\n    "model": "opus"\n}\n' });
    init(ws, { write: true });

    expect(read(ws.repo, ".claude/settings.json")).toContain('\n    "hooks": {');
  });
});

describe("init — .gitignore", () => {
  test("existing lines are kept exactly, and the new block is appended after them", () => {
    const before = "node_modules\n*.log\n";
    const ws = freshRepo({ ".gitignore": before });

    init(ws, { write: true });

    const after = read(ws.repo, ".gitignore");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("/.composable-skills/");
  });

  test("a file with no trailing newline is not glued to the new block", () => {
    const ws = freshRepo({ ".gitignore": "node_modules" });
    init(ws, { write: true });

    expect(read(ws.repo, ".gitignore").split("\n")[0]).toBe("node_modules");
    expect(read(ws.repo, ".gitignore")).not.toContain("node_modules#");
  });

  test("an entry already covered is not added again", () => {
    const ws = freshRepo({ ".gitignore": ".composable-skills/\n" });
    init(ws, { write: true });

    const after = read(ws.repo, ".gitignore");
    expect(after.split("\n").filter((line) => line.includes(".composable-skills"))).toHaveLength(1);
    expect(after).toContain("/.claude/skills/");
  });

  test("a fully covered file is not touched at all", () => {
    const before = "/.composable-skills/\n.claude/skills\n";
    const ws = freshRepo({ ".gitignore": before });

    const run = init(ws, { write: true });

    expect(read(ws.repo, ".gitignore")).toBe(before);
    expect(run.stdout).toContain("every generated path is already ignored");
  });

  test("a commented-out line does not count as covering anything", () => {
    const ws = freshRepo({ ".gitignore": "# .composable-skills/\n" });
    init(ws, { write: true });

    expect(read(ws.repo, ".gitignore")).toContain("\n/.composable-skills/\n");
  });

  test("a target outside the repo gets no ignore line, since no .gitignore governs it", () => {
    const ws = workspace({
      git: true,
      config: { id: "acme", sources: [], targets: ["~/.claude/skills", "./.claude/skills"] },
    });
    init(ws, { write: true });

    const after = read(ws.repo, ".gitignore");
    expect(after).toContain("/.claude/skills/");
    expect(after).not.toContain("..");
  });
});

describe("init — the config file", () => {
  test("an existing config is left entirely alone", () => {
    const original = '{ "id": "mine", "sources": ["./x"] }\n';
    const ws = workspace({ git: true, config: original });

    const run = init(ws, { write: true });

    expect(read(ws.repo, "composable-skills.jsonc")).toBe(original);
    expect(run.stdout).toContain("a config already exists — left exactly as it is");
  });

  test("the id is derived from the directory name and said to be the developer's", () => {
    expect(deriveId("/tmp/acme-platform")).toBe("acme-platform");
    expect(deriveId("/tmp/My Repo!")).toBe("My-Repo");
    expect(deriveId("/tmp/!!!")).toBe("repo");

    const ws = freshRepo();
    init(ws, { write: true });
    expect(read(ws.repo, "composable-skills.jsonc")).toContain("declared and never derived from its path");
  });

  test("a config that cannot be parsed stops the run before anything is written", () => {
    const ws = workspace({ git: true, config: "{ nope" });
    const before = snapshot(ws.root);

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(snapshot(ws.root)).toEqual(before);
    expect(hasError(run)).toBe(true);
  });
});

/**
 * `findRepoRoot` falls back to the working directory where no `.git` is found anywhere above, so a
 * mistyped `cd` makes `$HOME` "the repo" — and `~/.claude/settings.json` is Claude Code's
 * *user-level* settings file. A per-project build hook merged there runs in every session in every
 * repo. This is the one comparison whose false negative is unbounded.
 */
describe("init — the home directory is not a repository", () => {
  const USER_LEVEL = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;

  test("refuses outright, writing nothing into the home directory", () => {
    const ws = workspace({ config: null, osHomeFiles: { ".claude/settings.json": USER_LEVEL } });

    const run = init(ws, { cwd: ws.osHome, write: true });

    expect(run.code).toBe(1);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("is your home directory rather than a repository");
    expect(run.stdout).toContain("init is refusing to write anything");
    expect(run.stdout).toContain("would run in every session in every repo");
    // The user-level settings file, the one a false negative would edit, is untouched…
    expect(read(ws.osHome, ".claude/settings.json")).toBe(USER_LEVEL);
    // …and so is everything else it would have written beside it.
    expect(exists(ws.osHome, "composable-skills.jsonc")).toBe(false);
    expect(exists(ws.osHome, ".gitignore")).toBe(false);
    // It refuses before planning, so no diff is offered for a developer to be tempted by.
    expect(run.stdout).not.toContain("would create");
  });

  test("a home directory reached through a symlink is still the home directory", () => {
    const ws = workspace({ config: null, osHomeFiles: { ".claude/settings.json": USER_LEVEL } });
    symlink(ws.osHome, ws.root, "elsewhere-home");

    const run = init(ws, { cwd: path.join(ws.root, "elsewhere-home"), write: true });

    // The resolved text differs; only the `realpath` comparison catches it, and an automounted or
    // symlinked home is the ordinary case rather than the exotic one.
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("is your home directory rather than a repository");
    expect(read(ws.osHome, ".claude/settings.json")).toBe(USER_LEVEL);
    expect(exists(ws.osHome, "composable-skills.jsonc")).toBe(false);
  });

  test("an ordinary repo that merely lives under the home directory is not refused", () => {
    const ws = workspace({ config: null, git: true, osHomeFiles: { ".keep": "" } });
    const inside = path.join(ws.osHome, "dev", "api");
    mkdir(ws.osHome, "dev/api");
    write(inside, { ".git/HEAD": "ref: refs/heads/main\n" });

    const run = init(ws, { cwd: inside, write: true });

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("is your home directory");
    expect(exists(ws.osHome, "dev/api/composable-skills.jsonc")).toBe(true);
    expect(exists(ws.osHome, "composable-skills.jsonc")).toBe(false);
  });
});

describe("init — a directory that is not a checkout", () => {
  test("says loudly that no .git was found, and still offers the plan", () => {
    const ws = workspace({ config: null, git: false });

    const run = init(ws);

    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(`no .git was found at or above ${ws.repo}, so this is not a checkout`);
    expect(run.stdout).toContain("Check it is the one you meant before applying this.");
    // A warning, not a refusal — `init` writes only inside that directory either way.
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("would create  composable-skills.jsonc");
  });

  test("a checkout says nothing of the sort", () => {
    expect(init(freshRepo()).stdout).not.toContain("no .git was found");
  });
});

describe("init — Yarn PnP", () => {
  test("refuses, explains why, and writes nothing", () => {
    const ws = freshRepo({ ".pnp.cjs": "// yarn pnp\n" });
    const before = snapshot(ws.root);

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(snapshot(ws.root)).toEqual(before);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("Yarn Plug'n'Play");
    expect(run.stdout).toContain("would silently never run");
  });

  test("refuses on a dry run too, rather than printing a plan it would refuse to apply", () => {
    const ws = freshRepo({ ".pnp.cjs": "// yarn pnp\n" });

    const run = init(ws);

    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain("would create");
  });

  test(".pnp.js — Yarn 2's spelling — is detected as well as .pnp.cjs", () => {
    const ws = freshRepo({ ".pnp.js": "// yarn 2 pnp\n" });

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`${path.join(ws.repo, ".pnp.js")} exists, so this repo uses Yarn Plug'n'Play`);
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(false);
  });

  test("a .pnp.cjs at the git root is found from a repo root below it", () => {
    const ws = workspace({
      config: null,
      git: true,
      repoFiles: {
        ".pnp.cjs": "// yarn pnp\n",
        "packages/api/composable-skills.jsonc": '{ "id": "api", "sources": ["./templates"] }\n',
      },
    });

    // The config puts the repo root in `packages/api`; the file that decides whether
    // `node_modules` exists at all sits at the top of the checkout.
    const run = init(ws, { cwd: path.join(ws.repo, "packages", "api"), write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`${path.join(ws.repo, ".pnp.cjs")} exists`);
    expect(exists(ws.repo, "packages/api/.claude")).toBe(false);
    expect(exists(ws.repo, "packages/api/.gitignore")).toBe(false);
  });

  test("a .pnp.cjs above the git root belongs to some other tree and is not consulted", () => {
    const ws = freshRepo();
    write(ws.root, { ".pnp.cjs": "// somebody else's yarn pnp\n" });

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("Yarn Plug'n'Play");
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(true);
  });
});

/**
 * The PnP refusal's justification — written, never runs, never reported — reached by the ordinary
 * route: a repo that has not installed yet, or a fresh `git worktree`, which has no `node_modules`
 * of its own and so kills the hook at every session start with nothing downstream to say so.
 */
describe("init — a hook that would never run", () => {
  const CLI_PATH = ["node_modules", "composable-skills", "dist", "cli.js"];

  test("warns that the binary the hook names is not there, and names the worktree case", () => {
    const ws = freshRepo();

    const run = init(ws);

    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(`${path.join(ws.repo, ...CLI_PATH)} does not exist`);
    expect(run.stdout).toContain("would fail at every session start — silently");
    expect(run.stdout).toContain("a fresh git worktree needs its own install");
    // A warning, not a refusal: unlike PnP this is a state that ends by itself.
    expect(run.code).toBe(0);
  });

  test("and the command string is written the same either way, because it must stay stable", () => {
    const ws = freshRepo();
    init(ws, { write: true });

    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
    expect(read(ws.repo, ".claude/settings.json")).toContain("$CLAUDE_PROJECT_DIR");
  });

  test("an installed copy silences it", () => {
    const ws = freshRepo({ [CLI_PATH.join("/")]: "#!/usr/bin/env node\n" });

    const run = init(ws);

    expect(run.stdout).not.toContain("does not exist, so the SessionStart hook");
  });
});

describe("init — writes only inside the repo it is run in", () => {
  test("nothing outside the repo root is created or changed", () => {
    const ws = freshRepo();
    write(ws.home, { "global/.keep": "" });
    const before = snapshot(ws.home);

    init(ws, { write: true });

    expect(snapshot(ws.home)).toEqual(before);
  });

  test("a symlinked .claude is refused rather than written through", () => {
    const ws = freshRepo();
    const outside = mkdir(ws.root, "elsewhere");
    symlink(outside, ws.repo, ".claude");

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("is a symlink, so writing");
    expect(exists(ws.root, "elsewhere/settings.json")).toBe(false);
    // The steps that stay inside the repo still apply — the refusal is this file's, not the run's.
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(true);
  });

  test("run from a subdirectory, it still writes at the repo root", () => {
    const ws = freshRepo({ "src/deep/file.ts": "export {};\n" });

    init(ws, { write: true, cwd: `${ws.repo}/src/deep` });

    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(true);
    expect(exists(ws.repo, "src/deep/composable-skills.jsonc")).toBe(false);
  });
});

/**
 * Matching the bare name anywhere in a command string made `echo building composable-skills docs`
 * look like an installed hook — and the consequence was the worst available one: the hook was
 * silently not installed, and the run then reported success.
 */
describe("invokesThisTool — the invoked program, never the name", () => {
  test("matches a real invocation, however the path is spelled", () => {
    expect(invokesThisTool(HOOK_COMMAND)).toBe(true);
    expect(invokesThisTool("node ./node_modules/composable-skills/dist/cli.js build")).toBe(true);
    expect(invokesThisTool("node /opt/app/node_modules/composable-skills/dist/cli.js build")).toBe(true);
    expect(invokesThisTool("node node_modules\\composable-skills\\dist\\cli.js build")).toBe(true);
    expect(invokesThisTool("composable-skills build")).toBe(true);
    expect(invokesThisTool("npx composable-skills build")).toBe(true);
    expect(invokesThisTool("composable-skills.cmd build")).toBe(true);
    expect(invokesThisTool("./node_modules/.bin/composable-skills build")).toBe(true);
  });

  test("does not match a command that merely mentions the name", () => {
    expect(invokesThisTool("echo building composable-skills docs")).toBe(false);
    expect(invokesThisTool("echo composable-skills")).toBe(false);
  });

  test("does not match a path that merely lives under a directory of that name", () => {
    expect(invokesThisTool("cd /home/me/dev/composable-skills && npm run build")).toBe(false);
    expect(invokesThisTool("bash -c 'cd /home/me/dev/composable-skills && bun run build'")).toBe(false);
    expect(invokesThisTool("cat /home/me/dev/composable-skills/README.md")).toBe(false);
  });

  test("a bare word is a word — only an argv position followed by the verb makes it a program", () => {
    expect(invokesThisTool("composable-skills")).toBe(false);
    expect(invokesThisTool("composable-skills lint")).toBe(false);
    // Someone else's tool that happens to share our entry-point filename, deliberately not matched.
    expect(invokesThisTool("node scripts/cli.js build")).toBe(false);
  });
});

/**
 * The third step state, beside "refused" and "nothing to do": nothing is wrong with the file, but
 * what `init` came to do was not done, and the run must not describe the repo as wired up.
 */
describe("init — a foreign hook that already runs this tool", () => {
  const THEIRS = `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "npx composable-skills build" }] },
        ],
      },
    },
    null,
    2,
  )}\n`;

  test("the step is 'not done', and the run does not claim the repo is already wired up", () => {
    const ws = freshRepo({ ".claude/settings.json": THEIRS });
    init(ws, { write: true });

    // The second run has nothing else left to change, which is where the false summary appeared.
    const second = init(ws, { write: true });

    expect(second.stdout).toContain(
      "not done  .claude/settings.json — NOT installed — this repo already runs the tool under another command string",
    );
    expect(second.stdout).not.toContain("Nothing to do — this repo is already wired up.");
    expect(second.stdout).toContain("Nothing was applied: 1 step is yours to resolve by hand");
    expect(read(ws.repo, ".claude/settings.json")).toBe(THEIRS);
  });

  test("the exit code stays 0 — the repo does rebuild, under a string the developer chose", () => {
    const ws = freshRepo({ ".claude/settings.json": THEIRS });

    expect(init(ws, { write: true }).code).toBe(0);
    expect(init(ws).code).toBe(0);
  });

  test("a hook that merely mentions the name is not mistaken for one, and ours is installed", () => {
    const mentions = `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo building composable-skills docs" }] },
          ],
        },
      },
      null,
      2,
    )}\n`;
    const ws = freshRepo({ ".claude/settings.json": mentions });

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("NOT installed");
    expect(commandsOf(settingsOf(ws))).toEqual([
      "echo building composable-skills docs",
      HOOK_COMMAND,
    ]);
  });
});

describe("init — the shapes a settings.json comes in", () => {
  test("CRLF is preserved rather than rewritten to LF", () => {
    const ws = freshRepo({ ".claude/settings.json": '{\r\n  "model": "opus"\r\n}\r\n' });

    init(ws, { write: true });

    const after = read(ws.repo, ".claude/settings.json");
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
    // Every LF is preceded by a CR: a rewrite of every line ending renders as every line changed
    // and identical, which discloses nothing while disclosing everything.
    expect(occurrences(after, "\n")).toBe(occurrences(after, "\r\n"));
    expect(occurrences(after, "\r\n")).toBeGreaterThan(3);
  });

  test("CRLF is preserved in the .gitignore append too", () => {
    const ws = freshRepo({ ".gitignore": "node_modules\r\n*.log\r\n" });

    init(ws, { write: true });

    const after = read(ws.repo, ".gitignore");
    expect(after).toContain("/.composable-skills/");
    expect(occurrences(after, "\n")).toBe(occurrences(after, "\r\n"));
  });

  test("a BOM is stripped and re-emitted, not rejected and not doubled", () => {
    const ws = freshRepo({ ".claude/settings.json": `﻿{\n  "model": "opus"\n}\n` });

    const run = init(ws, { write: true });

    const after = read(ws.repo, ".claude/settings.json");
    expect(run.code).toBe(0);
    expect(after.startsWith("﻿")).toBe(true);
    expect(occurrences(after, "﻿")).toBe(1);
    expect(commandsOf(JSON.parse(after.slice(1)))).toEqual([HOOK_COMMAND]);
  });

  test("a BOM and CRLF together survive together", () => {
    const ws = freshRepo({ ".claude/settings.json": `﻿{\r\n  "model": "opus"\r\n}\r\n` });

    init(ws, { write: true });

    const after = read(ws.repo, ".claude/settings.json");
    expect(after.startsWith("﻿")).toBe(true);
    expect(occurrences(after, "\n")).toBe(occurrences(after, "\r\n"));
    expect(commandsOf(JSON.parse(after.slice(1)))).toEqual([HOOK_COMMAND]);
  });

  test("an empty file is treated as {} — `touch` leaves nothing for a refusal to protect", () => {
    const ws = freshRepo({ ".claude/settings.json": "" });

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("was empty — written with only our hook");
    expect(settingsOf(ws)).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
    });
  });

  test("a whitespace-only file is treated the same way", () => {
    const ws = freshRepo({ ".claude/settings.json": "  \n\t\n" });

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("was empty — written with only our hook");
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
  });
});

describe("init — a mode is a decision about a file", () => {
  const OWNER_ONLY = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;

  test("chmod 600 survives --write, because a rename replaces the inode", () => {
    const ws = freshRepo({ ".claude/settings.json": OWNER_ONLY });
    chmod(ws.repo, ".claude/settings.json", 0o600);

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
    expect(modeOf(ws.repo, ".claude/settings.json")).toBe(0o600);
  });

  test("a file the process cannot write is refused in the plan, so the dry run says so", () => {
    const ws = freshRepo({ ".claude/settings.json": OWNER_ONLY });
    chmod(ws.repo, ".claude/settings.json", 0o444);

    const dry = init(ws);

    // `rename(2)` does not consult the mode, so refusing here is the only place it means anything.
    expect(dry.code).toBe(1);
    expect(dry.stdout).toContain(
      `${path.join(ws.repo, ".claude", "settings.json")} is not writable (mode 444)`,
    );
    expect(dry.stdout).toContain("refused  .claude/settings.json — not writable — left exactly as it is");
    expect(dry.stdout).not.toContain("would update  .claude/settings.json");
  });

  test("and --write leaves it byte-identical, at the mode it had", () => {
    const ws = freshRepo({ ".claude/settings.json": OWNER_ONLY });
    chmod(ws.repo, ".claude/settings.json", 0o444);

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(read(ws.repo, ".claude/settings.json")).toBe(OWNER_ONLY);
    expect(modeOf(ws.repo, ".claude/settings.json")).toBe(0o444);
    // The steps that are writable still apply — the refusal is that file's, not the run's.
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(true);
  });
});

/**
 * Claude Code merges `hooks` from the project file, the untracked local file, and the user-level
 * file. `init` writes only the first; a hook already in either of the others builds twice at every
 * session start, and nothing else would ever say so. Both are read-only, in both directions.
 */
describe("init — the settings files it reads but never writes", () => {
  const HOOKED = `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "composable-skills build" }] }],
      },
    },
    null,
    2,
  )}\n`;

  test("a hook in this repo's settings.local.json is reported, and that file is not written", () => {
    const ws = freshRepo({ ".claude/settings.local.json": HOOKED });

    const run = init(ws, { write: true });

    expect(run.stdout).toContain(
      `${path.join(ws.repo, ".claude", "settings.local.json")} — this repo's untracked personal settings — already runs this tool at SessionStart`,
    );
    expect(run.stdout).toContain("init only read that file and will never write it.");
    expect(read(ws.repo, ".claude/settings.local.json")).toBe(HOOKED);
    // …and it does not block the project file's merge — the warning is the whole intervention.
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
  });

  test("a hook in the user-level settings file is reported, and that file is not written", () => {
    const ws = workspace({
      config: null,
      git: true,
      osHomeFiles: { ".claude/settings.json": HOOKED },
    });
    const before = snapshot(ws.osHome);

    const run = init(ws, { write: true });

    expect(run.stdout).toContain(
      `${path.join(ws.osHome, ".claude", "settings.json")} — your user-level settings — already runs this tool at SessionStart`,
    );
    expect(snapshot(ws.osHome)).toEqual(before);
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
  });

  /**
   * The hermeticity of every other test in this file, asserted rather than assumed: the user-level
   * file `init` reaches for is the fixture's stand-in `~`, and the developer's own `~/.claude` is
   * named nowhere in the run.
   */
  test("the `~` it reads is the fixture's, never the developer's own home", () => {
    const ws = workspace({
      config: null,
      git: true,
      osHomeFiles: { ".claude/settings.json": HOOKED },
    });

    const run = init(ws);

    expect(run.stdout).toContain(path.join(ws.osHome, ".claude", "settings.json"));
    expect(run.stdout).not.toContain(path.join(os.homedir(), ".claude"));
    expect(ws.osHome.startsWith(os.homedir())).toBe(false);
  });

  test("a merged file that merely mentions the name is not reported", () => {
    const mentions = `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo composable-skills is great" }] },
          ],
        },
      },
      null,
      2,
    )}\n`;
    const ws = freshRepo({ ".claude/settings.local.json": mentions });

    const run = init(ws, { write: true });

    expect(run.stdout).not.toContain("already runs this tool at SessionStart");
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
  });

  test("with no such hook anywhere, nothing is said about either file", () => {
    const ws = freshRepo();

    const run = init(ws, { write: true });

    expect(run.stdout).not.toContain("settings.local.json");
    expect(run.stdout).not.toContain("your user-level settings");
  });
});

/**
 * The config `init` writes invites the developer to uncomment two lines. Doing so used to produce
 * `Expected ',' or '}'` — a fatal config, which exits 0 under the session hook and reaches only
 * `.composable-skills/build.log`, the channel that exists because nobody reads it.
 */
describe("init — the config survives its own invitation", () => {
  function uncomment(text: string, which: number[]): string {
    let seen = -1;
    return text
      .split("\n")
      .map((line) => {
        const match = /^(\s*)\/\/ ("[^"]+"\s*:.*)$/.exec(line);
        if (match === null) return line;
        seen++;
        return which.includes(seen) ? `${match[1]!}${match[2]!}` : line;
      })
      .join("\n");
  }

  test("it invites exactly two lines, and each of them is a key", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    const written = read(ws.repo, "composable-skills.jsonc");

    expect(uncomment(written, [0])).not.toBe(written);
    expect(uncomment(written, [1])).not.toBe(written);
    expect(uncomment(written, [0, 1, 2])).toBe(uncomment(written, [0, 1]));
    expect(uncomment(written, [0, 1])).toContain('"overrides"');
    expect(uncomment(written, [0, 1])).toContain('"targets"');
  });

  for (const which of [[], [0], [1], [0, 1]]) {
    const label = which.length === 0 ? "as written" : `with line(s) ${which.join(" and ")} uncommented`;
    test(`${label}, the config still parses and still loads`, () => {
      const ws = freshRepo();
      init(ws, { write: true });
      const written = read(ws.repo, "composable-skills.jsonc");
      write(ws.repo, { "composable-skills.jsonc": uncomment(written, which) });

      expect(parseJsonc(read(ws.repo, "composable-skills.jsonc"))).toMatchObject({ id: "repo" });

      const reloaded = init(ws);

      expect(reloaded.code).toBe(0);
      expect(hasError(reloaded)).toBe(false);
      expect(reloaded.stdout).toContain("a config already exists — left exactly as it is");
    });
  }

  test("uncommenting the targets line still yields the ignore lines it implies", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    write(ws.repo, {
      "composable-skills.jsonc": uncomment(read(ws.repo, "composable-skills.jsonc"), [1]),
      ".gitignore": "",
    });

    const run = init(ws, { write: true });

    expect(hasError(run)).toBe(false);
    expect(read(ws.repo, ".gitignore")).toContain("/.claude/skills/");
  });
});

describe("init — reporting", () => {
  test("output does not depend on how the streams are wired", () => {
    const separate = init(freshRepo());
    const shared = init(freshRepo(), { streams: "shared" });

    expect(lines(shared).length).toBe(lines(separate).length);
    expect(shared.writes.filter((entry) => entry.stream === "stdout")).toHaveLength(0);
    expect(separate.stdout).toBe(separate.stderr);
  });

  test("it never writes the build log, which belongs to the last build", () => {
    const ws = freshRepo();
    init(ws, { write: true });

    expect(exists(ws.repo, ".composable-skills")).toBe(false);
  });

  test("the postinstall decision is printed rather than acted on", () => {
    const ws = freshRepo({ "package.json": '{ "name": "demo" }\n' });
    const run = init(ws, { write: true });

    expect(run.stdout).toContain("Not written, on purpose: a `postinstall` script");
    expect(read(ws.repo, "package.json")).toBe('{ "name": "demo" }\n');
  });
});

describe("init — the diff renderer", () => {
  test("marks removals and additions around unchanged context", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual(["  a", "- b", "+ B", "  c"]);
  });

  test("elides long stretches of unchanged lines", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const rendered = unifiedDiff(before, `${before}\nnew`);

    expect(rendered[0]).toBe("  … 27 unchanged lines");
    expect(rendered[rendered.length - 1]).toBe("+ new");
  });

  test("a created file is all additions", () => {
    expect(unifiedDiff("", "x\ny\n")).toEqual(["+ x", "+ y"]);
  });

  /**
   * Past the size where the LCS table stops being cheap the renderer used to dump both whole files,
   * which for a four-line insertion into a 3000-line settings file is six thousand lines describing
   * it. Matching lines at each end are matching lines and need no LCS to find.
   */
  test("past the LCS budget it windows the change instead of dumping both files", () => {
    const before = `${Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const after = before.replace(
      "line 1500\n",
      "line 1500\ninserted a\ninserted b\ninserted c\ninserted d\n",
    );

    const rendered = unifiedDiff(before, after);

    expect(rendered).toEqual([
      "  … 1498 unchanged lines",
      "  line 1498",
      "  line 1499",
      "  line 1500",
      "+ inserted a",
      "+ inserted b",
      "+ inserted c",
      "+ inserted d",
      "  line 1501",
      "  line 1502",
      "  line 1503",
      "  … 1496 unchanged lines",
    ]);
  });

  test("and a real settings file past the budget prints tens of lines, not thousands", () => {
    const allow = Array.from({ length: 3000 }, (_, i) => `Bash(command-${i}:*)`);
    const settings = `${JSON.stringify({ permissions: { allow } }, null, 2)}\n`;
    const ws = freshRepo({ ".claude/settings.json": settings });
    expect(settings.split("\n").length).toBeGreaterThan(3000);

    const run = init(ws);

    expect(lines(run).length).toBeLessThan(120);
    // …and the change itself is still shown, which is the whole contract of the dry run.
    expect(run.stdout).toContain(HOOK_COMMAND.replaceAll('"', '\\"'));
    expect(run.stdout).toContain("unchanged lines");
  });
});
