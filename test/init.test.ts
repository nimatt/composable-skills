import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { unifiedDiff } from "../src/diff.ts";
import { deriveId } from "../src/init.ts";
import { OWNER_MARKER } from "../src/layout.ts";
import { HOOK_COMMAND, invokesThisTool } from "../src/settings.ts";
import { parseJsonc } from "../src/config.ts";
import type { BuildRun } from "./fixtures/workspace.ts";
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
  withFsFailures,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

/** A repo `init` has never touched: a git checkout with no config of ours in it. */
function freshRepo(repoFiles: Record<string, string> = {}) {
  return workspace({ config: null, git: true, repoFiles });
}

/**
 * The directory the `sources` entry `init` scaffolds points at. A fresh repo does not have it, and
 * the plan's "### 2 — A source the tool cannot use is an error" makes a source root that is not
 * there an error rather than a warning — deliberately, since the config does name something that
 * is not there, and deliberately not papered over in `init`, since scaffolding the directory would
 * presume a layout on behalf of a repo that may be about to name a package. So a test here either
 * names that error ("the config it writes is one the tool can load") or creates the directory,
 * when the error is not what the test is about.
 */
const SCAFFOLDED_SOURCE_REL = "skills/templates";

/** Every error line, so a test can name the error it expects rather than assert there are none. */
function errorsOf(run: BuildRun): string[] {
  return lines(run).filter((line) => line.startsWith("composable-skills: error"));
}

function settingsOf(ws: { repo: string }): unknown {
  return JSON.parse(read(ws.repo, ".claude/settings.json"));
}

/** Every SessionStart command string, so an assertion reads the value rather than its escaping. */
function commandsOf(settings: unknown): unknown[] {
  const hooks = (settings as { hooks?: { SessionStart?: { hooks?: { command?: unknown }[] }[] } })
    .hooks;
  return (hooks?.SessionStart ?? []).flatMap((group) =>
    (group.hooks ?? []).map((entry) => entry.command),
  );
}

/**
 * Whether the suite is running as uid 0. `init` enforces every permission it enforces through the
 * kernel — `access(2)` for writability, `open(2)` for readability — and root is exempt from both,
 * so a test that arranges a mode with `chmod` and asserts the refusal it should draw asserts
 * nothing under root: it does not pass, it fails, and has to skip instead.
 *
 * A test asserting the mode stored in the inode needs no guard: `open` and `fchmod` record what
 * they are told whoever runs them. And where the refused branch has to stay covered under root as
 * well, the twin beside it arranges the same failure through `withFsFailures()` rather than
 * through a mode, which no uid is exempt from.
 */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

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

  /**
   * The config still loads — a config `init` cannot read is fatal, and this run exits 0 and reports
   * the file as already there. What it is not is diagnostic-free: the `sources` entry `init` writes
   * names a directory a fresh repo does not have yet, and that is an error by design (see
   * `SCAFFOLDED_SOURCE_REL`). It ends the moment the first template is added. Naming that one error
   * rather than asserting there are none keeps every *other* error a failure here.
   */
  test("the config it writes is one the tool can load", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    const reloaded = init(ws);

    expect(reloaded.code).toBe(0);
    expect(errorsOf(reloaded)).toEqual([
      'composable-skills: error source root "./skills/templates" does not exist at ' +
        `${path.join(ws.repo, SCAFFOLDED_SOURCE_REL)} — skipped; create it, or point "sources" ` +
        "at an installed package",
    ]);
    expect(reloaded.stdout).toContain("a config already exists — left exactly as it is");
    expect(read(ws.repo, "composable-skills.jsonc")).toContain('"id": "repo"');
  });

  /**
   * The config's own account of what it just scaffolded has to match the error above it. Saying
   * only that "nothing compiles until" the directory exists describes silence, and what a fresh
   * repo actually gets is an `error` line on every build and a non-zero `build --check` — the
   * first thing a developer wiring this into CI meets. The template states it rather than
   * apologising for it.
   */
  test("the config it writes says the scaffolded source errors until it exists", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    // Unwrapped, so the assertion is about the sentence rather than about where it breaks.
    const commentary = read(ws.repo, "composable-skills.jsonc").replaceAll(/\n\s*\/\/ ?/g, " ");

    expect(commentary).toContain(
      "Until the directory exists at all, every build reports it as an error and build --check " +
        "exits non-zero: create it, or repoint this entry at an installed package.",
    );
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
    expect(settings.hooks.SessionStart[0]?.hooks).toEqual([
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
              {
                hooks: [
                  {
                    type: "command",
                    command: "node ./node_modules/composable-skills/dist/cli.js build",
                  },
                ],
              },
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
    expect(run.stdout).toContain(
      "already runs this tool at SessionStart under a different command string",
    );
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
    expect(run.stdout).toContain(
      "contains comments or trailing commas, which a rewrite would delete",
    );
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
    const ws = freshRepo({
      ".claude/settings.json": '{ "hooks": { "SessionStart": ["echo hi"] } }\n',
    });

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

  /**
   * The whole of what "already covered" means here: the same pattern, with or without its
   * anchoring `/` and its trailing one. Pinned because a loosening of it — reading `dir/**` as
   * covering `/dir/` — was once made in passing while a *different* file's dedup was being
   * written, and nothing in this suite noticed.
   */
  test("covered means the same pattern, not merely one that would ignore the same files", () => {
    const ws = freshRepo({ ".gitignore": ".composable-skills/**\n" });

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

/**
 * The `.gitignore` step's twin, and downstream of it: Claude Code copies a file into a worktree it
 * creates only where `.worktreeinclude` names it **and** git ignores it, which is exactly the set
 * of paths the step above has just made gitignored. Without these lines a worktree has no tool for
 * the hook to run, and no skills directory that existed when the session started.
 */
describe("init — .worktreeinclude", () => {
  const OUTSIDE_TARGET_CONFIG = {
    id: "acme",
    sources: [],
    targets: ["~/.claude/skills", "./.claude/skills"],
  };

  /** Every pattern the file states, in order; the `#` header lines are not patterns. */
  function patternsOf(text: string): string[] {
    return text.split("\n").filter((line) => line.startsWith("/"));
  }

  test("--write creates it, naming the tool's package directory and the in-repo target", () => {
    const ws = freshRepo();

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(patternsOf(read(ws.repo, ".worktreeinclude"))).toEqual([
      "/node_modules/composable-skills/**",
      "/.claude/skills/**",
      `/.claude/skills/**/${OWNER_MARKER}`,
    ]);
  });

  /**
   * The whole package directory, never `dist/` alone. The shipped bundle is ESM and what makes
   * node read it as ESM is the `"type": "module"` in the `package.json` beside it — a `dist/`
   * copied on its own throws `Cannot use import statement outside a module` at every session
   * start, which is the same silent hook failure the lines are here to end.
   */
  test("the package directory comes across whole, not its dist alone", () => {
    const ws = freshRepo();
    init(ws, { write: true });

    const after = read(ws.repo, ".worktreeinclude");
    expect(after).toContain("/node_modules/composable-skills/**");
    expect(after).not.toContain("composable-skills/dist");
  });

  /**
   * The anti-freezing guarantee, asserted on its own so that a later edit cannot quietly drop it.
   * A skill directory copied without its ownership marker is one no build in that worktree may
   * ever write to or prune again: each one warns that it was not written by this tool and leaves
   * the stale skill sitting in front of the model.
   */
  test("the ownership marker gets a pattern of its own beside the contents", () => {
    const ws = freshRepo();
    init(ws, { write: true });

    expect(read(ws.repo, ".worktreeinclude")).toContain(`/.claude/skills/**/${OWNER_MARKER}`);
  });

  test("existing lines are kept exactly, and the new block is appended after them", () => {
    const before = "dist/**\n.env\n";
    const ws = freshRepo({ ".worktreeinclude": before });

    const run = init(ws, { write: true });

    const after = read(ws.repo, ".worktreeinclude");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("/node_modules/composable-skills/**");
    expect(run.stdout).toContain(
      "update  .worktreeinclude — appended — no existing line is rewritten",
    );
  });

  test("a file with no trailing newline is not glued to the new block", () => {
    const ws = freshRepo({ ".worktreeinclude": ".env" });
    init(ws, { write: true });

    expect(read(ws.repo, ".worktreeinclude").split("\n")[0]).toBe(".env");
    expect(read(ws.repo, ".worktreeinclude")).not.toContain(".env#");
  });

  test("CRLF is preserved in the append", () => {
    const ws = freshRepo({ ".worktreeinclude": "dist/**\r\n.env\r\n" });
    init(ws, { write: true });

    const after = read(ws.repo, ".worktreeinclude");
    expect(after).toContain("/node_modules/composable-skills/**\r\n");
    expect(after.split("\n").filter((line) => line !== "" && !line.endsWith("\r"))).toEqual([]);
  });

  /**
   * Covered means the same pattern, spelled with or without its anchoring `/` — and nothing
   * looser. This file is read by Claude Code's copier rather than by git, so `dir/` covering
   * `dir/**` would be a claim about a matcher this repo does not own.
   */
  test("a file that already covers everything is not touched at all", () => {
    const before = [
      "node_modules/composable-skills/**",
      "/.claude/skills/**",
      `.claude/skills/**/${OWNER_MARKER}`,
      "",
    ].join("\n");
    const ws = freshRepo({ ".worktreeinclude": before });

    const run = init(ws, { write: true });

    expect(read(ws.repo, ".worktreeinclude")).toBe(before);
    expect(run.stdout).toContain(
      "unchanged  .worktreeinclude — a worktree already gets the tool and the compiled skills",
    );
  });

  /**
   * The strict key, stated as the behaviour it buys. A redundant line is the whole cost of being
   * too strict here; being too loose omits a line the worktree needs, and a worktree quietly
   * missing its skills is the failure this feature exists to end.
   */
  test("a hand-written directory line covers neither the contents nor the marker", () => {
    const ws = freshRepo({ ".worktreeinclude": ".claude/skills/\n" });

    init(ws, { write: true });

    const after = read(ws.repo, ".worktreeinclude");
    expect(after.split("\n").filter((line) => line.includes(".claude/skills"))).toEqual([
      ".claude/skills/",
      "/.claude/skills/**",
      `/.claude/skills/**/${OWNER_MARKER}`,
    ]);
  });

  /** A dangling link never reaches the unreadable branch: the symlink verdict outranks it. */
  test("a dangling symlink keeps the symlink verdict rather than the unreadable one", () => {
    const ws = freshRepo();
    symlink(path.join(ws.root, "nowhere"), ws.repo, ".worktreeinclude");

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("is a symlink, so writing");
    expect(run.stdout).not.toContain("exists but could not be read");
    expect(exists(ws.root, "nowhere")).toBe(false);
  });

  test("two consecutive --write runs leave the file byte-identical", () => {
    const ws = freshRepo();
    init(ws, { write: true });
    const after = read(ws.repo, ".worktreeinclude");

    const second = init(ws, { write: true });

    expect(read(ws.repo, ".worktreeinclude")).toBe(after);
    expect(second.stdout).toContain("unchanged  .worktreeinclude");
  });

  test("a commented-out line does not count as covering anything", () => {
    const ws = freshRepo({ ".worktreeinclude": "# node_modules/composable-skills/\n" });
    init(ws, { write: true });

    expect(read(ws.repo, ".worktreeinclude")).toContain("\n/node_modules/composable-skills/**\n");
  });

  test("a target outside the repo gets no pattern, since no worktree copy reaches it", () => {
    const ws = workspace({ git: true, config: OUTSIDE_TARGET_CONFIG });

    init(ws, { write: true });

    expect(patternsOf(read(ws.repo, ".worktreeinclude"))).toEqual([
      "/node_modules/composable-skills/**",
      "/.claude/skills/**",
      `/.claude/skills/**/${OWNER_MARKER}`,
    ]);
  });

  test("the dry run prints the block it would write and writes nothing", () => {
    const ws = freshRepo();
    const before = snapshot(ws.root);

    const dry = init(ws);

    expect(snapshot(ws.root)).toEqual(before);
    expect(dry.stdout).toContain("would create  .worktreeinclude");
    expect(dry.stdout).toContain("+ /node_modules/composable-skills/**");
    expect(dry.stdout).toContain(`+ /.claude/skills/**/${OWNER_MARKER}`);
  });

  test("a symlinked .worktreeinclude is refused rather than written through", () => {
    const ws = freshRepo();
    write(ws.root, { "elsewhere/worktreeinclude": ".env\n" });
    symlink(path.join(ws.root, "elsewhere", "worktreeinclude"), ws.repo, ".worktreeinclude");

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("is a symlink, so writing");
    expect(read(ws.root, "elsewhere/worktreeinclude")).toBe(".env\n");
    // The steps that stay inside the repo still apply — the refusal is this file's, not the run's.
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(true);
  });

  test.skipIf(asRoot)("an unreadable .worktreeinclude is refused rather than replaced", () => {
    const ws = freshRepo({ ".worktreeinclude": ".env\n" });
    chmod(ws.repo, ".worktreeinclude", 0o000);

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      `${path.join(ws.repo, ".worktreeinclude")} exists but could not be read`,
    );
    chmod(ws.repo, ".worktreeinclude", 0o600);
    expect(read(ws.repo, ".worktreeinclude")).toBe(".env\n");
  });

  /** The always-running twin: an injected read failure no uid is exempt from. */
  test("the same file under an injected read failure keeps its bytes", () => {
    const ws = freshRepo({ ".worktreeinclude": ".env\n" });
    const target = path.join(ws.repo, ".worktreeinclude");

    const { result: run, fired } = withFsFailures({ calls: ["readFileSync"], when: target }, () =>
      init(ws, { write: true }),
    );

    expect(fired).toContain(`readFileSync ${target}`);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("refused  .worktreeinclude — exists but could not be read");
    expect(run.stdout).not.toContain("create  .worktreeinclude");
    expect(read(ws.repo, ".worktreeinclude")).toBe(".env\n");
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
    expect(read(ws.repo, "composable-skills.jsonc")).toContain(
      "declared and never derived from its path",
    );
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
    expect(run.stdout).toContain(
      `no .git was found at or above ${ws.repo}, so this is not a checkout`,
    );
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
    expect(run.stdout).toContain(
      `${path.join(ws.repo, ".pnp.js")} exists, so this repo uses Yarn Plug'n'Play`,
    );
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
 * route: a repo that has not installed yet, or a `git worktree` made by hand, which has no
 * `node_modules` of its own and so kills the hook at every session start with nothing downstream
 * to say so.
 */
describe("init — a hook that would never run", () => {
  const CLI_PATH = ["node_modules", "composable-skills", "dist", "cli.js"];

  test("warns that the binary the hook names is not there, and names the worktree case", () => {
    const ws = freshRepo();

    const run = init(ws);

    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(`${path.join(ws.repo, ...CLI_PATH)} does not exist`);
    expect(run.stdout).toContain("would fail at every session start — silently");
    // The remedy differs by which kind of worktree you are in, and the warning names both.
    expect(run.stdout).toContain(
      "the .worktreeinclude below carries the main checkout's install across",
    );
    expect(run.stdout).toContain("`git worktree add` is copied into by nothing and needs its own");
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
    expect(invokesThisTool("node /opt/app/node_modules/composable-skills/dist/cli.js build")).toBe(
      true,
    );
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
    expect(invokesThisTool("bash -c 'cd /home/me/dev/composable-skills && bun run build'")).toBe(
      false,
    );
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
        SessionStart: [{ hooks: [{ type: "command", command: "npx composable-skills build" }] }],
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

  /**
   * **Finding 26.** The test above pins the mode the swap ends at; this one pins the span before
   * it. The staging file was created at the umask default and narrowed only afterwards, so the
   * merged content of a deliberately-`600` settings file — these can carry `env` values — sat
   * group- and world-readable, under a name inside the repo, for the width of a write. The mode is
   * now handed to the call that creates the file, so it is never wider than the file it replaces.
   *
   * `fs.chmodSync` is patched here rather than driven through `withFsFailures()`, which injects
   * failures and cannot observe: what has to be seen is the mode the staging file was *created*
   * with, and that is only visible in the instant between the write and the chmod. This patch
   * records and delegates, so nothing about the run changes. No `skipIf(asRoot)`: the assertion is
   * on the mode stored in the inode, which `open` records the same whoever runs it.
   */
  test("the staging file is created at the mode it will end at, never wider", () => {
    const ws = freshRepo({ ".claude/settings.json": OWNER_ONLY });
    chmod(ws.repo, ".claude/settings.json", 0o600);

    const stagedAs: number[] = [];
    const realChmod = fs.chmodSync;
    const patchable = fs as { chmodSync: typeof fs.chmodSync };
    let run: BuildRun;
    try {
      patchable.chmodSync = (target, mode) => {
        if (String(target).includes("composable-skills-tmp")) {
          stagedAs.push(fs.statSync(target).mode & 0o777);
        }
        realChmod(target, mode);
      };
      run = init(ws, { write: true });
    } finally {
      patchable.chmodSync = realChmod;
    }

    expect(run.code).toBe(0);
    // One staging file was chmod'd — the settings merge — and it was already owner-only.
    expect(stagedAs).toEqual([0o600]);
    expect(modeOf(ws.repo, ".claude/settings.json")).toBe(0o600);
  });

  /**
   * `skipIf(asRoot)` on both halves: `isWritable` asks `access(2)` for `W_OK`, which succeeds for
   * uid 0 whatever the mode says, so under a root runner `init` would not refuse at all and these
   * would fail rather than skip. The refusal is the assertion, and root defeats what enforces it.
   */
  test.skipIf(asRoot)(
    "a file the process cannot write is refused in the plan, so the dry run says so",
    () => {
      const ws = freshRepo({ ".claude/settings.json": OWNER_ONLY });
      chmod(ws.repo, ".claude/settings.json", 0o444);

      const dry = init(ws);

      // `rename(2)` does not consult the mode, so refusing here is the only place it means
      // anything.
      expect(dry.code).toBe(1);
      expect(dry.stdout).toContain(
        `${path.join(ws.repo, ".claude", "settings.json")} is not writable (mode 444)`,
      );
      expect(dry.stdout).toContain(
        "refused  .claude/settings.json — not writable — left exactly as it is",
      );
      expect(dry.stdout).not.toContain("would update  .claude/settings.json");
    },
  );

  test.skipIf(asRoot)("and --write leaves it byte-identical, at the mode it had", () => {
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
 * Mode 000, which is a different file from the mode 444 above: that one can be read, so the plan
 * can at least see what it is proposing to replace. This one cannot, and a read that fails is not
 * a file that is absent — treating the two alike had `init` report `created` for a `.gitignore`
 * it had just destroyed, over a diff showing nothing but `+` lines.
 */
describe("init — a file that exists but cannot be read", () => {
  const GITIGNORE = "node_modules/\ndist/\n*.log\n";
  const SETTINGS = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;

  test.skipIf(asRoot)("the dry run calls an unreadable .gitignore refused, not created", () => {
    const ws = freshRepo({ ".gitignore": GITIGNORE });
    // No `finally` restoring the mode: `chmod()` records the path and `cleanup()` reopens it.
    chmod(ws.repo, ".gitignore", 0o000);

    const dry = init(ws);

    expect(dry.code).toBe(1);
    expect(dry.stdout).toContain("refused  .gitignore — exists but could not be read");
    expect(dry.stdout).not.toContain("create  .gitignore");
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(false);
  });

  test.skipIf(asRoot)("and --write leaves its bytes exactly as they were", () => {
    const ws = freshRepo({ ".gitignore": GITIGNORE });
    chmod(ws.repo, ".gitignore", 0o000);

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      `${path.join(ws.repo, ".gitignore")} exists but could not be read`,
    );
    chmod(ws.repo, ".gitignore", 0o600);
    expect(read(ws.repo, ".gitignore")).toBe(GITIGNORE);
  });

  // The same claim under an injected read failure, so it still runs where a root CI makes `chmod`
  // meaningless. `fired` is asserted so a predicate that never matched cannot leave this hollow.
  test("an unreadable .gitignore is refused rather than replaced", () => {
    const ws = freshRepo({ ".gitignore": GITIGNORE });
    const target = path.join(ws.repo, ".gitignore");

    const { result: run, fired } = withFsFailures(
      { calls: ["readFileSync"], when: target, code: "EACCES" },
      () => init(ws, { write: true }),
    );

    expect(fired).toContain(`readFileSync ${target}`);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`${target} exists but could not be read`);
    expect(run.stdout).toContain("init will not replace a file it has not seen");
    expect(run.stdout).not.toContain("create  .gitignore");
    expect(read(ws.repo, ".gitignore")).toBe(GITIGNORE);
  });

  test.skipIf(asRoot)("an unreadable .claude/settings.json is refused, not merged over", () => {
    const ws = freshRepo({ ".claude/settings.json": SETTINGS });
    chmod(ws.repo, ".claude/settings.json", 0o000);

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      `${path.join(ws.repo, ".claude", "settings.json")} exists but could not be read`,
    );
    chmod(ws.repo, ".claude/settings.json", 0o600);
    // Every unrelated key is preserved, which a rewrite of a file nobody read cannot promise.
    expect(read(ws.repo, ".claude/settings.json")).toBe(SETTINGS);
  });

  test("the same settings file under an injected read failure keeps its bytes", () => {
    const ws = freshRepo({ ".claude/settings.json": SETTINGS });
    const target = path.join(ws.repo, ".claude", "settings.json");

    const { result: run, fired } = withFsFailures({ calls: ["readFileSync"], when: target }, () =>
      init(ws, { write: true }),
    );

    expect(fired).toContain(`readFileSync ${target}`);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`${target} exists but could not be read`);
    expect(read(ws.repo, ".claude/settings.json")).toBe(SETTINGS);
  });

  test("and its dry run prints the refusal rather than a creation", () => {
    const ws = freshRepo({ ".claude/settings.json": SETTINGS });
    const target = path.join(ws.repo, ".claude", "settings.json");
    const before = snapshot(ws.root);

    const { result: dry, fired } = withFsFailures({ calls: ["readFileSync"], when: target }, () =>
      init(ws),
    );

    expect(fired).toContain(`readFileSync ${target}`);
    expect(dry.code).toBe(1);
    expect(dry.stdout).toContain("refused  .claude/settings.json — exists but could not be read");
    expect(dry.stdout).not.toContain("create  .claude/settings.json");
    expect(snapshot(ws.root)).toEqual(before);
  });

  test("a dangling symlink keeps the symlink verdict rather than this one", () => {
    const ws = freshRepo();
    symlink(path.join(ws.root, "nowhere"), ws.repo, ".gitignore");

    const run = init(ws, { write: true });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("is a symlink, so writing");
    expect(run.stdout).not.toContain("exists but could not be read");
    expect(exists(ws.root, "nowhere")).toBe(false);
  });

  /**
   * The two files `init` reads and never writes are the opposite case: there is nothing there to
   * refuse on behalf of, and a refusal would stop a run over a file this tool has no claim on. It
   * warns instead, because an unchecked merge source is exactly what builds twice every session.
   */
  test.skipIf(asRoot)("an unreadable settings.local.json warns, and the run still succeeds", () => {
    const ws = freshRepo({ ".claude/settings.local.json": SETTINGS });
    chmod(ws.repo, ".claude/settings.local.json", 0o000);

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(run.stdout).toContain(
      `${path.join(ws.repo, ".claude", "settings.local.json")} — this repo's untracked personal ` +
        "settings — exists but could not be read",
    );
    expect(run.stdout).toContain("could not check whether a hook there already runs this tool");
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
  });

  /**
   * The always-running twin of the test above. That one arranges the failure with `chmod 000`, so
   * it has to skip under a root runner — `open(2)` hands uid 0 the file whatever the mode says.
   * The user-level test below is not a substitute: it is about the *other* file, and asserts the
   * other two sentences ("your user-level settings", "init never writes that file either way."),
   * so without this the repo-local branch would go entirely uncovered wherever the suite runs as
   * root. Injecting the read failure covers it for every runner, root included.
   */
  test("the same settings.local.json under an injected read failure warns the same way", () => {
    const ws = freshRepo({ ".claude/settings.local.json": SETTINGS });
    const target = path.join(ws.repo, ".claude", "settings.local.json");

    const { result: run, fired } = withFsFailures({ calls: ["readFileSync"], when: target }, () =>
      init(ws, { write: true }),
    );

    expect(fired).toContain(`readFileSync ${target}`);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(
      `${target} — this repo's untracked personal settings — exists but could not be read`,
    );
    expect(run.stdout).toContain("could not check whether a hook there already runs this tool");
    // The run still did its own job: the project file was merged and the hook is in it.
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
    // And the file it could not read is still exactly as it was — `init` never writes it.
    expect(read(ws.repo, ".claude/settings.local.json")).toBe(SETTINGS);
  });

  test("an unreadable user-level settings file warns too, and does not refuse", () => {
    const ws = workspace({
      config: null,
      git: true,
      osHomeFiles: { ".claude/settings.json": SETTINGS },
    });
    const target = path.join(ws.osHome, ".claude", "settings.json");

    const { result: run, fired } = withFsFailures({ calls: ["readFileSync"], when: target }, () =>
      init(ws, { write: true }),
    );

    expect(fired).toContain(`readFileSync ${target}`);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(
      `${target} — your user-level settings — exists but could not be read`,
    );
    expect(run.stdout).toContain("init never writes that file either way.");
    expect(commandsOf(settingsOf(ws))).toEqual([HOOK_COMMAND]);
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
 *
 * What is under test here is the invited lines, not the scaffolded `sources` entry, so these
 * fixtures create `SCAFFOLDED_SOURCE_REL` — the steady state of a repo that has added its first
 * template. That keeps `hasError` a live assertion about uncommenting: without the directory every
 * one of these would report the error described at `SCAFFOLDED_SOURCE_REL` no matter what the
 * uncommented lines did, and an error introduced by an invited line would hide inside it.
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
        return which.includes(seen) ? `${match[1] ?? ""}${match[2] ?? ""}` : line;
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
    const label =
      which.length === 0 ? "as written" : `with line(s) ${which.join(" and ")} uncommented`;
    test(`${label}, the config still parses and still loads`, () => {
      const ws = freshRepo();
      mkdir(ws.repo, SCAFFOLDED_SOURCE_REL);
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
    mkdir(ws.repo, SCAFFOLDED_SOURCE_REL);
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
