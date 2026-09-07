import path from "node:path";
import type { Diagnostic } from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { loadConfig } from "./config.ts";
import { stateDir, toolVersion } from "./layout.ts";
import { crashStateDir, emitReport } from "./report.ts";
import { pathExists } from "./fsutil.ts";
import { discoverSkills } from "./discover.ts";
import { compileSkill } from "./compile.ts";
import { acquireBuildLock } from "./lock.ts";
import type { SkillOutcomes } from "./stamp.ts";
import {
  asReplayed,
  computeStamp,
  hashContent,
  outputsVerified,
  previouslyCompiled,
  readStamp,
  snapshotOutput,
  writeStamp,
} from "./stamp.ts";
import { emitSkill, pruneTarget } from "./emit.ts";

export interface BuildOptions {
  cwd?: string;
  check?: boolean;
  /** Overrides the tool's own version in the stamp. For tests; a real run reads it itself. */
  version?: string;
  env?: NodeJS.ProcessEnv;
}

export function runBuild(options: BuildOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const check = options.check ?? false;
  const loaded = loadConfig(cwd, options.env ?? process.env);

  if ("fatal" in loaded) {
    /**
     * The three-channel rule has exactly two documented exceptions — `--check` and an interactive
     * terminal — and a fatal config error is neither. It is also the likeliest real failure, in
     * the context the file channel exists for, so it gets the log like everything else.
     */
    let fatalLogDir: string | null = null;
    if (!check) {
      try {
        fatalLogDir = crashStateDir(cwd);
      } catch {
        fatalLogDir = null;
      }
    }
    emitReport([...loaded.diagnostics, error(loaded.fatal)], [], fatalLogDir);
    return check ? 1 : 0;
  }

  const { config } = loaded;
  /** `--check` writes nothing, and that includes the log file. */
  const logDir = check ? null : stateDir(config.repoRoot);
  const discovery = discoverSkills(config);
  /** Recomputed every run, so a gated run must not replay them from the stamp as well. */
  const live: Diagnostic[] = [
    ...loaded.diagnostics,
    ...loaded.buildAdvice,
    ...discovery.diagnostics,
  ];
  const skills = discovery.skills;

  const stamp = computeStamp(config, options.version ?? toolVersion());
  const stored = readStamp(config);
  /** The gate's own observations — recomputed every run, so they go to `live` and not the stamp. */
  const freshStamp =
    stored !== null && stored.stamp === stamp && outputsVerified(config, skills, stored, live)
      ? stored
      : null;

  if (check) {
    if (freshStamp === null) {
      /**
       * Where the inputs still hash the same, staleness is a verdict about the *output* and the
       * last build's own diagnostics are the only account of why it looks like that — a template
       * that has failed to compile every run since leaves nothing on disk to verify, and bare
       * "stale" then names a remedy that cannot clear it. Withheld where the hash differs, since
       * those diagnostics describe a corpus this is no longer looking at.
       */
      const sameInputs = stored !== null && stored.stamp === stamp;
      emitReport(
        [
          ...live,
          ...(sameInputs ? asReplayed(stored.diagnostics) : []),
          error("compiled output is stale — run `composable-skills build`"),
        ],
        [],
        logDir,
      );
      return 1;
    }
    const replayed = [...live, ...asReplayed(freshStamp.diagnostics)];
    // A live error is an error the next real build would hit too, so it fails `--check` exactly
    // as a replayed one does. Only the replayed half is recorded in the stamp.
    const broken = replayed.some((entry) => entry.severity === "error");
    emitReport(replayed, broken ? [] : ["compiled output is up to date"], logDir);
    return broken ? 1 : 0;
  }

  if (freshStamp !== null) {
    emitReport([...live, ...asReplayed(freshStamp.diagnostics)], [], logDir);
    return 0;
  }

  const diagnostics: Diagnostic[] = [];
  const lock = acquireBuildLock(config);
  if (lock.kind === "busy") {
    // Nothing was compiled, so the last real build's diagnostics are still the truth about this
    // tree — dropping them would hide a permanently broken template for as long as the lock holds.
    const replayed = stored === null ? [] : asReplayed(stored.diagnostics);
    emitReport([...live, ...replayed, warning(lock.message)], [], logDir);
    return 0;
  }
  /**
   * An observation about this run's environment rather than about the tree, so it goes where the
   * `busy` message above goes and never into the stamp: `diagnostics` is what `writeStamp`
   * persists as the last real build's account of the corpus, and a one-off `EACCES` on the state
   * directory would otherwise be replayed as `[last build] building without a lock` at every
   * session start until an input hash changed.
   */
  if (lock.kind === "unavailable") live.push(warning(lock.message));

  /**
   * Read before anything writes, because `emitSkill` creates the target itself. A target that was
   * not there when the session started is the fresh-clone case ADR-0001 records: the harness does
   * not watch a skills directory that appeared mid-session, so this build's output is on disk and
   * invisible until the next one, with no error and no signal. `build` runs at `SessionStart` and
   * its stdout reaches the model, which makes it the only channel that reaches the person who
   * cloned — the advice `init` prints reaches the maintainer who ran it, once.
   */
  const absentTargets = config.targets.filter((target) => !pathExists(target.path));

  let built = 0;
  const failed: string[] = [];
  const outputs: Record<string, SkillOutcomes> = {};
  let pruned = 0;
  try {
    for (const skill of skills) {
      /** A skill that fails keeps its previous output, so its previous record stays the truth. */
      const carried = stored?.outputs[skill.name] ?? {};
      try {
        const result = compileSkill(skill, config);
        diagnostics.push(...result.diagnostics);
        if (result.compiled === null) {
          failed.push(skill.name);
          outputs[skill.name] = carried;
          continue;
        }
        const hash = hashContent(result.compiled.content);
        const recorded: SkillOutcomes = {};
        let written = false;
        for (const target of config.targets) {
          const outcome = emitSkill(target, result.compiled, config, diagnostics);
          if (outcome === "written") {
            written = true;
            /**
             * The skill is on disk by now, so a manifest this run cannot take is a gap in the
             * record and not a failed skill. Leaving the target unrecorded is what the gap should
             * cost: `outputsVerified` does not vouch for output no outcome claims, so the next run
             * finds it stale and writes it again — where recording the write without its manifest
             * would gate on a claim nothing had checked, and throwing would both mislabel a skill
             * that succeeded and abandon the targets after this one.
             */
            try {
              recorded[target.path] = {
                outcome: "written",
                hash,
                files: snapshotOutput(path.join(target.path, skill.name)),
              };
            } catch (cause) {
              diagnostics.push(
                warning(
                  `wrote ${skill.name} to ${target.path} but could not record what was ` +
                    `written: ${describe(cause)} — it will be compiled again next run`,
                  { skill: skill.name },
                ),
              );
            }
          } else if (outcome === "declined") {
            recorded[target.path] = { outcome: "declined" };
          } else {
            /** An I/O error says nothing about what is on disk, so the last outcome still does. */
            const previous = carried[target.path];
            if (previous !== undefined) recorded[target.path] = previous;
          }
        }
        outputs[skill.name] = recorded;
        if (written) built++;
      } catch (cause) {
        failed.push(skill.name);
        outputs[skill.name] = carried;
        diagnostics.push(
          error(`skill failed unexpectedly: ${describe(cause)}`, {
            skill: skill.name,
            file: skill.templatePath,
          }),
        );
      }
    }

    const keep = new Set(skills.map((skill) => skill.name));
    if (!discovery.complete) {
      diagnostics.push(
        warning(
          "a configured source root could not be read in full, or resolved to a copy this build " +
            "cannot vouch for — nothing was pruned this run",
        ),
      );
    } else {
      const orphaned = previouslyCompiled(stored).filter((name) => !keep.has(name));
      /**
       * An empty corpus and a config that lost its `sources` key look identical from here, and
       * one of them means deleting every compiled skill. The last stamp tells them apart: a
       * corpus that was genuinely emptied one template at a time never reaches zero *roots*.
       */
      if (config.sources.length === 0 && orphaned.length > 0) {
        diagnostics.push(
          warning(
            `no usable source roots, but the last build compiled ${orphaned.length} skill(s) ` +
              `(${orphaned.join(", ")}) — refusing to prune; check the "sources" key`,
          ),
        );
      } else {
        for (const target of config.targets) {
          pruned += pruneTarget(target, keep, config, diagnostics);
        }
      }
    }

    diagnostics.push(...writeStamp(config, { stamp, failed, outputs, diagnostics }));
  } finally {
    if (lock.kind === "held") lock.release();
  }

  const summary: string[] = [];
  const targetWord = config.targets.length === 1 ? "target" : "targets";
  const parts = [
    `${built} skill${built === 1 ? "" : "s"} → ${config.targets.length} ${targetWord}`,
  ];
  if (failed.length > 0) parts.push(`${failed.length} kept previous output`);
  if (pruned > 0) parts.push(`${pruned} pruned`);
  summary.push(parts.join(", "));

  const created = absentTargets.filter((target) => pathExists(target.path));
  if (built > 0 && created.length > 0) {
    summary.push(
      `${created.map((target) => target.spec).join(", ")} did not exist before this build — a ` +
        `skills directory that was not there when the session started is not picked up, so these ` +
        `skills become available in the next session`,
    );
  }
  emitReport([...live, ...diagnostics], summary, logDir);

  return 0;
}
