import fs from "node:fs";
import path from "node:path";

import { isMissing } from "./fsutil.ts";

/**
 * Path containment, asked as two questions rather than one, because the callers genuinely want
 * two different answers about the root itself.
 *
 * A security boundary — the read boundary in `directives.ts`, the write boundary in `init.ts` —
 * asks `isUnder`: the root is not a file you may read, nor a path you may write, so the self path
 * is not contained. Validation and advice ask `isAtOrUnder`: `overrides: ["${home}"]` names the
 * root itself and must not be rejected as outside itself, and an override root of `.` is inside
 * the working tree in every sense that the advisory means.
 *
 * Both split the relative path into segments and look for a `..` among them. Testing the string
 * for a `..` prefix instead would refuse a genuinely contained file whose own name merely begins
 * with two dots.
 */
function relativeSegments(root: string, candidate: string): string[] | null {
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative)) return null;
  const segments = relative === "" ? [] : relative.split(path.sep);
  return segments.includes("..") ? null : segments;
}

/** Strictly under `root`. The root itself is not contained. */
export function isUnder(root: string, candidate: string): boolean {
  const segments = relativeSegments(root, candidate);
  return segments !== null && segments.length > 0;
}

/** Under `root`, or `root` itself. */
export function isAtOrUnder(root: string, candidate: string): boolean {
  return relativeSegments(root, candidate) !== null;
}

/**
 * `root`/`missing` mean the path is not there; `root-unreadable`/`unreadable` mean it is there and
 * this process cannot see it. Collapsing the two is what let a `chmod`'d override root revert a
 * slot to its template default with nothing said — the same distinction `discover.ts` draws
 * between an absent skill and one the build cannot look at.
 */
export type ContainmentFailure =
  | { kind: "root" }
  | { kind: "root-symlink" }
  | { kind: "root-unreadable"; cause: unknown }
  | { kind: "missing"; part: string }
  | { kind: "unreadable"; part: string; cause: unknown }
  | { kind: "symlink"; part: string }
  | { kind: "outside" }
  | { kind: "not-file" }
  | { kind: "not-directory" };

function rootFailure(cause: unknown): ContainmentFailure {
  return isMissing(cause) ? { kind: "root" } : { kind: "root-unreadable", cause };
}

function partFailure(cause: unknown, part: string): ContainmentFailure {
  return isMissing(cause) ? { kind: "missing", part } : { kind: "unreadable", part, cause };
}

export type ContainedFile = { path: string } | { failure: ContainmentFailure };

export interface ContainmentOptions {
  /**
   * Refuse a root whose own last component is a symlink. Containment is asserted against the
   * *resolved* root, so `ln -s <outside> <root>` otherwise reads outside it cleanly and the
   * config's `${home}` check — which runs on unresolved path text — does not see it either.
   * Off for source roots, where a symlinked package directory is ordinary (pnpm, workspaces).
   */
  rejectSymlinkedRoot?: boolean;
  /**
   * What the resolved path must be. `include:` and overrides name files; a package `sources`
   * subpath names a directory. Defaults to `"file"`, so every path the compiler reads keeps the
   * rule it had before this option existed.
   */
  expect?: "file" | "directory";
}

/**
 * Resolve `<root>/<...parts>` under the containment discipline the spec requires of every path
 * the compiler reads: the root is `realpath`'d once, every component is `lstat`'d with any
 * symlink hop refused, the result is asserted contained, and only a node of the expected kind —
 * a regular file unless `expect` says otherwise — is accepted.
 */
export function resolveContainedFile(
  root: string,
  parts: string[],
  options: ContainmentOptions = {},
): ContainedFile {
  const last = parts[parts.length - 1] ?? "";

  if (options.rejectSymlinkedRoot === true) {
    let rootStats: fs.Stats;
    try {
      rootStats = fs.lstatSync(root);
    } catch (cause) {
      return { failure: rootFailure(cause) };
    }
    if (rootStats.isSymbolicLink()) return { failure: { kind: "root-symlink" } };
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch (cause) {
    return { failure: rootFailure(cause) };
  }

  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (cause) {
      return { failure: partFailure(cause, part) };
    }
    if (stats.isSymbolicLink()) return { failure: { kind: "symlink", part } };
  }

  let real: string;
  try {
    real = fs.realpathSync(current);
  } catch (cause) {
    return { failure: partFailure(cause, last) };
  }
  if (!isUnder(realRoot, real)) return { failure: { kind: "outside" } };

  let stats: fs.Stats;
  try {
    stats = fs.statSync(real);
  } catch (cause) {
    return { failure: partFailure(cause, last) };
  }
  if (options.expect === "directory") {
    if (!stats.isDirectory()) return { failure: { kind: "not-directory" } };
  } else if (!stats.isFile()) {
    return { failure: { kind: "not-file" } };
  }
  return { path: real };
}
