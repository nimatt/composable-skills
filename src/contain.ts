import path from "node:path";

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
