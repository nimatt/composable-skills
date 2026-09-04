import os from "node:os";
import path from "node:path";

import type { Diagnostic } from "./types.ts";
import { describe, error, warning } from "./types.ts";
import { parseJsonc } from "./config.ts";
import type { InitStep } from "./steps.ts";
import { firstSymlinkComponent, symlinkRefusal, unreadableRefusal } from "./steps.ts";
import { applyEol, dominantEol, readIfPresent } from "./textfile.ts";

/**
 * Written literally and byte-stably. Codex pins hook trust to the hash of the command string, so
 * a string that changes spontaneously re-prompts every developer on the team; that is also why no
 * behaviour is expressed as a flag here — all logic lives in the tool. `$CLAUDE_PROJECT_DIR` is
 * expanded by Claude Code, which keeps the string identical in every clone and every worktree.
 */
export const HOOK_COMMAND =
  'node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build';

export const SETTINGS_REL = ".claude/settings.json";

/**
 * Read for detection and never written. Claude Code merges hooks from the project file, this one,
 * and the user-level file, so a hook already present in either of the other two is a hook this
 * repo does not need a second copy of.
 */
export const LOCAL_SETTINGS_REL = ".claude/settings.local.json";

/** What `HOOK_COMMAND` will resolve to at session start, once `$CLAUDE_PROJECT_DIR` is expanded. */
export const CLI_REL = "node_modules/composable-skills/dist/cli.js";

/** U+FEFF, spelled rather than written, since the character itself is invisible in this file. */
const BOM = "\uFEFF";

export function settingsStep(repoRoot: string, diagnostics: Diagnostic[]): InitStep {
  const target = path.join(repoRoot, SETTINGS_REL);

  /**
   * Before the file is read rather than after, so that every verdict below is a verdict about a
   * file inside this repo. Reading through `.claude -> ~/dotfiles/claude` and then reporting on
   * what was found there describes — and offers remedies for — someone else's file.
   */
  const hop = firstSymlinkComponent(repoRoot, target);
  if (hop !== null) return symlinkRefusal(target, hop, repoRoot, diagnostics);

  warnAboutMergedSettings(repoRoot, diagnostics);

  const raw = readIfPresent(target);
  if (raw.kind === "unreadable") return unreadableRefusal(target, raw.cause, diagnostics);
  if (raw.kind === "absent") {
    return {
      path: target,
      before: null,
      after: `${JSON.stringify({ hooks: { SessionStart: [hookGroup()] } }, null, 2)}\n`,
      note: "created",
    };
  }

  const before = raw.text;
  /**
   * A BOM is stripped and re-emitted rather than rejected, the same way the frontmatter rule
   * treats one: a Windows editor or a PowerShell redirect writes it invisibly, and the file the
   * developer sees is the file this should read.
   */
  const bom = before.startsWith(BOM) ? BOM : "";
  const body = before.slice(bom.length);
  const eol = dominantEol(body);
  const emit = (value: unknown): string => `${bom}${applyEol(stringifyLike(body, value), eol)}`;

  /**
   * `touch .claude/settings.json` produces a file with nothing in it to preserve, so there is
   * nothing for a refusal to protect.
   */
  if (body.trim() === "") {
    return {
      path: target,
      before,
      after: `${bom}${applyEol(`${JSON.stringify({ hooks: { SessionStart: [hookGroup()] } }, null, 2)}\n`, eol)}`,
      note: "was empty — written with only our hook",
    };
  }

  const refuse = (why: string): InitStep => {
    diagnostics.push(
      error(
        `${target} ${why} — init will not rewrite it. Add this to hooks.SessionStart by hand: ` +
          JSON.stringify(hookGroup()),
      ),
    );
    return { path: target, before, after: null, note: why, refused: true };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    /**
     * A settings file with comments in it parses under our JSONC reader and would round-trip
     * through `JSON.stringify` with every comment deleted. Silently destroying a developer's
     * annotations is exactly the first-contact damage this verb must not do, so it is refused
     * with the same finality as a syntax error.
     */
    if (parsesAsJsonc(body)) {
      return refuse("contains comments or trailing commas, which a rewrite would delete");
    }
    return refuse(`is not valid JSON (${describe(cause)})`);
  }
  if (!isPlainObject(parsed)) return refuse("does not contain a JSON object");

  const rawHooks = parsed["hooks"];
  if (rawHooks !== undefined && !isPlainObject(rawHooks))
    return refuse('has a "hooks" key that is not an object');
  const hooks = isPlainObject(rawHooks) ? rawHooks : {};

  const rawSessionStart = hooks["SessionStart"];
  if (rawSessionStart !== undefined && !Array.isArray(rawSessionStart)) {
    return refuse('has a "hooks.SessionStart" key that is not an array');
  }
  const sessionStart = Array.isArray(rawSessionStart) ? rawSessionStart : [];
  if (!sessionStart.every(isHookGroup)) {
    return refuse('has a "hooks.SessionStart" entry this tool does not recognise');
  }

  const commands = sessionStart.flatMap((group) =>
    (group["hooks"] as Record<string, unknown>[]).map((entry) => entry["command"]),
  );
  if (commands.includes(HOOK_COMMAND)) {
    return { path: target, before, after: null, note: "the SessionStart hook is already there" };
  }
  /**
   * A near-miss is not an absence. A hook that runs this tool under a different string — an older
   * `init`'s resolved path, a hand-written entry — already rebuilds every session, and appending
   * ours beside it would build twice per session forever. Reported, and left to the developer,
   * because only they know which string they meant to keep.
   */
  const existing = commands.find(
    (command) => typeof command === "string" && invokesThisTool(command),
  );
  if (typeof existing === "string") {
    diagnostics.push(
      warning(
        `${target} already runs this tool at SessionStart under a different command string ` +
          `(${existing}) — left alone rather than adding a second hook that would build twice ` +
          `every session. The string init writes is: ${HOOK_COMMAND}`,
      ),
    );
    return {
      path: target,
      before,
      after: null,
      blocked: true,
      note: "NOT installed — this repo already runs the tool under another command string",
    };
  }

  const next: Record<string, unknown> = { ...parsed };
  next["hooks"] = { ...hooks, SessionStart: [...sessionStart, hookGroup()] };
  return {
    path: target,
    before,
    after: emit(next),
    note: "the SessionStart hook is appended; every other key is preserved",
  };
}

/**
 * Whether a command line *runs this tool*, as opposed to merely containing its name. The two are
 * easy to confuse and expensive to confuse: matching the bare name anywhere in the string makes
 * `echo building composable-skills docs` — or any path under a directory of that name — look like
 * an installed hook, which silently cancels the one thing this verb exists to do.
 */
export function invokesThisTool(command: string): boolean {
  const tokens = tokenise(command).map((token) => token.replaceAll("\\", "/"));
  return tokens.some((token, index) => {
    if (token.endsWith(INSTALLED_TAIL)) return true;
    const segments = token.split("/");
    const base = segments[segments.length - 1] ?? "";
    /**
     * The bin shim, or this tool's entry point reached by some other path — always with the verb
     * after it, because a bare word is a word and only an argv position makes it a program.
     */
    const runsIt =
      base === "composable-skills" ||
      base === "composable-skills.cmd" ||
      (base === "cli.js" && segments.slice(0, -1).includes("composable-skills"));
    return runsIt && tokens[index + 1] === "build";
  });
}

/** `composable-skills/dist/cli.js` — the tail of `CLI_REL` that identifies an installed copy. */
const INSTALLED_TAIL = CLI_REL.split("/").slice(-3).join("/");

/** Enough shell to tell one argv word from the next; quoting is all this needs to survive. */
function tokenise(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let open = false;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) tokens.push(current);
      current = "";
      open = false;
      continue;
    }
    current += ch;
    open = true;
  }
  if (open) tokens.push(current);
  return tokens;
}

/**
 * Claude Code merges `hooks` from the project settings, the untracked local settings, and the
 * user-level file. `init` writes only the first, but a hook already present in either of the
 * others builds twice at every session start, and nothing else would ever say so. Read-only, in
 * both directions: neither file is ever written, and neither one stops the project file's merge.
 */
function warnAboutMergedSettings(repoRoot: string, diagnostics: Diagnostic[]): void {
  const elsewhere = [
    {
      path: path.join(repoRoot, ...LOCAL_SETTINGS_REL.split("/")),
      whose: "this repo's untracked personal settings",
    },
    {
      path: path.join(os.homedir(), ".claude", "settings.json"),
      whose: "your user-level settings",
    },
  ];
  for (const candidate of elsewhere) {
    const read = readIfPresent(candidate.path);
    /**
     * Neither file is this tool's to write, so an unreadable one cannot be refused the way the
     * project file is — but it is the one file that could have made this repo build twice, and
     * saying nothing would report a clean run that was never checked.
     */
    if (read.kind === "unreadable") {
      diagnostics.push(
        warning(
          `${candidate.path} — ${candidate.whose} — exists but could not be read ` +
            `(${describe(read.cause)}), so init could not check whether a hook there already runs ` +
            "this tool. If one does, wiring this repo up as well builds twice at every session " +
            "start. init never writes that file either way.",
        ),
      );
      continue;
    }
    if (read.kind === "absent") continue;
    if (!sessionStartCommands(read.text).some(invokesThisTool)) continue;
    diagnostics.push(
      warning(
        `${candidate.path} — ${candidate.whose} — already runs this tool at SessionStart. Claude ` +
          "Code merges hooks from every settings file it reads, so wiring this repo up as well " +
          "builds twice at every session start. init only read that file and will never write it.",
      ),
    );
  }
}

/** Every SessionStart command string a settings file holds, or none where it does not parse. */
function sessionStartCommands(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text.startsWith(BOM) ? text.slice(BOM.length) : text);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const hooks = parsed["hooks"];
  if (!isPlainObject(hooks)) return [];
  const sessionStart = hooks["SessionStart"];
  if (!Array.isArray(sessionStart)) return [];
  return sessionStart.flatMap((group) => {
    if (!isPlainObject(group)) return [];
    const entries = group["hooks"];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      if (!isPlainObject(entry)) return [];
      const command = entry["command"];
      return typeof command === "string" ? [command] : [];
    });
  });
}

/** No matcher: a SessionStart hook with none runs for every session source, which is the intent. */
function hookGroup(): Record<string, unknown> {
  return { hooks: [{ type: "command", command: HOOK_COMMAND }] };
}

function isHookGroup(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const entries = value["hooks"];
  return Array.isArray(entries) && entries.every(isPlainObject);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsesAsJsonc(text: string): boolean {
  try {
    parseJsonc(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Round-tripping JSON is the most a merge can preserve, so it preserves what it can: the file's
 * own indentation and whether it ended with a newline. Key order survives `JSON.parse` for every
 * key that is not an array index, which covers a settings file.
 */
function stringifyLike(original: string, value: unknown): string {
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? "  ";
  const text = JSON.stringify(value, null, indent);
  return original.endsWith("\n") ? `${text}\n` : text;
}
