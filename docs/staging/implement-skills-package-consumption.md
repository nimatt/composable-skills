# Implementation notes — make a skills package installable

Plan: [`docs/plans/skills-package-consumption.md`](../plans/skills-package-consumption.md)
Started: 2026-09-04, against HEAD `4cd25cf` on `main`, working tree otherwise clean.

Subagents append here. Sections below are added per phase; the user reviews this file after the
run and promotes anything that matters into the spec, an ADR, or a follow-up plan.

## Pre-implementation

### Assumptions

- **Diagnostic wording is the implementer's to choose.** The plan fixes the failure *kinds*, not
  the strings. Tests assert on substrings, so the test task must read the strings the code
  actually emits rather than inventing its own.
- **`expect` defaults to `file`,** so `include:` resolution is byte-identical after the change;
  the existing `not-file` failure kind stays for files and a new kind covers "not a directory".
- **The chain walk starts at the repo root** (the config file's directory), matching today's
  `createRequire(repoRoot/package.json)` anchor — not the working directory.
- **First hit wins, and a directory without `package.json` is walked past, not a stop.** A
  `node_modules/<name>/` holding no `package.json` does not shadow a real package higher up.
- **The severity change applies to `sources` only.** Override and target roots keep their current
  severities; a missing override root is normal and must stay silent.
- **The containment warning fires once per source root,** naming the first offending target or
  the state directory, rather than once per pair.
- **README placement:** the packaging section goes after `## Install`, before the worked example.

### Open questions

- **Where do the two moved bullets live in the spec?** They leave *Warned* (`tool-contract.md:395`),
  but *Rejected* at `:358` is explicitly per-skill and a config entry error is not. The likely
  home is the entry-level framing at `:383-385`, which already says an unusable entry is "a
  warning or an error against that entry alone". Resolved by the docs task; recorded here because
  the plan says what leaves *Warned* and not what it joins.
- **Does the aggregate warning still read correctly** once every entry errors on its own? It may
  want rewording from "no usable source roots — no skills to compile" to something that does not
  imply it is the only signal. Left to the implementer's judgment.

### Concerns / risks

- **Line citations decay as the phases run.** Every `file:line` in the plan is true at `4cd25cf`
  and false after the first phase edits that file. Implementers locate by symbol name, never by
  line number.
- **Ancestor `node_modules` in the test environment.** The walk climbs to the filesystem root, so
  a test that asserts "package not found" could be defeated by a stray `/tmp/node_modules` on
  someone's machine. Test packages must use a scope unique enough that no ancestor can hold one.
- **`test/config.test.ts:220` carries two assertions** — the severity *and* the pruning
  suppression. The rewrite must keep the second.
- **Severity changes can flip unrelated tests** that assert exit codes or use `hasWarning`. The
  suite is 397 green at the start and must be 397+ green at the end.

## Phase 1 — resolver and containment

- **Assumption: an invalid package *spec* gets its own failure kind (`spec`), not folded into
  "absent".** The task listed five kinds to distinguish and did not name this one, but
  `isPackageSpec` rejects before any lookup happens and its failures (`@acme//templates`,
  `@acme/../escaper`, a bare `@scope`) are not "the package is not installed" — telling a
  developer to install `@acme/../escaper` would be wrong advice. If this is unwanted, the fix is
  to delete the `spec` arm and return `{ kind: "absent" }` from the `isPackageSpec` gate; the
  existing tests at `test/config.test.ts:263-264`, `:288` pass either way because both messages
  keep the substring `source "<spec>" could not be resolved as a package`.
- **Assumption: a bare scope (`"@acme"`, one segment after the `@`) is a `spec` failure.** It is
  not a package name, and the old code would have handed it to `require.resolve` as
  `@acme/package.json`. No test covers it today.
- **Assumption: the miss-shaped messages keep the old substring, deliberately.** Five existing
  assertions in `test/config.test.ts` contain `could not be resolved as a package`, and the task
  fixed the baseline at 397/0 with tests off-limits. So `spec` and `absent` keep that phrase and
  append their own reason, while the subpath kinds — which no test asserts today — are worded
  freely, and the symlink one as a refusal. If the test phase prefers different wording for
  `spec`/`absent`, those five assertions have to move with it.
- **Assumption: the no-subpath case returns the `node_modules` path, not its realpath.** Only the
  subpath case goes through `resolveContainedFile`, which realpaths the root. Preserving the
  un-realpathed path for a bare package spec keeps the pnpm behaviour byte-identical to today
  (the source root reported in diagnostics stays the `node_modules/@scope/name` a developer
  recognises). A subpath under a pnpm symlink therefore reports the store path instead — that is
  containment's own doing and the reason the two differ.
- **Open question: the resolver's `unreadable` / `root-unreadable` arms are close to
  unreachable.** Measured: a mode-000 subdirectory still `lstat`s fine, so it resolves and
  `discover.ts` reports it (`cannot read source root … EACCES`); making the *package root*
  unreadable instead makes `isFile(<root>/package.json)` fail, so the walk continues past it and
  the failure is `absent`. Both arms are written and correct, but a black-box test for them may
  not be constructible without a race or an exotic mount. Resolved by the test phase deciding
  whether to attempt one.

## Phase 2 — severity (config)

- **Assumption: the `${id}`-with-no-`id` diagnostic splits by kind rather than staying uniform.**
  The task named this as the judgment call to make and log. A `sources` entry naming `${id}` in a
  config that declares no `id` is a source the tool cannot use, so it is now an `error`; the same
  message for an `override` or a `target` stays a `warning`, because `${home}/repos/${id}` ships
  in `DEFAULT_OVERRIDES` and being inert without an `id` is the designed behaviour, not a mistake.
  The split is a ternary on `kind === "source"` inside `expandVariables`, whose `kind` parameter is
  typed `string` rather than the union — left as it is rather than narrowed, since narrowing is a
  refactor and the callers only ever pass the three literals.
- **Assumption: the aggregate `no usable source roots — no skills to compile` keeps its exact
  wording.** The task invited a reword if it overclaims. It does not: it names a state ("there are
  no usable source roots") and its consequence, both of which are true whether the config declared
  no sources at all or declared some that every one of which errored on its own line above it. It
  neither asserts a fault nor claims something failed, which is what a reword would have had to
  remove. Rewording would also churn assertions in the test phase for no gain.
- **Assumption: `sourcesIncomplete` and the pruning suppression it drives are untouched.** They
  are computed from `sources.length < sourceSpecs.length`, which is unchanged by severity, so a
  source that now errors still suppresses pruning exactly as it did when it warned.
- **Six existing tests now fail, all in `test/init.test.ts`, all asserting `hasError(...) === false`
  on a freshly `init`ed repo.** `init` scaffolds `"sources": ["./skills/templates"]` into a repo
  where that directory does not exist, so the run now produces
  `error source root "./skills/templates" does not exist at … — skipped`. This is the exact
  consequence the plan states under change 2 ("A repo freshly `init`ed goes red on `--check` until
  its first template exists … That is correct"), so it is information for the test phase, not a
  defect: `init — diff first > the config it writes is one the tool can load`, the four
  `init — the config survives its own invitation > … still parses and still loads` cases, and
  `init — the config survives its own invitation > uncommenting the targets line still yields the
  ignore lines it implies`. Note that all six assert on `hasError`, never on the exit code, which
  stays 0 — `init` is unaffected in behaviour, only in the severity of a diagnostic it reports.
- **Open question: does `init`'s own output want a softer signal for the directory it just
  scaffolded a name for?** The plan settles that `init` is deliberately not changed to paper over
  the red, and the six failures above are all `init`'s. Left exactly as the plan says; recorded
  only because the test phase will see six `init` tests move and should not read that as scope
  creep into `init`.

## Phase 2 — severity (discovery)

- **Assumption: the message text is left exactly as it was.** `cannot read source root ${path}:
  ${describe(cause)} — skipped` contains no word that names the old severity, and "skipped" still
  describes what happens — the root is passed over and the run continues. Only the constructor
  changed. Biome then collapsed the `diagnostics.push(...)` call onto one line, because `error(` is
  two characters shorter than `warning(`; that is the formatter, not a rewording.
- **Assumption: `complete = false` is untouched, so the two mechanisms stay independent.** The
  severity decides `--check`'s exit code; `complete` decides whether pruning may run. A root that
  cannot be read still sets both, and the `warning("a configured source root could not be read in
  full — nothing was pruned this run")` in `build.ts` stays a warning — it reports a consequence
  the tool chose, not a source the tool cannot use.
- **Assumption: nothing in `build.ts` needed to change for the error to reach `--check`.** Discovery
  diagnostics land in `live`, which is recomputed every run and folded into `broken` on both the
  fresh-stamp and stale-stamp paths, so an unreadable root fails `--check` even when the stamp
  verifies. `build` still exits 0 unconditionally.
- **Assumption: only the source-root arm moves.** The four other `warning`s in `discover.ts` — the
  symlinked skill directory, the unreadable template, the unreadable skill directory, and the
  cross-source name collision — are per-skill or per-entry and stay warnings. Each of them leaves
  the rest of the corpus intact; the source-root failure is the only one that means "the corpus the
  config promised is not there".
- **Open question: should the source-root diagnostic carry `file: root.path`?** It is the only
  diagnostic in `discover.ts` with no location fields, so a consumer reading structured output gets
  the path only by parsing the message. Left alone deliberately — out of a severity-only task — and
  resolved by whoever owns the report shape.

## Phase 3 — containment warning

- **Assumption: `isAtOrUnder`, not `isUnder`.** The plan's own wording is "if the state directory or
  any target root is at or under it", and a target root *equal* to a source root is the same
  mistake in its most extreme form, not a special case to exempt. `isUnder` is the security
  boundary's question; this is the advisory question, which `contain.ts`'s own comment assigns to
  `isAtOrUnder`.
- **Assumption: the comparison is asked twice — resolved text, then real path — and either answer
  suffices.** `isSamePath` in `steps.ts` could not be reused: it answers equality, not containment,
  and it returns `false` when either side cannot be realpath'd. A target directory normally does
  not exist on a first run, so `realpathSync` throws on it; a source root reached through a
  symlinked parent is only comparable by real path. `canonicalPath` falls back to `path.resolve`
  for a path that cannot be realpath'd, and `rootContains` tries the lexical pair first, so the
  first-run case (target absent) still warns — verified by hand: the warning fires on the run that
  creates `./.claude/skills`, before it exists.
- **Assumption: targets are checked before the state directory, and only the first offender is
  named.** With `sources: ["."]` both offend; the target is the actionable one and the state
  directory is a consequence of the same layout, so naming both would be two sentences describing
  one mistake. "Once per source root" is the plan's instruction.
- **Assumption: the diagnostic is unlocated.** No `file:` or `line:` field, matching every other
  `resolveRoots`-adjacent diagnostic in `config.ts`. It names two absolute paths in its message
  instead; the same open question recorded under phase 2 (whether these want location fields)
  covers it, and is still for whoever owns the report shape.
- **Open question: should a *package* source root that contains a target warn?** It cannot in any
  layout that is not already broken — a target under `node_modules` would be pruned by the next
  install — but the check does not special-case package roots, so it would fire if someone
  contrived one. Left uniform: the consequence for the stamp is identical whatever kind of root it
  is, and a kind-specific exemption would be a rule with no observed case behind it.
- **Note: `src/stamp.ts` is untouched.** The walk still has no exclusions; that was cut by the plan
  and this phase only names the consequence.

## Phase 4 — tests (init)

- **Assumption: one deliberate pin, not six.** Only `init — diff first > the config it writes is
  one the tool can load` now names the missing-source-root error, asserting the *whole* error line
  and that it is the only one. That test's subject is the config `init` writes into a fresh repo,
  which is exactly the situation the plan's "### 2 — A source the tool cannot use is an error"
  describes, so it is the honest place to record the accepted consequence. Repeating the same
  assertion in the other five would restate one design decision five times and bury each test's own
  subject.
- **Assumption: the other five get the directory instead.** The five tests in `init — the config
  survives its own invitation` are about the two lines the config invites the developer to
  uncomment, not about `sources`. Their fixtures now `mkdir` `skills/templates` — the steady state
  of a repo that has added its first template, and the state the plan says ends the error. That
  keeps `hasError(...) === false` a live assertion about uncommenting: with the error present
  unconditionally, an error newly introduced by an invited line would hide inside it.
- **Assumption: naming the error beats `hasError === true`.** `errorsOf(run)` (new, beside
  `commandsOf`) filters the `composable-skills: error` lines so the pin is an exact `toEqual` on
  one formatted line, including the absolute path. Any second error, or a change to that message,
  fails the test rather than satisfying a boolean.
- **Note: `src/init.ts` is untouched**, as the plan requires. No `.gitkeep`, no commented-out
  `sources`. The `--write` runs in these tests never saw the error anyway: `loadConfig` runs before
  the config is written, so only a *second* `init` over the config it wrote reports it — which is
  why exactly six tests failed and not every test that calls `init` twice.
- **Open question: does `test/build.test.ts` (and the other suites that scaffold a config by hand)
  now carry a silent error?** They pass, because their fixtures name source roots that exist. Not
  investigated further — outside this task, and green either way.

## Phase 5 — docs

- **Assumption: the `${id}` asymmetry belongs in the spec, though the plan never named it.** The
  spec said "an entry containing `${id}` is skipped with a warning where the config declares no
  `id`", which is now false for `sources` — `expandVariables` (`src/config.ts`) errors there and
  warns for overrides and targets. Verified in a scratch repo: a `sources` entry using `${id}` with
  no `id` prints `error`, the default `${home}/repos/${id}` override prints `warning`, and
  `--check` exits 1. The sentence was rewritten to state both severities and why they differ, and
  the *Warned* list's config bullet now reads "an override or target entry using `${id}`". Left
  unstated would have been a spec passage contradicting shipped behaviour on a line the plan
  happened not to enumerate.
- **Assumption: the resolution rule goes beside `sources`, not in a new section.** The plan asked
  for it "where `sources` is described". It is one paragraph after the defaults paragraph in
  *Configuration*, covering the `node_modules` walk from the repo root upward, that `main` and
  `exports` are never consulted, that node's global fallbacks are deliberately not honoured, and
  that a subpath carries `include:`'s containment discipline with only the package root's own last
  component exempt from the symlink rule. That is what the tool now enforces, so it stays inside
  the scope the plan sets for the spec; the how-to for authoring a pack went to the README.
- **Assumption: the hard-dependency sentence lands in the entry-level severity passage.** The plan
  left the placement open. It sits at the end of the rewritten "a single unusable *entry*"
  paragraph, immediately after the sentence naming which entry failures are errors, because that is
  where the consequence is derived rather than asserted.
- **Note: the unreadable source root is named in the error passage, not in the *Warned* discovery
  bullet.** `discover.ts` raises it, so it is not a config entry, but it is the same rule; the
  passage says so explicitly ("the same rule reaching into discovery") rather than leaving a
  discovery error unmentioned in the only place severities are explained.
- **Note: the QA answer was struck, not deleted.** `qa-composable-skills-tooling.md` is an evidence
  record, so the false sentence stays visible under `~~strikethrough~~` with a dated **Corrected
  2026-09-04** block beneath it giving the mechanism (discovery walks up and stops at `.git`;
  `DEFAULT_SOURCES` is empty) and the outright rejection of a package-supplied default config.
- **Verified against the built CLI**, not read off the source: subpath source with an `exports` map
  and no stub `package.json` compiles; templates at the package root compile; absent package,
  mistyped subpath, and a subpath crossing a symlink each print their own error and exit `--check`
  1; a `"sources": ["."]` repo prints the containment warning and still builds. `bun test` 397 pass
  / 0 fail and `bun run typecheck` clean after the doc edits — no `src/` or `test/` file touched.
- **Open question: should the README's `## Install` note and the new packaging section say the same
  thing about Yarn PnP?** `## Install` already scopes PnP out; the packaging section does not
  repeat it, on the assumption one statement is enough. Not raised with the plan.

## Phase 4 — tests (config)

- **Assumption: every test package is named under a `@cskt-…` scope.** `findPackageRoot` climbs to
  the filesystem root, so an ancestor of the temp workspace — `/tmp`, `/` — could in principle hold
  a `node_modules` that satisfies a name a test asserts is absent. `@acme/…`, which the existing
  fixtures use, is plausible enough to collide; `@cskt-absent/pack`, `@cskt-check-partial/pack` and
  the rest are not. The rewritten `:220` test renamed its spec from `@acme/absent` for this reason,
  which is the only change to that fixture beyond the severity.
- **Assumption: severity is asserted on the diagnostic line, not with `hasError` alone.** Every
  new severity-bearing assertion spells the substring as
  `composable-skills: error <message prefix>`, because `hasError`/`hasWarning` are satisfied by any
  unrelated diagnostic in the same run — which is exactly how `:220`'s warning-era title survived
  a change that made it false. The substrings stop at the first absolute path and resume after it,
  so nothing asserts a temp-directory name.
- **Assumption: the pruning half of `:220` is the same two assertions it always was.** `hasWarning`
  stays true — now carried by `a configured source root could not be read in full — nothing was
  pruned this run` rather than by the resolution failure — and `beta`'s output still standing after
  its template is deleted is untouched. The title moved from "warns" to "errors"; nothing was
  dropped.
- **Assumption: a `--check` test that expects 1 builds first, so the exit code is the severity and
  not staleness.** For the unreadable-root case that is asserted outright: the test gates green
  once *before* the `chmod`, and only then locks the directory. That is sound because
  `listEntries` (`stamp.ts:180`) swallows its own `readdirSync` failure, so an unreadable empty
  directory contributes exactly what a readable empty one did and the stamp is unchanged. The test
  also asserts the report says neither "up to date" nor "stale".
- **Assumption: "a config that declares no sources at all" means the `sources` key is absent**,
  not `"sources": []`. That is the inert default the plan names — `DEFAULT_SOURCES` is empty — and
  it exercises the defaulting path rather than an explicit empty array.
- **Assumption: the existing `:292` test stays as it is.** Its assertion,
  `source "@acme/loose-files" could not be resolved as a package`, is still a true substring of the
  new `absent` diagnostic, so it did not encode old behaviour and had nothing to rewrite. What it
  could not prove — that the walk *continues* past a non-package directory rather than stopping at
  it — is pinned by a new test beside it, which puts a real package of the same name in an ancestor
  `node_modules` and asserts that one compiles while the repo-level directory's `stray` does not.
- **Assumption: the pnpm fixture links the package root, not its parent.** `node_modules/@cskt-pnpm/pack`
  is the symlink and `node_modules/@cskt-pnpm` a real directory, which is the shape pnpm produces;
  linking the scope directory instead would test a different exemption than the one
  `tool-contract.md:203` grants.
- **Open question: the unreadable-root test assumes the process is not root.** `chmod 000` does not
  stop uid 0, so this test would go green-for-the-wrong-reason in a container that runs the suite
  as root. It is the same assumption several existing `chmod` tests in the suite already make, so
  it was not solved here; whoever owns CI's container image should know it is load-bearing in more
  than one file now.
- **Note: no fixture capability was added.** `symlink()`, `chmod()`, `mkdir()` and `write(ws.root, …)`
  covered every layout, as the plan predicted. `test/fixtures/workspace.ts` is unmodified.

## Review round — code findings

Eleven findings from the six-lens review, addressed in `src/` only. Applied: 1, 2, 3, 4, 5, 6, 7,
9, 10. Partial: 8. Rejected: 11.

- **Note: `isMissing` moved from `discover.ts` to `fsutil.ts`.** Finding 3 asks for
  `resolveContainedFile` to live in `contain.ts`, and it needs `isMissing`. Importing it from
  `discover.ts` would have made the containment leaf depend on the directory walker — the layering
  the finding exists to fix, moved one module along. `fsutil.ts` imports nothing of the project's
  own, so both `contain.ts` and `discover.ts` reach it downward. Pure move, no behaviour change;
  `emit.ts` and `directives.ts` follow the import.
- **Note: the containment warning's *claim* was shape-dependent, not only its remedy.** Finding 9
  addressed the remedy. Reproduced before rewriting: with `sources: ["."]` the state directory is
  inside the source root, `stamp` and `build.log` are rewritten every run, and `build --check` is
  stale forever — the old text is exact. With a *target* inside a source root and the state
  directory outside it (a workspace package root reached through its `node_modules` symlink), three
  builds then `--check` reports **up to date**: the stamp is computed before anything is written
  and the output is byte-stable, so the layout settles after one extra rebuild. The old sentence
  "the freshness gate never closes … can never report the output up to date" was therefore false
  for one of the two shapes it fires on. The new text says what is true of both and names which
  shape gets the worse symptom.

### Disputed findings

- **Finding 8 — "`rootContains` asks containment twice and neither half is load-bearing", partial.**
  The list-and-`find` collapse is applied. The realpath arm is **kept**, because the case it exists
  for is constructible and was reproduced: `node_modules/@scope/pack -> ../../packages/pack` (the
  workspace/pnpm link that is the one exemption invariant 8 grants) with
  `targets: ["./packages/pack/out"]`. The source root's path is
  `<repo>/node_modules/@scope/pack` — `findPackageRoot` returns the walked path, not a `realpath`,
  and only a *subpath* source goes through `resolveContainedFile`, which is the one that returns a
  real path. The target's is `<repo>/packages/pack/out`. Lexical containment between those two is
  plainly false; the realpath arm is what fires. And it is right to fire: `listEntries` reads the
  source root through the symlink and hashes the output under it. The finding's premise — "every
  path comes from `path.resolve(repoRoot, …)`, so lexical containment is exact" — held before
  package source roots existed and does not now. The mutation-testing evidence (both arms deletable,
  suite green) is a gap in `test/`, not evidence the arm is dead; the layout above has no test.
- **Finding 11 — "where a package source root resolved is reported on no channel", rejected.**
  Not adding it. Three reasons, in the order they bite. (1) There is no log-only channel:
  `emitReport` renders one text and writes it to stdout, stderr and `build.log` alike, by design
  (the three-channel rule). Recording the resolved path in the log therefore means printing it at
  every session start, for every package source, forever — and `build` runs from a `SessionStart`
  hook whose stdout is fed to a model. That is the diagnostic-volume discipline the project holds
  everywhere else, spent on information that matters once, at setup. (2) The ambiguity the security
  reviewer showed — a repo-local `node_modules/<name>/` with no `package.json` walked past in favour
  of an ancestor's package of the same name — is a documented *success* of a deterministic rule
  ("a directory that exists but carries no `package.json` is not a package, so the walk continues
  past it"), and every *failure* of the walk already names the repo root it started from and says
  what it could not find. (3) The verb whose job is "where did this come from" is `explain`
  (phase 5), which reports per-skill provenance on demand rather than per-build. A package source
  root belongs there, with the override roots, and not in the build's per-session stdout.

## Fix pass — tests

Ten mutations, the one failing assertion and the two extra review items, all in
`test/config.test.ts`. Every test added below was verified against the mutation it is meant to
catch, in a copy of `src/` under the scratchpad — never in the real `src/`.

### Assumptions

- **The renamed test title is part of the fix, not decoration.** `sources: ["."] warns that the
  freshness gate can never close` asserted a claim the message no longer makes, and the claim was
  false for that shape (a target alone settles after one extra rebuild). The title now says what
  the case actually shows — the target is an input to the next stamp — and the *state-directory*
  case, added beside it, is the one that carries "reports stale forever".
- **The bad-spec assertions were tightened, not just extended.** Every package failure kind opens
  with `could not be resolved as a package`, so the old assertions would have passed on an
  `absent` failure too — which is exactly what `segments.length < 0` turns the bare-scope case
  into. All three entries now assert down to the `not a package name:` clause.
- **`@acme` stays as the *spec* in the bad-spec test** (it is refused before the filesystem is
  touched, so no ancestor can satisfy it). Only fixtures that reach the filesystem asserting a
  miss were moved to the `@cskt-` discipline.
- **The `${id}`-in-`sources` test declares no `id` at all** rather than a malformed one: that is
  the shape the override half is pinned in, and the only one that reaches `expandVariables`'
  severity choice.

### Open questions

- **Is a symlinked `node_modules` meant to be refused?** `findPackageRoot` `lstat`s
  `<dir>/node_modules` before the name components, so `node_modules -> ./vendor` — a real shape
  (shared caches, container volumes) — is refused with the same "only a package root's own last
  component may be one" message as a symlinked scope. Pinned as shipped, in
  `a symlinked node_modules is refused`, because it is the only case that reaches that `lstat` at
  all (an unscoped name has no scope component between the two). Flagged rather than assumed: if
  the intent was only to close the *scope* hole, this test is the one to revisit.

### Judgment recorded

- **Finding 11 — "the flat-install test duplicates the wrapper test" — partial, not applied as
  written.** The overlap was real while both used a scoped name. Rather than delete the test, it
  now installs an *unscoped* package (`cskt-flat-pack`), which no other case in the suite did —
  and which is what the reviewer's fourth mutation (`const nameLength = 2;`) was surviving on. The
  test therefore stops being a duplicate and starts being the only coverage of where a name stops
  and a subpath begins. `hasWarning === false`, the finding's stated addition, was moved onto the
  wrapper test as suggested, so nothing was lost by keeping this one.

## Fix pass — docs

Twelve documentation findings from the six-lens review, addressed in `docs/` and `README.md` only.
All twelve applied; nothing disputed. Every claim was reproduced against a CLI built from the
current `src/` before the prose describing it was written — a scratch repo per layout, with
`COMPOSABLE_SKILLS_HOME` pointed inside the scratch tree.

- **Reproduced, finding 1.** `"sources": ["@acme/pack/templates"]` with `templates` replaced by a
  symlink out of the package is refused: `error source "@acme/pack/templates" was refused —
  "templates" traverses a symlink at "templates" …`, and `--check` exits 1. A bare
  `"@acme/pack"` whose package directory is a symlink still resolves. So the exemption is *the
  package root's* own last component, never *a source root's* — a subpath source root's last
  component is a directory inside the package and is checked like any other. Invariant 8 and the
  *Resolution* paragraph were both narrowed to say that; the *Configuration* paragraph already did.
- **Reproduced, finding 12.** `node_modules/@acme -> …` (a symlinked scope directory) and a
  symlinked `node_modules` are both refused with `only a package root's own last component may be
  one`. Documented in *Configuration* as one of three named refusals, alongside the lexical assert
  that the name path stays under `<repoRoot>/node_modules` and the `[\\/]` split.
- **Assumption: severity belongs in the spec, install advice in the README.** Finding 7's clause
  (`--check` belongs in a dev install) was cut from `tool-contract.md` and left standing in
  `README.md`, where it already was. The enforced half — a repo installing without devDependencies
  must not name a source — stays in the spec as the consequence of the severity rule.
- **Finding 5 resolved towards the pinned vocabulary rather than towards a new synonym.**
  `CONTEXT.md` is unchanged. "pack" is gone from `README.md` (six uses) and the spec (one); the
  README says "the templates package" or "the package", which is the word the spec's own
  resolution paragraph already uses throughout, so no new term was coined. "consumer" in the
  flagged sense is gone from the README. **Left alone:** `tool-contract.md:373`, *"the report's
  main consumer is a model reading a session hook's stdout"* — that is a consumer of the report,
  not the repo/developer conflation `CONTEXT.md` flags, and rewriting it would obscure the
  sentence for no gain.
- **Reproduced, finding 8.** `"sources": ["", "./skills/templates"]` builds one skill, warns
  `empty source entry ignored`, and `--check` exits 0. Stated in the spec as one of two exceptions
  to the severity rule; the other, in the opposite direction, is that a `${home}` escape errors in
  all three lists by containment rather than by the source rule (finding 6).
- **Reproduced, finding 9.** A second `init` in a repo it has already wired up prints
  `error source root "./skills/templates" does not exist …` and exits 0. The first `init` in a repo
  with no config does not print it — `planInit` withholds config diagnostics until a config exists
  — so the sentence in the spec says *a second* `init`. `override` likewise prints severity and
  gates on its own outcome instead.
- **Reproduced, finding 10.** Bare spec reports `source root "@acme/pack" at
  <repo>/node_modules/@acme/pack` — the walked path, symlink intact. Subpath spec reports
  `source root "@acme/pack/templates" at <store>/pack/templates` — `realpath`'s answer. Both from
  the source-root containment warning, which prints `Root.path` verbatim. Documented beside the
  resolution rule, with the consequence that re-spelling an entry from one form to the other
  changes the stamp and costs one rebuild. **No code change proposed.**
- **Open question, observed while checking finding 10 — not a finding, and no change made.** The
  containment warning fires a build later for a subpath source root than for a bare one in the same
  layout: `rootContains` falls back to `canonicalPath`, which can only `realpath` a target that
  already exists, and the realpath'd subpath root is lexically unrelated to the target's configured
  spelling. With a bare spec the lexical arm matches on the first build. Nobody loses a diagnostic
  permanently — the second build warns — so this is recorded rather than raised.
- **Finding 4 applied to `qa-composable-skills-tooling.md` only.** Both false claims struck with a
  dated block, matching the form already at `:157`. **Not touched:**
  `implement-composable-skills-tooling.md:319`, *"Assumption: `sources` entries that are not
  path-like resolve by node module resolution"*. That file is an append-only record of what was
  assumed during an earlier implementation, not a live answer document with a promotion target; the
  qa file is the one that reads as a current claim about the tool.
- **Finding 11 applied by moving, not by glossing.** *Shipping skills as a package* now sits after
  *A worked example*, which is where "consuming repo", `sources`, and the config shape are
  introduced. The moved section gained one gloss of its own — the `.composable-skills/` state
  directory, which *Build behaviour* introduces further down.
- **Checked and found stale, corrected under finding 12.** The *Warned* list's containment bullet
  and `README.md`'s packaging section both still carried the pre-rewrite claim that the gate "never
  closes" and `--check` "can never report the output up to date" — false for the target-only shape,
  as the code fixer's own note records. Both now say what the shipped warning says. `README.md`
  also repeated the `--check` enumeration finding 2 flags in the spec; both were widened to name
  discovery. No doc under `docs/specs/`, `docs/decisions/` or `README.md` names a source module, so
  the `contain.ts` / `fsutil.ts` move needed no doc change.

## User-directed fix — spec prose

Two re-review findings applied to `docs/specs/tool-contract.md` alone. Both were cases where the
document had become knowingly false; neither is a behaviour change.

- **Invariant 8's exemption widened from "a package root" to "a source root".** The previous
  amendment was right about package subpaths and wrong in general. Verified in `src/`: a path
  `sources` entry is `path.resolve`'d against the repo root and checked only with `statSync`, which
  follows the link (`config.ts` `resolveRoots`, `isDirectory`); `discoverSkills` `readdirSync`s
  `root.path` directly; `listEntries` in `stamp.ts` walks it directly; and `directives.ts` calls
  `resolveContainedFile(sourceRoot, …)` with `rejectSymlinkedRoot` unset. Nothing `lstat`s a source
  root's own last component whichever way it was named. Reproduced end to end: a repo whose
  `./skills/templates` is a symlink to a directory outside the repo compiles what it finds there,
  with zero diagnostics and exit 0. The exemption is a **source root's** own last component —
  deliberate for a package root, incidental for a path root — and nothing *inside* a resolved root
  is exempt, a subpath's components and the `node_modules` name path included. Applied in three
  places: the Configuration section's resolution paragraph, the overrides passage under
  *Resolution*, and invariant 8. Override roots are untouched by the exemption and the spec still
  says so — `compile.ts` passes `rejectSymlinkedRoot: true` for them.
- **The containment warning is `build`-only, and the spec now says so twice.** `outputsInsideSources`
  returns into `LoadedConfig.buildAdvice`, which only `runBuild` folds into its report; `init.ts`
  and `override.ts` read `loaded.diagnostics` and nothing else. Confirmed by running all three verbs
  against a repo whose target sits inside its source root: `build` warns, `init --dry-run` and
  `override --dry-run` do not. The severity paragraph's claim that `init` and `override` "print the
  same diagnostics" now carves this warning out, and the *Warned* list's config bullet marks it as
  reported by `build` alone.

Nothing disputed. Prose describes the rules rather than quoting diagnostic text, since the strings
were being edited in parallel.

## User-directed fix — walk diagnostics

`findPackageRoot` recorded the *first* level it refused anywhere on the `node_modules` chain and
then either discarded it (a higher level resolved) or reported it *instead of* `absent` (nothing
resolved). Both halves are now gone, and the third symptom — `catch {}` reading an `EACCES` as
"not a symlink" and then as "no package.json" — with them.

**Shape of the fix.** The walk returns `{ path: string | null; skipped: SkippedLevel[] }`. A
`SkippedLevel` is `{ kind: "symlink" | "unreadable"; part; cause? }`, and the list survives the
walk rather than being collapsed to one entry or dropped by a later success. Where `path` is set,
every entry sits *below* it and is a place a nearer copy could have been, so each becomes a
warning. Where `path` is null, `unresolvedFailure` picks the headline: `absent` unless a level was
unreadable, in which case a new `PackageFailure` kind `unreadable` takes it and the rest stay as
context. A symlink refusal never takes the headline — it is a rule this tool chose, it fires on
ancestors the project never named, and it names no remedy. `packageFailureDiagnostic` now returns
`Diagnostic[]` (head = the failure, tail = the context notes); `subpathFailureDiagnostic`,
`resolveIncludePath` and `overrideContainmentMessage` are untouched, and every switch stays
`default:`-free with a non-optional return type. `ContainmentFailure` gained no kind, so no switch
outside `config.ts` moved.

**Judgment calls.**

- *Two diagnostics rather than one long string.* "A refusal may appear as secondary context, but
  must not displace it" is a claim about primacy, and `emitReport` renders diagnostics in push
  order with no severity grouping, so an `error` followed by its `warning` stays adjacent and
  reads as headline-then-footnote. Appending the context to the `absent` message instead would
  have put text after its trailing `— skipped`, which every other diagnostic in the file uses as
  terminal.
- *`unreadable` is a `PackageFailure` kind, not a note beside `absent`.* `contain.ts` keeps
  `missing`/`root` apart from `unreadable`/`root-unreadable` because collapsing them is what let a
  `chmod`'d root revert a slot silently. "Is it installed?" is the wrong question about a directory
  the build was refused entry to, so it is not asked there at all.
- *One warning per skipped level, not just the first.* The count is bounded by the depth of the
  chain and is zero in every ordinary install; picking one would reintroduce the discarding this
  fix exists to end.
- *A subpath failure carries the notes too.* "The package resolves to `<ancestor>/…`, which has no
  `templates` directory" is a claim about a copy the developer did not install; the copy they did
  install is behind the refused level and may well have that directory.
- *The shadowing warning fires even when the refused level shadows nothing.* It cannot be told from
  the level that does without looking through it, which is the thing invariant 8 forbids. The
  existing fixture `a refusal at one level does not end the upward walk` is exactly that case and
  now asserts the warning.

**Diagnostic strings changed.** `name-symlink` is gone as a failure kind, so the two fixtures that
pinned `source "<spec>" was refused — <part> is a symlink … — skipped` now read as `absent` plus a
note. New: the skipped-level note, the shadowing warning, and the `unreadable` headline. Changed:
the missing-source-root message gained `; create it, or point "sources" at an installed package`.
`init`'s config template gained one sentence stating that the scaffolded `sources` entry is an
`error` on every build and a non-zero `build --check` until the directory exists. The template's
comment lines are indexed by `test/init.test.ts`'s `uncomment()` regex, which matches only
`// "<key>":` lines — the added prose matches none of them, so the indices did not move, and the
parametrised tests were left alone.

**Verification.** 427 pass / 0 fail, `bun run typecheck` clean, `biome check` at its pre-existing
10 warnings and 0 errors. Seven mutations were applied to a scratch copy of `src/` (never to the
real tree) and each was caught by exactly the intended test: dropping the shadow warnings; letting
the first refusal take the headline; collapsing the manifest `stat`'s `EACCES` into `missing`;
collapsing the component `lstat`'s `EACCES` into "not a symlink"; reverting the source-root remedy;
reverting the config-template sentence; dropping the subpath failure's notes.

Nothing declined.

## User-directed fix — prose drift

`README.md` and `docs/specs/tool-contract.md` reconciled with the walk fix above. Documentation
only; no `src/` or `test/` change, and `bun test` (427 pass / 0 fail) and `bun run typecheck` are
unchanged by it.

**The false claim, in both files.** Each said a symlink at `node_modules` or at a scope directory
*refuses the entry*, and that every such failure is an error skipping that entry alone. Both halves
are now wrong: the level is stepped over, the walk continues above it, and the entry fails only
where no level resolves — at which point the headline is `absent` (or `unreadable`) and the skipped
level is an adjacent warning. Where a higher level does resolve, the entry succeeds and the skipped
level is a warning naming the path actually used.

- **README, *Shipping skills as a package*.** The resolution paragraph now says the earlier name
  components are not looked *through* where they are links or cannot be read, that the walk steps
  over such a level, that a warning follows either way because a copy behind the skipped level
  would have won, and that an unreadable level reports as unreadable rather than as a missing
  install. Split in two: the subpath rules keep their own paragraph, and the "an error, named
  individually, and skips that entry alone" sentence now belongs to subpath failures, where it is
  still true.
- **Spec, *Configuration*.** "Three things are refused" is now two — not-a-package-name and a
  subpath that does not resolve — and the name-path level moves out of that list into a paragraph
  of its own: stepped over rather than refused, headline never the skipped level, warning either
  way, with invariant 8 named as the reason the warning exists at all.
- **Spec, exemption paragraph and invariant 8.** Both said the earlier name components are
  "`lstat`'d and refused"; both now say "`lstat`'d and not looked through", invariant 8 adding that
  the walk steps over such a level, warns, and carries on above it. Everything the previous fix got
  right about the exemption belonging to a *source* root is untouched.
- **Spec, *Severity*.** The error enumeration listed "one refused for a symlink in its name path".
  Replaced by the unreadable-level error, which is the walk-shaped failure that really is an error:
  "one where a level of that chain could not be read, so whether the package is installed there was
  not a question this build was allowed to ask." The *Warned* config bullet gains the skipped level,
  reported whether the entry went on to resolve above it or failed.

**Verified against the code and a built CLI**, not against the message strings, which the prose
deliberately does not quote. `src/config.ts`: `findPackageRoot` pushes a `SkippedLevel` and
continues to `path.dirname(dir)` rather than returning; `unresolvedFailure` gives the headline to
the first `unreadable` and never to a `symlink`; `resolveRoots` emits `shadowedPackageWarning` per
skipped level on the success path; `subpathFailureDiagnostic` is unchanged and still an error.
Reproduced with `bun build ./src/cli.ts` into the session scratchpad and `COMPOSABLE_SKILLS_HOME`
pointed inside it: (1) repo `node_modules` a symlink, package present in the ancestor's
`node_modules` — exit 0, skill compiled from the ancestor's copy, one warning naming the used path
and the skipped level, no error; (2) same layout with the ancestor copy removed — the `is it
installed?` error as the headline and the symlink refusal as a warning beneath it.

Nothing disputed, nothing declined. No material moved between the two files: the spec keeps the
rule, the README keeps the how-to.

## User-directed fix 2 — confirm-then-warn

`shadowedPackageWarning` fired for every skipped level unconditionally, asserting a counterfactual
the walk had refused itself the evidence for. It now fires only where a `stat` *through* the
skipped level confirms something worth saying, and the walk records one shape of failure it used
to miss entirely.

**The permission this rests on.** A `stat` through a stepped-over candidate opens no compile path:
its answer picks a diagnostic and is never a path anything reads from. Invariant 8 governs what a
build reads into its output, so it is untouched. Resolution still refuses to look through such a
level — what compiles is unchanged by this whole fix; only what is said about it changed.

**Two cases the walk could not tell apart, and now can.** `packageManifest` collapses "nothing is
here" and "something is here that is not a usable package" into `missing`, and `missing` recorded
no level — so a dangling package-root link (the steady state after `rm -rf node_modules/.pnpm`, a
branch switch that drops a linked workspace package, a half-restored cache) was walked past in
silence while an ancestor's copy compiled. `findPackageRoot` now `lstat`s the candidate, but only
where the manifest came back missing *and* the walk is continuing anyway, and records
`{ kind: "not-a-package" }` with whether the level was the repo's own `node_modules`.

**Shape.** `SkippedLevel` gains that third kind, and its `symlink` kind carries `candidate` — where
the package would have been at that level, which a confirming `stat` needs and the blocked
component itself does not say (a symlinked `node_modules` and a symlinked scope directory sit at
different depths above it). `confirmSkippedLevel` turns a level into a `LevelVerdict` —
`harmless` | `shadowed` | `unchecked` | `broken` — and `resolveRoots` emits nothing at all for
`harmless`. Both switches are `default:`-free with non-optional return types, and `skipReason` now
takes `OpaqueLevel` (`Extract<SkippedLevel, { kind: "symlink" | "unreadable" }>`), so a level kind
the reason clause cannot describe is a compile error rather than a wrong sentence.

**The case table, each row run.** Rows 1, 2, 4 are pinned by existing fixtures (whose failures are
handed to the test task); rows 3, 5, 6, 7 were run in a scratch suite against the real fixtures.

| # | The nearer candidate | Now |
|---|---|---|
| 1 | symlinked `node_modules`/scope, package behind it | warns, naming the used path and the confirmed copy |
| 2 | symlinked, package not behind it | silent |
| 3 | dangling package-root link in the repo's own `node_modules` | warns as a broken local install |
| 4 | directory with no manifest in the repo's own `node_modules` | warns, same message |
| 5 | rows 3-4 above the repo root | silent |
| 6 | level unreadable (`EACCES`) | warns, hedged: says the check could not be made |
| 7 | nothing stepped over | silent |

**Judgment calls.**

- *The failure path keeps its unconfirmed notes.* Where nothing resolved anywhere, `skippedLevelNote`
  still fires for every level without a confirming `stat`. It is not the speculation this fix
  exists to end: the note's claim is *"a copy installed behind it was not considered"*, which is
  true whether or not one is there, where the deleted warning claimed a copy *"would have won"*.
  Confirming there would also have to be allowed to move the `absent` headline, which is a second
  change to a message the round has already settled.
- *A `not-a-package` level above the repo root is silent on the success path and a note on the
  failure path.* Silence is row 5's rule — an entry no lockfile the developer controls put there,
  naming them no action. On the failure path nothing resolved at all, so the same broken entry is
  the likeliest explanation of the failure rather than a fact about a stranger's machine, and it
  rides as context under an error rather than as a standalone claim.
- *`inRepoModules` is decided in the walk, not later.* The walk is the only place that knows which
  level it was standing on; recomputing it from the path afterwards would compare strings.
- *Row 7 stays reported nowhere.* A package resolving cleanly from above the repo root is the
  residue of this problem and is left as residue: the honest home for "where did this resolve
  from" is `explain` (Phase 5), and this round already rejected putting it in per-session stdout.
  Recorded here rather than added as a line.

### A doubtful resolution no longer prunes

`resolveRoots` returns `{ roots, doubtful }`, and `sourcesIncomplete` is now
`roots.length < specs.length || doubtful`. A non-harmless verdict is exactly the condition: the
corpus that resolved may not be the corpus that exists, which is the same reason an unreadable root
suppresses pruning. Reproduced before and after — baseline compiles two skills; the lockfile's copy
is then reachable only through a scope link and an empty package of the same name sits above the
repo; the run reports `0 skills → 1 target` and the two compiled skills survive, where it used to
report `2 pruned` and empty the target. `build.ts`'s suppression line was reworded, since "could
not be read in full" is false of a root that read fine and resolved doubtfully; it keeps its
`nothing was pruned this run` tail. Rows 2 and 5 set nothing, so the ordinary pnpm and
shared-`node_modules` layouts prune exactly as before.

### `${home}` containment asked of the real path

`sources: ["${home}/x"]`, `x` a link out of `${home}`, compiled the outside templates with exit 0
and nothing said: the check ran on unresolved text. `homeEscape` now asks both questions — of the
text, which catches a `..` that walks out lexically, and of the real path, which catches a link
that walks out at the first read. Applied to **every** kind, not sources alone:

- **Targets have the same gap and it is a write.** `emitSkill` `mkdir`s the target root and writes
  through it; nothing `lstat`s the root itself. `targets: ["${home}/out"]` with `out` linked
  outside wrote outside `${home}`. Now refused (verified: nothing lands outside).
- **Overrides had a residual one.** `rejectSymlinkedRoot` covers the root's own last component, but
  `resolveContainedFile` `realpath`s the root before walking it, so `${home}/a/b` with `a` linked
  outside was read through silently. The same check closes it, one layer earlier.

The lexical message is unchanged; the symlink case gets its own, naming where the path leads.

*What this moves for overrides, checked both ways.* A `${home}`-spelled override root linked
**out** of `${home}` is now dropped at config load with that error, and the skill compiles with its
template default — which is exactly what the lexical `${home}/../sibling` escape has always done,
so the two spellings of the same mistake now behave alike. One linked to somewhere **inside**
`${home}` still reaches `rejectSymlinkedRoot` and still fails the skill with *"override root … is
itself a symlink"*, so that path stays live. In both cases the content behind the link is never
read.

### Smaller items

- `unresolvedFailure`'s `level === undefined || level.kind !== "unreadable"` carried a statically
  dead disjunct — `level` came from a `findIndex` on that very predicate. Now a `find` plus an
  identity `filter`, which states the same thing with nothing false in it.
- The symlink reason clause said *"only a package root's own last component may be one"*. The rule
  is named-versus-derived: a root the config named — a path entry, or a package — is a destination
  and is not `lstat`'d; anything derived by joining names onto a root the tool must vouch for is
  checked in full. It now reads *"only the root a config entry names may be one"*, one word shorter.
- A NUL in a segment made `fs.statSync` throw `ERR_INVALID_ARG_VALUE`, which carries no errno, so
  `isMissing` routed a malformed spec to `unreadable` — "a level this build was not allowed to
  read" about a path no filesystem can hold. `isPackageSpec` refuses it up front, alongside the
  empty and dotted segments, and the `spec` message names it.

**Verification.** `bun run typecheck` clean; `biome check` back at its pre-existing 10 warnings and
0 errors. The exhaustiveness gate was probed by adding `{ kind: "probe-variant" }` to
`ContainmentFailure` and two probe kinds to `PackageFailure`/`SkippedLevel`: `tsc` failed in
`overrideContainmentMessage` (`compile.ts`), `resolveIncludePath` (`directives.ts`),
`subpathFailureDiagnostic`, `packageFailureDiagnostic` and `confirmSkippedLevel` (`config.ts`), and
in `skippedLevelNote` where the new kind would have reached `skipReason`. Reverted, and typecheck
re-confirmed clean afterwards. `bun test` is 420 pass / 7 fail, every failure a test asserting
behaviour or a string this fix deliberately changed; `test/` is another task's to move.

Nothing declined.

## User-directed fix 2 — docs

`docs/specs/tool-contract.md` and `README.md` only. Every claim below was either read out of the
current `src/` or reproduced against a CLI built from it into a scratch tree
(`…/scratchpad/fix2-docs`, `COMPOSABLE_SKILLS_HOME` pointed inside it); seventeen scratch repos in
five scripts, `v1.sh`–`v5.sh`. No `src/` or `test/` file was touched, so the suite is exactly where
the parallel task left it — this pass added no failures because it changed nothing a test reads.

### Invariant 8 is now a table of routes

The sentence had been wrong three rounds running because each version named the exempt thing by
**position**. The code does not branch on position; it branches on **named versus derived**, and
the verdicts are three, so a single sentence had to flatten two of them. Invariant 8 now states the
principle and then routes it:

| Path | Named or derived | Verdict where it is a symlink |
|---|---|---|
| A `sources` path entry — `./skills/templates` | named | **Never `lstat`'d**, and neither is any component of it. Resolved lexically and then read through, so a link anywhere along it is followed and the root loads with nothing said. |
| The last component of a package name — `node_modules/@acme/skills` | named | **Never `lstat`'d.** Deliberate: a symlinked package directory is ordinary under pnpm and workspaces, and the walk reads the package's own `package.json` through it. |
| `node_modules` itself, and every earlier component of a package name | derived | **Stepped over** — not looked *through*, but the walk carries on to the next `node_modules` above, since a link at one level says nothing about the level above. Whether anything is said is settled afterwards; see *Configuration*. |
| An `overrides` root's own last component | named, checked by request | **Refused.** Containment is asserted against the root's `realpath`, so a link here would widen the root to wherever it points. The skill is rejected. Its earlier components are not checked, as no root's are. |
| A `targets` root's own path | named | **Never `lstat`'d.** The build `mkdir`s the root and writes through it; what stands *inside* it is the target-entry row below. |
| A `sources` subpath's components — `templates` in `@acme/skills/templates` | derived | **Refused.** An error against that entry, which is skipped. |
| An `include:` path's components | derived | **Refused.** The skill is rejected. |
| The components of `<override root>/<skill>/<slot>.md` | derived | **Refused.** The skill is rejected. |
| A skill directory under a source root | derived | **Refused** — not discovered as a skill, and never read through. Warns and blocks pruning for that run where the directory holds a template or otherwise looks like a skill; silent where nothing about it does. |
| A file inside a skill directory | derived | **Refused** — not copied to any target, and warns. |
| A target entry — `<target>/<skill>` | derived | **Refused** — not rewritten and not read through. Warns, and that skill is recorded as declined for that target. |
| A skill directory's ownership marker | derived | **Refused** — opened without following it, so the directory reads as *unmarked* and is neither overwritten nor pruned. |
| A link met while hashing a source or override tree | derived | **Refused** — never read through; its destination is hashed instead, since retargeting one changes what the build refuses to do. |

**The principle as shipped**, which is what keeps the table from being a list of coincidences: a
root a config entry *names* is a destination the tool did not construct, so nothing `lstat`s it —
not its last component, and for a path entry not any component of it. Everything the tool derived,
by joining further names onto a root it must then vouch for, is `lstat`'d in full, its own last
component included; that is why `@acme/skills` is exempt and `@acme/skills/templates` is not, the
subpath entry's source root being the derived `<package>/templates`. Two riders the table needs and
a sentence cannot carry: the `node_modules` chain is the one path the tool builds to *reach* a named
destination, and it is derived too — every level `lstat`'d bar the package directory the name lands
on; and an override root is `lstat`'d by its reader's request rather than by this rule, its job
being to bound what may be read.

*Verified rather than reasoned:* a path source root whose **last** component is a link compiles the
outside templates silently (`v1.sh` case 1), and so does one whose **intermediate** component is
(`v5.sh`) — which is why row 1 says "nor any component", where every previous version of this
sentence said "last component" and would have left a reader expecting `./skills` to be checked.

**Two passages collapsed into pointers at it.** *Configuration*'s exemption paragraph (11 lines,
opening "The symlink rule's one exemption is **a source root's own last component**…") is gone,
replaced by one clause inside the stepped-over paragraph. *Resolution*'s tail (7 lines, "The
exemption belongs to **source** roots and not to these…") is gone, replaced by one sentence that
keeps the override-specific fact — `realpath`-asserted containment, root-symlink rejected — and
points at the table for the rest.

### What the walk now does, documented

*Configuration*, replacing the old "A third thing is **stepped over rather than refused**" paragraph
with three: the routes, the confirmation, and the failure path.

- **A third skipped kind.** A level that is there and is not a usable package — no readable
  `package.json`: a dangling workspace link, a half-restored cache — is recorded and stepped over
  where it used to be walked past in silence. Named in the resolution paragraph too, at the
  sentence that already said the walk continues past a directory carrying no manifest.
- **Confirm-then-warn.** Where the entry resolved, the tool `stat`s *through* the stepped-over level
  purely to decide whether a diagnostic is warranted; that opens no compile path, so invariant 8 is
  untouched — stated in the spec in those terms. Four outcomes documented: a confirmed nearer copy
  (warns, naming both paths); nothing behind it (silence, and the spec says why that satisfies
  invariant 8's *silently* rather than evading it); the level itself unreadable (warns that the
  check could not be made); a broken entry in **this repo's own `node_modules`** (warns, pointing at
  a reinstall). Reproduced in order: `v1.sh` cases 3, 4, 6, and `v2.sh` case 8.
- **Ancestors are deliberately not this repo's business.** The same broken entry above the repo root
  is silent — `v1.sh` case 7 — because an ancestor's install is governed by no lockfile the
  developer controls. Stated as a reason, not a quirk.
- **A doubtful resolution no longer prunes.** Written into *Configuration*, the `build [--check]`
  row, the *Warned* pruning bullet, and *Ownership and pruning*'s enumeration of what suppresses a
  prune. Reproduced in `v2.sh` case 9: a package substituted through a scope link, its own corpus
  emptied upstream, reports `0 skills → 1 target` and the two compiled skills survive.
- **The failure path is unchanged and now says so.** Where nothing resolved, every stepped-over
  level rides as an unconfirmed warning under the error, whose claim is only that a copy behind it
  was not considered. `v4.sh` case 16 shows both a symlink note and a `not-a-package` note beneath
  the ordinary not-installed error.

### `${home}` containment, as a check rather than a caveat

*Configuration* now says the question is asked twice — of the resolved text, catching a lexical
`..`, and of the **real** path, catching an entry that leads out through a link — and that either
escape is an error against that entry in any of the three lists. Reproduced for all three: a source
(`v2.sh` case 10, error, `--check` exits 1), a target (case 11, refused, and nothing lands in the
outside directory), an override (case 12, dropped at config load, the skill compiling with its
template default). Case 12 also confirms the other half still stands: a `${home}` override root
linked to somewhere *inside* `${home}` still fails the skill with the root-symlink error. This is
also the one check that reaches a named root's own last component, which is how invariant 8's
"nothing `lstat`s a named root" and the `${home}` promise coexist; both places say so.

### Enumerations audited

- **Errors.** The severity paragraph's list of unusable *entries* was missing the subpath that
  **cannot be read** — a live `ContainmentFailure` kind with its own message in
  `subpathFailureDiagnostic`. Added. Every other item checked reachable against `config.ts`; the
  five `subpathFailureDiagnostic` kinds the code itself documents as unreachable from that call site
  are correctly absent from the spec.
- **Warned.** The config bullet's "a level … reported whether the entry went on to resolve above it
  or failed" was the shipped-yesterday behaviour and is now false; it is replaced by the three
  confirmed shapes on the success path and the unconfirmed notes on the failure path. The pruning
  bullet gained the doubtful-resolution cause, matching the reworded suppression line in `build.ts`.
- **`--check`.** The `build [--check]` row gained the one thing this round adds to its account: a
  doubtful resolution is a *warning*, so `--check` still exits 0 and the suppressed prune is the
  only consequence. Verified in `v2.sh` case 8 — a hedged unreadable level, then `--check`
  reporting `compiled output is up to date`, exit 0.

### README

*Shipping skills as a package* keeps its how-to register and loses the false claim. Before: "Either
way you get a warning naming the level that was stepped over, because a copy installed behind it
would have won." After: a four-bullet "**What you are told when it resolves from further up**" —
confirmed nearer copy, silence, unreadable level, your own broken install (and the note that the
same wreckage above your repo says nothing) — plus one sentence that any of those warnings also
stops that run pruning, "so a source that resolved to a copy the tool cannot vouch for can never
empty your skills directory". The not-a-package level is introduced in the developer's own terms
(`rm -rf node_modules/.pnpm`, a branch switch). Nothing in the README claimed a symlinked level was
fatal; that had been fixed a round earlier, and the sentence saying so is kept. *What the build owns,
and what it deletes* gained the doubtful case beside the unreadable-root one.

### Found stale, outside the brief

- **`src/contain.ts`'s `rejectSymlinkedRoot` doc comment is now false** (not edited — `src/` is not
  this task's): it says the config's `${home}` check "runs on unresolved path text", which is what
  `homeEscape` stopped doing this round. The option is still needed for override roots that do not
  spell `${home}`, so only the justification is stale, not the code.
- **`test/ownership.test.ts:37` and `:78` cite `docs/specs/tool-contract.md:431-433`** for the
  `id`-versus-repo-path identification rule. That bullet is now at `:624`; line 431 is the override
  seeding paragraph. The citation was already drifting before this round — line-number citations
  into a document under active edit cannot hold. Left for the test task.
- **"pack" survived the vocabulary sweep in one place** — `tool-contract.md`'s Windows-separator
  example read `pack\templates`. Changed to `skills\templates`; `CONTEXT.md` has "pack" on the
  Avoid list and the previous round believed it had removed the last one.

### Judgment calls

- *The table lives under invariant 8, not in Configuration.* It covers overrides, targets, markers
  and the stamp as well as package resolution, so Configuration would have been the wrong home; the
  invariant is the rule the table restates, and both other passages now point at it.
- *A `targets` root row was added although the brief did not list one.* Without it the "named" side
  of the table reads as a fact about sources and overrides, and the target root is exactly where the
  `${home}` real-path check earned its keep this round.
- *The verdict column is three words plus a consequence, not three words.* "Refused" covers seven
  rows whose consequences differ — an entry skipped, a skill rejected, a file not copied, a
  directory left standing — and the differences are what a reader is actually looking for.

## User-directed fix 2 — tests

`test/` only. The confirm-then-warn change and the `${home}` real-path check landed with seven
failing tests and twelve mutations the reviewer found surviving; both are closed here, and the
seven-row case table is pinned row by row — the silent rows included.

### The seven repairs

Six were in `test/config.test.ts` and are string or behaviour changes the fix made deliberately:

- *a symlinked scope directory / a symlinked node_modules, under an absent headline* — the reason
  clause is now *"only the root a config entry names may be one"*. Both were also converted from
  substring matches to whole-line, ordered assertions.
- *a refusal at one level does not end the upward walk* — row 2. The `stat` through the link found
  nothing behind it, so the run is now **silent**; the test asserts that as an empty diagnostic list.
- *a package shadowed behind a refused level* — row 1, whose message now names the confirmed copy
  and says the build *is not* compiling it, where it used to hedge with *"may not be"*.
- *a spec with an empty, `..` or missing segment* — the message gained `or contain a NUL`.
- *a directory in node_modules with no package.json is walked past* — row 4. The walk is unchanged;
  what changed is that this repo's own broken entry is now **warned about**, so the test asserts the
  broken-install line rather than `hasWarning === false`.

**The seventh, and what was chosen.** `override containment > an override root that is itself a
symlink is rejected` broke because the `${home}` real-path check fires first, at config load, and
drops the root before `compile.ts` ever reads it. **The new message is asserted**, on the reasoning
the fix itself recorded: `${home}/…` naming a directory outside `${home}` is the developer's
mistake whether or not a symlink is how it got there, and it now reads identically to the lexical
`${home}/../elsewhere` spelling of the same mistake. The more specific *"is itself a symlink"*
message is **not** conceded, though — it is still the right message for a root that is a link and
stays inside its promised area, and that path had no test at all once this one moved. So the test
was split in two: the original fixture keeps its link pointing **out** of `${home}` and asserts the
containment error, and a new sibling points the link **inside** `${home}` and asserts
`rejectSymlinkedRoot`'s message. Both assert the smuggled content never reaches the output. Nothing
was logged as a finding for the code owner; the split is the answer, not a deferral.

### The case table, row by row

| # | Pinned by | How |
|---|---|---|
| 1 | `a package shadowed behind a refused level …` | ordered lines: the named-copy warning, then the prune suppression |
| 2 | `a refusal at one level does not end the upward walk` | `diagnosticsOf(run)` is `[]`, and the ancestor's template is what compiled |
| 3 | `a dangling package-root link in the repo's own node_modules warns` (new) | a `node_modules/.pnpm/gone/…` link that `lstat`s and resolves to nothing |
| 4 | `a directory in node_modules with no package.json is walked past …` | the broken-install line, in full |
| 5 | `the same broken entry above the repo root says nothing` (new) | repo root is `repo/sub`, so `repo/node_modules` is an ancestor's; `[]` |
| 6 | `a package hoisted above an unreadable manifest …` (new) | injected `EACCES` on the nearer manifest; the hedged line, in full |
| 7 | `a package hoisted above the repo is found by the upward walk` | strengthened to `[]`: a `node_modules` was passed through and held no candidate |

A silent row asserts `diagnosticsOf(run)` — every error and warning line, in order — equals `[]`,
and separately that the compiled output came from the expected package. `not.toContain(…)` was not
used for any of them: it passes just as happily on a run that warned about something else.

### The mutations

Eighteen were applied to a copy of `src/` under the session scratchpad — never the real tree — and
**all eighteen die**. The twelve the reviewer listed were reconstructed from this document's
description of the fix; the six extra are neighbouring cells the same fixtures reach.

- **Headline selection** (fixture A: a symlink level nearer than an unreadable one, nothing
  resolving; fixture C: two unreadable levels at different depths). `find` → `skipped[0]`; `find` →
  `findLast`; the de-dup `filter(entry => entry !== level)` dropped, which repeats the headline as a
  note under itself. On a one-element skipped list all three are the same function, which is why
  neither fixture existed and all three survived.
- **Context notes** dropped from the `absent` case and from the `unreadable` case, separately.
- **`confirmSkippedLevel`, every cell**: a confirmed shadowing copy silenced; the
  `{ symlink, candidate unreadable }` cell silenced (fixture: a scope link whose candidate manifest
  throws `EACCES` — the walk never stats through a refused level, so the one injected throw *is* the
  confirming stat); the `{ unreadable, resolved }` cell silenced (fixture B); `inRepoModules` forced
  true and forced false.
- **`packageManifest`**: `.isFile()` dropped, so a `package.json` that is a *directory* counts as a
  manifest (fixture D, which puts a different skill beside it so the two outcomes differ in the
  output and not only in the diagnostics).
- **The walk**: `pathExists(candidate)` forced true, so an absent level records as `not-a-package`;
  `inRepoModules: dir === start` forced true.
- **The prune guard**: `doubtful = true` never set; `|| sources.doubtful` dropped from
  `sourcesIncomplete`; and the converse — `doubtful` set for `harmless` too, which is what a guard
  that fired on rows 2 and 5 would look like.
- **`${home}`**: the real-path half of `homeEscape` dropped; the check applied to `sources` alone.

### What else was added

- **`${home}` escapes, one per list.** `sources` and `targets` in `test/config.test.ts`; `overrides`
  is the repaired test in `test/validate.test.ts`, cross-referenced from the others rather than
  duplicated. The `targets` one is the write path: it asserts the summary is `0 skills → 0 targets`
  and that the directory behind the link still holds exactly what it held before the build.
- **The prune guard, both directions** (`describe("pruning against a package source")`). A baseline
  build compiles two skills; the lockfile's copy then moves behind a scope link with an empty
  package of the same name above the repo, and the second build reports `0 skills → 1 target` with
  **both skills still on disk**. The converse fixture keeps a row-2 link across both builds, deletes
  one skill upstream, and asserts `1 pruned` with no diagnostics at all.
- **Ordered full-line assertions** on every failure path that carries context notes — the two
  absent-headline tests and both new headline fixtures — so the de-dup filter and "the head is
  always the failure itself" are checked rather than assumed.
- **`test/config.test.ts:928`'s comment** claimed a directory without `package.json` is "not a
  package by node's own rule". Node's CommonJS resolution falls through to `index.js`, so the rule
  is this tool's own: it asks the filesystem for a manifest and does not use node resolution,
  deliberately. Both copies of the comment (`:902` and `:928`) now say that.
- **`test/ownership.test.ts:37` and `:78`**, left here by the docs task: the
  `tool-contract.md:431-433` citations now name the heading and the bullet instead. A line number
  into a document under active edit cannot hold, and that one had already stopped holding.

### Verification

`bun test` 439 pass / 0 fail (was 420/7; +19 tests). `bun run typecheck` clean. `biome check` back
at its pre-existing 10 warnings and 0 errors. All eighteen mutations die. No existing assertion was
weakened: the six repaired tests each gained assertions relative to what they had, and the two
strengthened ones (`hasWarning === false` → an empty ordered list) replaced a claim with a stronger
one.

Nothing was left unpinned. Row 7's residue — that a package resolving cleanly from *above* the repo
root is reported nowhere — is the fix's own recorded judgment and belongs to `explain` (phase 5),
so the row is pinned as "silent" rather than as a gap.
