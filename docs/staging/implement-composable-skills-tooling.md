# Implementation notes — `composable-skills` CLI

Working notes for the `/implement-plan` run against
[`docs/plans/composable-skills-tooling.md`](../plans/composable-skills-tooling.md).
Contract: [`docs/specs/tool-contract.md`](../specs/tool-contract.md).
Rationale: [`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md).

Subagents append here. The user reviews after the run and promotes anything that should
become an ADR, a spec change, or a follow-up plan.

---

## Pre-implementation

**Plan:** `docs/plans/composable-skills-tooling.md`
**Started:** 2026-08-20
**Repo state at start:** one commit (`8ee3b10`), no `src/`. Untracked and pre-existing:
`REVIEW-FINDINGS.md`, `composable-agent-skills.md`, `docs/`. Not touched by this run.

### Assumptions

- **Zero runtime dependencies.** The plan mandates a hand-rolled frontmatter parser to avoid a
  YAML dependency; that reasoning (this runs at every session start, and the input is untrusted
  data) generalises. Everything is bundled to `dist/` regardless, so a dependency would also
  cost startup time on the hot path.
- **TypeScript, ESM, bundled with `bun build --target=node`.** `dist/cli.js` carries a shebang.
  `bin` stays in `package.json` for `npx` and `.bin` use even though the hook invokes
  `node dist/cli.js` directly.
- **`engines.node >= 20`.** Nothing in the design needs newer, and 20 is the oldest maintained
  line.
- **Templates live at `<source>/<skill>/SKILL.md.tmpl`.** Inferred from the plan's
  `.gitattributes` line adding `*.tmpl text eol=lf`. See open questions — this is a guess.
- **Everything else in a skill directory is copied verbatim** to each target — `references/`,
  scripts, assets. Only `SKILL.md.tmpl` is compiled. The spec does not say this explicitly, but
  a skill whose `references/` files did not travel would be broken.
- **`bun test` unit tests are in scope for Phase 1.** The plan states a Phase 1 acceptance
  criterion — "compile a template with both directives, all three slot forms, and an override in
  each of the three roots, and assert precedence matches the spec" — which is a test by any
  reading. Resolution precedence is not verifiable by inspection.
- **Config accepted as `composable-skills.jsonc` or `.json`**, with a comment-stripping pass that
  correctly ignores `//` and `/* */` inside string literals.
- **`repository` is omitted from `package.json`** — `git remote -v` is empty, so there is no
  honest value to put there.

### Open questions

- **Template file naming.** `SKILL.md.tmpl` (assumed) versus plain `SKILL.md` in the source
  tree. `.tmpl` disambiguates template from compiled output, which matters in a skills repo
  where both live in one tree; plain `SKILL.md` keeps the source readable by tools that
  understand skills. **Resolving toward `.tmpl` on the `.gitattributes` evidence.**
- **Stamp file location.** Unspecified. Proposing a single gitignored dot-file at the repo root
  rather than one per target, since the stamp covers inputs, not outputs.
- **Diagnostics file location.** The spec says diagnostics go to "a file" without naming it.
  Proposing it sits next to the stamp.
- **Codex hook variable expansion.** `$CLAUDE_PROJECT_DIR` is Claude-specific. Already an open
  question in the plan; blocks only the `.codex/hooks.json` half of Phase 2.

### Concerns / risks

- **The spec has never been executed.** It is detailed, but several mechanical details are
  underspecified (template naming, stamp and diagnostic paths, non-`SKILL.md` file handling).
  Each is being decided during implementation and logged here rather than guessed silently.
- **Scope of a single run.** Six phases through a subagent workflow is a large, expensive run.
  Phases 0–1 are the acceptance-testable core; 2–5 are additive verbs on top of it.
- **Windows is in scope but untestable here.** Path handling, the hook string, and containment
  checks must be written for it, but this is a Linux machine — correctness rests on using
  `node:path` correctly rather than on verification.

---

## Phase 0 — package scaffolding

- **Assumption:** removed the scaffold's `"module": "index.ts"` from `package.json`. It pointed
  at the deleted `index.ts`, and the plan is explicit that nothing imports this as a library.
  If a library entry point is ever wanted, it comes back as a deliberate `exports` block, not as
  a resurrected `bun init` leftover.
- **Assumption:** the `description` is a one-line paraphrase of the spec's Overview ("a node CLI
  that compiles skill templates into `SKILL.md` files and writes them where an agent harness
  will find them"). It is the npm package-page subtitle, so it must stay true if the Overview
  is reworded.
- **Assumption:** keywords are `skills`, `agent-skills`, `claude-code`, `codex`, `cli`. `codex`
  is the weakest of the five — the Codex target is still gated on the open `.agents/skills`
  question, so if that target is dropped the keyword should go with it.
- **Assumption:** `"version": "0.0.0"` marks unreleased, per the task. The first publish needs a
  real version chosen deliberately; `0.0.0` must never reach the registry as-is.
- **Assumption:** `tsconfig.json` was left completely untouched. It is already coherent for a
  `src/` layout bundled by Bun — `noEmit` is correct because Bun's bundler emits, not tsc, and
  no `outDir` is needed for the same reason. `allowImportingTsExtensions` is consistent with
  `moduleResolution: "bundler"` and `noEmit`.
- **Open question:** `tsconfig.json` has no `include`/`exclude` and sets `allowJs: true`, so a
  future `tsc --noEmit` typecheck script would also pull in the bundled output under `dist/`.
  Harmless today (there is no typecheck script and `dist/` is gitignored), but adding
  `"include": ["src"]` when a typecheck script lands would resolve it. Left alone here to honour
  the change-as-little-as-possible instruction.
- **Open question:** nothing yet guarantees `dist/` is built before publish. `files: ["dist"]`
  plus a gitignored `dist/` means `npm publish` from a clean clone would ship an empty package.
  A `prepublishOnly` (or `prepack`) script running the build would resolve it — deliberately not
  added here, since release process is outside Phase 0's stated scope.
- **Open question:** `bin` points at `./dist/cli.js`, which only works as a `bin` target if the
  bundled file carries a shebang. Phase 1 owns that; recorded here because the `bin` entry is a
  standing promise that Phase 1 must keep.

## Phase 0 — LICENSE and README

Files written: `LICENSE` (MIT, 2026 Mattias Nilsson, verbatim standard text) and `README.md`
(complete rewrite of the `bun init` boilerplate, ~185 lines). Nothing else touched.

### Assumptions

- **Templates live at `<source>/<skill>/SKILL.md.tmpl`.** The README's worked example shows
  `skills/templates/code-review/SKILL.md.tmpl`. This mirrors the assumption already logged under
  *Pre-implementation* rather than introducing a second one; the spec names no template
  filename. If Phase 1 settles on plain `SKILL.md` in the source tree, one line of the README
  example changes.
- **`mode` defaults to `replace`.** Stated as such in the README. This follows
  `docs/specs/tool-contract.md`, which is explicit, and contradicts `docs/CONTEXT.md`, which
  defines **Slot** as having "a mode — `append` (default) or `replace`". Treated the spec as
  authoritative because it argues the point ("Declaring a slot states that its content is the
  developer's to specify") while the glossary states it in passing. **The glossary line should
  be corrected**; the README is wrong the moment that resolves the other way.
- **The README makes no claim about blank-line or whitespace handling around expanded
  directives.** The compiled-output block in the example is spaced the way a reader would
  expect, but the spec specifies nothing here, so no surrounding prose asserts it. If Phase 1
  produces materially different spacing (e.g. an empty slot leaving two blank lines), the
  example block should be regenerated from real output rather than hand-corrected.
- **Default `overrides` precedence order is presented as the spec's example list.** The spec
  says defaults are "`overrides` as shown", referring to the config example
  `["${home}/global", "./.claude/skills-local", "${home}/repos/${id}"]`, and that later entries
  win. The README therefore lists highest-precedence-first as `${home}/repos/<id>`, then
  `./.claude/skills-local`, then `${home}/global`. If "as shown" was meant loosely, this whole
  ordering is wrong in a way a reader would act on.
- **Doc links are repo-relative** (`docs/specs/tool-contract.md`, not a GitHub URL). Correct in
  the repo; on the npm package page these render as dead links, since `files: ["dist"]` means
  `docs/` is not published. Absolute URLs would fix it but there is no remote yet
  (`git remote -v` is empty), so there is no honest URL to write. **Revisit before first
  publish.**
- **The README documents `build`, `init`, `override`, `lint`, `explain` with an explicit
  built/planned split**, rather than omitting the unbuilt verbs. Omitting them would have made
  the "Status" section unable to say what the tool is going to be.

### Open questions

- **Does the README's example belong in the repo as a real fixture?** Phase 1's acceptance
  criterion is a compile of a template with both directives, all three slot forms, and an
  override in each of the three roots. If that fixture is built, the README example should be
  derived from it so the two cannot drift. Not done here — no `src/` or test tree existed to
  hang it on.
- **`docs/CONTEXT.md` also defines "Config value"** as "a tracked, typed, per-repo value
  substituted into templates at build time", which the spec contradicts outright: "There is no
  variable substitution." The README follows the spec and does not mention config values. The
  glossary entry looks like a leftover from an earlier design and should probably be deleted.
- **npm package-page framing.** The README opens with what the tool is and immediately states it
  is unreleased. An alternative is a prominent banner line before anything else. Chose the
  quieter form; if the package is published before Phase 2 lands, a louder warning may be worth
  it.

### Not done — out of scope

- `package.json`, `index.ts`, `tsconfig.json`, `.gitattributes`, `src/` — owned by the parallel
  Phase 0 agent, untouched.
- The `docs/CONTEXT.md` slot-mode and config-value corrections above. Flagged, not applied.
- No `.gitignore` change (`dist/` handling belongs with the build step).

## Glossary corrections

Scope: `docs/CONTEXT.md` only. `docs/specs/tool-contract.md` treated as authoritative, with the
reasoning taken from the Q/A entries *"What is the slot syntax?"*, *"Does `{{ value }}` config
substitution survive?"*, *"How are override locations configured?"*, and *"What verbs does the
CLI expose?"*. Nothing committed.

### The two reported errors

- **`Slot`** — was "Has a mode — `append` (default) or `replace`", now "…may extend or replace
  the text, with a mode — `replace` (default) or `append`." One sentence, `_Avoid_` line kept.
  The spec's reasoning (declaring a slot states its content is the developer's to specify;
  `mode` is orthogonal to whether a default exists; an empty default behaves the same either
  way) stays in the spec — a glossary entry is not the place for it.
- **`Config value`** — **replaced, not deleted**, by **`Config file`**: "The tracked
  `composable-skills.jsonc` in a consuming repo, carrying only locations — `id`, `sources`,
  `overrides`, `targets` — and never content." Deleting outright would have left the design's
  most-referenced artifact unnamed while the dead term stayed alive in casual use; the new
  entry's `_Avoid_` line retires "config value" explicitly and points at the tracked override
  root as the per-repo mechanism that replaced it. Both remaining references to the dead concept
  were removed (the Relationships bullet "template plus fragments plus **config values**", and
  the entry itself).

### Further staleness found in the same sweep — all fixed

- **`The tool`** — said the CLI "registers them with an agent harness". `register` was cut
  (Q/A *"What verbs does the CLI expose?"*; spec "Not in the contract"). Now matches the spec's
  own wording: "writes them where an agent harness will find them."
- **`Override`** — said "The per-developer content that fills a slot. **Never lives in a tracked
  repo.**" Directly contradicted the spec: "a tracked root is how a repo fills a slot for
  everyone who builds there." This is the same error as `Config value` seen from the other side —
  the tracked per-repo mechanism *is* a tracked override root. Rewritten to name the resolution
  (reverse order over `overrides` roots) and both ownership cases.
- **`Registration`** — **deleted.** It defined only cut mechanisms: generated
  marketplace/plugin manifests (cut with `register`) and a tracked settings snippet (`init` writes
  config, the hook entry, and the `.gitignore` line, and the spec says it "never writes any
  consuming repo's `settings.json`"). `grep -rn -i registration docs/` now returns nothing —
  no other document used the term. The Relationships bullet "**Registration** is required for
  plugin delivery" went with it.
- **`Delivery`** — said "How compiled skills reach an agent harness… Currently three: plugin,
  project, personal." That job now belongs to `targets`, and plugin delivery is explicitly not
  the tool's decision. Narrowed to its surviving meaning: how a skills repo's skills reach
  another repo (clone-and-link or a wrapper package), which the tool is agnostic about.
- **Relationships** — rewritten throughout: "only **delivery** differs" → "only the configured
  **targets** differ" (spec Overview); the compile bullet drops config values and gains "written
  to every **target**"; the slot bullet notes the template default as the fallback; the
  registration bullet is replaced by the ordered-list rule (later wins in `sources` and
  `overrides`, every target written).

### Terms added

Two, both load-bearing in the spec and previously unnamed:

- **`Template source`** — the `sources` roots, with whole-skill later-wins collision.
- **`Target`** — the `targets` output directories, all written every build, default
  `./.claude/skills/`.

Named "template source" rather than "source" deliberately: **"skill source" is a flagged
ambiguity** meaning a directory a *harness* scans, which does not exist. One sentence appended to
that flagged entry to hold the two apart — the config's `sources` are roots the *tool* reads.

### Verified and deliberately left alone

- **`Fragment`**, **`Reference file`**, and the conditionality-not-size blockquote — match the
  spec's `include:` section exactly.
- **`Consuming repo`**, **`Skills repo`**, **`Project repo`**, **`Template`**,
  **`Compiled skill`** — accurate.
- **Flagged ambiguity "Consumer"** — still accurate; untouched.
- `include:` path containment, per-skill fail-soft build behaviour, the frontmatter
  byte-identity invariant, and the `SessionStart` stamp — all real vocabulary but all
  implementation detail with no term to pin. Not added; the spec covers them.

### Open

- **`Delivery` may not earn its entry at all.** It now describes something the tool explicitly
  does not do. Kept because "delivery" is still used in the ADR and plan and the `_Avoid_` line
  usefully separates it from "distribution" (npm). Worth a second look if the word stops
  appearing in design conversation.
- **`Wrapper package`** is spec vocabulary (Overview, and the whole of the Q/A delivery entry)
  and has no glossary entry. Left out as borderline — it is defined in-line where it is used and
  is not a term anyone is misusing. Add it if it starts drifting.

## Phase 1 — compiler core

Files written: `src/types.ts`, `src/config.ts`, `src/frontmatter.ts`, `src/directives.ts`,
`src/validate.ts`, `src/build.ts`, `src/cli.ts`. Nothing else in the repo was touched. Zero
runtime dependencies — `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:module`,
`node:url` only.

### Decisions the task left open

- **Assumption:** the stamp and the diagnostics file live in a single gitignored directory at
  the repo root, `.composable-skills/` — `stamp` (a sha256 hex line) and `build.log` (the last
  run's diagnostics, truncated each run). A directory rather than two dot-files so `init` can
  offer one `.gitignore` line, and so a later phase can add state without adding root clutter.
  If wrong, only the two constants `STATE_DIR`/`STAMP_FILENAME`/`LOG_FILENAME` in
  `src/config.ts` move. The log is truncated rather than appended because an ever-growing file
  in a repo root is a maintenance problem nobody signed up for; the previous run's diagnostics
  are the only ones anyone acts on.
- **Assumption:** a skill directory with no `SKILL.md.tmpl` is **skipped silently unless it
  looks like a skill** — it warns only if it contains a `SKILL.md` or some other `*.tmpl`.
  Reason: the spec's own `include:` example is `fragments/hard-rules.md`, so a `fragments/`
  directory sits *inside* a source root next to the skill directories. Warning on it would
  print noise into every session's context forever, while the case the warning exists for (a
  template named `SKILL.md` instead of `SKILL.md.tmpl`) is still caught. If wrong, delete
  `looksLikeSkill` in `src/build.ts`.

### Assumptions

- **Assumption:** the stamp is written **only when the run produced no errors.** A rejected
  skill therefore re-reports its rejection every session instead of being silenced by a stamp
  hit, and `build --check` keeps failing until the template is fixed. The alternative — stamping
  regardless — makes a broken template invisible after its first build.
- **Assumption:** the stamp gate also requires `<target>/<skill>/SKILL.md` to exist for every
  discovered skill. The spec says a stamp match "exits immediately"; a stamp match with the
  output deleted would leave a session with no skills and no signal, so presence is checked
  too. Cost is one `stat` per skill per target.
- **Assumption:** `include:` resolves **only within the source root that owns the skill**, never
  falling through to another source root. This is the reading of "with N source roots, each
  resolves independently with no fall-through between them", and it matches "sources never merge
  within a single skill". If it was meant as "try each root in turn until found", one argument
  in `expandIncludes` changes.
- **Assumption:** every path component is `lstat`'d and **any symlink hop is rejected outright**
  rather than skipped. Also: symlinks inside a skill directory are not copied to targets
  (warned), symlinked skill directories in a source root are ignored, and symlinks are skipped
  when hashing for the stamp. Rationale: a symlink is the one way content outside a reviewed
  source root reaches a compiled `SKILL.md`.
- **Assumption:** "byte-identical frontmatter" is asserted **after LF normalisation**, which is
  applied to every text input before anything else. A CRLF template emits LF frontmatter. With
  `.gitattributes` forcing LF this is unobservable, and the stamp requires the normalisation
  anyway.
- **Assumption:** a template that opens `---` and never closes it is **rejected** ("frontmatter
  opened but never closed"). Not in the spec's reject list, but the alternative — treating the
  whole file as body — would expand directives inside what the author meant as frontmatter.
- **Assumption:** "unknown directive" is scoped to **near-misses of the two real directives**:
  a comment whose first token is `slot`/`include`/`slots`/`includes`/`endslot`/`end-slot` in any
  case, that did not parse (wrong case, inline rather than on its own line, unknown attribute,
  a `mode=` value other than `replace`/`append`, an invalid slot name). Every other HTML comment
  passes through untouched. Policing all comments would flag `<!-- TODO: ... -->` and break
  byte-transparency.
- **Assumption:** merge-conflict markers are checked in the **template and its included
  fragments**, not in override files. The spec says "in a template", and warnings are the
  category for a developer's own mistakes. An override with conflict markers still cannot reach
  the model unnoticed if it contains directive syntax — the leftover-directive scan runs over
  the finished output, so an override that injects `<!-- slot: x -->` is a rejection (verified).
- **Assumption:** the config file is JSONC with `//`, `/* */`, **and trailing commas** stripped
  by one string-aware scanner. Comments are replaced with nothing but newlines are preserved, so
  `JSON.parse` error positions still point at the right line. Verified against a config
  containing `"https://example.com/a//b /* still a string */"` as a value.
- **Assumption:** `~` at the start of a `sources`/`overrides`/`targets` entry expands to the home
  directory. The spec's Targets table lists `~/.claude/skills` as a supported target, and nothing
  else would make that entry work.
- **Assumption:** an override root or target that uses `${id}` when the config declares no `id`
  is **skipped with a warning** rather than derived from the directory name — invariant 5 says
  `id` is declared, never derived.
- **Assumption:** `sources` entries that are not path-like resolve by node module resolution
  (`createRequire` on `<repoRoot>/package.json`, then a plain `node_modules` walk as fallback).
  An unresolvable or missing source root is a warning, and **pruning is skipped entirely for
  that run** — otherwise one broken template package would silently delete every compiled skill
  on every developer's machine.
- **Assumption:** ownership for prune is a marker file, `.composable-skills`, written inside each
  emitted skill directory. `prune_stale_links` in `nimatt-skills/install.sh` recovers ownership
  from the filesystem (a symlink pointing into the repo), not from remembered state; a marker
  does the same for real directories, so ownership survives a lost stamp file. A directory
  without the marker is never overwritten and never pruned — it warns, exactly like
  `link_skill`'s "a real directory already exists ... left untouched". Verified.
- **Assumption:** the swap is two-step on every platform — park the old directory aside inside
  the target, rename the staging directory into place, then delete the parked copy, rolling back
  if the second rename fails. Renaming a directory over a non-empty directory fails on POSIX as
  well as Windows, so there is no platform-specific path. Staging directories are
  `<target>/.composable-skills-tmp-*`, never `$TMPDIR`; stale `tmp-`/`old-` directories are
  cleaned on the next run.
- **Assumption:** when a directive resolves to nothing, its lines are removed **and one adjacent
  blank line is consumed** if the block sat between two blank lines. This reproduces the
  README's worked example byte for byte. No other whitespace is touched — no global blank-line
  collapsing, because a compiler for prose has to be byte-transparent.
- **Assumption:** `mode=append` joins the template default and the override with one blank line
  between them, default first.
- **Assumption:** diagnostics go to stdout **and** stderr, except when both are TTYs, where they
  go only to stderr. The spec asks for both channels so an agent can report and a human can
  read; when a human is at a terminal both channels are the same screen and duplicating every
  line is worse than useless.
- **Assumption:** `build --check` compiles nothing — it compares the stamp and exits. It reports
  staleness, not template errors; validating without building is `lint` (phase 4).
- **Assumption:** an unrecognised *option* (e.g. `build --nope`) exits 2 with usage, and an
  unknown verb exits 2. "`build` always exits 0" is about compile failures on the session-hook
  path, where the command string is a fixed `build`; a typed flag typo is a human at a terminal
  who wants to be told.
- **Assumption:** the "frontmatter field a target does not support" warning is implemented for
  Codex targets only (a target path containing `.agents` or `.codex`, supporting `name` and
  `description`). No table of Claude Code's supported fields is authoritative enough to warn
  against, and a false warning on every build is worse than a missing one.
- **Assumption:** the tool version used in the stamp is read from `package.json` next to the
  bundle at runtime (`dist/../package.json`, which is also `src/../package.json` in dev), falling
  back to `0.0.0`.

### Open questions

- **Open question:** should the reject list include an override that contains merge-conflict
  markers? Currently no (spec says "in a template"). Resolved by deciding whether "a developer's
  typo never breaks a build" outranks "a conflict marker reaching the model always does" when the
  developer's own file is the one carrying the marker.
- **Open question:** line numbers in diagnostics are exact for the template, but a rejection
  found *after* an `include:` expanded is reported at the post-expansion body line plus the
  frontmatter offset, so it drifts by the size of the fragment. Fixing it needs a source map from
  expanded lines back to (file, line). Worth it only if templates start using many includes.
- **Open question:** the compiled `SKILL.md`'s sibling marker file `.composable-skills` is an
  extra file inside a skill directory. Harnesses scan for `SKILL.md` and ignore dot-files, but
  this has not been executed against either harness. If it turns out to be a problem, ownership
  moves to a manifest stored in `.composable-skills/` at the repo root, at the cost of losing
  ownership when that file is deleted.
- **Open question:** nothing adds `.composable-skills/` to this repo's own `.gitignore`. `init`
  (phase 2) offers that line for a consuming repo; this repo is not one, but it becomes one the
  moment anybody dogfoods the tool here.
- **Open question:** the plan's "does an in-session `build` hit `EPERM`?" is still open — not
  reproducible here, since that needs a sandboxed Claude Code session writing to
  `.claude/skills`. The code path is ready for it: a failed emit is a per-skill error diagnostic
  written to `.composable-skills/build.log`, and the build still exits 0.

### Verification actually run

`bun run build` emits `dist/cli.js` with `#!/usr/bin/env node` intact (and the executable bit),
`bunx tsc --noEmit --project tsconfig.json` is clean. End-to-end fixtures were built outside the
repo, driven through `node dist/cli.js` with `COMPOSABLE_SKILLS_HOME` pointed at a scratch home:
two source roots with a colliding skill (later wins, warned), a JSONC config carrying a URL
inside a string, `include:`, all three slot forms, overrides in all three roots (the
`${home}/repos/${id}` copy beat the `${home}/global` copy for the same slot), `references/`
copied verbatim, and every rejection in the spec's list — conflict markers, slot in frontmatter,
stray `<!-- /slot -->`, unknown directive, `..` and absolute and symlinked `include:` paths,
duplicate slot names, and a frontmatter-injecting override caught by the byte-identity assertion.
Per-skill isolation, prune, the "never clobber what the tool did not write" guard, the stamp
gate, and CRLF normalisation were each exercised. No test files were written — that is the next
agent's job.

---

## Phase 1 — tests

Written independently of the implementation: the contract, then the plan's acceptance criterion,
then the code. Expectations were formed from
[`docs/specs/tool-contract.md`](../specs/tool-contract.md) first, and the compiler was read only
afterwards to find *where* to point them.

Files: `test/fixtures/workspace.ts` (temp-tree builder, output capture, snapshot helper),
`test/resolution.test.ts`, `test/slots.test.ts`, `test/frontmatter.test.ts`,
`test/validate.test.ts`, `test/build.test.ts`. Every fixture tree is built under
`os.tmpdir()` per test and removed in `afterEach`; nothing is written into this repo's own
`.claude/`, and no static fixture files are committed.

`bun test`: **64 pass, 1 fail, 241 expect() calls, 5 files.** The one failure is deliberate and
described below.

### Spec/implementation mismatch

**Merge-conflict markers in an *override* file reach the compiled `SKILL.md` silently.** Neither
rejected nor warned — copied through verbatim. The spec's Rejected list scopes the scan to
"merge-conflict markers in a template", and the implementer logged this narrow reading as a
deliberate open question. But the organising principle two paragraphs later is unqualified —
*"A developer's typo never breaks a build. A conflict marker reaching the model always does."* —
and Resolution explicitly contemplates a **tracked** override root as "how a repo fills a slot
for everyone who builds there", which is exactly where a merge leaves markers that then reach
every developer's model. Today the outcome is neither of the two dispositions the spec offers.

Pinned by `test/validate.test.ts` → *"merge-conflict markers in an override > never reach the
compiled output"*, left failing. Whether the fix is to scan override files or to narrow the
organising principle's wording is the spec owner's call — one line either way.

### Spec ambiguities that blocked a decisive test

- **`include:` fall-through is specified twice, differently.** The `include` section says a
  fragment "resolves only within a configured `sources` root ... each resolves independently
  with no fall-through"; the Rejected list says "an `include:` resolving outside **every** source
  root", which only means anything if more than one root is consulted. The implementation takes
  the restrictive reading (the owning skill's root only), which is the safer one and consistent
  with "sources never merge within a single skill". Pinned as *"a fragment in a different source
  root does not fall through"*. Suggested spec fix: "outside **its** source root".
- **"unclosed `<!-- /slot -->`" is undetectable as written.** A fenced slot missing its closing
  tag is byte-identical in shape to the legal bare form, so no compiler can separate them. The
  implementation rejects only a *stray* `<!-- /slot -->` closing nothing. The consequence is
  pinned by *"an unclosed fenced slot (spec-ambiguous)"*: the text the author meant as a default
  survives as ordinary body prose **and** the override is inserted ahead of it, so the developer
  gets both. If that is unacceptable, the language needs an unambiguous fenced opener.
- **Code fences are not mentioned anywhere.** Directives are recognised inside ``` blocks, so a
  template cannot document the directive syntax literally — it would either be expanded or
  rejected as leftover syntax. Pinned by *"directives inside a code fence (spec-silent)"*.
- **"Diagnostics go to stdout, stderr, and a file" vs `--check` "writes nothing".** The
  implementation resolves this in favour of writes-nothing (no `build.log` under `--check`), and
  additionally suppresses the stdout copy when both streams are TTYs. Both are reasonable; both
  are deviations from a flat sentence. Tests assert the non-TTY behaviour only.

### Implementer judgment calls now pinned by test

Each of these was a place the spec was silent. They are locked down so a later change is a
deliberate one, not a regression:

- a source root that fails to resolve suppresses pruning for the entire run;
- ownership by `.composable-skills` marker file — an unmarked directory in a target is neither
  overwritten nor pruned, and warns;
- the stamp covers tool version and config text as well as the source and override trees;
- `mode=append` joins default and override with exactly one blank line, default first;
- a directive that resolves to nothing consumes one adjacent blank line;
- an unclosed `---` frontmatter fence is rejected;
- an override matching no declared slot warns and names the file, and the skill still compiles;
- CRLF inputs normalise to LF output and do not flap the stamp across a checkout switch.

### Verification of the tests themselves

Every test was checked against a mutated copy of `src/` in a scratch directory (the repo's own
`src/` was never modified). Twenty-two mutations were applied one at a time — reversing the
override scan direction, defaulting `mode` to `append`, deleting the leftover-directive scan,
allowing symlink hops, stubbing `resolveIncludePath` entirely, disabling prune, promoting the
stray-override warning to an error, deleting the frontmatter byte-identity assertion, forcing
the stamp stale, removing the ownership guard, skipping extras collection, allowing duplicate
slot names, emitting failed skills anyway, making the *first* source win, removing EOL
normalisation, reversing append order, letting `--check` write its log, dropping the stdout
copy, never applying overrides, dropping the tool version from the stamp, suppressing the
diagnostics file, and writing a stray file into an override root. **Every one was caught by at
least one test.** No test passes vacuously.

### Noticed, not done

- The `explain`, `lint`, `init` and `override` verbs are Phases 2–5; `cli.ts` exits 1 with a
  "not implemented yet" message and that is all the coverage they have here.
- The swap-and-rollback path in `swapIntoPlace` is only covered indirectly (a failing skill keeps
  its previous output; no `tmp-`/`old-` directories survive a rebuild). Exercising the rollback
  branch itself needs fault injection between the two renames.
- Windows path handling is untested — same constraint the implementer recorded.
- The `.composable-skills` marker file inside each emitted skill directory is asserted only
  through its effects (ownership), not by name, so moving ownership to a repo-root manifest would
  not break these tests.
- Node-module resolution of a non-path-like `sources` entry is untested; the tests use only
  path-like source roots.

## Disputed findings

### Minor — "`config.ts` is a grab-bag of things that are not configuration" (rejected: organisational, unsafe to land concurrently)

> `TEMPLATE_FILENAME` (source-layout constant), `OWNER_MARKER` (emit-protocol constant),
> `STATE_DIR`/`STAMP_FILENAME`/`LOG_FILENAME` (state layout), `stateDir()` (path derivation), and
> `describe()` (a generic error-to-string helper also imported by `cli.ts`) all live here because
> that is where the first caller happened to be. `build.ts` imports seven names from this module
> and six are not configuration.
> Direction: move the filesystem-layout constants and `stateDir` to a small `src/layout.ts`;
> `describe` to `src/types.ts`.

The observation is correct — six of the seven names `build.ts` imports from `config.ts` are not
configuration, and `layout.ts` is where they belong. It is rejected **for this pass only**, on
sequencing rather than merit.

The move is not confined to `config.ts`. It only compiles if the import blocks in `src/build.ts`
and `src/cli.ts` change in the same instant, and both files were being edited by other agents
while this pass ran. These are concurrent edits to one working tree, not to separate branches:
there is no merge step to catch a conflict. If another agent's write of `build.ts` is based on a
read taken before my import-line edit, my edit is silently discarded, and the result is a
`config.ts` that no longer exports `stateDir`, `OWNER_MARKER`, `STAMP_FILENAME`,
`LOG_FILENAME`, `TEMPLATE_FILENAME` or `describe` and a `build.ts` still importing all six. That
breaks the build for every other agent in the session, and it breaks it in a way that looks like
their change rather than mine.

The cost of waiting is zero: this finding names no defect, changes no behaviour, and no other
finding depends on it. The cost of losing the race is a red build for everyone. A re-export shim
in `config.ts` was considered and rejected as worse than either option — it would leave the
grab-bag surface exactly as wide while adding a second home for each name.

**Follow-up:** land as a single-owner pass once `build.ts`, `cli.ts` and `config.ts` are all free.
Mechanical: create `src/layout.ts` with `TEMPLATE_FILENAME`, `OWNER_MARKER`, `STATE_DIR`,
`STAMP_FILENAME`, `LOG_FILENAME` and `stateDir`; move `describe` to `src/types.ts`; repoint the
two import blocks. Note that `stateDir(config: Config)` takes a `Config`, so `layout.ts` imports
the type from `types.ts` — or, better, takes `repoRoot: string` and depends on nothing.

### Minor — "`Config` carries build state" (partially deferred: `configText`)

> `configText` exists solely so `computeStamp` can hash the config bytes, and
> `sourcesIncomplete` is a prune-safety flag. Neither is configuration.

Accepted as an observation; neither field is landed in this pass.

`sourcesIncomplete` was left untouched by instruction — another fixer is moving prune eligibility
out of config resolution and into the discovery pass, and that change is defined against the
field as it exists today.

`configText` cannot be dropped from `config.ts` alone. Its only consumer is `computeStamp` in
`src/build.ts:450`, which hashes `normaliseEol(config.configText)`; removing the field means
rewriting that line to read and hash from `config.configPath` instead — a change to the body of a
file owned by another agent this pass, not an import line. Deferred rather than disputed: the
replacement is a strict improvement (the stamp stops depending on a string carried through the
config object) and should land with, or just after, the `layout.ts` move above.

### `collectExtras` and `listFiles` should be one walker (`src/build.ts`) — declined

> `src/build.ts:466-485,296-324` — … Also, `collectExtras` and `listFiles` are near-identical
> walkers with different symlink policies.

The other half of this bullet (latin1 + two `replaceAll` copies in `readForHash`) was applied:
hashing now reads a `Buffer` and normalises line endings in one byte pass, with a fast path for
files containing no `CR`.

The walker unification is declined. The two walkers are near-identical only in their four-line
`readdirSync` preamble; everything that follows is per-entry *policy*, and the policies are
opposites by design rather than by accident:

- `collectExtras` warns on a symlink and refuses to copy it, errors on a top-level name the
  compiler owns, and skips `SKILL.md.tmpl`. It is a copy operation into a target directory, so
  every entry it accepts is a file it will write somewhere else.
- `listEntries` (the stamp walker) must record a symlink *and its destination* rather than skip
  it — retargeting a link changes what the build refuses to do, so it has to invalidate the
  stamp — and it sorts, because a hash is order-sensitive.

Factoring these into one walker means a callback that returns a recurse/skip decision per entry,
which moves the interesting part (the policy) behind an indirection and leaves the shared part
(a `readdirSync` in a `try`) as the only thing actually reused. That reads worse, not better, and
the brief for this pass was explicit about not refactoring adjacent code opportunistically. No
failure scenario was offered for this item and none is apparent.

## Documentation notes

Recorded while reconciling `docs/specs/tool-contract.md`, `docs/CONTEXT.md` and `README.md`
against the landed compiler. Neither item is a dispute; both are behaviour judged too small for
the contract but worth not rediscovering.

- **Scratch directories can linger for up to an hour.** A build killed mid-swap leaves a
  `.composable-skills-tmp-*` or `.composable-skills-old-*` directory in the target until a later
  build collects it, because a young scratch directory may belong to a build running right now.
  Harmless — dot-prefixed, and no harness reads them — but somebody will eventually find one in
  `.claude/skills` and wonder what it is. Left out of the contract as implementation detail; the
  threshold is `STALE_SCRATCH_MS` in `src/build.ts`.
- **The marker filename is named in exactly one place.** `docs/specs/tool-contract.md` spells
  `.composable-skills-owner`; the README says only "a marker file", and the glossary defines
  **Marker** by role. It was renamed from `.composable-skills` during this pass to stop it
  colliding with `STATE_DIR`, so if it churns again there is one line to change. Nothing in the
  compiler hardcodes either string — both come from the constants in `src/config.ts`.

## Compiler notes from the review-fix pass

Rationale that is not visible in the code and would otherwise be "simplified" away by a later
reader. Appended by the compiler fixer (`src/build.ts`, `src/directives.ts`).

- **`--check` exits non-zero on a broken corpus because that is *preserved* behaviour, not a new
  policy.** The contract row now reads "exits non-zero if the output is stale or the last build
  had errors", which sounds like an addition. It is not. Before the stamp became a record, a run
  containing any error simply never wrote a stamp, so the corpus was permanently "stale" and
  `--check` always exited 1. Making the stamp a record — written unconditionally, so a healthy
  skill stays gated while a broken sibling is broken — would have silently flipped `--check` to 0
  on a permanently broken corpus, turning a CI gate into a no-op. The explicit
  `stored.diagnostics.some(error)` test in `runBuild` exists to hold the old behaviour steady
  across that change. Deleting it looks like a simplification and is a regression.

- **The build lock is best-effort by design, and that asymmetry is deliberate.** A lock that is
  *held* by a live build makes this build compile nothing and exit 0. A lock that cannot be
  *taken at all* (unwritable or read-only state directory) makes this build warn and proceed
  **unlocked**. The two look inconsistent and are not: the tool runs inside a fail-soft session
  hook, so refusing to build over a lock it could not take would convert an environment problem
  into "this developer silently has no skills, forever". Losing the mutual exclusion is the
  cheaper failure, and the age-based scratch-directory rule still protects the last good output
  even with no lock at all.

- **Prune eligibility is a property of the discovery pass, not of config resolution.** It is
  tempting to derive it from `config.sourcesIncomplete` alone, since that is where a
  failed-to-resolve root is already recorded. That was the original bug: `discoverSkills` has its
  own failure path — a root that resolves but cannot be enumerated (EACCES, unmounted network
  path) — and a root the build could not read is indistinguishable from a root whose skills were
  all deleted upstream. `Discovery.complete` folds both checks together and is the only thing
  prune should ever consult.

## Phase 1 — test fixes

Second pass over `test/`, after the review-fix pass changed the compiler under it. Everything
below was re-derived from [`docs/specs/tool-contract.md`](../specs/tool-contract.md) as it stands
now, then checked against `src/`.

`bun test`: **111 pass, 2 fail, 455 expect() calls, 6 files** — identical piped and under a pty
(`script -qec "bun test" /dev/null`). Both failures are deliberate and described below.

### The suite used to fail 25/65 in a terminal

`emitReport` routes diagnostics by `process.stdout.isTTY && process.stderr.isTTY`: an interactive
terminal gets stderr only. Every assertion in the suite read `run.stdout`, so a developer running
`bun test` normally saw 25 failures that CI, with its pipes, never showed.

The fixture's `build()` now pins `isTTY` to `false` on both streams for the duration of the call
and restores the original property descriptor afterwards (including the case where the property
did not exist). A `tty: true` option opts one test into the other branch, so the routing is
covered rather than avoided — `test/build.test.ts`, `describe("diagnostics")`, asserts both
directions plus the log file.

### Assumption: an interactive terminal still gets the log file

The spec reads "Diagnostics go to stdout, stderr, and a file … except that an interactive
terminal (both streams a TTY) gets stderr only, and `--check` writes no file." Read strictly,
"stderr only" could mean no file either. The implementation writes the file regardless, and the
sentence enumerates `--check` separately as *the* file exception, so the test pins current
behaviour: interactive suppresses stdout, not the log. Worth one sentence in the spec.

### Spec/implementation mismatch — `--check` reports an error and success together

`test/config.test.ts` → `${home} > --check exits non-zero while a config error is still being
reported`. **Expected to fail.**

The contract says `--check` "exits non-zero if the output is stale **or the last build had
errors**." Config-level diagnostics (here: an `overrides` entry that escapes `${home}`, which is
dropped with severity `error`) are recomputed live on every run rather than stored in the stamp,
and the `check` branch of `runBuild` derives `broken` from `stored.diagnostics` alone. The run
therefore prints

```
composable-skills: error override "${home}/../elsewhere" resolves to …, outside … — skipped
composable-skills: compiled output is up to date
```

and exits **0**. A CI gate reading the exit code never sees it. The narrow fix is to let `live`
count towards `broken` in the `--check` branch; whether config errors should instead be fatal is
the implementation owner's call, so the test asserts the contract as written rather than the code.

### Spec/implementation mismatch — diagnostic line numbers are in the wrong coordinate space

`test/validate.test.ts` → `diagnostic locations > a slot diagnostic after an include names the
template's real line`. **Expected to fail.**

`src/directives.ts` documents `expandIncludes` as single-pass precisely so that "every line number
a diagnostic carries is a line that exists in the file it names". It does not hold. Slot
diagnostics are numbered against the *include-expanded* body and then offset by `bodyOffset`, so
any fragment that is not exactly one line long shifts every subsequent number. In the test, a
three-line fragment moves a duplicate slot from template line 10 to a reported line 12.

The same class of error reaches `findLeftoverDirectives`, which numbers against the *rendered*
output while naming the template. That case is pinned as current behaviour (not endorsed) in the
adjacent test: an override smuggling `<!-- slot: … -->` is reported as `SKILL.md.tmpl:7`, where
line 7 of the template is blank and the offending text lives in
`.claude/skills-local/lo/s.md:3`.

Fixing it means either carrying a source map through expansion and rendering, or attributing the
diagnostic to the file the line actually came from. Both are implementation choices, so only the
documented promise is asserted.

### Open question: a UTF-8 BOM hides the frontmatter entirely

`test/frontmatter.test.ts` → `encoding > a UTF-8 BOM makes the frontmatter invisible to the
compiler`. Pinned as current behaviour, flagged rather than decided.

A BOM makes the first line `﻿---`, which does not match the `---` fence, so `splitFrontmatter`
reports no frontmatter and the whole file — fences included — is emitted as body. Byte identity
still holds (an empty frontmatter equals an empty frontmatter), the build succeeds with no
diagnostic, and the harness sees a skill with no `name`/`description` at all. Three defensible
answers: strip a leading BOM, reject the template, or leave it. The spec says nothing; the test
will need updating whichever way it goes.

### Open question: a failed swap stamps as if it had succeeded

`test/build.test.ts` → `a swap that fails midway`. The rollback itself is correct — the previous
good output is restored, no `tmp-`/`old-` directories survive, exit code stays 0 — but a target
that failed to *emit* is not recorded in `StampRecord.failed` (only a failed *compile* is). The
next run is therefore stamp-gated with stale content in the target. It is not silent: the stored
diagnostics replay every session and `--check` exits 1, which the test asserts. Still, a transient
`ENOSPC` or `EXDEV` leaves the target stale until an input changes. Cheap fix if wanted: push the
skill name onto `failed` when `emitSkill` returns false for every target.

### Note: extras-before-`SKILL.md` ordering is unobservable

Copying non-template files before writing `SKILL.md` is defence in depth, not behaviour: the only
extra that could overwrite the compiled file is a top-level `SKILL.md`, and that is already a
rejection (`test/validate.test.ts`, `names the compiler writes itself`, which also covers a
differently-cased `skill.md` and the ownership marker). No test asserts the ordering directly
because no observable output distinguishes it; reversing it in `src/build.ts` changes nothing.

### What the new coverage pins

Verified by mutation — each of these turns the suite red when reverted in a scratch copy of the
repo:

- non-template files (`references/`) are part of the stamp, and a deleted one disappears from
  every target
- staging happens **inside the target directory**, and every path a build creates is under the
  repo root (invariant 7, asserted positively by wrapping `mkdirSync`/`writeFileSync`/
  `renameSync`/`copyFileSync` for one build)
- the stamp is written even when a skill fails; the third run replays the stored diagnostics, and
  a repair reaches the target
- the documented config defaults, exercised by a config declaring only `id` and `sources`; the
  `findRepoRoot` walk from a subdirectory with no config at all; `findConfigFile` stopping at the
  first `.git`
- node-module resolution of a `sources` entry, its fallback's `package.json` requirement, and the
  package-spec rules (`//`, `..`) that keep the bounded fallback from walking sideways
- `formatDiagnostic`'s `[skill file:line]` bracket, asserted as whole formatted lines
- errors — not just warnings — reaching `.composable-skills/build.log`, with file and line
- `id` validation as fatal, and the `${id}`-root skip warning when none is declared
- `homeRoot` against all three environments, including the `~/.config` default
- a target outside the repo, with prune touching only marker-owned directories, and the
  overwrite/delete split (a foreign marker still yields the name; an unmarked directory does not)
- the build lock: held → report and do nothing, stale → broken, `--check` → never taken
- the `swapIntoPlace` rollback branch
- non-ASCII round-tripping as bytes (a `latin1` template read turns the suite red)
- forced-rebuild idempotency, byte for byte across two targets
- "there is no variable substitution" — `${home}`, `${id}` and `{{ value }}` emitted verbatim
- single-pass `expandIncludes`: a nested include survives and is rejected as leftover syntax
- override files going through the same containment helper as `include:` (symlink file, symlinked
  skill directory, non-regular file)
- a symlink inside a skill directory being skipped with a warning

### Fixture cleanup

`tempDir` and `DEFAULT_CONFIG` are no longer exported (only `workspace()` used them);
`writeBytes` now has a call site; `mkdir` and `lines` were added for the lock and
whole-line-diagnostic tests. `frontmatter.test.ts` dropped two assertions its third one already
subsumed. `validate.test.ts` now uses one `rejects()` helper for every rejection test — it takes
the full `WorkspaceOptions` plus an optional `prepare(ws)` callback, which is what the symlink
cases needed and why they had been hand-rolled.

### Re-pinning the leftover-directive location, and what `diagnostic locations` covers now

Third pass over `test/`, after the line-provenance fix landed. Only `test/validate.test.ts`
changed. `bun test`: **119 pass, 0 fail, 478 expect() calls, 6 files** — identical piped and under
a pty (`script -qec "bun test" /dev/null`). `bun run typecheck` is clean.

`diagnostic locations > a leftover-directive diagnostic numbers the output while naming the
template` pinned the mis-attribution (`SKILL.md.tmpl:7`, a blank line) as then-current behaviour.
It is now `a directive smuggled in through an override names the override file, at its own line`
and asserts `…/.claude/skills-local/lo/s.md:3`, the file the text came from. Its sibling — the
duplicate slot after an include — is unchanged and still passes.

The group grew from two tests to eight, pinning provenance from every direction text can enter the
output: the template's own body (offending line after *two* fragments of different lengths splice
in, so an accumulating shift is caught, not just a single one), the template's frontmatter region
(the `line <= bodyOffset` branch, exercised by an `include:` hiding in the frontmatter), an
included fragment (a duplicate slot declared inside one; a nested include surviving inside one),
and an override file (a smuggled directive; the same with blank edges the splice trims away; and
one appended with `mode=append`).

A local `expectDiagnostic(run, formatted, offendingLine)` helper asserts the whole formatted
diagnostic *and then resolves it against the filesystem* — it re-reads the file the bracket names,
requires the line number to be one that file actually has, and requires that line's trimmed text
to be the text the message is about. That is the promise the implementation now makes, so it is
what the tests check; a diagnostic naming the right file at the wrong line fails on the second
half even where some other file happens to carry a matching line.

**`origin: null` on the `mode=append` separator is unobservable, as the implementer judged.** The
synthesized line is blank, and every scan that could produce a located diagnostic — the leftover
directive scan, `findConflictMarkers`, the lookalike branch of `parseSlots` — needs non-blank
text, so nothing can land on it and the "name the template with no line number" fallback is
unreachable today. What *is* observable is that it does not renumber what follows it, and that is
pinned: an override appended after a two-line default reports its smuggled directive at `s.md:3`,
its own line, not shifted by the separator standing between the two blocks.

**No provenance gap found.** Every case probed reports the file the text came from at a line that
exists in it, including the ones with blank edges on both the fragment and the override side, a
slot declared inside a fragment and overridden from disk, and two accumulating splices. The
diagnostics that never had a coordinate-space problem (template and fragment conflict markers,
`include:` resolution errors) were re-checked and are still numbered in the file they name.

Each of the eight tests was verified by mutation against a scratch copy of `src/`: reverting
`inBody` to the pre-provenance `{ line: line + bodyOffset }` turns seven of them red (all but the
frontmatter one, which does not take that branch); numbering a spliced block *after* its blank
edges are trimmed rather than before turns the two blank-edge tests red; and dropping the line
number from the `line <= bodyOffset` branch turns the frontmatter one red.


## Phase 1 — line provenance

Fix pass over the two deliberately-failing tests from the test agent's second pass, plus the
half-finished crash-report fix. Files touched: `src/directives.ts`, `src/build.ts`, and a new
`src/report.ts`. `bun test`: **112 pass, 1 fail** — identical piped and under a pty
(`script -qec "bun test" /dev/null`). The one failure is the companion test that pinned the
leftover-directive mis-attribution, and it fails *because* that half is now fixed; see below.

### `--check` now counts live diagnostics towards its exit code

The `check` branch derived `broken` from `stored.diagnostics` alone. Config- and discovery-time
diagnostics are recomputed every run and deliberately not stamped, so a live config error was
printed and the run still exited 0 — "error … outside …" immediately followed by "compiled output
is up to date". `broken` is now taken over `[...live, ...stored.diagnostics]`: a live error is one
the next real build would hit too, which is exactly what the contract's "the last build had
errors" is protecting CI from. `--check` still writes nothing and still never takes the lock —
the log file is now suppressed by passing a null state directory rather than by an `emitReport`
flag.

### Every line of the body carries where it came from

`expandIncludes` promised that "every line number a diagnostic carries is a line that exists in
the file it names" and could not keep it: splicing an *n*-line fragment shifts every line after
it, so a duplicate slot at template line 10 was reported as line 12.

Full provenance rather than the minimum fix. The body pipeline now moves `SourceLine`
(`{ text, origin }`) instead of bare strings, where `origin` is `{ file, line }` — `file: null`
meaning the template's own body, numbered body-relative, because only the caller knows the
frontmatter offset. `LineWriter`, `trimBlockEdges`, `parseSlots` and `renderSlots` all carry it
through; a slot's default keeps its own lines' numbers (`LocatedSlotBlock.defaultBlock`), and an
override's lines are numbered within the override file. `compileSkill` maps a diagnostic's line
through the origin of the line it landed on, so the diagnostic names the file the text actually
came from and a line that exists in it.

That fixes both halves at once. A slot diagnostic after an include names the template's real
line; a duplicate slot declared inside a fragment names the fragment; and a directive smuggled in
through an override is now reported at `…/.claude/skills-local/lo/s.md:3` instead of at
`SKILL.md.tmpl:7`, which was a blank line.

### Judgment calls

- **`origin: null` for synthesized text.** `mode=append` inserts a blank separator line that
  exists in no file. It is the only such line today, it can never match a directive or a conflict
  marker, and a diagnostic that somehow landed on it falls back to naming the template with no
  line number rather than inventing one.
- **`types.ts` left alone** (another agent owns it). `LocatedSlotBlock extends SlotBlock` adds
  `defaultBlock` in `directives.ts` instead of changing `SlotBlock.defaultLines`, which keeps
  every existing consumer compiling.
- **The leftover-directive scan still runs on the whole output**, frontmatter included, so an
  `include:` sitting inside the frontmatter region is still caught. Output lines at or before
  `bodyOffset` are template lines by construction; everything after maps through the rendered
  body's origins.
- **Not covered:** the diagnostics that never had a coordinate-space problem are untouched —
  template conflict markers, fragment conflict markers, and `include:` resolution errors are
  already numbered in the file they name.

### Reporting extracted to `src/report.ts`

`formatDiagnostic` and `emitReport` moved out of `build.ts`. The three-channel rule (stdout,
stderr, a file; stderr only where both streams are a TTY) is an obligation of the *tool*, not of
the build verb, and `lint` and `explain` will need it in phases 4–5. `emitReport` now takes the
state directory to write `build.log` into, or null for a run that must write no file (`--check`,
or a crash that never resolved a config). `build.ts` re-exports `formatDiagnostic` so its existing
importer keeps working.

`report.ts` also exports `reportCrash(message, cwd?)`, which completes the review-fix pass's
partial fix: the CLI's catch-all currently formats and routes correctly but writes no log file —
in exactly the case, an unexpected crash inside a session hook, where the log is the only
surviving evidence. `crashStateDir(cwd)` resolves the state directory from locations alone
(`findConfigFile` → its directory, else `findRepoRoot`), duplicating those two lines of
`loadConfig` because a crash may have no `Config` at all.

**Handoff to `cli.ts`'s owner** (not edited here): delete the local `reportCrash` (and the now
unused `formatDiagnostic`/`error` imports) and import the shared one —
`import { reportCrash } from "./report.ts";`. The call site in the `build` branch is unchanged.

### Expected new failure

`test/validate.test.ts` → `diagnostic locations > a leftover-directive diagnostic numbers the
output while naming the template` pinned the mis-attribution as current behaviour, explicitly not
endorsed. It now reports
`error [lo …/.claude/skills-local/lo/s.md:3] directive syntax left in the output: <!-- slot:
smuggled -->` — the file the text came from and a line that exists in it — so the pin needs
re-pinning to the fixed behaviour. Not edited here.

---

## Outstanding review findings (second pass — NOT addressed)

The `/implement-plan` fix loop is capped at two cycles. These survived the second review pass
and are recorded here rather than fixed. Both blockers from the first pass are **closed** and
independently re-verified.

> **Status, superseded — read this section as history, not as a worklist.** The user approved these
> and a later pass applied them; see [`## Phase 1 — second fix pass`](#phase-1--second-fix-pass).
> **Highest value 1–6: all closed.** **Also open:** the unauthenticated marker, zero configured
> `sources`, the missing `build.log`, the lock-busy path dropping replays and the 0644 log are
> closed; a **hardlink inside an override root** and **forged lock info evicting a live holder**
> remain open — the lock work clamped a *future* `at`, which is the wedge, not the eviction, and
> cross-checking the directory mtime gives a second thing to forge for the same bounded effect.
> **Architectural:** `resolveSlot` discarding the winning root and write-only
> `SlotBlock.defaultLines` are closed; `layout.ts`, `compileSkill` doing three jobs, and two
> `normaliseEol` implementations with nothing pinning their equivalence remain open — the last of
> those got *wider*, since both now also strip a BOM and still nothing pins that they agree.
> **Documentation:** closed by the docs pass. The heading's "NOT addressed" is left as written
> rather than rewritten, so this paragraph is the only edit and the original record stands.

### Highest value

1. **A BOM or leading blank line silently defeats the frontmatter region.** `splitFrontmatter`
   requires `---` on line 1 exactly, so `﻿---` or one leading newline makes the whole file
   body. `findSlotsInFrontmatter("")` then finds nothing, a slot between the fences is accepted,
   and `checkFrontmatterIdentity` compares `""` to `""` and passes — so an override can write
   `allowed-tools`/`hooks` with **no diagnostic**. This is invariant 1, the only enforced content
   rule, failing open. Needs a careless Windows editor, not a malicious author. *Fix: strip or
   reject a leading BOM in `normaliseEol`, and reject a file classified as frontmatter-less that
   has a `^---$` line before its first non-blank content.*
2. **Tampered compiled output is never detected.** The stamp hashes inputs; `outputsPresent`
   only stats. A hand-edited `.claude/skills/<x>/SKILL.md` — including added `allowed-tools` —
   survives unlimited rebuilds and `--check` reports it up to date. Weakens the ADR's stated
   compensating control for untracked output. *Fix: hash emitted content into the stamp record.*
3. **A crafted stamp file skips all work and replays chosen text to stdout** — the channel the
   SessionStart hook feeds to the model. `failed[]` is subtracted from the presence check, so
   listing every skill disables it. *Fix: treat the stamp as a cache hint, never authority.*
4. **The build wedges permanently, found independently by two reviewers.** If `.composable-skills`
   exists as a regular file, the state-dir `mkdir` throws `EEXIST`, which is misread as "lock
   directory exists"; every session then reports `another build holds the lock` and compiles
   nothing, forever, naming a cause that does not exist. A far-future `at` in `info.json` wedges
   the same way. *Fix: separate the two `mkdir` calls — any state-dir failure is `unavailable`
   (build unlocked), only a lock-dir `EEXIST` is `busy`. Clamp a future `at` to now.*
5. **The prune guard still misses a route.** `Discovery.complete` covers a root that fails to
   resolve or whose `readdir` throws, but not a failure *inside* a readable root: `existsFile`
   swallows every errno and `looksLikeSkill` swallows its own readdir error, so an unreadable
   **skill directory** produces no diagnostic, drops out of `keep`, and is pruned. Same defect
   class as the first pass's blocker. A symlinked skill directory hits it too.
6. **A symlinked override *root* escapes containment.** `resolveContainedFile` realpaths the root
   and asserts containment against the resolved location, and the config-time `${home}` check runs
   on unresolved text — so `ln -s <outside> ${home}/global` reads outside cleanly.

### Also open

Hardlink inside an override root reads any readable file; forged lock info evicts a live holder
(bounded — no output loss); unauthenticated marker (30-byte forgery makes a foreign directory
deletable); zero configured `sources` prunes the whole corpus; a fatal config error writes no
`build.log`; the lock-busy path drops replayed diagnostics; diagnostics echo full override lines
to a 0644 log.

### Architectural, deferred deliberately

`layout.ts` extraction — **its sequencing rejection has expired** now that concurrent editing has
stopped, and `report.ts` already spread the coupling. Architect recommends landing it *before*
Phase 2's `init`, which will widen the grab-bag most. Also open: `resolveSlot` discards which
override root won (a real Phase 3/5 prerequisite), `compileSkill` now does three jobs, write-only
`SlotBlock.defaultLines`, two `normaliseEol` implementations with nothing pinning equivalence.

### Documentation

Spec correctly describes every mechanic the fix pass touched, and the README's worked example
compiles byte-for-byte. What is wrong: no **Fatal** disposition documented (five config conditions
abort the whole run, contradicting "failure is isolated per skill"); the Warned list names 3 of
~15 warnings; **ADR-0001 was not edited** and now understates the policing surface (decisions 5
and 7); `CONTEXT.md` **Target** re-flattens the overwrite/prune asymmetry and **Stamp** is wrong
twice; README overstates marker identity where the spec is right; single-pass `include` is
undocumented while the code comment cites a spec clause that does not exist.

Not a finding, but worth keeping: the ADR's hot-path premise was **re-measured and improved** —
~0.9 ms/MB gated, down from ~1.5. The lock and marker parse are cold-path only, because
`acquireBuildLock` sits after the `if (fresh) return 0` gate.

## Phase 1 — second fix pass

### `report.ts` — de-duplication keyed on the destination, not on the terminal

The old rule wrote to stderr alone when **both streams were a TTY** and to both otherwise. That
inverted the intent: a terminal is two views of one destination where a duplicate is visible but
harmless, while the merged-stream consumers the file channel exists for — `npm postinstall`, a
`SessionStart` hook or CI capturing combined output, `> log 2>&1` — got every diagnostic twice.

`emitReport` now asks whether fds 1 and 2 *name the same destination*: `fs.fstatSync` on each,
compared on `dev`/`ino`. Two open file descriptions on one file, one pipe, or one pty share both;
two pipes, or a redirect alongside a terminal, do not. The terminal case is no longer special —
it falls out of the general rule, verified rather than assumed (below).

Judgment calls:

- **Which stream survives the merge.** stderr, unchanged from the old interactive branch. Where
  the destination is shared the choice is unobservable to the reader, and keeping stderr means the
  terminal behaviour the spec already describes is bit-for-bit what it was.
- **`fstatSync` throwing falls back to the old TTY test**, not to a crash and not to silence. A
  closed or exotic fd is exactly the shape of failure a fail-soft session hook must survive, and
  saying something twice is a far better failure than not building.
- **The fds come from `process.stdout.fd`/`process.stderr.fd`, defaulting to 1/2**, rather than
  being hard-coded. Same values in every real run, but it is the descriptor actually written to,
  and it gives the suite a seam: a fixture can point the streams at descriptors it opened itself
  and exercise the real rule instead of a faked `isTTY`.
- **Not adopted:** keeping an `isTTY` short-circuit ahead of the stat. It would have preserved the
  existing fixture's control over routing, at the price of leaving the terminal a special case —
  the thing the finding asked to remove — and of disagreeing with the stat when stdout and stderr
  are two *different* terminals.

Four cases verified against the built module (probe emitting one diagnostic, copies counted):

| Case | Invocation | Result |
|---|---|---|
| both pipes, one file | `probe > log 2>&1` | 1 copy |
| merged pipe (npm/CI shape) | `probe 2>&1 \| cat` | 1 copy |
| different destinations | `probe > out.log 2> err.log` | 1 copy each |
| both a TTY | `script -qec "probe" /dev/null` | 1 copy |
| stdout redirected, stderr a TTY | `script -qec "probe > out.log" /dev/null` | 1 copy in the file, 1 on the tty |
| stderr redirected, stdout a TTY | `script -qec "probe 2> err.log" /dev/null` | 1 copy in the file, 1 on the tty |

### `report.ts` — `build.log` created 0600

Diagnostics quote the line they rejected, so the log holds whatever a template, fragment or
override held — the reproduced case was a conflict marker carrying an API key landing in a 0644
file under a default umask. The write now passes `mode: 0o600`.

Judgment call: a `mode` only takes effect where the file is **created**, so a log written by an
earlier build would keep 0644 forever. The write is followed by an explicit `chmodSync(0o600)`,
which costs one syscall on a cold path and closes the upgrade case. The state directory's own
mode is left alone — the leak is the file's contents, and the directory holds the lock and stamp
that are not this fix's business.

### Test fallout

One test pinned the old rule and now fails: **`test/build.test.ts` — "an interactive terminal gets
stderr only"** (`build(ws, { tty: true })`). The fixture's `tty` option sets `process.stdout.isTTY`
/`process.stderr.isTTY`, which no longer routes anything; under `bun test` the two descriptors are
whatever the invoking shell gave them, so with separate pipes both streams are written and
`run.stdout` is not empty. Its sibling, "a non-interactive run writes every diagnostic to both
streams", passes only because the streams *are* separate there — run `bun test` with both
descriptors on one destination (a terminal, or `2>&1`) and every `run.stdout` assertion in the
suite fails instead.

That environment sensitivity is real and belongs to the fixture, not to `emitReport`: routing is
now a property of the process's descriptors. The suggested re-pin is for `test/fixtures/
workspace.ts` to stop faking `isTTY` and instead point `process.stdout`/`process.stderr` at
descriptors it opened — one temp file opened twice for the shared case, two temp files for the
separate case (`fd` is settable the same way `isTTY` already is) — and to read the captured text
back from those files. With separated descriptors the rest of the suite is unaffected: 118 pass,
1 fail, and `typecheck` and `build` are clean.

### Spec change needed (not made here — `docs/specs/tool-contract.md` is owned by the docs agent)

Under **Build behaviour**, the sentence

> **Diagnostics go to stdout, stderr, and a file** — stdout so the agent can report it, stderr for
> a human running the command, and a file because the first two are frequently unread — except
> that an interactive terminal (both streams a TTY) gets stderr only, and `--check` writes no
> file.

should become

> **Diagnostics go to stdout, stderr, and a file** — stdout so the agent can report it, stderr for
> a human running the command, and a file because the first two are frequently unread — except
> that where both streams name the same destination (a terminal, or `> log 2>&1`) they are written
> once, and `--check` writes no file.

Worth adding alongside it, if the docs agent wants the security property recorded: the build log
is created 0600, because a diagnostic can quote a full line of override or fragment content.

### `build.ts` / `directives.ts` / `frontmatter.ts` / `types.ts` — the compiler half of the pass

Eleven findings applied, plus the Phase 3/5 seams. Judgment calls, in the order they matter.

**A frontmatter fence that is not on line 1 is now a rejection, not a silently frontmatter-less
file.** The finding asked for a BOM strip plus a rejection of the specific leading-blank-line case;
what landed refuses the whole shape. `splitFrontmatter` scans forward from line 1 over blank lines
only, and any `^---[ \t]*$` reached before the first non-blank content rejects the skill. That is
one rule instead of an enumeration of the ways a fence drifts off line 1, and it is the rule the
frontmatter checks already assume: invariant 1 is enforced by comparing two frontmatter *regions*,
so a file with no region satisfies it vacuously. The BOM itself is stripped rather than rejected —
`normaliseEol` drops a leading `﻿`, and `normaliseEolBytes` drops `EF BB BF` so the stamp does
not see one either — because the character is invisible to the author who introduced it. Cost: a
frontmatter-less template whose body opens with a horizontal rule after a blank first line is now
rejected. Judged acceptable; it is indistinguishable from the failure being closed, and the
diagnostic names the fix.

**The stamp gate now verifies content, and `failed[]` no longer subtracts from the check.**
`StampRecord` gains `outputs: Record<string, string | null>` — a sha256 of the `SKILL.md` this
build left in every target, or `null` for a skill that produced none. `outputsPresent` is gone.
Only `SKILL.md` is hashed, per the explicit decision: a `references/` tree dominates corpus bytes,
and re-reading one at every session start would put back the cost the stamp exists to avoid. A
skill that fails carries its *previous* hash forward rather than dropping to `null`, so a skill
that keeps its last good output still has that output integrity-checked while it is broken.

Two consequences worth naming. A `null` entry is honoured only when no output is actually present,
so listing a skill in `failed` can no longer hide a file from the check. And a record that
verifies nothing gates nothing: `outputsVerified` returns false unless at least one skill hashed
clean, or the corpus is empty. That last rule is the one that closes the crafted-stamp replay —
claiming every skill failed is the cheapest way to claim there is nothing to check, and a gate may
only skip work it can prove was done. It costs a rebuild every session for a corpus where *every*
skill is broken, which is a corpus with nothing to preserve.

**Replayed diagnostics are prefixed `[last build]`.** Stored text reaching stdout unmarked is
stored text impersonating this run's observations, on the one channel the SessionStart hook feeds
to the model. The prefix is applied in `runBuild` (`asReplayed`), not in `formatDiagnostic`, so a
live diagnostic is untouched and the distinction survives the file channel too.

**A symlinked *skill directory* is refused with a warning rather than followed.** `isDirectory()`
is false for a symlink dirent, so such a directory was invisible to discovery while being
perfectly readable — and its compiled output was pruned as a skill that no longer exists.
Following it would read a template from outside every configured source root, which is the thing
`include:` containment exists to prevent, so refusal is the consistent answer. `complete` is
cleared, so nothing is pruned that run. The warning fires only where the directory actually looks
like a skill (a template, or a `SKILL.md`/`*.tmpl`), so an ordinary symlink sitting in a source
root is still ignored in silence.

**`ENOENT` and every other errno are now distinguished** (`probeFile`, `looksLikeSkill` returning
a tri-state). `ENOTDIR` counts as missing — a path component that is not a directory means the
file genuinely is not there. Everything else warns and clears `complete`.

**The symlinked override root is a rejection, scoped to override roots only.**
`resolveContainedFile` takes `rejectSymlinkedRoot`, which `lstat`s the root's own last component.
It is *off* for source roots on purpose: a symlinked package directory is ordinary there (pnpm,
npm workspaces), and refusing it would break `include:` for a normal install. The finding's second
option — re-asserting `${home}` containment against the realpathed root — was not taken because it
needs `homeRoot(env)` threaded through `compileSkill` and `resolveSlot` for a check that only ever
fires on `${home}`-derived entries, while the `lstat` closes `./.claude/skills-local` as well.
Known cost: a developer whose dotfiles manager symlinks `${home}/global` at the leaf now gets a
rejection on every skill that declares a slot. The message names the root and says to point the
entry at a real directory.

**The lock's two `mkdir` calls are separated.** Any state-directory failure, of any errno, is
`unavailable` — build unlocked; only an `EEXIST` from the lock-directory `mkdir` is `busy` or a
staleness check. That makes the documented `unavailable` path reachable through the case that
previously wedged (`.composable-skills` existing as a regular file). `lockIsStale` now clamps a
future `at` to now and cross-checks the lock directory's own mtime, which is the reading the
holder does not write; an mtime more than the staleness window into the *future* also breaks the
lock, since a clock that jumped forward leaves no other way out.

**The ownership marker requires `skill` to match its directory's basename and at least one of
`id`/`repo`.** A marker whose `skill` names another directory is a marker that was copied rather
than written where it sits, which is exactly the 30-byte forgery shape.

**Phase 3/5 seams.** `resolveSlot` is exported and returns `{ lines, from: Root | null }`;
`CompileResult` carries `slots: SlotBlock[]` and `resolutions: SlotResolution[]`. An empty
override file reports the root that supplied it rather than falling back to `from: null`, under
either mode — `explain` must be able to say a slot is deliberately emptied, and a `replace` slot
filled from an empty file already reported that way. `SlotBlock.defaultLines` is deleted and
`LocatedSlotBlock` is collapsed into `SlotBlock`, which now carries `defaultBlock: SourceLine[]`;
`SourceLine`/`LineOrigin` moved to `types.ts` (re-exported from `directives.ts`, since that is
where every current importer looks) because `SlotBlock` lives there and cannot reference a type
`directives.ts` owns without a cycle. `formatDiagnostic`'s re-export from `build.ts` is deleted —
`grep` finds no importer, as the finding said.

**Postscript, after `src/text.ts` was extracted.** A later refactor consolidated `normaliseEol`
and `normaliseEolBytes` into one module and defined the first over the second. That is a better
close than the equivalence test proposed above — one implementation cannot drift from itself — and
all twelve fixes were re-verified against the refactored tree, behaviour unchanged. It does carry
one precondition, now recorded next to the function: `normaliseEol` round-trips through UTF-8, so
it is identity only for text that already came from a UTF-8 decode. `Buffer.from(text, "utf8")`
replaces a lone surrogate with U+FFFD, so `"a\uD800b"` returns `"a\uFFFDb"`. Harmless at all four
call sites, which read through `fs.readFileSync(..., "utf8")` and so have already taken that
substitution — verified against a file holding the raw bytes `61 ED A0 80 62`, which reads back
already replaced and normalises to itself. It would stop being harmless the day a caller passes a
string literal.

### Test breakage this pass created — for the test agent, not fixed here

`bun test` with stdout and stderr on separate destinations: **111 pass, 8 fail.** (Run with both
descriptors on one destination and 68 fail, for the `report.ts` reason recorded above; that is the
fixture issue, not this.) Seven of the eight are this pass:

| Test | Why |
|---|---|
| `encoding > a UTF-8 BOM makes the frontmatter invisible to the compiler` | Pins the behaviour just deleted; the file's own comment flags it as "pinned, not endorsed". Re-pin as: BOM stripped, frontmatter honoured, output byte-identical to the template minus the BOM. |
| `stamp gate > a second run with no input change does no work` | Overwrites the compiled `SKILL.md` with a sentinel to prove the tool did not run, which is now exactly the tamper the gate detects. Needs a different probe — an mtime, or a sentinel in a *copied extra* rather than in `SKILL.md`. |
| `stamp inputs beyond the file trees > a new tool version invalidates the stamp` | Same sentinel technique. |
| `stamp inputs beyond the file trees > editing the config invalidates the stamp` | Same sentinel technique. |
| `line endings > switching a checkout between CRLF and LF does not make the stamp flap` | Same sentinel technique. The stamp-equality half of the assertion still passes. |
| `a build that failed keeps saying so until it is repaired > the third run replays…` | Same sentinel technique, on `steady`'s output. The replay assertions on that run still pass. |
| `a shared target outside the repo > overwrite and delete…` | Fixture artifact: one `foreignMarker` constant, `skill: "foreign"`, is written into both `claude/skills/foreign/` and `claude/skills/shared/`. The tightened marker rejects the copy in `shared/`, so that directory reads as unmarked and is refused rather than overwritten. Give `shared/` its own marker with `skill: "shared"`. |

None of these is a regression: each pins behaviour a finding asked to change, or a fixture the
tightened marker now rejects. The eighth, `diagnostics > an interactive terminal gets stderr only`,
belongs to the `report.ts` change above.

Gaps worth a new test, since nothing covers them: the crafted-stamp replay (`outputs` all `null`
plus a deleted target must produce a real build, not a silent replay), the state-directory-is-a-file
lock case, a far-future `at`, the zero-`sources` prune refusal, the symlinked override root, and
the symlinked skill directory. All six were verified by hand against a scratch harness this pass;
none is pinned.

## Phase 1 — layout extraction

Single-owner pass over `src/` only. Lands the `layout.ts` move whose sequencing rejection is
recorded under [Disputed findings](#disputed-findings) — that rejection has expired: the
concurrent editing it named has stopped, and `report.ts` had since widened the coupling it
predicted. Pure move: no behaviour was intended to change, and none did.

### What moved

**New `src/layout.ts`** — filesystem layout, depends on nothing in `src/`:

- `TEMPLATE_FILENAME`, `STATE_DIR`, `STAMP_FILENAME`, `LOG_FILENAME`, `OWNER_MARKER`
- `stateDir(repoRoot: string)` — **takes the root, not a `Config`**, which is what keeps this
  module free of `types.ts` and stops the grab-bag re-forming. `crashStateDir` in `report.ts`
  derived the same path by hand and now calls it.
- `toolVersion()` — moved out of `cli.ts`, see below.

**New `src/text.ts`** — `normaliseEol` (string) and `normaliseEolBytes` (bytes).

**`describe()` → `src/types.ts`.** Generic error-to-string; no config relationship.

Nothing is re-exported from its old home. `config.ts` now exports configuration only, and
`build.ts` imports exactly one name from it (`loadConfig`), down from seven.

### `toolVersion()` next to the layout constants

The tool version is a stamp input — a tree compiled by a different version must read as stale —
so it belongs with the things the stamp is derived from, not in the CLI. `runBuild` now calls it
directly and `BuildOptions.version` became optional, kept **only** as a test override (the test
fixture already passes `"test-version"` on every call, so no test changed). Any later caller —
Phase 4's `lint`, a programmatic entry — now gets the correct version by default instead of
having to remember to supply one.

Its `../package.json` lookup via `import.meta.url` was the one thing a module move could break
silently in the bundle but not in `src/`, since a failed lookup falls back to `"0.0.0"` — which
is also the real version, so `--version` alone proves nothing. Verified against a scratch copy
with the version rewritten to `9.9.9-smoke`: `node dist/cli.js --version` and `bun src/cli.ts
--version` both print it, so `..` resolves to the package root from both layouts. End-to-end,
a `build --check` against a tree built by the `0.0.0` binary reports stale when re-run with the
`9.9.9-smoke` binary — so the version reaches `computeStamp` through the new path.

### One line-ending implementation, not two

`normaliseEol` (in `frontmatter.ts`, but a generic utility with no relationship to frontmatter)
and `computeStamp`'s private `normaliseEolBytes` were two implementations of one rule, with
nothing pinning them equivalent. They agreed; had they drifted, the stamp would have hashed
bytes the compiler never sees and the gate would have decided staleness on the wrong content —
a failure with no symptom.

Both now live in `src/text.ts`, with the **string form defined over the byte form**:
`normaliseEolBytes(Buffer.from(text, "utf8")).toString("utf8")`. That direction, not the
reverse: the byte form is what hashes arbitrary files in a source tree, including files that are
not text, and routing those through a UTF-8 decode would corrupt the hash of every binary extra.

Equivalence with the deleted string implementation was fuzzed over 200k random strings built
from BOM/CR/LF/CRLF/ASCII/multibyte/emoji fragments — no divergence. One theoretical difference
remains: a string holding a **lone surrogate** would round-trip to `U+FFFD`. Unreachable from
this code, since every caller's input comes from `fs.readFileSync(..., "utf8")`, which has
already substituted the replacement character.

### Judgment calls

- **`CONFIG_FILENAMES` stayed in `config.ts`.** It names the config file, which is config's own
  schema, not filesystem layout. Phase 2's `init` should import it from there and take the state
  directory from `layout.ts`.
- **`src/text.ts` rather than folding the line-ending helpers into `layout.ts` or `types.ts`.**
  Line endings are neither a path nor a type; putting them in either module would rebuild a
  grab-bag one file over from the one just dismantled.
- **`crashStateDir` now calls `stateDir(repoRoot)`** instead of repeating `path.join(repoRoot,
  STATE_DIR)`. Identical by definition, and removing the second derivation is the point of
  having the function.
- **`configText` was left alone.** The deferred half of the `Config`-carries-build-state finding
  is a change to `computeStamp`'s body, not an import line, and this pass is a move.

### Test suite

Unchanged, as expected — `test/` was not touched. **Before: 111 pass / 8 fail. After: 111 pass /
8 fail** (stdout and stderr on separate destinations; 51/68 with both on one, the known fixture
issue). The failing set is identical name-for-name, in the same order. No test imports any moved
name — the only `src` import in the suite is `homeRoot` from `config.ts`, which did not move —
so there is no handoff item for the test agent from this pass.

`bun run typecheck` clean on both projects; `bun run build` bundles 10 modules (was 8) and
`dist/cli.js` keeps its `#!/usr/bin/env node` shebang.

## Phase 1 — second test pass

Single-owner pass over `test/` only. `src/`, `docs/specs/`, `README.md`, `package.json` and the
tsconfigs were not touched. **160 pass / 0 fail, identical under all four invocations** (see below);
`bun run typecheck` clean on both projects.

### The suite no longer has an opinion about the shell it was run from

This was the important one. `emitReport` routes by asking whether fds 1 and 2 *name the same
destination*, so the fixture's `tty` flag — which set `isTTY` — no longer routed anything, and the
suite's result became a property of the invocation: **51 pass / 68 fail** under `bun test` with the
two descriptors merged, **111 / 8** with them separate. Every `run.stdout` assertion in the suite
depended on the non-merged half.

`test/fixtures/workspace.ts` now points the streams at descriptors it opens itself. `build()` takes
`streams?: "separate" | "shared"`, defaulting to `"separate"`:

- **`"separate"`** — two temp files, one fd each.
- **`"shared"`** — one temp file opened twice. Two open file descriptions on one path share
  `dev`/`ino`, which is exactly what a terminal, a merged pipe, and `> log 2>&1` share.

`process.stdout.fd`/`process.stderr.fd` are writable own properties under both bun and node, so the
real rule runs against real descriptors; `process.stdout.write` is intercepted only to `writeSync`
the bytes to the matching fd, and each run's text is read back from the file afterwards. `isTTY` is
still forced — to `false`, deterministically — so the `fstat` fallback can never be reached with a
value inherited from the shell: if a descriptor ever stops being stat-able the fallback writes
twice and the routing tests fail loudly instead of drifting.

The capture files are opened with `fs.openSync`/`fs.writeSync` and never `fs.mkdirSync`/
`fs.writeFileSync`, because "every path a build creates is inside the repo" patches those two to
record what the *build* touched.

`BuildRun` gained `writes: { stream, text }[]` — what `emitReport` called, as distinct from what
landed at the destination. Both are needed: the file content pins the one-copy rule, the call log
pins which stream survives the merge.

**The rule itself is now pinned**, replacing `diagnostics > an interactive terminal gets stderr only`:

| Test | Pins |
|---|---|
| `two destinations get one copy each` | one copy in each file, each stream written exactly once, one copy in `build.log` |
| `one destination gets one copy, not two` | one copy in the single file, one write, and that it is the stderr call that survives |
| `the diagnostics themselves do not depend on how the streams are wired` | same run under both routings produces byte-identical text (workspace path elided) |

Four-way verification, all **160 pass / 0 fail**: `bun test`; `bun test > out 2> err`;
`bun test > all 2>&1`; `script -qec "bun test" /dev/null`.

### The eight failures, re-pinned

- **`a UTF-8 BOM makes the frontmatter invisible to the compiler`** → **`a UTF-8 BOM is stripped and
  the frontmatter is honoured`**: output is byte-identical to the template minus the BOM, and the
  BOM does not survive into the output. Two siblings added: `a fence reached only past leading blank
  lines is refused outright` (with a healthy skill alongside, so per-skill isolation is asserted
  too), and `a frontmatter-less template whose body opens with content keeps its horizontal rules`
  — the acceptable-cost boundary of the new rule, so the rejection cannot quietly widen.
- **The five stamp/line-ending tests** proved "the tool did not run" by overwriting the compiled
  `SKILL.md` with a sentinel, which is now the tamper the gate detects. The probe moved to a
  **copied extra** — deliberately not hashed by the gate, rewritten from source by any real build.
  Each affected skill directory gained a `notes.txt`. That choice is not free: those tests now
  depend on extras being unhashed, so the decision is stated directly by
  `the stamp gate verifies its outputs > a compiled extra is deliberately not hashed` rather than
  only implied. Two of them gained a positive half as well (a real rebuild *does* rewrite the
  extra), so "never rebuild" is not an accepted mutation. The replay test also now asserts the
  `[last build]` prefix, which nothing pinned.
- **`a shared target outside the repo > overwrite and delete are governed separately`**: the fixture
  artifact is fixed by turning `foreignMarker` into a function of the skill name, so each planted
  directory carries a marker that names it. The tightened rule it exposed was itself unpinned — see
  the marker tests below.

### Six unpinned fixes, now pinned

| Fix | Test(s) |
|---|---|
| crafted stamp replay | `a forged stamp > claiming every skill failed does not gate the build`, `… a \`failed\` entry cannot hide an output from the check`, `… a skill missing from the record is not treated as verified`, `… a bare-hash stamp verifies nothing and gates nothing` |
| state dir is a regular file | `the build lock > a state directory that is a regular file builds unlocked instead of reporting a lock` |
| far-future lock `at` | `… a lock whose timestamp is in the future is still broken once the directory is old`, `… a lock directory dated in the future is broken rather than honoured forever`, `… a fresh lock is honoured even where its own timestamp is in the future` |
| zero `sources` + a remembering stamp | `prune and ownership > zero source roots plus a stamp that remembers skills refuses to prune, and says what it kept`, `… zero source roots with nothing remembered still prunes` |
| symlinked override root (and the source-root exemption) | `override containment > an override root that is itself a symlink is rejected`, `… a source root that is itself a symlink is followed, and include: still resolves inside it` |
| symlinked skill directory | `prune and ownership > a symlinked skill directory warns, is not followed, and does not take its output with it`, `… a symlink in a source root that is not skill-shaped is ignored in silence` |

Plus output content hashing: `editing a compiled SKILL.md in place forces a rebuild` (a same-shape,
different-content edit, which only a content hash sees), `a compiled extra is deliberately not
hashed`, and `an output missing from one of several targets is enough`.

Three judgment calls worth recording.

- **The forged-stamp workspace has two skills, not one.** With one skill, every forgery fails for
  the same reason — *nothing* verified — and the per-skill checks are untested underneath it. Each
  of the three per-skill tests now leaves one skill verifying cleanly, so the rule under test is
  the one that fires. This was found by mutation-checking: with a single skill, dropping the
  `actual !== null` check and turning `!(name in outputs)` into `continue` were both **uncaught**.
- **The far-future `at` is only observable through the directory-mtime cross-check.** With the lock
  directory freshly created, `Math.min(holder.at, Date.now())` yields an age of 0 either way, so
  removing the clamp alone changes nothing — honouring a lock taken seconds ago is correct however
  its `at` reads. What the future timestamp actually defeats is `|| byDirectory`, and that is what
  the tests discriminate: the lock directory is backdated with `utimesSync`. **Not caught: removing
  the `Math.min` clamp.** It is defensive only, unreachable while the mtime cross-check stands, and
  pinning it would mean asserting a state the filesystem does not produce.
- **`zero source roots with nothing remembered still prunes` pins the alarming half on purpose.**
  Zero roots plus an empty stamp is not "a corpus that lost its `sources` key", and a guard widened
  to `sources.length === 0` alone would silently stop pruning anything in a repo whose stamp was
  cleared. Both halves are asserted so the guard cannot drift in either direction.

The tightened ownership marker also had no coverage at all, and is security-shaped, so it got two:
`a marker naming another directory does not license a deletion` (with the honestly-marked sibling
still pruning, so the guard is on the name and not on pruning itself) and `a marker copied from
another skill's directory does not make a directory overwritable`.

### Layout refactor — what was checked and what was skipped

**New `test/text.test.ts`.** Table-driven cases for the rule (CRLF, lone CR, CR at EOF, `CR CR LF`,
one leading BOM only, a non-leading BOM kept), each asserted through both entry points; two
byte-level cases pinning the *direction* of the definition — invalid UTF-8 passes through
unchanged, and a CR embedded in otherwise-binary bytes is normalised without moving anything else.
That is the reason the string form is defined over the byte form and not the reverse, and nothing
stated it. Plus a 20k-case fuzz against an independent oracle (`strip one leading BOM, then
/\r\n|\r/g → \n`), over fragments chosen to hit the byte loop's boundaries. Deliberately no lone
surrogates: every real caller's input has already been through a UTF-8 decode, and the known
`U+FFFD` divergence is unreachable from this code.

**New `test/layout.test.ts`.** `toolVersion()` is smoke-tested from **both shipped layouts** against
a staged copy of `src/` whose `package.json` declares `9.9.9-smoke` — `bun <copy>/src/cli.ts
--version`, then `bun build` into `<copy>/dist` and `<copy>/dist/cli.js --version`. Asserting
against the repo's own `package.json` would have proved nothing: it declares `0.0.0`, which is also
the value a failed lookup falls back to. The staged copy costs ~90 ms and writes nothing into the
repo. A second test pins that the version reaches `computeStamp` through the new default path —
`BuildOptions.version` is now a test override, so a caller that omits it must get the real version
— via a new fixture option `ownVersion: true`.

**Skipped:** a test that the deleted string implementation and the surviving byte one agree. It is
a tautology now that one is defined over the other; the oracle fuzz pins the rule instead, which is
what would actually catch a rewrite. Also skipped: asserting `toolVersion()` against the repo's own
`package.json`, for the reason above.

### Mutations checked

Each against a scratch copy of `src/`; the repo's `src/` was never modified. "Caught by" names the
test that failed.

| # | Mutation | Result |
|---|---|---|
| 1 | `emitReport` always writes both streams | caught (`one destination gets one copy, not two`, `…do not depend on how the streams are wired`) |
| 2 | `emitReport` always writes once | caught (65 failures) |
| 3 | `fstat` made to throw, falling back to the `isTTY` test | caught (same two) |
| 4 | BOM strip removed from `normaliseEolBytes` | caught (`a UTF-8 BOM is stripped…`) |
| 5 | late `---` fence accepted as frontmatter-less | caught (`a fence reached only past leading blank lines…`) |
| 6 | marker `skill` no longer required to match its directory | caught (both marker tests) — **was uncaught before this pass** |
| 7 | `outputsVerified` → `return true` | caught (`claiming every skill failed…`) |
| 8 | `expected === null` no longer rejects a present file | caught (`a \`failed\` entry cannot hide an output…`) |
| 9 | a skill absent from `outputs` skipped instead of rejecting | caught (`a skill missing from the record…`) |
| 10 | every state-directory failure reads as *held* | caught (`a state directory that is a regular file…`) |
| 11 | `\|\| byDirectory` dropped from `lockIsStale` | caught (both future-timestamp tests) |
| 12 | future-mtime branch dropped from `directoryLooksStale` | caught (`a lock directory dated in the future…`) |
| 13 | `lockIsStale` → `return true` | caught (`a fresh lock is honoured…`, `a lock held by a live process…`) |
| 14 | zero-`sources` prune guard removed | caught (`…refuses to prune, and says what it kept`) |
| 15 | zero-`sources` guard widened to ignore the stamp | caught (`zero source roots with nothing remembered still prunes`) |
| 16 | `complete = false` dropped for a symlinked skill directory | caught (`a symlinked skill directory warns…`) |
| 17 | symlinked-skill-directory warning removed entirely | caught (same) |
| 18 | warn on *every* symlink in a source root | caught (`…not skill-shaped is ignored in silence`) |
| 19 | `rejectSymlinkedRoot` ignored | caught (`an override root that is itself a symlink is rejected`) |
| 20 | `rejectSymlinkedRoot` applied to source roots too | caught (`a source root that is itself a symlink is followed…`) |
| 21 | gate hashes the whole compiled directory, extras included | caught (`a compiled extra is deliberately not hashed`, + 5 probe tests) |
| 22 | `[last build]` prefix dropped from replayed diagnostics | caught (`the third run replays the error…`) |
| 23 | `toolVersion()` looks for `package.json` beside its module | caught (`from src/, and from the bundle`) |
| 24 | CRLF handled as two separate line breaks | caught (9 failures in `text.test.ts`) |
| 25 | output check reduced to presence, not content | caught (`editing a compiled SKILL.md in place forces a rebuild`) |
| 26 | output check applied to the first target only | caught (`an output missing from one of several targets is enough`) |
| — | `Math.min` clamp removed from `lockIsStale` | **not caught** — unobservable while the mtime cross-check stands; see above |

Nothing was left failing, and no test in this pass was bent to fit the code.

### Coverage gaps judged not worth closing

- **The `emitReport` `fstat` fallback path itself.** Reaching it means a descriptor that cannot be
  `fstat`'d, which the fixture cannot produce without patching `fs.fstatSync` — at which point the
  test asserts the patch, not the tool. The fixture instead pins `isTTY` to `false` so that if the
  fallback is ever reached, the routing tests fail rather than silently changing meaning.
- **The lock's `at` clamp**, per the table above.
- **`--version` against the real `package.json`**, which is `0.0.0` and therefore indistinguishable
  from the fallback; the staged-copy smoke test covers the same code with a distinguishable value.

## Phase 2/3 — init and override

New: `src/init.ts`, `src/override.ts`, `test/init.test.ts`, `test/override.test.ts`. Changed:
`src/cli.ts` (dispatch, flag parsing, usage), `src/report.ts` (one new export), and
`test/fixtures/workspace.ts` (the fd-capture harness generalised over all three verbs). `lint` and
`explain` are left as stubs. `README.md` still lists both verbs as planned — it is the docs agent's
file, and the status table there needs updating.

### `report.ts` — `emitLines`, and why the two verbs do not write `build.log`

`emitReport`'s stream logic was extracted into a private `writeToStreams`, and a second export
`emitLines` was added over it: same one-destination rule, no `composable-skills:` prefix, no log
file. Two decisions are folded into that.

**No prefix**, because `init`'s diff and `override`'s path are the *answer to what the developer
asked*, not a remark about the run. Prefixing a 20-line unified diff with `composable-skills:` on
every line makes the one output a human is meant to read the least readable thing the tool emits.
Diagnostics from either verb still go through `emitReport` and still carry the prefix.

**No log file.** `emitReport(…, stateDirectory)` writes `.composable-skills/build.log`, which the
contract defines as the record of the last *build* — the channel that exists because a session
hook's stdout is unread. A human-run verb whose output is already on their terminal has no claim
on it, and letting `init` or `override` write there would destroy the diagnostics a broken build
left behind. Both verbs pass `null`. Pinned by two tests (`init` writes no state directory at all;
`override` leaves no `build.log`).

### `init` — judgment calls

**The hook command string** is written literally as
`node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build`, exported as
`HOOK_COMMAND` and asserted byte-for-byte by test. Note this differs from the plan's Phase 2 text,
which says `init` writes a *resolved* absolute path. The `$CLAUDE_PROJECT_DIR` form was chosen
instead because it makes the string identical in every clone and every worktree of every repo,
which is a strictly stronger form of the byte-stability the Codex trust hash wants — a resolved
path changes whenever the repo moves, and each move would re-prompt. **The plan's Phase 2 bullet
should be corrected to match.** The Codex hook itself (`.codex/hooks.json`) is out of scope by user
decision and nothing Codex-shaped was built "for later"; the only Codex-specific fact hard-coded
anywhere remains `targetsCodex` in `validate.ts`, which predates this pass.

**No `matcher` on the hook group.** A `SessionStart` entry with no matcher runs for every session
source. Writing `startup` would skip `resume` and `clear`, where the compiled output is just as
capable of being stale.

**`postinstall` is not written — decided against.** Printed as advice instead, always, as part of
the run's output. Three reasons, in the order they bite:

1. A consuming repo that is *itself a published package* would run that `postinstall` inside its
   own dependents' `node_modules`, where `build` walks up from its cwd, finds a `.git` that is not
   its own, and compiles into a repo it was never configured for. That is invariant 7 breached by a
   line `init` wrote — the one failure mode this verb must not have.
2. Many consuming repos are not npm packages at all, so there is often no `package.json` to add it
   to; and where there is, `scripts.postinstall` may already be a chain. `package.json` is a
   riskier file to merge into than `settings.json`, with none of the same payoff.
3. It is a mitigation and never a guarantee — `--ignore-scripts` skips it entirely, which the
   plan already records.

The advice text carries the `|| true` that keeps it fail-soft in a Docker build. If it is ever
added as a real step, it must be a `refuse`-able `InitStep` like the others so it appears in the
diff; the plumbing supports that today.

**A `sources` entry of `./skills/templates` is written live; `overrides` and `targets` are written
as commented-out lines showing the defaults.** Minimal live config, discoverable defaults, and the
tool's defaults stay authoritative rather than being frozen into every repo at init time. `init`
does *not* create the `skills/templates` directory: the build's "source root does not exist"
warning is the accurate description of a repo with no templates yet, and creating an empty
directory to silence it would be worse.

**`id` is derived from the directory name and the written config says, beside the value, that it is
derived only to get you started.** Invariant 5 is about `id` never being derived *by the tool at
resolution time*; a seeded default in a tracked file the developer then owns is a different thing.
Non-`[A-Za-z0-9._-]` runs collapse to `-`, and a name with nothing left falls back to `repo`.

**Config diagnostics are reported only when a config file already exists.** Pre-`init`, `loadConfig`
says "no usable source roots — no skills to compile", which describes the world `init` is there to
end and reads as an error in the middle of a diff. Once the file exists, it is the developer's and
what the loader made of it is theirs to see.

**A dry run with nothing to do prints `Nothing to do — this repo is already wired up.`** rather
than "re-run with --write", which would be a lie about there being something to apply.

### `init` — `settings.json`, the part that had to be right

Every case the task names is handled and tested, plus three the task did not:

| Shape | Behaviour |
|---|---|
| absent | created with only our hook |
| present, no `hooks` key | merged; unrelated keys preserved |
| present, other `SessionStart` groups | ours appended, theirs byte-identical |
| present, our hook already | file not rewritten at all — `init` is idempotent |
| present, unparseable | **refused**, file untouched, exit 1 |
| present, *valid JSONC but not JSON* | **refused** — a rewrite would silently delete the comments |
| present, not a JSON object / `hooks` not an object / `SessionStart` not an array / a group of an unrecognised shape | **refused** |
| present, a SessionStart command mentioning `composable-skills` under a *different* string | left alone with a warning, never duplicated |

The last one is the case nobody asks for and everybody hits: an older `init`'s resolved-path
command, or a hand-written entry. Appending ours beside it would build twice at every session
start, forever. Only the developer knows which string they meant, so the tool reports both and
changes nothing.

A refused `settings.json` does **not** block the config or the `.gitignore` step — those are
independent and safe. The run still exits 1, and re-running after the fix is safe because the whole
verb is idempotent.

Formatting preservation is what JSON round-tripping allows and no more: key order (which
`JSON.parse` preserves for non-index keys), the file's own indent width (sniffed from the first
indented line), and whether it ended with a newline. Anything else — a compact `["a"]` array
becoming three lines — shows up in the printed diff, which is exactly what diff-first is for. Seen
in the end-to-end run below.

### `init` — the diff renderer

`renderPlan` prints a real unified diff (LCS, three lines of context, `… N unchanged lines` for the
elisions) rather than a summary. "Prints exactly what it would do" is the contract of this verb,
and *"I will add a SessionStart hook"* is not that when the file also gets reformatted. It falls
back to a plain before/after dump past 2000 lines a side, where the LCS table stops being cheap.
Exported and unit-tested directly.

### `init` — invariant 7, stated in paths rather than in path text

`ln -s ~/dotfiles/claude .claude` makes `.claude/settings.json` a name inside the repo for a file
outside it. Text-level containment does not see that, so every step's path is walked component by
component with `lstat` and any symlink hop refuses that step — in the *plan*, so a dry run says so,
with a second assertion in `applyStep` as a backstop. The repo root itself is deliberately not
checked: a checkout reached through a symlink (`/tmp` on macOS, an automounted home) is the
caller's own working directory, not a hop this verb took. Consistent with invariant 8.

### `override` — judgment calls

**It uses the seam Phase 1 left rather than re-deriving it.** `compileSkill` returns `slots` and
`resolutions`; `SlotResolution.from` is the winning `Root` or null. Nothing here re-runs resolution
or reaches into a private function.

**`mode=append` is created empty, not seeded — a deliberate deviation from "seed with the current
default".** The build emits the default, then a blank line, then the override, so a file seeded
with the default puts that text in the compiled skill *twice*, and a developer who edits nothing
gets a wrong output the tool itself produced. The rationale for seeding, in both the plan and the
task, is explicitly about `replace` discarding the team's text — a hazard `append` does not have.
The default is printed instead, so the developer still sees the text they are extending, and the
output says which of the two happened and why. Recorded here because it is a spec deviation, not a
detail: **the spec's Phase 3 line and the verb table both say "seeds it with the current default"
unconditionally and should be qualified.**

**It refuses to seed from a template that does not compile.** The seed *is* the template's text, so
a rejected template is a text this verb cannot vouch for — and where the rejection came before slot
parsing, there is no slot list to offer alternatives from either. The compiler's own diagnostics
print first and say what to fix.

**`--dry-run` was added; nothing else was.** It is the same diff-first shape as `init` and one
line of flag parsing. A `--print`-the-default flag was considered and dropped: `override` already
prints where the slot resolves and, for `append`, the default itself, and a piping-friendly output
mode would have to fight the two-stream diagnostic rule for stdout.

**An existing file exits 0, not 1.** The developer asked for an override file at that path and one
is there. It prints the path, what currently resolves, and that nothing was written.

**A symlinked skill directory inside an override root** needs no guard here: `resolveSlot`'s
containment discipline already rejects the skill during `compileSkill`, so the run refuses before
reaching the write, naming the symlink. A guard was written, found to be unreachable, and removed
rather than left as dead code; the *property* is pinned by a test that asserts nothing is written
through the link.

### Spec/plan corrections this pass wants (not made — those files are the docs agent's)

1. **`docs/plans/…` Phase 2** — the hook command is `$CLAUDE_PROJECT_DIR`-relative, not a resolved
   absolute path. See above for why the substitution is strictly better for byte-stability.
2. **`docs/specs/…` verb table and `docs/plans/…` Phase 3** — "seeds it with the slot's current
   default" needs the `mode=append` qualification.
3. **`docs/specs/…` verb table** — `override` now takes `--dry-run`; `init`'s and `override`'s rows
   should stop being described as unimplemented, and the "only `build` exists today" sentence above
   the table is now wrong.
4. **`README.md`** — the status table still says Phase 2 and Phase 3 are planned, and the "How it
   runs" section still says "until `init` writes it, `build` is run by hand".

### Verification actually run

- `bun run typecheck` — clean (both projects).
- `bun run build` — `dist/cli.js`, shebang intact (`#!/usr/bin/env node`).
- `bun test`, all four ways — **219 pass / 0 fail** each: plain, `> out 2> err`, `> all 2>&1`, and
  `script -qec "bun test" /dev/null`. The two new suites use the existing fd-capture fixture, so
  they are invocation-independent for the same reason the rest of the suite is; both carry an
  explicit "output does not depend on how the streams are wired" test.
- **End-to-end against the real bundle** (`node dist/cli.js`), in a scratch repo outside this tree:
  `init` dry → `init --write` → add a template → `build` → `override reviewer extra-checks`
  (`--dry-run`, then for real) → edit the seeded file → `build` again → the override text is in the
  compiled `SKILL.md`. Re-run `init --write` a second time: *Nothing to do*. Re-run `override`:
  *This file already exists*. Typo'd slot name: exit 1, listing `extra-checks`. A second scratch
  repo started from a `settings.json` holding a `permissions.allow` array, to exercise the merge
  and the reformat disclosure.
- **`init --write` was NOT run against this repo**, per the task. Its dry-run diff is in the task
  report.

### Mutations checked

Each against a scratch copy of `src/` under the scratchpad; this repo's `src/` was never modified
(verified by `diff -r` afterwards). All 21 caught.

| # | Mutation | Result |
|---|---|---|
| 1 | `init`: `--write` ignored, it always writes | caught (`a dry run writes nothing at all`) |
| 2 | `init`: `settings.json` rewritten wholesale | caught (`every unrelated key survives`) |
| 3 | `init`: the already-present hook appended again | caught (`the file is not rewritten at all`) |
| 4 | `init`: PnP refusal dropped | caught (both Yarn PnP tests) |
| 5 | `init`: `.gitignore` rewritten rather than appended | caught (3 gitignore tests) |
| 6 | `init`: an already-covered ignore entry added again | caught (3 tests, incl. idempotency) |
| 7 | `init`: malformed `settings.json` overwritten | caught (`malformed: refused…`, `…does not block the config`) |
| 8 | `init`: comments round-tripped away instead of refused | caught (`comments and trailing commas…`) |
| 9 | `init`: an existing config overwritten | caught (`an existing config is left entirely alone`) |
| 10 | `init`: a target outside the repo still gets an ignore line | caught (`a target outside the repo…`) |
| 11 | `init`: the symlink refusal dropped (plan *and* backstop) | caught (`a symlinked .claude is refused…`) |
| 12 | `override`: seeds from what currently resolves | caught (3 seeding tests) |
| 13 | `override`: seeds `append` slots too | caught (`mode=append is created empty…`) |
| 14 | `override`: an existing file overwritten | caught (`left byte-identical and reported`) |
| 15 | `override`: the lowest-precedence root chosen | caught (3 seeding tests) |
| 16 | `override`: unknown slot names no alternatives | caught (`an unknown slot lists the slots…`) |
| 17 | `override`: unknown skill names no alternatives | caught (`an unknown skill lists the skills…`) |
| 18 | `override`: `--dry-run` writes anyway | caught (`--dry-run writes nothing at all`) |
| 19 | `override`: a broken template seeded from anyway | caught (`a template that does not compile…`) |
| 20 | `override`: the current resolution not reported | caught (3 tests) |
| 21 | `report`: `emitLines` always writes both streams | caught (both `…how the streams are wired` tests) |

### Noticed, not done

- **`.claude/settings.local.json`** is untouched by `init`. It is untracked and personal; the hook
  belongs in the tracked file so the whole team gets it. No test, because there is no behaviour.
- **`.gitignore` coverage is matched on normalised literal lines**, not by evaluating gitignore
  globs. A repo that ignores `.claude/*` therefore gets a redundant `/.claude/skills/` line
  appended. Implementing a real matcher to avoid one redundant ignore line is not worth the
  surface; the failure mode is a duplicate, never a missing entry.
- **PnP detection is `.pnp.cjs` only**, as the plan names it. `.pnp.loader.mjs` and
  `.pnp.data.json` do not appear without it.
- **`init` does not verify that `node_modules/composable-skills/dist/cli.js` actually exists.**
  Running `init` before `npm install` finishes, or from a checkout of this repo rather than a
  consuming one, writes a hook pointing at nothing. It would be a cheap warning to add; it was left
  out because the hook is fail-soft by design and the string must not vary with what is on disk.

## Phase 2/3 — override and fresh-clone pass

Changed: `src/override.ts` (all four `override` findings), `src/build.ts` (the fresh-clone summary
line, and the resolution seam `override` needed), `src/types.ts` (one field on `SlotResolution`).
Nothing in `test/`, `docs/` or `src/init.ts` was touched.

### `override` now seeds from what currently resolves, not from the template's default

The previous behaviour seeded `block.defaultBlock` unconditionally, which is wrong in exactly the
case the seeding exists to defuse: where a **tracked** override root already fills the slot for the
whole repo, a developer who ran `override` and edited nothing got a file that dropped the team's
text on the next build. The output even printed both facts adjacently — `resolves the override
root "./.claude/skills-local"` immediately above `seeded the template's current default` — and
mislabelled the second as "current".

`resolveSlot` already knew the answer; it was discarding half of it. It now returns the winning
override's **own** lines alongside the composed `lines` and the `from` root, and `SlotResolution`
carries that through `compileSkill` to both `override` and (later) `explain`. Nothing re-runs
resolution.

**Why the override's own lines rather than the composed result.** For `replace` the two are the
same. For `append` they are not: the build emits *default, blank line, override*, so the composed
result is not what belongs in an override file — seeding that would emit the default twice, which
is the whole reason `append` was exempted from seeding in the first place. Seeding the override
half is the rule that makes the exemption a special case of the general one rather than a
contradiction of it:

| mode | nothing overrides the slot yet | a lower-precedence root fills it |
|---|---|---|
| `replace` | the template's default (as before) | that root's text |
| `append` | empty, default printed for reference (as before) | that root's text |

So the `mode=append` exemption is kept, and is now stated as what it always was — the override half
of an `append` slot with nothing overriding it is empty. The label is provenance-bearing in every
case: *"the text that currently resolves, from `./.claude/skills-local`"*, and only the words
"the template's current default" where the default is genuinely what resolves.

**The no-op property this is all for** — build, run `override`, edit nothing, build again, and the
compiled `SKILL.md` is byte-identical — was verified by hand across all eight combinations of
{`replace`, `append`} × {no override, non-empty override at a lower root, empty override file at a
lower root, empty template default}. It holds in every one. It did **not** hold before this change,
in either mode, whenever a lower-precedence root won the slot: `replace` swapped the team's text
for the template's, and `append` (seeded empty) dropped the lower root's text entirely, since an
empty override at the winning root resolves to the default alone. There is still no test asserting
it; it is the single property most worth pinning next.

Seeded text is `trimBlockEdges`'d lines joined with a trailing newline, which is not necessarily
byte-identical to the lower root's file (blank edges go). The *compiled output* is identical
regardless, because the build applies the same trim — and `trimBlockEdges` is idempotent, so the
property survives repeated seeding.

### `describeSeed` tests emptiness before mode

A bare `<!-- slot: x mode=append -->`, and a fenced `append` slot with an empty body, both used to
print *"mode=append adds this file after the default, so seeding it would emit the default twice"*
— then skip the "The default this override will be appended to" block, because there is no default.
The spec says a slot with an empty default behaves identically under either mode, and that message
denied it at the one place a developer reads about it. The order is now: non-empty seed → say where
it came from; empty default → *"the slot declares no default, so there is nothing to replace"*;
`append` → the twice message; otherwise (a `replace` slot whose winning override file is empty) →
*"…currently fills this slot with nothing"*, which was previously unreachable prose.

### `override` says when the root it chose is inside the repo

Drop `id` from the config and `${home}/repos/${id}` goes inert, so the highest-precedence root
becomes `./.claude/skills-local` — inside the working tree, and outside the `.gitignore` block
`init` writes. The only signal was a config warning that a *root* was skipped, which says nothing
about where the file landed. `override` now prints, whenever the chosen root resolves inside
`config.repoRoot`, that the file is in the working tree and git will see it unless it is ignored,
plus a line naming the inert `${id}` root as the cause where no `id` is declared. Containment is
the same text-level `path.relative` test `config.ts` applies to a `${home}` entry — deliberately
not a `realpath` walk, because a checkout reached through a symlink is the caller's own working
directory, the same reasoning `init` uses for the repo root.

Only on the write/dry-run path. The already-exists path writes nothing and reports no root.

### Column alignment

Every row goes through one `row(label, value)` helper padding the label to 10, so `would seed`
lines up with `seeded`, `slot`, `root` and `resolves` instead of running two columns wide.

### `build` closes the fresh-clone hole from inside the tool

ADR-0001 records "a fresh clone has no skills until the first build … mitigated by a `postinstall`
build". That mitigation was declined this pass, for reasons that stand, so the hole was
unmitigated — and the advice `init` prints reaches the **maintainer**, once, while the person who
suffers is the **cloner**, who never runs `init`.

`build` runs at `SessionStart` and its stdout reaches the model, so it is the one channel that
reaches the cloner in the session where it matters, needing no cooperation from the consuming repo.
The targets that did not exist are recorded **before the compile loop**, because `emitSkill`
creates the directory itself, and a summary line is added afterwards naming them by spec.

Three conditions on it, each deliberate:

- **Summary, not a per-skill diagnostic.** It is information about the session, not a fault, and it
  must not multiply by skill count.
- **Only where something was actually built** (`built > 0`) **and the directory now exists.** A repo
  with no skills creates no target and gets no line; a target whose creation failed already has an
  error of its own.
- **Nothing on the gated path.** The stamp gate returns before this code, and a target that exists
  is not reported, so a warm repo stays silent — which is what makes the line meaningful when it
  does appear.

Wording is about the harness rather than about Claude Code by name, since the same fact holds for
every target the tool writes.

### Verification actually run

- `bun run typecheck` — clean (both projects). It failed twice mid-pass inside `src/init.ts`, which
  another agent was editing concurrently; the closure of `override.ts`/`build.ts`/`types.ts` was
  typechecked on its own in the meantime and was clean throughout.
- `bun run build` — `dist/cli.js`, shebang intact.
- `bun test` all four ways (plain, `> out 2> err`, `> all 2>&1`, `script -qec … /dev/null`) —
  **218 pass / 1 fail / 219 total**, identical counts and the same single failure in each.
- The one failure is `test/override.test.ts:62`, *"seeds from the default, not from a
  lower-precedence override that currently wins"*, which pins the behaviour finding 1 removes. It is
  the test that should now assert the opposite; `test/` was not touched.
- End-to-end against three scratch repos outside this tree, driving `runBuild`/`runOverride`
  directly: the fresh-clone line on the first build and silence on the second; seeding from a lower
  tracked root in both modes with a byte-identical rebuild; the in-repo note and the inert-`${id}`
  line in a config with no `id`; the bare and empty-bodied `append` slots' message; the empty
  override file case; and `--dry-run` alignment.

### Noticed, not done

- **`SlotResolution.override` is reporting-only, like `from`.** `explain` will want it for the same
  reason `override` did — it is the only place a slot's own override text is distinguished from the
  composed output — so it is on the interface rather than local to `override`.
- **The staleness question is untouched.** Seeding from what resolves means a developer's file now
  starts as a copy of a *tracked* root's text, which will drift when the team edits theirs, exactly
  as it drifts against a template default. ADR-0001 accepts that for defaults and the same reasoning
  applies unchanged.
- **The fresh-clone line names targets by spec, not by resolved path**, matching every other place
  the tool names a root to a human. A `~/.claude/skills` target created on first build therefore
  reports as `~/.claude/skills`.

## Phase 2/3 — init safety pass

Two reviewers ran `init` against ~30 crafted repos and reproduced fourteen findings. All fourteen
were applied; the judgment calls each one forced are below. Files changed: `src/init.ts`,
`src/cli.ts`. Nothing in `test/`, `docs/specs/`, `src/override.ts` or `src/build.ts` was touched.

### The three refusals, and why only one of them is new

`init` now refuses three things before it plans anything: a repo root that *is* `os.homedir()`, a
Yarn PnP tree, and (per step) a file whose mode denies writing.

**Home directory.** `findRepoRoot` falls back to the working directory where no `.git` is found
anywhere above, so in `$HOME` the "repo root" is the home directory and `.claude/settings.json`
under it is Claude Code's **user-level** settings file. A per-project build hook merged there runs
in every session in every repo, next to a new `~/.gitignore` and `~/composable-skills.jsonc`. This
is the one comparison whose false negative is unbounded, so it is made against `realpath` as well
as against the resolved text — a home reached through an automount or a `/home` symlink is the
ordinary case, not the exotic one. `src/config.ts` belongs to another pass, so the check lives in
`init`, which is also where the consequence is.

**No `.git` at all** is a loud warning rather than a refusal: a directory that is not a checkout is
a legitimate place to run this (`init` writes only inside it either way), but nothing used to remark
on it, and the diff header alone does not tell a developer that the tool picked their cwd because it
could not find a repository.

**A file whose mode denies writing.** `rename(2)` does not consult the target's mode, so the
staging swap replaced a `chmod 444` file without complaint, and — because a rename replaces the
inode — handed it back at the umask default. Both halves are fixed: the mode is carried onto the
staging file before the swap, and a file the process cannot write is refused *in the plan*, so the
dry run says so. A mode that says "do not write me" is a decision, and this verb's whole posture is
that a developer's decisions about their own files outrank its opinions about them.

### Detection is about the invoked program, never about the name

`commands.find(c => c.includes("composable-skills"))` matched any hook whose command *mentioned*
the name — `echo building composable-skills docs`, or any path under a directory of that name — and
the consequence was the worst available one: the hook was silently not installed, and the run then
printed *Nothing to do — this repo is already wired up*. Replaced with `invokesThisTool`, which
tokenises the command with just enough shell to respect quoting and asks whether any token *is* the
program: a path ending in `composable-skills/dist/cli.js`, or the bin shim (or this tool's `cli.js`
under a `composable-skills` directory) immediately followed by the verb `build`. A bare word is a
word; only an argv position makes it a program.

`node scripts/cli.js build` — someone else's tool with our entry-point filename — deliberately does
**not** match. The reviewer's suggested rule ("ending in `cli.js build`") would have re-created the
same class of false positive one notch narrower, and the case it buys is a copy of this tool's
bundle renamed out of its own package directory, which nothing can identify anyway.

When the branch *does* fire legitimately, the step is marked `blocked` — a new third state beside
"refused" and "nothing to do". It prints `not done  .claude/settings.json — NOT installed …`, and
it suppresses "Nothing to do — this repo is already wired up", which is replaced by "Nothing was
applied: N steps are yours to resolve by hand". **The exit code stays 0**, deliberately: the repo
*does* rebuild at every session start, under a string the developer chose, and nothing is broken.
The falsehood was in the summary line, not in the status.

### A hook that silently never runs, in the three ways it happens

The PnP refusal's justification — "the hook would be written, would silently never run, and no
session would ever report it" — applies verbatim to two shapes it did not detect and to two states
it never considered.

1. **`.pnp.cjs` above the repo root.** A config in `packages/api` makes that directory the repo
   root, while the file that decides whether `node_modules` exists sits at the top of the checkout.
   The search now walks from the repo root **up to the git root**.
2. **`.pnp.js`** — Yarn 2's spelling — is detected alongside `.pnp.cjs`.
3. **`node_modules/composable-skills/dist/cli.js` missing.** A repo that has not installed yet, or
   a checkout of this repo rather than a consuming one, gets the identical silent failure. Now a
   warning — not a refusal, because unlike PnP this is a state that ends by itself.
4. **`git worktree`.** A fresh worktree has no `node_modules` of its own, so the hook dies every
   session with `Cannot find module`, and everything downstream is fail-soft, so nobody learns. It
   is the same detectable condition as (3) and the warning names it. **The command string is not
   changed**: `.claude/settings.json` is tracked, so a resolved absolute path would be committed and
   be wrong in every other clone. The earlier note in this file that `$CLAUDE_PROJECT_DIR` makes the
   string "identical in every clone and every worktree" is true and was being read as more than it
   says — the *string* is identical; what it resolves to is not necessarily there. The warning is
   what closes that gap, and it varies with what is on disk while the written string does not.

### The written config was one uncomment away from being fatal

`"sources": ["./skills/templates"]` carried no trailing comma, and the next line invited the
developer to uncomment one of the two below it. Doing so produced `Expected ',' or '}'`, which under
`build` exits 0 by design and reaches only `.composable-skills/build.log` — the channel that exists
because nobody reads it. The repo would simply stop compiling. The loader strips trailing commas, so
the comma is valid in both states; it is written on the `sources` line and on the commented
`targets` line, and the config now says beside them that it is deliberate.

### Reporting fixes

- **A symlinked `.claude` is a verdict about a path, and it now wins over any verdict about
  contents.** `settingsStep` asks for the symlink check *before* it reads the file, so
  `.claude -> ~/dotfiles/claude` no longer reports "is not valid JSON" about a stranger's file and
  no longer prints a remedy pointing at it. The write was already refused; only the reporting was
  wrong. The refusal text now says init has not read what the link points at.
- **CRLF is preserved**, sniffed the way the indent already was, for `settings.json` and for the
  `.gitignore` append alike. The old behaviour rewrote every line ending in the file, which a
  terminal renders as every line changed and identical — a diff that discloses nothing while
  disclosing everything. A leading BOM is stripped and re-emitted for the same reason the
  frontmatter rule strips one.
- **An empty or whitespace-only `settings.json` is treated as `{}`** rather than refused. `touch`
  produces one, and a file with nothing in it has nothing for a refusal to protect.
- **`settings.local.json` and `~/.claude/settings.json` are read for detection only.** Claude Code
  merges hooks from all three files, so a developer already wired up in either gets two builds every
  session and nothing said so. Neither file is ever written, and neither one blocks the project
  file's merge — the warning is the whole intervention.
- **`--write` no longer reprints the diff.** The diff is the *dry run's* contract; after the fact it
  buries the notes and the refusals under forty lines of `+`. `--write` prints one line per step.
  Related: `renderPlan` used to `return` before `plan.notes` whenever there was nothing to change,
  so the `postinstall` advice vanished on every re-run. Notes now print unconditionally.
- **The >2000-line diff fallback is windowed.** It dumped both whole files — 6066 lines for a
  four-line insertion into a 3006-line settings file. Matching lines at each end need no LCS to
  find, so the fallback trims the common prefix and suffix, keeps three lines of context, and caps
  the middle. The LCS path was measured fine (34 lines, 0.06 s at 1906 lines) and is unchanged.

### Two dead branches removed

`gitignoreStep`'s `"nothing generated to ignore"` could not fire — `wanted` always holds
`/${STATE_DIR}/`, so a file covering everything had to exist. And `settingsStep`'s whitespace-
insensitive `"unchanged"` note could not fire for a step that had just appended a hook group, and
would have printed `unchanged` beside a file that was then written.

### `cli.ts` — shared vocabulary, different defaults

`init --dry-run`, `override --write`, and `--help` after any verb were all usage errors. The
defaults themselves are right and stay as they are: `init` merges into files the repo already tracks
so it shows the diff and writes nothing without `--write`; `override` only ever creates one file and
refuses to overwrite an existing one, so it writes by default. What was wrong is that the
*vocabulary* differed. Each verb now accepts the other's flag as an explicit spelling of its own
default, only the contradiction (`--write --dry-run`) is an error, `-h`/`--help` after any known
verb prints the usage and exits 0, and `USAGE` states why the two verbs default in opposite
directions instead of leaving it to be discovered.

### Duplication: collapsed where it could be, reported where it could not

The containment predicate was written out verbatim three times in `init.ts` and is now one
`isInsideRepo`. The deeper duplication is real and is **not** fixed here:
`firstSymlinkComponent` re-implements the component-by-component `lstat` walk that
`resolveContainedFile` in `src/directives.ts` already performs. It cannot simply call it —
`resolveContainedFile` treats a missing path as failure, and every path `init` walks is one that
does not exist yet — so unifying them means giving that primitive a "tolerate a missing tail" mode,
which is a change to a file this pass does not own. **Follow-up: one containment primitive in
`directives.ts`, with an option for a path whose tail may not exist, consumed by `init`.**

### Verification

- `bun run typecheck` clean; `bun run build` produces `dist/cli.js` with the shebang intact.
- `bun test` four ways (plain, `> out 2> err`, `> all 2>&1`, `script -qec`): **218 pass / 1 fail /
  20790 expect() calls** each — identical. The single failure is
  `override — seeding > seeds from the default, not from a lower-precedence override that currently
  wins`, in `test/override.test.ts`, against a concurrent change to `src/override.ts` by another
  agent ("the seed is what the slot resolves to *today*"). No `init` or `cli` test fails; all 40
  tests in `test/init.test.ts` pass unchanged.
- Every finding was re-run against a scratch repo built to reproduce it: home-directory refusal,
  no-`.git` warning, both PnP shapes (including one above a nested repo root), the unrelated
  `echo …composable-skills…` hook (now installed alongside), a genuine other command string (now
  `not done` plus "Nothing was applied"), a symlinked `.claude` over a malformed settings file, CRLF
  and BOM and CRLF+BOM together, `chmod 600`/`444`, empty and whitespace-only settings, a hook in
  `settings.local.json`, a 3007-line settings file (68 lines of output, was ~6000), and every
  `cli.ts` flag combination.
- `init --write` was **not** run against this repo. Its dry-run diff is in the task report.

### Left alone on purpose

- **The hook command string.** Unchanged, byte for byte, and finding 4 explicitly agrees.
- **Exit 0 when the hook is `blocked`.** Argued above.
- **`.gitignore` coverage is still matched on literal lines**, not by evaluating globs — unchanged
  from the previous pass and unrelated to these findings.

## Phase 2/3 — safety test pass

Changed: `test/fixtures/workspace.ts`, `test/override.test.ts`, `test/init.test.ts`,
`test/build.test.ts`, and a new `test/cli.test.ts`. Nothing in `src/`, `docs/specs/`, `README.md`,
`package.json` or `tsconfig*.json` was touched. **218 pass / 1 fail → 298 pass / 0 fail**, identical
under all four invocation modes.

### The fixture now owns `os.homedir()`, because `HOME` does not

`init` compares the repo root against `os.homedir()` and reads `~/.claude/settings.json` through it.
Under Bun `os.homedir()` is a real lookup and **ignores `HOME`**, so redirecting the environment was
not enough: every `init` test in this suite was opening the developer's own
`/home/<user>/.claude/settings.json`. Verified, not assumed — `strace -f -e trace=%file` over the
whole suite with the redirect removed shows exactly that `openat`.

`captured()` therefore patches `os.homedir` for the duration of every run it wraps, restoring it
the same way it restores the descriptors, and `Workspace` gains an `osHome` directory that stands in
for `~` — kept separate from `${home}`, since they are separate things. `ws.env` also carries
`HOME` and `XDG_CONFIG_HOME` for anything that reads the environment instead, and for subprocesses.
With the patch in place the same `strace` run reports **zero** syscalls against the real
`~/.claude` across 33 543 traced file operations.

This is the same class of bug as the two the fixture already exists to prevent — a test whose result
depends on the machine it runs on rather than on the code — so it is closed the same way: in the
fixture, for every verb, where no test can forget it. Invocation-independence is untouched;
`captured()` still opens its own descriptors and still pins `isTTY` false.

### `cli()` — the CLI in a child process, and why not an import

`src/cli.ts` sets `process.exitCode = main(process.argv)` at module scope, so importing it into a
test file runs the CLI against the test runner's own argv and hands its verdict to `bun test`. The
exit code is half of what the flag matrix is *about*, so the fixture spawns instead. The child gets
a generated shim that patches `os.homedir()` before `cli.ts` loads — a subprocess cannot inherit the
in-process patch — and both descriptors are pipes, so the routing is `separate` by construction
rather than by inheritance from the invoking shell.

### Task 1 — the failing test re-pinned

`test/override.test.ts` — *"seeds from the default, not from a lower-precedence override that
currently wins"* — is now *"seeds from a lower-precedence override that currently wins, not from the
default"*, asserting the seeded file **is** the lower root's text and that the report says
`the text that currently resolves, from "./.claude/skills-local"`.

The `append` twin the old `mode=append` exemption was hiding is pinned beside it: with a lower root
winning, the file is seeded with **that root's own half**, never the composed
default-plus-blank-plus-override. Both directions are asserted — the seeded bytes, and the absence
of the message the other branch would have printed.

### Task 2 — the no-op property, all eight combinations

*Build, run `override`, edit nothing, build again, and the compiled `SKILL.md` is byte-identical.*
It is the entire rationale for seeding and nothing in the suite asserted it. Now
`override — an unedited override changes nothing` runs it across
{`replace`, `append`} × {nothing overrides it yet, a lower root fills it, a lower root fills it with
an empty file, the template declares no default}.

Each case also asserts the second build **was not gated** (`1 skill → 1 target`): byte-identity that
came from not recompiling would prove nothing, and the seeded file is part of the hashed override
tree precisely so that it cannot. A ninth test pins the idempotence the property rests on — the seed
is `trimBlockEdges`'d, so seeding from a seed lands in the same place.

### Task 3 — the fourteen safety fixes

All fourteen are pinned. Notes only where a choice was made:

- **Homedir refusal** — three tests: the refusal itself (asserting the *user-level settings file* is
  byte-identical afterwards, since that is the file the false negative would have edited), the
  `realpath` half via a symlinked home, and a repo that merely *lives* under the home directory,
  which must not be refused.
- **PnP** — `.pnp.js`, and `.pnp.cjs` at the git root with the config in `packages/api`. Plus the
  bound in the other direction: a `.pnp.cjs` **above** the git root belongs to some other tree and
  must not be consulted. Without that third test, "search to the filesystem root" passes.
- **`invokesThisTool`** — matches (bin shim, `npx`, absolute and relative `dist/cli.js`, a backslash
  path, `node_modules/.bin`), does not match (`echo building composable-skills docs`,
  `cd /home/me/dev/composable-skills && npm run build`, a quoted `bash -c` whose interior mentions
  it, a bare name with no verb, and `node scripts/cli.js build`, whose non-match is deliberate).
- **`blocked`** — asserted on the *second* `init --write`, where nothing else is left to change and
  the false "Nothing to do — this repo is already wired up" is the only thing that could print. Exit
  0 is pinned as a decision, not left to drift.
- **Read-only refusal** — asserted in the dry run (`refused  .claude/settings.json — not
  writable …`), which is where the fix put it, and again under `--write` for the bytes and the mode.
- **Merged settings** — both files, warning text and byte-identity, plus that neither blocks the
  project file's merge. One test asserts the hermeticity directly: the `~` named in the output is
  the fixture's, and `os.homedir()`'s real value appears nowhere in the run.
- **Windowed diff** — pinned twice: `unifiedDiff` on a 3000-line file with a four-line insertion,
  asserted as the exact twelve lines it should be, and end to end through `init` on a 3000-entry
  `permissions.allow` file, asserted under 120 lines of output. The old dump produces ~6000.
- **The config's own invitation** — the two commented lines are uncommented in all four subsets;
  each must `parseJsonc` and each must still load through `init` without an error. Deleting the
  trailing comma after `"sources"` fails three of the four.
- **The fresh-clone notice** — the first build says it, naming targets by spec and joining several
  into **one** summary line; the gated second build is silent; an *ungated* rebuild is silent too,
  because the target now exists; and a pre-existing target is never reported.

### Mutation check

Twenty-seven mutations, applied to a **scratch copy** of `src/` outside the repo (the repo's `src/`
verified byte-identical afterwards with `diff -r`). **All twenty-seven were caught, each by the test
written for it** — no mutation was caught only incidentally by an unrelated test. The full table is
in the task report; the shape of it: one mutation per fix, plus a second in the opposite direction
wherever a guard has a bound that a one-sided test would leave unpinned (PnP's search ceiling, the
fresh-clone notice's absence on a warm repo, `invokesThisTool`'s false positives).

### Coverage judged not worth closing

- **`windowedDiff`'s `capped()` branch** — a *changed region* larger than 2000 lines. It is the cap
  on a cap; constructing it costs a slow test for output nobody reads to the end of either.
- **Running as root.** `access(W_OK)` succeeds for root, so the `chmod 444` refusal test is vacuous
  there. Not guarded: this suite is not run as root, and a skip would hide the vacuity rather than
  report it.
- **Real Windows paths.** `invokesThisTool`'s backslash handling is pinned on a synthetic string;
  nothing here runs on Windows.
- **Symlinked-`.claude` × unwritable-file interaction.** The ordering (path verdict beats contents
  verdict) is already pinned by the existing symlink test; the combination adds no new branch.

### Verification actually run

- `bun test` four ways (plain, `> out 2> err`, `> all 2>&1`, `script -qec … /dev/null`) —
  **298 pass / 0 fail / 21 099 expect() calls** in every one, identical.
- `bun run typecheck` — clean, both projects.
- `strace -f -e trace=%file` over the whole suite — zero references to the real `~/.claude`; and the
  same trace with the fixture's homedir patch removed shows the `openat` it prevents.
- `diff -r src <scratch pristine copy>` — the repo's `src/` unchanged by the mutation pass.
