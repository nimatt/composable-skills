# Changelog

Notable changes to this tool. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Nothing here is under a semver promise until `1.0.0`: while the major version is `0`, a minor
bump may change the directive syntax, the config schema or the verb surface.

## 0.0.1 — 2026-09-10

First published release. Three of the five specified verbs are implemented.

### Added

- `build [--check]` — discovers templates under the configured sources, resolves `slot` and
  `include` directives, merges each developer's overrides, and writes the compiled `SKILL.md`
  files to every configured target. `--check` reports whether the last build is still fresh
  without writing anything.
- `init [--write|--dry-run]` — sets up a consuming repo: a starting `composable-skills.jsonc`,
  the `.gitignore` entries for the generated targets, the Claude Code `SessionStart` hook that
  runs a build, and the `.worktreeinclude` patterns that carry the tool and the compiled skills
  into a worktree. An existing config is left exactly as it is.
- `override <skill> <slot> [--write|--dry-run]` — scaffolds a personal override for one slot of
  one skill.
- The build owns only what it wrote: every compiled skill carries an ownership marker, and a
  directory without one is never written to or pruned.

### Not yet implemented

- `lint` (Phase 4) and `explain [<skill>]` (Phase 5) are specified but absent; running either
  says so and exits non-zero.
- Codex targets are written on every build, but only the Claude Code hook is installed by `init`,
  so nothing triggers a build automatically for Codex.
