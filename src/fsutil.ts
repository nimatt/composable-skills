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

/**
 * A directory this tool derived and is about to write files into, which must therefore be the
 * directory itself and not a link standing where it should be. A symlinked `.composable-skills`
 * redirects the log, the stamp and the lock at once — every one of them outside the repo, which
 * invariants 7 and 8 both forbid — so it is refused rather than followed. The `mkdir` comes first
 * because a link to a directory is only visible to `lstat` once there is something at the path at
 * all, and a recursive `mkdir` neither creates nor rewrites what is already there.
 */
export function ensureRealDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`refusing to write through the symlink at ${directory}`);
  }
}

export interface NoFollowWrite {
  handle: number;
  /** Whether a symlink was standing at the path and was removed to get at the real one. */
  removedSymlink: boolean;
}

/**
 * `writeFileSync` follows a symlink standing at its destination and truncates whatever it points
 * at, so a link planted at a path this tool derived — `<state>/build.log`, `<state>/stamp` — would
 * make the build overwrite an arbitrary file anywhere on the disk. The link is unlinked rather
 * than written through, the way a `rename` into place would replace it, and `O_NOFOLLOW` is what
 * closes the window between the two on a kernel that has the flag. A *hard* link planted at the
 * same path is still truncated — `lstat` cannot tell one from a regular file and `O_NOFOLLOW` does
 * not apply — but a hard link is not representable in a repository, so nothing a checkout carries
 * can plant one.
 */
export function openForWriteNoFollow(file: string, mode: number): NoFollowWrite {
  const removedSymlink = unlinkIfSymlink(file);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
  return { handle: fs.openSync(file, flags, mode), removedSymlink };
}

function unlinkIfSymlink(file: string): boolean {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  fs.unlinkSync(file);
  return true;
}
