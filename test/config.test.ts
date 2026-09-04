import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { blankJsonComments, blankTrailingCommas, homeRoot, parseJsonc } from "../src/config.ts";
import {
  build,
  cleanup,
  compiled,
  exists,
  hasError,
  hasWarning,
  init,
  lines,
  override,
  read,
  remove,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

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
    expect(compiled(ws, "wrapped")).toBe(
      "---\nname: wrapped\n---\n\nRule from the package.\n\nThe consuming repo's override.\n",
    );
    expect(read(ws.repo, ".claude/skills/wrapped/references/guide.md")).toBe("Packaged guide.\n");
  });

  test("one that cannot be resolved warns, and suppresses pruning for the whole run", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates", "@acme/absent"],
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
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain('source "@acme/absent" could not be resolved as a package');
    expect(run.stdout).toContain("nothing was pruned");
    expect(exists(ws.repo, ".claude/skills/beta/SKILL.md")).toBe(true);
    expect(compiled(ws, "alpha")).toContain("Alpha.");
  });

  test("a spec with an empty or `..` segment is never treated as a package", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@acme//templates", "@acme/../../etc"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "package.json": CONSUMER },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('source "@acme//templates" could not be resolved as a package');
    expect(run.stdout).toContain('source "@acme/../../etc" could not be resolved as a package');
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

  test("a directory in node_modules that is not a package is not a source root", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["@acme/loose-files"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "package.json": CONSUMER,
        // a directory, but no package.json — not a package by node's own rule
        "node_modules/@acme/loose-files/stray/SKILL.md.tmpl": "---\nname: stray\n---\n\nStray.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('source "@acme/loose-files" could not be resolved as a package');
    expect(exists(ws.repo, ".claude/skills/stray")).toBe(false);
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
