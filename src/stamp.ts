import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Config, Diagnostic, DiscoveredSkill, Root } from "./types.ts";
import { warning } from "./types.ts";
import { OUTPUT_FILENAME, STAMP_FILENAME, stateDir } from "./layout.ts";
import { ensureRealDir, openForWriteNoFollow } from "./fsutil.ts";
import { normaliseEol, normaliseEolBytes } from "./text.ts";
import { foreignOwner, standingOf } from "./ownership.ts";

/**
 * The serialised record's format. A stamp written by another version records outcomes this one
 * cannot interpret, so it is treated as absent rather than parsed leniently — one forced rebuild,
 * deliberately, in place of a silent misreading of what the last build left on disk.
 */
const STAMP_VERSION = 2;

/**
 * Owner-only, for the reason `build.log` is: the record carries the same `Diagnostic[]` the log
 * does, so it holds whatever a template, fragment or override held — a merge-conflict marker
 * wrapped around a secret, say — and replays it on every later run. Re-applied on every write,
 * because a mode only takes effect where the file is created and a stamp left wider by an older
 * version would otherwise stay that way for good.
 */
const STAMP_MODE = 0o600;

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The stamp is a cache hint, never an authority: a matching input hash says only that the *inputs*
 * are unchanged, so the outputs are checked by content. Only `SKILL.md` is hashed — a `references/`
 * tree dominates corpus bytes and hashing it would put the gated path's cost back where the stamp
 * exists to avoid, and `SKILL.md` is the file that reaches the model as instructions.
 *
 * **Outcomes are recorded per target because they differ per target.** A skill written to one and
 * declined in another has no single state, and collapsing the pair to *declined* would strip the
 * integrity check from a compiled skill that really is there — which anyone able to create a
 * directory in a shared target such as `~/.claude/skills` could arrange for themselves.
 *
 * Every recorded outcome is re-checked, and every outcome that re-checks counts as verification
 * work done: a hash whose file still hashes to it, and a decline whose non-owned entry is still
 * standing. Both are readings of the disk that confirm the record is *true* of it. A record that
 * confirms nothing gates nothing, which is what closes a crafted stamp claiming there was never
 * anything to check — but a corpus whose every skill is genuinely declined has a record that
 * confirms as much as any other, and the spec promises those are not stale output.
 */
export function outputsVerified(
  config: Config,
  skills: DiscoveredSkill[],
  stored: StampRecord,
  diagnostics: Diagnostic[],
): boolean {
  let verified = 0;
  let matched = true;
  for (const skill of skills) {
    const recorded = stored.outputs[skill.name];
    if (recorded === undefined) {
      matched = false;
      continue;
    }
    for (const target of config.targets) {
      const destination = path.join(target.path, skill.name);
      const outcome = recorded[target.path];
      if (outcome !== undefined && outcome.outcome === "declined") {
        if (declineHolds(destination)) verified++;
        else matched = false;
        continue;
      }
      const actual = readOutput(path.join(destination, OUTPUT_FILENAME));
      if (outcome === undefined) {
        /**
         * No outcome for this target at all: the record does not claim a `SKILL.md` was written
         * there, so one standing there is not this stamp's to vouch for. That is what stops a
         * `failed` list hiding a file from the check.
         */
        if (actual !== null) matched = false;
        continue;
      }
      if (actual !== null && hashContent(actual) === outcome.hash) {
        verified++;
        continue;
      }
      matched = false;
      /**
       * Two repos may publish a skill of the same name into one shared target — blessed, and
       * explicitly not arbitrated. Neither one's stamp can then verify the file, so each recompiles
       * in full at every session start. Naming the marker's owner is what turns that permanent
       * rebuild from bare staleness into something a developer can act on. It is conditioned on a
       * *foreign marker* rather than on any mismatch, so an ordinary hand edit stays silent.
       */
      const owner = foreignOwner(destination, config);
      if (owner !== null) {
        diagnostics.push(
          warning(
            `${destination} carries another build's marker (${owner}) — both publish a skill of ` +
              `this name into this target, so neither can gate and each recompiles it every run`,
            { skill: skill.name },
          ),
        );
      }
    }
  }
  /**
   * A gate may only skip work it can prove was done, and a record that confirms nothing against
   * the disk proves nothing — the shape a forged stamp takes when it claims every skill failed,
   * since a `failed` list is the one outcome that names no path to go and look at. A run with no
   * skills, or no targets, wrote nothing anywhere and has nothing to prove.
   */
  const nothingToWrite = skills.length === 0 || config.targets.length === 0;
  return matched && (verified > 0 || nothingToWrite);
}

/**
 * A recorded decline is re-checked by asking whether a **non-owned entry is still standing** at
 * that path, never whether the path is still *unmarked*. Standing, it is exactly what a fresh
 * build would find and decline over again, which is why the answer counts as verified. A path that has since been emptied also
 * reads as unmarked, so the weaker test would honour the decline forever and never write the skill
 * to a target that is now free — breaking the promise that deleting a compiled skill by hand
 * rebuilds it.
 */
function declineHolds(destination: string): boolean {
  const standing = standingOf(destination);
  return standing === "symlink" || standing === "unmarked";
}

function readOutput(candidate: string): string | null {
  try {
    return fs.readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

/** Every skill the last stamp record knew about, whether it compiled or failed. */
export function previouslyCompiled(stored: StampRecord | null): string[] {
  if (stored === null) return [];
  return [...new Set([...Object.keys(stored.outputs), ...stored.failed])].sort();
}

/**
 * Stored text is not this run's report. Marking it says so on the one channel the SessionStart
 * hook feeds to the model, so a replayed line can never pass for something the tool just observed.
 */
export function asReplayed(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map((entry) => ({ ...entry, message: `[last build] ${entry.message}` }));
}

export function computeStamp(config: Config, version: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(`composable-skills\0${version}\0id\0${config.id ?? ""}\0`);
  const rootSets: [string, Root[]][] = [
    ["source", config.sources],
    ["override", config.overrides],
    ["target", config.targets],
  ];
  for (const [label, roots] of rootSets) {
    for (const root of roots) hash.update(`${label}\0${root.spec}\0${root.path}\0`);
  }
  hash.update(`config\0${config.configText === null ? "" : normaliseEol(config.configText)}\0`);
  for (const root of [...config.sources, ...config.overrides]) {
    hash.update(`tree\0${root.path}\0`);
    for (const entry of listEntries(root.path)) {
      hash.update(`${entry.rel}\0`);
      if (entry.link) {
        let destination: string;
        try {
          destination = fs.readlinkSync(entry.abs);
        } catch {
          destination = "\0unreadable";
        }
        hash.update(`symlink\0${destination}`);
      } else {
        updateWithFile(hash, entry.abs);
      }
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

interface ListedEntry {
  rel: string;
  abs: string;
  link: boolean;
}

function listEntries(root: string): ListedEntry[] {
  const found: ListedEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // A symlink is never followed, but retargeting one changes what the build refuses to do,
      // so its destination belongs in the hash.
      if (entry.isSymbolicLink()) found.push({ rel, abs, link: true });
      else if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) found.push({ rel, abs, link: false });
    }
  };
  walk(root, "");
  return found;
}

function updateWithFile(hash: crypto.Hash, file: string): void {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    hash.update("\0unreadable");
    return;
  }
  hash.update(normaliseEolBytes(raw));
}

/**
 * The stamp is a record rather than a bare hash so a gated run can replay what the last real
 * build said. Without it, one permanently broken template would suppress the stamp for the whole
 * repo and recompile every healthy skill at every session start, forever.
 */
export interface StampRecord {
  stamp: string;
  /** Skills that failed to compile last time. Recorded for reporting, not trusted by the gate. */
  failed: string[];
  /**
   * What this build left at each target, per skill: the sha256 of the `SKILL.md` it wrote there,
   * or a decline where the target held something that was not this tool's to replace. Keyed by the
   * target's resolved path, which is itself a stamp input, so a record only ever meets the targets
   * it was written for. Inputs hashing to the same stamp says nothing about what is on disk, so
   * the gate checks these against the files themselves.
   */
  outputs: Record<string, SkillOutcomes>;
  diagnostics: Diagnostic[];
}

export type TargetOutcome = { outcome: "written"; hash: string } | { outcome: "declined" };

/** One skill's outcome at each target, keyed by the target's resolved path. */
export type SkillOutcomes = Record<string, TargetOutcome>;

function stampPath(config: Config): string {
  return path.join(stateDir(config.repoRoot), STAMP_FILENAME);
}

export function readStamp(config: Config): StampRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(stampPath(config), "utf8").trim();
  } catch {
    return null;
  }
  if (text === "") return null;
  // A bare-hash stamp predates the record entirely, so there is nothing in it to verify.
  if (!text.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== STAMP_VERSION) return null;
  if (typeof record["stamp"] !== "string" || record["stamp"] === "") return null;
  const failed = record["failed"];
  const diagnostics = record["diagnostics"];
  return {
    stamp: record["stamp"],
    failed: Array.isArray(failed)
      ? failed.filter((name): name is string => typeof name === "string")
      : [],
    outputs: readOutcomes(record["outputs"]),
    diagnostics: Array.isArray(diagnostics) ? diagnostics.filter(isDiagnostic) : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOutcomes(value: unknown): Record<string, SkillOutcomes> {
  const outputs: Record<string, SkillOutcomes> = {};
  if (!isRecord(value)) return outputs;
  for (const [name, perTarget] of Object.entries(value)) {
    if (!isRecord(perTarget)) continue;
    // An entry surviving with no readable outcome still says the record *mentions* this skill,
    // which is not the same as claiming anything about it.
    const outcomes: SkillOutcomes = {};
    for (const [targetPath, outcome] of Object.entries(perTarget)) {
      const read = readOutcome(outcome);
      if (read !== null) outcomes[targetPath] = read;
    }
    outputs[name] = outcomes;
  }
  return outputs;
}

function readOutcome(value: unknown): TargetOutcome | null {
  if (!isRecord(value)) return null;
  if (value["outcome"] === "declined") return { outcome: "declined" };
  const hash = value["hash"];
  if (value["outcome"] === "written" && typeof hash === "string" && hash !== "") {
    return { outcome: "written", hash };
  }
  return null;
}

/**
 * Defence in depth behind `report.ts`, which is what actually makes a replayed message safe to
 * render. This is the type assertion's own half of the bargain: `StampRecord` declares
 * `Diagnostic[]`, so every field the type promises has to be established here rather than
 * inherited from whatever JSON was on disk. `line` is a coordinate a reader is invited to open a
 * file at, so a non-integer is not a weaker `line` but a different claim.
 */
function isDiagnostic(value: unknown): value is Diagnostic {
  if (!isRecord(value)) return false;
  if (value["severity"] !== "error" && value["severity"] !== "warning") return false;
  if (typeof value["message"] !== "string") return false;
  if (!isOptionalString(value["skill"]) || !isOptionalString(value["file"])) return false;
  const line = value["line"];
  return line === undefined || (typeof line === "number" && Number.isInteger(line) && line > 0);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/**
 * Returns what the caller must say about the write rather than saying it here, because the stamp
 * is written before the report is rendered and the record on disk is already sealed by then.
 * Invariant 8 asks that no symlink is followed *silently*: a link standing where the stamp goes is
 * removed rather than written through, and the run names it.
 */
export function writeStamp(config: Config, record: StampRecord): Diagnostic[] {
  try {
    ensureRealDir(stateDir(config.repoRoot));
    const serialised = JSON.stringify({ version: STAMP_VERSION, ...record });
    const stamp = openForWriteNoFollow(stampPath(config), STAMP_MODE);
    try {
      // Before the write, like the log's: a stamp left group- or world-readable by an older
      // version must not be readable for the span in which this run's diagnostics land in it.
      fs.fchmodSync(stamp.handle, STAMP_MODE);
      fs.writeFileSync(stamp.handle, `${serialised}\n`, "utf8");
    } finally {
      fs.closeSync(stamp.handle);
    }
    if (stamp.removedSymlink) {
      return [
        warning("the stamp path was a symlink — removed rather than written through", {
          file: stampPath(config),
        }),
      ];
    }
  } catch {
    // a stamp that cannot be written only costs a rebuild next session
  }
  return [];
}
