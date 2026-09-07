import fs from "node:fs";
import path from "node:path";

import type { Diagnostic } from "./types.ts";
import { error } from "./types.ts";
import { findConfigFile, findRepoRoot } from "./config.ts";
import { LOG_FILENAME, stateDir } from "./layout.ts";
import { ensureRealDir, openForWriteNoFollow } from "./fsutil.ts";

/**
 * A diagnostic quotes the line it rejected, so the log can hold whatever a template, fragment or
 * override held — a merge-conflict marker around a secret, say. Owner-only, and re-applied on
 * every write because a mode only takes effect where the file is created.
 */
const LOG_MODE = 0o600;

/**
 * True where a reader of one stream is also the reader of the other — a terminal, `> log 2>&1`,
 * or the merged pipe a postinstall or session hook captures — so a diagnostic written to both
 * would arrive twice. Two open file descriptions on one destination share `dev`/`ino`; two pipes,
 * or a redirect alongside a terminal, do not. Where the descriptors cannot be stat'd at all the
 * old TTY test stands in: this runs inside a fail-soft hook, and saying something twice is a far
 * better failure than not building.
 */
function streamsShareOneDestination(): boolean {
  try {
    const out = fs.fstatSync(fdOf(process.stdout, 1));
    const err = fs.fstatSync(fdOf(process.stderr, 2));
    return out.dev === err.dev && out.ino === err.ino;
  } catch {
    return process.stdout.isTTY === true && process.stderr.isTTY === true;
  }
}

function fdOf(stream: NodeJS.WriteStream, fallback: number): number {
  const fd = (stream as { fd?: unknown }).fd;
  return typeof fd === "number" ? fd : fallback;
}

/**
 * Anything that can end a line or move a terminal cursor, so one report line can only ever render
 * as one line. Tab is left alone: it cannot start a new line, and `init`'s diff quotes settings
 * files that legitimately contain them.
 */
const INVISIBLE = /(?!\t)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * **The one place untrusted text is made safe to display, and the reason every report line goes
 * through here.** A diagnostic quotes template, override and marker text, replays messages read
 * back from `.composable-skills/stamp`, and names skills after directories on disk — none of
 * which this tool wrote. The build's stdout is fed to a model as instructions by the
 * `SessionStart` hook, so a newline in any of that would let borrowed text forge a line that
 * reads as the tool's own report. Normalising once, at the render, covers every source at once
 * and cannot be forgotten by a new one.
 */
function oneLine(text: string): string {
  return text.replace(INVISIBLE, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/**
 * The three-channel discipline the contract puts on the tool as a whole, not on any one verb:
 * stdout so the agent can report it, stderr for a human running the command, a file because the
 * first two are frequently unread — and one write where the two streams name the same
 * destination, so nothing is said twice. A terminal is the familiar case of that; `> log 2>&1`,
 * `npm postinstall` and a hook capturing combined output are the ones that matter, because there
 * the duplicate is what the reader keeps.
 */
export function formatDiagnostic(entry: Diagnostic): string {
  const where: string[] = [];
  if (entry.skill !== undefined) where.push(entry.skill);
  if (entry.file !== undefined) {
    where.push(entry.line === undefined ? entry.file : `${entry.file}:${entry.line}`);
  } else if (entry.line !== undefined) {
    where.push(`line ${entry.line}`);
  }
  const location = where.length === 0 ? "" : ` [${where.join(" ")}]`;
  return oneLine(`composable-skills: ${entry.severity}${location} ${entry.message}`);
}

/**
 * The one place the stdout/stderr rule is applied. Everything the tool says goes through here, so
 * a verb can never grow its own opinion about which stream it writes to or how many times.
 */
function writeToStreams(text: string): void {
  if (streamsShareOneDestination()) {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
    process.stderr.write(text);
  }
}

/**
 * A verb's own output — `init`'s diff, `override`'s path — rather than a diagnostic about it. It
 * takes the same stream discipline and none of the rest: no `composable-skills:` prefix, because
 * these lines are the answer to what the developer asked rather than a remark about it, and no
 * log file, because `build.log` is the last *build*'s record and a human-run verb must not
 * overwrite it.
 */
export function emitLines(lines: string[]): void {
  if (lines.length === 0) return;
  writeToStreams(renderLines(lines));
}

/** The join every channel shares, so a line can never carry a newline of its own into the text. */
function renderLines(lines: string[]): string {
  return `${lines.map(oneLine).join("\n")}\n`;
}

/**
 * What the log records for a run that had nothing to say. The gated run over a healthy repo is
 * exactly that run, and it is the common case at every session start — so a log written only when
 * there were lines is a log that, once deleted, never comes back in the repos that are working.
 * The spec makes the file a record *that the build ran*, not only of what it complained about, so
 * the run is written down: a reader can tell a build that found nothing from one that never
 * happened, and the timestamp above it dates the last session either way. It goes to the file
 * alone, because saying nothing on stdout and stderr is the whole point of a gated run.
 */
const NOTHING_TO_REPORT = "composable-skills: nothing to report\n";

/**
 * `stateDirectory` is null for a run that must write no file — `--check` writes nothing, and a
 * run that never resolved a config has nowhere to write.
 */
export function emitReport(
  diagnostics: Diagnostic[],
  summary: string[],
  stateDirectory: string | null,
): void {
  const lines = [
    ...diagnostics.map(formatDiagnostic),
    ...summary.map((line) => `composable-skills: ${line}`),
  ];
  const text = lines.length === 0 ? "" : renderLines(lines);

  if (text !== "") writeToStreams(text);

  if (stateDirectory === null) return;
  try {
    ensureRealDir(stateDirectory);
    // A symlink removed here is deliberately not reported: this is the reporter, the report for
    // this run has already gone to the streams, and a diagnostic raised now has nowhere honest to
    // go. `writeStamp` names the one it removes, which covers the same planted-link attempt.
    const log = openForWriteNoFollow(path.join(stateDirectory, LOG_FILENAME), LOG_MODE);
    try {
      // Before the write, not after it: a pre-existing log left group- or world-readable must not
      // be readable for the span in which this run's diagnostics are landing in it.
      fs.fchmodSync(log.handle, LOG_MODE);
      const body = text === "" ? NOTHING_TO_REPORT : text;
      fs.writeFileSync(log.handle, `${new Date().toISOString()}\n${body}`, "utf8");
    } finally {
      fs.closeSync(log.handle);
    }
  } catch {
    // the log is a convenience; never let it break a build
  }
}

/**
 * Where a report goes when no `Config` was ever built — a crash that escaped the build. Resolved
 * from locations only, the same way `loadConfig` fixes the repo root, because the log file is the
 * only channel that survives an unexpected failure inside a session hook.
 */
export function crashStateDir(cwd: string = process.cwd()): string {
  const configPath = findConfigFile(cwd);
  const repoRoot = configPath === null ? findRepoRoot(cwd) : path.dirname(configPath);
  return stateDir(repoRoot);
}

/** The report a crash gets when it escapes the build before anything else could describe it. */
export function reportCrash(message: string, cwd?: string): void {
  let stateDirectory: string | null;
  try {
    stateDirectory = crashStateDir(cwd);
  } catch {
    stateDirectory = null;
  }
  emitReport([error(message)], [], stateDirectory);
}
