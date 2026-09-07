import fs from "node:fs";
import path from "node:path";

import type { CompiledSkill, Config, Diagnostic, Root } from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { OUTPUT_FILENAME, OWNER_MARKER } from "./layout.ts";
import { createdAtFromName, isMissing, pathExists, removeQuietly, uniqueSuffix } from "./fsutil.ts";
import { markerContent, markedByThisBuildFor, ownedByThisBuild, standingOf } from "./ownership.ts";

const TMP_PREFIX = ".composable-skills-tmp-";
const OLD_PREFIX = ".composable-skills-old-";

/** Scratch directories younger than this may belong to a build running right now. */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

/**
 * `declined` is "something is standing there that is not mine to replace"; `failed` is an I/O
 * error. They are recorded differently, because a decline is a stable state the next run can
 * re-check while a failure says nothing about what is on disk.
 */
export type EmitOutcome = "written" | "declined" | "failed";

export function emitSkill(
  target: Root,
  skill: CompiledSkill,
  config: Config,
  diagnostics: Diagnostic[],
): EmitOutcome {
  const destination = path.join(target.path, skill.name);
  try {
    fs.mkdirSync(target.path, { recursive: true });
  } catch (cause) {
    diagnostics.push(
      error(`cannot create target ${target.path}: ${describe(cause)}`, { skill: skill.name }),
    );
    return "failed";
  }

  const standing = standingOf(destination);
  if (standing === "symlink") {
    diagnostics.push(
      warning(`${destination} is a symlink — left untouched and not read through`, {
        skill: skill.name,
      }),
    );
    return "declined";
  }
  if (standing === "unmarked") {
    diagnostics.push(
      warning(`${destination} exists and was not written by this tool — left untouched`, {
        skill: skill.name,
      }),
    );
    return "declined";
  }

  const staging = path.join(target.path, `${TMP_PREFIX}${skill.name}-${uniqueSuffix()}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    /**
     * The marker goes in before the content rather than after it, so that a staging directory
     * abandoned by a build that died mid-copy still says whose it was. `pruneTarget` sweeps only
     * scratch it can attribute to this repo, and what it cannot attribute it leaves where it is —
     * so an unmarked staging directory would sit in a shared target forever.
     */
    fs.writeFileSync(path.join(staging, OWNER_MARKER), markerContent(skill.name, config), "utf8");
    for (const extra of skill.extras) {
      const to = path.join(staging, ...extra.rel.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(extra.from, to);
    }
    fs.writeFileSync(path.join(staging, OUTPUT_FILENAME), skill.content, "utf8");
    swapIntoPlace(staging, destination, target.path);
    return "written";
  } catch (cause) {
    diagnostics.push(
      error(`cannot write ${destination}: ${describe(cause)}`, { skill: skill.name }),
    );
    removeQuietly(staging);
    return "failed";
  }
}

function swapIntoPlace(staging: string, destination: string, targetDir: string): void {
  if (!pathExists(destination)) {
    fs.renameSync(staging, destination);
    return;
  }
  const parked = path.join(
    targetDir,
    `${OLD_PREFIX}${path.basename(destination)}-${uniqueSuffix()}`,
  );
  fs.renameSync(destination, parked);
  try {
    fs.renameSync(staging, destination);
  } catch (cause) {
    try {
      fs.renameSync(parked, destination);
    } catch (rollbackCause) {
      /**
       * Both renames failed, so `destination` is now missing entirely and the parked copy is the
       * only thing left holding its content. Reporting only the rollback would lose why the swap
       * was attempted in the first place, and reporting only the swap would leave nobody looking
       * for the parked directory, so the message carries both and where the content went.
       */
      throw new Error(
        `${describe(cause)} — and ${destination} could not be restored from ${parked}: ` +
          `${describe(rollbackCause)}`,
        { cause },
      );
    }
    throw cause;
  }
  fs.rmSync(parked, { recursive: true, force: true });
}

export function pruneTarget(
  target: Root,
  keep: Set<string>,
  config: Config,
  diagnostics: Diagnostic[],
): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target.path, { withFileTypes: true });
  } catch (cause) {
    /**
     * A target nothing has been written to yet is the ordinary cold case, and a warning there
     * would be replayed from the stamp at every session start. Every other errno is the mirror of
     * `discoverSkills`'s unreadable source root: what this build could not see is not evidence
     * that nothing is stale, so nothing in this target is pruned.
     */
    if (!isMissing(cause)) {
      diagnostics.push(
        warning(
          `cannot read target ${target.path}: ${describe(cause)} — nothing in it was considered ` +
            `for pruning`,
        ),
      );
    }
    return 0;
  }

  let pruned = 0;
  for (const entry of entries) {
    const full = path.join(target.path, entry.name);
    const scratchPrefix = scratchPrefixOf(entry.name);
    if (scratchPrefix !== null) {
      /**
       * Two gates, because a target may be shared and pruning is the only unowned destructive
       * operation this tool performs. A young scratch directory may be a concurrent build's
       * staging area, or the only copy of another build's last good output while its swap is in
       * flight; an old one may still be *another repo's*, parked by a build that was killed
       * between the two renames, and deleting that is the same wrong as pruning a foreign skill.
       * A link is neither: nothing is read through it, and a marker found by following it would
       * describe its destination rather than this entry. Anything that cannot be attributed stays.
       */
      const ours =
        !entry.isSymbolicLink() && scratchOwnedByThisBuild(full, entry.name, scratchPrefix, config);
      if (ours && isStaleScratch(full)) removeQuietly(full);
      continue;
    }
    // `isDirectory()` is already false for a symlink dirent, so this arm is the only thing that
    // decides a link's fate here — as it is in `discoverSkills`, which puts it first for the same
    // reason. Nothing below is reached for one, and none is followed.
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name) || !ownedByThisBuild(full, config)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      pruned++;
    } catch (cause) {
      diagnostics.push(warning(`cannot remove stale ${full}: ${describe(cause)}`));
    }
  }
  return pruned;
}

function scratchPrefixOf(name: string): string | null {
  if (name.startsWith(TMP_PREFIX)) return TMP_PREFIX;
  if (name.startsWith(OLD_PREFIX)) return OLD_PREFIX;
  return null;
}

/**
 * Every scratch directory is named `<prefix><skill>-<suffix>` for the skill it holds, and carries
 * that skill's marker. Owning it is both halves agreeing: the marker is this repo's, and the name
 * is one this build's own naming would have produced for the skill the marker declares. The name
 * is what stands in for `readMarker`'s basename check, which a scratch name cannot answer.
 */
function scratchOwnedByThisBuild(
  directory: string,
  name: string,
  prefix: string,
  config: Config,
): boolean {
  return markedByThisBuildFor(directory, config, (skill) => name.startsWith(`${prefix}${skill}-`));
}

function isStaleScratch(directory: string): boolean {
  const created = createdAtFromName(path.basename(directory));
  if (created !== null) return Date.now() - created > STALE_SCRATCH_MS;
  try {
    return Date.now() - fs.lstatSync(directory).mtimeMs > STALE_SCRATCH_MS;
  } catch {
    return false;
  }
}
