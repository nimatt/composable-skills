import fs from "node:fs";
import path from "node:path";

import type { Config } from "./types.ts";
import { isValidId } from "./config.ts";
import { OWNER_MARKER } from "./layout.ts";

interface OwnerRecord {
  skill: string;
  id: string | null;
  repo: string;
}

export function markerContent(skill: string, config: Config): string {
  const record: OwnerRecord & { tool: string } = {
    tool: "composable-skills",
    skill,
    id: config.id,
    repo: config.repoRoot,
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * Opened `O_NOFOLLOW` rather than read by path. `standingOf` refuses to read a marker through a
 * symlinked skill *directory*, but the marker file inside a real directory is a second link the
 * same rule covers: what it named would be read as a claim about *this* directory, and invariant
 * 8 says no symlink is ever followed. The `lstat` is what covers a platform with no `O_NOFOLLOW`,
 * and carries the ordinary race any path-based check does; the open flag is what closes it where
 * the kernel has one.
 *
 * A marker must further be a **regular file**, of a size the `lstat` already in hand can vouch
 * for. `O_NOFOLLOW` refuses a symlink but not a FIFO, and `open(fifo, O_RDONLY)` blocks until a
 * writer appears — so a named pipe under any name in a shared target would hang `build`, which
 * runs at every session start and holds the repo lock while it does, with no exit code and no
 * self-healing. That is strictly worse than the failure the fail-soft contract was written to
 * avoid. `O_NONBLOCK` covers the same entry swapped in between the `lstat` and the `open`, and is
 * a no-op on the regular file this is meant to read; the bounded read covers it growing in the
 * same window.
 */
function readMarkerFile(directory: string): string | null {
  const marker = path.join(directory, OWNER_MARKER);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(marker);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MARKER_FILE_MAX) return null;
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const nonBlocking = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let handle: number;
  try {
    handle = fs.openSync(marker, fs.constants.O_RDONLY | noFollow | nonBlocking);
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(stats.size + 1);
    const filled = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, filled);
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // nothing was written through it, so a failed close costs only the descriptor
    }
  }
}

/**
 * The longest a marker field may be. A marker is written by another build, which is the point of
 * it, so `repo` is a path this tool never resolved and `id` a string it never validated — and
 * `foreignOwner` puts whichever one is present into a warning that reaches a model as
 * instructions. `PATH_MAX` is the generous end of what a real repo root can be.
 */
const MARKER_FIELD_MAX = 4096;

/**
 * The largest a marker file may be, checked against `stat` before it is opened — `MARKER_FIELD_MAX`
 * is applied only once `JSON.parse` has already built the whole file in memory, so on its own it
 * bounds nothing. Derived rather than picked: `readMarker` accepts four fields, none of which can
 * exceed `MARKER_FIELD_MAX` UTF-16 units. Two are bounded by `markerField` saying so — `id` and
 * `repo` — and two by being accepted only as equalities: `tool` against a fixed literal, `skill`
 * against the skill directory's own name, which no filesystem lets approach the length of a whole
 * path. JSON's widest spelling of one such unit is six bytes (`\uXXXX`). So no file under this
 * bound could have been rejected for size, and nothing over it is anything but padding around a
 * marker that would have fit.
 */
const MARKER_FILE_MAX = MARKER_FIELD_MAX * 4 * 6;

/**
 * A marker field, bounded in length and in nothing else. `repo` is why the bound is all there is:
 * it is `config.repoRoot` written back verbatim, an absolute path this tool never chose, and a
 * control character is legal in every component of one — a TAB, a ZWJ, a soft hyphen or a bidi
 * mark in any ancestor directory. Filtering those out here would void a marker this build had just
 * written for itself, the same defect `skill` carried: the directory could then neither be
 * rewritten nor pruned, and the warning blamed the developer for a directory the tool had
 * written itself.
 * Nothing is given up by that, because display safety was never held here — `report.ts` escapes
 * every line-breaking character in every line it renders, once, at the point each channel renders
 * through, where no later source of borrowed text can miss it. What a field must still not be is
 * *unbounded*: `foreignOwner` quotes whichever one names the owner into a warning that reaches a
 * model as instructions.
 */
function markerField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > MARKER_FIELD_MAX ? null : value;
}

function readMarker(directory: string): OwnerRecord | null {
  return readMarkerNaming(directory, (skill) => skill === path.basename(directory));
}

function readMarkerNaming(
  directory: string,
  namesTheDirectory: (skill: string) => boolean,
): OwnerRecord | null {
  const raw = readMarkerFile(directory);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record["tool"] !== "composable-skills") return null;
  /**
   * The contract sells the marker as what makes a shared `~/.claude/skills` safe, so it must name
   * something. `{"tool":"composable-skills"}` alone would otherwise make an unmarked directory
   * overwritable, and a `skill` that does not match the directory it sits in is a marker that was
   * copied rather than written here.
   *
   * Compared to the directory name rather than merely bounded as a field: `skill` is written
   * verbatim from a directory name this tool did not choose and is never rendered — `foreignOwner`
   * quotes `id ?? repo` — so a control-character filter bought nothing there and cost the round
   * trip. A directory name may legally hold a TAB, a ZWJ (every emoji sequence has one) or a soft
   * hyphen, and a marker this build had just written for such a skill read back as *unmarked*: the
   * directory could then neither be rewritten nor pruned, and the warning blamed the developer for
   * output the tool itself had emitted.
   */
  const skill = record["skill"];
  if (typeof skill !== "string" || skill === "" || !namesTheDirectory(skill)) return null;
  /**
   * The shape the config validator holds this repo's own `id` to; a marker declares the same. It
   * admits `[A-Za-z0-9._-]` and nothing else, so it is also what keeps a declared `id` clear of
   * everything `markerField` no longer rejects — `repo` is the field that had to widen, being a
   * path rather than a name this tool gets to constrain.
   */
  const declaredId = markerField(record["id"]);
  const id = declaredId !== null && isValidId(declaredId) ? declaredId : null;
  const repo = markerField(record["repo"]) ?? "";
  if (id === null && repo === "") return null;
  return { skill, id, repo };
}

/** Written by this tool, for anybody. Governs whether a directory may be overwritten. */
export function isOwned(directory: string): boolean {
  return readMarker(directory) !== null;
}

/**
 * What is standing where a compiled skill would go. A **symlink** is none of the other three: the
 * entry is `lstat`'d and recognised as a link before anything about its destination is consulted,
 * because the question asked here is whether *this* entry, in *this* target, is the tool's to
 * replace — and a marker found by following the link would be a claim about the link's
 * destination instead.
 */
export type Standing = "absent" | "symlink" | "unmarked" | "owned";

export function standingOf(destination: string): Standing {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(destination);
  } catch {
    return "absent";
  }
  if (entry.isSymbolicLink()) return "symlink";
  return isOwned(destination) ? "owned" : "unmarked";
}

function matchesThisBuild(marker: OwnerRecord, config: Config): boolean {
  if (config.id !== null && marker.id !== null) return marker.id === config.id;
  return marker.repo !== "" && marker.repo === config.repoRoot;
}

/**
 * Written by *this* repo's build. Governs deletion: a target may be shared — `~/.claude/skills`
 * is a blessed one — and another repo's skills are not this build's to prune.
 */
export function ownedByThisBuild(directory: string, config: Config): boolean {
  const marker = readMarker(directory);
  return marker !== null && matchesThisBuild(marker, config);
}

/**
 * `ownedByThisBuild` for a directory whose own name is not the skill's — which is every scratch
 * directory `emit.ts` makes: a `-tmp-` staging area is marked before anything else goes into it,
 * and a `-old-` parked copy is the emitted directory itself, marker and all. `readMarker`'s rule
 * that a marker names the directory it sits in cannot be put to
 * `.composable-skills-old-<skill>-<suffix>`, so the caller puts the question its own naming can
 * answer instead. It has to be asked somehow: a marker that does not fit the name it is standing
 * in was copied there rather than written there. And the fit is what the caller decides rather
 * than what this returns, because `MARKER_FILE_MAX`'s whole derivation rests on `skill` only ever
 * being weighed against a name, never taken on the field's own word.
 */
export function markedByThisBuildFor(
  directory: string,
  config: Config,
  namesTheDirectory: (skill: string) => boolean,
): boolean {
  const marker = readMarkerNaming(directory, namesTheDirectory);
  return marker !== null && matchesThisBuild(marker, config);
}

/**
 * How a valid marker that is *not* this build's names its owner — its declared `id`, or the repo
 * root it was written from. Null where there is no valid marker, or where it is this build's own.
 */
export function foreignOwner(directory: string, config: Config): string | null {
  const marker = readMarker(directory);
  if (marker === null || matchesThisBuild(marker, config)) return null;
  return marker.id ?? marker.repo;
}
