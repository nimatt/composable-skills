#!/usr/bin/env node
import { runBuild } from "./build.ts";
import { runInit } from "./init.ts";
import { runOverride } from "./override.ts";
import { toolVersion } from "./layout.ts";
import { reportCrash } from "./report.ts";
import { describe } from "./types.ts";

const USAGE = `composable-skills — compile skill templates into SKILL.md

Usage:
  composable-skills build [--check]      compile every skill to every target
  composable-skills init [--write|--dry-run]
                                         wire this repo up: config, .gitignore, SessionStart hook
  composable-skills override <skill> <slot> [--dry-run|--write]
                                         create the override file for a slot, seeded with its
                                         current default, in the highest-precedence root
  composable-skills lint                 not implemented yet (planned for phase 4)
  composable-skills explain [<skill>]    not implemented yet (planned for phase 5)

Options:
  -h, --help       show this message, or the same message after any verb
  -v, --version    print the tool version

build always exits 0 so a session hook can never break a session.
build --check writes nothing and exits non-zero when the output is stale.

The two writing verbs default in opposite directions, because they do different things:
init merges into files the repo already has and tracks, so it shows the diff and writes
nothing without --write; override only ever creates one file, and refuses to overwrite an
existing one, so it writes by default. Each accepts the other's flag as an explicit spelling
of its own default — init --dry-run and override --write both say what would happen anyway.
`;

const PLANNED: Record<string, number> = {
  lint: 4,
  explain: 5,
};

const KNOWN = new Set(["build", "init", "override", ...Object.keys(PLANNED)]);

/**
 * The two writing verbs default in opposite directions for a real reason — see USAGE — but the
 * vocabulary is shared, so neither spelling is ever a typo: each verb accepts the other's flag as
 * an explicit statement of its own default, and only the *contradiction* is an error.
 */
function resolveWrite(verb: string, flags: string[], byDefault: boolean): number | boolean {
  const wants = flags.includes("--write");
  const dry = flags.includes("--dry-run");
  if (wants && dry) return usageError(`${verb} cannot take both --write and --dry-run`);
  return wants ? true : dry ? false : byDefault;
}

function usageError(message: string): number {
  process.stderr.write(`composable-skills: ${message}\n\n${USAGE}`);
  return 2;
}

export function main(argv: string[]): number {
  const args = argv.slice(2);
  const verb = args[0];

  if (verb === undefined || verb === "--help" || verb === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (verb === "--version" || verb === "-v") {
    process.stdout.write(`${toolVersion()}\n`);
    return 0;
  }

  const rest = args.slice(1);

  /**
   * `--help` after a verb is a request for help, not a mistake to be punished with a usage error
   * and exit 2. There is one usage text, so every verb answers with it.
   */
  if (KNOWN.has(verb) && rest.some((argument) => argument === "--help" || argument === "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (verb === "build") {
    const [unknownFlag] = rest.filter((flag) => flag !== "--check");
    if (unknownFlag !== undefined) return usageError(`unknown option "${unknownFlag}"`);
    const check = rest.includes("--check");
    try {
      return runBuild({ check });
    } catch (cause) {
      reportCrash(`build failed: ${describe(cause)}`);
      return check ? 1 : 0;
    }
  }

  if (verb === "init") {
    const [unknownArgument] = rest.filter(
      (argument) => argument !== "--write" && argument !== "--dry-run",
    );
    if (unknownArgument !== undefined) {
      return usageError(`init takes only --write or --dry-run, not "${unknownArgument}"`);
    }
    const write = resolveWrite("init", rest, false);
    if (typeof write === "number") return write;
    try {
      return runInit({ write });
    } catch (cause) {
      reportCrash(`init failed: ${describe(cause)}`);
      return 1;
    }
  }

  if (verb === "override") {
    const flags = rest.filter((argument) => argument.startsWith("-"));
    const positional = rest.filter((argument) => !argument.startsWith("-"));
    const [unknownFlag] = flags.filter((flag) => flag !== "--dry-run" && flag !== "--write");
    if (unknownFlag !== undefined) return usageError(`unknown option "${unknownFlag}"`);
    const [skill, slot, extra] = positional;
    if (skill === undefined || slot === undefined || extra !== undefined) {
      return usageError("override takes exactly two arguments: <skill> <slot>");
    }
    const write = resolveWrite("override", flags, true);
    if (typeof write === "number") return write;
    try {
      return runOverride({ skill, slot, dryRun: !write });
    } catch (cause) {
      reportCrash(`override failed: ${describe(cause)}`);
      return 1;
    }
  }

  const phase = PLANNED[verb];
  if (phase !== undefined) {
    process.stderr.write(
      `composable-skills: ${verb} is not implemented yet (planned for phase ${phase})\n`,
    );
    return 1;
  }

  return usageError(`unknown command "${verb}"`);
}

process.exitCode = main(process.argv);
