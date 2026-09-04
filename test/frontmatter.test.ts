import { afterEach, describe, expect, test } from "bun:test";

import {
  build,
  cleanup,
  compiled,
  exists,
  frontmatterOf,
  hasError,
  read,
  readBytes,
  workspace,
  writeBytes,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

const AWKWARD_FRONTMATTER = [
  "---",
  "name:   reviewer",
  'description: "A description: with a colon, and a comma"',
  "allowed-tools: Bash(git status:*), Read",
  "metadata:",
  "  owner: platform",
  "  tags: [a, b]",
  "",
  "license: MIT",
  "---",
].join("\n");

describe("frontmatter", () => {
  test("emitted frontmatter is byte-identical to the template's", () => {
    const ws = workspace({
      repoFiles: {
        "templates/fm/SKILL.md.tmpl": `${AWKWARD_FRONTMATTER}\n\nBody text.\n`,
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);

    expect(compiled(ws, "fm")).toBe(`${AWKWARD_FRONTMATTER}\n\nBody text.\n`);
  });

  test("a slot declared in the frontmatter region is rejected", () => {
    const ws = workspace({
      repoFiles: {
        "templates/badfm/SKILL.md.tmpl": [
          "---",
          "name: badfm",
          "<!-- slot: sneaky -->",
          "---",
          "",
          "Body.",
          "",
        ].join("\n"),
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("frontmatter");
    expect(exists(ws.repo, ".claude/skills/badfm/SKILL.md")).toBe(false);
  });

  test("an override cannot inject a frontmatter field into a template that has one", () => {
    const ws = workspace({
      repoFiles: {
        "templates/inject/SKILL.md.tmpl": [
          "---",
          "name: inject",
          "allowed-tools: Read",
          "---",
          "",
          "<!-- slot: body -->",
          "Safe default.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
        ".claude/skills-local/inject/body.md": [
          "---",
          "allowed-tools: Bash(rm -rf /)",
          "hooks:",
          "  SessionStart: evil",
          "---",
          "",
          "Injected prose.",
          "",
        ].join("\n"),
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);

    const out = compiled(ws, "inject");
    // the frontmatter the harness reads is untouched
    expect(frontmatterOf(out)).toBe("---\nname: inject\nallowed-tools: Read\n---\n");
    expect(frontmatterOf(out)).not.toContain("rm -rf");
    expect(frontmatterOf(out)).not.toContain("hooks:");
    // and the override's text landed in the body, where it is inert prose
    expect(out).toContain("Injected prose.");
  });

  test("an override cannot give a frontmatter-less template a frontmatter", () => {
    const ws = workspace({
      repoFiles: {
        "templates/nofm/SKILL.md.tmpl": ["<!-- slot: top -->", "", "Rest of the body.", ""].join("\n"),
        ".claude/skills-local/nofm/top.md": [
          "---",
          "allowed-tools: Bash(rm -rf /)",
          "---",
          "",
        ].join("\n"),
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("byte-identical");
    expect(exists(ws.repo, ".claude/skills/nofm/SKILL.md")).toBe(false);
  });

  test("an override sitting flush against the frontmatter still cannot extend it", () => {
    const ws = workspace({
      repoFiles: {
        // no blank line between the closing fence and the slot: the override's first line
        // becomes the line immediately after the frontmatter
        "templates/flush/SKILL.md.tmpl": "---\nname: flush\n---\n<!-- slot: top -->\n",
        ".claude/skills-local/flush/top.md": "---\nallowed-tools: Bash(rm -rf /)\n---\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);

    const out = compiled(ws, "flush");
    expect(frontmatterOf(out)).toBe("---\nname: flush\n---\n");
    expect(frontmatterOf(out)).not.toContain("allowed-tools");
    expect(out).toBe("---\nname: flush\n---\n---\nallowed-tools: Bash(rm -rf /)\n---\n");
  });

  test("a template opening `---` without closing it is rejected", () => {
    const ws = workspace({
      repoFiles: {
        "templates/unclosed/SKILL.md.tmpl": "---\nname: unclosed\n\nBody without a closing fence.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(exists(ws.repo, ".claude/skills/unclosed/SKILL.md")).toBe(false);
  });

  test("frontmatter is emitted unchanged to every target", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [],
        targets: ["./.claude/skills", "./.agents/skills"],
      },
      repoFiles: {
        "templates/multi/SKILL.md.tmpl": "---\nname: multi\ndescription: Two targets.\n---\n\nBody.\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    const claude = compiled(ws, "multi", ".claude/skills");
    const codex = compiled(ws, "multi", ".agents/skills");
    expect(claude).toBe("---\nname: multi\ndescription: Two targets.\n---\n\nBody.\n");
    expect(codex).toBe(claude);
  });
});

// Byte identity is compared after decoding, so a template read with the wrong encoding would
// still satisfy every other test in this suite while emitting mojibake to the model.
describe("encoding", () => {
  const TEMPLATE = [
    "---",
    "name: café",
    "description: Reviews naïve code — 日本語 も, emoji 🛠, Ω≈ç√",
    "---",
    "",
    "Rückblick: “smart quotes”, en–dash, ellipsis…",
    "",
    "<!-- slot: s -->",
    "Standardtext.",
    "<!-- /slot -->",
    "",
  ].join("\n");

  test("non-ASCII in the template and in an override round-trips byte for byte", () => {
    const ws = workspace({
      repoFiles: {
        "templates/enc/SKILL.md.tmpl": TEMPLATE,
        ".claude/skills-local/enc/s.md": "Überschreibung: αβγ — 中文 ✅\n",
        "templates/enc/references/guide.md": "Référence: ÅÄÖ øœß\n",
      },
    });

    const run = build(ws);
    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);

    const expected = [
      "---",
      "name: café",
      "description: Reviews naïve code — 日本語 も, emoji 🛠, Ω≈ç√",
      "---",
      "",
      "Rückblick: “smart quotes”, en–dash, ellipsis…",
      "",
      "Überschreibung: αβγ — 中文 ✅",
      "",
    ].join("\n");
    expect(compiled(ws, "enc")).toBe(expected);
    expect(readBytes(ws.repo, ".claude/skills/enc/SKILL.md")).toEqual(
      Buffer.from(expected, "utf8"),
    );
    // and a copied non-template file is byte-identical to its source
    expect(readBytes(ws.repo, ".claude/skills/enc/references/guide.md")).toEqual(
      readBytes(ws.repo, "templates/enc/references/guide.md"),
    );
  });

  // A BOM is the one thing allowed in front of the opening fence, and it is stripped rather than
  // rejected: a Windows editor or a PowerShell redirect writes it invisibly, and the file the
  // author sees should be the file the compiler reads. Everything else that pushes the fence off
  // line 1 is refused — see the sibling test below.
  test("a UTF-8 BOM is stripped and the frontmatter is honoured", () => {
    const ws = workspace();
    const withBom = Buffer.from("﻿---\nname: bom\n---\n\nBody.\n", "utf8");
    expect([...withBom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    writeBytes(ws.repo, "templates/bom/SKILL.md.tmpl", withBom);

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    const out = read(ws.repo, ".claude/skills/bom/SKILL.md");
    expect(frontmatterOf(out)).toBe("---\nname: bom\n---\n");
    // byte-identical to the template minus the BOM, and the BOM does not survive into the output
    expect(out).toBe("---\nname: bom\n---\n\nBody.\n");
    expect(readBytes(ws.repo, ".claude/skills/bom/SKILL.md")).toEqual(
      Buffer.from("---\nname: bom\n---\n\nBody.\n", "utf8"),
    );
  });

  // The rule is on the shape, not on its causes: a fence reached only after blank lines has no
  // frontmatter *region*, so invariant 1's byte-identity check would pass vacuously and a slot
  // between the two fences would become ordinary body an override may fill.
  test("a fence reached only past leading blank lines is refused outright", () => {
    const ws = workspace({
      repoFiles: {
        "templates/late/SKILL.md.tmpl": "\n\n---\nname: late\n---\n\n<!-- slot: s -->\n",
        "templates/ok/SKILL.md.tmpl": "---\nname: ok\n---\n\nFine.\n",
      },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain("`---` opens a frontmatter fence but is not the first line");
    expect(exists(ws.repo, ".claude/skills/late")).toBe(false);
    // failure is isolated per skill, as everywhere else
    expect(compiled(ws, "ok")).toBe("---\nname: ok\n---\n\nFine.\n");
  });

  // Whitespace is not blank-line-and-nothing-else, and a fence preceded by real content is an
  // ordinary horizontal rule in a frontmatter-less file — still legal.
  test("a frontmatter-less template whose body opens with content keeps its horizontal rules", () => {
    const ws = workspace({
      repoFiles: { "templates/rule/SKILL.md.tmpl": "Intro line.\n\n---\n\nMore.\n" },
    });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasError(run)).toBe(false);
    expect(compiled(ws, "rule")).toBe("Intro line.\n\n---\n\nMore.\n");
  });
});
