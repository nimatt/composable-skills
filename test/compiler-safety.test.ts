import { afterEach, expect, test } from "bun:test";
import path from "node:path";

import { compileSkill } from "../src/compile.ts";
import { loadConfig } from "../src/config.ts";
import { discoverSkills } from "../src/discover.ts";
import {
  build,
  cleanup,
  hasError,
  read,
  remove,
  symlink,
  withFsFailures,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

test("failed supporting-directory enumeration retains complete output and fails check", () => {
  const ws = workspace({
    repoFiles: {
      "templates/safe/SKILL.md.tmpl": "---\nname: safe\n---\n\nOriginal.\n",
      "templates/safe/references/guide.md": "Original guide.\n",
    },
  });
  expect(hasError(build(ws))).toBe(false);
  const previous = read(ws.repo, ".claude/skills/safe/SKILL.md");
  write(ws.repo, {
    "templates/safe/SKILL.md.tmpl": "---\nname: safe\n---\n\nUpdated.\n",
  });
  const failed = withFsFailures(
    { calls: ["readdirSync"], when: path.join(ws.repo, "templates/safe/references") },
    () => {
      const run = build(ws);
      expect(hasError(run)).toBe(true);
      expect(run.stdout).toContain("cannot enumerate supporting files");
      expect(build(ws, { check: true }).code).toBe(1);
    },
  );
  expect(failed.fired.length).toBeGreaterThan(0);
  expect(read(ws.repo, ".claude/skills/safe/SKILL.md")).toBe(previous);
  expect(read(ws.repo, ".claude/skills/safe/references/guide.md")).toBe("Original guide.\n");
  expect(hasError(build(ws))).toBe(false);
  expect(read(ws.repo, ".claude/skills/safe/SKILL.md")).toContain("Updated.");
});

test("compilation rejects a template replaced by a symlink after discovery", () => {
  const ws = workspace({
    repoFiles: {
      "templates/safe/SKILL.md.tmpl": "---\nname: safe\n---\n\nOriginal.\n",
      "private.md": "---\nname: safe\n---\n\nPrivate content.\n",
    },
  });
  const loaded = loadConfig(ws.repo, ws.env);
  if ("fatal" in loaded) throw new Error(loaded.fatal);
  const skill = discoverSkills(loaded.config).skills[0];
  if (!skill) throw new Error("missing fixture skill");
  remove(ws.repo, "templates/safe/SKILL.md.tmpl");
  symlink(path.join(ws.repo, "private.md"), ws.repo, "templates/safe/SKILL.md.tmpl");
  const result = compileSkill(skill, loaded.config);
  expect(result.compiled).toBeNull();
  expect(
    result.diagnostics.some((d) => d.severity === "error" && d.message.includes("symlink")),
  ).toBe(true);
});
