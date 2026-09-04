# Implementation notes — remediate-review-findings

Staging notes for the execution of
[`docs/plans/remediate-review-findings.md`](../plans/remediate-review-findings.md) (revision 2).

Subagents append here. Do not overwrite.

---

## Pre-implementation

**Plan:** `docs/plans/remediate-review-findings.md` (revision 2, adversarially reviewed)
**Started:** 2026-09-04
**Baseline at start:** `bun test` 298 pass / 0 fail; `bun run typecheck` clean on both projects.

### Blocking conflict between the plan and this skill

**Stage 0 of the plan is three git commits. This skill forbids `git commit`, `git add`, and
`git stash` outright.** Stage 0 therefore cannot be executed here and must be done by the user.
This matters more than a normal scope note, because:

- Stage 0 is finding 1, ranked the highest-severity item in the whole review: 9,500 lines of
  `src/` and `test/` exist in one unbacked copy with no remote. Every subsequent stage adds
  uncommitted change on top of that.
- Stage 0 commit 1 also carries findings **3** (`typescript` peer→dev) and **15** (`.gitignore`
  `_.log` → `*.log`), because both are encoded in what gets committed. Those two file edits can
  be made in the working tree here; only the committing cannot.

### Loss of the per-commit green gate

The plan specifies "one module per commit, suite green after each" for Stage 4, and the
adversarial review demonstrated why that granularity matters: revision 1's Wave 4 step 2 went
red in a way that showed up as `16 pass / 10 fail` while **272 tests silently never executed**.

Without commits, the working tree accumulates every change and that gate degrades to
"green at the end". **Mitigation adopted:** every implementer that performs a module extraction
must run `bun test` and `bun run typecheck` immediately after its own step and report both
results, including the *test count*. A run reporting fewer than 298 executed tests is a failure
even if it reports 0 failures.

### Assumptions

- **A1.** The user performs Stage 0's commits themselves, either before this run (preferred —
  it creates the known-good marker the plan argues for) or after. Implementation proceeds on the
  working tree regardless.
- **A2.** Pre-existing uncommitted changes (5 modified, 8 untracked, `index.ts` deleted) are
  intentional and are the tree to be imported. Nothing here reverts or stashes them.
- **A3.** `src/` has no external consumers — `package.json` has `files: ["dist"]` and
  `version: 0.0.0` — so the module extractions in Stage 4 break no published API and need no
  re-export shims.
- **A4.** Stage 6's CI workflow file is written but inert: `git remote -v` is empty, so there is
  no GitHub repo for it to run in yet.
- **A5.** Findings 9 and 12 (the extractions) are in scope. The user was shown the premise
  reviewer's argument for dropping them and chose the full scope explicitly.

### Open questions

- **Q1.** Is a shared `~/.claude/skills` across concurrent builds real in this setup? It is the
  only route by which finding 10 causes real loss. Unresolved; finding 10 is implemented
  conservatively (name-embedded timestamp with mtime fallback) either way.
- **Q2.** Node floor — `engines: ">=20"` has never been executed. Stage 6's smoke matrix is
  written to settle it, but cannot run without a remote. The claim stays unverified this run.
- **Q3.** Invariant 9 (`tool-contract.md:536`) — finding 5's per-key config diagnostic names a
  file with no line, as every existing config diagnostic already does. Scoping the invariant to
  template-derived diagnostics is proposed but not decided.

### Concerns / risks

- **R1.** Stage 4 is the high-risk stage. Two of its steps were *proven* to break revision 1 by
  execution, not argued. The `[adv]` annotations in the plan mark the corrections; they must not
  be second-guessed by implementers working from intuition.
- **R2.** Findings 11 and 4 must land as a single unit. Splitting them opens a window in which a
  symlinked target entry produces a warning plus a full recompile at every session start.
- **R3.** Finding 4 changes the stamp record shape. Old stamps must be treated as stale — one
  forced rebuild, which is safe, but it must be deliberate rather than accidental.
- **R4.** The review pass at the end of this skill is a *different* thing from the adversarial
  review already performed on the plan. It reviews the implementation, not the plan.

---

## Q1 resolved — shared targets are an intended use case

**User, 2026-09-04:** "It is possible to share target across repos. Installing into user home
should be valid and you should be able to use multiple repos as sources for those skills."

**Consequences, recorded before implementation:**

- **Finding 10 stays in scope and is fixed properly.** The concurrent-build race on a shared
  target is reachable, not theoretical. Fix = creation timestamp embedded in the scratch
  directory *name* (via `uniqueSuffix`, currently `pid-<8 hex>` with no time component), with a
  **fallback to mtime for names carrying no timestamp**, so scratch written by the current
  version still ages out instead of becoming immortal. Still sequenced last: highest regression
  risk, lowest urgency.
- **The build lock does not protect a shared target.** Different repo roots produce different
  state directories and therefore different locks (`build.ts:859`), so two repos building into
  `~/.claude/skills` are never serialised. Concurrency safety rests entirely on the ownership
  marker plus the per-skill atomic swap. Implementers must not assume the lock covers this.
- **Finding 14 is elevated.** `ownedByThisBuild` (`build.ts:834-839`) is the guard the spec names
  as what makes a shared target safe (`tool-contract.md:426-430`). Its no-`id` branch (`:838`,
  repo-root comparison) has zero coverage and gates the only destructive operation. C1 is now a
  correctness test for a live configuration, not a coverage exercise.
- **Finding 4's threat model is real.** The per-target decline design was chosen partly because
  anyone able to `mkdir` in a shared `~/.claude/skills` could otherwise flip a skill to
  "declined" and strip integrity checking from the real compiled skill elsewhere. That is now a
  normal environment.
- **Finding 11 is a plausible setup, not a curiosity.** Its only reachable case is a symlink to a
  directory whose marker names a skill of the same basename — another repo's compiled skill of
  the same name, which a shared target makes ordinary.

### Observation — NOT in scope, flagged for the user

**Two repos publishing a skill of the same name into a shared target recompile forever.** Repo
A's stamp holds A's content hash; `outputsVerified` (`build.ts:334-353`) re-reads the file, finds
B's content, mismatches, and refuses to gate — so A rebuilds and overwrites, and B does the same
next session. Same shape as finding 4 (a gate that can never close), but arising from content
collision rather than a declined write. `tool-contract.md:430` accepts "last writer wins" on
content and is silent on the resulting rebuild loop. Disjoint skill names are unaffected.

Not added to the plan. Awaiting a decision.

## Stage 1 — finding 13 (DiagnosticLocation)

- **Assumption:** the narrowing applies only to `fail`'s parameter. The three helpers that feed it
  inside `compileSkill` — `attribute`, `inBody`, `inOutput` (`src/build.ts:468`, `:473`, `:508`) —
  still declare their return type as `Partial<Diagnostic>`, so they remain structurally able to
  return a `severity`. They never do today, and a `Partial<Diagnostic>` value is still assignable to
  a `DiagnosticLocation` parameter, so nothing breaks; the plan named only `fail`, so I left them.
  If the intent was to close the hole everywhere, those three return types should be
  `DiagnosticLocation` too — a mechanical follow-up with no behaviour change.

## Stage 1 — findings 3 and 15 (package metadata)

- **Assumption:** the `peerDependencies` → `devDependencies` move needs no matching change in
  `tsconfig.src.json` / `tsconfig.json`. Nothing in `src/` imports `typescript`; the only consumer
  is `scripts.typecheck` invoking the `tsc` binary, which now resolves from `node_modules/typescript`
  as a direct dev dependency (verified `5.9.3` installed, `bun run typecheck` exits 0). If this were
  wrong the typecheck script would fail to find `tsc`, which it does not.
- **Assumption:** pinning `^5.9.3` rather than the looser `^5` that the peer dep carried is a safe
  tightening — it is the version that was already resolving in the lockfile, so no install actually
  changes. If a contributor needs an older 5.x, the floor would have to drop back to `^5`.
- **Assumption:** the second corrupted `.gitignore` line is intended to be the stock Bun pattern
  `report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json` (Bun's crash-report filenames). Verified with
  `git check-ignore -v report.1.2.3.4.json`, which now matches on line 19. If the intent was
  something else, only that one line changes.
- **Note (not an issue):** `bun install` churned `bun.lock` by exactly the dependency move — the
  `peerDependencies` block removed and `"typescript": "^5.9.3"` added under `devDependencies`,
  with no change to the resolved `packages` section. No unexplained churn to report.

## Stage 1b — finding 13 helper return types

- **Assumption:** all three helpers (`attribute`, `inBody`, `inOutput` in `src/build.ts`) exist
  solely to build the `extra` argument for `fail`, so `DiagnosticLocation` is the correct return
  type for each. Verified: their only call sites are `fail(...)` invocations, and none of the three
  constructs a `severity` or `message` field. `bun run typecheck` is clean on both projects after
  the narrowing, confirming no caller relied on the wider `Partial<Diagnostic>`.
- **Note (not an issue):** the change was a literal three-occurrence rename of `Partial<Diagnostic>`
  to `DiagnosticLocation`; `Diagnostic` remains imported and used elsewhere in the file, so the
  import block is unchanged. No casts, assertions, or widening were needed.

## Stage 2 — fixture repair

- **Assumption:** `cleanup()` should still be *loud* about a removal it could not do. It now
  attempts every queued temp directory, collecting failures, and throws one `AggregateError` at the
  end. The old code also threw, so this is not a new failure mode — it is the same signal with the
  abandonment removed. If the plan would rather have silent best-effort removal, the throw is one
  line to delete.
- **Assumption:** restoring a recorded path to `0o700` (rather than to whatever mode it had before
  `chmod()` was called) is enough. The recorded paths only ever live inside a temp tree that is
  removed moments later, so the original mode is never observable. Recording the prior mode would
  be strictly more machinery for no assertion.
- **Assumption:** modes are restored shallowest-path-first (sorted by string length). A parent's
  path is always a prefix of its children's and therefore shorter, which is what makes a mode-000
  parent reopen before anything under it is chmod'd. Verified against a nested
  `locked/` + `locked/inner/` pair, both at `0o000`.
- **Assumption:** matching a *path argument* means arg 0 for the one-path calls and args 0-1 for
  `renameSync`/`copyFileSync`. Matching every string argument would be wrong — `writeFileSync`'s
  second argument is file *content*, and a content-matching predicate would fire on data.
- **Assumption:** `withFsFailures()` returning `{ result, fired }` rather than the bare result is
  worth the destructuring, because a `when` predicate that matches nothing otherwise leaves a test
  green while proving nothing. `fired` is the assertion that the injection actually happened.
- **Open question:** `withFsFailures()` patches the `fs` *namespace object* the fixture and `src/`
  both import. If any later stage moves `src/` to `node:fs/promises`, to destructured imports
  (`import { writeFileSync } from "node:fs"`), or to `Bun.file`, the patch stops reaching the code
  under test — and it will do so silently except for `fired` being empty. That is the reason
  `fired` exists; nothing enforces that a test checks it.
- **Note (not an issue):** the only `test/` file touched outside the fixture is
  `test/build.test.ts`, at the one site the task allowed — the hand-rolled `try/finally` at
  `:305-315` is gone, the test now uses the fixture's `mkdir`/`chmod`, and the two local
  `fsMkdir`/`fsChmod` aliases at `:6-7` were removed with their last callers.
- **Note (not an issue):** `captured()` was documented, not restructured. The doc comment now names
  every syscall it makes inside a test's patch window (`mkdtempSync`, `existsSync`, `openSync`,
  `writeSync`, `closeSync`, `readFileSync`) and says why the read is not moved out.

---

## Stage 2 — orchestration decision: characterization tests pin the bug, not the fix

Several Stage 2 tests cover findings that are still open (C2 case 3 → finding 10, C5's two-run
assertion → finding 4, C9 → finding 17). The plan describes these as tests that "fail today",
which would leave Stage 2 red and break the stage gate.

**Decision:** every Stage 2 test asserts **today's** behaviour and passes, including where today's
behaviour is the bug. Each such test carries a comment naming the finding and the Stage 5 item
that will invert it. Stage 5 then shows up as a deliberate test inversion rather than as a test
that was quietly failing for two stages.

Rationale: that is what a characterization test is for — it records the behaviour a refactor must
not change *accidentally*, and makes an intentional change visible as an edit to the assertion.
It also keeps "suite green after every step" meaningful through Stages 3 and 4, which is the
property the adversarial review showed matters most (revision 1's Wave 4 step 2 went red in a way
that read as `16 pass / 10 fail` while 272 tests silently never executed).

**Consequence for Stage 5:** items 2 (findings 11+4+17) and 7 (finding 10) must each edit the
corresponding assertion in `test/stamp-gate.test.ts` / `test/scratch.test.ts`. A Stage 5 change
that leaves those assertions untouched has not actually changed behaviour.

## Stage 2 — C1/C3 (ownership)

**Assumption:** C1's first test uses the config the plan specifies literally — `{sources, targets}`
with no `id` and therefore no `overrides` key either. That leaves the *default* override chain in
play, whose `${home}/repos/${id}` entry is skipped with a warning on every run of that config. The
warning is incidental to what the test pins, so the test asserts the report line by `toContain`
rather than pinning whole stdout. The other three tests declare `overrides: []` and pin stdout
exactly.

**Assumption:** "does not prune" is asserted as the *absence of the `, N pruned` clause* from the
report line (`expect(run.stdout).toBe("composable-skills: 1 skill → 1 target\n")`), not as a
dedicated diagnostic. The build says nothing at all when it declines to prune a directory it does
not own — confirmed against controls that flip only the marker's identity and do report `1 pruned`.

**Assumption:** the marker in the no-`id` configuration was verified to be exactly
`{"tool":"composable-skills","skill":"<name>","id":null,"repo":"<repoRoot>"}` — `id` is serialised
as JSON `null`, not omitted — and the test asserts the whole object, so a change to the marker's
shape surfaces here rather than only in whatever depends on it.

**Assumption:** C3 uses `"{\n"` as the unparseable marker. Any non-JSON byte string takes the same
`catch` at `src/build.ts:806`; `{` was chosen because it is what a truncated write leaves behind,
which is the realistic way a marker becomes unparseable.

**Open question:** `readMarker` returning `null` collapses "no marker", "not our marker", "forged
marker" and "corrupt marker" into one verdict, so the build's warning for a corrupt marker is the
same `was not written by this tool` a hand-written directory gets. That is the safe reading and the
tests pin it, but a corrupt marker in a directory this build *did* write is now silently
unprunable and unreportable — the user never learns why the stale skill will not go away. Worth a
finding if it is not already one.

## Stage 2 — C-contain (containment table)

**Assumption:** the four inputs are exercised as *the candidate's path relative to the root the
predicate is asked about* — `root`, `root/..foo`, `root/sub`, `root/../sibling` — and each is
driven through the verb that reaches the call site, never by importing the private predicate. The
file created is `test/containment.test.ts` (19 tests).

**Assumption:** for `directives.ts` I used a fragment file literally named `..foo.md` rather than a
directory `..foo/`. `path.relative` yields `..foo.md`, which is what `!relative.startsWith("..")`
refuses, so the divergence is exercised identically and the fixture is one file shorter.

**Assumption:** `init.ts:229`'s only config-steerable call site is `gitignoreStep` (`:489`), so the
four-input table for that predicate is recorded there. `:204` and `:375` are recorded by a separate
test that asserts `init` writes the same three repo-derived paths even when every configured root
points outside the repo.

**Open question:** the task brief stated that the self case "cannot arise" at `override.ts:122`
because the call site joins a path. That is not what the code does — `insideRepo(config.repoRoot,
root.path)` is applied to the override root itself, and `overrides: ["."]` makes candidate and root
the same string. The self case **is** reachable there and is covered. (The join at `override.ts:77`
builds the *target file* path, which the predicate never sees.)

**Open question / unreachable combinations logged:**

- `directives.ts:176`, **self path** — unreachable. `resolveIncludePath` (`:155`) filters `""` and
  `"."` components, so `parts` is never empty and `resolveContainedFile` never builds the root
  itself. Recorded instead: `include: .` is refused as `names no file`.
- `directives.ts:176`, **`root/../sibling`** — unreachable. `resolveIncludePath:157` refuses a
  literal `..` component before `resolveContainedFile` is called. Recorded instead: the distinct
  message `escapes its source root with ".."`, and that the `outside` message does *not* appear.
- `directives.ts:176` at the **override-file** call site (`build.ts:566`) — only `root/sub` is
  reachable. The parts are `[skillName, "<slot>.md"]`: never empty (no self case), never a literal
  `..` (no sibling case), and neither component can begin with two dots, because `discoverSkills`
  skips source entries whose name starts with `.` (`build.ts:256`) and `SLOT_NAME_RE`
  (`directives.ts:14`) requires a slot name to start with an alphanumeric. One test asserts both
  refusals so the claim is backed rather than asserted.
- `init.ts:229` at `:204` and `:375` — none of the four inputs are reachable; every `step.path` is
  `path.join(repoRoot, <constant>)`.

**Assumption:** the `..foo` refusal in `directives.ts` is marked in the test file as the one
expectation Stage 3 deliberately reverses (the over-strict false refusal). Every other expectation
in the file should survive Stage 3 unchanged.

**Note on counts:** `bun test` reports **321 pass / 0 fail**. The plan's baseline of 298 plus this
file's 19 is 317; the extra 4 are `test/ownership.test.ts`, added concurrently by another agent.

---

## Candidate finding 18 — NOT in scope, surfaced during Stage 2

Found by the C1/C3 implementer while pinning `readMarker`'s verdicts.

`readMarker` (`src/build.ts:795-825`) collapses four distinct situations into a single `null`:
no marker, a foreign marker, a forged marker, and a **corrupt** marker. The consequences split
across the two paths that consult it:

- **Write path** — `isOwned` false, so `emitSkill` warns "exists and was not written by this
  tool" and declines. Visible.
- **Prune path** — `ownedByThisBuild` false, so `pruneTarget` skips the directory **with no
  diagnostic at all**. Silent.

The asymmetry bites for a skill that has been *deleted upstream*. There is no write attempt, so
the warning never fires; the prune is declined silently; and the compiled skill stays in the
target indefinitely, still loaded by the harness, long after the team removed it. The corruption
need only be a truncated or hand-edited `.composable-skills-owner`.

Test 4 in `test/ownership.test.ts` pins the behaviour ("does not make a directory prunable, even
one this build wrote"), so the current semantics are now recorded either way.

Same family as findings 6, 7 and 16: a failure collapsed into a benign value on a path that is
silent by design. Not added to the plan — scope was fixed before Stage 1 and the fix would touch
`pruneTarget`, which Stage 5 item 4 is already changing. Raise at wrap-up.

## Stage 2 — C2/C4 (scratch and lock)

**Assumption:** the sweep is only reachable from a build that is *not* gated fresh, so every C2
case changes the template between the setup build and the swept build (`rebuild()` in
`test/scratch.test.ts`). Asserting scratch survival after an unchanged rerun would pass for the
wrong reason — `runBuild` returns before `pruneTarget` ever runs.

**Assumption:** `ctime` is a usable witness that a directory was renamed just now. C2's third case
asserts both clocks — `ctimeAgeOf(parked) < 1h` and `mtimeAgeOf(parked) > 1h` — so the test states
finding 10 as the disagreement between them rather than as a bare deletion. This is `rename(2)`
semantics on Linux; if the suite ever runs somewhere `ctime` is not updated by a rename, that one
precondition is the line to drop, not the assertion under it.

**Assumption:** C4's release-by-token case needs a hook *inside* the locked window, and there is
none that is not a patch — everything between `acquireBuildLock` and the `finally` that releases
is synchronous. It is staged as a `withFsFailures` predicate that injects nothing (always returns
false) and re-takes the lock as a side effect, keyed on the stamp file, which is the last write
before the release. `fired` is asserted empty to make the non-injection explicit.

**Open question:** C4's second case models "broken as stale, then re-taken" as *remove the lock
directory, recreate it, write a foreign token*. That is what a third party actually does, but the
test cannot make the two builds concurrent, so what it pins is `releaseBuildLock`'s token
comparison, not the race. If stage 4 moves the lock into its own module, this is the test that
should gain a real second holder.

**Open question:** the scratch prefixes and `STALE_SCRATCH_MS` are spelled out literally in
`test/scratch.test.ts` rather than imported, matching how `workspace.ts` pins the default override
chain. If stage 5 item 7 moves the timestamp into the directory *name*, these literals become the
statement of the old naming and will need rewriting alongside the inverted assertion.

## Stage 2 — C5/C7/C8/C9 (stamp gate)

**Assumption:** `test/stamp-gate.test.ts` reimplements the stamp's sha256 (`sha256()`) rather than
importing `hashContent` from `src/build.ts`, on the same reasoning the plan gives for
`computeStamp`: Stage 4 moves the stamp machinery to `src/stamp.ts`, and the file should not
acquire a second import across that seam. `hashContent` *is* exported today, so this is a choice,
not a constraint.

**Assumption:** "recompiled rather than gated" is asserted via the presence of the build's own
summary line (`compiledThisRun()` matches `composable-skills: <n> skill(s) → `), because a gated
run with no diagnostics writes nothing at all to stdout. Both directions are exercised — C7's
gated run asserts the line is absent, C5's and C9's compiling runs assert it is present — so the
predicate cannot pass hollowly. Stage 5 changes neither summary wording nor the gate's silence,
but if it does, this is the helper to update.

**Assumption:** C7's unreadable input is `templates/notes.md` — a *file directly under a source
root*. `discoverSkills` skips non-directory entries there silently (`build.ts:274`), while
`listEntries` hashes it, so it is unreadable to `computeStamp` and to nothing else. Putting the
unreadable file inside a skill directory instead would have made it an *extra* and routed the
failure through `collectExtras`/`copyFileSync`, testing a different thing.

**Assumption:** C9 builds the second repo as a sibling directory under `ws.root` with its own
`composable-skills.jsonc` (so its own `repoRoot`, and therefore its own state dir and stamp), both
repos targeting `${home}/skills`. The two configs carry distinct `id`s (`repo-a`, `repo-b`) so
neither's marker makes the other's output prunable — the collision under test is the *overwrite*
loop, not a prune.

**Assumption:** C8's second patch site keys on `target.includes(".composable-skills-tmp-a-")`, the
`TMP_PREFIX` literal, because `TMP_PREFIX` is not exported from `src/build.ts`. If Stage 5's change
to `uniqueSuffix()` also changes that prefix, this predicate has to change with it. It is
path-selective, not call-count-selective, as the plan requires.

**Open question:** C5's failed-outcome test drives the failure through `emitSkill`'s catch arm by
making `writeFileSync` throw for the staging `SKILL.md`, which means it also exercises the
unguarded `rmSync` at `build.ts:708` — that call happens to succeed there. After Stage 5 wraps it
in `removeQuietly` (item 3/4), the test still passes unchanged; noting it so the overlap with C8 is
deliberate rather than discovered later.

**Open question:** C5's finding-4 test asserts `build --check` returns 1 after two real builds and
again after a third. Stage 5 inverts that to 0. Whether the *declined* skill should additionally
appear in `--check`'s replayed diagnostics (rather than only in the real build's live ones) is not
settled by the plan; the test currently asserts nothing about `--check`'s output text, only its
exit code, so Stage 5 is free either way.

## Stage 3 — containment (finding 8)

**Assumption:** `src/contain.ts` shares one private `relativeSegments` helper between `isUnder`
and `isAtOrUnder`, returning `null` for "escapes" and a segment array otherwise. `isUnder` is then
`segments.length > 0` and `isAtOrUnder` is `segments !== null`. This keeps the single core the
plan asked for while making the self-path difference the only visible distinction between the two
exports.

**Assumption:** the segment-split core is strictly more permissive than `config.ts`'s and
`override.ts`'s old string-prefix form only for a candidate whose relative path *segment* is not
`..` but whose text starts with `..` — i.e. exactly the `..foo` case, which those two already
accepted. So re-pointing them to `isAtOrUnder` is a no-op, which the four-way table in
`test/containment.test.ts` confirms unchanged.

**Assumption:** the header comment block of `test/containment.test.ts` and the four section
markers named the predicates by their old `file:line` (`directives.ts:176 isContained`,
`init.ts:229 isInsideRepo`, …), all of which Stage 3 deleted. Those comments were rewritten to
name `isUnder` / `isAtOrUnder` and the call site instead, and the header's four-way table now
records the post-Stage-3 result. No assertion other than the one the boxed comment marked was
touched; the suite is still 334 tests.

**Open question:** `directives.ts` no longer exports anything containment-related, but
`resolveContainedFile` and `ContainmentFailure` still live there rather than in `contain.ts`. They
need `node:fs`, so moving them would cost `contain.ts` its leaf status; leaving them keeps the
`fs`-touching resolver with the parser that is its only caller-adjacent module. Stage 4's cut may
want them somewhere else again — not decided here.

## Stage 4 — build.ts cut

**Assumption:** "pure move" was read as preserving each symbol's *original visibility* rather than
exporting everything the plan lists. So `Probe`, `FileProbe`, `looksLikeSkill`, `probeFile`,
`isMissing`, `OwnerRecord`, `readMarker`, `LockResult`, `LockInfo`, `releaseBuildLock`,
`readLockInfo`, `lockIsStale`, `directoryLooksStale`, `describeLockHolder`, `processAlive`,
`overrideContainmentMessage`, `collectExtras`, `swapIntoPlace`, `isStaleScratch`, `readOutput`,
`ListedEntry`, `listEntries`, `updateWithFile`, `stampPath`, `readOutputHashes` and `isDiagnostic`
are module-private in their new homes, exactly as they were private inside `build.ts`. Only the
symbols another module actually calls are exported. A later stage that wants to test one directly
will have to export it then.

**Assumption:** imports that went dead in `build.ts` once a block left were deleted rather than
kept. After the cut `build.ts` imports nothing from `node:`, and no longer names `crypto`, `fs`,
`path`, `CompiledSkill`, `Config`, `DiscoveredSkill`, `Root`, `OUTPUT_FILENAME`, `OWNER_MARKER`,
`STAMP_FILENAME`, `normaliseEol`/`normaliseEolBytes`, the `frontmatter.ts`, `directives.ts` and
`validate.ts` imports, or `removeQuietly`/`uniqueSuffix`. Nothing else in those lines changed.

**Assumption:** `compile.ts` keeps `build.ts`'s import of `ContainmentFailure`, `LineOrigin` and
`SourceLine` from `./directives.ts` (which re-exports them from `types.ts` at `directives.ts:8`)
rather than re-pointing them at `types.ts`. `override.ts` imports `SourceLine` from `types.ts`
directly, so the two spellings coexist as they did before the cut; unifying them is not a move.

**Assumption:** `OUTPUT_FILENAME`/`OWNED_OUTPUT_NAMES` were placed in `layout.ts` directly below
`OWNER_MARKER`, keeping the existing doc comment verbatim, because `OWNED_OUTPUT_NAMES` is derived
from both `OUTPUT_FILENAME` and `OWNER_MARKER` and must follow the latter.

**Open question:** `stamp.ts` now owns `hashContent`, which is a general sha256-of-a-string helper
with no stamp-specific behaviour, and `build.ts` imports it from there only to hash a compiled
`SKILL.md`. It sits in `stamp.ts` because the plan assigned it there and every other caller is a
stamp concern, but `fsutil.ts` — or a future `hash.ts` — is arguably its home. Not decided here.

**Open question:** `emit.ts` owns `TMP_PREFIX`/`OLD_PREFIX`, and `test/scratch.test.ts:21` spells
both out rather than importing them, with a comment citing `src/build.ts:46-58`. That comment's
line reference is now stale (the constants are `emit.ts:10-11`). Tests were out of scope for this
stage, so it was left alone.

---

## Carry-forward: stale code references in test comments after the Stage 4 cut

The `build.ts` cut relocated code that Stage 2 tests cite by `file:line` in comments. Assertions
are unaffected; only the comments are now wrong.

Known stale references, reported by the Stage 4 implementer:
- `test/scratch.test.ts:21` — cites `src/build.ts:46-58` for `TMP_PREFIX` / `OLD_PREFIX`; both now
  live in `src/emit.ts`.
- `test/scratch.test.ts:41` — cites `src/build.ts:766`; now `src/emit.ts` (`isStaleScratch`).
- `test/scratch.test.ts:118` — cites `src/build.ts:747-748`; now `src/emit.ts` (`pruneTarget`'s
  scratch branch).

**Fix these in Stage 5 item 7**, which already edits `test/scratch.test.ts` to invert the
finding-10 assertion. Doing it there avoids a separate pass over the same file.

Anyone editing a Stage 2 test file in Stage 5 should re-check its `src/` citations at the same
time: `stamp-gate.test.ts` and `ownership.test.ts` cite `build.ts` line numbers too, and those
symbols are now spread across `stamp.ts`, `emit.ts`, `ownership.ts` and `compile.ts`.

---

## Stage 4 — init.ts cut

**Assumption:** the private `BOM` constant (`init.ts:43` before the cut) moved into `settings.ts`
alongside `settingsStep` and `sessionStartCommands`, its only two callers. The plan's table does
not name it, but leaving it in `init.ts` would have made it a dead export-less constant there and
forced a fourth import edge back out of `settings.ts`.

**Assumption:** `fileMode` and `isWritable` moved into `steps.ts` as module-private functions
rather than exports. Both are called only from `applyStep` / `refuseUnwritablePath`, which moved
with them; exporting them would widen the surface for nothing.

**Assumption:** `InitStep` is now declared and exported by `steps.ts`, and `init.ts` imports it as
a type rather than re-exporting it. Nothing outside `src/` imported `InitStep` from `init.ts`.

**Assumption:** the moved functions were exported where a caller outside their new module needs
them (`applyStep`, `isSamePath`, `refuseSymlinkedPath`, `refuseUnwritablePath`, `symlinkRefusal`,
`firstSymlinkComponent`, `settingsStep`, all four of `textfile.ts`, `unifiedDiff`), and otherwise
kept exactly the visibility they had. Adding `export` is the only textual change made to any moved
line; a multiset comparison of the pre-cut file against the five post-cut files confirms every
other line, comment included, is byte-identical.

**Open question:** `textfile.ts:fileExists` and `fsutil.ts:pathExists` are now two identically
bodied `lstatSync` wrappers in two modules, an artefact of the two halves of the Stage 4 cut being
specified independently. Deduplicating them is a behaviour-neutral follow-up nobody has scheduled;
it was out of scope here because `fsutil.ts` belongs to the `build.ts` half.

**Open question:** `settings.ts` is 305 lines and holds both the settings-file merge and the
"does this command string invoke us" analysis (`invokesThisTool` / `tokenise` / `INSTALLED_TAIL`).
The two are related only through `HOOK_COMMAND`. A later `hookcmd.ts` split is defensible, but
`INSTALLED_TAIL` derives from `CLI_REL` at module scope, so any such split must keep those two
together or reproduce the temporal-dead-zone crash this cut was redesigned to avoid.

---

## Cleanup owed: `textfile.ts:fileExists` duplicates `fsutil.ts:pathExists`

Introduced by this plan, not pre-existing. Stage 4's two halves were specified independently —
the `build.ts` chain put `pathExists` in `fsutil.ts`, and the `init.ts` chain put `fileExists` in
`textfile.ts` — and the two bodies came out identical. Reported by the Stage 4 `init.ts`
implementer.

**Do not fix while `s5-finding2` holds `textfile.ts`.** That agent is rewriting `readIfPresent`
into a three-state result and moving existence onto `lstat`, which touches the same file and may
change what the survivor should be called.

Afterwards: keep `fsutil.ts:pathExists` (the strict leaf, and the name the `build.ts` side already
uses), delete `textfile.ts:fileExists`, and re-point its callers. **Verify the semantics match
before deleting** — `pathExists` uses `lstatSync`, so a symlink counts as existing; if the
`init.ts` original followed symlinks instead, these are two different questions wearing the same
body and merging them would be a behaviour change, not a dedup.

Related, logged by the same implementer and not acted on: `settings.ts` (305 lines) arguably
holds a second module in `invokesThisTool` / `tokenise` / `INSTALLED_TAIL`. Any such split must
keep `CLI_REL` and `INSTALLED_TAIL` together — separating them is what caused the TDZ crash that
revision 1 of this plan shipped.

## Stage 5 — finding 6

**Assumption:** `isMissing` is exported from `src/discover.ts` rather than copied or moved.
`src/directives.ts` now imports it, which puts `directives.ts` above `discover.ts` in the module
graph. Verified acyclic — `discover.ts` imports only `types.ts` and `layout.ts`. The plan's
stage-5 item 3 (finding 7) says to reuse "`discover.ts`'s `isMissing`", so exporting it there is
the shared move both items need; the one-token `export` is the only change to `discover.ts`.

**Assumption:** the `rejectSymlinkedRoot` `lstatSync(root)` is a **fifth** errno-collapse point in
`resolveContainedFile`, not counted by the plan's "four" (`:115`, `:125`, `:134`, `:142` — the
`lstat` sits above `:115`). It produced the same `{kind:"root"}` verdict, and it is the call that
actually fires when an override root's *parent* is unsearchable, so leaving it collapsed would
have kept exactly the case finding 6 names silent. It now routes through the same `rootFailure`.

**Assumption:** for a `chmod 000` override root the failing syscall is the loop's `lstatSync`
(verdict `unreadable`), not `realpathSync(root)` — `realpath` needs search permission on the
root's *parent*, not on the root itself. `realpathSync(root)`'s `root-unreadable` verdict is
reached when a directory *above* the root is unsearchable. Both cases are covered by tests.

**Assumption:** `resolveIncludePath`'s `"root"` message ("source root … is unreadable") was
already wrong for the absent case, so the message-quality fix rewords it to "does not exist" and
adds distinct `root-unreadable` / `unreadable` messages. No test asserted the old strings, and no
control flow changed there — every one of these still rejects the skill.

**Open question:** the `unreadable` verdict carries `part` (the component that failed), which
nothing currently reads — `describe(cause)` already names the full path in the errno message. It
is kept for symmetry with `missing` and because a future caller may want the component without
parsing a libuv string. Drop it if that never materialises.

## Stage 5 — docs

**Assumption:** draft A's "exists but cannot be read" refusal is stated as scoped to the three
paths `init` *writes* (the config file, `.gitignore`, the repo's tracked `.claude/settings.json`),
and the spec now says explicitly that it does not reach `.claude/settings.local.json` or the
user-level settings file, which `init` only reads. Those two get a *warning* — the duplicate-hook
check could not be made — never a refusal, matching the plan's code note for
`warnAboutMergedSettings`.

**Assumption:** draft E's normative half was written so the warned case does **not** change
control flow: an override root or file that exists but cannot be read warns and the scan still
falls through to the next root. This matches the plan's requirement that the `unreadable` kind
take the `continue` branch rather than `return fromDefault()`.

**Assumption:** draft F's normative half scopes the guard to the single unreadable target —
"nothing in that target is pruned" — rather than to the whole run, because the cause is local to
that target, unlike an unreadable source root which makes the corpus unknowable everywhere. A
target that does not exist at all is explicitly excluded, so the diagnostic-noise constraint
holds.

**Assumption:** finding 17's *warning* was added to the spec's illustrative Warned list under
*writing and pruning* ("a target holding a compiled skill of this build's name under another
build's marker") as well as to the normative Prune bullet, so it is stated in both places rather
than only in the enumerated prose.

**Assumption:** `docs/CONTEXT.md`'s **Marker** entry was amended alongside the **Stamp** entry,
though only the latter was named in the stage brief. The Marker entry said "a *directory* without
one is never overwritten"; a symlink is not a directory, and `CONTEXT.md` is normative, so leaving
it would have licensed the reading finding 11 exists to close.

**Assumption:** `README.md`'s stamp paragraph ("the stamp also records a hash of every compiled
`SKILL.md`, and each is re-read before the gate closes") was left unchanged. It stays true under
per-target outcomes — every `SKILL.md` this build actually wrote still gets a hash recorded — and
the README is deliberately a summary of the spec rather than a second normative statement. Only
its warned list needed the symlink case.

**Open question:** the spec now says a build whose stamp records *only* declines verifies nothing
and therefore gates nothing, so it recompiles at every session start. That is the intended reading
of "a record that verifies nothing gates nothing", but it means a repo whose every target is
occupied by someone else's directory pays a full compile forever, in silence apart from the
decline warnings. Whether that case deserves its own summary line is not decided; it is the same
shape as open question 1 (whether the tool should concede a colliding name).

**Open question:** draft H says "the stamp check reports the collision", which places a
marker-aware diagnostic inside the stamp comparison rather than inside writing or pruning. The
spec's *Ownership and pruning* section is where the sentence lives, but the behaviour is the
`SessionStart` hook section's. If a later reader finds that split confusing, the fix is a
cross-reference, not a move — the collision is an ownership fact and the rebuild loop is a stamp
fact.

## Stage 5 — finding 2

**Assumption:** the three-state result is a discriminated union in `src/textfile.ts` —
`TextFileRead = { kind: "present"; text } | { kind: "absent" } | { kind: "unreadable"; cause }` —
rather than `string | null | typeof UNREADABLE` or a thrown error. It reads at each call site as
three named branches, and `cause` carries the errno string into the diagnostic so the developer is
told *why* the read failed rather than only that it did.

**Assumption:** existence is decided by `lstat`, and only on the failing path: a successful read is
itself proof the file is there, so `readIfPresent` calls `fileExists` (lstat) only inside the
`catch`. This keeps the common case at one syscall while making "absent" a statement `lstat` made.

**Assumption:** the refusal is one shared helper, `unreadableRefusal` in `src/steps.ts`, beside
`symlinkRefusal` — both are "a verdict about the path, reached before any verdict about contents",
and both return a `refused: true` step with `after: null`, which is the existing mechanism
`runInit` already turns into exit code 1 in both the dry-run and the `--write` branch.

**Assumption:** for a `.gitignore` that is *both* a symlink and unreadable (a dangling link, or a
link to a file this process cannot open), the **symlink** verdict still wins. `gitignoreStep` only
returns the unreadable refusal when `firstSymlinkComponent` finds no link, so the step falls
through to `refuseSymlinkedPath` exactly as it did before this change. Without that guard the
diagnostic would tell the developer to "fix the permissions" on a path whose real problem is that
it points outside the repo. `settingsStep` needed no such guard — it already asks about the
symlink before it reads. Pinned by `test/init.test.ts`, "a dangling symlink keeps the symlink
verdict rather than this one".

**Assumption:** `warnAboutMergedSettings` warns per unreadable file and carries on, and the warning
says what could not be *checked* ("could not check whether a hook there already runs this tool"),
not what is wrong with the file — the tool has no claim on either of those two files and cannot
know that anything is wrong with them.

**Note for the `fileExists`/`pathExists` cleanup above:** `fileExists` is now load-bearing rather
than a convenience — it is what separates "absent" from "unreadable". Whichever name survives must
stay `lstat`-based and must not become `existsSync` or a `statSync` that follows links: under a
symlink-following existence test a dangling `.gitignore` symlink would read as absent again, and
the create-over-a-file-nobody-read bug returns by that route.

**Open question:** the same three-state distinction applies to every other place `src/` reads a
file it is about to replace — `build.ts`'s target marker reads are the obvious one. Nothing in
this finding's scope touches them, and finding 11 is already changing that area, so no attempt was
made to generalise `TextFileRead` beyond `init`.

---

## Correction to the plan: finding 6 had FIVE errno-collapse points, not four

The plan (and the adversarial review that produced it) named four collapse points in
`resolveContainedFile`. The implementer found a fifth and it is the load-bearing one:

1. **`rejectSymlinkedRoot`'s `lstatSync(root)`** — sits *above* the range everyone counted, so it
   appeared in no analysis. **This is the call that actually fires when an override root's parent
   directory is unsearchable.** Fixing only the four named points would have left the precise case
   finding 6 describes still silent.
2. `realpathSync(root)` — finding 6's nominal subject in the plan.
3. the loop's `lstatSync(current)` — fires for a plain `chmod 000` on the root itself, because
   `realpath` needs search permission on the root's *parent*, not the root.
4. `realpathSync(current)`.
5. `statSync(real)`.

Lesson for the remaining stages: the adversarial review's line-level inventories were accurate for
what they covered but were not exhaustive. An implementer who fixes exactly the cited lines and
stops has not necessarily fixed the finding. Locate every call that can produce the verdict, not
only the ones a reviewer enumerated.

Also of note: the implementer verified the `continue` vs `return fromDefault()` decision by
substitution — swapping it makes all three new tests fail, because each asserts that a
lower-precedence override root still wins. That is the right way to guard a one-line decision
whose wrong version is invisible in review.

`isMissing` was exported from `src/discover.ts` (one token) to avoid a fifth hand-rolled errno
check. Finding 7 needs the same export; it is a shared move, not a competing one.

---

## Stage 5 — findings 11, 4, 17

**Assumption:** the stamp record's per-target key is the target's **resolved path** (`Root.path`),
not its spec string. Both are already stamp inputs (`computeStamp` hashes `spec` *and* `path` for
every root), so a record can only ever be read back against the target list it was written for —
changing either invalidates the input hash before the outcomes are ever consulted.

**Assumption:** a target for which `emitSkill` reported **failed** records the skill's *previous*
outcome for that target where one exists, and no outcome at all otherwise. An I/O error says
nothing about what is standing at the path, so the last thing actually observed there stays the
truth — the per-target form of the existing "a skill that failed carries its previous record
forward" rule. "No outcome at all" is then a claim the record does not make, and the gate treats it
the way it treated a `null`: it requires that nothing be standing there. That is also what makes a
decline distinguishable from a failure, which a single `null` could not do.

**Assumption:** `outputsVerified` no longer returns on the first mismatch; it scans every skill and
target and decides at the end. A failed verification is followed by a full recompile that dwarfs
the extra reads, and stopping early would suppress the finding-17 collision warning for every skill
after the first mismatch.

**Assumption:** a run with **no configured targets** gates as before. Nothing is written anywhere,
so `verified > 0` can never be reached and the old per-skill counter's behaviour (which incremented
regardless of targets) would otherwise become a permanent recompile. It is spelled out beside
`skills.length === 0` as the other "wrote nothing anywhere, so has nothing to prove" case.

**Assumption:** `standingOf` in `src/ownership.ts` is the single answer to "is this entry mine to
replace" — used by `emitSkill` to decide, and by the stamp's decline re-check to ask whether the
decline still holds. Two spellings of the symlink rule would be a way for one of them to drift, and
the re-check is the one where drift silently wedges a skill out of a target forever.

**Assumption:** a bare-hash stamp (pre-record format) now reads as **absent** rather than as an
empty record. It verified nothing and therefore gated nothing before, so the observable behaviour
is unchanged; treating it as absent puts it on the same path as any other unreadable format.

**Open question:** the finding-17 warning fires from the *gate*, so it is a live diagnostic and is
never stored in the stamp. It therefore appears on exactly the runs the collision forces a
recompile on — which is every run, for as long as both repos build. That is the accepted cost of
not arbitrating (open question 1 in the plan), but it does mean the noise constraint is satisfied
only in the sense that a *non-colliding* repo stays silent. If open question 1 is later answered by
conceding the name, this warning is the thing that should become a one-off.

**Out of scope but necessarily touched:** `test/build.test.ts`'s `a forged stamp` block. The record
shape it forges is the shape under change, and its `expect(outputs["c"]).toBeString()` setup
assertion is a direct read of it. The block's helpers were updated to the per-target shape and to
write the format `version`; without the version every forgery would be rejected at parse time and
the four tests would pass vacuously, testing the version check instead of the gate.

## Stage 5 — finding 5

**Assumption:** every `return { fatal }` in `loadConfig` carries the whole `diagnostics` array
accumulated so far, not a hand-picked subset. The three early returns (unreadable, unparseable,
not an object) run before anything is pushed, so they carry an empty array; the two `"id"` returns
can carry unknown-key warnings, and the `readStringArray` return carries the per-key errors that
are the point of the finding. One rule for all six rather than a per-site judgement about what is
"relevant" — the fatal already tells the developer the file is unusable, and a warning about a
misspelt key is more likely to *be* the cause than to distract from it.

**Assumption:** consumers print the diagnostics *before* the fatal. `runBuild`, `runInit` and
`runOverride` all emit `[...loaded.diagnostics, error(loaded.fatal)]`. Specific-then-general reads
as an explanation followed by its consequence; the reverse reads as a retraction. `runInit` keeps
its own "init needs a config it can read" line last, after the fatal, unchanged.

**Decision — the parse-position message.** The plan offered two ways out of a `position`/`column`
computed against the comment-stripped text: map the offset back, or stop quoting it. Neither was
taken, because a third removes the mismatch at its source: the JSONC reduction now **blanks** what
JSON cannot hold instead of deleting it. Comments become spaces (newlines kept as newlines) and a
trailing comma becomes a space, so the reduced text has the same length and the same line breaks as
the file on disk and every offset the parser reports already addresses the developer's own file.
`stripJsonComments`/`stripTrailingCommas` are renamed `blankJsonComments`/`blankTrailingCommas` to
say so; neither had a consumer outside `parseJsonc`, whose signature is unchanged (`settings.ts` and
`test/init.test.ts` use it and are untouched). This beats mapping the offset back — which needs an
index map plus a regex rewrite of an engine-specific message string — and it beats dropping the
number, which would have discarded a correct line along with a wrong column. It is also the only
one of the three that is testable under this suite: Bun's JSC reports no position at all, so a
message rewrite would have had no end-to-end coverage on the runtime the tests run on, whereas the
length-and-line-break invariant that makes the offsets right is runtime-independent and is asserted
directly.

**Open question:** invariant 9 (`tool-contract.md:536`, plan open question 3) — the per-key error
carries `file` and no `line`. With the blanking change a line is now *available* for a parse error,
but not for a key error: `readStringArray` sees a parsed object and has no offset for the key. The
invariant still needs scoping to template-derived diagnostics, or accepting a config diagnostic with
no line. Unchanged by this work.

---

## Design improvement over the plan: finding 5's parse-position fix

The plan offered two options for the wrong `position`/`column` in the JSONC parse error: map the
offset back through the comment strip, or stop quoting a position that is wrong. The implementer
took a third that removes the mismatch at its source.

**The JSONC reduction is now length-preserving.** Comments become spaces (newlines kept as
newlines) and a trailing comma becomes a space, rather than being deleted. The reduced text has
identical length and identical line breaks to the file on disk, so the engine's reported offsets
already address the developer's own file. `stripJsonComments`/`stripTrailingCommas` were renamed
`blankJsonComments`/`blankTrailingCommas` so the names stop lying.

**Why this beats mapping the offset back**, and the reason worth keeping: **Bun runs on JSC, which
reports no position at all** — `JSON Parse error: Expected ':' before value in object property
definition`. Any offset-mapping or message-rewriting code would therefore have had **zero
end-to-end coverage on the runtime this suite runs on**, which is exactly the defect class this
whole review exists to remove. The length-and-line-break invariant that makes the offsets correct
is runtime-independent and is asserted directly.

Verified under Node 24: a file with a leading line comment and an inline block comment now reports
`line 4 column 13` with offset 60 landing on the offending `[`; before the change the same file
reported a column short by the width of the removed block comment and a position short by 31.

Generalisable lesson for this repo: when a fix's correctness can only be observed on a runtime the
test suite does not use, prefer a formulation whose invariant is runtime-independent and can be
asserted directly.

---

## Stage 5 — findings 7, 16, 10

**Assumption:** finding 16's fix changes what `test/stamp-gate.test.ts`'s "per-skill crash
containment" test can observe, so that test was updated even though tests were otherwise out of
this stage's scope. It reached `runBuild`'s per-skill catch *through* finding 16 — the C8 row in
the plan says so explicitly ("past the one unguarded call on the path") — so once the cleanup
`rmSync` goes through `removeQuietly` there is no fs-injectable route to that catch at all:
`compileSkill`, `expandIncludes`, `resolveContainedFile`, `resolveSlot`, `findStrayOverrides`,
`collectExtras`, `standingOf`/`readMarker` and `emitSkill`'s own `try` are each guarded. The test
now asserts the *fixed* behaviour — the write failure is reported as `cannot write …` with its own
errno, `skill failed unexpectedly` does not appear, the other skill still compiles, and the
unremovable staging directory is left for a later sweep. `runBuild`'s per-skill catch is now
defensive only; nothing in `src/` can be made to reach it from the test fixture.

**Assumption:** the finding-16 rollback repair reports both errors in one thrown `Error` message
(`<swap failure> — and <destination> could not be restored from <parked>: <rollback failure>`,
with the swap failure also as `cause`), rather than logging separately. `emitSkill`'s catch arm
interpolates exactly one `describe(cause)` into `cannot write …`, and a caller looking for the
parked copy needs its path in that one line. `fs.rmSync(parked, …)` at the end of `swapIntoPlace`
was deliberately **left** as-is: it is inside `emitSkill`'s `try`, so it is guarded, and routing it
through `removeQuietly` would change a swap that succeeded from `failed` to `written` — a real
question, but not one of these three findings.

**Assumption:** finding 7's warning is worded `cannot read target <path>: <errno> — nothing in it
was considered for pruning`, taking the consequence clause verbatim from `tool-contract.md`'s
Warned list. Where the same permission bit breaks every write into that target too, it arrives
after N `cannot write <target>/<skill>: <errno>` errors; it is not duplicate noise because it
names a different verb, a different path (the target, not a skill under it) and the one
consequence the per-skill errors do not mention. `test/scratch.test.ts` pins that shape.

**Assumption:** the "one group" wording fix in `src/discover.ts` settled on
`cannot read <noun> <path>: <reason> — <consequence>`, which is the shape `src/compile.ts`'s
`cannot read override root <root>: <cause>` already uses. Three messages changed: the source root
gained `— skipped`, and the template and skill-directory arms gained their nouns (`cannot read
template …`, `cannot read skill directory …`). No test asserted on any of the three.
`src/compile.ts:281`'s `collectExtras` warning shares the vocabulary but was left alone —
`compile.ts` was outside this stage's file scope.

**Assumption:** `uniqueSuffix()` now returns `<pid base36>-<8 hex>-t<Date.now() base36>` — the
timestamp **last**, behind a `t`. Position is load-bearing, not cosmetic: these suffixes are
appended to names that embed a skill name, skill names are unvalidated directory names and may
contain `-`, so a timestamp parsed positionally from either end can be a fragment of a skill name.
The previous format ended in eight hex digits, which can never begin with `t`, so `/-t([0-9a-z]
{1,12})$/` anchored at end-of-name separates the two formats without guessing where the skill name
stops. Verified against adversarial names (`…my-keyboard-mnemonic-1a2b-deadbeef`,
`…t-shirt-printer-3n2-1a2b3c4d`): both read as old-format and fall back to mtime. A base36
timestamp is not itself sufficient — `parseInt("keyboard", 36)` lands inside the plausible
millisecond window, which is why length or range checks were rejected in favour of the sentinel.

**Assumption:** `createdAtFromName` lives in `src/fsutil.ts`, next to `uniqueSuffix`, so the format
and its only reader sit together; `isStaleScratch` in `src/emit.ts` consults it and falls back to
`lstat().mtimeMs` when it returns null. `src/lock.ts:35` also calls `uniqueSuffix()` for a lock
token; a longer token is still a unique token, and nothing parses it.

**Open question:** the `STALE_SCRATCH_MS` window is now measured from two different clocks
depending on the name format — the recorded parking time for new directories, `mtime` for
old-format ones. That is intended and transitional, but it means the fallback path stays live
forever unless a later version dates the format out (e.g. by treating any name with no timestamp
as stale outright once enough releases have passed). Not decided; the current behaviour is
strictly no worse than before for those directories.

**Open question:** three tests were added to `test/scratch.test.ts` covering finding 7's new
warning (`a target that cannot be enumerated`), which the plan did not list a proof for. They live
there rather than in `test/build.test.ts` because `pruneTarget` is the subject and that file
already owns `pruneTarget`'s scratch branch, but `build.test.ts`'s `prune and ownership` block is
arguably their home.

## Stage 6 — fileExists/pathExists dedup

**Assumption:** the two bodies were still byte-identical at merge time — both
`try { fs.lstatSync(candidate); return true } catch { return false }` — so the finding-2 rewrite of
`readIfPresent` did not diverge `fileExists` from `pathExists`, and `pathExists` satisfies the
constraint logged under Stage 5 finding 2 (must stay `lstat`-based, never `existsSync` or a
link-following `statSync`). The merge is therefore a dedup, not a behaviour change.

**Assumption:** `src/init.ts` gaining a direct `./fsutil.ts` import is safe rather than a new
coupling to route around. `fsutil.ts` imports only `node:crypto`/`node:fs`/`node:path`, so it adds
no cycle; verified by `bun test` (376 pass) and by running the bundled `dist/cli.js`, where module
init order differs from the source layout.

**Assumption:** `node:fs` stays imported in `src/textfile.ts` — `readIfPresent` still calls
`fs.readFileSync` directly; only the `lstat` call moved out.

## Stage 6 — version, CI, tooling

**Assumption:** `package.json` gained `author: "Mattias Nilsson"` (the name on the only commit in
the repo) and nothing else. `repository` and `bugs` were left out rather than guessed: `git remote
-v` is empty, so there is no URL to read, and a `bugs` URL is conventionally derived from the
repository one. The commit author's email (a work address) was deliberately not
put in `author`, because `package.json` is published to the registry verbatim and a work address
in it is a disclosure the repo has not otherwise made. Add both fields in one line each once a
remote exists.

**Assumption:** `lineWidth` is 100. The evidence is the existing distribution of line lengths in
`src/`: of 4148 lines, 442 fall in the 91-100 column band and only 43 in 101-110 — a tenfold cliff
at exactly 100, which is the author's hand-wrap point. Formatting the tree at Biome's default 80
rewrites 2965 lines; at 100 it rewrites 470. The formatter was fitted to the code, per the plan's
"if the reformat is huge, the config is wrong, not the code".

**Assumption:** the diff-size minimum across widths is actually at 105-108 (253-264 lines), not at
100 (470). It was not chosen. Those widths only look cheaper because they leave the handful of
101-110 column outliers alone while also not re-splitting anything; formatting at 110 *creates*
194 lines over 100 columns where the tree has 157, moving away from the observed style rather than
towards it. 100 is the round number the cliff sits on.

**Assumption:** `assist.actions.source.organizeImports` is turned **off**. It is on by default in
Biome 2 and `biome check` reports it at error severity, so leaving it on would have (a) made
`bun run lint` fail and (b) folded a 23-file import reordering — a content change, not a
formatting one — into the commit meant to reflow whitespace only. No lint *rule* was disabled and
none was added; the linter is `preset: "recommended"` untouched.

**Assumption:** `rules.recommended: true` was written as `rules.preset: "recommended"`. Biome
2.5.12 emits a DEPRECATED diagnostic for the former and will remove it in the next major.

**Open question:** `bun run lint` passes while emitting **102 warnings and 43 infos**, all from
three recommended rules this codebase violates deliberately and pervasively —
`style/noNonNullAssertion` (59, the idiomatic pairing with `noUncheckedIndexedAccess`),
`complexity/useLiteralKeys` (43, indexing `unknown` records in type guards) and
`suspicious/noTemplateCurlyInString` (41, `${...}` inside the placeholder syntax this tool's whole
domain is about). A gate that is green with 102 standing warnings does not gate much. The three
rules are candidates for `"off"` with a written reason, but switching them off is *tuning
recommended*, which stage 6 was told not to do. Not decided.

**Open question:** `biome check` also reports 2 real `correctness/noUnusedImports` hits —
`test/resolution.test.ts:13` (`read`) and `test/slots.test.ts:3` (`bodyOf`). They are dead imports,
not formatting, so they were left alone; they are a one-line fix whenever someone touches those
files.

**Open question:** the `chore: add biome` commit is red in CI by construction. It adds the
`bun run lint` step, and `lint` runs `biome check`, which fails on the then-unformatted tree; only
the following `style: apply biome format` commit makes it green. That is inherent to the plan's
two-commit split (config first, zero content changes; formatting second). The alternative — one
combined commit — buys a green history at the cost of the reviewable separation the
`.git-blame-ignore-revs` entry depends on. Left as specified.

**Assumption:** `biome.json` carries **no comments**. Biome 2.5.12 does not parse `//` comments in
`biome.json` the way the documentation implies: with the rationale written inline as comments, the
`organizeImports: "off"` setting was silently ignored and the error count went from 1 to 91.
Verified by stripping the comments and re-running. The rationale therefore lives in this document
instead of next to the settings, which is worse but correct.

**Open question:** the formatter's one aesthetically bad rewrite is
`test/text.test.ts`, where a compact two-line table of 16 byte-level fixtures (`"\r\n"`, `"﻿"`,
`"\x00"`, `"日"`, ...) becomes 16 one-per-line entries, because it no longer fits on one line and
Biome then explodes it fully. Every fixture byte is preserved — the census of control and non-ASCII
bytes is identical before and after, and no assertion changed — but a `// biome-ignore format:` on
that array would read better. Not applied, because it is a content change.

**Assumption:** the `smoke` job installs both Bun and Node: Bun to run `bun run build`, and
`actions/setup-node@v4` at the matrix version to execute the built bundle. `--version` and
`--help` both exit 0 today, verified locally, so a non-zero exit in CI means a genuine module-load
or floor violation rather than a verb that legitimately exits non-zero.

### Stage 6 — revision after review

Three entries above are superseded. Kept rather than edited, because this document is append-only.

**Supersedes the "no comments" assumption.** The config is now **`biome.jsonc`**, not `biome.json`,
and it does carry its rationale inline. The earlier finding was right about the mechanism and wrong
about the remedy: a `//` in `biome.json` makes Biome emit parse errors on the config and silently
fall back to its defaults (observed as `organizeImports` switching itself back on and the error
count going 1 → 14). Biome reads `biome.jsonc` as JSONC, so the same comments parse cleanly there.
Verified by adding one comment to each filename in turn and comparing diagnostic counts.

**Supersedes the `preset` open question.** `"preset": "recommended"` is correct and is *not*
silently ignored. Both the schema shipped in `node_modules/@biomejs/biome/configuration_schema.json`
and the published `2.5.12` schema define `Rules.preset` with the enum
`["recommended", "all", "none"]`, and Biome emits a DEPRECATED diagnostic for the older
`"recommended": true` telling you to use `preset` instead. Proven honoured by varying it:
`none` → 0 diagnostics, `recommended` → 102 warnings + 43 infos, `all` → 30 errors + 431 warnings
+ 612 infos.

**Supersedes the "102 warnings" open question.** Three `recommended` rules are now **off**, each
because it contradicts a deliberate, pervasive idiom rather than because it was noisy:

- `style/noNonNullAssertion` (59) — `tsconfig.json` sets `noUncheckedIndexedAccess`, so `lines[i]!`
  after a bounds check is the idiom that setting exists to produce. The alternative is dead
  branches for cases the surrounding code has already excluded.
- `complexity/useLiteralKeys` (43) — every hit is bracket access on a `Record<string, unknown>` at
  a JSON deserialization boundary (`record["version"]`, `parsed["hooks"]`, `record["token"]`).
  The brackets mark the key as untrusted external input rather than a property of a typed object,
  and Biome classifies its own fix for this rule as unsafe.
- `suspicious/noTemplateCurlyInString` (41) — every hit is this tool's *own* placeholder syntax in
  a plain string (`"${home}/claude/skills"`), expanded by its config resolver at runtime. The rule
  asks for a template literal, which would break path resolution outright.

`assist/source/organizeImports` stays off, now with its reason written next to it: the imports are
grouped semantically (node builtins, then types, then local modules) and the action flattens each
file to one alphabetical list.

`biome check .` now reports **zero diagnostics**, so a new one is visible.

**Assumption:** the two genuine `correctness/noUnusedImports` hits were fixed rather than left
visible — `read` from `test/resolution.test.ts` and `write` from `test/slots.test.ts`, both
provably dead (every remaining occurrence of `read` in that file is inside a comment or a string
literal). Biome classifies the fix as unsafe and would not apply it, so the two lines were deleted
by hand. No assertion changed. Removing `write` shortened the `slots.test.ts` import list enough to
fit on one line, so the formatter then re-collapsed it; that reflow travels with the deletion, not
with the formatting commit.

**Assumption:** this makes **three** separable changes, not two, and they must land in this order —
`chore: add biome`, then `style: apply biome format` (whose SHA goes in `.git-blame-ignore-revs`),
then `chore: drop two unused test imports`. The deletion cannot ride in the formatting commit: that
commit is the one blame is configured to skip, and a real content change hidden inside it would
make its author unfindable.

### Stage 6 — second revision, `noNonNullAssertion` re-enabled

**Supersedes the `style/noNonNullAssertion` bullet in the revision above.** The rule is **on**, at
`warn` severity. Disabling it was the wrong call: most of the 49 remaining assertions can be
removed properly rather than asserted away, and switching the rule off would have papered over a
fixable problem and stopped future assertions from being flagged. `warn` is what keeps
`bun run lint` green while the call sites are fixed by a separate change; deleting the entry
restores the rule's default `error` severity once they are gone. The `noUncheckedIndexedAccess`
argument still explains why *some* of these are legitimate, but it does not justify silencing the
whole rule.

`biome check .` now reports **49 warnings, 0 errors**, all of them this one rule, which is a
to-do list rather than a permanently ignored wall.

**Open question:** `complexity/useLiteralKeys` (43 sites) is arguably the same class of decision
and is currently **off**. Its sites are bracket access on `Record<string, unknown>` at JSON
deserialization boundaries, and Biome marks its own fix unsafe, so the case for switching it off is
stronger than it was for `noNonNullAssertion` — but the reasoning that reversed that rule ("it can
be fixed properly, so do not paper over it") applies here too, and this was not explicitly decided.
Re-enabling it at `warn` is a one-line change if that is preferred.

## Stage 6 — non-null assertions

**Assumption:** 25 of the 49 `!` sites in `src/` were removed by restructuring so the value is
never `T | undefined` in the first place — `.entries()` where the loop already started at 0,
destructuring where a length test was standing in for a presence test, `?.[1]` where the only use
of a match object was one mandatory capture group. No site was "fixed" by adding an
`if (x === undefined)` branch no input can reach; that would trade an honest assertion for dead
code, which this effort has already treated as a defect elsewhere.

**Assumption:** the 24 that remain are the ones where restructuring would cost either correctness
clarity or measurable speed, and each now carries a `biome-ignore lint/style/noNonNullAssertion`
naming its reason: the per-byte stamp loop in `text.ts` (`.entries()` allocates a tuple per byte of
the corpus), the JSONC scanners in `config.ts` and the slot walks in `directives.ts` (cursors that
jump an escape pair, a comment run or a whole slot block, so no iterator expresses them), the
`frontmatter.ts` scan that starts at index 1 and goes on to slice by that index, and the LCS table
and dual-cursor walk in `diff.ts:markChanges`.

**Assumption:** `markChanges` is covered by a single `biome-ignore-start`/`biome-ignore-end` pair
rather than eight inline comments. Sixteen assertions in thirty lines are one decision about one
algorithm, and repeating the reason eight times reads worse than stating it once.

**Assumption:** a Biome suppression comment must be the line *immediately* above the diagnostic, so
a reason that needs two lines is written as a plain comment line followed by the `biome-ignore`
line. A two-line `biome-ignore` is silently inert — Biome reports the assertion *and* an unused
suppression, which is how this was caught.

**Assumption:** `cli.ts`'s `override` rejects three or more positional arguments through
`const [skill, slot, extra] = positional` plus `extra !== undefined`, not through a two-element
destructure, because `positional.length !== 2` rejected them too. `test/cli.test.ts:116` pins that
case.

**Open question:** the suppressions are correct while `style/noNonNullAssertion` is on (at `warn`
or at `error`). If the rule is ever switched off, all nine become `suppressions/unused`
diagnostics and would have to be deleted in the same change.

**Open question:** `test/` still holds 10 assertions, untouched here. Whether test code is held to
the same standard as `src/` was not decided.

## Doc-lag fix after the decline-gating change

**Assumption:** For the ADR amendment I replaced the false clause in place rather than narrowing
the amendment to a per-target *recording* claim plus a cross-reference. The amendment's whole
purpose is to argue that the per-target change did not weaken decision 4's guard, and that guard
is the stated mitigation for the ADR's principal accepted risk; an auditor reading the ADR alone
needs the honest position there, not a pointer to it. The cross-reference to the spec's
*`SessionStart` hook* section is kept as the source for enumerated behaviour.

**Assumption:** The replacement states the guard's job as correctness against ordinary staleness
and detectability, and says explicitly that no gating floor is a trust boundary against an actor
who can write the state directory. That matches the spec's "That floor is not the trust boundary
and is not sold as one", and is deliberately weaker than the sentence it replaces.

**Assumption:** The property the amendment now rests on is the spec's narrow one — a record
naming no path to go and look at gates nothing (a `failed` list, an empty per-target map). No
claim is made that a decline gates nothing; it does gate, and the ADR now says so.

**Assumption:** `docs/CONTEXT.md`'s **Stamp** entry took only the phrase swap the spec made
("verifies nothing" → "confirms nothing against the disk"), with the paragraph re-wrapped to the
file's line width. Its substance was already correct and was left alone.

**Open question:** Neither document restates the spec's worked example of the planted `SKILL.md`
recorded as `written` beyond one clause. If the ADR is ever read on its own as the security
account, that clause may want expanding — but duplicating the spec's reasoning is the drift this
fix exists to remove.

---

# Review findings NOT addressed — surfaced for the user

The skill caps the review-fix loop at two cycles. Everything below was found by the independent
review and deliberately left, with the reasoning. Full reports are in the session scratchpad
(`rev-*.md`, `rerev-*.md`) — they will not survive the session, so anything worth keeping should
be promoted from here.

## Worth doing next, in rough priority order

1. **`runBuild`'s per-skill crash catch is untested** (`src/build.ts`). Its only positive test was
   converted into a *negative* one by finding 16's fix: C8 reached the outer catch through the
   unguarded `rmSync` in `emitSkill`'s catch arm, and wrapping that call in `removeQuietly` closed
   the route. The test now asserts `not.toContain("skill failed unexpectedly")`. A still-reachable
   route was identified: `uniqueSuffix()` at `src/emit.ts:58`, outside `emitSkill`'s staging try —
   patch `crypto.randomBytes` to throw there and the outer catch fires with exit 0 and the other
   skill compiled. Needs a small `withCryptoFailure` sibling to `withFsFailures`.
2. **A throw in `acquireBuildLock`'s `uniqueSuffix()` (`src/lock.ts:35`) escapes `runBuild`
   entirely** rather than degrading to an unlocked build. That is a hole in the contract
   `src/cli.ts` states — "build always exits 0 so a session hook can never break a session".
3. **`--check` does not detect a hijacked compiled skill.** `outputsVerified` compares hashes and
   never consults ownership, so a skill whose directory was taken over by another build passes
   once any healthy skill exists in the corpus. Pre-existing and unrelated to the decline-gating
   change (verified by A/B against a revert); affects essentially every real corpus.
4. **`isPlainObject` is written six times across five modules** (`stamp`, `lock`, `ownership`,
   `settings`, `config`). The one piece of duplication the module split *introduced* rather than
   removed — `fsutil.ts` was created as the shared-primitives home in the same change and did not
   receive it.
5. **Stamp-record construction lives in `build.ts` while interpretation lives in `stamp.ts`.** The
   omit-vs-carry rule is satisfied in one file and relied on in another, and the two already
   disagree: a compile failure copies carried outcomes wholesale, an emit failure filters to
   `config.targets`. Inert today only because the reader filters too.
6. **The decline predicate is spelled twice** — `emit.ts` and `stamp.ts` share the `standingOf`
   primitive but not the policy built on it.
7. **`settings.ts` reads one JSON shape with two independent parsers** (`settingsStep` strict,
   `sessionStartCommands` tolerant) that must agree about what a SessionStart hook looks like.

## Smaller, still real

- `withFsFailures`'s `PATH_ARGUMENTS` arity map and `message` field have no consumer; `calls` is
  always a single-element array.
- `isHookGroup`'s predicate does not record the shape the adjacent cast asserts (`settings.ts`).
- `ContainmentFailure` is exhaustively *shaped* but not exhaustively *checked*.
- `attribute[1] as SlotMode` casts away `undefined` next to a line that already avoids it.
- `as NodeJS.ErrnoException` on a bare `unknown` throws if the thrown value is nullish.
- `resolveContainedFile` arguably belongs outside `directives.ts`; `isMissing` in `discover.ts` and
  `parseJsonc` in `config.ts` make the init side depend on build-side modules.
- `Math.min(holder.at, Date.now())` in `lock.ts` is a provable no-op whose comment claims it
  defends against a future clock; the real recovery is `directoryLooksStale`.
- `readStamp`'s bare-hash guard is redundant with the parse path below it.
- `Standing`'s `absent` and `owned` arms are never distinguished by any caller.
- Two upward `.git` walks.
- **Candidate finding 18** (recorded earlier in this file): a corrupt marker makes a directory
  permanently unprunable *and* silent on the prune path, so a skill deleted upstream stays in the
  target forever.

## Deliberately not done, with reasons

- **`complexity/useLiteralKeys` (43 sites) and `suspicious/noTemplateCurlyInString` (41)** stay
  disabled in `biome.jsonc`. The first is purely notational — bracket access at JSON boundaries,
  with Biome's own fix marked unsafe. The second would break path resolution outright: every hit
  is this tool's own `${home}` placeholder.
- **`noNonNullAssertion` stays enabled at `warn`** with 24 justified suppressions. Delete the
  entry once those are gone to restore the default `error`.

## Marker read hardening (FIFO / size)

**Assumption:** `stats.isFile()` replaces the `isSymbolicLink()` rejection outright rather than
sitting beside it. `isFile()` is false for a symlink, so nothing is lost, and it additionally
rejects FIFOs, sockets, devices and directories — the class the old check named only one member
of. A hardlink to a regular file still reports `isFile()`, so the one legitimate setup that could
plausibly be affected is not. A symlinked skill *directory* containing a real marker is refused a
level higher, by `standingOf`, and is unchanged by this.

**Assumption:** `MARKER_FILE_MAX` is derived, not chosen: `MARKER_FIELD_MAX * 4 * 6`. `readMarker`
accepts four fields, each at most `MARKER_FIELD_MAX` UTF-16 units, and JSON's widest spelling of
one unit is six bytes (`\uXXXX`). The bound therefore cannot reject a marker `readMarker` would
have accepted — only padding around one. The `tool` field's budget is a fixed 17-character literal
in practice, so its share also covers the structural bytes (braces, keys, commas).

**Assumption:** `O_NONBLOCK` was added to the open flags alongside `O_NOFOLLOW`. The `lstat` check
carries the ordinary path-based race, and for this defect that race's payload is a *hang* rather
than a wrong read; `O_NONBLOCK` makes `open` return immediately on a FIFO swapped in after the
`lstat`, and POSIX gives it no effect on the regular file this is meant to read. This goes beyond
what the brief asked for, and is justified only because an unbounded block is the failure mode the
whole change exists to remove.

**Assumption:** The read itself is bounded (`readSync` into a `stats.size + 1` buffer) rather than
`readFileSync` on the descriptor. The size check alone rejects on the size observed *before* the
open; a file that grows in that window would still be read whole. A short buffer yields truncated
JSON, which fails to parse, which is the same unmarked outcome.

**Assumption:** A rejected marker introduces no new diagnostic kind and no error. The directory
reads **unmarked** — the identical path a malformed marker already takes — so it is neither
overwritten nor pruned, and `emitSkill` emits the existing "was not written by this tool" warning
when the name collides with a published skill. Under a name the build does not publish,
`pruneTarget` skips it silently, exactly as it does for any other build's directory.

**Assumption:** The two FIFO tests run `build` in a **child process** under `Bun.spawnSync`'s
`timeout`, not through the in-process `build()` fixture. The regression they guard is an unbounded
block, which in-process would wedge the whole suite instead of failing one test. The spawn deadline
(8s) is deliberately shorter than the per-test timeout they are given (30s), so a regression fails
as a killed child with a signal to name rather than as the runner reaping a test it cannot explain.
`fs.mkfifoSync` does not exist in this runtime, so the FIFO is made with the coreutils `mkfifo`,
and a failure to create one fails the test loudly rather than passing hollow.

**Assumption:** The size test pads *this build's own, otherwise valid* marker with whitespace.
Every field parses and validates, so size is the only thing that can refuse the file — which is
what makes "not pruned" evidence that the file was never parsed. It mirrors the existing
unparseable-marker prune test rather than inventing a new shape.

**Open question:** `outputsVerified` gates a `written` outcome on the compiled file's content hash
and does not consult the marker, so a marker that becomes unreadable *after* a successful build is
not noticed until the inputs change. Observed while verifying by hand; pre-existing, unrelated to
this change, and not touched.
