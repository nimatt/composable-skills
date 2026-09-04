# Plan: Remediate the 16 findings from the code review

> **Revision 2.** Revision 1 was broken by a four-way adversarial review: it had two proven
> red-tree breaks, a runtime crash, an unsafe contract change, and 20 wrong citations out of
> 112. Every correction is folded in below and marked **[adv]** where it reverses revision 1.
> Do not resurrect revision 1's ordering from memory.

## Objective

A four-agent review found 15 issues; the adversarial review of revision 1 found a 16th. Three
cause silent wrong behaviour (a clobbered file, a permanently wedged `--check`, an override
that stops applying), and one — nothing being committed — means 9,500 lines exist in a single
unbacked copy. This plan sequences the repairs so the suite is green at every step.

## Background

`composable-skills` compiles templates into `SKILL.md`. It runs at `SessionStart` inside a
**fail-soft hook**: `build` exits 0 unconditionally (`tool-contract.md:504`) and its stdout
reaches a model, not a human. Hence the review's central observation: *the uncovered lines and
the silent lines are the same lines*.

Baseline: `bun test` 298 pass / 0 fail (~0.9s), `bun run typecheck` clean, 95.14% lines.

Two facts drive sequencing:

- **The suite is black-box.** Only four `src/` symbols are imported anywhere in `test/`.
  **[adv]** But this says nothing about the binding constraint, which is an *intra-`src/`*
  edge: `override.ts:7` imports `{ compileSkill, discoverSkills }` from `build.ts`. That edge,
  not the test imports, is what takes the suite down during extraction.
- **The spec's two lists have opposite closure.** `tool-contract.md:373` — the *Warned* list is
  "illustrative, **not the enumerated set**". ADR-0001:70 — the *Rejected* list "is the
  enumerated version and the one to trust." Both verified verbatim. **[adv]** But this licenses
  less than revision 1 claimed: none of the drafts below *add* to the Rejected list, so
  decision 7's delegation does not by itself authorise them, and a warning added *only* to an
  illustrative list is never normatively stated. Each draft must also fix the normative
  sentence that currently asserts the old behaviour.

### The 16th finding

**(16)** `src/build.ts:708` — `fs.rmSync(staging, …)` sits **unguarded inside `emitSkill`'s own
catch arm**, the only reachable unguarded fs call on the per-skill path. A throw there escapes
to `runBuild`'s per-skill catch and is reported as `skill failed unexpectedly`.

### Corrections to the findings themselves

- **(11) is narrower than reported, and is not exploitable. [adv]** A *dangling* symlink does
  **not** reach `swapIntoPlace`: `pathExists` is `lstatSync` so the link "exists", `isOwned` →
  `readMarker` → `readFileSync` gets ENOENT → `null`, so `emitSkill:681`'s unmarked branch warns
  and returns. The only reachable case is a symlink to a directory carrying a **valid marker
  whose `skill` field matches the link's basename**. Verified independently three times: no
  write or delete escapes the target.
- **(2) is not "the only irreversible finding". [adv]** For a *tracked* file `git checkout`
  restores it. It remains the highest-harm finding because `.claude/settings.json` is commonly
  untracked and the loss is silent, but do not repeat the stronger claim.
- **(6)'s line citations were wrong. [adv]** The four collapse points in `resolveContainedFile`
  are `realpathSync(root)` **:115**, the loop `lstatSync` **:125**, `realpathSync(current)`
  **:134**, and `statSync` **:142**. `:139` is a blank line. **:115** is the one producing
  `{kind:"root"}` that `build.ts:570` silently `continue`s — the actual subject of finding 6.

## Approach

Seven stages, **strictly serial**. **[adv]** Revision 1 declared stages parallel; that is unsafe
with one working tree, one branch, and no worktree isolation — Wave 0 commit 3 is the initial
import of the very files the "parallel" stages mutate, so `git add` would snapshot a
half-applied change.

### Stage 0 — Import the tree

Three commits. Nothing else may run until this finishes.

1. `chore: replace bun init scaffolding with package metadata`
   - `git rm index.ts`; add `LICENSE`, `.gitattributes`, `tsconfig.src.json`
   - `.gitignore`: `_.log` → `*.log`, `report.[0-9]_.…json` → `report.[0-9]*.…json` **(15)**
   - `package.json`: `typescript` from `peerDependencies` to `devDependencies` as `^5.9.3`
     **(3)**; add `repository`, `author`, `bugs`. **Leave `version` at `0.0.0` for now** — it is
     a stamp input (`layout.ts:33` → `build.ts:979`), so bump it once, at the end.
   - `bun.lock`
   - **[adv]** Stage the files by explicit path. `git add src/` would pick up the untracked
     zero-byte `src/.gitkeep`, which this plan says not to commit.
2. `docs: spec, ADR, plan, glossary and README` — `docs/`, `README.md`, and the two root files
   `REVIEW-FINDINGS.md` / `composable-agent-skills.md`, which ADR-0001 links via `../../`.
3. `feat: implement build, init and override verbs` — `src/` and `test/` together.

Release facts (verified empirically): `npm i -D` fails `ERESOLVE` against typescript@4.9.5
**and** @7.0.2 (current `latest`); a clean install pulls 23 MB for a 96 KB `dist/`; `npm pack`
currently picks up `LICENSE` only because it exists untracked on disk. Do not remove
`typescript` outright — `typecheck` needs it. Keep `prepack`, keep `files: ["dist"]`, do not add
`exports`.

### Stage 1 — The free type fix

**(13)** `build.ts:424`: `Partial<Diagnostic>` → `DiagnosticLocation`. Type-only.
**If `typecheck` fails, some caller is downgrading an error today** — that is a behaviour
finding; stop and reclassify.

### Stage 2 — Characterization tests. No `src/` change.

Fix the fixture first:

- `workspace.ts:17-21` — `created.pop()` runs before `rmSync`, and `rmSync(…, {force:true})`
  throws `EACCES` on a tree containing a mode-000 directory, so one throw fails `afterEach`
  **and abandons every remaining temp dir**. Record chmod'd paths in `chmod()` (`:64`), restore
  them to `0o700` before the loop, and wrap the loop so one failure does not abandon the rest.
- `workspace.ts:276` — `captured()` reads the capture file back inside the window where a test's
  `fs` patch is live. **[adv]** That window covers `openSync:223`, `writeSync:257`,
  `closeSync:270-271`, `existsSync/mkdtempSync:205,:12` — not just `readFileSync`.

**[adv] There is no existing "path-selective patch" pattern to copy.** `test/build.test.ts:717-757`
is a *blanket delegating recorder* (safe only because it never throws);
`test/build.test.ts:1444-1461` is *call-count-selective* (`if (renames === 2) throw`) and is the
**wrong** template, because stage 4 moves `swapIntoPlace`, stage 5 restructures its branches, and
stage 5 changes `uniqueSuffix()` and hence the parked directory's name. New tests must key on
**path**, and the helper has to be written.

Write every test through `runBuild` via the fixture. **Do not export `emitSkill`/`pruneTarget`/
`acquireBuildLock` to test them** — finding 4 changes `emitSkill`'s signature, so such a test
would guard nothing.

| id | what | on unmodified `src/` |
|---|---|---|
| C1 | no-`id` prunes own output; no-`id` does **not** prune another checkout (`tool-contract.md:431-433`). Needs a new `config:` block — all 9 existing ones and `DEFAULT_CONFIG` (`workspace.ts:82`) set `id: "acme"`. Covers `build.ts:838`, the zero-coverage line gating the only destructive operation. | passes |
| C2 | back-dated `tmp-*` removed; fresh `tmp-*` kept; **young `old-*` kept** | **[adv]** the third case **passes** if written naively — a freshly `mkdir`'d `old-*` has `mtime = now`. It must be built by **renaming an older directory into place**, which is what `swapIntoPlace:719` does and what `rename(2)` preserving mtime means. Only then does it fail, and only then is it finding 10's proof. |
| C3 | unparseable `.composable-skills-owner` reads as unmarked | passes |
| C4 | `mkdir` failing non-`EEXIST` → `unavailable`; release-by-token must not remove a new holder's lock (`build.ts:904`) | passes |
| C5 | `emitSkill`'s three outcomes; declined → stamp records `null` | passes — **[adv]** and therefore proves nothing on its own. Add the **two-run** assertion: with a hand-written `.claude/skills/hand/SKILL.md`, the second run's diagnostics must carry the `[last build]` prefix (`asReplayed:375`). That assertion **fails today** and is finding 4's real proof. |
| C6 | none — `test/build.test.ts:589-696` already covers four forged stamp shapes. Re-run after every move; they are the split's canary. | — |
| C7 | `computeStamp` determinism with an unreadable input | passes. **[adv]** Do **not** `import { computeStamp }` — stage 4 moves it to `stamp.ts`, which would manufacture a second extraction-broken import. Assert through the stamp file's `stamp` field instead. |
| C8 | per-skill crash containment (`build.ts:167-174`) | **[adv]** needs a **two-site** patch: every fs call on that path is guarded except `rmSync` at `build.ts:708` (finding 16), so make `writeFileSync` throw for skill A's staging file **and** `rmSync` throw for its staging dir. |
| C-contain | table test recording today's answers for all four containment predicates at `root`, `root/..foo`, `root/sub`, `root/../sibling` | passes |

**Test pattern for every I/O finding: a pair** — one `skipIf(asRoot)` test using a real `chmod`,
plus one always-running path-selective patch test. `test/build.test.ts:307`'s `hasError` sits
inside the `skipIf(asRoot)` at `:292`, so the suite is not red under root; it silently loses that
test.

### Stage 3 — Containment

**These are not four copies of one predicate** — they are two predicates with opposite
specifications. `config.ts:269` needs self-is-contained or `overrides: ["${home}"]` rejects
itself; `directives.ts:138` and `init.ts:204` are security boundaries needing the opposite.

New `src/contain.ts` (leaf, `node:path` only) exporting `isUnder` and `isAtOrUnder` over
`init.ts:229`'s segment-split core. Re-point all three `isInsideRepo` call sites (`init.ts:204` write boundary, `:375` inside `firstSymlinkComponent`, `:489` in `gitignoreStep`) and `directives.ts:138` → `isUnder`;
`config.ts:269` and `override.ts:122` → `isAtOrUnder`. Delete all four local copies;
`directives.ts` stops exporting `isContained` (nothing in `test/` imports it).

It does **not** live in `directives.ts`: that file is the directive parser, already recorded as
overloaded at `docs/plans/composable-skills-tooling.md:135-145`, and it would make `init.ts` —
the *write* boundary — depend on the parser for its safety check.

Expected change: `directives.ts:176`'s `!relative.startsWith("..")` currently refuses a
contained file named `..foo`. An over-strict false refusal, not an escape; ADR decision 7's list
has no such entry, so removing it is conformance.

### Stage 4 — The cut. One module per commit, suite green after each.

**[adv] Every re-point is folded into the commit that breaks it.** Revision 1 scheduled the
`override.ts` re-point three steps late; reproduced result was `16 pass / 10 fail` with **272 of
298 tests never executed** (they die at module load via `workspace.ts:7`'s `runOverride` import) —
a failure invisible in the summary line.

Verified acyclic: `fsutil → discover → ownership → compile → lock → stamp → emit`.

| # | module | contents |
|---|---|---|
| 1 | `src/fsutil.ts` | `pathExists:968`, `removeQuietly:771`, `uniqueSuffix:964`. Strict leaf. |
| 2 | `src/discover.ts` | `discoverSkills:241`, `Discovery:230`, `looksLikeSkill:379`, `probeFile:398`, `isMissing:406`, `Probe`, `FileProbe`. **Re-point `override.ts:7`'s `discoverSkills` in this same commit.** |
| 3 | `src/ownership.ts` | `OwnerRecord:779`, `markerContent:785`, `readMarker:795`, `isOwned:826`, `ownedByThisBuild:834` |
| 4 | `src/compile.ts` | `compileSkill:419`, `CompileResult:411`, `resolveSlot:547`, `ResolvedSlot:536`, `overrideContainmentMessage:613`, **`collectExtras:627`**. **Re-point `override.ts:7`'s `compileSkill` in this same commit**, completing the line. Hoist `OUTPUT_FILENAME:49` / `OWNED_OUTPUT_NAMES:50` into `layout.ts`; while there, `looksLikeSkill:383` hardcodes `"SKILL.md"` instead of the constant. |
| 5 | `src/lock.ts` | `:841-962` **plus `LOCK_DIRNAME:52`, `LOCK_INFO_FILENAME:53`, `LOCK_STALE_MS:55`** |
| 6 | `src/stamp.ts` | `computeStamp:977`, `StampRecord:1055`, `readStamp:1072`, `writeStamp:1119`, `stampPath:1068`, `hashContent:321`, `outputsVerified:334`, `readOutput:355`, `previouslyCompiled:364`, `asReplayed:373`, `listEntries:1016`, **`ListedEntry:1010`**, `updateWithFile:1039`, `readOutputHashes:1102`, `isDiagnostic:1112` |
| 7 | `src/emit.ts` | `emitSkill:667`, `swapIntoPlace:713`, `pruneTarget:729`, `isStaleScratch:763`, **`STALE_SCRATCH_MS:57`**, `TMP_PREFIX`, `OLD_PREFIX` |

`build.ts` retains `runBuild` + `BuildOptions`.

`compileSkill` calls `collectExtras` at `:523` — a second seam crossing. It resolves by
classification: `collectExtras` produces part of `CompiledSkill` and enforces ADR decision 7's
"a source skill directory supplying one of the files the compiler writes itself" rejection at
`:644-652`. A rejection is a compile-time concern.

#### The `init.ts` cut — **[adv] re-designed; revision 1's range crashed at runtime**

Revision 1 specified `settings.ts` as `init.ts:532-818`. That produces
`ReferenceError: Cannot access 'CLI_REL' before initialization` — `INSTALLED_TAIL:684` is inside
the range and reads `CLI_REL:36`, outside it, so the two modules import each other and
`settings.ts` evaluates while `init.ts`'s bindings are in the temporal dead zone. `tsc` accepts
cycles; only running the code shows it. Revision 1 also stranded `readIfPresent:820` /
`fileExists:828` and ignored `firstSymlinkComponent:374` / `symlinkRefusal:319`.

Corrected cut — two shared modules, no cycle:

| # | module | contents |
|---|---|---|
| 8 | `src/textfile.ts` | `readIfPresent:820`, `fileExists:828`, `dominantEol:809`, `applyEol:816`. Shared: `readIfPresent` is called from `gitignoreStep:483` (stays), `settingsStep:545` and `warnAboutMergedSettings:731` (move); `dominantEol` from `gitignoreStep:511` (stays) and `settingsStep:563` (moves). **This is where finding 2's three-state rewrite lands.** |
| 9 | `src/steps.ts` | `InitStep`, `applyStep:203`, `refuseSymlinkedPath:306`, `refuseUnwritablePath:346`, `symlinkRefusal:319`, `firstSymlinkComponent:374`, `isWritable:360`, `isSamePath:239`, `fileMode:273`. Shared: `symlinkRefusal`/`firstSymlinkComponent` are called at `:205`/`:308-310` (stay) **and** `settingsStep:540-541` (moves). |
| 10 | `src/settings.ts` | `CLI_REL:36`, `HOOK_COMMAND:18`, `SETTINGS_REL:21`, `LOCAL_SETTINGS_REL:29`, `INSTALLED_TAIL:684`, `settingsStep:532`, `hookGroup:770`, `isHookGroup:774`, `invokesThisTool:665`, `tokenise:687`, `warnAboutMergedSettings:722`, `sessionStartCommands:745`, `parsesAsJsonc:784`, `isPlainObject:780`, `stringifyLike:798`. **`CLI_REL` moves with it**; `postinstallNote:407` (staying in `init.ts`) imports it back — one direction only. |
| 11 | `src/diff.ts` | `unifiedDiff:883`, `MAX_DIFF_LINES:876`, `elision:916`, `windowedDiff:926`, `capped:955`, `splitKeepingShape:963`, `MarkedLine:970`, `markChanges:975` |

`init.ts` retains `runInit`, `planInit`, `configStep`, `gitignoreStep`, `ignoreKey`, `deriveId`,
`configTemplate`, `postinstallNote`, `renderPlan`, `findGitRoot`, `findPnpFile`.

**[adv]** `test/init.test.ts:5` imports `HOOK_COMMAND, deriveId, invokesThisTool, unifiedDiff`.
That one line becomes **three** imports across `settings.ts`, `init.ts` and `diff.ts` — revision 1
called it "the suite's only extraction-broken import", which was wrong twice over.

Constraint on the whole cut: **static imports only** (ADR decision 4), and nothing may move
`layout.ts:33 toolVersion()`, whose `import.meta.url` resolution is deliberately correct in both
the `src/` and bundled `dist/` layouts. `bun build` bundles one entry, so new modules are free.

### Stage 5 — Behaviour

**Docs first, in one commit.** **[adv]** Each draft must also fix the *normative* sentence that
currently asserts the old behaviour — a line added only to the illustrative Warned list is never
normatively stated.

- **A** (`:273`) — extend the `init` refusal to "exists but cannot be read", stating existence is
  decided by `lstat`, never by a successful read. **[adv] Scope it to the three files `init`
  writes.** `:247-249` *requires* `init` to **read** `.claude/settings.local.json` and the
  user-level settings file; an unscoped clause turns those mandated reads into refusals.
- **B** (`:425`) — a target entry that is a **symlink** is never rewritten and its marker is not
  read through it; the build warns and moves on.
- **C** (`:494-495`) — **[adv] re-drafted; revision 1's version was unsafe.** See below.
- **D** (`:227`) — a declined skill is not stale output; `--check` exits 0 unless something else
  failed.
- **E** (`:382`) — "an override file, **or an override root**, that exists but cannot be read".
  **[adv]** Also amend `:192-193`, which currently states only that a root that *does not exist*
  is not an error.
- **F** (`:386`) — a target directory that exists but could not be enumerated. **[adv]** Also
  amend `:435-442`, the normative pruning passage.
- **G** (`:391-393`) — add "and decline, with a warning, when something already in a target is
  not this tool's to replace", so B and C read as instances of a stated rule.
- **ADR-0001** — **[adv] revision 1's "no amendment needed" reasoning does not hold.** Decision
  7 delegates only the *Rejected* list, and none of A–G add to it. More importantly, finding 4
  changes *what decision 4's stamp guard verifies*, and ADR Consequences `:93-100` names that
  guard as the entire mitigation for a knowingly-accepted security cost. Add a short amendment
  recording that the guard now verifies per-target outcomes and why that is at least as strong.

- **README.md:210-226 and `docs/CONTEXT.md:103-109`** -- **[adv] in no stage of revision 1.** README's warned list ends "a directory the build declined to overwrite because nothing marked it as this tool's" and must gain the symlink case from finding 11. The glossary's **Stamp** entry defines the record as "a hash of each `SKILL.md` emitted" gating "only if the recorded output is also still in place and unchanged" -- finding 4 replaces that with per-target outcomes including declines, so the definition becomes false and must be rewritten with it.

Then the code:

1. **(6)** `compile.ts` — unreadable override root/file warns instead of silent fall-through.
   **The `unreadable` kind must take the `continue` branch, not `return fromDefault()`** —
   `continue` is additive; `fromDefault()` would abandon every lower-precedence root and silently
   change compiled output for layered chains. Fix all four collapse points (**:115, :125, :134,
   :142**); `:115` is the one finding 6 is actually about. The split also reaches
   `resolveIncludePath:169-177`, where it is a **message-quality** bug only — fix the wording,
   do not change control flow. Severity **warning** (`:382`).
2. **(11) + (4) together, in one commit. [adv]** Revision 1 shipped them separately; between the
   two commits a symlinked target entry becomes a decline, `outputs[name]` goes `null`,
   `outputsVerified` compares against the symlink's content, never gates, and the build prints a
   new warning **and fully recompiles at every session start** — exactly what the noise
   constraint below forbids, and `!isMissing` does not help because a symlink is not ENOENT.
   - **(11)**: `emitSkill` lstats the destination and treats a symlink like an unmarked
     directory — never reading a marker through it. The message must say **symlink** explicitly
     (invariant 8 forbids following one *silently*). Drop the dead `|| entry.isSymbolicLink()`
     at `pruneTarget:751` and restructure so the symlink branch is visibly first, as
     `discoverSkills:257` already does.
   - **(4)**: `emitSkill` returns `"written" | "declined" | "failed"`, and **the stamp records a
     per-target outcome per skill**, replacing the single OR-folded hash at `build.ts:161-165`.
     **[adv] This is the chosen design and it is the only safe one:** with one state per skill,
     *written in target A, declined in target B* is unrepresentable, and recording it as
     declined strips integrity checking from the real compiled skill — reachable by anyone who
     can `mkdir` in the spec-blessed shared `~/.claude/skills`.
     The decline re-check is **"a non-owned entry still exists at that path"**, *not* "still
     unmarked" — **[adv]** a deleted directory also reads as unmarked, and `:491` promises that
     deleting a compiled skill by hand rebuilds it. Declined targets count toward nothing
     verified, preserving `:496-499` ("a record that verifies nothing gates nothing").
     The stamp shape changes, so bump the stamp version and treat an old-format stamp as stale —
     one forced rebuild, which is safe.
   - Proof: C5's two-run assertion.
3. **(7)** `pruneTarget` warns on non-ENOENT, silent on ENOENT, reusing `discover.ts`'s
   `isMissing` — **do not write a fifth copy**. Purely additive. **[adv]** The sibling arms it
   shares vocabulary with (`build.ts:250-252, 277-284, 289-296`) are inside `discoverSkills` and
   therefore live in `discover.ts` after stage 4, so this "one group" spans two modules — fix
   both, and note the warning will arrive stacked on N per-skill errors when a target is
   unreadable, since both fail from the same cause.
4. **(16)** wrap `build.ts:708`'s `rmSync` in `removeQuietly`.
5. **(2)** `textfile.ts` + `init.ts` — three-state `readIfPresent`; `refuseUnwritablePath` must
   stop using `before === null` as a proxy for "does not exist". **Existence by `lstat`, never
   by a successful read**, or the refusal at `:271` stays unreachable however it is worded.
   Callers: `gitignoreStep:483`, `settingsStep:545`, and `warnAboutMergedSettings:731`, which
   needs a *different* new warning ("cannot read; cannot check whether a hook there would build
   twice"), not a refusal. Also fixes `:228` ("prints exactly what it would do"), currently
   false because the dry run says `created` for a file that exists.
6. **(5)** `config.ts` — `ConfigFailure` gains `diagnostics: Diagnostic[]`; update the six
   `return { fatal }` points (`:299, 305, 308, 323, 328, 339`) and **three** consumers
   (`build.ts:70-88`, `init.ts:81-92`, `override.ts:22-26`). **[adv]** `report.ts` imports only
   `findConfigFile`/`findRepoRoot` and is *not* a consumer — revision 1 said four.
7. **(10)** `emit.ts` — scratch liveness off mtime. `rename(2)` preserves mtime *and*
   `birthtimeMs`, so the timestamp goes in the directory **name** via `uniqueSuffix()`.
   **Migration: a name carrying no timestamp falls back to mtime**, or every parked directory
   written by the current version becomes immortal garbage in every shared `~/.claude/skills`.

**Diagnostic-noise constraint.** Diagnostics are stored (`build.ts:205`) and replayed on gated
runs (`:121`), so a new warning appears at **every session start** until the input changes. Each
must be conditioned tightly on `!isMissing(cause)`, preserving `:400` — "a warm repo stays
silent, which is what makes it mean something when it appears."

### Stage 6 — Version, CI, tooling

- Bump `version` to `0.1.0` **once, here** — it is a stamp input, so every bump forces a full
  recompile for every consumer.
- **CI, two jobs.** `check`: Bun only (the suite imports `bun:test` and `../../src/build.ts` with
  a `.ts` extension), `ubuntu-latest`, on `push` to `main` and `pull_request`. `smoke`: matrix
  `node: [20, 22, 24]`, `bun run build` then `node dist/cli.js --version` / `--help` — the only
  thing converting `engines: ">=20"` into a checked fact. **Never use `container:`** — it runs as
  root and silently skips `test/build.test.ts:292`. Comment that in the workflow. No remote
  exists yet, so the file is inert until one does.
- **Lint/format last, two commits**: `chore: add biome` (config + devDep + scripts + CI step,
  zero content changes), then `style: apply biome format`, whose SHA goes into
  `.git-blame-ignore-revs`. If the reformat is huge, the config is wrong, not the code.

### Rejected alternatives

- **Unify the four containment predicates into one.** `config.ts:269` needs the opposite answer
  from the two security boundaries.
- **Export `emitSkill`/`pruneTarget`/`acquireBuildLock` for unit tests.** Would pin the very
  signature finding 4 must change.
- **Revision 1's parallel stages.** One working tree; stage 0 commit 3 imports the files the
  "parallel" stages mutate.
- **Revision 1's `settings.ts` range (`init.ts:532-818`).** Proven runtime `ReferenceError`.
- **Landing (11) and (4) in separate commits.** Proven regression window.
- **Revision 1's draft C (one decline state per skill).** Unrepresentable mixed case; strips
  integrity checking from a real compiled skill; `mkdir`-reachable.
- **A reconstructed multi-commit history for the import.** One author, no reviewer, no remote.
- **Removing `typescript` entirely.** `typecheck` needs it.
- **Adding `exports`.** Both invocation paths in `:468` are filesystem paths.

## Open questions

1. **Is a shared `~/.claude/skills` across concurrent builds real here?** `:430` blesses it and
   it is the only route by which finding 10 causes real loss. If not, 10 could be deferred.
2. **Node floor.** `engines: ">=20"` has never been executed; stage 6's smoke matrix settles it,
   or narrow to `">=22"`. Widening later is non-breaking; narrowing is not.
3. **Invariant 9** (`:536`) — "every diagnostic names a file, and a line that exists in that
   file". Finding 5's per-key config error names the file with no line, as every existing config
   diagnostic already does. Scope the invariant to template-derived diagnostics, or accept a
   technically non-conforming one. Non-blocking.
4. ~~Is finding 11 exploitable?~~ **Answered: no.** No write or delete escapes the target.

## Out of scope

- The `lint` (phase 4) and `explain` (phase 5) verbs. Stage 4 makes them cheaper; it does not
  build them.
- Any change to the composition design. ADR-0001's decisions 1, 2, 3, 5, 6 stand; only the
  decision-4 stamp-guard note is amended.
- Streaming `computeStamp`'s hash input or stat-caching the tree walk.
- `report.ts`'s crash-log path (85% coverage, lowest in `src/`). No reviewer examined it.
- Adopting TypeScript 7; the fix pins `^5` deliberately.
- A publish/release workflow.
- `report.ts:29-30`'s `fstat`→`isTTY` fallback, deliberately unreachable because
  `workspace.ts:248-251` pins `isTTY` false to keep stdout assertions deterministic.

## See Also

- [`docs/specs/tool-contract.md`](../specs/tool-contract.md)
- [`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md)
- [`docs/CONTEXT.md`](../CONTEXT.md) — normative. Use **marker**, **stamp** (never "cache"),
  **compiled skill** (never "output"), **template source** (never "skill source"), **target**,
  and distinguish **override file** from **override root**.
- [`docs/plans/composable-skills-tooling.md`](./composable-skills-tooling.md)
