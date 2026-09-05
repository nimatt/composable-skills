import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { blankJsonComments, blankTrailingCommas, homeRoot, parseJsonc } from "../src/config.ts";
import type { BuildRun } from "./fixtures/workspace.ts";
import {
  build,
  cleanup,
  compiled,
  exists,
  hasError,
  hasWarning,
  init,
  lines,
  mkdir,
  override,
  read,
  remove,
  symlink,
  withFsFailures,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

/**
 * Every error and warning line, in order and in full. A `toContain` on a substring cannot tell a
 * headline from a note that repeats it, and cannot see a line that should not be there at all —
 * so the walk's failure paths, where both of those are the behaviour under test, assert this.
 */
function diagnosticsOf(run: BuildRun): string[] {
  return lines(run).filter(
    (line) =>
      line.startsWith("composable-skills: error") || line.startsWith("composable-skills: warning"),
  );
}

/** What the fixture injects as the errno message, quoted back by every "cannot be read" line. */
function injected(call: string, target: string): string {
  return `EACCES: injected by the test fixture, ${call} '${target}'`;
}

/** The reason clause every refused level shares, spelled once so a reword fails loudly. */
const SYMLINK_REASON = "it is a symlink, and only the root a config entry names may be one";
const NO_SOURCES = "composable-skills: warning no usable source roots — no skills to compile";
const NOT_PRUNED =
  "composable-skills: warning a configured source root could not be read in full, or resolved to " +
  "a copy this build cannot vouch for — nothing was pruned this run";

describe("${home}", () => {
  test("COMPOSABLE_SKILLS_HOME relocates it, beating XDG_CONFIG_HOME", () => {
    expect(homeRoot({ COMPOSABLE_SKILLS_HOME: "/opt/skills", XDG_CONFIG_HOME: "/xdg" })).toBe(
      path.resolve("/opt/skills"),
    );
  });

  test("XDG_CONFIG_HOME alone puts it under that directory", () => {
    expect(homeRoot({ XDG_CONFIG_HOME: "/xdg" })).toBe(path.join("/xdg", "composable-skills"));
  });

  test("with neither set it is ~/.config/composable-skills", () => {
    expect(homeRoot({})).toBe(path.join(os.homedir(), ".config", "composable-skills"));
  });

  test("an entry that escapes it is dropped rather than followed", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: ["${home}/../elsewhere"],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "templates/e/SKILL.md.tmpl":
          "---\nname: e\n---\n\n<!-- slot: s -->\nThe template default.\n<!-- /slot -->\n",
      },
    });
    write(ws.root, { "elsewhere/e/s.md": "Read from outside the personal home.\n" });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain('override "${home}/../elsewhere"');
    expect(run.stdout).toContain("outside");
    expect(compiled(ws, "e")).toContain("The template default.");
    expect(compiled(ws, "e")).not.toContain("Read from outside the personal home.");
  });

  /**
   * The other spelling of the same mistake, and the one text alone cannot catch: the entry stays
   * under `${home}` as written and leaves it at the first read. Asked of all three lists, because
   * all three read or write through the root — the `overrides` case lives with the rest of
   * invariant 8, in `test/validate.test.ts` ("an override root that leaves ${home} through a
   * symlink is rejected at load").
   */
  test("a source that leaves it through a symlink is dropped, not compiled", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["${home}/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
    });
    write(ws.root, {
      "outside/smuggled/SKILL.md.tmpl": "---\nname: smuggled\n---\n\nSMUGGLED CONTENT\n",
    });
    symlink(path.join(ws.root, "outside"), ws.home, "templates");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: error source "\${home}/templates" resolves to ` +
        `${path.join(ws.home, "templates")}, which leads through a symlink to ` +
        `${path.join(ws.root, "outside")}, outside ${ws.home} — skipped`,
      NO_SOURCES,
      NOT_PRUNED,
    ]);
    expect(exists(ws.repo, ".claude/skills/smuggled")).toBe(false);
    expect(run.stdout).not.toContain("SMUGGLED CONTENT");
  });

  /**
   * The same check on `targets`, which is the one that matters most: nothing ever `lstat`s a
   * target root — `emitSkill` `mkdir`s it and writes through it — so before this check a
   * `${home}`-spelled target linked out of `${home}` wrote outside `${home}` with nothing said.
   */
  test("a target that leaves it through a symlink is refused before anything is written", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [],
        targets: ["${home}/out"],
      },
      repoFiles: { "templates/t/SKILL.md.tmpl": "---\nname: t\n---\n\nBody.\n" },
    });
    write(ws.root, { "outside-out/.keep": "" });
    symlink(path.join(ws.root, "outside-out"), ws.home, "out");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: error target "\${home}/out" resolves to ` +
        `${path.join(ws.home, "out")}, which leads through a symlink to ` +
        `${path.join(ws.root, "outside-out")}, outside ${ws.home} — skipped`,
    ]);
    // the root was dropped, so the build had nowhere to write and wrote nowhere
    expect(run.stdout).toContain("composable-skills: 0 skills → 0 targets");
    expect(exists(ws.root, "outside-out/t")).toBe(false);
    expect(fs.readdirSync(path.join(ws.root, "outside-out"))).toEqual([".keep"]);
  });

  // -------------------------------------------------------------------------------------------
  // EXPECTED TO FAIL — `--check` reports an error and success in the same breath.
  //
  // tool-contract.md, Public API: "`--check` writes nothing and exits non-zero if the output is
  // stale **or the last build had errors**." A config-level error — here, an override root that
  // escapes ${home} — is recomputed live on every run rather than stored in the stamp, and
  // `runBuild` decides `--check`'s exit code from the *replayed* diagnostics alone. So the run
  // prints "error ... outside ..." immediately followed by "compiled output is up to date", and
  // exits 0. CI gates on the exit code and would never see it.
  //
  // The narrow fix is to let live diagnostics count towards `broken` in the `--check` branch of
  // `runBuild`; whether config errors should instead be fatal is the implementation owner's call,
  // so the test asserts the contract as written.
  // -------------------------------------------------------------------------------------------
  test("--check exits non-zero while a config error is still being reported", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: ["${home}/../elsewhere"],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "templates/e/SKILL.md.tmpl": "---\nname: e\n---\n\nBody.\n" },
    });

    expect(build(ws).code).toBe(0);

    const checked = build(ws, { check: true });
    expect(hasError(checked)).toBe(true);
    expect(checked.stdout).not.toContain("compiled output is up to date");
    expect(checked.code).toBe(1);
  });
});

describe("the documented defaults", () => {
  // Every other fixture writes all four keys, so nothing else would notice the defaults in
  // `src/config.ts` being rewritten. This is the wrapper-package case the spec calls out: a repo
  // that names its templates and nothing else.
  test("a config of only id and sources still resolves the whole override chain and target", () => {
    const ws = workspace({
      config: { id: "acme", sources: ["./templates"] },
      repoFiles: {
        "templates/w/SKILL.md.tmpl": [
          "---",
          "name: w",
          "---",
          "",
          "<!-- slot: everywhere -->",
          "The template default.",
          "<!-- /slot -->",
          "",
          "<!-- slot: only-global -->",
          "Unfilled.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        ".claude/skills-local/w/everywhere.md": "From the repo-local root.\n",
      },
      homeFiles: {
        "global/w/everywhere.md": "From the global root.\n",
        "global/w/only-global.md": "Only the global root has this.\n",
        "repos/acme/w/everywhere.md": "From the personal repo root.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    // the default target
    const out = read(ws.repo, ".claude/skills/w/SKILL.md");
    // ${home}/repos/${id} is last in the default chain, so it wins
    expect(out).toContain("From the personal repo root.");
    expect(out).not.toContain("From the repo-local root.");
    expect(out).not.toContain("From the global root.");
    // and ${home}/global is still in the chain, at the bottom
    expect(out).toContain("Only the global root has this.");
  });

  test("with no config at all the repo root is the enclosing git checkout", () => {
    const ws = workspace({ config: null, git: true, repoFiles: { "sub/nested/.keep": "" } });

    const run = build(ws, { cwd: path.join(ws.repo, "sub", "nested") });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("no usable source roots");
    // state belongs to the repo root, not to the working directory the hook happened to run in
    expect(exists(ws.repo, ".composable-skills/build.log")).toBe(true);
    expect(exists(ws.repo, "sub/nested/.composable-skills")).toBe(false);
  });

  test("the search for a config stops at the git boundary", () => {
    const ws = workspace({ config: null, git: true });
    write(ws.root, {
      "composable-skills.jsonc": `${JSON.stringify({
        id: "outer",
        sources: ["./outer-templates"],
        overrides: [],
        targets: ["./outer-out"],
      })}\n`,
      "outer-templates/leak/SKILL.md.tmpl": "---\nname: leak\n---\n\nLeaked.\n",
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("no usable source roots");
    expect(exists(ws.root, "outer-out")).toBe(false);
    expect(exists(ws.repo, ".claude/skills/leak")).toBe(false);
    expect(exists(ws.repo, ".composable-skills")).toBe(true);
  });
});

describe("a sources entry resolved as a node package", () => {
  const CONSUMER = '{"name":"consumer","version":"0.0.0","private":true}\n';
  const manifest = (name: string) => `{"name":"${name}","version":"1.0.0"}\n`;
  const PACKED = "---\nname: packed\n---\n\nFrom the installed package.\n";

  // The unscoped shape, which every other case here would miss: a scoped name is two segments and
  // an unscoped one is a single segment, and the split is what decides where the name stops and
  // the subpath begins.
  test("an unscoped flat node_modules install resolves and compiles", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["cskt-flat-pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/cskt-flat-pack/package.json": manifest("cskt-flat-pack"),
        "node_modules/cskt-flat-pack/packed/SKILL.md.tmpl": PACKED,
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(false);
    expect(compiled(ws, "packed")).toBe(PACKED);
  });

  // pnpm links a direct dependency into `node_modules/<name>`; the real directory lives in the
  // store. A symlinked *package root* is the one exemption invariant 8 grants, so this resolves.
  test("a pnpm-shaped install resolves through the symlinked package root", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-pnpm/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER },
    });
    const store = "store/@cskt-pnpm+pack@1.0.0/node_modules/@cskt-pnpm/pack";
    write(ws.root, {
      [`${store}/package.json`]: manifest("@cskt-pnpm/pack"),
      [`${store}/packed/SKILL.md.tmpl`]: PACKED,
    });
    symlink(path.join(ws.root, ...store.split("/")), ws.repo, "node_modules/@cskt-pnpm/pack");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(false);
    expect(compiled(ws, "packed")).toBe(PACKED);
  });

  // A workspace child with the dependency hoisted to the monorepo root: the package is in no
  // `node_modules` the repo owns, only in an ancestor's. `ws.root` is the parent of `ws.repo`.
  test("a package hoisted above the repo is found by the upward walk", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-hoist/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        // the repo has a `node_modules` of its own, it just does not hold this package
        "node_modules/.package-lock.json": "{}\n",
      },
    });
    write(ws.root, {
      "node_modules/@cskt-hoist/pack/package.json": manifest("@cskt-hoist/pack"),
      "node_modules/@cskt-hoist/pack/packed/SKILL.md.tmpl": PACKED,
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(compiled(ws, "packed")).toBe(PACKED);
    // Row 7, and the reason it needs a fixture with a `node_modules` in the way: the walk passed
    // through one and stepped over nothing — no candidate was there to step over — so there is
    // nothing to confirm and nothing to say.
    expect(diagnosticsOf(run)).toEqual([]);
  });

  // The subpath is asked of the filesystem, not of node, so the directory needs no manifest of
  // its own — which is the whole point of the layout a skills repo actually wants.
  test("a subpath entry needs no package.json of its own, and narrows the root", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-subpath/pack/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-subpath/pack/package.json": manifest("@cskt-subpath/pack"),
        "node_modules/@cskt-subpath/pack/templates/packed/SKILL.md.tmpl": PACKED,
        // a sibling of the named subpath, so the test fails if the package root were used instead
        "node_modules/@cskt-subpath/pack/unpacked/SKILL.md.tmpl":
          "---\nname: unpacked\n---\n\nNot named by the spec.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(false);
    expect(compiled(ws, "packed")).toBe(PACKED);
    expect(exists(ws.repo, ".claude/skills/unpacked")).toBe(false);
  });

  // npm tarballs carry symlinks, so `templates -> /elsewhere` inside a published package is a
  // reachable shape. The exemption is the package root's own last component and nothing deeper.
  test("a subpath that leaves the package through a symlink is refused", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-escape/pack/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-escape/pack/package.json": manifest("@cskt-escape/pack"),
      },
    });
    // outside the package and outside the repo, but a perfectly valid template
    write(ws.root, {
      "outside/escaped/SKILL.md.tmpl": "---\nname: escaped\n---\n\nFrom outside the package.\n",
    });
    symlink(path.join(ws.root, "outside"), ws.repo, "node_modules/@cskt-escape/pack/templates");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      'composable-skills: error source "@cskt-escape/pack/templates" was refused — "templates" ' +
        'traverses a symlink at "templates" under ',
    );
    expect(run.stdout).toContain(", and no symlink is followed — skipped");
    expect(run.stdout).toContain("0 skills → 1 target");
    expect(exists(ws.repo, ".claude/skills/escaped")).toBe(false);
  });

  /**
   * The distinction the containment discipline is chosen for. This symlink stays *inside* the
   * package — `templates -> real`, both under the package root — so a "resolve both ends and
   * compare" discipline would accept it and compile what it points at. The shipped rule refuses
   * every symlink hop below the root, contained or not, so what a build reads is what the
   * published tree literally holds.
   */
  test("a subpath symlink that stays inside the package is refused all the same", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-inside/pack/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-inside/pack/package.json": manifest("@cskt-inside/pack"),
        "node_modules/@cskt-inside/pack/real/inside/SKILL.md.tmpl":
          "---\nname: inside\n---\n\nFrom inside the package.\n",
      },
    });
    symlink("real", ws.repo, "node_modules/@cskt-inside/pack/templates");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain(
      'composable-skills: error source "@cskt-inside/pack/templates" was refused — "templates" ' +
        'traverses a symlink at "templates" under ',
    );
    expect(run.stdout).toContain(", and no symlink is followed — skipped");
    expect(run.stdout).toContain("0 skills → 1 target");
    expect(exists(ws.repo, ".claude/skills/inside")).toBe(false);
  });

  // The likeliest way to get a subpath wrong, and the one whose diagnostic has somewhere useful to
  // point: the package resolved, so the message can name what it resolved to and what was not
  // inside it. The generic "source root ... does not exist" says neither.
  test("a mistyped subpath names the package root it was looked for under", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-typo/pack/templats"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-typo/pack/package.json": manifest("@cskt-typo/pack"),
        "node_modules/@cskt-typo/pack/templates/packed/SKILL.md.tmpl": PACKED,
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain(
      'composable-skills: error source "@cskt-typo/pack/templats" could not be resolved — the ' +
        "package resolves to ",
    );
    expect(run.stdout).toContain(', which has no "templats" directory — skipped');
    // not the generic root diagnostic, which would name neither the package nor the subpath
    expect(run.stdout).not.toContain("does not exist at ");
    expect(exists(ws.repo, ".claude/skills/packed")).toBe(false);
  });

  /**
   * The same diagnostic, made honest about which copy it is describing. "The package resolves to
   * <ancestor>, which has no "templates" directory" is a claim about a package the developer did
   * not install, and the copy they did install is behind the refused level and may well have the
   * directory. The skipped level rides along with the subpath failure for that reason.
   */
  test("a subpath failure names the level the walk stepped over to reach that package", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-subshadow/pack/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "vendor-scope/pack/package.json": manifest("@cskt-subshadow/pack"),
        "vendor-scope/pack/templates/packed/SKILL.md.tmpl": PACKED,
      },
    });
    symlink(path.join(ws.repo, "vendor-scope"), ws.repo, "node_modules/@cskt-subshadow");
    write(ws.root, { "node_modules/@cskt-subshadow/pack/package.json": manifest("x") });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      'composable-skills: error source "@cskt-subshadow/pack/templates" could not be resolved — ',
    );
    expect(run.stdout).toContain(
      `composable-skills: warning source "@cskt-subshadow/pack/templates": ` +
        `${path.join(ws.repo, "node_modules", "@cskt-subshadow")} was not looked through`,
    );
  });

  test("a subpath that names a file rather than a directory says so", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-file/pack/README.md"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-file/pack/package.json": manifest("@cskt-file/pack"),
        "node_modules/@cskt-file/pack/README.md": "Not a source root.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain(
      'composable-skills: error source "@cskt-file/pack/README.md" could not be resolved — ',
    );
    expect(run.stdout).toContain("exists but is not a directory — skipped");
  });

  // The exemption is the package root's own last component. A symlinked *scope* directory is a
  // level above that, so a link there redirects every package in the scope at once and is refused.
  //
  // Nothing resolves anywhere up the chain here, so the headline is `absent` and the refusal is
  // the line under it: "no such package — is it installed?" is the near-certain truth and the only
  // one of the two that names a remedy, and a link in some ancestor must never be able to take
  // that headline away from it.
  test("a symlinked scope directory is refused, under an absent headline", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-scopelink/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "vendor-scope/pack/package.json": manifest("@cskt-scopelink/pack"),
        "vendor-scope/pack/packed/SKILL.md.tmpl": PACKED,
      },
    });
    symlink(path.join(ws.repo, "vendor-scope"), ws.repo, "node_modules/@cskt-scopelink");

    const run = build(ws);

    expect(run.code).toBe(0);
    // Whole lines, in order: the headline is the failure itself, and the refusal is the line
    // *under* it and appears exactly once. A substring match cannot see either.
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: error source "@cskt-scopelink/pack" could not be resolved as a package ` +
        `— no "@cskt-scopelink/pack" in any node_modules from ${ws.repo} upward; is it ` +
        `installed? — skipped`,
      `composable-skills: warning source "@cskt-scopelink/pack": ` +
        `${path.join(ws.repo, "node_modules", "@cskt-scopelink")} was not looked through — ` +
        `${SYMLINK_REASON}. A copy of the package installed behind it was not considered.`,
      NO_SOURCES,
      NOT_PRUNED,
    ]);
    expect(exists(ws.repo, ".claude/skills/packed")).toBe(false);
  });

  // `node_modules` itself is above the exemption too, and an unscoped name has no scope directory
  // between the two — so this is the only place that lstat is reachable at all.
  test("a symlinked node_modules is refused, under an absent headline", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["cskt-nm-pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "vendor/cskt-nm-pack/package.json": manifest("cskt-nm-pack"),
        "vendor/cskt-nm-pack/packed/SKILL.md.tmpl": PACKED,
      },
    });
    symlink(path.join(ws.repo, "vendor"), ws.repo, "node_modules");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: error source "cskt-nm-pack" could not be resolved as a package — no ` +
        `"cskt-nm-pack" in any node_modules from ${ws.repo} upward; is it installed? — skipped`,
      `composable-skills: warning source "cskt-nm-pack": ${path.join(ws.repo, "node_modules")} ` +
        `was not looked through — ${SYMLINK_REASON}. A copy of the package installed behind it ` +
        `was not considered.`,
      NO_SOURCES,
      NOT_PRUNED,
    ]);
    expect(exists(ws.repo, ".claude/skills/packed")).toBe(false);
  });

  // What keeps the two refusals above from being over-refusals: a link at one level says nothing
  // about the level above, so the walk carries on and an ancestor's real install still resolves.
  // It resolves *loudly*, though — see the shadowing test below for why the warning is the point.
  test("a refusal at one level does not end the upward walk", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-cont/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "empty-scope/.keep": "",
      },
    });
    symlink(path.join(ws.repo, "empty-scope"), ws.repo, "node_modules/@cskt-cont");
    write(ws.root, {
      "node_modules/@cskt-cont/pack/package.json": manifest("@cskt-cont/pack"),
      "node_modules/@cskt-cont/pack/packed/SKILL.md.tmpl": PACKED,
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(compiled(ws, "packed")).toBe(PACKED);
    // Row 2, and the whole point of confirming before warning: a `stat` through the link found no
    // package behind it, so there is nothing to tell the developer and the run says nothing at
    // all. Asserted as an empty list rather than as an absent substring — a run that warned about
    // something else would pass the second and not the first.
    expect(diagnosticsOf(run)).toEqual([]);
  });

  /**
   * The shadowing the warning above exists for, made observable: the refused level *does* hold a
   * copy of the package, and it is a different copy. The build compiles the ancestor's templates
   * — the walk cannot do otherwise, since looking through the link is the thing invariant 8
   * forbids — so the only defence a developer has is being told. Without the warning this run is
   * indistinguishable from a clean one, and the skills that land in `.claude/skills` are not the
   * ones the lockfile installed.
   */
  test("a package shadowed behind a refused level warns, naming the copy that was used", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-shadow/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        // the copy the lockfile installed, reachable only through the refused scope link
        "vendor-scope/pack/package.json": manifest("@cskt-shadow/pack"),
        "vendor-scope/pack/lockfile-copy/SKILL.md.tmpl":
          "---\nname: lockfile-copy\n---\n\nThe copy this repo installed.\n",
      },
    });
    symlink(path.join(ws.repo, "vendor-scope"), ws.repo, "node_modules/@cskt-shadow");
    write(ws.root, {
      "node_modules/@cskt-shadow/pack/package.json": manifest("@cskt-shadow/pack"),
      "node_modules/@cskt-shadow/pack/ancestor-copy/SKILL.md.tmpl":
        "---\nname: ancestor-copy\n---\n\nA different package entirely.\n",
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    // the ancestor's copy is what compiled — that is the behaviour, and it is why this warns
    expect(exists(ws.repo, ".claude/skills/ancestor-copy")).toBe(true);
    expect(exists(ws.repo, ".claude/skills/lockfile-copy")).toBe(false);
    // Named, not hedged: the `stat` through the link saw the nearer copy, so the line says where
    // it is and says the build *is not* compiling it.
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: warning source "@cskt-shadow/pack" resolved to ` +
        `${path.join(ws.root, "node_modules", "@cskt-shadow", "pack")}, but a package is ` +
        `installed nearer the repo at ` +
        `${path.join(ws.repo, "node_modules", "@cskt-shadow", "pack")}: ` +
        `${path.join(ws.repo, "node_modules", "@cskt-shadow")} was not looked through — ` +
        `${SYMLINK_REASON}. The nearer copy would have won, so this build is not compiling the ` +
        `one installed for this repo.`,
      // a doubtful resolution is not a corpus this build can prune against
      NOT_PRUNED,
    ]);
  });

  /**
   * Symptom 2 of the same walk, from the other side: a symlinked `node_modules` in an ancestor the
   * project has nothing to do with — `$HOME/node_modules`, a container mount, a shared cache. The
   * refusal it produces must not become the headline of every missing-package error underneath it,
   * because it points at a directory the developer never named and it names no remedy.
   */
  test("a refused ancestor level does not displace the absent headline", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-unrelated/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER },
    });
    write(ws.root, { "shared-cache/.keep": "" });
    symlink(path.join(ws.root, "shared-cache"), ws.root, "node_modules");

    const run = build(ws);
    const errors = lines(run).filter((line) => line.startsWith("composable-skills: error "));

    expect(run.code).toBe(0);
    expect(errors).toEqual([
      `composable-skills: error source "@cskt-unrelated/pack" could not be resolved as a package ` +
        `— no "@cskt-unrelated/pack" in any node_modules from ${ws.repo} upward; is it ` +
        `installed? — skipped`,
    ]);
    // the refusal survives, as the line under it rather than in place of it
    expect(run.stdout).toContain(
      `composable-skills: warning source "@cskt-unrelated/pack": ` +
        `${path.join(ws.root, "node_modules")} was not looked through`,
    );
  });

  /**
   * The distinction `contain.ts` keeps `missing` and `unreadable` apart for, applied to the walk:
   * a `node_modules` this process cannot see into is not a package that was never installed, and
   * telling the developer "is it installed?" about it sends them to reinstall a package that is
   * very likely already there. `lstat` on the directory succeeds — the parent is readable — and
   * the `stat` of the manifest inside it is what fails.
   *
   * Injected rather than `chmod`'d for the reason the source-root case gives: mode 000 stops
   * nobody running as uid 0, which most CI images do.
   */
  test("a node_modules that cannot be read is not reported as a missing install", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-locked/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-locked/pack/package.json": manifest("@cskt-locked/pack"),
        "node_modules/@cskt-locked/pack/packed/SKILL.md.tmpl": PACKED,
      },
    });
    const manifestPath = path.join(ws.repo, "node_modules", "@cskt-locked", "pack", "package.json");

    const { result: run, fired } = withFsFailures({ calls: ["statSync"], when: manifestPath }, () =>
      build(ws),
    );

    expect(fired).toContain(`statSync ${manifestPath}`);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain(
      `composable-skills: error source "@cskt-locked/pack" could not be resolved as a package — ` +
        `${path.join(ws.repo, "node_modules", "@cskt-locked", "pack")} cannot be read: `,
    );
    expect(run.stdout).toContain(
      `, so whether "@cskt-locked/pack" is installed there is not something this build can tell; ` +
        `no node_modules it could read from ${ws.repo} upward holds it — skipped`,
    );
    // the claim the old walk made about it, which is the one thing it must not say
    expect(run.stdout).not.toContain("is it installed?");
  });

  // The other half of the same distinction: a level whose `lstat` itself fails is unreadable too,
  // and `isSymlink`'s `catch {}` used to read that as "not a symlink" and walk straight past it.
  test("a node_modules that cannot be lstat'd is unreadable rather than absent", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-nolstat/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-nolstat/pack/package.json": manifest("@cskt-nolstat/pack"),
      },
    });
    const modules = path.join(ws.repo, "node_modules");

    const { result: run, fired } = withFsFailures({ calls: ["lstatSync"], when: modules }, () =>
      build(ws),
    );

    expect(fired).toContain(`lstatSync ${modules}`);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain(
      `composable-skills: error source "@cskt-nolstat/pack" could not be resolved as a package ` +
        `— ${modules} cannot be read: `,
    );
    expect(run.stdout).not.toContain("is it installed?");
  });

  // The subpath half of the pnpm exemption: the root is a link, so every component below it is
  // resolved from the store directory the link lands in rather than from the link's own path.
  test("a symlinked package root resolves a subpath too", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-pnpmsub/pack/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER },
    });
    const store = "store/@cskt-pnpmsub+pack@1.0.0/node_modules/@cskt-pnpmsub/pack";
    write(ws.root, {
      [`${store}/package.json`]: manifest("@cskt-pnpmsub/pack"),
      [`${store}/templates/packed/SKILL.md.tmpl`]: PACKED,
      [`${store}/unpacked/SKILL.md.tmpl`]: "---\nname: unpacked\n---\n\nNot named.\n",
    });
    symlink(path.join(ws.root, ...store.split("/")), ws.repo, "node_modules/@cskt-pnpmsub/pack");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(false);
    expect(compiled(ws, "packed")).toBe(PACKED);
    expect(exists(ws.repo, ".claude/skills/unpacked")).toBe(false);
  });

  test("a wrapper package's templates compile like any other source", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@acme/skill-templates"],
        overrides: ["./.claude/skills-local"],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@acme/skill-templates/package.json":
          '{"name":"@acme/skill-templates","version":"1.0.0"}\n',
        "node_modules/@acme/skill-templates/fragments/rules.md": "Rule from the package.\n",
        "node_modules/@acme/skill-templates/wrapped/SKILL.md.tmpl": [
          "---",
          "name: wrapped",
          "---",
          "",
          "<!-- include: fragments/rules.md -->",
          "",
          "<!-- slot: s -->",
          "Packaged default.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        "node_modules/@acme/skill-templates/wrapped/references/guide.md": "Packaged guide.\n",
        ".claude/skills-local/wrapped/s.md": "The consuming repo's override.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(false);
    expect(compiled(ws, "wrapped")).toBe(
      "---\nname: wrapped\n---\n\nRule from the package.\n\nThe consuming repo's override.\n",
    );
    expect(read(ws.repo, ".claude/skills/wrapped/references/guide.md")).toBe("Packaged guide.\n");
  });

  test("one that cannot be resolved errors, and suppresses pruning for the whole run", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates", "@cskt-absent/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "templates/alpha/SKILL.md.tmpl": "---\nname: alpha\n---\n\nAlpha.\n",
        "templates/beta/SKILL.md.tmpl": "---\nname: beta\n---\n\nBeta.\n",
      },
    });

    build(ws);
    expect(exists(ws.repo, ".claude/skills/beta/SKILL.md")).toBe(true);

    remove(ws.repo, "templates/beta");
    const run = build(ws);

    expect(run.code).toBe(0);
    // The severity carries the exit code, so it is asserted on the line itself: `hasError` alone
    // would be satisfied by any unrelated diagnostic, which is how the warning-era title survived.
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain(
      'composable-skills: error source "@cskt-absent/pack" could not be resolved as a package ' +
        '— no "@cskt-absent/pack" in any node_modules from ',
    );
    expect(run.stdout).toContain("upward; is it installed? — skipped");
    // and the pruning suppression it has always carried, which the severity move leaves alone
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain("nothing was pruned");
    expect(exists(ws.repo, ".claude/skills/beta/SKILL.md")).toBe(true);
    expect(compiled(ws, "alpha")).toContain("Alpha.");
  });

  // `@acme` is here for the other half of the rule: a scope on its own names no package, and the
  // reason has to be the *spec* one. Every failure kind opens with "could not be resolved as a
  // package", so each is asserted down to the clause that says which kind it was — a bare scope
  // that fell through to the filesystem would report "no @acme in any node_modules" instead.
  test("a spec with an empty, `..` or missing segment is never treated as a package", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@acme//templates", "@acme/../../etc", "@acme"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER },
    });

    const run = build(ws);
    const notAPackageName =
      ' could not be resolved as a package — not a package name: a scoped name is "@scope/name", ' +
      'and no segment may be empty, ".", ".." or contain a NUL — skipped';

    expect(run.code).toBe(0);
    for (const spec of ["@acme//templates", "@acme/../../etc", "@acme"]) {
      expect(run.stdout).toContain(`source "${spec}"${notAPackageName}`);
    }
  });

  // The `..` rule has to be enforced on the spec itself, not left to the resolver: the bounded
  // fallback joins the segments onto `node_modules/`, where a `..` would otherwise reach a
  // sibling package the config never named.
  test("a `..` segment cannot walk sideways into another installed package", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@acme/../escaper"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/escaper/package.json": '{"name":"escaper","version":"1.0.0"}\n',
        "node_modules/escaper/sneaky/SKILL.md.tmpl": "---\nname: sneaky\n---\n\nSneaky.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('source "@acme/../escaper" could not be resolved as a package');
    expect(exists(ws.repo, ".claude/skills/sneaky")).toBe(false);
  });

  // The scope is unique to this test because the walk it asserts a miss from runs to the
  // filesystem root: any ancestor of the temp directory that happened to hold a package of this
  // name would satisfy it and the assertion would be of nothing.
  test("a directory in node_modules that is not a package is not a source root", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-loose/files"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        // A directory, but no package.json. This tool does not ask node to resolve anything —
        // deliberately: it asks the filesystem for a manifest, where node's own CommonJS
        // resolution would fall through to index.js. No manifest, no package.
        "node_modules/@cskt-loose/files/stray/SKILL.md.tmpl": "---\nname: stray\n---\n\nStray.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('source "@cskt-loose/files" could not be resolved as a package');
    expect(exists(ws.repo, ".claude/skills/stray")).toBe(false);
  });

  // The test above holds only because its fixture has no ancestor `node_modules` — "not accepted"
  // and "the walk stopped there" are indistinguishable when there is nothing further up. Here a
  // real package of the same name sits in an ancestor, so the walk's continuation is observable:
  // stopping at the first name match compiles nothing at all.
  test("a directory in node_modules with no package.json is walked past, not stopped at", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-walk/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        // The right name, and no package.json — so not a package here, for the reason the test
        // above gives: the manifest is asked of the filesystem, not of node's resolution.
        "node_modules/@cskt-walk/pack/stray/SKILL.md.tmpl": "---\nname: stray\n---\n\nStray.\n",
      },
    });
    write(ws.root, {
      "node_modules/@cskt-walk/pack/package.json": manifest("@cskt-walk/pack"),
      "node_modules/@cskt-walk/pack/packed/SKILL.md.tmpl": PACKED,
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(compiled(ws, "packed")).toBe(PACKED);
    expect(exists(ws.repo, ".claude/skills/stray")).toBe(false);
    // Row 4. The walk's behaviour is unchanged — it steps over and resolves above — but the entry
    // it stepped over is this repo's own install, which is a broken install rather than an
    // absence, and the developer is the one who can repair it.
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: warning source "@cskt-walk/pack" resolved to ` +
        `${path.join(ws.root, "node_modules", "@cskt-walk", "pack")}, but ` +
        `${path.join(ws.repo, "node_modules", "@cskt-walk", "pack")} is this repo's own install ` +
        `of it and is not a usable package — it has no readable package.json, so it was stepped ` +
        `over; reinstall to repair it.`,
      NOT_PRUNED,
    ]);
  });

  /**
   * Row 3. The steady state after `rm -rf node_modules/.pnpm`, a branch switch that drops a linked
   * workspace package, or a half-restored cache: the link the install left in `node_modules` is
   * still there and points at nothing. `lstat` sees it, so it is not an absence — and it is this
   * repo's own install, so the developer is the one who can repair it.
   */
  test("a dangling package-root link in the repo's own node_modules warns", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-dangle/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER },
    });
    const store = path.join(ws.repo, "node_modules", ".pnpm", "gone", "@cskt-dangle", "pack");
    symlink(store, ws.repo, "node_modules/@cskt-dangle/pack");
    write(ws.root, {
      "node_modules/@cskt-dangle/pack/package.json": manifest("@cskt-dangle/pack"),
      "node_modules/@cskt-dangle/pack/packed/SKILL.md.tmpl": PACKED,
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(compiled(ws, "packed")).toBe(PACKED);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: warning source "@cskt-dangle/pack" resolved to ` +
        `${path.join(ws.root, "node_modules", "@cskt-dangle", "pack")}, but ` +
        `${path.join(ws.repo, "node_modules", "@cskt-dangle", "pack")} is this repo's own ` +
        `install of it and is not a usable package — it has no readable package.json, so it was ` +
        `stepped over; reinstall to repair it.`,
      NOT_PRUNED,
    ]);
  });

  /**
   * Row 5, the counterweight to rows 3 and 4. The same broken entry one level up is governed by no
   * lockfile this developer controls and names them no action, so it is confirmed harmless and
   * nothing is said — and, because nothing is said, nothing is doubtful and pruning is untouched.
   *
   * The repo root is `repo/sub`, so `repo/node_modules` is an ancestor's rather than this repo's.
   */
  test("the same broken entry above the repo root says nothing", () => {
    const ws = workspace({
      config: null,
      repoFiles: {
        "sub/composable-skills.jsonc": `${JSON.stringify(
          {
            id: "acme",
            sources: ["@cskt-above/pack"],
            overrides: [],
            targets: ["./.claude/skills"],
          },
          null,
          2,
        )}\n`,
        "sub/package.json": CONSUMER,
      },
    });
    symlink(path.join(ws.repo, "gone"), ws.repo, "node_modules/@cskt-above/pack");
    write(ws.root, {
      "node_modules/@cskt-above/pack/package.json": manifest("@cskt-above/pack"),
      "node_modules/@cskt-above/pack/packed/SKILL.md.tmpl": PACKED,
    });

    const run = build(ws, { cwd: path.join(ws.repo, "sub") });

    expect(run.code).toBe(0);
    expect(read(ws.repo, "sub/.claude/skills/packed/SKILL.md")).toBe(PACKED);
    expect(diagnosticsOf(run)).toEqual([]);
  });

  /**
   * Row 6, and the `{ unreadable, resolved }` cell no other fixture reaches: every unreadable-level
   * case in the suite ends with nothing resolving anywhere. Here the walk resolves above it, so
   * the level is not the failure — it is a place a nearer copy could be sitting that this process
   * was not allowed to look at. The line has to hedge, because no `stat` could confirm anything.
   */
  test("a package hoisted above an unreadable manifest warns that the check could not be made", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-eaccess/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-eaccess/pack/package.json": manifest("@cskt-eaccess/pack"),
        "node_modules/@cskt-eaccess/pack/nearer/SKILL.md.tmpl":
          "---\nname: nearer\n---\n\nThe copy behind the unreadable manifest.\n",
      },
    });
    write(ws.root, {
      "node_modules/@cskt-eaccess/pack/package.json": manifest("@cskt-eaccess/pack"),
      "node_modules/@cskt-eaccess/pack/packed/SKILL.md.tmpl": PACKED,
    });
    const nearest = path.join(ws.repo, "node_modules", "@cskt-eaccess", "pack");
    const manifestPath = path.join(nearest, "package.json");

    const { result: run, fired } = withFsFailures({ calls: ["statSync"], when: manifestPath }, () =>
      build(ws),
    );

    expect(fired).toContain(`statSync ${manifestPath}`);
    expect(run.code).toBe(0);
    // the ancestor's copy is what compiled, and the nearer one was never read
    expect(compiled(ws, "packed")).toBe(PACKED);
    expect(exists(ws.repo, ".claude/skills/nearer")).toBe(false);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: warning source "@cskt-eaccess/pack" resolved to ` +
        `${path.join(ws.root, "node_modules", "@cskt-eaccess", "pack")}, but ${nearest} was not ` +
        `looked through — it cannot be read: ${injected("statSync", manifestPath)}, so whether a ` +
        `nearer copy of the package is installed behind it could not be checked; this build may ` +
        `not be compiling the one installed for this repo.`,
      NOT_PRUNED,
    ]);
  });

  /**
   * Row 6 met through a link rather than at a level of its own, which is the one cell of
   * `confirmSkippedLevel` no other fixture reaches: the level is refused for being a symlink, and
   * the confirming `stat` *through* it is the thing that fails. Neither of the two confident
   * verdicts is available — no copy was seen, and none was ruled out — so the line hedges, and it
   * still names the link as the reason the walk did not go that way.
   */
  test("a link whose candidate cannot be stat'd is hedged, not called harmless", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-linklocked/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER, "vendor-scope/.keep": "" },
    });
    symlink(path.join(ws.repo, "vendor-scope"), ws.repo, "node_modules/@cskt-linklocked");
    write(ws.root, {
      "node_modules/@cskt-linklocked/pack/package.json": manifest("@cskt-linklocked/pack"),
      "node_modules/@cskt-linklocked/pack/packed/SKILL.md.tmpl": PACKED,
    });
    const scope = path.join(ws.repo, "node_modules", "@cskt-linklocked");
    const candidateManifest = path.join(scope, "pack", "package.json");

    const { result: run, fired } = withFsFailures(
      { calls: ["statSync"], when: candidateManifest },
      () => build(ws),
    );

    // the walk never stats through a refused level; this is the confirming stat and nothing else
    expect(fired).toEqual([`statSync ${candidateManifest}`]);
    expect(run.code).toBe(0);
    expect(compiled(ws, "packed")).toBe(PACKED);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: warning source "@cskt-linklocked/pack" resolved to ` +
        `${path.join(ws.root, "node_modules", "@cskt-linklocked", "pack")}, but ${scope} was ` +
        `not looked through — ${SYMLINK_REASON}, so whether a nearer copy of the package is ` +
        `installed behind it could not be checked; this build may not be compiling the one ` +
        `installed for this repo.`,
      NOT_PRUNED,
    ]);
  });

  /**
   * Two skipped levels of different kinds, nothing resolving. The rule is that a symlink refusal
   * never takes the headline — it is a rule this tool chose, and it names no remedy — so the
   * headline is the unreadable level even though the symlink was met first. With one skipped level
   * that claim is unfalsifiable: "the first unreadable", "the last unreadable" and "the first
   * skipped level of any kind" are the same answer. Here they are three different answers.
   */
  test("an unreadable level takes the headline from a nearer symlink", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-order/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER, "empty-scope/.keep": "" },
    });
    symlink(path.join(ws.repo, "empty-scope"), ws.repo, "node_modules/@cskt-order");
    write(ws.root, {
      "node_modules/@cskt-order/pack/package.json": manifest("@cskt-order/pack"),
      "node_modules/@cskt-order/pack/packed/SKILL.md.tmpl": PACKED,
    });
    const ancestor = path.join(ws.root, "node_modules", "@cskt-order", "pack");
    const manifestPath = path.join(ancestor, "package.json");

    const { result: run, fired } = withFsFailures({ calls: ["statSync"], when: manifestPath }, () =>
      build(ws),
    );

    expect(fired).toContain(`statSync ${manifestPath}`);
    expect(run.code).toBe(0);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: error source "@cskt-order/pack" could not be resolved as a package — ` +
        `${ancestor} cannot be read: ${injected("statSync", manifestPath)}, so whether ` +
        `"@cskt-order/pack" is installed there is not something this build can tell; no ` +
        `node_modules it could read from ${ws.repo} upward holds it — skipped`,
      `composable-skills: warning source "@cskt-order/pack": ` +
        `${path.join(ws.repo, "node_modules", "@cskt-order")} was not looked through — ` +
        `${SYMLINK_REASON}. A copy of the package installed behind it was not considered.`,
      NO_SOURCES,
      NOT_PRUNED,
    ]);
    expect(exists(ws.repo, ".claude/skills/packed")).toBe(false);
  });

  /**
   * Two unreadable levels at different depths, which is what makes "the *first* unreadable level
   * is the headline" a testable claim rather than a restatement of "the only one". It is also the
   * only shape where the de-dup matters: the level promoted to the headline must not also appear
   * as a note under itself, and the note that remains must be the *other* level.
   */
  test("a second unreadable level rides as context under the first", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-twolevel/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-twolevel/pack/package.json": manifest("@cskt-twolevel/pack"),
      },
    });
    write(ws.root, {
      "node_modules/@cskt-twolevel/pack/package.json": manifest("@cskt-twolevel/pack"),
    });
    const nearest = path.join(ws.repo, "node_modules", "@cskt-twolevel", "pack");
    const ancestor = path.join(ws.root, "node_modules", "@cskt-twolevel", "pack");
    const manifestOf = (root: string) => path.join(root, "package.json");

    const { result: run, fired } = withFsFailures(
      {
        calls: ["statSync"],
        // Scoped to the workspace: the chain runs to the filesystem root, and a predicate that
        // matched everywhere would make `/tmp` and `/` unreadable levels too.
        when: (target) =>
          target.startsWith(`${ws.root}${path.sep}`) &&
          target.endsWith(path.join("@cskt-twolevel", "pack", "package.json")),
      },
      () => build(ws),
    );

    expect(fired).toEqual([`statSync ${manifestOf(nearest)}`, `statSync ${manifestOf(ancestor)}`]);
    expect(run.code).toBe(0);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: error source "@cskt-twolevel/pack" could not be resolved as a package ` +
        `— ${nearest} cannot be read: ${injected("statSync", manifestOf(nearest))}, so whether ` +
        `"@cskt-twolevel/pack" is installed there is not something this build can tell; no ` +
        `node_modules it could read from ${ws.repo} upward holds it — skipped`,
      `composable-skills: warning source "@cskt-twolevel/pack": ${ancestor} was not looked ` +
        `through — it cannot be read: ${injected("statSync", manifestOf(ancestor))}. A copy of ` +
        `the package installed behind it was not considered.`,
      NO_SOURCES,
      NOT_PRUNED,
    ]);
  });

  /**
   * A `package.json` that is a directory rather than a file. `statSync` succeeds on it, so a
   * manifest check that only asked whether the `stat` threw would accept the entry as a package
   * and compile whatever is beside it — which is why the check asks `isFile()`. What is beside it
   * here is a different skill from the one the ancestor's real package carries, so the two
   * outcomes are told apart by the output and not only by the diagnostics.
   */
  test("a package.json that is a directory is not a manifest", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-dirmanifest/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-dirmanifest/pack/package.json/README.md": "Not a manifest.\n",
        "node_modules/@cskt-dirmanifest/pack/nearer/SKILL.md.tmpl":
          "---\nname: nearer\n---\n\nBeside the directory that is not a manifest.\n",
      },
    });
    write(ws.root, {
      "node_modules/@cskt-dirmanifest/pack/package.json": manifest("@cskt-dirmanifest/pack"),
      "node_modules/@cskt-dirmanifest/pack/packed/SKILL.md.tmpl": PACKED,
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(compiled(ws, "packed")).toBe(PACKED);
    expect(exists(ws.repo, ".claude/skills/nearer")).toBe(false);
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: warning source "@cskt-dirmanifest/pack" resolved to ` +
        `${path.join(ws.root, "node_modules", "@cskt-dirmanifest", "pack")}, but ` +
        `${path.join(ws.repo, "node_modules", "@cskt-dirmanifest", "pack")} is this repo's own ` +
        `install of it and is not a usable package — it has no readable package.json, so it was ` +
        `stepped over; reinstall to repair it.`,
      NOT_PRUNED,
    ]);
  });
});

/**
 * The prune guard, from both sides. A package source that resolved to a copy this build cannot
 * vouch for is the same situation as a source root that could not be read end to end: the corpus
 * that resolved may not be the corpus that exists, and a substitution that empties the target must
 * not take the compiled skills with it. The converse matters just as much — rows 2 and 5 of the
 * table are ordinary layouts (pnpm's scope links, a shared `node_modules` above the repo), and a
 * guard that fired on those would stop pruning for most installs that use them.
 */
describe("pruning against a package source", () => {
  const CONSUMER = '{"name":"consumer","version":"0.0.0","private":true}\n';
  const manifest = (name: string) => `{"name":"${name}","version":"1.0.0"}\n`;
  const ALPHA = "---\nname: alpha\n---\n\nAlpha.\n";
  const BETA = "---\nname: beta\n---\n\nBeta.\n";

  test("a doubtful resolution emits but deletes nothing", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-guard/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        "node_modules/@cskt-guard/pack/package.json": manifest("@cskt-guard/pack"),
        "node_modules/@cskt-guard/pack/alpha/SKILL.md.tmpl": ALPHA,
        "node_modules/@cskt-guard/pack/beta/SKILL.md.tmpl": BETA,
      },
    });

    const baseline = build(ws);
    expect(diagnosticsOf(baseline)).toEqual([]);
    expect(compiled(ws, "alpha")).toBe(ALPHA);
    expect(compiled(ws, "beta")).toBe(BETA);

    // The lockfile's copy moves behind a scope link — where the walk will not look — and an empty
    // package of the same name appears above the repo. The walk resolves to the empty one, so the
    // corpus reads as zero skills and both compiled skills are orphans by the usual rule.
    remove(ws.repo, "node_modules/@cskt-guard");
    write(ws.repo, {
      "vendor-scope/pack/package.json": manifest("@cskt-guard/pack"),
      "vendor-scope/pack/alpha/SKILL.md.tmpl": ALPHA,
      "vendor-scope/pack/beta/SKILL.md.tmpl": BETA,
    });
    symlink(path.join(ws.repo, "vendor-scope"), ws.repo, "node_modules/@cskt-guard");
    write(ws.root, {
      "node_modules/@cskt-guard/pack/package.json": manifest("@cskt-guard/pack"),
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    // The whole summary line, so the absence of a ", 2 pruned" tail is asserted rather than hoped
    // for: the corpus that resolved holds nothing, and nothing is what was deleted.
    expect(lines(run)).toContain("composable-skills: 0 skills → 1 target");
    expect(diagnosticsOf(run)).toEqual([
      `composable-skills: warning source "@cskt-guard/pack" resolved to ` +
        `${path.join(ws.root, "node_modules", "@cskt-guard", "pack")}, but a package is ` +
        `installed nearer the repo at ` +
        `${path.join(ws.repo, "node_modules", "@cskt-guard", "pack")}: ` +
        `${path.join(ws.repo, "node_modules", "@cskt-guard")} was not looked through — it is a ` +
        `symlink, and only the root a config entry names may be one. The nearer copy would have ` +
        `won, so this build is not compiling the one installed for this repo.`,
      NOT_PRUNED,
    ]);
    // the whole point: neither skill was deleted by a resolution the build could not vouch for
    expect(compiled(ws, "alpha")).toBe(ALPHA);
    expect(compiled(ws, "beta")).toBe(BETA);
  });

  test("a skipped level confirmed harmless prunes exactly as before", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-stillprunes/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER, "empty-scope/.keep": "" },
    });
    // Row 2: a scope link the walk steps over, with no package behind it. Present for both builds.
    symlink(path.join(ws.repo, "empty-scope"), ws.repo, "node_modules/@cskt-stillprunes");
    write(ws.root, {
      "node_modules/@cskt-stillprunes/pack/package.json": manifest("@cskt-stillprunes/pack"),
      "node_modules/@cskt-stillprunes/pack/alpha/SKILL.md.tmpl": ALPHA,
      "node_modules/@cskt-stillprunes/pack/beta/SKILL.md.tmpl": BETA,
    });

    const baseline = build(ws);
    expect(diagnosticsOf(baseline)).toEqual([]);
    expect(compiled(ws, "beta")).toBe(BETA);

    remove(ws.root, "node_modules/@cskt-stillprunes/pack/beta");
    const run = build(ws);

    expect(run.code).toBe(0);
    expect(diagnosticsOf(run)).toEqual([]);
    expect(run.stdout).toContain("1 pruned");
    expect(exists(ws.repo, ".claude/skills/beta")).toBe(false);
    expect(compiled(ws, "alpha")).toBe(ALPHA);
  });
});

/**
 * The rule a consuming team holds in their head: *a source you named that the tool cannot use
 * fails `--check`*. `build` stays fail-soft throughout, so every case here asserts the gate's exit
 * code rather than the build's.
 *
 * Each failing case builds first and gates second, so the 1 is the diagnostic's severity rather
 * than staleness — asserted directly where the fixture can make the stamp verifiably fresh first.
 */
describe("a source the tool cannot use", () => {
  const CONSUMER = '{"name":"consumer","version":"0.0.0","private":true}\n';
  const TEMPLATE = { "templates/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" };

  test("--check exits 1 for a package source that cannot be resolved", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-check-absent/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER },
    });

    expect(build(ws).code).toBe(0);

    const checked = build(ws, { check: true });

    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain(
      'composable-skills: error source "@cskt-check-absent/pack" could not be resolved as a package',
    );
    expect(checked.stdout).not.toContain("compiled output is up to date");
  });

  // The likelier cause, and the shape `init` scaffolds: one typo in the source entry.
  test("--check exits 1 for a mistyped path source", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./skils/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "skills/templates/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" },
    });

    expect(build(ws).code).toBe(0);

    const checked = build(ws, { check: true });

    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain(
      'composable-skills: error source root "./skils/templates" does not exist at ',
    );
    // The remedy, which is the same for every caller of this diagnostic and is also the only
    // place a developer who has only ever written paths is told the package form exists.
    expect(checked.stdout).toContain(
      `${path.join(ws.repo, "skils", "templates")} — skipped; create it, or point "sources" at ` +
        "an installed package",
    );
    expect(checked.stdout).not.toContain("compiled output is up to date");
  });

  test("--check exits 1 for a source root that resolves but cannot be read", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates", "./locked"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: TEMPLATE,
    });
    const locked = mkdir(ws.repo, "locked");

    expect(build(ws).code).toBe(0);
    // green first, with the same stamp inputs — an unreadable directory contributes nothing to the
    // hash either way, so the 1 below cannot be staleness
    expect(build(ws, { check: true }).code).toBe(0);

    // Injected rather than `chmod`'d: mode 000 stops nobody running as uid 0, which most CI
    // images do, and there the directory would simply read and the premise evaporate. `fired` is
    // what says the failure the test asked for is the one that happened.
    const { result: checked, fired } = withFsFailures(
      { calls: ["readdirSync"], when: locked },
      () => build(ws, { check: true }),
    );

    expect(fired).toContain(`readdirSync ${locked}`);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain(`composable-skills: error cannot read source root ${locked}`);
    expect(checked.stdout).not.toContain("compiled output is up to date");
    expect(checked.stdout).not.toContain("compiled output is stale");
  });

  // The case that was invisible before: the repo compiles its own skills while a whole packaged
  // corpus is missing, so a gate keyed on "did anything compile" would stay green.
  test("--check exits 1 for a partial failure, even though skills compiled", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates", "@cskt-check-partial/pack"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER, ...TEMPLATE },
    });

    expect(build(ws).code).toBe(0);
    expect(compiled(ws, "x")).toContain("Body.");

    const checked = build(ws, { check: true });

    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain(
      'composable-skills: error source "@cskt-check-partial/pack" could not be resolved as a package',
    );
    expect(checked.stdout).not.toContain("compiled output is up to date");
  });

  // The inert default, which is not a mistake: `DEFAULT_SOURCES` is empty, so a config that names
  // no source at all is a repo that has not started rather than one that lost something.
  test("--check exits 0 for a config that declares no sources at all", () => {
    const ws = workspace({
      config: { id: "acme", overrides: [], targets: ["./.claude/skills"] },
    });

    expect(build(ws).code).toBe(0);

    const checked = build(ws, { check: true });

    expect(checked.code).toBe(0);
    expect(hasError(checked)).toBe(false);
    expect(checked.stdout).toContain(
      "composable-skills: warning no usable source roots — no skills to compile",
    );
    expect(checked.stdout).toContain("compiled output is up to date");
  });

  // An empty corpus is a legitimate steady state; erroring on it would make a fresh repo red.
  test("--check exits 0 for a source root that resolves and is empty", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
    });
    mkdir(ws.repo, "templates");

    expect(build(ws).code).toBe(0);

    const checked = build(ws, { check: true });

    expect(checked.code).toBe(0);
    expect(hasError(checked)).toBe(false);
    expect(hasWarning(checked)).toBe(false);
    expect(checked.stdout).toContain("compiled output is up to date");
  });
});

describe("a source root holding the build's own output", () => {
  test('sources: ["."] warns that the target is an input to the next stamp', () => {
    const ws = workspace({
      config: { id: "acme", sources: ["."], overrides: [], targets: ["./.claude/skills"] },
      repoFiles: { "x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain('composable-skills: warning source root "." at ');
    expect(run.stdout).toContain(' contains target root "./.claude/skills" at ');
    expect(run.stdout).toContain(
      ", which the next build's stamp hashes as an input — so a build recompiles when nothing " +
        "changed",
    );
    expect(run.stdout).toContain("Keep compiled output and build state outside the source roots.");
    // a warning, not an error: the layout works, it just rebuilds for nothing
    expect(compiled(ws, "x")).toContain("Body.");
  });

  /**
   * The other half of the warning, and the worse shape: the state directory is rewritten every
   * run, so `--check` is stale forever rather than settling after one rebuild. Unreachable while
   * a target is also inside the source root — the targets are examined first and the first
   * offender found is the one named — so the target list is empty here.
   */
  test('sources: ["."] with no target names the build state directory instead', () => {
    const ws = workspace({
      config: { id: "acme", sources: ["."], overrides: [], targets: [] },
      repoFiles: { "x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(run.stdout).toContain('composable-skills: warning source root "." at ');
    expect(run.stdout).toContain(` contains the build state directory ${ws.repo}`);
    expect(run.stdout).toContain(
      '"build --check" reports stale forever. Keep compiled output and build state outside the ' +
        "source roots.",
    );
  });

  /**
   * The layout the realpath arm of `rootContains` exists for: a workspace package linked into
   * `node_modules`, whose target sits inside the package's real directory. The source root's path
   * is the *walked* path — `findPackageRoot` returns what it joined, not a `realpath` — so
   * `<repo>/node_modules/@cskt-link/pack` and `<repo>/packages/pack/out` are lexically unrelated
   * and only the real paths show the containment. `listEntries` reads the source root through the
   * link and hashes the output under it all the same, so the warning is right to fire.
   */
  test("a target inside a symlinked package source root still warns", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@cskt-link/pack"],
        overrides: [],
        targets: ["./packages/pack/out"],
      },
      repoFiles: {
        "package.json": '{"name":"consumer","version":"0.0.0","private":true}\n',
        "packages/pack/package.json": '{"name":"@cskt-link/pack","version":"1.0.0"}\n',
        "packages/pack/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n",
      },
    });
    symlink(path.join("..", "..", "packages", "pack"), ws.repo, "node_modules/@cskt-link/pack");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain('composable-skills: warning source root "@cskt-link/pack" at ');
    expect(run.stdout).toContain(' contains target root "./packages/pack/out" at ');
    expect(read(ws.repo, "packages/pack/out/x/SKILL.md")).toContain("Body.");
  });

  test("the same target under a templates subdirectory does not warn", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./skills/templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "skills/templates/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(false);
    expect(compiled(ws, "x")).toContain("Body.");
  });
});

describe("id", () => {
  test("with none declared, the ${id} root is skipped and the rest of the chain still works", () => {
    const ws = workspace({
      config: { sources: ["./templates"] },
      repoFiles: {
        "templates/n/SKILL.md.tmpl":
          "---\nname: n\n---\n\n<!-- slot: s -->\nThe template default.\n<!-- /slot -->\n",
      },
      homeFiles: { "global/n/s.md": "From global.\n" },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(
      'override "${home}/repos/${id}" uses ${id} but the config declares no "id" — skipped',
    );
    expect(compiled(ws, "n")).toBe("---\nname: n\n---\n\nFrom global.\n");
  });

  // The source half of the same rule, at the other severity. An override or target named with an
  // undeclared ${id} is inert by design — `${home}/repos/${id}` ships in DEFAULT_OVERRIDES — while
  // a *source* named that way is a corpus the tool was told to compile and cannot find, so it is
  // an error and it moves `--check` to 1.
  test("a ${id} source with no id declared is an error, and fails --check", () => {
    const ws = workspace({
      config: { sources: ["./templates/${id}"], overrides: [], targets: ["./.claude/skills"] },
      repoFiles: { "templates/acme/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" },
    });

    expect(build(ws).code).toBe(0);
    expect(exists(ws.repo, ".claude/skills/x")).toBe(false);

    const checked = build(ws, { check: true });

    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain(
      'composable-skills: error source "./templates/${id}" uses ${id} but the config declares ' +
        'no "id" — skipped',
    );
    expect(checked.stdout).not.toContain("compiled output is up to date");
  });

  for (const bad of ["../evil", ".", "..", "a/b", "has space", "nul\u0000byte"]) {
    test(`${JSON.stringify(bad)} is fatal, and nothing is written`, () => {
      const ws = workspace({
        config: { id: bad, sources: ["./templates"] },
        repoFiles: { "templates/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" },
      });

      const run = build(ws);

      expect(run.code).toBe(0);
      expect(hasError(run)).toBe(true);
      expect(run.stdout).toContain('"id" must be a single path segment');
      expect(exists(ws.repo, ".claude/skills")).toBe(false);
      expect(build(ws, { check: true }).code).toBe(1);
    });
  }
});

describe("a config that cannot be loaded", () => {
  const TEMPLATE = {
    "templates/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n",
  };

  for (const key of ["sources", "overrides", "targets"] as const) {
    test(`"${key}" as a bare string names that key, not just the file`, () => {
      const ws = workspace({
        config: { id: "acme", [key]: "./templates" },
        repoFiles: TEMPLATE,
      });

      const run = build(ws);

      expect(run.code).toBe(0);
      expect(hasError(run)).toBe(true);
      expect(run.stdout).toContain(`"${key}" must be an array of strings`);
      expect(exists(ws.repo, ".claude/skills")).toBe(false);
    });
  }

  test("the per-key error and the generic summary are both printed, in that order", () => {
    const ws = workspace({
      config: { id: "acme", sources: "./templates" },
      repoFiles: TEMPLATE,
    });

    const run = build(ws);
    const printed = lines(run);
    const configPath = path.join(ws.repo, "composable-skills.jsonc");

    expect(printed).toEqual([
      `composable-skills: error [${configPath}] "sources" must be an array of strings`,
      `composable-skills: error ${configPath} is invalid; nothing was built`,
    ]);
  });

  test("every wrong key is named, not just the first", () => {
    const ws = workspace({
      config: { id: "acme", sources: "./templates", overrides: 7, targets: [1, 2] },
      repoFiles: TEMPLATE,
    });

    const run = build(ws);

    expect(run.stdout).toContain('"sources" must be an array of strings');
    expect(run.stdout).toContain('"overrides" must be an array of strings');
    expect(run.stdout).toContain('"targets" must be an array of strings');
  });

  test("an array holding a non-string is as fatal as no array at all", () => {
    const ws = workspace({
      config: { id: "acme", sources: ["./templates", 3] },
      repoFiles: TEMPLATE,
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"sources" must be an array of strings');
  });

  test("build --check still exits non-zero while build stays fail-soft", () => {
    const ws = workspace({
      config: { id: "acme", sources: "./templates" },
      repoFiles: TEMPLATE,
    });

    expect(build(ws).code).toBe(0);

    const checked = build(ws, { check: true });

    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain('"sources" must be an array of strings');
  });

  test("init names the key too, alongside its own advice", () => {
    const ws = workspace({
      config: { id: "acme", sources: "./templates" },
      repoFiles: TEMPLATE,
      git: true,
    });

    const run = init(ws);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('"sources" must be an array of strings');
    expect(run.stdout).toContain("is invalid; nothing was built");
    expect(run.stdout).toContain("init needs a config it can read");
  });

  test("override names the key too", () => {
    const ws = workspace({
      config: { id: "acme", sources: "./templates" },
      repoFiles: TEMPLATE,
    });

    const run = override(ws, "x", "s");

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('"sources" must be an array of strings');
    expect(run.stdout).toContain("is invalid; nothing was built");
  });

  test("an empty id is fatal and says so specifically", () => {
    const ws = workspace({
      config: { id: "", sources: ["./templates"] },
      repoFiles: TEMPLATE,
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"id" must be a non-empty string');
    expect(exists(ws.repo, ".claude/skills")).toBe(false);
    expect(build(ws, { check: true }).code).toBe(1);
  });

  test("a config that is not a JSON object is fatal", () => {
    const ws = workspace({ config: "[1, 2]\n", repoFiles: TEMPLATE });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("must contain a JSON object");
  });

  test("unparseable text is fatal and quotes the parser", () => {
    const ws = workspace({ config: '{ "id" "acme" }\n', repoFiles: TEMPLATE });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("cannot parse");
    expect(exists(ws.repo, ".claude/skills")).toBe(false);
  });
});

describe("blanking JSONC", () => {
  const CASES = [
    '// lead\n{\n  /* a\n     b */ "id": "x",\n  "sources": ["t",],\n}\n',
    '{ "a": "// not a comment", "b": "/* nor this */" }\n',
    "/* unterminated\n{}\n",
    '{ "a": 1 } // no trailing newline',
    '{ "a": "quote \\" then // not a comment" }\n',
  ];

  for (const text of CASES) {
    test(`preserves length and line breaks: ${JSON.stringify(text.slice(0, 24))}`, () => {
      const blanked = blankTrailingCommas(blankJsonComments(text));

      expect(blanked.length).toBe(text.length);
      expect(blanked.split("\n").length).toBe(text.split("\n").length);
    });
  }

  test("a parser's reported offset therefore addresses the original file", () => {
    const text = '// lead comment here\n{\n  /* block */ "id": "x",\n  "sources" ["t"]\n}\n';
    const blanked = blankTrailingCommas(blankJsonComments(text));

    expect(blanked.indexOf("[")).toBe(text.indexOf('["t"]'));
    expect(() => parseJsonc(text)).toThrow();
  });

  test("comments and a trailing comma still parse away", () => {
    expect(parseJsonc('// c\n{ "a": [1, 2,], /* b */ "c": 3, }\n')).toEqual({ a: [1, 2], c: 3 });
  });
});

describe("unknown config keys", () => {
  test("are warned about and otherwise ignored", () => {
    const ws = workspace({
      config: { id: "acme", sources: ["./templates"], sourcs: ["./typo"] },
      repoFiles: { "templates/x/SKILL.md.tmpl": "---\nname: x\n---\n\nBody.\n" },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain('unknown config key "sourcs" ignored');
    expect(compiled(ws, "x")).toContain("Body.");
  });
});
