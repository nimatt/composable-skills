import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBuild } from "../../src/build.ts";
import { runInit } from "../../src/init.ts";
import { runOverride } from "../../src/override.ts";

const created: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "composable-skills-test-")));
  created.push(dir);
  return dir;
}

export function cleanup(): void {
  while (created.length > 0) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
}

export function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

export function writeBytes(root: string, rel: string, bytes: Buffer): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
}

export function readBytes(root: string, rel: string): Buffer {
  return fs.readFileSync(path.join(root, ...rel.split("/")));
}

export function exists(root: string, rel: string): boolean {
  try {
    fs.lstatSync(path.join(root, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

export function remove(root: string, rel: string): void {
  fs.rmSync(path.join(root, ...rel.split("/")), { recursive: true, force: true });
}

export function symlink(target: string, root: string, rel: string): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.symlinkSync(target, abs);
}

export function chmod(root: string, rel: string, mode: number): void {
  fs.chmodSync(path.join(root, ...rel.split("/")), mode);
}

export function modeOf(root: string, rel: string): number {
  return fs.statSync(path.join(root, ...rel.split("/"))).mode & 0o777;
}

export function mkdir(root: string, rel: string): string {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * The spec's documented default override chain, spelled out literally rather than imported from
 * `src/config.ts`, so most fixtures work against a chain this file pins independently. That the
 * *implementation's* defaults still match these strings is asserted separately, by the
 * config-defaults tests that write no `overrides` key at all.
 */
const DEFAULT_CONFIG = {
  id: "acme",
  sources: ["./templates"],
  overrides: ["${home}/global", "./.claude/skills-local", "${home}/repos/${id}"],
  targets: ["./.claude/skills"],
};

export interface Workspace {
  root: string;
  repo: string;
  /** `${home}` — what `COMPOSABLE_SKILLS_HOME` points at, holding `global/` and `repos/<id>/`. */
  home: string;
  /**
   * What `os.homedir()` returns for the duration of a run started through this fixture. A separate
   * directory from `${home}`, because they are separate things: this one stands in for `~`, which
   * `init` reads `~/.claude/settings.json` out of and compares the repo root against.
   */
  osHome: string;
  env: NodeJS.ProcessEnv;
}

export interface WorkspaceOptions {
  /** An object or a raw string is written as the config file; `null` writes no config at all. */
  config?: unknown;
  /** Give the repo a `.git` entry, so `findRepoRoot`/`findConfigFile` stop there. */
  git?: boolean;
  repoFiles?: Record<string, string>;
  homeFiles?: Record<string, string>;
  /** Files under the stand-in `~`, for the user-level settings file `init` reads for detection. */
  osHomeFiles?: Record<string, string>;
}

export function workspace(options: WorkspaceOptions = {}): Workspace {
  const root = tempDir();
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const osHome = path.join(root, "os-home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(osHome, { recursive: true });

  const config = options.config === undefined ? DEFAULT_CONFIG : options.config;
  if (config !== null) {
    const text = typeof config === "string" ? config : `${JSON.stringify(config, null, 2)}\n`;
    write(repo, { "composable-skills.jsonc": text });
  }
  if (options.git) write(repo, { ".git/HEAD": "ref: refs/heads/main\n" });
  if (options.repoFiles) write(repo, options.repoFiles);
  if (options.homeFiles) write(home, options.homeFiles);
  if (options.osHomeFiles) write(osHome, options.osHomeFiles);

  return {
    root,
    repo,
    home,
    osHome,
    /**
     * `HOME` and `XDG_CONFIG_HOME` are redirected as well as `COMPOSABLE_SKILLS_HOME`, so that no
     * path any verb derives from the environment can reach the developer's real home. `os.homedir()`
     * does not consult `HOME` under every runtime, which is why `captured()` patches it outright —
     * these two are the belt beside that brace, and they are what a subprocess gets.
     */
    env: { COMPOSABLE_SKILLS_HOME: home, HOME: osHome, XDG_CONFIG_HOME: path.join(osHome, ".config") },
  };
}

export interface StreamWrite {
  stream: "stdout" | "stderr";
  text: string;
}

export interface BuildRun {
  code: number;
  /** Read back from the destination fd 1 pointed at while the build ran. */
  stdout: string;
  /** Read back from the destination fd 2 pointed at. Under `streams: "shared"` that is one file, so this is the same text. */
  stderr: string;
  /** Every write the build made, in order, tagged with the stream it went through. */
  writes: StreamWrite[];
}

/**
 * Where fds 1 and 2 point while a build runs. `emitReport` decides whether to write once or twice
 * by `fstat`ing them and comparing `dev`/`ino`, so these are the two cases it distinguishes —
 * spelled out here rather than inherited from whatever shell invoked `bun test`.
 */
export type StreamRouting = "separate" | "shared";

export interface BuildOptions {
  check?: boolean;
  version?: string;
  /** Pass no `version` at all, so `runBuild` reads the tool's own. */
  ownVersion?: boolean;
  /** Where the build runs from; defaults to the repo root. */
  cwd?: string;
  /**
   * Defaults to `"separate"` — pinned, not inherited. Every `run.stdout` assertion in this suite
   * depends on the two-destination half of the rule, and under a shell that merges the two the
   * whole suite would otherwise assert something different.
   */
  streams?: StreamRouting;
}

/** Restores the property exactly, including the case where it did not exist at all. */
function force(stream: object, key: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(stream, key);
  Object.defineProperty(stream, key, { value, writable: true, configurable: true, enumerable: true });
  return () => {
    if (original === undefined) delete (stream as Record<string, unknown>)[key];
    else Object.defineProperty(stream, key, original);
  };
}

let captureRoot: string | null = null;
let captureSeq = 0;

/**
 * Deliberately not `fs.mkdirSync`/`fs.writeFileSync`: one test patches those to record every path
 * a build touches, and capture files are the fixture's business, not the build's.
 */
function captureDir(): string {
  if (captureRoot === null || !fs.existsSync(captureRoot)) captureRoot = tempDir();
  return captureRoot;
}

interface Capture {
  outFd: number;
  errFd: number;
  outPath: string;
  errPath: string;
}

function openCapture(routing: StreamRouting): Capture {
  const dir = captureDir();
  const stem = path.join(dir, `run-${captureSeq++}`);
  const outPath = `${stem}-stdout`;
  const errPath = routing === "shared" ? outPath : `${stem}-stderr`;
  // Two open file descriptions on one path share `dev`/`ino`; two paths do not. That is exactly
  // the distinction `emitReport` makes, so the fixture makes it with real descriptors.
  return { outFd: fs.openSync(outPath, "a"), errFd: fs.openSync(errPath, "a"), outPath, errPath };
}

/**
 * Runs one verb with fds 1 and 2 pointed at real files, so `emitReport`'s one-destination rule is
 * exercised against real descriptors rather than a faked `isTTY`. Shared by every verb, so a test
 * of `init` or `override` is as invocation-independent as a test of `build`.
 */
function captured(routing: StreamRouting, run: () => number, homedir: string | null = null): BuildRun {
  const writes: StreamWrite[] = [];
  const capture = openCapture(routing);

  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const restore = [
    force(process.stdout, "fd", capture.outFd),
    force(process.stderr, "fd", capture.errFd),
    /**
     * `os.homedir()` is a real syscall under some runtimes and ignores `HOME`, so redirecting the
     * environment is not enough on its own: `init` compares the repo root against it and reads
     * `~/.claude/settings.json` through it, and neither may ever reach the developer's own home.
     * Patched here, for every verb, so no test can forget.
     */
    ...(homedir === null ? [] : [force(os, "homedir", () => homedir)]),
    // Pinned false so the `fstat` fallback in `emitReport` can never be reached silently with a
    // value inherited from the invoking shell. If a descriptor above ever stops being stat-able,
    // the fallback writes twice and the routing tests fail loudly rather than drifting.
    force(process.stdout, "isTTY", false),
    force(process.stderr, "isTTY", false),
  ];
  const capturing = (stream: "stdout" | "stderr", fd: number) =>
    ((chunk: unknown) => {
      const text = String(chunk);
      writes.push({ stream, text });
      fs.writeSync(fd, text);
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = capturing("stdout", capture.outFd);
  process.stderr.write = capturing("stderr", capture.errFd);

  let code: number;
  try {
    code = run();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    for (const undo of restore) undo();
    fs.closeSync(capture.outFd);
    fs.closeSync(capture.errFd);
  }

  return {
    code,
    stdout: fs.readFileSync(capture.outPath, "utf8"),
    stderr: fs.readFileSync(capture.errPath, "utf8"),
    writes,
  };
}

export function build(ws: Workspace, options: BuildOptions = {}): BuildRun {
  return captured(
    options.streams ?? "separate",
    () =>
      runBuild({
        cwd: options.cwd ?? ws.repo,
        check: options.check ?? false,
        ...(options.ownVersion === true ? {} : { version: options.version ?? "test-version" }),
        env: ws.env,
      }),
    ws.osHome,
  );
}

export interface InitOptions {
  write?: boolean;
  cwd?: string;
  streams?: StreamRouting;
}

export function init(ws: Workspace, options: InitOptions = {}): BuildRun {
  return captured(
    options.streams ?? "separate",
    () => runInit({ cwd: options.cwd ?? ws.repo, env: ws.env, write: options.write ?? false }),
    ws.osHome,
  );
}

export interface OverrideOptions {
  dryRun?: boolean;
  cwd?: string;
  streams?: StreamRouting;
}

export function override(
  ws: Workspace,
  skill: string,
  slot: string,
  options: OverrideOptions = {},
): BuildRun {
  return captured(
    options.streams ?? "separate",
    () =>
      runOverride({
        cwd: options.cwd ?? ws.repo,
        env: ws.env,
        skill,
        slot,
        dryRun: options.dryRun ?? false,
      }),
    ws.osHome,
  );
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `src/cli.ts` in a child process, which is the only way to observe the exit code it actually
 * produces — it sets `process.exitCode` at module scope, so importing it here would both run the
 * CLI against the test runner's own argv and hand its verdict to `bun test`.
 *
 * The child gets a shim that patches `os.homedir()` before `cli.ts` loads, for the same reason
 * `captured()` does: no run started by this fixture may see the developer's real home. Both
 * descriptors are pipes, so the routing is `separate` and cannot depend on the invoking shell.
 */
export function cli(ws: Workspace, args: string[], cwd = ws.repo): CliRun {
  const shim = path.join(tempDir(), "cli-shim.ts");
  const cliPath = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
  fs.writeFileSync(
    shim,
    [
      'import os from "node:os";',
      `const home = ${JSON.stringify(ws.osHome)};`,
      '(os as unknown as { homedir: () => string }).homedir = () => home;',
      `await import(${JSON.stringify(cliPath)});`,
      "",
    ].join("\n"),
    "utf8",
  );
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, "run", shim, ...args],
    cwd,
    env: { ...ws.env, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

/** How many times `needle` occurs in `haystack` — the unit the one-copy rule is stated in. */
export function occurrences(haystack: string, needle: string): number {
  if (needle === "") throw new Error("occurrences() needs a non-empty needle");
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

export function compiled(ws: Workspace, skill: string, target = ".claude/skills"): string {
  return read(ws.repo, `${target}/${skill}/SKILL.md`);
}

/** The frontmatter block of a compiled file, including both `---` fences and the trailing LF. */
export function frontmatterOf(text: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") return "";
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return `${lines.slice(0, i + 1).join("\n")}\n`;
  }
  return "";
}

export function bodyOf(text: string): string {
  return text.slice(frontmatterOf(text).length);
}

/** Every file under `root`, as `relative-path\0bytes` lines, for before/after comparison. */
export function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(`${rel}\0${fs.readFileSync(abs).toString("base64")}`);
    }
  };
  walk(root, "");
  return out;
}

export function hasError(run: BuildRun): boolean {
  return run.stdout.includes("composable-skills: error");
}

export function hasWarning(run: BuildRun): boolean {
  return run.stdout.includes("composable-skills: warning");
}

/** Every diagnostic line, so a test can assert one whole formatted line rather than a substring. */
export function lines(run: BuildRun): string[] {
  return run.stdout.split("\n").filter((line) => line !== "");
}
