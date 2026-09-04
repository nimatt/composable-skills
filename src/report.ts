import fs from "node:fs";
import path from "node:path";

import type { Diagnostic } from "./types.ts";
import { error } from "./types.ts";
import { findConfigFile, findRepoRoot } from "./config.ts";
import { LOG_FILENAME, stateDir } from "./layout.ts";

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
  if (lines.length === 0) return;
  const text = renderLines(lines);

  writeToStreams(text);

  if (stateDirectory === null) return;
  try {
    fs.mkdirSync(stateDirectory, { recursive: true });
    const logPath = path.join(stateDirectory, LOG_FILENAME);
    fs.writeFileSync(logPath, `${new Date().toISOString()}\n${text}`, {
      encoding: "utf8",
      mode: LOG_MODE,
    });
    fs.chmodSync(logPath, LOG_MODE);
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
