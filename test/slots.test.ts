import { afterEach, describe, expect, test } from "bun:test";

import { build, bodyOf, cleanup, compiled, hasError, workspace } from "./fixtures/workspace.ts";

afterEach(cleanup);

/** The same surrounding prose either side of the slot, so the two forms are directly comparable. */
function skillWithSlot(name: string, slotLines: string[]): string {
  return ["---", `name: ${name}`, "---", "", "Before.", "", ...slotLines, "", "After.", ""].join(
    "\n",
  );
}

describe("bare and fenced-with-empty-default", () => {
  test("behave identically with no override", () => {
    const ws = workspace({
      repoFiles: {
        "templates/bare/SKILL.md.tmpl": skillWithSlot("bare", ["<!-- slot: s -->"]),
        "templates/fenced/SKILL.md.tmpl": skillWithSlot("fenced", [
          "<!-- slot: s -->",
          "<!-- /slot -->",
        ]),
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);

    const bare = bodyOf(compiled(ws, "bare"));
    const fenced = bodyOf(compiled(ws, "fenced"));
    expect(bare).toBe("\nBefore.\n\nAfter.\n");
    expect(fenced).toBe(bare);
  });

  test("behave identically with an override", () => {
    const ws = workspace({
      repoFiles: {
        "templates/bare/SKILL.md.tmpl": skillWithSlot("bare", ["<!-- slot: s -->"]),
        "templates/fenced/SKILL.md.tmpl": skillWithSlot("fenced", [
          "<!-- slot: s -->",
          "<!-- /slot -->",
        ]),
        ".claude/skills-local/bare/s.md": "Filled in.\n",
        ".claude/skills-local/fenced/s.md": "Filled in.\n",
      },
    });

    build(ws);
    const bare = bodyOf(compiled(ws, "bare"));
    const fenced = bodyOf(compiled(ws, "fenced"));
    expect(bare).toBe("\nBefore.\n\nFilled in.\n\nAfter.\n");
    expect(fenced).toBe(bare);
  });
});

describe("mode", () => {
  test("defaults to replace — the override replaces the default", () => {
    const ws = workspace({
      repoFiles: {
        "templates/rep/SKILL.md.tmpl": skillWithSlot("rep", [
          "<!-- slot: s -->",
          "The template default.",
          "<!-- /slot -->",
        ]),
        ".claude/skills-local/rep/s.md": "The override.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    const out = compiled(ws, "rep");
    expect(out).toContain("The override.");
    expect(out).not.toContain("The template default.");
    expect(bodyOf(out)).toBe("\nBefore.\n\nThe override.\n\nAfter.\n");
  });

  test("mode=append places the override text after the default", () => {
    const ws = workspace({
      repoFiles: {
        "templates/app/SKILL.md.tmpl": skillWithSlot("app", [
          "<!-- slot: s mode=append -->",
          "The template default.",
          "<!-- /slot -->",
        ]),
        ".claude/skills-local/app/s.md": "The override.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    const out = compiled(ws, "app");
    expect(out).toContain("The template default.");
    expect(out).toContain("The override.");
    expect(out.indexOf("The template default.")).toBeLessThan(out.indexOf("The override."));
    expect(bodyOf(out)).toBe("\nBefore.\n\nThe template default.\n\nThe override.\n\nAfter.\n");
  });

  test("mode=append with no override leaves the default alone", () => {
    const ws = workspace({
      repoFiles: {
        "templates/app/SKILL.md.tmpl": skillWithSlot("app", [
          "<!-- slot: s mode=append -->",
          "The template default.",
          "<!-- /slot -->",
        ]),
      },
    });

    build(ws);
    expect(bodyOf(compiled(ws, "app"))).toBe("\nBefore.\n\nThe template default.\n\nAfter.\n");
  });

  test("a slot with an empty default behaves the same under either mode", () => {
    const ws = workspace({
      repoFiles: {
        "templates/emptyrep/SKILL.md.tmpl": skillWithSlot("emptyrep", [
          "<!-- slot: s -->",
          "<!-- /slot -->",
        ]),
        "templates/emptyapp/SKILL.md.tmpl": skillWithSlot("emptyapp", [
          "<!-- slot: s mode=append -->",
          "<!-- /slot -->",
        ]),
        ".claude/skills-local/emptyrep/s.md": "Developer text.\n",
        ".claude/skills-local/emptyapp/s.md": "Developer text.\n",
      },
    });

    build(ws);
    const replaceBody = bodyOf(compiled(ws, "emptyrep"));
    const appendBody = bodyOf(compiled(ws, "emptyapp"));
    expect(replaceBody).toBe("\nBefore.\n\nDeveloper text.\n\nAfter.\n");
    expect(appendBody).toBe(replaceBody);
  });

  test("a slot's mode reaches no text but its own default", () => {
    const ws = workspace({
      repoFiles: {
        "templates/two/SKILL.md.tmpl": [
          "---",
          "name: two",
          "---",
          "",
          "<!-- slot: a mode=append -->",
          "Default A.",
          "<!-- /slot -->",
          "",
          "<!-- slot: b -->",
          "Default B.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        ".claude/skills-local/two/a.md": "Override A.\n",
        ".claude/skills-local/two/b.md": "Override B.\n",
      },
    });

    build(ws);
    expect(bodyOf(compiled(ws, "two"))).toBe("\nDefault A.\n\nOverride A.\n\nOverride B.\n");
  });
});

// The two forms are syntactically identical at the opening tag, so the compiler cannot tell a
// deliberate bare slot from a fenced slot whose `<!-- /slot -->` was forgotten. The spec lists
// "unclosed <!-- /slot -->" as a rejection but the implementation cannot detect this shape; it
// reads it as the bare form. Pinned because the consequence is visible: the text the author
// meant as a default stays in the body *and* the override is inserted before it.
describe("an unclosed fenced slot (spec-ambiguous)", () => {
  test("is read as the bare form, leaving the intended default as ordinary body text", () => {
    const ws = workspace({
      repoFiles: {
        "templates/unclosed/SKILL.md.tmpl": [
          "---",
          "name: unclosed",
          "---",
          "",
          "<!-- slot: s -->",
          "Text the author meant as the default.",
          "",
        ].join("\n"),
        ".claude/skills-local/unclosed/s.md": "The override.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(bodyOf(compiled(ws, "unclosed"))).toBe(
      "\nThe override.\nText the author meant as the default.\n",
    );
  });
});

// The spec says nothing about markdown code fences, and the implementation is fence-blind:
// directive syntax is a directive wherever it appears. A template that documents the syntax
// therefore cannot show it literally. Pinned so the constraint is a decision, not a surprise.
describe("directives inside a code fence (spec-silent)", () => {
  test("are expanded, not shown literally", () => {
    const ws = workspace({
      repoFiles: {
        "templates/doc/SKILL.md.tmpl": [
          "---",
          "name: doc",
          "---",
          "",
          "Declare an extension point like this:",
          "",
          "```markdown",
          "<!-- slot: example -->",
          "```",
          "",
        ].join("\n"),
        ".claude/skills-local/doc/example.md": "SUBSTITUTED\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    const out = compiled(ws, "doc");
    expect(out).toContain("SUBSTITUTED");
    expect(out).not.toContain("<!-- slot: example -->");
  });
});

describe("override file content", () => {
  test("a multi-line override keeps its internal blank lines and is edge-trimmed", () => {
    const ws = workspace({
      repoFiles: {
        "templates/multi/SKILL.md.tmpl": skillWithSlot("multi", ["<!-- slot: s -->"]),
        ".claude/skills-local/multi/s.md": "\n\nOne.\n\nTwo.\n\n\n",
      },
    });

    build(ws);
    expect(bodyOf(compiled(ws, "multi"))).toBe("\nBefore.\n\nOne.\n\nTwo.\n\nAfter.\n");
  });

  test("an empty override file empties a replace slot", () => {
    const ws = workspace({
      repoFiles: {
        "templates/blank/SKILL.md.tmpl": skillWithSlot("blank", [
          "<!-- slot: s -->",
          "Default text.",
          "<!-- /slot -->",
        ]),
        ".claude/skills-local/blank/s.md": "",
      },
    });

    build(ws);
    const out = compiled(ws, "blank");
    expect(out).not.toContain("Default text.");
    expect(bodyOf(out)).toBe("\nBefore.\n\nAfter.\n");
  });

  test("no directive syntax survives into the output", () => {
    const ws = workspace({
      repoFiles: {
        "templates/clean/SKILL.md.tmpl": [
          "---",
          "name: clean",
          "---",
          "",
          "<!-- slot: a -->",
          "",
          "<!-- slot: b mode=append -->",
          "B default.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        ".claude/skills-local/clean/a.md": "A text.\n",
      },
    });

    build(ws);
    const out = compiled(ws, "clean");
    expect(out).not.toContain("<!--");
    expect(out).toContain("A text.");
    expect(out).toContain("B default.");
  });
});
