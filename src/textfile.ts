import fs from "node:fs";

import { pathExists } from "./fsutil.ts";

/**
 * Sniffed the way the indent is, and for the same reason: a merge that rewrites every line ending
 * in the file shows up in the diff as every line changed, rendered by a terminal as every line
 * identical — the developer sees their whole file replaced and is given no way to see why.
 */
export function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** Applies to text this tool generated, which is LF-only; it is not a normaliser. */
export function applyEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replaceAll("\n", eol);
}

/**
 * What one attempt to read a text file found. Three states rather than two, because "absent" and
 * "present but unreadable" are opposite instructions to a caller that is about to write: the first
 * invites a create, the second forbids one.
 */
export type TextFileRead =
  | { kind: "present"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; cause: unknown };

/**
 * Existence is decided by `lstat`, never by a successful read. A mode-000 file read through a
 * catch-all `catch` is indistinguishable from a file that is not there, and a caller told "not
 * there" creates one — over the top of content nobody ever saw, with a diff showing only `+`
 * lines and so nothing for the developer to object to.
 */
export function readIfPresent(candidate: string): TextFileRead {
  try {
    return { kind: "present", text: fs.readFileSync(candidate, "utf8") };
  } catch (cause) {
    return pathExists(candidate) ? { kind: "unreadable", cause } : { kind: "absent" };
  }
}
