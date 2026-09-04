import { afterEach, describe, expect, test } from "bun:test";

import {
  build,
  cleanup,
  compiled,
  exists,
  frontmatterOf,
  hasError,
  read,
  remove,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

const REVIEWER_TEMPLATE = [
  "---",
  "name: reviewer",
  "description: Reviews code.",
  "---",
  "",
  "# Reviewer",
  "",
  "<!-- include: fragments/hard-rules.md -->",
  "",
  "<!-- slot: intro -->",
  "",
  "## Checks",
  "",
  "<!-- slot: extra-checks -->",
  "Check for dead code.",
  "<!-- /slot -->",
  "",
  "## Output",
  "",
  "<!-- slot: output-format mode=append -->",
  "Report findings as a markdown table.",
  "<!-- /slot -->",
  "",
  "<!-- slot: unfilled -->",
  "Nothing overrides this.",
  "<!-- /slot -->",
  "",
].join("\n");

function acceptanceWorkspace() {
  const ws = workspace({
    repoFiles: {
      "templates/fragments/hard-rules.md": "Never edit files outside the repo.\n",
      "templates/reviewer/SKILL.md.tmpl": REVIEWER_TEMPLATE,
      // overrides[1] — the repo-local root
      ".claude/skills-local/reviewer/extra-checks.md": "LOCAL checks.\n",
      ".claude/skills-local/reviewer/output-format.md": "Also include a severity column.\n",
    },
    homeFiles: {
      // overrides[0] — the lowest-precedence personal root
      "global/reviewer/intro.md": "Global intro.\n",
      "global/reviewer/extra-checks.md": "GLOBAL checks.\n",
      // overrides[2] — the highest-precedence personal root
      "repos/acme/reviewer/extra-checks.md": "REPO checks.\n",
    },
  });
  return ws;
}

describe("acceptance criterion", () => {
  test("both directives, all three slot forms, an override in each of the three roots", () => {
    const ws = acceptanceWorkspace();
    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);

    const expected = [
      "---",
      "name: reviewer",
      "description: Reviews code.",
      "---",
      "",
      "# Reviewer",
      "",
      "Never edit files outside the repo.",
      "",
      "Global intro.",
      "",
      "## Checks",
      "",
      "REPO checks.",
      "",
      "## Output",
      "",
      "Report findings as a markdown table.",
      "",
      "Also include a severity column.",
      "",
      "Nothing overrides this.",
      "",
    ].join("\n");

    expect(compiled(ws, "reviewer")).toBe(expected);
  });

  test("diagnostics reach stdout and stderr alike", () => {
    const ws = acceptanceWorkspace();
    const run = build(ws);
    expect(run.stdout).toContain("composable-skills:");
    expect(run.stderr).toBe(run.stdout);
  });
});

describe("override precedence", () => {
  test("the three roots resolve in reverse order, then fall through to the default", () => {
    const ws = acceptanceWorkspace();

    build(ws);
    expect(compiled(ws, "reviewer")).toContain("REPO checks.");
    expect(compiled(ws, "reviewer")).not.toContain("LOCAL checks.");
    expect(compiled(ws, "reviewer")).not.toContain("GLOBAL checks.");

    remove(ws.home, "repos/acme/reviewer/extra-checks.md");
    build(ws);
    expect(compiled(ws, "reviewer")).toContain("LOCAL checks.");
    expect(compiled(ws, "reviewer")).not.toContain("GLOBAL checks.");
    expect(compiled(ws, "reviewer")).not.toContain("Check for dead code.");

    remove(ws.repo, ".claude/skills-local/reviewer/extra-checks.md");
    build(ws);
    expect(compiled(ws, "reviewer")).toContain("GLOBAL checks.");
    expect(compiled(ws, "reviewer")).not.toContain("Check for dead code.");

    remove(ws.home, "global/reviewer/extra-checks.md");
    build(ws);
    expect(compiled(ws, "reviewer")).toContain("Check for dead code.");
  });

  test("an override present in several roots contributes exactly one copy", () => {
    const ws = acceptanceWorkspace();
    write(ws.home, { "global/reviewer/extra-checks.md": "SHARED.\n" });
    write(ws.repo, { ".claude/skills-local/reviewer/extra-checks.md": "SHARED.\n" });
    write(ws.home, { "repos/acme/reviewer/extra-checks.md": "SHARED.\n" });

    build(ws);
    const out = compiled(ws, "reviewer");
    expect(out.split("SHARED.").length - 1).toBe(1);
  });

  test("the template default applies when no override matches", () => {
    const ws = workspace({
      repoFiles: {
        "templates/plain/SKILL.md.tmpl": [
          "---",
          "name: plain",
          "---",
          "",
          "<!-- slot: body -->",
          "The template's own words.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(compiled(ws, "plain")).toBe("---\nname: plain\n---\n\nThe template's own words.\n");
  });
});

describe("sources", () => {
  test("a later sources entry replaces an earlier same-named skill wholesale", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./first", "./second"],
        overrides: ["${home}/global"],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "first/shared/SKILL.md.tmpl": [
          "---",
          "name: shared",
          "description: from first",
          "---",
          "",
          "FROM FIRST",
          "",
          "<!-- slot: only-in-first -->",
          "First-only default.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        "first/shared/references/first-only.md": "first reference\n",
        "second/shared/SKILL.md.tmpl": [
          "---",
          "name: shared",
          "description: from second",
          "---",
          "",
          "FROM SECOND",
          "",
        ].join("\n"),
        "second/shared/references/second-only.md": "second reference\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);

    const out = compiled(ws, "shared");
    expect(out).toBe("---\nname: shared\ndescription: from second\n---\n\nFROM SECOND\n");
    expect(out).not.toContain("FROM FIRST");
    expect(out).not.toContain("First-only default.");
    expect(frontmatterOf(out)).toBe("---\nname: shared\ndescription: from second\n---\n");

    // wholesale, never merged: the earlier entry's sibling files do not travel either
    expect(exists(ws.repo, ".claude/skills/shared/references/second-only.md")).toBe(true);
    expect(exists(ws.repo, ".claude/skills/shared/references/first-only.md")).toBe(false);
  });

  test("a skill name colliding across sources is warned, not rejected", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./first", "./second"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: {
        "first/shared/SKILL.md.tmpl": "---\nname: shared\n---\n\nA\n",
        "second/shared/SKILL.md.tmpl": "---\nname: shared\n---\n\nB\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(run.stdout).toContain("collides across sources");
    expect(compiled(ws, "shared")).toContain("B");
  });
});

describe("include", () => {
  test("a legitimate fragment inside the source root is spliced into the body", () => {
    const ws = workspace({
      repoFiles: {
        "templates/fragments/hard-rules.md": "Rule one.\nRule two.\n",
        "templates/inc/SKILL.md.tmpl": [
          "---",
          "name: inc",
          "---",
          "",
          "Before.",
          "",
          "<!-- include: fragments/hard-rules.md -->",
          "",
          "After.",
          "",
        ].join("\n"),
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "inc")).toBe(
      "---\nname: inc\n---\n\nBefore.\n\nRule one.\nRule two.\n\nAfter.\n",
    );
  });

  test("a fragment directory in the source root is not mistaken for a skill", () => {
    const ws = workspace({
      repoFiles: {
        "templates/fragments/hard-rules.md": "Rule one.\n",
        "templates/inc/SKILL.md.tmpl": "---\nname: inc\n---\n\n<!-- include: fragments/hard-rules.md -->\n",
      },
    });

    build(ws);
    expect(exists(ws.repo, ".claude/skills/fragments")).toBe(false);
    expect(exists(ws.repo, ".claude/skills/inc/SKILL.md")).toBe(true);
  });
});

// "There is no variable substitution. Every variable point is a slot." The same build expands
// `${home}` and `${id}` in *config* strings, so a leak into body rendering is a realistic
// regression rather than a hypothetical one.
describe("no variable substitution", () => {
  test("template markers that look like variables are emitted verbatim", () => {
    const body = [
      "Personal roots live under ${home}, and this repo is ${id}.",
      "",
      "A handlebars-looking thing: {{ value }} and {{value}}.",
      "",
      "A shell-looking thing: $HOME and ${HOME} and %USERPROFILE%.",
    ].join("\n");

    const ws = workspace({
      repoFiles: {
        "templates/verbatim/SKILL.md.tmpl": [
          "---",
          "name: verbatim",
          "description: Mentions ${home} and ${id} in the frontmatter too.",
          "---",
          "",
          body,
          "",
          "<!-- slot: s -->",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        ".claude/skills-local/verbatim/s.md": "An override may say ${home}/${id} too.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "verbatim")).toBe(
      [
        "---",
        "name: verbatim",
        "description: Mentions ${home} and ${id} in the frontmatter too.",
        "---",
        "",
        body,
        "",
        "An override may say ${home}/${id} too.",
        "",
      ].join("\n"),
    );
    // nothing resembling a resolved path leaked in
    expect(compiled(ws, "verbatim")).not.toContain(ws.home);
    expect(compiled(ws, "verbatim")).not.toContain("acme");
  });
});
