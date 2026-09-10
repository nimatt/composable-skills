import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBuild } from "../../src/build.ts";
import { CONFIG_FILENAMES } from "../../src/config.ts";
import { runInit } from "../../src/init.ts";
import { runOverride } from "../../src/override.ts";

const created: string[] = [];

/**
 * Every path `chmod()` has changed the mode of. `fs.rmSync(…, { force: true })` still throws
 * `EACCES` on a tree containing a mode-000 directory, so a test that locks a directory used to
 * have to unlock it by hand in a `finally` — and forgetting cost more than that one test, because
 * the throw escaped `cleanup()`'s loop and abandoned every temp directory still queued behind it.
 * Recording the paths here moves that obligation off the test author.
 */
const chmodded: string[] = [];

/**
 * Everything a verb derives from the environment is redirected below, so no `${home}` root can
 * reach the developer's own files. The upward *filesystem* walk is the same leak through a
 * different mechanism, and nothing redirects it: `findConfigFile` and `findRepoRoot` climb from the
 * repo until they meet a `.git`, and a workspace built without one has nothing to stop them, so
 * they leave the temp directory and keep going. Whatever sits above `os.tmpdir()` then decides what
 * the fixture's own tests observe — a `composable-skills.jsonc` there becomes the config every
 * `config: null` workspace resolves, and a `.git` there becomes the repo root every workspace
 * without one reports.
 *
 * That is not hypothetical. Running a verb with the working directory set to `/tmp` leaves exactly
 * such a config behind, and the tests that then fail name the tool and a path inside the tool
 * rather than the file responsible, which is expensive to chase and easy to misread as a bug in the
 * code under test.
 *
 * It cannot be fenced off, only detected: `.git` is the sole thing that halts either walk, and
 * planting one above the workspace would make `findRepoRoot` return that ancestor, which is the
 * behaviour a `git: false` workspace exists to test. So the precondition is checked once and the
 * offending path is named, rather than being enforced.
 */
export function strayAncestors(startDir: string): string[] {
  const found: string[] = [];
  let dir = startDir;
  for (;;) {
    for (const name of [...CONFIG_FILENAMES, ".git"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/**
 * The walk is cached, but the refusal is not: every workspace a polluted run tries to create fails
 * the same way. Reporting once and then letting the rest of the suite proceed would put the results
 * it was built to distrust back in front of the reader, under a green-looking summary.
 */
let stray: string[] | null = null;

function assertNothingShadowsTheTempDirectory(): void {
  stray ??= strayAncestors(fs.realpathSync(os.tmpdir()));
  if (stray.length === 0) return;
  throw new Error(
    `the test fixture cannot trust its workspaces: ${stray.length === 1 ? "a path" : "paths"} at or ` +
      `above ${os.tmpdir()}, where every workspace is created, ${stray.length === 1 ? "is" : "are"} ` +
      `visible to the upward search that resolves a config and a repo root:\n\n  ${stray.join("\n  ")}\n\n` +
      "A config there is resolved by every workspace built with `config: null`, and a `.git` there " +
      "becomes the repo root of every workspace built without one, so the suite would report " +
      "failures that belong to those paths rather than to the code. Remove them and run again.",
  );
}

function tempDir(): string {
  assertNothingShadowsTheTempDirectory();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "composable-skills-test-")));
  created.push(dir);
  return dir;
}

function restoreModes(): void {
  // Shallowest first: a mode-000 parent has to be reopened before anything under it can be
  // chmod'd, and a parent's path is always the shorter string.
  for (const target of chmodded.splice(0).sort((a, b) => a.length - b.length)) {
    try {
      fs.chmodSync(target, 0o700);
    } catch {
      // Already removed by the test, or never created. The removal below is what has to succeed.
    }
  }
}

export function cleanup(): void {
  restoreModes();
  const failures: unknown[] = [];
  for (const dir of created.splice(0).reverse()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "cleanup() could not remove every temp directory");
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

/** Recorded, so `cleanup()` can reopen the path before removing the tree it sits in. */
export function chmod(root: string, rel: string, mode: number): void {
  const abs = path.join(root, ...rel.split("/"));
  chmodded.push(abs);
  fs.chmodSync(abs, mode);
}

export function modeOf(root: string, rel: string): number {
  return fs.statSync(path.join(root, ...rel.split("/"))).mode & 0o777;
}

export function mkdir(root: string, rel: string): string {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** The `fs` functions `withFsFailures()` patches, mapped to how many of their leading arguments are paths. */
const PATH_ARGUMENTS = {
  readFileSync: 1,
  writeFileSync: 1,
  lstatSync: 1,
  statSync: 1,
  readdirSync: 1,
  mkdirSync: 1,
  rmSync: 1,
  unlinkSync: 1,
  openSync: 1,
  chmodSync: 1,
  renameSync: 2,
  copyFileSync: 2,
} as const;

export type PatchableFsCall = keyof typeof PATH_ARGUMENTS;

export interface FsFailure {
  /** Which `fs` functions to patch. Calls to anything else reach the real implementation untouched. */
  calls: PatchableFsCall[];
  /**
   * An absolute path to match exactly, or a predicate applied to each path argument of the call.
   * For the two-path calls (`renameSync`, `copyFileSync`) either argument matching is enough.
   */
  when: string | ((target: string) => boolean);
  /** errno the injected error carries. Defaults to `EACCES`. */
  code?: string;
  /** Message the injected error carries. Defaults to one shaped like libuv's. */
  message?: string;
}

export interface FsFailureRun<T> {
  result: T;
  /** `"<call> <path>"` for every injected throw, in order. An empty array means the patch never fired. */
  fired: string[];
}

function injectedError(
  failure: FsFailure,
  call: PatchableFsCall,
  target: string,
): NodeJS.ErrnoException {
  const code = failure.code ?? "EACCES";
  const error: NodeJS.ErrnoException = new Error(
    failure.message ?? `${code}: injected by the test fixture, ${call} '${target}'`,
  );
  error.code = code;
  error.syscall = call;
  error.path = target;
  return error;
}

/**
 * Runs `run()` with the named `fs` functions throwing for the paths `when` selects, and delegating
 * to the real implementation for every other path. Everything is restored in a `finally`.
 *
 * **Path-selective, deliberately not call-count-selective.** Keying an injected failure on "the
 * second `renameSync`" pins the test to the *order* `src/` happens to issue its syscalls in today,
 * so any later refactor that reorders, adds or removes a call silently retargets the failure at a
 * different operation and the test keeps passing while proving something else. Keying on the path
 * pins it to the operation the test actually means.
 *
 * Selectivity is also what makes this safe to wrap around `build()`/`init()`/`override()` at all:
 * see `captured()` below, whose own bookkeeping runs inside this window. A blanket patch — one that
 * throws for every call — breaks the fixture rather than the code under test.
 *
 * `fired` is returned so a test can assert the failure it asked for really happened; a predicate
 * that matches nothing would otherwise leave the test green and hollow.
 */
export function withFsFailures<T>(
  failures: FsFailure | FsFailure[],
  run: () => T,
): FsFailureRun<T> {
  const list = Array.isArray(failures) ? failures : [failures];
  const fired: string[] = [];
  const patchable = fs as unknown as Record<PatchableFsCall, (...args: unknown[]) => unknown>;
  const originals = new Map<PatchableFsCall, (...args: unknown[]) => unknown>();

  const selects = (failure: FsFailure, target: string): boolean =>
    typeof failure.when === "string"
      ? path.resolve(target) === path.resolve(failure.when)
      : failure.when(target);

  try {
    for (const call of new Set(list.flatMap((failure) => failure.calls))) {
      const original = patchable[call];
      originals.set(call, original);
      const patched = (...args: unknown[]) => {
        for (const failure of list) {
          if (!failure.calls.includes(call)) continue;
          for (const arg of args.slice(0, PATH_ARGUMENTS[call])) {
            if (typeof arg !== "string" || !selects(failure, arg)) continue;
            fired.push(`${call} ${arg}`);
            throw injectedError(failure, call, arg);
          }
        }
        return original(...args);
      };
      // Some of these carry extra properties (`realpathSync.native`); the patch keeps them.
      patchable[call] = Object.assign(patched, original);
    }
    return { result: run(), fired };
  } finally {
    for (const [call, original] of originals) patchable[call] = original;
  }
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
    env: {
      COMPOSABLE_SKILLS_HOME: home,
      HOME: osHome,
      XDG_CONFIG_HOME: path.join(osHome, ".config"),
    },
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
  Object.defineProperty(stream, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
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

/**
 * The same reason `captureDir()` avoids `fs.mkdirSync`: one test patches `fs.openSync` to record
 * every path a build opens — the log and the stamp are opened rather than written by path — and
 * these two descriptors are the fixture's own, not the build's. Bound at load, so no patch a test
 * installs around a verb can see them.
 */
const openCaptureFile = fs.openSync;

function openCapture(routing: StreamRouting): Capture {
  const dir = captureDir();
  const stem = path.join(dir, `run-${captureSeq++}`);
  const outPath = `${stem}-stdout`;
  const errPath = routing === "shared" ? outPath : `${stem}-stderr`;
  // Two open file descriptions on one path share `dev`/`ino`; two paths do not. That is exactly
  // the distinction `emitReport` makes, so the fixture makes it with real descriptors.
  return {
    outFd: openCaptureFile(outPath, "a"),
    errFd: openCaptureFile(errPath, "a"),
    outPath,
    errPath,
  };
}

/**
 * Runs one verb with fds 1 and 2 pointed at real files, so `emitReport`'s one-destination rule is
 * exercised against real descriptors rather than a faked `isTTY`. Shared by every verb, so a test
 * of `init` or `override` is as invocation-independent as a test of `build`.
 *
 * **This whole function is inside any `fs` patch a test has installed around a verb**, and it does
 * its own I/O throughout: `mkdtempSync`/`existsSync` for the capture directory, `openCaptureFile`
 * for the two descriptors, `writeSync` on every captured write, `closeSync` on the way out, and
 * `readFileSync` on the capture files *after* the run but still inside the patch window. A patch
 * that throws unconditionally therefore breaks the fixture, not the code under test, and the
 * failure looks like it came from `src/`. Patch through `withFsFailures()` above, which selects by
 * path and so never touches a capture file. Do not move the read out of the window to work around
 * this: when the capture files are read is part of what the stdout assertions are pinned to.
 */
function captured(
  routing: StreamRouting,
  run: () => number,
  homedir: string | null = null,
): BuildRun {
  const writes: StreamWrite[] = [];
  const capture = openCapture(routing);

  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  // A config-less fixture must not discover a real checkout or config above its temporary
  // directory. Keep discovery inside the fixture while preserving its own ancestor layouts.
  const outsideDiscovery = new Set<string>();
  if (homedir !== null) {
    let ancestor = path.dirname(path.dirname(homedir));
    for (;;) {
      for (const name of [".git", "composable-skills.jsonc", "composable-skills.json"]) {
        outsideDiscovery.add(path.join(ancestor, name));
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  const outside = (candidate: unknown): boolean =>
    typeof candidate === "string" && outsideDiscovery.has(path.resolve(candidate));
  const originalExists = fs.existsSync;
  const originalStat = fs.statSync;
  const restore = [
    force(fs, "existsSync", (candidate: fs.PathLike) =>
      outside(candidate) ? false : originalExists(candidate),
    ),
    force(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
      if (outside(args[0])) {
        const missing: NodeJS.ErrnoException = new Error("outside the test workspace");
        missing.code = "ENOENT";
        throw missing;
      }
      return originalStat(...args);
    }),
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
 * A call the child is made to throw from, before `src/cli.ts` loads, so that a verb crashes the
 * way `main()`'s last-resort catch blocks assume something one day will.
 *
 * It is injected rather than arranged out of a workspace's contents because it cannot be arranged
 * out of one: every `fs` call a verb makes is already inside a guard that turns the failure into a
 * diagnostic, which is what fail-soft means, so nothing on disk reaches those catch blocks. What
 * reaches them is a call nobody expected to fail — so that is what is broken here. Both of these
 * can genuinely fail: `process.cwd()` throws `ENOENT` once the working directory has been removed
 * out from under the process, and `os.hostname()` is a syscall like any other.
 *
 * There are two because they break different verbs at different depths. `process.cwd()` is the
 * first thing every verb touches — the CLI passes no `cwd`, so each defaults to it — and it takes
 * `crashStateDir()` down with it, which is the crash whose own cause has removed the ground the
 * crash *report* would stand on. `os.hostname()` is reached only by `build`, in the lock, deep
 * enough that the config has loaded and the log file has somewhere to go.
 *
 * `withFsFailures()` is no use here: a patch installed in this process does not cross into a
 * spawned one, and the CLI can only be observed in a spawned one.
 */
export type BrokenCall = "process.cwd" | "os.hostname";

export interface CliOptions {
  breaks?: BrokenCall[];
}

function breakCall(call: BrokenCall): string {
  const message = `injected by the test fixture, ${call} failed`;
  const thrower =
    `() => { const failure: NodeJS.ErrnoException = new Error(${JSON.stringify(message)}); ` +
    'failure.code = "ENOENT"; throw failure; }';
  return call === "process.cwd"
    ? `(process as unknown as { cwd: () => string }).cwd = ${thrower};`
    : `(os as unknown as { hostname: () => string }).hostname = ${thrower};`;
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
export function cli(ws: Workspace, args: string[], options: CliOptions = {}): CliRun {
  const shim = path.join(tempDir(), "cli-shim.ts");
  const cliPath = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
  fs.writeFileSync(
    shim,
    [
      'import os from "node:os";',
      `const home = ${JSON.stringify(ws.osHome)};`,
      "(os as unknown as { homedir: () => string }).homedir = () => home;",
      ...(options.breaks ?? []).map(breakCall),
      `await import(${JSON.stringify(cliPath)});`,
      "",
    ].join("\n"),
    "utf8",
  );
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, "run", shim, ...args],
    cwd: ws.repo,
    /**
     * `HOME` is redirected to `ws.osHome`, which sits inside the tree the snapshot assertions
     * walk -- so bun's own runtime transpiler cache lands in `os-home/.bun/install/cache/@t@/`
     * and reads as a write the verb under test made. `"0"` disables that cache for the child.
     *
     * It has to be disabled rather than filtered out of the snapshot: `~` is a place the verbs
     * genuinely write (`~/.claude/settings.json`, a `~/.claude/skills` target), so a snapshot
     * that learned to skip parts of `os-home` would stop proving the thing it exists to prove.
     *
     * Bun 1.4.2 writes this cache and 1.3.14 does not, which is why the suite passed locally and
     * failed on CI, where `oven-sh/setup-bun` installs the latest release.
     */
    env: { ...ws.env, PATH: process.env.PATH ?? "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
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
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
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
