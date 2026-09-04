import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  build,
  cleanup,
  compiled,
  exists,
  hasWarning,
  occurrences,
  read,
  withFsFailures,
  workspace,
  write,
} from "./fixtures/workspace.ts";
import type { BuildRun, Workspace } from "./fixtures/workspace.ts";

afterEach(cleanup);

/**
 * Spelled out rather than imported from `src/emit.ts`. These prefixes are what the tool leaves
 * lying in somebody's `~/.claude/skills`, so they are a fact about the on-disk layout that a test
 * should pin independently — importing them would make any renaming of them agree with itself.
 * `suffixMadeAt` spells out the rest of that layout for the same reason: `uniqueSuffix()` in
 * `src/fsutil.ts` is where a scratch directory's creation time is written, and the sweep is the
 * only thing that reads it back.
 */
const TMP_PREFIX = ".composable-skills-tmp-";
const OLD_PREFIX = ".composable-skills-old-";
const STALE_SCRATCH_MS = 60 * 60 * 1000;

function suffixMadeAt(when: number): string {
  return `1a2b-deadbeef-t${when.toString(36)}`;
}

/**
 * `suffixMadeAt` read back: the creation time a scratch directory's name records, or null for a
 * name that records none. Every test below that *writes* a name uses the first; the two that pin
 * `uniqueSuffix()` itself use this one, because a name the build produced is only worth asserting
 * on if something can be read out of it.
 */
function createdAtIn(name: string): number | null {
  const digits = /-t([0-9a-z]+)$/.exec(name)?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 36);
}

const TARGET = ".claude/skills";
const STATE = ".composable-skills";

function skillTemplate(body: string): string {
  return `---\nname: s\n---\n\n${body}\n`;
}

function targetDir(ws: Workspace): string {
  return path.join(ws.repo, ...TARGET.split("/"));
}

/** The reading `isStaleScratch` in `src/emit.ts` falls back to: `mtimeMs` compared against now. */
function backdate(directory: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(directory, when, when);
}

function mtimeAgeOf(directory: string): number {
  return Date.now() - fs.lstatSync(directory).mtimeMs;
}

/** How long ago the inode was last *moved or relinked* — what `rename(2)` updates and mtime is not. */
function ctimeAgeOf(directory: string): number {
  return Date.now() - fs.lstatSync(directory).ctimeMs;
}

function builtWorkspace(): Workspace {
  const ws = workspace({ repoFiles: { "templates/s/SKILL.md.tmpl": skillTemplate("One.") } });
  const first = build(ws);
  expect(first.code).toBe(0);
  expect(compiled(ws, "s")).toBe(skillTemplate("One."));
  return ws;
}

/**
 * A second build that actually reaches the sweep. `runBuild` returns on a fresh stamp long
 * before `pruneTarget`, so a rerun over an unchanged corpus would leave every scratch directory
 * in place and prove nothing; the template has to change for the target to be swept at all.
 */
function rebuildWith(ws: Workspace, body: string): BuildRun {
  write(ws.repo, { "templates/s/SKILL.md.tmpl": skillTemplate(body) });
  const run = build(ws);
  expect(run.code).toBe(0);
  expect(compiled(ws, "s")).toBe(skillTemplate(body));
  return run;
}

function rebuild(ws: Workspace): BuildRun {
  return rebuildWith(ws, "Two.");
}

/**
 * Collects the names `swapIntoPlace` parks live output under, from a build that really performs a
 * swap. The parked copy exists only between the two renames and is removed before the build
 * returns, so nothing on disk afterwards records what it was called; a `withFsFailures` predicate
 * is the one path-keyed hook that runs inside a build. It injects nothing — it always returns
 * false — so `fired` stays empty and the build proceeds exactly as it would unwatched.
 */
function recordParkedNames(into: string[]): (candidate: string) => boolean {
  return (candidate: string) => {
    const name = path.basename(candidate);
    if (name.startsWith(OLD_PREFIX)) into.push(name);
    return false;
  };
}

describe("the scratch sweep", () => {
  test("a back-dated tmp- staging directory is removed by the next build", () => {
    const ws = builtWorkspace();
    const abandoned = path.join(targetDir(ws), `${TMP_PREFIX}s-abandoned`);
    fs.mkdirSync(abandoned);
    fs.writeFileSync(path.join(abandoned, "SKILL.md"), "half a file\n", "utf8");
    backdate(abandoned, 2 * STALE_SCRATCH_MS);
    expect(mtimeAgeOf(abandoned)).toBeGreaterThan(STALE_SCRATCH_MS);

    const run = rebuild(ws);

    expect(fs.existsSync(abandoned)).toBe(false);
    // Sweeping leftovers is housekeeping, not news: `removeQuietly` says nothing either way.
    expect(run.stdout).not.toContain(path.basename(abandoned));
  });

  // The complement, and the reason the window exists at all: a `tmp-` directory that appeared a
  // moment ago is most likely another build's staging area, mid-swap.
  test("a freshly created tmp- staging directory is left alone", () => {
    const ws = builtWorkspace();
    const inFlight = path.join(targetDir(ws), `${TMP_PREFIX}s-a-concurrent-build`);
    fs.mkdirSync(inFlight);
    fs.writeFileSync(path.join(inFlight, "SKILL.md"), "somebody else's staging\n", "utf8");

    rebuild(ws);

    expect(fs.existsSync(inFlight)).toBe(true);
    expect(read(ws.repo, `${TARGET}/${path.basename(inFlight)}/SKILL.md`)).toBe(
      "somebody else's staging\n",
    );
  });

  /**
   * **Finding 10, fixed.** `isStaleScratch` used to date a parked rollback copy by its `mtime`,
   * and `rename(2)` preserves `mtime`. So the copy `swapIntoPlace` parks inherited the age of the
   * output it was made from: a skill whose compiled directory had sat untouched for over an hour —
   * the normal case for a warm repo — was parked and read as stale *the instant it was created*.
   * A concurrent build sweeping the same target then deleted the only copy of another build's last
   * good output while its swap was still in flight, which is precisely what the window in
   * `pruneTarget`'s scratch branch exists to prevent. Reachable, not theoretical: it needs two
   * repos sharing one target, which `tool-contract.md` blesses.
   *
   * Liveness is now carried in the directory *name*, which a rename cannot rewind, so this copy
   * survives its whole hour however old the inode beneath it is.
   *
   * The construction matters as much as the assertion. A plain `mkdir` of an `old-` name gets
   * `mtime = now` and would pass whether or not the name were consulted, proving nothing. The
   * parked directory MUST be built the way `swapIntoPlace` builds one: an older directory renamed
   * into an `OLD_PREFIX` name, so mtime says hours and the name says seconds.
   */
  test("a rollback copy parked seconds ago survives, however old its mtime is", () => {
    const ws = builtWorkspace();

    // Stand-in for a compiled skill that has sat in the target since the last session.
    const previousOutput = path.join(targetDir(ws), "compiled-a-while-ago");
    fs.mkdirSync(previousOutput);
    fs.writeFileSync(path.join(previousOutput, "SKILL.md"), "the last good output\n", "utf8");
    backdate(previousOutput, 2 * STALE_SCRATCH_MS);

    // `swapIntoPlace` parks the live output, then moves staging in. This is that first rename.
    const parked = path.join(targetDir(ws), `${OLD_PREFIX}s-${suffixMadeAt(Date.now())}`);
    fs.renameSync(previousOutput, parked);

    // The two clocks disagree, which is the whole of finding 10: parked moments ago, dated hours.
    expect(ctimeAgeOf(parked)).toBeLessThan(STALE_SCRATCH_MS);
    expect(mtimeAgeOf(parked)).toBeGreaterThan(STALE_SCRATCH_MS);

    rebuild(ws);

    expect(fs.existsSync(parked)).toBe(true);
    expect(read(ws.repo, `${TARGET}/${path.basename(parked)}/SKILL.md`)).toBe(
      "the last good output\n",
    );
  });

  // The complement: the name is a clock, not a reprieve. Once the hour recorded in it has passed,
  // the same directory goes, and a fresh mtime does not save it.
  test("a rollback copy whose name records an old parking is swept", () => {
    const ws = builtWorkspace();
    const parked = path.join(
      targetDir(ws),
      `${OLD_PREFIX}s-${suffixMadeAt(Date.now() - 2 * STALE_SCRATCH_MS)}`,
    );
    fs.mkdirSync(parked);
    fs.writeFileSync(path.join(parked, "SKILL.md"), "long abandoned\n", "utf8");
    expect(mtimeAgeOf(parked)).toBeLessThan(STALE_SCRATCH_MS);

    rebuild(ws);

    expect(fs.existsSync(parked)).toBe(false);
  });

  /**
   * Both tests above build their parked directory out of `suffixMadeAt`, a name *this file*
   * writes, so both pin the reader and neither pins the writer: take the clock back out of
   * `uniqueSuffix()` in `src/fsutil.ts` and they still pass while finding 10 returns whole, since
   * a name with nothing to read sends every parked copy down the mtime fallback the finding is
   * about. The two below take the name from a swap the build really performed.
   *
   * This one pins the property the fix rests on rather than the spelling of the suffix: the name
   * carries a creation time, and that time is when the directory was created and not when its
   * contents were last written. The two are told apart by back-dating the live output first, so
   * the inode going into the rename is hours old while the name has to read as seconds.
   */
  test("the name the build parks a copy under records when it parked it", () => {
    const ws = builtWorkspace();
    const live = path.join(targetDir(ws), "s");
    backdate(live, 2 * STALE_SCRATCH_MS);
    expect(mtimeAgeOf(live)).toBeGreaterThan(STALE_SCRATCH_MS);

    const parked: string[] = [];
    const before = Date.now();
    const { fired } = withFsFailures(
      { calls: ["renameSync"], when: recordParkedNames(parked) },
      () => rebuild(ws),
    );
    const after = Date.now();

    expect(fired).toEqual([]);
    expect(parked).toHaveLength(1);
    const recordedAt = createdAtIn(parked[0] ?? "");
    expect(recordedAt).not.toBeNull();
    expect(recordedAt ?? -1).toBeGreaterThanOrEqual(before);
    expect(recordedAt ?? -1).toBeLessThanOrEqual(after);
  });

  /**
   * And the same survival the parked-seconds-ago test asserts, with the writer in the loop and
   * nothing about the name's shape assumed: the name is the one `swapIntoPlace` really produced,
   * and the mtime is the hours-old one `rename(2)` really leaves on a copy parked out of a warm
   * target. What is planted is another build's parked copy, mid-swap, in a target the two share.
   */
  test("a copy parked under a name the build itself wrote survives the next sweep", () => {
    const ws = builtWorkspace();

    const parked: string[] = [];
    withFsFailures({ calls: ["renameSync"], when: recordParkedNames(parked) }, () => rebuild(ws));
    expect(parked).toHaveLength(1);

    const concurrent = path.join(targetDir(ws), parked[0] ?? "");
    fs.mkdirSync(concurrent);
    fs.writeFileSync(
      path.join(concurrent, "SKILL.md"),
      "the other build's last good output\n",
      "utf8",
    );
    backdate(concurrent, 2 * STALE_SCRATCH_MS);
    expect(mtimeAgeOf(concurrent)).toBeGreaterThan(STALE_SCRATCH_MS);

    rebuildWith(ws, "Three.");

    expect(fs.existsSync(concurrent)).toBe(true);
    expect(read(ws.repo, `${TARGET}/${path.basename(concurrent)}/SKILL.md`)).toBe(
      "the other build's last good output\n",
    );
  });

  /**
   * The migration case, and the reason the mtime path survives at all. Every scratch directory
   * written before the timestamp moved into the name has a name with nothing to read, and reading
   * that as "created just now" would make it immortal — never swept, in every shared target it was
   * ever left in. It ages out by mtime instead, exactly as it did before.
   */
  test("an old-format scratch directory, with no timestamp in its name, still ages out", () => {
    const ws = builtWorkspace();
    // What `uniqueSuffix()` produced before: a base36 pid and eight hex digits, and no clock.
    const oldFormat = path.join(targetDir(ws), `${OLD_PREFIX}s-1a2b-deadbeef`);
    expect(path.basename(oldFormat)).not.toMatch(/-t[0-9a-z]+$/);

    fs.mkdirSync(oldFormat);
    fs.writeFileSync(path.join(oldFormat, "SKILL.md"), "written by the previous version\n", "utf8");
    backdate(oldFormat, 2 * STALE_SCRATCH_MS);

    rebuild(ws);

    expect(fs.existsSync(oldFormat)).toBe(false);
  });
});

/**
 * **Finding 7.** `pruneTarget`'s `readdirSync` used to swallow every errno and return 0, so a
 * target the build could not enumerate was indistinguishable from one holding nothing stale — the
 * same collapse `discoverSkills` makes on a source root, pointed the other way. It now warns on
 * any errno but `ENOENT`, which has to stay silent: a target nothing has been written to yet is
 * the fresh-clone case, and a diagnostic there is replayed from the stamp at every session start.
 */
describe("a target that cannot be enumerated", () => {
  const A = "---\nname: a\n---\n\nAlpha.\n";
  const B = "---\nname: b\n---\n\nBravo.\n";

  test("warns, names the target, and prunes nothing in it", () => {
    const ws = workspace({
      repoFiles: { "templates/a/SKILL.md.tmpl": A, "templates/b/SKILL.md.tmpl": B },
    });
    expect(build(ws).code).toBe(0);
    expect(compiled(ws, "b")).toBe(B);

    // `b` is now orphaned, so a readable target would prune it. An unreadable one must not.
    fs.rmSync(path.join(ws.repo, "templates", "b"), { recursive: true, force: true });
    write(ws.repo, { "templates/a/SKILL.md.tmpl": "---\nname: a\n---\n\nAlpha again.\n" });

    const { result: run, fired } = withFsFailures(
      { calls: ["readdirSync"], when: targetDir(ws), code: "EACCES" },
      () => build(ws),
    );

    expect(fired.length).toBeGreaterThan(0);
    expect(run.code).toBe(0);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(`cannot read target ${targetDir(ws)}`);
    expect(run.stdout).toContain("nothing in it was considered for pruning");
    expect(exists(ws.repo, `${TARGET}/b/SKILL.md`)).toBe(true);
  });

  /**
   * The warning arrives stacked on one `cannot write` error per skill whenever the same permission
   * bit is what broke both, so it has to add something rather than repeat them. It names a
   * different verb, a different path, and the one consequence the per-skill errors do not mention.
   */
  test("reads as its own consequence when every write into that target failed too", () => {
    const ws = workspace({
      repoFiles: { "templates/a/SKILL.md.tmpl": A, "templates/b/SKILL.md.tmpl": B },
    });
    const insideTarget = (candidate: string) => candidate.startsWith(`${targetDir(ws)}${path.sep}`);

    const { result: run } = withFsFailures(
      [
        { calls: ["readdirSync"], when: targetDir(ws), code: "EACCES" },
        { calls: ["mkdirSync"], when: insideTarget, code: "EACCES" },
      ],
      () => build(ws),
    );

    expect(run.code).toBe(0);
    expect(occurrences(run.stdout, "cannot write")).toBe(2);
    expect(occurrences(run.stdout, "cannot read target")).toBe(1);
    expect(run.stdout).toContain("nothing in it was considered for pruning");
  });

  test("a target that does not exist yet says nothing at all", () => {
    const ws = workspace({ repoFiles: { "templates/.keep": "" } });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(exists(ws.repo, TARGET)).toBe(false);
    expect(run.stdout).not.toContain("cannot read target");
  });
});

describe("the build lock's edges", () => {
  const LOCK_TEMPLATE = "---\nname: l\n---\n\nBody.\n";

  function lockWorkspace(): Workspace {
    return workspace({ repoFiles: { "templates/l/SKILL.md.tmpl": LOCK_TEMPLATE } });
  }

  /**
   * The sibling of `test/build.test.ts`'s "a state directory that is a regular file builds
   * unlocked instead of reporting a lock", which reaches the *state directory* arm of
   * `acquireBuildLock` in `src/lock.ts`. This one reaches the arm below it: the lock `mkdir`
   * itself failing with an errno that is not `EEXIST`. Only `EEXIST` means held; everything else
   * means the lock cannot be taken, and the contract answers that by building unlocked rather
   * than by refusing to build.
   */
  test("a lock directory that cannot be created builds unlocked rather than reporting a lock", () => {
    const ws = lockWorkspace();
    const lockDir = path.join(ws.repo, STATE, "lock");

    const { result: run, fired } = withFsFailures(
      { calls: ["mkdirSync"], when: lockDir, code: "EPERM" },
      () => build(ws),
    );

    expect(fired).toHaveLength(1);
    expect(fired[0] ?? "").toContain(path.join(STATE, "lock"));
    expect(run.code).toBe(0);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain("building without a lock");
    expect(run.stdout).not.toContain("holds the lock");
    // Unlocked means unlocked, not degraded: the build does its whole job.
    expect(compiled(ws, "l")).toBe(LOCK_TEMPLATE);
    expect(exists(ws.repo, `${STATE}/lock`)).toBe(false);
    expect(exists(ws.repo, `${STATE}/stamp`)).toBe(true);
  });

  /**
   * `releaseBuildLock` in `src/lock.ts` compares the token in `info.json` against the one this
   * build wrote,
   * and that comparison is the whole defence against a build releasing a lock it no longer holds.
   * The complement — a build that still holds its lock does remove it on the way out — is
   * `test/build.test.ts`'s "broken, and released on the way out".
   *
   * The re-take is staged through `withFsFailures` purely to get a *path-keyed* hook inside the
   * run; the predicate injects nothing and always returns false, so `fired` stays empty. Keying it
   * on the stamp file puts the re-take at the last write before `runBuild`'s `finally` calls
   * `release()`, without depending on how many syscalls anything issues.
   */
  test("a build whose lock was re-taken by another holder leaves the new lock alone", () => {
    const ws = lockWorkspace();
    const lockDir = path.join(ws.repo, STATE, "lock");
    const stampSuffix = path.join(STATE, "stamp");
    const newHolder = {
      token: "the-second-holder",
      pid: 1,
      host: "a-machine-that-is-not-this-one",
      at: Date.now(),
    };

    let retakes = 0;
    const retakeTheLock = (target: string): boolean => {
      if (!target.endsWith(stampSuffix)) return false;
      retakes++;
      // Exactly what a third party that judged this lock stale does: remove the directory,
      // recreate it, and write its own token in. The directory is the lock; the token is who.
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, "info.json"), `${JSON.stringify(newHolder)}\n`, "utf8");
      return false;
    };

    const { result: run, fired } = withFsFailures(
      { calls: ["writeFileSync"], when: retakeTheLock },
      () => build(ws),
    );

    expect(retakes).toBe(1);
    expect(fired).toEqual([]);
    expect(run.code).toBe(0);
    expect(compiled(ws, "l")).toBe(LOCK_TEMPLATE);

    // The new holder's lock survives this build's release, tokens and all.
    expect(exists(ws.repo, `${STATE}/lock`)).toBe(true);
    expect(read(ws.repo, `${STATE}/lock/info.json`)).toContain("the-second-holder");
  });
});
