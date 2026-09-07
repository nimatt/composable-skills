import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build, cleanup, read, remove, workspace, write } from "./fixtures/workspace.ts";

afterEach(cleanup);
const body = "---\nname: x\n---\n\nBody.\n";
function fixture() {
  const ws = workspace({
    repoFiles: { "templates/x/SKILL.md.tmpl": body, "templates/x/script.sh": "a\rb" },
  });
  expect(build(ws).code).toBe(0);
  return ws;
}
for (const mutation of ["delete", "edit", "mode", "extra", "symlink"] as const) {
  test(`supporting output ${mutation} is stale and rebuilt`, () => {
    const ws = fixture();
    const output = path.join(ws.repo, ".claude/skills/x/script.sh");
    if (mutation === "delete") fs.unlinkSync(output);
    if (mutation === "edit") fs.writeFileSync(output, "changed");
    if (mutation === "mode") fs.chmodSync(output, fs.statSync(output).mode ^ 0o100);
    if (mutation === "extra") write(ws.repo, { ".claude/skills/x/extra": "injected" });
    if (mutation === "symlink") {
      fs.unlinkSync(output);
      fs.symlinkSync(path.join(ws.repo, "templates/x/script.sh"), output);
    }
    expect(build(ws, { check: true }).code).toBe(1);
    expect(build(ws).stdout).toContain("1 skill → 1 target");
    expect(read(ws.repo, ".claude/skills/x/script.sh")).toBe("a\rb");
    expect(build(ws, { check: true }).code).toBe(0);
  });
}
test("verbatim source byte and executable-mode changes invalidate the stamp", () => {
  const ws = fixture();
  write(ws.repo, { "templates/x/script.sh": "a\nb" });
  expect(build(ws, { check: true }).code).toBe(1);
  build(ws);
  expect(read(ws.repo, ".claude/skills/x/script.sh")).toBe("a\nb");
  fs.chmodSync(path.join(ws.repo, "templates/x/script.sh"), 0o755);
  expect(build(ws, { check: true }).code).toBe(1);
  build(ws);
  expect(fs.statSync(path.join(ws.repo, ".claude/skills/x/script.sh")).mode & 0o777).toBe(0o755);
});
test("old stamps force rebuilding and wider stamp permissions are narrowed", () => {
  const ws = fixture();
  const stamp = path.join(ws.repo, ".composable-skills/stamp");
  const record = JSON.parse(fs.readFileSync(stamp, "utf8"));
  record.version = 2;
  fs.writeFileSync(stamp, JSON.stringify(record));
  fs.chmodSync(stamp, 0o666);
  expect(build(ws, { check: true }).code).toBe(1);
  build(ws);
  expect(fs.statSync(stamp).mode & 0o777).toBe(0o600);
});
test.skipIf(process.platform === "win32")(
  "Node output and state FIFO reads and writes never block",
  async () => {
    const ws = fixture();
    const built = await Bun.build({
      entrypoints: [path.resolve("src/fsutil.ts")],
      target: "node",
      format: "esm",
      outdir: path.join(ws.repo, "bundle"),
    });
    expect(built.success).toBe(true);
    const pipe = path.join(ws.repo, "pipe");
    expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
    const script = `import { readRegularFile, openForWriteNoFollow } from ${JSON.stringify(built.outputs[0]?.path)}; for (const fn of [() => readRegularFile(${JSON.stringify(pipe)}), () => openForWriteNoFollow(${JSON.stringify(pipe)}, 384)]) { try { fn(); process.exitCode = 1; } catch {} }`;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      timeout: 3000,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    remove(ws.repo, ".claude/skills/x/SKILL.md");
    expect(spawnSync("mkfifo", [path.join(ws.repo, ".claude/skills/x/SKILL.md")]).status).toBe(0);
    expect(build(ws, { check: true }).code).toBe(1);
    build(ws);
    expect(build(ws, { check: true }).code).toBe(0);
  },
);
