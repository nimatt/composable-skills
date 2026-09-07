# Plan: build the `composable-skills` CLI

**Status: historical.** This is the plan as it was written, before any of it existed as code. It is
kept for the intent and the order it argued for, with *as built* notes added inline where what
shipped departed from it. Phases 0 through 3 have since been built; Phases 4 and 5 have not. For
what the tool does today, read the tool contract rather than this plan.

## Objective

Ship the tool described in [`docs/specs/tool-contract.md`](../specs/tool-contract.md): a node
CLI that compiles skill templates into `SKILL.md`, merging a developer's personal overrides at
build time, so a skill can be extended at points its author declared without either side losing
the other's work.

The starting state, when this was written: a bare `bun init` scaffold — one commit, `index.ts`
printing `"Hello via Bun!"`, `package.json` `"private": true` with no `name`, `bin`, `exports`, or
`files`. Nothing of the design existed as code.

## Background

The *what* is settled and lives in [`docs/specs/tool-contract.md`](../specs/tool-contract.md).
The *why* is settled and lives in
[`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md).
Per-question evidence is in
[`docs/staging/qa-composable-skills-tooling.md`](../staging/qa-composable-skills-tooling.md).
This plan is only the *how* and the order.

One superseded document remains at the repo root for its evidence rather than its
conclusions: [`composable-agent-skills.md`](../../composable-agent-skills.md), the original
monorepo plan. The five-way adversarial review of it — since removed from the repo —
re-verified roughly 45 of ~55 factual claims and reproduced an empirical git-hook matrix
independently; that work stands. Its headline recommendation does not — it rests on reading
*"injected commands never prompt for permission"* as *"always run"*, when the mechanism is
fail-closed.

Facts that constrain the build, verified against Claude Code 2.1.237 and `codex-cli` 0.147.0:

- The published binary must run under plain **node**. `tsconfig.json` sets `"noEmit": true` and
  `allowImportingTsExtensions`, so it cannot emit as-is — a real build step is required. Bun
  stays the development runtime and test runner.
- Claude Code **does not watch** a top-level skills directory that did not exist at session
  start, so a fresh clone's first session sees nothing.
- Codex reads repo-level skills from **`.agents/skills`**, not `.codex/skills`. Medium-high
  confidence — docs plus binary strings, never executed.
- `.claude/skills` appears under `denyWithinAllow` in Claude Code's own sandbox policy, so an
  in-session build may hit `EPERM`.

## Approach

### Phase 0 — make this a package

Published **publicly to npm as `composable-skills`**, unscoped. The name is unclaimed
(`registry.npmjs.org/composable-skills` → 404 as of 2026-08-20). Publishing publicly makes
issue triage, a cross-platform CI matrix, and semver on the directive syntax into real
obligations, in a repo that ran no tests at the time — accepted deliberately.

- `package.json`: `"name": "composable-skills"`, drop `"private"`, add `bin`, `files`,
  `engines`, `license`, `repository`. No `main`, no `exports` for JS, no `.d.ts` — nothing
  imports this as a library, and inventing an entry point to justify `main` is the classic
  mistake. *As built: `repository` was deliberately left out. `git remote -v` is still empty, and
  a `repository` field pointing at a URL that does not exist is worse on the npm page than no
  field at all. Add it with the first remote.*
- Delete `index.ts`.
- Add a `LICENSE`, and rewrite `README.md` from the `bun init` boilerplate — both are the
  package page on npm, not just repo furniture.
- Add a `bun build --target=node` step emitting `dist/`.
- Add `*.md text eol=lf` and `*.tmpl text eol=lf` to a new `.gitattributes`. Without it,
  Git-for-Windows' `core.autocrlf` breaks the content hash the stamp gate depends on.

### Phase 1 — `build`

The compiler and the validator. Everything else is scaffolding around this.

1. **Config loading** — `id`, `sources`, `overrides`, `targets`, with the documented defaults.
2. **Frontmatter split** — hand-rolled, not a YAML dependency: it runs at every session start,
   and a YAML parser's tags and anchors are attack surface on a file the tool must treat as
   data. Parse into (frontmatter, body) *first*, expand only in the body, and assert the
   emitted frontmatter is byte-identical.
3. **Directive expansion** — `include:` with containment, then `slot` resolution across the
   override chain.
4. **Validator** — the reject/warn split from the spec, with **per-skill failure isolation**.
5. **Emit** — temp directory *inside* the destination, swap on success. Not `$TMPDIR`, which is
   frequently a different mount where the rename degrades to copy-then-unlink and a session
   starting mid-copy reads a truncated `SKILL.md`.
6. **Prune** — the builder owns its target directories: a template removed upstream must remove
   the compiled skill. The previous plan never stated this, which would have left deleted
   skills alive on every machine forever. Port the ownership model from
   `nimatt-skills/install.sh` — only touch what the tool wrote, never clobber a real directory.
7. **Stamp gate** — content hash of templates, config, overrides, and tool version. Normalise
   line endings before hashing.

Acceptance: compile a template with both directives, all three slot forms, and an override in
each of the three roots, and assert precedence matches the spec.

**As built.** Phase 1 is complete. It grew four things the seven items above never mention:

- **A build lock** in the state directory, taken with `mkdir` — the atomic primitive available on
  every supported platform — and broken automatically when its holder is provably dead or its
  timestamp is old, so two builds cannot run over each other and a killed build cannot wedge the
  repo. Best-effort by design: where the state directory cannot be written the build warns and
  proceeds unlocked, because refusing to build over a lock it could not take is the worse failure.
- **`build --check`.** The spec's verb table always carried it; the seven items did not.
- **The stamp is a *record*, not a bare hash.** It also carries which skills failed and what they
  said, so a gated run replays those diagnostics. Without that, one permanently broken template
  would suppress the stamp for the whole repo and force a full recompile at every session start,
  forever.
- **Line provenance.** Splicing a fragment moves text between coordinate spaces, so each line
  carries the file and line number it actually came from and every diagnostic is reported in
  those terms — never in the expanded body's coordinates, which are nobody's file.

It also left a **reporting seam** for two later verbs, which is worth recording so neither has to
re-derive it: `resolveSlot` is exported and returns the winning root alongside the text, and
`CompileResult` carries the slots a template declared plus what each one resolved to — slot name,
mode, and the override root that won or nothing for the template's default. Phase 3's `override`
can therefore seed a file with a slot's current default, and Phase 5's `explain` can say which
overrides are active and from where, without either re-running the compile pipeline by hand or
reaching into a private function. The data is there; neither verb is.

**A second fix pass** over Phase 1 then closed six things, all of them found by review rather
than by a failing test:

1. **A frontmatter hole.** Anything that pushed the opening `---` off line 1 — a UTF-8 BOM, a
   leading blank line — left the file with no frontmatter *region* at all, so every guard on
   that region passed vacuously and a slot between the fences became ordinary body an override
   could fill. The BOM is now stripped; any other fence reached before the first non-blank
   content is refused, which closes the shape rather than the two known routes into it.
2. **Output content hashing**, rather than only checking that the output is present.
3. **A third route past the prune guard**, where a config that lost its `sources` key reads
   exactly like a corpus emptied on purpose.
4. **An override root that is itself a symlink**, which widened containment to wherever it
   pointed. Source roots stay exempt — a symlinked package directory is ordinary under pnpm.
5. **A lock wedge**, where a *file* at `.composable-skills` made the state directory's failure
   indistinguishable from a held lock, so every session reported a lock that did not exist and
   compiled nothing, forever. Only an `EEXIST` on the lock directory now reads as held.
6. **Duplicate diagnostics**, where the two output streams share one destination. The test was
   "both are a TTY"; it is now whether the descriptors share a `dev`/`ino`, which also covers
   `> log 2>&1`, `npm postinstall`, and a hook capturing combined output — the cases where the
   duplicate is what the reader keeps.

**Still open, deliberately.** Splitting the line-assembly machinery — `SourceLine`,
`LineWriter`, edge-trimming — out of `directives.ts`, so directive *parsing* stops sharing a file
with the primitives `include:` and `slot` both build on. It was scoped out of the fix pass rather
than deferred by accident: that pass was a fixed list of findings and this is a refactor, not one
of them. It was to land **before Phase 2's `init`**, while `directives.ts` still had few callers;
Phase 2 shipped without it, so that window has closed. Still open, and no worse for it — the
module's callers in `src/` are still only two, `validate.ts` and the `compile.ts` later split out
of `build.ts`, since neither `init.ts` nor `override.ts` imports it.

> **Do not read `src/layout.ts` as this item.** That file exists and is *filesystem* layout — the
> path and filename constants, `stateDir`, `toolVersion`. The name collides; the work does not.
> Pick a different name for the extraction.

The companion finding — two `normaliseEol` implementations with nothing pinning their
equivalence — is **closed**, and closed structurally rather than by a test: both now live in
`src/text.ts`, and the string form is *defined over* the byte form. The compiler reads text while
the stamp hashes bytes, so two implementations that agree today would decide staleness on
different content the day they stopped agreeing, and nothing would report it. One implementation
cannot drift from itself.

Two findings from the second review pass remain genuinely open, both narrow and both recorded
against the tool rather than closed quietly: a **hardlink inside an override root**, which the
symlink discipline does not catch, and **forged lock info evicting a live holder** — the fix pass
clamped a future timestamp, which is the wedge, not the eviction. See
[*Outstanding review findings*](../staging/implement-composable-skills-tooling.md#outstanding-review-findings-second-pass--not-addressed)
in the staging notes for the full record and the per-item status.

### Phase 2 — `init` and the hook

- `init` writes the config, the `.gitignore` line, and the `SessionStart` hook entry. Diff-first,
  nothing without `--write`, and never outside the repo it runs in.
- **The hook command is
  `node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build`.**
  `$CLAUDE_PROJECT_DIR` is written **literally**, and Claude Code expands it at session start.
  The reason is not byte-stability across worktrees — `.claude/settings.json` is a **tracked**
  file, so a resolved absolute path would be committed and would be wrong for every other clone
  on the team. Byte-stability is satisfied either way, since neither form changes spontaneously.

  Why this form, over two alternatives that were measured or scoped out:

  | Form | Per invocation | Verdict |
  |---|---|---|
  | `npx --no-install composable-skills` | **~378 ms** | rejected — ~290 ms of pure resolution overhead every session, 15× the stamp check it guards |
  | `node_modules/.bin/composable-skills` | ~85 ms | rejected — a `.cmd`/`.ps1` shim on Windows, needing a separate Codex `commandWindows` |
  | `node "<path>/dist/cli.js"` | **~28 ms** | chosen — fastest, and identical on every platform |

- **Windows is supported.** The `node <path>` form avoids the shim-extension problem entirely;
  forward slashes in the JSON string work on Windows.
- **Yarn PnP is out of scope.** It has no `node_modules`, so every path-based form breaks.
  `init` detects `.pnp.cjs` and **fails loudly with an explanation** rather than writing a
  command that silently never runs.
- **Install as a devDependency only.** No global-install path, so resolution is always
  repo-relative. This also pins the tool's version alongside the templates it compiles.
- **A `git worktree` needs its own install.** `git worktree add` produces a tree with no
  `node_modules`, so the hook's target is absent and it fails at every session start — silently,
  since it is fail-soft. This is a real limitation and not a bug to fix in the string: ADR-0001's
  headline *"personal overrides survive `git worktree add`"* is about override resolution, which
  is keyed on the declared `id`; the hook resolves through the filesystem. `init` should detect
  the missing target and say so.
- A `postinstall` build for the fresh-clone case. It **must be fail-soft**: the motivating repo
  has four Dockerfiles running `bun install --frozen-lockfile` without `--ignore-scripts`, and
  `postinstall` is skipped entirely where `ignore-scripts` is set — so it is a mitigation, never
  a guarantee. *As built: declined — see the Phase 2/3 note below.*

### Phase 3 — `override`

Computes the highest-precedence override root, creates the directory, **seeds the file with the
slot's current default**, and prints the path. The seeding is not a convenience: it is what
defuses replace-by-default, by making the developer edit the text they are replacing rather
than write blind into an empty file. *As built: the seeding rule is "what currently resolves",
of which the current default is one case — see below.*

### Phase 2/3 — as built

**Both phases are complete**, for **Claude Code only**. `src/init.ts` and `src/override.ts` exist,
`src/cli.ts` dispatches all three working verbs, and `README.md` was rewritten. The behavioural
contract for both verbs is
[the spec's *Public API*](../specs/tool-contract.md#public-api) — this note records only where
what was built departs from what this plan said, and why.

- **`postinstall` was declined, not deferred.** The reasons that hold are the ones above:
  `package.json` is a repo's identity and a riskier merge than `settings.json`, many consuming
  repos are not npm packages at all, and `--ignore-scripts` voids it. (A fourth argument was
  advanced during the pass — that a consuming repo which is *itself* a published package would
  compile into its dependents' trees — and does **not** reproduce as stated: with no config
  shipped, no source root resolves and nothing is compiled. What it does leave behind is a stray
  `.composable-skills/` state directory at the dependent repo's root, which is real but smaller.)
  In its place, **`build` names any target directory that did not exist before the run**, which
  reaches the cloner in the session where it matters rather than the maintainer once. ADR-0001's
  fresh-clone consequence was updated to match.
- **`$CLAUDE_PROJECT_DIR` is written literally**, per the corrected bullet above.
- **The seeding rule is "what currently resolves"**, and specifically the winning override file's
  *own* lines rather than the composed result. That makes `mode=append` — created empty where
  nothing overrides the slot yet — a case of the rule rather than an exception to it, and it is
  what buys the property the seeding exists for: an unedited `override` followed by a build
  produces a byte-identical compiled skill, in both modes. The plan's Phase 3 line, which named
  the template's default unconditionally, would have dropped a *tracked* override root's text on
  the next build.
- **The Codex hook is deferred by explicit user decision.** Nothing Codex-shaped was built "for
  later"; `.codex/hooks.json` is untouched, and the open question below about what Codex expands
  in a hook command therefore stays open rather than being answered by this work.
- `init` grew a set of refusals and warnings this plan never enumerated — a home-directory repo
  root, both Yarn PnP spellings searched to the git root, an unwritable or symlinked or
  comment-carrying `settings.json`, a hook already installed under another command string, a
  missing `node_modules/composable-skills/dist/cli.js`. They are listed in the spec, not here.

**Remaining: Phase 4 (`lint`) and Phase 5 (`explain`).** Both are stubs that print the phase they
are planned for and exit non-zero.

### Phase 4 — `lint`

The template validator without the build, for a skills repo's CI. Non-zero on any rejection.
This is the only channel where a warning reliably reaches a human, since build output goes to a
session hook nobody reads.

### Phase 5 — `explain`

Provenance: which source a skill came from, which overrides are active and from which root,
which slots exist and which are filled. Ships last and stays small — it is a last resort when
something is already confusing, and nothing else in the design may depend on it being run.

### Files touched

| Path | Change |
|---|---|
| `package.json` | drop `private`; add `name`, `bin`, `files`, `engines`, `build`, `typecheck` and `prepack` scripts |
| `index.ts` | delete |
| `.gitattributes` | new — `*.md text eol=lf`, `*.tmpl text eol=lf` |
| `tsconfig.src.json` | new — typechecks `src/` under node's resolution, separately from the bun-typed tests |
| `src/cli.ts` | new — verb dispatch |
| `src/types.ts` | new — shared shapes and the `error`/`warning` diagnostic constructors |
| `src/config.ts` | new — config load, defaults, `${home}`/`${id}` expansion |
| `src/frontmatter.ts` | new — hand-rolled split, byte-identity assertion |
| `src/directives.ts` | new — `slot` and `include` parsing, containment |
| `src/build.ts` | new — resolution, emit, prune, stamp, lock |
| `src/layout.ts` | new — filesystem layout: path and filename constants, `stateDir`, `toolVersion` |
| `src/text.ts` | new — line-ending and BOM normalisation, one implementation over bytes |
| `src/validate.ts` | new — reject/warn split, per-skill isolation |
| `src/report.ts` | new — the three-channel diagnostic report and the crash path |
| `src/init.ts` | new — config, hook entry, gitignore; diff-first |
| `src/override.ts` | new — path derivation, seeding |
| `src/explain.ts` | new — provenance |
| `README.md` | rewrite — at the time the `bun init` boilerplate |

## Open questions

**What does Codex expand in a hook command?** `$CLAUDE_PROJECT_DIR` is Claude-specific, so the
`.codex/hooks.json` entry needs either its own variable or an absolute path. This does not change
the strategy, only the literal string `init` writes for that harness. **Still open.** Phase 2
wrote the Claude Code hook only, and the Codex hook was deferred by explicit user decision rather
than blocked on this — so the question is now a prerequisite for that work rather than for Phase
2, and nothing Codex-shaped was built ahead of the answer.

**Does `.agents/skills` actually work for repo-level Codex skills?** Drop a `SKILL.md` at
`<repo>/.agents/skills/x/` and launch `codex`. Two minutes, never executed, and both prior
documents had the path wrong. **Blocks shipping a Codex target, nothing else.**

**Does an in-session `build` hit `EPERM`?** `.claude/skills` is under `denyWithinAllow` in
Claude Code's sandbox policy. If the agent cannot write there, fail-soft will swallow it
silently — which is exactly the case where the diagnostic file earns its place. It was to be
answered during Phase 2, since it needs a sandboxed in-session run rather than a test — the same
session `init` has to write a working hook for. **Phase 2 shipped without answering it, and it
stays open.** `init --write` was deliberately never run against this repo, so no session has yet
started under a hook this tool wrote.

**Is there a team?** `git log --format='%an'` on the skills corpus returns four commits by one
author, and `git remote -v` is empty. Two reviewers searched 2,143 lines of real skills for
something that wanted a per-developer slot and found only per-repo variation, all already solved
by other means. That does not argue against the requirement — the corpus is far too young to
show divergence even if it is coming — but it argues that **slots should be authored on request,
sparingly, rather than sprinkled prophylactically.** Each one is an extension point with
invisible consumers. **Blocks nothing; shapes how the first templates are written.**

## Out of scope

- **Plugin and marketplace manifest generation.** Delivery is the skills-repo team's decision.
  Recorded because it was a previous revision's anchor use case: a marketplace entry's `skills[]`
  array silently drops any skill missing from it, which is a real failure that now belongs to
  whoever builds a skills repo's release process.
- **Override staleness tracking.** See ADR-0001. The design prefers empty-default slots, where
  nothing can drift.
- **Guardrail protection.** Advisory documentation only.
- **Consuming-repo hygiene** — `permissions.deny`, CODEOWNERS, `.gitignore` beyond the one line
  `init` offers, `enableAllProjectMcpServers`.
- **Evals.** A tool whose output is prose that changes model behaviour has no test story here,
  and this plan does not invent one.

## See Also

- [`docs/specs/tool-contract.md`](../specs/tool-contract.md) — the contract being implemented
- [`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md) — why
- [`docs/staging/qa-composable-skills-tooling.md`](../staging/qa-composable-skills-tooling.md) — evidence
- [`docs/CONTEXT.md`](../CONTEXT.md) — glossary
