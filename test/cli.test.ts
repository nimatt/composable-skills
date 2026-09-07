import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, cli, exists, read, snapshot, workspace } from "./fixtures/workspace.ts";

afterEach(cleanup);

const TEMPLATE = [
  "---",
  "name: reviewer",
  "description: Reviews code.",
  "---",
  "",
  "<!-- slot: extra-checks -->",
  "Check for dead code.",
  "<!-- /slot -->",
  "",
].join("\n");

/** A repo with one skill, so `override` has something real to resolve. */
function repo() {
  return workspace({ repoFiles: { "templates/reviewer/SKILL.md.tmpl": TEMPLATE } });
}

/** A checkout with no config of ours, which is what `init` is run in. */
function bare() {
  return workspace({ config: null, git: true });
}

/**
 * The two writing verbs default in opposite directions for a real reason — `init` merges into files
 * the repo already tracks, `override` only ever creates one file it refuses to overwrite — but the
 * vocabulary is shared, so neither spelling is ever a typo. Only the contradiction is an error.
 */
describe("cli — each verb accepts the other's flag as a spelling of its own default", () => {
  test("init --dry-run says what init already does, and writes nothing", () => {
    const ws = bare();
    const before = snapshot(ws.root);

    const run = cli(ws, ["init", "--dry-run"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`init: dry run in ${ws.repo}`);
    expect(run.stdout).toContain("Nothing was written. Re-run with --write to apply this.");
    expect(snapshot(ws.root)).toEqual(before);
  });

  test("init with no flag is the same dry run", () => {
    const ws = bare();

    const run = cli(ws, ["init"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`init: dry run in ${ws.repo}`);
    expect(exists(ws.repo, "composable-skills.jsonc")).toBe(false);
  });

  test("override --write says what override already does, and writes the file", () => {
    const ws = repo();

    const run = cli(ws, ["override", "reviewer", "extra-checks", "--write"]);

    expect(run.code).toBe(0);
    expect(read(ws.home, "repos/acme/reviewer/extra-checks.md")).toBe("Check for dead code.\n");
    expect(run.stdout).toContain("seeded");
  });

  test("override --dry-run is the one that changes the behaviour", () => {
    const ws = repo();

    const run = cli(ws, ["override", "reviewer", "extra-checks", "--dry-run"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("would seed");
    expect(exists(ws.home, "repos/acme/reviewer/extra-checks.md")).toBe(false);
  });
});

describe("cli — a contradiction is an error, and only a contradiction", () => {
  test("init --write --dry-run exits 2 and says which verb refused", () => {
    const ws = bare();
    const before = snapshot(ws.root);

    const run = cli(ws, ["init", "--write", "--dry-run"]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("composable-skills: init cannot take both --write and --dry-run");
    expect(run.stderr).toContain("Usage:");
    expect(snapshot(ws.root)).toEqual(before);
  });

  test("override --write --dry-run exits 2 and writes nothing", () => {
    const ws = repo();

    const run = cli(ws, ["override", "reviewer", "extra-checks", "--write", "--dry-run"]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "composable-skills: override cannot take both --write and --dry-run",
    );
    expect(exists(ws.home, "repos/acme/reviewer/extra-checks.md")).toBe(false);
  });

  test("an option no verb defines still exits 2", () => {
    const ws = bare();

    expect(cli(ws, ["init", "--force"]).code).toBe(2);
    expect(cli(ws, ["build", "--write"]).code).toBe(2);
    expect(cli(ws, ["override", "a", "b", "--check"]).code).toBe(2);
    expect(cli(ws, ["nonesuch"]).code).toBe(2);
  });

  test("override still needs exactly its two positional arguments", () => {
    const ws = repo();

    expect(cli(ws, ["override", "reviewer"]).code).toBe(2);
    expect(cli(ws, ["override", "reviewer", "extra-checks", "extra"]).code).toBe(2);
    expect(cli(ws, ["override", "reviewer"]).stderr).toContain(
      "override takes exactly two arguments",
    );
  });
});

describe("cli — help after a verb is a request for help", () => {
  const USAGE_MARKER = "composable-skills — compile skill templates into SKILL.md";

  for (const verb of ["build", "init", "override", "lint", "explain"]) {
    for (const flag of ["-h", "--help"]) {
      test(`${verb} ${flag} prints the usage and exits 0`, () => {
        const ws = bare();

        const run = cli(ws, [verb, flag]);

        expect(run.code).toBe(0);
        expect(run.stdout).toContain(USAGE_MARKER);
        expect(run.stdout).toContain("composable-skills override <skill> <slot>");
        expect(run.stderr).toBe("");
      });
    }
  }

  test("help wins over arguments that would otherwise be a usage error", () => {
    const ws = bare();

    const run = cli(ws, ["override", "--help"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(USAGE_MARKER);
  });

  test("the usage says why the two writing verbs default in opposite directions", () => {
    const run = cli(bare(), ["--help"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      "init --dry-run and override --write both say what would happen anyway.",
    );
  });

  test("an unimplemented verb still reports its phase rather than pretending", () => {
    const ws = bare();

    const lint = cli(ws, ["lint"]);

    expect(lint.code).toBe(1);
    expect(lint.stderr).toContain("lint is not implemented yet (planned for phase 4)");
    expect(cli(ws, ["explain"]).stderr).toContain("planned for phase 5");
  });
});

/**
 * **Finding 14.** `main()`'s three catch blocks and the `reportCrash` they call had no test at
 * all, and the `build` one carries a clause of the contract rather than a courtesy:
 * `tool-contract.md` says `build` "exits 0 unconditionally, including on failure", because it runs
 * at `SessionStart` and a non-zero exit is reported to the developer as a broken session. That
 * clause is only interesting in the case these blocks exist for — a throw escaping the verb — and
 * the one outcome the fail-soft design forbids is `reportCrash` itself failing and taking the exit
 * code with it.
 *
 * Nothing a workspace can contain gets a throw out of a verb: every `fs` call inside one is
 * already guarded, which is the whole design. So the crash is injected at a call nobody guards —
 * see `BrokenCall` in the fixture for which two, and why those.
 */
describe("cli — a throw that escapes a verb", () => {
  test("build still exits 0, and the crash reaches all three channels", () => {
    const ws = repo();

    const run = cli(ws, ["build"], { breaks: ["os.hostname"] });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("composable-skills: error build failed:");
    expect(run.stderr).toContain("composable-skills: error build failed:");
    // The log is the channel that exists for exactly this: a session hook's streams are read by a
    // model, if at all, and a crash is what the developer will want to go back and look at.
    expect(read(ws.repo, ".composable-skills/build.log")).toContain("build failed:");
  });

  /**
   * The same clause, in the case that also breaks the crash report's own footing: `crashStateDir`
   * resolves the log's directory from the working directory, so a crash caused by losing that
   * directory leaves `reportCrash` with nowhere to write. It must still not throw — `build`'s exit
   * code is what a session hook reads, and 0 is the only answer it may ever give.
   */
  test("build still exits 0 when the crash took the log's own path down with it", () => {
    const ws = repo();

    const run = cli(ws, ["build"], { breaks: ["process.cwd"] });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("composable-skills: error build failed:");
    expect(exists(ws.repo, ".composable-skills")).toBe(false);
  });

  // `--check` is the documented exception to the exit-0 rule: it is run by a person or by CI, who
  // are entitled to a verdict, and a crash is not a passing one.
  test("build --check exits 1 instead, and writes nothing", () => {
    const ws = repo();

    const run = cli(ws, ["build", "--check"], { breaks: ["process.cwd"] });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("composable-skills: error build failed:");
    expect(exists(ws.repo, ".composable-skills")).toBe(false);
  });

  // Neither writing verb runs unattended, so both answer a crash the ordinary way.
  test("init reports the crash and exits 1", () => {
    const ws = bare();

    const run = cli(ws, ["init"], { breaks: ["process.cwd"] });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("composable-skills: error init failed:");
  });

  test("override reports the crash and exits 1", () => {
    const ws = repo();

    const run = cli(ws, ["override", "reviewer", "extra-checks"], { breaks: ["process.cwd"] });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("composable-skills: error override failed:");
  });
});
