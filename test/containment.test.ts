import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  build,
  cleanup,
  compiled,
  exists,
  hasError,
  init,
  override,
  read,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

/**
 * The four containment call sites, each reached through its public verb, against the same four
 * inputs. `src/contain.ts` now serves all four from one segment-split core, in two forms:
 *
 * | call site                       | predicate      | candidate === root | `root/..foo` | `root/sub` | `root/../sibling` |
 * |---------------------------------|----------------|--------------------|--------------|------------|-------------------|
 * | `directives.ts` resolveContained | `isUnder`     | not contained      | contained    | contained  | not contained     |
 * | `config.ts` resolveRoots         | `isAtOrUnder` | **contained**      | contained    | contained  | not contained     |
 * | `override.ts` advisory           | `isAtOrUnder` | **contained**      | contained    | contained  | not contained     |
 * | `init.ts` gitignoreStep          | `isUnder`     | not contained      | contained    | contained  | not contained     |
 *
 * The self path is the one disagreement, and it is deliberate: the two security boundaries refuse
 * it, validation and advice accept it. Each test reaches its predicate through the verb — never by
 * importing the function — so the record survives however the predicates are factored.
 *
 * Where a call site cannot be reached with one of the four inputs, there is a test that says so
 * and asserts the behaviour that occurs instead, rather than a test that pretends to cover it.
 */

// -------------------------------------------------------------------------------------------
// 1. `isUnder`, via `resolveContainedFile` (`directives.ts`).
//
// Reached from `resolveIncludePath` when `build` compiles an `include:` directive, and from
// `resolveSlot` (`build.ts`) when it resolves an override file. Both compare a realpath'd
// candidate against a realpath'd root.
// -------------------------------------------------------------------------------------------

describe("containment — isUnder, through an include: directive", () => {
  const SKILL = (spec: string) => `---\nname: inc\n---\n\n<!-- include: ${spec} -->\n`;

  test("root/sub — a fragment in a subdirectory of the source root is contained and spliced", () => {
    const ws = workspace({
      repoFiles: {
        "templates/sub/frag.md": "Fragment from a subdirectory.\n",
        "templates/inc/SKILL.md.tmpl": SKILL("sub/frag.md"),
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "inc")).toContain("Fragment from a subdirectory.");
  });

  // ---------------------------------------------------------------------------------------
  // Stage 3 changed this test. The old `directives.ts` predicate tested `!relative.startsWith("..")`
  // and so refused a file whose own name merely *begins* with two dots, even though it sits
  // directly inside the source root and no `..` component was ever traversed. That was an
  // over-strict false refusal, not an escape — the other three predicates all allowed it. The
  // segment-split `isUnder` in `src/contain.ts` accepts and splices it, in line with the other
  // three.
  // ---------------------------------------------------------------------------------------
  test("root/..foo — a file directly inside the source root is contained, even though its name starts with two dots", () => {
    const ws = workspace({
      repoFiles: {
        "templates/..foo.md": "A fragment whose name starts with two dots.\n",
        "templates/inc/SKILL.md.tmpl": SKILL("..foo.md"),
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "inc")).toContain("A fragment whose name starts with two dots.");
  });

  test("root itself — unreachable here: an include: naming no file is rejected before isUnder runs", () => {
    const ws = workspace({
      repoFiles: { "templates/inc/SKILL.md.tmpl": SKILL(".") },
    });

    const run = build(ws);

    // `resolveIncludePath` filters out "." and "" components, so `parts` is never empty and the
    // candidate `resolveContainedFile` builds can never be the root itself. The self case is
    // therefore not reachable at this call site, and the refusal comes from the earlier guard.
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain('include: "." names no file');
    expect(exists(ws.repo, ".claude/skills/inc/SKILL.md")).toBe(false);
  });

  test("root/../sibling — unreachable here: the explicit `..` guard rejects it before isUnder runs", () => {
    const ws = workspace({
      repoFiles: {
        "secret.md": "Outside the source root.\n",
        "templates/inc/SKILL.md.tmpl": SKILL("../secret.md"),
      },
    });

    const run = build(ws);

    // `resolveIncludePath` refuses any spec containing a literal `..` component, so the sibling
    // case is caught by that guard and never reaches `resolveContainedFile`. The wording of the
    // message is what distinguishes the two refusals.
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain('include: "../secret.md" escapes its source root with ".."');
    expect(run.stdout).not.toContain("resolves outside its source root");
    expect(exists(ws.repo, ".claude/skills/inc/SKILL.md")).toBe(false);
  });
});

describe("containment — isUnder, through override-file resolution", () => {
  const TEMPLATE =
    "---\nname: ov\n---\n\n<!-- slot: s -->\nThe template default.\n<!-- /slot -->\n";

  test("root/sub — the override file one level under its override root is contained and applied", () => {
    const ws = workspace({
      repoFiles: { "templates/ov/SKILL.md.tmpl": TEMPLATE },
      homeFiles: { "repos/acme/ov/s.md": "The override text.\n" },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "ov")).toContain("The override text.");
  });

  test("the other three inputs are unreachable in resolveSlot — the parts are a skill name and a slot name", () => {
    // `resolveSlot` calls `resolveContainedFile(root.path, [skillName, `${block.name}.md`])`.
    // Both components come from validated identifiers, so none of the remaining three inputs can
    // be constructed: the parts list is never empty (no self case), never contains a literal
    // `..` (no sibling case), and neither component can begin with two dots — `discoverSkills`
    // skips every source entry whose name starts with "." (`build.ts:256`) and `SLOT_NAME_RE`
    // (`directives.ts:14`) requires a slot name to begin with an alphanumeric.
    const ws = workspace({
      repoFiles: {
        "templates/..hidden/SKILL.md.tmpl": "---\nname: hidden\n---\n\nBody.\n",
        "templates/ov/SKILL.md.tmpl":
          "---\nname: ov\n---\n\n<!-- slot: ..bad -->\nDefault.\n<!-- /slot -->\n",
      },
    });

    const run = build(ws);

    // The dot-leading source directory is not a skill at all…
    expect(exists(ws.repo, ".claude/skills/..hidden/SKILL.md")).toBe(false);
    // …and the dot-leading slot name is rejected as a name, so no override path is ever built
    // from it.
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain('invalid slot name "..bad"');
    expect(exists(ws.repo, ".claude/skills/ov/SKILL.md")).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// 2. `isAtOrUnder`, via `resolveRoots` (`config.ts`).
//
// Reached whenever `build` or `init` loads a config whose root specs use `${home}`: a root that
// resolves outside `${home}` is dropped with an error. This predicate answers "contained" for
// the self path, which is deliberate — `overrides: ["${home}"]` must not reject itself.
// -------------------------------------------------------------------------------------------

describe("containment — isAtOrUnder, through a ${home}-derived override root", () => {
  const TEMPLATE = "---\nname: e\n---\n\n<!-- slot: s -->\nThe template default.\n<!-- /slot -->\n";

  function homeRootWorkspace(spec: string) {
    return workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [spec],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "templates/e/SKILL.md.tmpl": TEMPLATE },
    });
  }

  test("root itself — `${home}` is contained in `${home}`, so the root is kept", () => {
    const ws = homeRootWorkspace("${home}");
    write(ws.home, { "e/s.md": "Override from ${home} itself.\n" });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "e")).toContain("Override from ${home} itself.");
  });

  test("root/..foo — a sibling-looking name that is really a child is contained, so the root is kept", () => {
    const ws = homeRootWorkspace("${home}/..foo");
    write(ws.home, { "..foo/e/s.md": "Override from a two-dot child.\n" });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "e")).toContain("Override from a two-dot child.");
  });

  test("root/sub — an ordinary child is contained, so the root is kept", () => {
    const ws = homeRootWorkspace("${home}/sub");
    write(ws.home, { "sub/e/s.md": "Override from a child directory.\n" });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "e")).toContain("Override from a child directory.");
  });

  test("root/../sibling — not contained, so the root is dropped with an error", () => {
    const ws = homeRootWorkspace("${home}/../sibling");
    write(ws.root, { "sibling/e/s.md": "Override from outside ${home}.\n" });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain('override "${home}/../sibling"');
    expect(run.stdout).toContain("outside");
    expect(compiled(ws, "e")).toContain("The template default.");
    expect(compiled(ws, "e")).not.toContain("Override from outside");
  });
});

// -------------------------------------------------------------------------------------------
// 3. `isAtOrUnder`, via the advisory line in `override.ts`.
//
// Purely a printed warning: when the highest-precedence override root sits inside the working
// tree, `override` says so, because a file seeded there is the whole team's rather than the
// developer's. Reached by the `override` verb only.
// -------------------------------------------------------------------------------------------

describe("containment — isAtOrUnder, through the override verb's advisory", () => {
  const TEMPLATE = [
    "---",
    "name: reviewer",
    "---",
    "",
    "<!-- slot: extra-checks -->",
    "Check for dead code.",
    "<!-- /slot -->",
    "",
  ].join("\n");

  const ADVISORY = "This root is inside the repo, so the file lands in the working tree";

  function reviewerWorkspace(spec: string) {
    return workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [spec],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "templates/reviewer/SKILL.md.tmpl": TEMPLATE },
    });
  }

  // Reachable, contrary to a first reading: the predicate is applied to `root.path` itself, not to
  // the joined target path, so an override root of "." makes candidate and root the same string.
  test("root itself — an override root of `.` is the repo root, and counts as inside it", () => {
    const ws = reviewerWorkspace(".");

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    expect(read(ws.repo, "reviewer/extra-checks.md")).toBe("Check for dead code.\n");
    expect(run.stdout).toContain(ADVISORY);
  });

  test("root/..foo — a two-dot child of the repo root counts as inside it", () => {
    const ws = reviewerWorkspace("./..foo");

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    expect(read(ws.repo, "..foo/reviewer/extra-checks.md")).toBe("Check for dead code.\n");
    expect(run.stdout).toContain(ADVISORY);
  });

  test("root/sub — an ordinary child of the repo root counts as inside it", () => {
    const ws = reviewerWorkspace("./.claude/skills-local");

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    expect(read(ws.repo, ".claude/skills-local/reviewer/extra-checks.md")).toBe(
      "Check for dead code.\n",
    );
    expect(run.stdout).toContain(ADVISORY);
  });

  test("root/../sibling — a sibling of the repo root does not count as inside it", () => {
    const ws = reviewerWorkspace("../sibling");

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    expect(read(ws.root, "sibling/reviewer/extra-checks.md")).toBe("Check for dead code.\n");
    expect(run.stdout).not.toContain(ADVISORY);
  });
});

// -------------------------------------------------------------------------------------------
// 4. `isUnder`, via `gitignoreStep` (`init.ts`).
//
// The one call site of the three that a config can steer: a target root inside the repo gets an
// ignore line, one outside gets none. The other two call sites — the write boundary in `applyStep`
// and `firstSymlinkComponent` — are fed paths `init` derives from the repo root
// itself, so none of the four inputs can be pushed through them; the last test records that.
// -------------------------------------------------------------------------------------------

describe("containment — isUnder, through gitignoreStep", () => {
  function targetWorkspace(...targets: string[]) {
    return workspace({ git: true, config: { id: "acme", sources: [], targets } });
  }

  /** The ignore entries only, so an assertion reads the lines rather than the comment around them. */
  function ignoreEntries(repo: string): string[] {
    return read(repo, ".gitignore")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
  }

  test("root itself — a target of `.` is the repo root and is NOT treated as inside it, so it gets no line", () => {
    const ws = targetWorkspace(".");

    init(ws, { write: true });

    // `isUnder` requires a non-empty relative path, so the repo root is not inside itself and
    // `gitignoreStep` skips it. Only the state directory is ignored.
    expect(ignoreEntries(ws.repo)).toEqual(["/.composable-skills/"]);
  });

  test("root/..foo — a two-dot child is treated as inside the repo and gets a line", () => {
    const ws = targetWorkspace("./..foo");

    init(ws, { write: true });

    expect(ignoreEntries(ws.repo)).toEqual(["/.composable-skills/", "/..foo/"]);
  });

  test("root/sub — an ordinary child is treated as inside the repo and gets a line", () => {
    const ws = targetWorkspace("./.claude/skills");

    init(ws, { write: true });

    expect(ignoreEntries(ws.repo)).toEqual(["/.composable-skills/", "/.claude/skills/"]);
  });

  test("root/../sibling — a sibling of the repo root is not inside it and gets no line", () => {
    const ws = targetWorkspace("../sibling");

    init(ws, { write: true });

    expect(ignoreEntries(ws.repo)).toEqual(["/.composable-skills/"]);
  });

  test("the write boundary and firstSymlinkComponent cannot be steered by these inputs", () => {
    // Both are fed `step.path`, and every step's path is `path.join(repoRoot, <a constant>)` —
    // never anything a config said. A config whose roots all point outside the repo still writes
    // exactly the same three repo-relative files, so the boundary is only ever asked about paths
    // that are unambiguously one or more components under the repo root.
    const ws = workspace({
      git: true,
      config: {
        id: "acme",
        sources: ["../elsewhere"],
        overrides: ["../elsewhere"],
        targets: ["../sibling"],
      },
    });

    const run = init(ws, { write: true });

    expect(run.code).toBe(0);
    for (const rel of ["composable-skills.jsonc", ".claude/settings.json", ".gitignore"]) {
      expect(exists(ws.repo, rel)).toBe(true);
      expect(path.relative(ws.repo, path.join(ws.repo, rel)).startsWith("..")).toBe(false);
    }
    expect(exists(ws.root, "sibling")).toBe(false);
    expect(exists(ws.root, "elsewhere")).toBe(false);
  });
});
