import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
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
const OWNER_MARKER = ".composable-skills-owner";
const STALE_SCRATCH_MS = 60 * 60 * 1000;

/** The `id` the fixture's default config declares — what a marker has to name to be this repo's. */
const OWN_ID = "acme";

/**
 * The marker `emitSkill` writes into every directory it creates, scratch directories included,
 * spelled out here for the same reason the prefixes are. Planting one is what makes a scratch
 * directory *somebody's*, which is half of what the sweep now asks: age alone says a directory is
 * finished with, not whose it was, and a shared target holds other repos' scratch too.
 */
function markScratch(directory: string, skill: string, id: string = OWN_ID): void {
  fs.writeFileSync(
    path.join(directory, OWNER_MARKER),
    `${JSON.stringify({ tool: "composable-skills", skill, id })}\n`,
    "utf8",
  );
}

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
  test("a back-dated tmp- staging directory this repo left behind is removed by the next build", () => {
    const ws = builtWorkspace();
    const abandoned = path.join(targetDir(ws), `${TMP_PREFIX}s-abandoned`);
    fs.mkdirSync(abandoned);
    markScratch(abandoned, "s");
    fs.writeFileSync(path.join(abandoned, "SKILL.md"), "half a file\n", "utf8");
    backdate(abandoned, 2 * STALE_SCRATCH_MS);
    expect(mtimeAgeOf(abandoned)).toBeGreaterThan(STALE_SCRATCH_MS);

    const run = rebuild(ws);

    expect(fs.existsSync(abandoned)).toBe(false);
    // Sweeping leftovers is housekeeping, not news: `removeQuietly` says nothing either way.
    expect(run.stdout).not.toContain(path.basename(abandoned));
  });

  /**
   * The complement, and the reason the window exists at all: a `tmp-` directory that appeared a
   * moment ago is most likely a concurrent build's staging area, mid-swap.
   *
   * It is marked, and marked as *this* repo's, so that the age gate is the only thing standing
   * between it and `removeQuietly`. The sweep asks two questions now, and a plant that fails the
   * ownership one is spared for a reason this test is not about — it would survive a `pruneTarget`
   * that had no staleness window left in it at all. Two builds of one repo overlap often enough
   * that this is also the commonest real form of the case.
   */
  test("a freshly created tmp- staging directory is left alone", () => {
    const ws = builtWorkspace();
    const inFlight = path.join(targetDir(ws), `${TMP_PREFIX}s-a-concurrent-build`);
    fs.mkdirSync(inFlight);
    markScratch(inFlight, "s");
    fs.writeFileSync(path.join(inFlight, "SKILL.md"), "a concurrent build's staging\n", "utf8");

    rebuild(ws);

    expect(fs.existsSync(inFlight)).toBe(true);
    expect(read(ws.repo, `${TARGET}/${path.basename(inFlight)}/SKILL.md`)).toBe(
      "a concurrent build's staging\n",
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

    // Stand-in for a compiled skill that has sat in the target since the last session. Its marker
    // goes in here, before the rename, because that is where a parked copy's marker comes from:
    // `swapIntoPlace` parks the emitted directory itself, marker and all, so the marker naming `s`
    // is the one `emitSkill` wrote into `s` — nothing writes a marker into an `-old-` name.
    const previousOutput = path.join(targetDir(ws), "compiled-a-while-ago");
    fs.mkdirSync(previousOutput);
    markScratch(previousOutput, "s");
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
    markScratch(parked, "s");
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
   * target. What is planted is a concurrent build's parked copy, mid-swap, in a target it shares —
   * marked, as the copy `swapIntoPlace` parks always is, so that what decides its fate here is the
   * time read out of the name and not the attribution the sweep asks for first.
   */
  test("a copy parked under a name the build itself wrote survives the next sweep", () => {
    const ws = builtWorkspace();

    const parked: string[] = [];
    withFsFailures({ calls: ["renameSync"], when: recordParkedNames(parked) }, () => rebuild(ws));
    expect(parked).toHaveLength(1);

    const concurrent = path.join(targetDir(ws), parked[0] ?? "");
    fs.mkdirSync(concurrent);
    markScratch(concurrent, "s");
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
    markScratch(oldFormat, "s");
    fs.writeFileSync(path.join(oldFormat, "SKILL.md"), "written by the previous version\n", "utf8");
    backdate(oldFormat, 2 * STALE_SCRATCH_MS);

    rebuild(ws);

    expect(fs.existsSync(oldFormat)).toBe(false);
  });

  /**
   * **Finding 18.** The sweep used to remove any sufficiently old entry under either prefix with
   * no ownership check at all, which made it a destructive operation on directories this build
   * never wrote — and `tool-contract.md` says pruning is the only one of those the tool performs,
   * gated on a marker that names *this* build. The case is the one the contract blesses: two repos
   * sharing `~/.claude/skills`. A build of the other repo killed between `swapIntoPlace`'s two
   * renames leaves the only copy of its last good output parked under an `-old-` name, and an hour
   * later this repo's build deleted it.
   */
  test("a stale copy another repo parked in a shared target is left alone", () => {
    const ws = builtWorkspace();
    const theirs = path.join(
      targetDir(ws),
      `${OLD_PREFIX}s-${suffixMadeAt(Date.now() - 2 * STALE_SCRATCH_MS)}`,
    );
    fs.mkdirSync(theirs);
    markScratch(theirs, "s", "some-other-repo");
    fs.writeFileSync(path.join(theirs, "SKILL.md"), "the other repo's output\n", "utf8");

    rebuild(ws);

    expect(fs.existsSync(theirs)).toBe(true);
    expect(read(ws.repo, `${TARGET}/${path.basename(theirs)}/SKILL.md`)).toBe(
      "the other repo's output\n",
    );
  });

  /**
   * The conservative half of the same rule. A scratch directory carrying no marker cannot be
   * attributed to anyone, and "I cannot tell whose this is" is not a licence to delete it — the
   * cost of leaving one is a directory entry, and the cost of removing it is somebody else's only
   * copy. `emitSkill` writes the marker into a staging directory before anything else precisely so
   * that this case stays rare.
   */
  test("a stale scratch directory carrying no marker at all is left alone", () => {
    const ws = builtWorkspace();
    const anonymous = path.join(targetDir(ws), `${TMP_PREFIX}s-nobodys`);
    fs.mkdirSync(anonymous);
    fs.writeFileSync(path.join(anonymous, "SKILL.md"), "whose is this?\n", "utf8");
    backdate(anonymous, 2 * STALE_SCRATCH_MS);

    rebuild(ws);

    expect(fs.existsSync(anonymous)).toBe(true);
  });

  /**
   * The marker and the name have to agree, which is the scratch spelling of `readMarker`'s rule
   * that a marker names the directory it sits in. Without it a marker copied out of any owned
   * skill directory into any `-tmp-`/`-old-` name would hand this build the right to delete it.
   */
  test("a marker naming a different skill than the scratch name does is not attribution", () => {
    const ws = builtWorkspace();
    const mismatched = path.join(
      targetDir(ws),
      `${OLD_PREFIX}s-${suffixMadeAt(Date.now() - 2 * STALE_SCRATCH_MS)}`,
    );
    fs.mkdirSync(mismatched);
    markScratch(mismatched, "a-different-skill");
    fs.writeFileSync(path.join(mismatched, "SKILL.md"), "not what the name says\n", "utf8");

    rebuild(ws);

    expect(fs.existsSync(mismatched)).toBe(true);
  });

  /**
   * What keeps the rule above from turning every interrupted build into permanent litter: the
   * marker is the first thing `emitSkill` puts in a staging directory, so a build that dies while
   * copying extras still leaves something the next sweep can attribute. Written after the content
   * it would be the one file an abandoned staging directory lacked.
   */
  test("a staging directory is marked before any content is written into it", () => {
    const ws = workspace({
      repoFiles: {
        "templates/s/SKILL.md.tmpl": skillTemplate("One."),
        "templates/s/notes.md": "Notes.\n",
      },
    });

    const intoStaging: string[] = [];
    const recordStagedNames = (candidate: string): boolean => {
      if (path.basename(path.dirname(candidate)).startsWith(TMP_PREFIX)) {
        intoStaging.push(path.basename(candidate));
      }
      return false;
    };
    const { result: run, fired } = withFsFailures(
      { calls: ["writeFileSync", "copyFileSync"], when: recordStagedNames },
      () => build(ws),
    );

    expect(fired).toEqual([]);
    expect(run.code).toBe(0);
    expect(intoStaging[0]).toBe(OWNER_MARKER);
    expect(intoStaging).toContain("SKILL.md");
    expect(intoStaging).toContain("notes.md");
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
  /** `src/lock.ts`'s staleness window, spelled out here as the prefixes above are. */
  const LOCK_STALE_MS = 5 * 60 * 1000;

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
   * **Finding 13.** `runBuild` keeps two buckets apart: `live` is recomputed every run, and
   * `diagnostics` is what `writeStamp` persists as the last real build's account of the tree and a
   * gated run replays. Whether a lock could be taken is a fact about *this* run's environment, so
   * recording it in the stamp turned a one-off `EACCES` on the state directory into
   * `[last build] building without a lock` in every report until an input hash changed. The `busy`
   * message beside it was never persisted, and this one is now handled the same way.
   */
  test("the lock-unavailable warning is not replayed by later gated runs", () => {
    const ws = lockWorkspace();
    const lockDir = path.join(ws.repo, STATE, "lock");

    const { result: unlocked, fired } = withFsFailures(
      { calls: ["mkdirSync"], when: lockDir, code: "EPERM" },
      () => build(ws),
    );

    expect(fired).toHaveLength(1);
    expect(unlocked.stdout).toContain("building without a lock");
    expect(compiled(ws, "l")).toBe(LOCK_TEMPLATE);
    // The stamp is the record that outlives the run, so it is where the replay would come from.
    expect(read(ws.repo, `${STATE}/stamp`)).not.toContain("building without a lock");

    // Nothing has changed, so this run is gated and says only what the stamp recorded.
    const gated = build(ws, { check: true });

    expect(gated.code).toBe(0);
    expect(gated.stdout).toContain("compiled output is up to date");
    expect(gated.stdout).not.toContain("building without a lock");
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
   * on the `open` of the stamp file puts the re-take at the last write before `runBuild`'s
   * `finally` calls `release()`, without depending on how many syscalls anything issues.
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
      { calls: ["openSync"], when: retakeTheLock },
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

  /**
   * A pid that is certainly not running: a child that has already exited. The number is asserted
   * dead rather than assumed, because the whole point of the two tests below is which side of
   * `processAlive` the lock lands on, and a pid that turned out to be alive would make one of them
   * pass for the wrong reason.
   */
  function deadPid(): number {
    const exited = Bun.spawnSync({ cmd: ["sh", "-c", "exit 0"] });
    const pid = exited.pid;
    expect(() => process.kill(pid, 0)).toThrow();
    return pid;
  }

  /**
   * A lock exactly as a build leaves it, with a holder of the test's choosing. Both clocks are
   * fresh — `at` is now and the directory was made a moment ago — so nothing about age can break
   * it and the holder's pid and host are the only thing left that can.
   */
  function plantLock(ws: Workspace, holder: { pid: number; host: string }): string {
    const lockDir = path.join(ws.repo, STATE, "lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "info.json"),
      `${JSON.stringify({ token: "planted", at: Date.now(), ...holder })}\n`,
      "utf8",
    );
    return lockDir;
  }

  /**
   * The claim name `src/lock.ts` derives for a given lock, spelled out here rather than imported
   * for the same reason the scratch prefixes above are: the point of the protocol is that two
   * builds looking at one stale lock arrive at *one* name, so a test that asked the module for it
   * would only prove the module agrees with itself. Planting this name is what stands in for a
   * build killed between its claim and its `rm`.
   */
  function claimNameFor(lockDir: string): string {
    const entry = fs.lstatSync(lockDir);
    return `${lockDir}.breaking-${entry.ino.toString(36)}-${Math.round(entry.mtimeMs).toString(36)}`;
  }

  /** Every `lock.breaking-…` claim `src/lock.ts` creates while breaking a lock, so a leak shows. */
  function claimsLeftBehind(ws: Workspace): string[] {
    return fs
      .readdirSync(path.join(ws.repo, STATE))
      .filter((entry) => entry.startsWith("lock.breaking-"));
  }

  /**
   * The fast path the module comment in `src/lock.ts` names: "the holder's pid and host recover a
   * crash immediately". A build killed by a crash, an OOM or a `^C` leaves its lock behind, and
   * waiting out the five-minute staleness window before touching it would wedge every session
   * started in that window for no reason — the holder is demonstrably gone. Both clocks here are
   * fresh, so the window cannot be what breaks this lock; only the dead pid can.
   */
  test("a lock whose holder died on this machine is broken at once, not after the window", () => {
    const ws = lockWorkspace();
    plantLock(ws, { pid: deadPid(), host: os.hostname() });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("holds the lock");
    expect(compiled(ws, "l")).toBe(LOCK_TEMPLATE);
    // Broken means taken and given back, not merely deleted.
    expect(exists(ws.repo, `${STATE}/lock`)).toBe(false);
    expect(claimsLeftBehind(ws)).toEqual([]);
  });

  /**
   * The guard on that fast path, and the reason it is a conjunct. Pids are only meaningful on the
   * machine that issued them, and a shared checkout — a network home, a container mount, a VM
   * sharing a folder with its host — is the ordinary way two machines build one repo. Asking
   * whether pid 4242 is alive *here* says nothing about the build holding this lock over there,
   * and answering "no" would break a lock a live build is still writing under.
   */
  test("a live lock taken on another machine is honoured even where its pid is dead", () => {
    const ws = lockWorkspace();
    const pid = deadPid();
    plantLock(ws, { pid, host: "a-machine-that-is-not-this-one" });

    const run = build(ws);

    expect(run.code).toBe(0);
    expect(hasWarning(run)).toBe(true);
    expect(run.stdout).toContain(
      `another build holds the lock (pid ${pid} on a-machine-that-is-not-this-one)`,
    );
    // Nothing was built, and the other machine's lock is exactly where it left it.
    expect(exists(ws.repo, `${TARGET}/l`)).toBe(false);
    expect(read(ws.repo, `${STATE}/lock/info.json`)).toContain("planted");
    expect(claimsLeftBehind(ws)).toEqual([]);
  });

  /**
   * **Finding 20.** Breaking a stale lock used to be `rm` followed, on the next pass round the
   * loop, by an unguarded `mkdir`. Between those two syscalls there is no lock at all, so two
   * builds that judged the *same* stale lock stale both removed it and both created one, and both
   * then believed they held it — the one moment mutual exclusion matters most, since a lock is
   * only ever left behind by a crash or a reboot, which is also when several sessions start at
   * once. Taking the right to break first, with a `mkdir` of a claim named after the lock being
   * broken, is what makes the two syscalls one decision.
   *
   * The second build is run from inside the first one's `rm` of the stale lock — the exact instant
   * the old code left open. The hook is keyed on the path, injects nothing and returns false, so
   * `fired` stays empty.
   */
  test("a second build arriving mid-break waits rather than taking the lock as well", () => {
    const ws = lockWorkspace();
    const lockDir = plantLock(ws, { pid: deadPid(), host: os.hostname() });

    const racers: BuildRun[] = [];
    const raceTheBreak = (target: string): boolean => {
      if (target !== lockDir || racers.length > 0) return false;
      racers.push(build(ws));
      return false;
    };

    const { result: first, fired } = withFsFailures({ calls: ["rmSync"], when: raceTheBreak }, () =>
      build(ws),
    );

    expect(fired).toEqual([]);
    expect(racers).toHaveLength(1);
    expect(racers[0]?.stdout ?? "").toContain("another build holds the lock");
    expect(racers[0]?.code).toBe(0);
    expect(first.code).toBe(0);
    // One build compiled, and the claim it took to do so is not litter.
    expect(compiled(ws, "l")).toBe(LOCK_TEMPLATE);
    expect(exists(ws.repo, `${STATE}/lock`)).toBe(false);
    expect(claimsLeftBehind(ws)).toEqual([]);
  });

  /**
   * **Finding 20, the other half.** The claim is created before the stale lock is touched and
   * removed in a `finally`, so a build killed between those two points leaves one behind — and if
   * the kill landed *before* the `rm`, the stale lock survives with the same inode and the same
   * mtime. Every later build therefore derives this same claim name, hits `EEXIST` on it, and
   * reports busy: a wedge with no way out but `rm -rf` by hand, which nothing in the tool sweeps
   * and which the rm-then-mkdir code this replaced could not produce. `tool-contract.md` forbids
   * it in as many words — "a build can never wedge permanently".
   *
   * A claim only ever legitimately lives across two syscalls, so one this old has no owner, and
   * the run that finds it clears it and still stands off the lock. The recovery is the run after.
   */
  test("a claim left behind by a killed build does not wedge the lock forever", () => {
    const ws = lockWorkspace();
    const leaked = claimNameFor(plantLock(ws, { pid: deadPid(), host: os.hostname() }));
    fs.mkdirSync(leaked);
    backdate(leaked, 2 * LOCK_STALE_MS);

    const blocked = build(ws);

    expect(blocked.code).toBe(0);
    expect(blocked.stdout).toContain("another build holds the lock");
    expect(fs.existsSync(leaked)).toBe(false);
    expect(exists(ws.repo, `${TARGET}/l`)).toBe(false);

    const recovered = build(ws);

    expect(recovered.code).toBe(0);
    expect(recovered.stdout).not.toContain("holds the lock");
    expect(compiled(ws, "l")).toBe(LOCK_TEMPLATE);
    expect(exists(ws.repo, `${STATE}/lock`)).toBe(false);
    expect(claimsLeftBehind(ws)).toEqual([]);
  });
});
