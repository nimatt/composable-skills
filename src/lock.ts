import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config } from "./types.ts";
import { describe } from "./types.ts";
import { stateDir } from "./layout.ts";
import { removeQuietly, uniqueSuffix } from "./fsutil.ts";

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
 * `mkdir` is the atomic primitive available on every platform this tool supports (`flock` is
 * absent on macOS). A build that dies takes its lock with it, so the lock always carries enough
 * to be broken: the holder's pid and host recover a crash immediately, and a timestamp recovers
 * the cases pid liveness cannot see — a reboot, or a holder on another machine.
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
    fs.mkdirSync(stateDir(config.repoRoot), { recursive: true });
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
      if (attempt === 0 && lockIsStale(directory)) {
        removeQuietly(directory);
        continue;
      }
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
    parsed = JSON.parse(fs.readFileSync(path.join(directory, LOCK_INFO_FILENAME), "utf8"));
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
 * The lock directory's own mtime is the reading the holder does not write, so it is what a forged
 * or clock-skewed `at` is checked against. A timestamp in the future would otherwise never age
 * out — a lock that survives a reboot is exactly what "a build can never wedge permanently"
 * forbids — so `at` is clamped to now and either clock alone may declare the lock dead.
 */
function lockIsStale(directory: string): boolean {
  const byDirectory = directoryLooksStale(directory);
  const holder = readLockInfo(directory);
  if (holder === null) return byDirectory;
  if (holder.host === os.hostname() && !processAlive(holder.pid)) return true;
  return Date.now() - Math.min(holder.at, Date.now()) > LOCK_STALE_MS || byDirectory;
}

function directoryLooksStale(directory: string): boolean {
  let age: number;
  try {
    age = Date.now() - fs.lstatSync(directory).mtimeMs;
  } catch {
    return true;
  }
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
