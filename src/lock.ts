import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config } from "./types.ts";
import { describe } from "./types.ts";
import { stateDir } from "./layout.ts";
import {
  ensureRealDir,
  pathExists,
  readRegularFile,
  removeQuietly,
  uniqueSuffix,
} from "./fsutil.ts";

const LOCK_DIRNAME = "lock";
const LOCK_INFO_FILENAME = "info.json";
/** A build that has held the lock this long is assumed dead; the machine reboots mid-build too. */
const LOCK_STALE_MS = 5 * 60 * 1000;

type LockResult =
  | { kind: "held"; release: () => void }
  | { kind: "busy"; message: string }
  | { kind: "unavailable"; message: string };

interface LockInfo {
  token: string;
  pid: number;
  host: string;
  at: number;
}

/**
 * `mkdir` is the lock primitive: creating a directory either succeeds or fails `EEXIST`, which is
 * the classic atomic test-and-set, and it is the one this tool can rely on across the filesystems
 * and runtimes it targets — including over NFS, where advisory locking depends on a lock daemon
 * that need not be running. Node's `fs` exposes no `flock(2)` at all, on any platform, so an
 * advisory lock would mean a native addon.
 *
 * A build that dies takes its lock with it, so the lock always carries enough to be broken: the
 * holder's pid and host recover a crash immediately, and a timestamp recovers the cases pid
 * liveness cannot see — a reboot, or a holder on another machine.
 */
export function acquireBuildLock(config: Config): LockResult {
  const directory = path.join(stateDir(config.repoRoot), LOCK_DIRNAME);
  const token = uniqueSuffix();

  /**
   * Kept apart from the lock `mkdir` on purpose. A recursive `mkdir` throws `EEXIST` when the path
   * exists as a *regular file*, so a `.composable-skills` file made the state directory's failure
   * indistinguishable from "the lock is held" — and every session then reported a lock that did
   * not exist and compiled nothing, forever. Any state-dir failure means the lock cannot be taken
   * at all, which the contract answers by building unlocked.
   */
  try {
    ensureRealDir(stateDir(config.repoRoot));
  } catch (cause) {
    return { kind: "unavailable", message: `building without a lock: ${describe(cause)}` };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        return { kind: "unavailable", message: `building without a lock: ${describe(cause)}` };
      }
      if (attempt === 0 && breakStaleLock(directory)) continue;
      return {
        kind: "busy",
        message: `${describeLockHolder(directory)} — nothing was built this run`,
      };
    }

    const info: LockInfo = { token, pid: process.pid, host: os.hostname(), at: Date.now() };
    try {
      fs.writeFileSync(
        path.join(directory, LOCK_INFO_FILENAME),
        `${JSON.stringify(info)}\n`,
        "utf8",
      );
    } catch {
      // the directory is the lock; its contents only make the lock breakable
    }
    return { kind: "held", release: () => releaseBuildLock(directory, token) };
  }

  return { kind: "busy", message: "another build holds the lock — nothing was built this run" };
}

function releaseBuildLock(directory: string, token: string): void {
  const holder = readLockInfo(directory);
  if (holder !== null && holder.token !== token) return;
  removeQuietly(directory);
}

function readLockInfo(directory: string): LockInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readRegularFile(path.join(directory, LOCK_INFO_FILENAME)).bytes.toString("utf8"),
    );
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["token"] !== "string" || typeof record["host"] !== "string") return null;
  if (typeof record["pid"] !== "number" || typeof record["at"] !== "number") return null;
  return { token: record["token"], pid: record["pid"], host: record["host"], at: record["at"] };
}

/**
 * Removing a stale lock and creating a fresh one are two syscalls, and between them the lock does
 * not exist. Two builds that judge the *same* lock stale would both remove it, both `mkdir`, and
 * both believe they hold it — and that is not a theoretical race: a lock is left behind by a crash
 * or a reboot, which is exactly when several sessions start at once.
 *
 * So the *right to break* is taken before the lock is touched, with the same primitive as the lock
 * itself: `mkdir` of a directory whose name is derived from the lock being broken, so that two
 * builds looking at one stale lock derive one name and only one of them can create it. It is the
 * same test-and-set the lock itself rests on, for the reasons given in the header; `rename` is not
 * a substitute, because the loser of a rename race renames the *winner's fresh lock* aside and the
 * two hold it concurrently again.
 *
 * The identity is the lock directory's inode and mtime rather than the token in `info.json`,
 * because a holder that died between its `mkdir` and its info write leaves no token and is the
 * case most in need of breaking. The lock is re-read once the claim is held, since a build can win
 * the claim just after an earlier breaker took the lock, and what it re-reads then is a different
 * lock that must not be broken.
 *
 * The claim is removed in a `finally`, so the only way one outlives its build is a kill inside the
 * two syscalls it spans — and that kill lands on one of two sides. Killed *after* the lock was
 * removed, the leftover is already inert: a later lock would have to reuse the same inode with the
 * same mtime to the millisecond for any build to derive its name again. Killed *before*, the stale
 * lock survives with that same inode and that same mtime, so every later build derives exactly this
 * name, hits `EEXIST` on it, and reports busy — permanently, which is the one thing the contract
 * says a build may never do. That half is what `ageOutLeakedClaim` closes.
 */
function breakStaleLock(directory: string): boolean {
  const identity = staleLockIdentity(directory);
  // Either the lock is alive and this build waits, or it has already gone and the retried `mkdir`
  // is the whole of taking it.
  if (identity === null) return !pathExists(directory);

  const claim = `${directory}.breaking-${identity}`;
  try {
    fs.mkdirSync(claim);
  } catch {
    // Another build is breaking this same lock. Whichever of the two wins the claim ends up
    // holding the lock, so this one has nothing left to do but report it held.
    ageOutLeakedClaim(claim);
    return false;
  }
  try {
    if (staleLockIdentity(directory) !== identity) return !pathExists(directory);
    removeQuietly(directory);
    return true;
  } finally {
    removeQuietly(claim);
  }
}

/**
 * A claim is held across two syscalls, so one that is minutes old has no owner left: it is the
 * leftover of a build killed before it removed the lock, and it would otherwise turn that one
 * stale lock into a permanent one. Removing it here and still reporting busy — rather than
 * breaking the lock in the same breath — is deliberate: the removal is not a claim on anything,
 * and the *next* run takes the claim cleanly and breaks the lock through the ordinary path.
 *
 * The threshold is the lock's own staleness window, and the asymmetry is why it is not shorter.
 * Too short, and a claim whose owner is merely descheduled gets removed out from under it; a
 * second breaker then enters the window the claim exists to close, and the stalled owner wakes up
 * and removes the winner's *fresh* lock — the concurrent-holder bug, back again. Too long only
 * postpones recovery from a kill landing in a two-syscall window, and by one run. Five minutes is
 * already the point at which a build still *holding* the lock is presumed dead, so a claim that
 * old is beyond any doubt, and it leaves one number to tune instead of two.
 */
function ageOutLeakedClaim(claim: string): void {
  try {
    if (directoryLooksStale(fs.lstatSync(claim))) removeQuietly(claim);
  } catch {
    // the claim was removed by its owner, or by another build doing exactly this
  }
}

/**
 * The name two builds looking at one stale lock must both derive, and null for a lock that is
 * alive — or that cannot be read at all, which is not this build's to delete blindly.
 */
function staleLockIdentity(directory: string): string | null {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(directory);
  } catch {
    return null;
  }
  if (!lockIsStale(directory, entry)) return null;
  return `${entry.ino.toString(36)}-${Math.round(entry.mtimeMs).toString(36)}`;
}

/**
 * The lock directory's own mtime is the reading the holder does not write, so it is what a forged
 * or clock-skewed `at` is checked against. A timestamp in the future would otherwise never age
 * out — a lock that survives a reboot is exactly what "a build can never wedge permanently"
 * forbids — so `at` is clamped to now and either clock alone may declare the lock dead.
 */
function lockIsStale(directory: string, entry: fs.Stats): boolean {
  const byDirectory = directoryLooksStale(entry);
  const holder = readLockInfo(directory);
  if (holder === null) return byDirectory;
  if (holder.host === os.hostname() && !processAlive(holder.pid)) return true;
  return Date.now() - Math.min(holder.at, Date.now()) > LOCK_STALE_MS || byDirectory;
}

function directoryLooksStale(entry: fs.Stats): boolean {
  const age = Date.now() - entry.mtimeMs;
  // A future mtime is a clock that jumped or a file that was written to lie; either way the
  // directory dates nothing, and refusing to break it is the failure with no recovery.
  return age > LOCK_STALE_MS || age < -LOCK_STALE_MS;
}

function describeLockHolder(directory: string): string {
  const holder = readLockInfo(directory);
  if (holder === null) return "another build holds the lock";
  return `another build holds the lock (pid ${holder.pid} on ${holder.host})`;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}
