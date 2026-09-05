import crypto from "node:crypto";
import fs from "node:fs";

export function isMissing(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function pathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

export function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // leftover scratch costs nothing but a directory entry
  }
}

/**
 * The tail every scratch directory's name carries, which is also the only place its creation time
 * can be recorded. `rename(2)` preserves `mtime` *and* `birthtime` — same inode — so a directory
 * parked by a swap inherits the timestamps of the compiled output it was made from and reads as
 * hours old the instant it is created. The name is the one clock a rename cannot rewind.
 *
 * The time goes last, behind a `t`, because these suffixes are appended to names that embed a
 * skill name, and a skill name may contain `-`. The previous format ended in eight hex digits,
 * which can never begin with `t`, so a name from either format is read without having to guess
 * where the skill name stops.
 */
export function uniqueSuffix(): string {
  const random = crypto.randomBytes(4).toString("hex");
  return `${process.pid.toString(36)}-${random}-t${Date.now().toString(36)}`;
}

const CREATED_AT_RE = /-t([0-9a-z]{1,12})$/;

/**
 * Null for a name written before the timestamp existed, which the caller must read as "ask the
 * filesystem" rather than as "created just now": a scratch directory that can never look old is
 * never swept, and would sit in every shared target for as long as the directory itself does.
 */
export function createdAtFromName(name: string): number | null {
  const digits = CREATED_AT_RE.exec(name)?.[1];
  if (digits === undefined) return null;
  const created = Number.parseInt(digits, 36);
  return Number.isSafeInteger(created) ? created : null;
}
