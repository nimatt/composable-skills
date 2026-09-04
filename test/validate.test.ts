import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  build,
  cleanup,
  compiled,
  exists,
  hasError,
  hasWarning,
  lines,
  read,
  symlink,
  workspace,
  write,
} from "./fixtures/workspace.ts";
import type { BuildRun, Workspace, WorkspaceOptions } from "./fixtures/workspace.ts";

afterEach(cleanup);

/**
 * One workspace-and-build helper for every rejection test, including the ones that need to plant
 * a symlink or a second source root before building.
 */
function rejects(
  options: WorkspaceOptions & { skill: string; prepare?: (ws: Workspace) => void },
) {
  const { skill, prepare, ...rest } = options;
  const ws = workspace(rest);
  prepare?.(ws);
  const run = build(ws);
  return { ws, run, written: exists(ws.repo, `.claude/skills/${skill}/SKILL.md`) };
}

describe("rejected", () => {
  test("merge-conflict markers in a template", () => {
    const { run, written } = rejects({
      skill: "conflict",
      repoFiles: {
        "templates/conflict/SKILL.md.tmpl": [
          "---",
          "name: conflict",
          "---",
          "",
          "<<<<<<< HEAD",
          "ours",
          "=======",
          "theirs",
          ">>>>>>> branch",
          "",
        ].join("\n"),
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("merge-conflict marker");
    expect(written).toBe(false);
  });

  test("merge-conflict markers in an included fragment", () => {
    const { ws, run, written } = rejects({
      skill: "incconflict",
      repoFiles: {
        "templates/fragments/rules.md": "clean line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n",
        "templates/incconflict/SKILL.md.tmpl":
          "---\nname: incconflict\n---\n\n<!-- include: fragments/rules.md -->\n",
      },
    });

    expect(run.code).toBe(0);
    expect(written).toBe(false);
    // the fragment is named, not the template that included it, and the line is the fragment's own
    const fragment = path.join(ws.repo, "templates", "fragments", "rules.md");
    expect(lines(run)).toContain(
      `composable-skills: error [incconflict ${fragment}:2] merge-conflict marker "<<<<<<< HEAD"`,
    );
  });

  // The spec lists "merge-conflict markers in any compiled input — a template, an included
  // fragment, or an override file" among the rejections, and an override root may be tracked,
  // which is exactly where a merge leaves them.
  test("merge-conflict markers in an override file", () => {
    const { ws, run, written } = rejects({
      skill: "ovconflict",
      repoFiles: {
        "templates/ovconflict/SKILL.md.tmpl": [
          "---",
          "name: ovconflict",
          "---",
          "",
          "<!-- slot: s -->",
          "The safe default.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        ".claude/skills-local/ovconflict/s.md": [
          "<<<<<<< HEAD",
          "our version",
          "=======",
          "their version",
          ">>>>>>> feature",
          "",
        ].join("\n"),
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(written).toBe(false);
    const override = path.join(ws.repo, ".claude", "skills-local", "ovconflict", "s.md");
    expect(lines(run)).toContain(
      `composable-skills: error [ovconflict ${override}:1] merge-conflict marker "<<<<<<< HEAD"`,
    );
  });

  test("a stray closing directive", () => {
    const { run, written } = rejects({
      skill: "stray",
      repoFiles: {
        "templates/stray/SKILL.md.tmpl": "---\nname: stray\n---\n\nBody.\n<!-- /slot -->\n",
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("stray <!-- /slot --> closing no slot");
    expect(written).toBe(false);
  });

  test("a near-miss of a real directive", () => {
    const { run, written } = rejects({
      skill: "near",
      repoFiles: {
        "templates/near/SKILL.md.tmpl": "---\nname: near\n---\n\n<!-- SLOT: shouty -->\n",
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("unknown or malformed directive");
    expect(written).toBe(false);
  });

  test("an unknown slot attribute", () => {
    const { run, written } = rejects({
      skill: "attr",
      repoFiles: {
        "templates/attr/SKILL.md.tmpl": "---\nname: attr\n---\n\n<!-- slot: s mode=prepend -->\n",
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("only mode=replace|append is defined");
    expect(written).toBe(false);
  });

  test("a duplicate slot name within one skill, named at the line that repeats it", () => {
    const { ws, run, written } = rejects({
      skill: "dup",
      repoFiles: {
        "templates/dup/SKILL.md.tmpl": [
          "---", //             1
          "name: dup", //       2
          "---", //             3
          "", //                4
          "<!-- slot: same -->", // 5
          "First.", //          6
          "<!-- /slot -->", //  7
          "", //                8
          "<!-- slot: same -->", // 9  ← the offending line
          "Second.", //        10
          "<!-- /slot -->", // 11
          "", //               12
        ].join("\n"),
      },
    });

    expect(run.code).toBe(0);
    expect(written).toBe(false);
    const template = path.join(ws.repo, "templates", "dup", "SKILL.md.tmpl");
    expect(lines(run)).toContain(
      `composable-skills: error [dup ${template}:9] duplicate slot name "same"`,
    );
  });

  test("an override that injects directive syntax into the output", () => {
    const { run, written } = rejects({
      skill: "leftover",
      repoFiles: {
        "templates/leftover/SKILL.md.tmpl":
          "---\nname: leftover\n---\n\n<!-- slot: s -->\nDefault.\n<!-- /slot -->\n",
        ".claude/skills-local/leftover/s.md": "<!-- slot: smuggled -->\n",
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("directive syntax left in the output");
    expect(written).toBe(false);
  });

  // `expandIncludes` is a single pass by design: a fragment's own `include:` is copied through
  // unexpanded, and the leftover-directive scan is what turns it into a named rejection.
  test("a nested include is not expanded — it survives and is rejected as leftover syntax", () => {
    const { run, written } = rejects({
      skill: "nested",
      repoFiles: {
        "templates/fragments/outer.md": "Outer text.\n<!-- include: fragments/inner.md -->\n",
        "templates/fragments/inner.md": "Inner text.\n",
        "templates/nested/SKILL.md.tmpl":
          "---\nname: nested\n---\n\n<!-- include: fragments/outer.md -->\n",
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("directive syntax left in the output: <!-- include: fragments/inner.md -->");
    expect(written).toBe(false);
  });
});

describe("names the compiler writes itself", () => {
  for (const [label, name] of [
    ["SKILL.md", "SKILL.md"],
    ["a differently-cased SKILL.md", "skill.md"],
    ["the ownership marker", ".composable-skills-owner"],
  ] as const) {
    test(`${label} in the source skill directory is a rejection`, () => {
      const { run, written } = rejects({
        skill: "reserved",
        repoFiles: {
          "templates/reserved/SKILL.md.tmpl": "---\nname: reserved\n---\n\nBody.\n",
          [`templates/reserved/${name}`]: "Something the compiler would have overwritten.\n",
        },
      });

      expect(run.code).toBe(0);
      expect(hasError(run)).toBe(true);
      expect(run.stdout).toContain(`"${name}" in the source skill directory would overwrite`);
      expect(written).toBe(false);
    });
  }

  test("but a nested one is an ordinary copied file", () => {
    const ws = workspace({
      repoFiles: {
        "templates/nested/SKILL.md.tmpl": "---\nname: nested\n---\n\nBody.\n",
        "templates/nested/references/SKILL.md": "An example skill, quoted in a reference.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "nested")).toBe("---\nname: nested\n---\n\nBody.\n");
    expect(read(ws.repo, ".claude/skills/nested/references/SKILL.md")).toBe(
      "An example skill, quoted in a reference.\n",
    );
  });
});

describe("include containment", () => {
  const SKILL = (spec: string) => `---\nname: inc\n---\n\n<!-- include: ${spec} -->\n`;

  test("an absolute path is rejected", () => {
    const { run, written } = rejects({
      skill: "inc",
      repoFiles: { "templates/inc/SKILL.md.tmpl": SKILL("/etc/passwd") },
    });
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("absolute path");
    expect(written).toBe(false);
  });

  test("`..` escaping the source root is rejected", () => {
    const { run, written } = rejects({
      skill: "inc",
      repoFiles: {
        "secret.md": "SECRET CONTENT\n",
        "templates/inc/SKILL.md.tmpl": SKILL("../secret.md"),
      },
    });
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("../secret.md");
    expect(written).toBe(false);
  });

  test("a symlink whose target is outside the source root is rejected", () => {
    const { run, written } = rejects({
      skill: "inc",
      repoFiles: { "templates/inc/SKILL.md.tmpl": SKILL("linked.md") },
      prepare: (ws) => {
        write(ws.root, { "outside/secret.md": "SECRET CONTENT\n" });
        symlink(`${ws.root}/outside/secret.md`, ws.repo, "templates/linked.md");
      },
    });
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("symlink");
    expect(written).toBe(false);
  });

  test("a symlinked intermediate path component is rejected", () => {
    const { run, written } = rejects({
      skill: "inc",
      repoFiles: { "templates/inc/SKILL.md.tmpl": SKILL("linkdir/frag.md") },
      prepare: (ws) => {
        write(ws.root, { "outside/frag.md": "SECRET CONTENT\n" });
        symlink(`${ws.root}/outside`, ws.repo, "templates/linkdir");
      },
    });
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("symlink");
    expect(written).toBe(false);
  });

  test("a fragment in a different source root does not fall through", () => {
    const { run, written } = rejects({
      skill: "borrower",
      config: {
        id: "acme",
        sources: ["./first", "./second"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "first/fragments/rules.md": "First root's rules.\n",
        "second/borrower/SKILL.md.tmpl":
          "---\nname: borrower\n---\n\n<!-- include: fragments/rules.md -->\n",
      },
    });
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(written).toBe(false);
  });
});

// An override file goes through the same containment discipline as `include:` — the spec rejects
// "an override resolving outside its own override root, whether by `..` or a symlink hop".
describe("override containment", () => {
  const TEMPLATE = "---\nname: ov\n---\n\n<!-- slot: s -->\nThe safe default.\n<!-- /slot -->\n";

  test("an override that is a symlink out of its root is rejected", () => {
    const { run, written } = rejects({
      skill: "ov",
      repoFiles: { "templates/ov/SKILL.md.tmpl": TEMPLATE },
      prepare: (ws) => {
        write(ws.root, { "outside/s.md": "SMUGGLED CONTENT\n" });
        symlink(`${ws.root}/outside/s.md`, ws.repo, ".claude/skills-local/ov/s.md");
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("override traverses a symlink");
    expect(written).toBe(false);
  });

  test("an override reached through a symlinked skill directory is rejected", () => {
    const { run, written } = rejects({
      skill: "ov",
      repoFiles: { "templates/ov/SKILL.md.tmpl": TEMPLATE },
      prepare: (ws) => {
        write(ws.root, { "outside/s.md": "SMUGGLED CONTENT\n" });
        symlink(`${ws.root}/outside`, ws.repo, ".claude/skills-local/ov");
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("override traverses a symlink");
    expect(written).toBe(false);
  });

  // Invariant 8's least obvious clause. Containment is asserted against the root's `realpath`, so
  // a root that is *itself* a symlink would silently widen to wherever it points and every
  // component check below it would pass. The rejection is on the root, before any lookup.
  test("an override root that is itself a symlink is rejected", () => {
    const ws = workspace({
      repoFiles: { "templates/ov/SKILL.md.tmpl": TEMPLATE },
    });
    write(ws.root, { "outside/ov/s.md": "SMUGGLED CONTENT\n" });
    symlink(`${ws.root}/outside`, ws.home, "global");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("is itself a symlink");
    expect(run.stdout).toContain("point the entry at a real directory");
    expect(exists(ws.repo, ".claude/skills/ov/SKILL.md")).toBe(false);
    // and the content behind the link never reached the output
    expect(run.stdout).not.toContain("SMUGGLED CONTENT");
  });

  // The one documented exemption, pinned so nobody "fixes" it into consistency: a package
  // directory reached through a symlink is ordinary under pnpm and npm workspaces, so a *source*
  // root's own last component may be one. `include:` still resolves inside the realpathed root.
  test("a source root that is itself a symlink is followed, and include: still resolves inside it", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
    });
    write(ws.root, {
      "pkg/greet/SKILL.md.tmpl": "---\nname: greet\n---\n\n<!-- include: fragments/rules.md -->\n",
      "pkg/fragments/rules.md": "The shared rule.\n",
    });
    symlink(`${ws.root}/pkg`, ws.repo, "templates");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "greet")).toBe("---\nname: greet\n---\n\nThe shared rule.\n");
  });

  test("an override that is not a regular file is rejected", () => {
    const { run, written } = rejects({
      skill: "ov",
      repoFiles: {
        "templates/ov/SKILL.md.tmpl": TEMPLATE,
        ".claude/skills-local/ov/s.md/inside.txt": "a directory wearing a file's name\n",
      },
    });

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("override is not a regular file");
    expect(written).toBe(false);
  });
});

describe("warned, not rejected", () => {
  test("an override file matching no declared slot never breaks a build", () => {
    const ws = workspace({
      repoFiles: {
        "templates/typo/SKILL.md.tmpl": [
          "---",
          "name: typo",
          "---",
          "",
          "<!-- slot: known -->",
          "The default.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        ".claude/skills-local/typo/knwon.md": "Text nobody will ever see.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain("knwon");
    expect(exists(ws.repo, ".claude/skills/typo/SKILL.md")).toBe(true);
    expect(compiled(ws, "typo")).toContain("The default.");
    expect(compiled(ws, "typo")).not.toContain("Text nobody will ever see.");
  });

  test("an unsupported frontmatter field for a configured target is a warning only", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [],
        targets: ["./.agents/skills"],
      },
      repoFiles: {
        "templates/fields/SKILL.md.tmpl":
          "---\nname: fields\ndescription: d\nallowed-tools: Read\n---\n\nBody.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(run.stdout).toContain("allowed-tools");
    expect(compiled(ws, "fields", ".agents/skills")).toContain("allowed-tools: Read");
  });

  test("a symlink inside a skill directory is not copied, and warns", () => {
    const ws = workspace({
      repoFiles: { "templates/lnk/SKILL.md.tmpl": "---\nname: lnk\n---\n\nBody.\n" },
    });
    write(ws.root, { "outside/secret.md": "SECRET CONTENT\n" });
    symlink(`${ws.root}/outside/secret.md`, ws.repo, "templates/lnk/references/secret.md");

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(run.stdout).toContain("symlink not copied: references/secret.md");
    expect(compiled(ws, "lnk")).toBe("---\nname: lnk\n---\n\nBody.\n");
    expect(exists(ws.repo, ".claude/skills/lnk/references/secret.md")).toBe(false);
  });
});

describe("per-skill failure isolation", () => {
  test("one failing skill leaves the others compiling normally", () => {
    const ws = workspace({
      repoFiles: {
        "templates/good/SKILL.md.tmpl": "---\nname: good\n---\n\nGood body.\n",
        "templates/alsogood/SKILL.md.tmpl": "---\nname: alsogood\n---\n\nAlso good.\n",
        "templates/bad/SKILL.md.tmpl":
          "---\nname: bad\n---\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(compiled(ws, "good")).toBe("---\nname: good\n---\n\nGood body.\n");
    expect(compiled(ws, "alsogood")).toBe("---\nname: alsogood\n---\n\nAlso good.\n");
    expect(exists(ws.repo, ".claude/skills/bad/SKILL.md")).toBe(false);
  });

  test("a skill that starts failing keeps its previous output", () => {
    const ws = workspace({
      repoFiles: {
        "templates/flaky/SKILL.md.tmpl": "---\nname: flaky\n---\n\nVersion one.\n",
        "templates/steady/SKILL.md.tmpl": "---\nname: steady\n---\n\nSteady.\n",
      },
    });

    expect(build(ws).code).toBe(0);
    expect(compiled(ws, "flaky")).toContain("Version one.");

    write(ws.repo, {
      "templates/flaky/SKILL.md.tmpl":
        "---\nname: flaky\n---\n\n<<<<<<< HEAD\nbroken\n=======\nalso broken\n>>>>>>> b\n",
    });

    const second = build(ws);
    expect(second.code).toBe(0);
    expect(hasError(second)).toBe(true);
    expect(compiled(ws, "flaky")).toContain("Version one.");
    expect(compiled(ws, "flaky")).not.toContain("broken");
    expect(compiled(ws, "steady")).toContain("Steady.");
  });
});

// ---------------------------------------------------------------------------------------------
// Splicing moves text between coordinate spaces: an include shifts every line after it, a slot's
// text may come from an override file, and the leftover-directive scan runs on the finished
// output, which is nobody's file. `src/directives.ts` threads a `LineOrigin` through expansion and
// rendering so a diagnostic can name the file the text actually came from — and, crucially, a line
// that exists in that file. This group pins that promise from all four directions: the template's
// own body, its frontmatter, an included fragment, and an override file.
// ---------------------------------------------------------------------------------------------
describe("diagnostic locations", () => {
  /**
   * Asserts the whole formatted diagnostic, then cashes in the promise its location makes: the
   * `[skill file:line]` bracket must resolve to a line the named file really has, and it must be
   * the line the message is about. A wrong file or a shifted number fails here even if some other
   * file happens to have a matching line.
   */
  function expectDiagnostic(run: BuildRun, formatted: string, offendingLine: string): void {
    expect(lines(run)).toContain(formatted);

    const located = /^composable-skills: error \[\S+ (.+):(\d+)\] /.exec(formatted);
    if (located === null) throw new Error(`not a located diagnostic: ${formatted}`);
    const numbered = fs.readFileSync(located[1]!, "utf8").split("\n");
    const line = numbered[Number(located[2]!) - 1];
    expect(line).toBeDefined();
    expect(line!.trim()).toBe(offendingLine);
  }

  test("a slot diagnostic after an include names the template's real line", () => {
    const { ws, run } = rejects({
      skill: "ln",
      repoFiles: {
        "templates/fragments/f.md": "F one.\nF two.\nF three.\n",
        "templates/ln/SKILL.md.tmpl": [
          "---", //                              1
          "name: ln", //                         2
          "---", //                              3
          "", //                                 4
          "<!-- include: fragments/f.md -->", // 5
          "", //                                 6
          "<!-- slot: a -->", //                 7
          "<!-- /slot -->", //                   8
          "", //                                 9
          "<!-- slot: a -->", //                10  ← the offending line
          "", //                                11
        ].join("\n"),
      },
    });

    const template = path.join(ws.repo, "templates", "ln", "SKILL.md.tmpl");
    expectDiagnostic(
      run,
      `composable-skills: error [ln ${template}:10] duplicate slot name "a"`,
      "<!-- slot: a -->",
    );
  });

  // Two fragments of different lengths, each with blank edges the splice trims, and the offending
  // line is the template's own tail: the shift a single include causes is easy to get right by
  // accident, two accumulating ones are not.
  test("the template's own tail keeps its line number across two spliced fragments", () => {
    const { ws, run } = rejects({
      skill: "tw",
      repoFiles: {
        "templates/fragments/a.md": "\n\nA one.\nA two.\nA three.\n\n",
        "templates/fragments/b.md": "\nB one.\n",
        "templates/tw/SKILL.md.tmpl": [
          "---", //                              1
          "name: tw", //                         2
          "---", //                              3
          "", //                                 4
          "<!-- include: fragments/a.md -->", // 5
          "", //                                 6
          "<!-- include: fragments/b.md -->", // 7
          "", //                                 8
          "Tail with a stray <!-- slot -->.", // 9  ← the offending line
          "", //                                10
        ].join("\n"),
      },
    });

    const template = path.join(ws.repo, "templates", "tw", "SKILL.md.tmpl");
    expectDiagnostic(
      run,
      `composable-skills: error [tw ${template}:9] unknown or malformed directive: Tail with a stray <!-- slot -->.`,
      "Tail with a stray <!-- slot -->.",
    );
  });

  // The leftover scan runs on the whole output, frontmatter included — so an `include:` hiding in
  // the frontmatter region is still caught, and those lines are the template's by construction.
  test("a directive left in the frontmatter region names the template's frontmatter line", () => {
    const { ws, run } = rejects({
      skill: "fm",
      repoFiles: {
        "templates/fm/SKILL.md.tmpl": [
          "---", //                                1
          "name: fm", //                           2
          "# <!-- include: fragments/x.md -->", // 3  ← the offending line
          "---", //                                4
          "", //                                   5
          "Body.", //                              6
          "", //                                   7
        ].join("\n"),
      },
    });

    const template = path.join(ws.repo, "templates", "fm", "SKILL.md.tmpl");
    expectDiagnostic(
      run,
      `composable-skills: error [fm ${template}:3] directive syntax left in the output: # <!-- include: fragments/x.md -->`,
      "# <!-- include: fragments/x.md -->",
    );
  });

  test("a duplicate slot declared inside a fragment names the fragment, at its own line", () => {
    const { ws, run } = rejects({
      skill: "fd",
      repoFiles: {
        "templates/fragments/f.md": [
          "", //                   1  (trimmed by the splice, but still numbered)
          "F two.", //             2
          "<!-- slot: a -->", //   3
          "In the fragment.", //   4
          "<!-- /slot -->", //     5
          "F six.", //             6
          "<!-- slot: a -->", //   7  ← the offending line
          "<!-- /slot -->", //     8
          "", //                   9
        ].join("\n"),
        "templates/fd/SKILL.md.tmpl": [
          "---",
          "name: fd",
          "---",
          "",
          "Lead.",
          "",
          "<!-- include: fragments/f.md -->",
          "",
        ].join("\n"),
      },
    });

    const fragment = path.join(ws.repo, "templates", "fragments", "f.md");
    expectDiagnostic(
      run,
      `composable-skills: error [fd ${fragment}:7] duplicate slot name "a"`,
      "<!-- slot: a -->",
    );
  });

  // The sibling in `rejected` pins that a nested include survives at all; this pins where it is
  // reported — the fragment it sits in, never the template that pulled the fragment in.
  test("a surviving nested include names the fragment it sits in", () => {
    const { ws, run } = rejects({
      skill: "nb",
      repoFiles: {
        "templates/fragments/outer.md": [
          "Outer one.", //                           1
          "Outer two.", //                           2
          "<!-- include: fragments/inner.md -->", // 3  ← the offending line
          "", //                                     4
        ].join("\n"),
        "templates/fragments/inner.md": "Inner text.\n",
        "templates/nb/SKILL.md.tmpl":
          "---\nname: nb\n---\n\nLead.\n\n<!-- include: fragments/outer.md -->\n",
      },
    });

    const fragment = path.join(ws.repo, "templates", "fragments", "outer.md");
    expectDiagnostic(
      run,
      `composable-skills: error [nb ${fragment}:3] directive syntax left in the output: <!-- include: fragments/inner.md -->`,
      "<!-- include: fragments/inner.md -->",
    );
  });

  // The case the pre-provenance compiler got wrong: it numbered the rendered output while naming
  // the template, reporting this as `SKILL.md.tmpl:7` — a blank line in a file the text never
  // passed through.
  test("a directive smuggled in through an override names the override file, at its own line", () => {
    const { ws, run } = rejects({
      skill: "lo",
      repoFiles: {
        "templates/lo/SKILL.md.tmpl": [
          "---", //               1
          "name: lo", //          2
          "---", //               3
          "", //                  4
          "<!-- slot: s -->", //  5
          "<!-- /slot -->", //    6
          "", //                  7
          "Tail.", //             8
          "", //                  9
        ].join("\n"),
        ".claude/skills-local/lo/s.md": "line one\nline two\n<!-- slot: smuggled -->\n",
      },
    });

    const override = path.join(ws.repo, ".claude", "skills-local", "lo", "s.md");
    expectDiagnostic(
      run,
      `composable-skills: error [lo ${override}:3] directive syntax left in the output: <!-- slot: smuggled -->`,
      "<!-- slot: smuggled -->",
    );
  });

  // An override's blank edges are trimmed before it is spliced, so its surviving lines land at a
  // different depth in the output than they sit at in the file. The file's own numbering wins.
  test("an override's blank edges do not renumber the lines that survive them", () => {
    const { ws, run } = rejects({
      skill: "tr",
      repoFiles: {
        "templates/tr/SKILL.md.tmpl":
          "---\nname: tr\n---\n\n<!-- slot: s -->\nDefault.\n<!-- /slot -->\n",
        ".claude/skills-local/tr/s.md": [
          "", //                        1
          "", //                        2
          "Real first line.", //        3
          "<!-- slot: smuggled -->", // 4  ← the offending line
          "", //                        5
          "", //                        6
        ].join("\n"),
      },
    });

    const override = path.join(ws.repo, ".claude", "skills-local", "tr", "s.md");
    expectDiagnostic(
      run,
      `composable-skills: error [tr ${override}:4] directive syntax left in the output: <!-- slot: smuggled -->`,
      "<!-- slot: smuggled -->",
    );
  });

  // `mode=append` joins default and override with a blank separator line the compiler synthesizes,
  // whose origin is null because it exists in no file. Nothing can be diagnosed on the blank line
  // itself — it matches no scanner — but it sits between the default's origins and the override's,
  // so an implementation that let it renumber what follows would report the smuggled line as
  // `s.md:2`. What is observable is that it does not.
  test("an appended override is numbered past the separator the compiler synthesizes", () => {
    const { ws, run } = rejects({
      skill: "ap",
      repoFiles: {
        "templates/ap/SKILL.md.tmpl": [
          "---", //                          1
          "name: ap", //                     2
          "---", //                          3
          "", //                             4
          "<!-- slot: s mode=append -->", // 5
          "Default one.", //                 6
          "Default two.", //                 7
          "<!-- /slot -->", //               8
          "", //                             9
        ].join("\n"),
        ".claude/skills-local/ap/s.md": [
          "Added one.", //              1
          "Added two.", //              2
          "<!-- slot: smuggled -->", // 3  ← the offending line
          "", //                        4
        ].join("\n"),
      },
    });

    const override = path.join(ws.repo, ".claude", "skills-local", "ap", "s.md");
    expectDiagnostic(
      run,
      `composable-skills: error [ap ${override}:3] directive syntax left in the output: <!-- slot: smuggled -->`,
      "<!-- slot: smuggled -->",
    );
  });
});
