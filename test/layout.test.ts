import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { toolVersion } from "../src/layout.ts";
import { build, cleanup, compiled, read, workspace } from "./fixtures/workspace.ts";

afterEach(cleanup);

const REPO = path.join(import.meta.dir, "..");

/**
 * `toolVersion()` finds `package.json` at `..` from its own module, and the two layouts that ship
 * put it in different places: `src/layout.ts` during development, and the bundled `dist/cli.js`
 * this module is folded into for release. A failed lookup falls back to `"0.0.0"`, one patch
 * below the version the package declares — so asserting against the real package proves close to
 * nothing. Both layouts are smoke-tested against a copy whose version cannot be mistaken for the
 * fallback.
 */
describe("toolVersion resolves package.json from both shipped layouts", () => {
  const SMOKE = "9.9.9-smoke";

  function stagePackage(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "composable-skills-layout-"));
    fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "composable-skills", version: SMOKE, type: "module" })}\n`,
      "utf8",
    );
    return root;
  }

  function run(cmd: string[], cwd: string): string {
    const proc = Bun.spawnSync({ cmd, cwd });
    const out = new TextDecoder().decode(proc.stdout);
    const err = new TextDecoder().decode(proc.stderr);
    expect({ code: proc.exitCode, err }).toEqual({ code: 0, err: "" });
    return out;
  }

  test("from src/, and from the bundle", () => {
    const root = stagePackage();
    try {
      expect(run([process.execPath, path.join(root, "src", "cli.ts"), "--version"], root)).toBe(
        `${SMOKE}\n`,
      );

      run([process.execPath, "build", "src/cli.ts", "--target=node", "--outdir=dist"], root);
      expect(fs.existsSync(path.join(root, "dist", "cli.js"))).toBe(true);
      expect(run([process.execPath, path.join(root, "dist", "cli.js"), "--version"], root)).toBe(
        `${SMOKE}\n`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The version reaches the stamp through `toolVersion()` now that `BuildOptions.version` is a test
 * override rather than something every caller must remember to pass. A caller that forgets it must
 * get the real version, not a default that makes every tree look fresh across an upgrade.
 */
describe("a build that is given no version", () => {
  function versioned() {
    return workspace({
      repoFiles: { "templates/v/SKILL.md.tmpl": "---\nname: v\n---\n\nBody.\n" },
    });
  }

  test("stamps with the tool's own", () => {
    const ws = versioned();

    const first = build(ws, { ownVersion: true });
    expect(first.code).toBe(0);
    expect(compiled(ws, "v")).toBe("---\nname: v\n---\n\nBody.\n");
    const stamp = read(ws.repo, ".composable-skills/stamp");

    // the same version, spelled out, is the same stamp — so the default really is this value
    const again = build(ws, { version: toolVersion() });
    expect(again.stdout).toBe("");
    expect(read(ws.repo, ".composable-skills/stamp")).toBe(stamp);

    // and any other version is not, so the stamp is not simply ignoring the field
    build(ws, { version: `${toolVersion()}-other` });
    expect(read(ws.repo, ".composable-skills/stamp")).not.toBe(stamp);
  });
});
