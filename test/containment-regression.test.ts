import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import {
  build,
  cleanup,
  compiled,
  exists,
  remove,
  symlink,
  workspace,
  write,
} from "./fixtures/workspace.ts";

afterEach(cleanup);

for (const destination of ["outside", "missing-outside"]) {
  test(`refuses a missing target below a ${destination} symlink`, () => {
    const ws = workspace({
      config: { sources: ["./templates"], overrides: [], targets: ["${home}/linked/new/deep"] },
      repoFiles: { "templates/s/SKILL.md.tmpl": "---\nname: s\n---\n\nSafe.\n" },
    });
    if (destination === "outside") write(ws.root, { "outside/.keep": "" });
    symlink(path.join(ws.root, destination), ws.home, "linked");
    const run = build(ws);
    expect(run.stdout).toContain("error target");
    expect(exists(ws.root, `${destination}/new`)).toBe(false);
  });
}

test("creates missing target descendants under an internal symlink", () => {
  const ws = workspace({
    config: { sources: ["./templates"], overrides: [], targets: ["${home}/linked/new/deep"] },
    repoFiles: { "templates/s/SKILL.md.tmpl": "---\nname: s\n---\n\nSafe.\n" },
  });
  write(ws.home, { "actual/.keep": "" });
  symlink(path.join(ws.home, "actual"), ws.home, "linked");
  const run = build(ws);
  expect(run.stdout).not.toContain("error");
  expect(exists(ws.home, "actual/new/deep/s/SKILL.md")).toBe(true);
});

test("a symlinked template is never emitted and preserves the previous output", () => {
  const ws = workspace({
    config: { sources: ["./templates"], overrides: [], targets: ["./.claude/skills"] },
    repoFiles: { "templates/s/SKILL.md.tmpl": "---\nname: s\n---\n\nSafe.\n" },
  });
  build(ws);
  const previous = compiled(ws, "s");
  write(ws.root, { "private.md": "---\nname: s\n---\n\nPRIVATE CONTENT\n" });
  remove(ws.repo, "templates/s/SKILL.md.tmpl");
  symlink(path.join(ws.root, "private.md"), ws.repo, "templates/s/SKILL.md.tmpl");
  const run = build(ws);
  expect(run.stdout).toContain("template is a symlink");
  expect(run.stdout).not.toContain("PRIVATE CONTENT");
  expect(compiled(ws, "s")).toBe(previous);
  expect(build(ws, { check: true }).code).toBe(1);
});

test("a symlinked skill with a symlinked template does not prune previous output", () => {
  const ws = workspace({
    repoFiles: { "templates/s/SKILL.md.tmpl": "---\nname: s\n---\n\nSafe.\n" },
  });
  build(ws);
  const previous = compiled(ws, "s");
  write(ws.root, { "private.md": "Private content.", "linked-skill/.keep": "" });
  symlink(path.join(ws.root, "private.md"), ws.root, "linked-skill/SKILL.md.tmpl");
  remove(ws.repo, "templates/s");
  symlink(path.join(ws.root, "linked-skill"), ws.repo, "templates/s");
  expect(build(ws).stdout).toContain("skill directory is a symlink");
  expect(compiled(ws, "s")).toBe(previous);
});
