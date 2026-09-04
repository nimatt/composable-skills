import { afterEach, describe, expect, test } from "bun:test";

import {
  build,
  cleanup,
  compiled,
  exists,
  hasError,
  lines,
  mkdir,
  override,
  read,
  snapshot,
  symlink,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

const TEMPLATE = [
  "---",
  "name: reviewer",
  "description: Reviews code.",
  "---",
  "",
  "# Reviewer",
  "",
  "<!-- slot: intro -->",
  "",
  "<!-- slot: extra-checks -->",
  "Check for dead code.",
  "Check for TODOs.",
  "<!-- /slot -->",
  "",
  "<!-- slot: output-format mode=append -->",
  "Report findings as a markdown table.",
  "<!-- /slot -->",
  "",
].join("\n");

function reviewerWorkspace(extra: Record<string, string> = {}) {
  return workspace({
    repoFiles: { "templates/reviewer/SKILL.md.tmpl": TEMPLATE, ...extra },
  });
}

/** The default chain's highest-precedence entry, `${home}/repos/${id}`, with the fixture's id. */
const HIGHEST = "repos/acme/reviewer";

describe("override — seeding", () => {
  test("creates the file in the highest-precedence root, seeded with the template's default", () => {
    const ws = reviewerWorkspace();
    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    expect(read(ws.home, `${HIGHEST}/extra-checks.md`)).toBe(
      "Check for dead code.\nCheck for TODOs.\n",
    );
    expect(run.stdout).toContain(`${HIGHEST}/extra-checks.md`);
    expect(run.stdout).toContain("the template's current default (2 lines)");
  });

  test("seeds from a lower-precedence override that currently wins, not from the default", () => {
    const ws = reviewerWorkspace({
      ".claude/skills-local/reviewer/extra-checks.md": "The local root's text.\n",
    });
    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    // Writing into a higher-precedence root shadows whatever filled the slot before, so seeding
    // the template's default here would silently discard a root the whole repo builds against.
    expect(read(ws.home, `${HIGHEST}/extra-checks.md`)).toBe("The local root's text.\n");
    expect(run.stdout).toContain('the text that currently resolves, from "./.claude/skills-local"');
    // …and it says where that text came from, since `explain` does not exist to say it.
    expect(run.stdout).toContain('resolves    the override root "./.claude/skills-local"');
    expect(run.stdout).not.toContain("the template's current default");
  });

  test("mode=append seeds the winning root's own half, never the composed default-plus-override", () => {
    const ws = reviewerWorkspace({
      ".claude/skills-local/reviewer/output-format.md": "Also give a one-line verdict.\n",
    });
    const run = override(ws, "reviewer", "output-format");

    expect(run.code).toBe(0);
    // The build emits default, blank line, override — so the composed result is not what belongs
    // in an override file, and seeding it would emit the default twice.
    expect(read(ws.home, `${HIGHEST}/output-format.md`)).toBe("Also give a one-line verdict.\n");
    expect(run.stdout).toContain(
      'the text "./.claude/skills-local" currently adds here (1 line) — mode=append re-adds it after the default',
    );
    expect(run.stdout).not.toContain("would emit the default twice");
  });

  test("a slot resolving from the template's default says so", () => {
    const ws = reviewerWorkspace();
    expect(override(ws, "reviewer", "extra-checks").stdout).toContain(
      "resolves    the template's default",
    );
  });

  test("a slot with no default is created empty", () => {
    const ws = reviewerWorkspace();
    const run = override(ws, "reviewer", "intro");

    expect(read(ws.home, `${HIGHEST}/intro.md`)).toBe("");
    expect(run.stdout).toContain("the slot declares no default, so there is nothing to replace");
  });

  test("mode=append is created empty, because seeding it would emit the default twice", () => {
    const ws = reviewerWorkspace();
    const run = override(ws, "reviewer", "output-format");

    expect(read(ws.home, `${HIGHEST}/output-format.md`)).toBe("");
    expect(run.stdout).toContain("would emit the default twice");
    // The default is printed instead, so the developer still sees the text they are extending.
    expect(run.stdout).toContain("Report findings as a markdown table.");
  });

  test("the override reaches the compiled skill on the next build", () => {
    const ws = reviewerWorkspace();
    override(ws, "reviewer", "extra-checks");
    write(ws.home, { [`${HIGHEST}/extra-checks.md`]: "Check for dead code.\nCheck for flakes.\n" });

    expect(build(ws).code).toBe(0);
    expect(compiled(ws, "reviewer")).toContain("Check for flakes.");
    expect(compiled(ws, "reviewer")).not.toContain("Check for TODOs.");
  });
});

/**
 * The property the whole seeding design exists for: run `override`, edit nothing, and the compiled
 * skill does not move. It is what makes replace-by-default safe to hand a developer — the file they
 * are given already says what the slot says today, so the only way to change the output is to mean
 * to. Nothing else in this suite builds either side of an unedited `override`, and the property did
 * not hold before seeding learned to read the winning override rather than the template.
 */
describe("override — an unedited override changes nothing", () => {
  interface NoOpCase {
    what: string;
    mode: "replace" | "append";
    defaultLines: string[];
    /** Content of `./.claude/skills-local/solo/s.md`, or null for a slot nothing overrides yet. */
    lower: string | null;
  }

  const DEFAULT_LINES = ["The template default.", "On two lines."];

  const cases: NoOpCase[] = (["replace", "append"] as const).flatMap((mode) => [
    { what: "nothing overrides the slot yet", mode, defaultLines: DEFAULT_LINES, lower: null },
    {
      what: "a lower-precedence root fills it",
      mode,
      defaultLines: DEFAULT_LINES,
      lower: "The local root's text.\n",
    },
    {
      what: "a lower-precedence root fills it with an empty file",
      mode,
      defaultLines: DEFAULT_LINES,
      lower: "",
    },
    { what: "the template declares no default", mode, defaultLines: [], lower: null },
  ]);

  function template(mode: "replace" | "append", defaultLines: string[]): string {
    const open = mode === "append" ? "<!-- slot: s mode=append -->" : "<!-- slot: s -->";
    const body = defaultLines.length === 0 ? [open] : [open, ...defaultLines, "<!-- /slot -->"];
    return [
      "---",
      "name: solo",
      "description: One slot.",
      "---",
      "",
      "# Solo",
      "",
      ...body,
      "",
    ].join("\n");
  }

  for (const scenario of cases) {
    test(`mode=${scenario.mode}, ${scenario.what}`, () => {
      const ws = workspace({
        repoFiles: {
          "templates/solo/SKILL.md.tmpl": template(scenario.mode, scenario.defaultLines),
          ...(scenario.lower === null ? {} : { ".claude/skills-local/solo/s.md": scenario.lower }),
        },
      });

      const first = build(ws);
      expect(first.code).toBe(0);
      expect(hasError(first)).toBe(false);
      const before = compiled(ws, "solo");

      const created = override(ws, "solo", "s");
      expect(created.code).toBe(0);
      expect(exists(ws.home, "repos/acme/solo/s.md")).toBe(true);

      const second = build(ws);
      expect(second.code).toBe(0);
      expect(hasError(second)).toBe(false);
      // The new file is part of the hashed override tree, so the stamp gate opens and the skill is
      // genuinely recompiled — byte-identity that came from not rebuilding would prove nothing.
      expect(second.stdout).toContain("1 skill → 1 target");
      expect(compiled(ws, "solo")).toBe(before);
    });
  }

  test("and the seeded file is the text the slot resolved to, so a second override is a no-op too", () => {
    const ws = workspace({
      repoFiles: {
        "templates/solo/SKILL.md.tmpl": template("replace", ["The template default."]),
        ".claude/skills-local/solo/s.md": "\n\nThe local root's text.\n\n",
      },
    });
    build(ws);
    override(ws, "solo", "s");

    // `trimBlockEdges` is what makes the seed a copy of the *resolved* text rather than of the
    // file's bytes, and it is idempotent — so seeding from the seed lands in the same place.
    expect(read(ws.home, "repos/acme/solo/s.md")).toBe("The local root's text.\n");
  });
});

describe("override — never clobbers", () => {
  test("an existing override file is left byte-identical and reported", () => {
    const ws = reviewerWorkspace();
    write(ws.home, { [`${HIGHEST}/extra-checks.md`]: "Mine, edited.\n" });
    const before = snapshot(ws.home);

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    expect(snapshot(ws.home)).toEqual(before);
    expect(run.stdout).toContain("This file already exists, so nothing was written");
    expect(run.stdout).toContain(`the override root "\${home}/repos/\${id}"`);
  });

  test("an existing empty override file is still not overwritten", () => {
    const ws = reviewerWorkspace();
    write(ws.home, { [`${HIGHEST}/output-format.md`]: "" });
    const before = snapshot(ws.home);

    expect(override(ws, "reviewer", "output-format").code).toBe(0);
    expect(snapshot(ws.home)).toEqual(before);
  });

  test("--dry-run writes nothing at all", () => {
    const ws = reviewerWorkspace();
    const before = snapshot(ws.root);

    const run = override(ws, "reviewer", "extra-checks", { dryRun: true });

    expect(run.code).toBe(0);
    expect(snapshot(ws.root)).toEqual(before);
    expect(run.stdout).toContain("would seed");
    expect(run.stdout).toContain("Nothing was written.");
  });
});

describe("override — where the file lands", () => {
  test("a chosen root inside the repo is called out, and the inert ${id} root named as the cause", () => {
    const ws = workspace({
      config: { sources: ["./templates"], targets: ["./.claude/skills"] },
      repoFiles: { "templates/reviewer/SKILL.md.tmpl": TEMPLATE },
    });

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(0);
    // With no `id`, `${home}/repos/${id}` goes inert and the personal file lands in the working
    // tree, where git offers it to the whole team.
    expect(read(ws.repo, ".claude/skills-local/reviewer/extra-checks.md")).toBe(
      "Check for dead code.\nCheck for TODOs.\n",
    );
    expect(run.stdout).toContain(
      "This root is inside the repo, so the file lands in the working tree and git will see it",
    );
    expect(run.stdout).toContain("an override committed from here is the whole team's, not yours.");
    expect(run.stdout).toContain(
      '(The personal ${home}/repos/${id} root is inert until the config declares an "id".)',
    );
  });

  test("a root outside the repo says nothing of the sort", () => {
    const ws = reviewerWorkspace();
    const run = override(ws, "reviewer", "extra-checks");

    expect(read(ws.home, `${HIGHEST}/extra-checks.md`)).not.toBe("");
    expect(run.stdout).not.toContain("This root is inside the repo");
    expect(run.stdout).not.toContain("is inert until the config declares");
  });

  test("an in-repo root with an id declared still says the file is in the working tree", () => {
    const ws = workspace({
      config: { id: "acme", sources: ["./templates"], overrides: ["./.claude/skills-local"] },
      repoFiles: { "templates/reviewer/SKILL.md.tmpl": TEMPLATE },
    });

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.stdout).toContain("This root is inside the repo");
    // …but the inert-`${id}` explanation is not the reason here, so it is not offered.
    expect(run.stdout).not.toContain("is inert until the config declares");
  });
});

describe("override — a name typed slightly wrong", () => {
  test("an unknown skill lists the skills that do exist", () => {
    const ws = workspace({
      repoFiles: {
        "templates/reviewer/SKILL.md.tmpl": TEMPLATE,
        "templates/planner/SKILL.md.tmpl": "---\nname: planner\n---\n\nPlan.\n",
      },
    });
    const run = override(ws, "reviewr", "extra-checks");

    expect(run.code).toBe(1);
    expect(hasError(run)).toBe(true);
    expect(run.stdout).toContain('unknown skill "reviewr" — this repo compiles: planner, reviewer');
  });

  test("an unknown slot lists the slots the skill declares", () => {
    const ws = reviewerWorkspace();
    const run = override(ws, "reviewer", "extrachecks");

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      'declares no slot "extrachecks" — it declares: intro, extra-checks, output-format',
    );
  });

  test("a repo with no skills at all says so rather than listing nothing", () => {
    const ws = workspace();
    const run = override(ws, "reviewer", "intro");

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("no configured source root holds any skill");
  });

  test("a skill that declares no slots says so", () => {
    const ws = workspace({
      repoFiles: { "templates/planner/SKILL.md.tmpl": "---\nname: planner\n---\n\nPlan.\n" },
    });
    const run = override(ws, "planner", "intro");

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('declares no slots at all, so "intro" cannot be overridden');
  });
});

describe("override — refusals", () => {
  test("a template that does not compile is not seeded from", () => {
    const ws = workspace({
      repoFiles: {
        "templates/reviewer/SKILL.md.tmpl": [
          "---",
          "name: reviewer",
          "---",
          "",
          "<!-- slot: extra-checks -->",
          "<<<<<<< HEAD",
          "Check for dead code.",
          "<!-- /slot -->",
          "",
        ].join("\n"),
      },
    });
    const before = snapshot(ws.root);

    const run = override(ws, "reviewer", "extra-checks");

    expect(run.code).toBe(1);
    expect(snapshot(ws.root)).toEqual(before);
    expect(run.stdout).toContain("does not compile, so there is no current default to seed from");
  });

  test("a config with no usable override root says where it would have written", () => {
    const ws = workspace({
      config: {
        id: "acme",
        sources: ["./templates"],
        overrides: [],
        targets: ["./.claude/skills"],
      },
      repoFiles: { "templates/reviewer/SKILL.md.tmpl": TEMPLATE },
    });
    const run = override(ws, "reviewer", "intro");

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("no usable override root is configured");
  });

  test("a symlinked skill directory inside the override root gets no file written into it", () => {
    const ws = reviewerWorkspace();
    const outside = mkdir(ws.root, "elsewhere");
    mkdir(ws.home, "repos/acme");
    symlink(outside, ws.home, "repos/acme/reviewer");

    const run = override(ws, "reviewer", "extra-checks");

    // The compiler's own containment discipline gets there first: an override root that is
    // traversed through a symlink rejects the skill, which leaves nothing to seed from.
    expect(run.code).toBe(1);
    expect(exists(ws.root, "elsewhere/extra-checks.md")).toBe(false);
    expect(run.stdout).toContain('override traverses a symlink at "reviewer"');
  });

  test("a fatal config aborts before anything is written", () => {
    const ws = workspace({ config: "{ not json" });
    const before = snapshot(ws.root);

    const run = override(ws, "reviewer", "intro");

    expect(run.code).toBe(1);
    expect(snapshot(ws.root)).toEqual(before);
  });
});

describe("override — reporting", () => {
  test("output does not depend on how the streams are wired", () => {
    const separate = override(reviewerWorkspace(), "reviewer", "extra-checks");
    const shared = override(reviewerWorkspace(), "reviewer", "extra-checks", { streams: "shared" });

    expect(lines(shared).length).toBe(lines(separate).length);
    expect(shared.writes.filter((entry) => entry.stream === "stdout")).toHaveLength(0);
    expect(separate.stdout).toBe(separate.stderr);
  });

  test("nothing is written into the repo's state directory", () => {
    const ws = reviewerWorkspace();
    override(ws, "reviewer", "extra-checks");

    expect(exists(ws.repo, ".composable-skills/build.log")).toBe(false);
  });
});
