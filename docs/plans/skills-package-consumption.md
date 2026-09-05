# Plan: make a skills package installable

> **Revision 3.** Revision 1 proposed four changes; a three-way adversarial review cut two and
> found a security defect in a third, and a design interview then settled nine open branches. The
> shape that survives: **two changes and a warning**, in one commit. What the review killed, so
> nobody resurrects it: stamp exclusions for `sources: ["."]` (does not work — `.git` and
> `node_modules` stay in the walk, demonstrated twice by implementation) and anything touching the
> hook string or `init`'s missing-CLI warning (a measured decision and an argued one). What the
> interview changed: the severity rule is symmetric rather than package-only, it reaches into
> discovery, containment is reused rather than rewritten, the `node_modules` walk excludes node's
> global fallbacks, and every failure gets its own message.

## Objective

Make the three-repo shape work in the layouts teams actually have: a **skills repo** publishes
its templates as an npm package, a **project repo** installs that package and compiles its
skills. Two code changes and one doc correction. No new verb, no new configuration key, nothing
added to the template language.

## Background

Verified on 2026-09-04 against HEAD `4cd25cf`, in sandbox repos under `/tmp`, across four install
layouts: flat `node_modules`, pnpm-symlinked, a workspace child with the dependency hoisted to
the monorepo root, and a subpath spec in each. Baseline: `bun test` 397 pass / 0 fail,
`bun run typecheck` clean — both re-verified by the auditor.

### What already works, and must keep working

A package named in `sources` resolves and compiles; `references/` is copied beside the emitted
`SKILL.md`; a pnpm-symlinked package root is read (source roots are exempt from the symlink-root
rejection, `tool-contract.md:203`); a repo-local `./skills/templates` listed after the package
shadows a packaged skill by name; a team-tracked `./.claude/skills-local/<skill>/<slot>.md` fills
a packaged skill's slot; `override` seeds from the winning root; pruning leaves another repo's
skills alone.

### Defect A — a package `sources` entry is resolved as a module, not as a directory

`resolvePackageRoot` (`config.ts:253`) asks node to resolve `<spec>/package.json`, and falls back
to `<repoRoot>/node_modules` only (`config.ts:263`). Two consequences, and revision 1 stated both
too broadly:

- An `exports` map that does not list `"./package.json"` breaks **the hoisted layout only**. A
  flat install and a pnpm symlink both survive it, because the fallback's `isFile` check follows
  the symlink and finds the package where it is. Reproduced: flat + `exports` → `1 skill → 1
  target`; pnpm symlink + `exports` → `1 skill → 1 target`; workspace child with the dependency
  hoisted + `exports` → `could not be resolved as a package — skipped`. Node's own resolver
  already walks the `node_modules` chain upward, so "walking upward" was never the missing
  behaviour — hoisting is only why the one-directory fallback cannot paper over `exports`.
- A **subpath** entry — `"@acme/skills/templates"`, the natural layout for a skills repo that
  keeps templates in a subdirectory — fails in **every** layout, including a flat install with no
  `exports` map at all, unless that directory carries a `package.json` of its own. Different
  mechanism, same symptom.

The fix is one idea: stop asking node for a module and ask the filesystem for a directory.

### Defect B — nothing that fails to resolve reaches an exit code

Every resolution failure is a warning (`config.ts:288`, `:303`, `:394`), and `--check` fails only
on `severity === "error"` (`build.ts:93`, promised at `tool-contract.md:232`). Diagnostics do
reach stdout by design so the agent can report them (`tool-contract.md:430`) — the gap is the
exit code, not visibility. Full transcript for the hoisted-`exports` repo:

```
warning source "@acme/skills" could not be resolved as a package — skipped
warning no usable source roots — no skills to compile
warning a configured source root could not be read in full — nothing was pruned this run
0 skills → 1 target                                   build exit=0
compiled output is up to date                         check exit=0
```

And for the likelier cause — one typo in the source entry `init` itself scaffolds
(`init.ts:32`) — the same ending:

```
"sources": ["./skils/templates"]
warning source root "./skils/templates" does not exist at … — skipped
warning no usable source roots — no skills to compile
0 skills → 1 target                                   build exit=0
compiled output is up to date                         check exit=0
```

A repo with **no compiled skills at all** reports success on the one channel built for a human
and for CI. Revision 1 proposed promoting the *package* case only, which leaves the typo case —
the likelier one, and the shape `init` scaffolds — fully reproducible.

### Not defects, and not to be "fixed" — recorded so this is not re-proposed

- **`"sources": ["."]` never gating** is real but unfixable at proportionate cost.
  `listEntries` (`stamp.ts:180`) has no exclusions, so excluding the state directory and the
  target roots still leaves `.git/` and `node_modules/` inside a repo-root source. Both reviewers
  implemented the exclusion and measured it: `check` returns 0 immediately after a build, then
  returns 1 after a bare `git status`, an empty commit, or any write under `node_modules`. It
  also gives up real coverage — after excluding a target inside a source root, deleting an
  emitted `references/` file or the ownership marker no longer registers, and a missing marker
  makes the next build decline the directory as unowned (`emit.ts:49`, `emit.ts:153`) with
  `--check` green throughout. `outputsVerified` (`stamp.ts:40`) re-reads one file per skill per
  target — the `SKILL.md` — and covers nothing else. **The answer is a documented constraint, not
  code: a source root must not contain a target or the state directory.** Once change 1 lands, a
  `templates/` subdirectory costs nothing, which is what makes this cheap to say.
- **The hook string.** The roadmap already measured it: `npx --no-install` ~378 ms against
  ~28 ms for the literal path (`composable-skills-tooling.md:177`), and the auditor re-measured
  ~350 ms of overhead independently. Worse, `npx --no` on a missing binary makes a live registry
  request before failing (`npm error 404 … registry.npmjs.org`), so a `SessionStart` hook would
  block on a slow or offline network. The urgency revision 1 claimed — Codex trust-hashing — is
  void: the Codex hook was deferred by decision and does not exist.
- **`init`'s missing-CLI warning.** Promoting it to a refusal contradicts an argued decision:
  *"unlike PnP this is a state that ends by itself, and it changes nothing about the command
  string"* (`init.ts:135-139`, `tool-contract.md:269-274`).
- **A correction carried from revision 1's background.** The literal hook path is *not* dead
  under pnpm generally: pnpm symlinks direct dependencies into `node_modules/<name>`, and
  `node node_modules/composable-skills/dist/cli.js --version` works through that symlink. It is
  dead only when the tool is a transitive-only dependency of the skills pack, or when the project
  directory is a workspace child and the tool is hoisted above it. Both end by installing the
  tool in the repo the session opens — which the README should say.

## Approach

### 1 — Resolve a package `sources` entry by directory, not as a module

In `resolvePackageRoot` (`config.ts:253`):

- Split the spec into a package name (two segments when scoped, one otherwise) and a subpath.
- **Walk the `node_modules` chain directly**: from the repo root upward to the filesystem root,
  testing `<dir>/node_modules/<name>/package.json` at each level, first hit wins. Node's own
  `require.resolve.paths()` returns that chain *plus* `~/.node_modules`, `~/.node_libraries` and
  `/usr/lib/node`, and those are deliberately not honoured — a globally installed pack must not
  become a source of skills, which is the same stance the tool takes on installing itself
  (`README.md`, "there is no global-install path"). Walking the chain by hand rather than
  filtering node's list makes that structural rather than a policy to maintain.
- Never consult `main` or `exports`. A templates-only package has no entry point, which is why
  module resolution was the wrong instrument from the start.
- Where the spec names a subpath, resolve it with **`resolveContainedFile`**
  (`directives.ts:114`) — the discipline the compiler already applies to `include:`: realpath the
  package root, `lstat` every component with any symlink hop refused, assert `isUnder`, and
  accept only the right kind of node. It needs one addition, an `expect: "file" | "directory"`
  option defaulting to `file`, so include resolution is untouched. `rejectSymlinkedRoot` stays
  **off**, since a symlinked package root is ordinary under pnpm (`tool-contract.md:203`).
- Return null unless the result is an existing directory, so a mistyped subpath stays a
  resolution failure rather than becoming a path that does not exist.

Reusing `resolveContainedFile` is stricter than revision 1's "realpath both ends", which would
have allowed a symlink that stays inside the package; invariant 8 says no symlink is followed at
all bar the one exemption, and this keeps a single containment discipline in the codebase rather
than a second one that is nearly the same.

**Why this matters beyond layouts.** Revision 1 said only "assert containment", which in this
codebase means the lexical `isAtOrUnder` (`contain.ts:31`) — and that is dead code here, because
`isPackageSpec` (`config.ts:249`) already rejects every `.` and `..` segment. The review shipped
the exploit: a package carrying `templates -> /elsewhere` (npm tarballs do carry symlinks), named
as `"sources": ["@acme/skills/templates"]`, compiled a skill from outside the package and outside
the repo, with no diagnostic and with `allowed-tools: Bash(*)` in its frontmatter. Frontmatter is
emitted byte-identical, so this is invariant 1's rationale reached through invariant 8, whose
single exemption is *a source root's own last component* — not any directory a subpath names
inside a package.

The walk can find a package *above* the repo root; that is what makes a workspace child work. It
is a read, not a write, so invariant 7 is untouched, and the containment assert governs the
subpath inside the package rather than where the package sits.

**Diagnostics, one per failure kind**, copying the switch `resolveIncludePath`
(`directives.ts:186-208`) already uses: no package of that name in any `node_modules` from the
repo root upward (is it installed?); the package resolved but has no such directory; the subpath
traverses a symlink and is refused; the path exists but is not a directory. An error is recorded
in the stamp and replayed under `[last build]` every session until it is fixed, so a vague one is
a vague thing repeated forever — and the refusal case in particular must read as a refusal, not
as a miss.

*Tests* (black-box through `build`, asserting the diagnostic text as well as the output, since a
boundary test that asserts only absence is how `:292` came to pass for the wrong reason): flat
install; pnpm-symlinked package root; hoisted parent; subpath with no stub `package.json`;
**subpath crossing a symlink out of the package refused**; a non-package directory in
`node_modules` walked past rather than accepted (pinning `:292`'s intent, which today holds only
because its fixture has no ancestor `node_modules`); and the rewritten `:224` below. No new
fixture capability is needed — `ws.root` is the parent of `ws.repo`, and `symlink()` already
exists (`test/fixtures/workspace.ts:88`).

### 2 — A source the tool cannot use is an error

Symmetric, package or path, and it reaches wherever that failure surfaces:

- `config.ts:288` (a package spec that resolves to nothing) and `config.ts:303` (a path root that
  does not exist) become errors.
- `discover.ts:30` (a root that resolved but cannot be read) becomes an error too. Leaving it out
  would put a hole in the shape of the rule: a pack whose directory is unreadable would be silent
  where a pack that is absent is loud, and both mean the same thing to the model. The pruning
  suppression it already sets stays exactly as it is.
- The aggregate `no usable source roots — no skills to compile` (`config.ts:394`) **stays a
  warning**: every unusable entry now errors on its own, so the aggregate is a summary of
  consequence rather than the thing carrying the exit code, and it still has to cover a config
  that declares no sources at all — the inert default, which is not a mistake.
- A root that resolves, reads, and holds no skills stays **silent**. An empty corpus is a
  legitimate steady state, and erroring on it would make the fresh-repo case permanently red.

The rule a consuming team holds in their head is one line: *a source you named that the tool
cannot use fails `--check`*. It closes the full-loss case, the typo case, and the partial-loss
case — that last one being invisible today: with `sources: ["@acme/skills", "./skills/templates"]`
and the pack absent, the repo compiles its own skills, warns twice, and `--check` exits 0 while
the pack's entire corpus is missing (reproduced).

This stays inside the organising principle at `tool-contract.md:414`. `build` still exits 0
unconditionally — nothing here touches the fail-soft hook — and *"a developer's typo never breaks
a build"* still holds. What changes is that a repo which lost skills it asked for stops reporting
success from the one channel a human or a CI job reads.

Consequences to state rather than discover:

- A repo freshly `init`ed goes red on `--check` until its first template exists, because `init`
  scaffolds `"sources": ["./skills/templates"]` (`init.ts:32`) into a repo where that directory
  does not exist. That is correct — the config names something that is not there — and it ends
  the moment a template is added or `sources` points at a pack. `init` is deliberately **not**
  changed to paper over it: scaffolding a `.gitkeep` presumes a layout on behalf of a repo that
  may be about to name a package, and commenting `sources` out trades the red for a new silent
  hole.
- A production install (`--omit=dev`) has no pack, so the `postinstall` line `init` prints
  (`init.ts:245`) reports an error. It stays fail-soft (`|| true`) and breaks no image build. The
  answer is a documented constraint, not a config key: **a named source is a hard dependency of
  the build**, so a repo that installs without devDependencies must not name one, and `--check`
  belongs in a dev install. Scoping the error more narrowly — to a failed *package* spec that
  empties the corpus — was considered and rejected: it errors in the production case anyway, and
  it hands back the typo and partial-loss cases.

*Spec:* the two entry bullets at `tool-contract.md:395` move out of *Warned*; *"no usable source
root at all"* stays. `:383-385` names "a missing source root" as an example of an entry-level
warning-or-error and needs updating to say error. There is no table to add a row to — `:414` is
prose — and the mechanism already exists at `:232`: *"`--check` … exits non-zero … if this run's
own config produced an error."*

*Tests:* rewrite `test/config.test.ts:220` — *"one that cannot be resolved **warns** …"* — which
stays green under this change while its title becomes false, because `hasWarning` is satisfied by
unrelated diagnostics and nothing asserts the absence of an error. Add `--check` exit codes: 1 for
an unresolvable package source, 1 for a mistyped path source, 1 for an unreadable root, 1 for a
partial failure alongside a working source, 0 for a config declaring no sources, 0 for a source
root that resolves and is empty.

### 3 — Warn when a source root contains a target or the state directory

This is what replaces the cut change 3. `loadConfig` resolves all three lists before returning,
`steps.ts:62` has a realpath equality helper and `contain.ts:31` the containment test, so the
check is: for each resolved source root, if the state directory or any target root is at or under
it, warn once, naming both and saying the gate will not close.

A **warning, not an error** — the layout works, it just never gates, which is squarely *"warn when
the input is probably a mistake"*. There is no legitimate case to false-positive on: compiled
output inside a source root is an input to the next build's hash.

It earns its place because the alternative is documenting a constraint whose violation the tool
detects in eight lines and declines to mention. The symptom otherwise is either "every session
recompiles" (invisible) or "`--check` is permanently red" (which the developer will blame on the
tool). It goes in the spec's *Warned* list as it is added.

### 4 — Doc corrections

- `tool-contract.md:72` — *"so a consuming repo using a wrapper package need not write this file
  at all"* — and its source, `qa-composable-skills-tooling.md:157`. Unimplementable: config
  discovery walks *up* and stops at `.git` (`config.ts:152`), and `DEFAULT_SOURCES` is empty
  (`config.ts:12`). Replace with: every consuming repo writes its own config; a package's
  contribution is one `sources` entry.
- `tool-contract.md:10-11` — cut *"and re-expose the CLI; the tool sees no difference"*. The hook
  names this tool's own bin.
- The spec gains only what the tool now enforces: the two severity moves, the containment
  warning, and the sentence that a named source is a hard dependency of the build.

Everything else packaging-shaped goes in the **README**: the two layouts, keeping `files` tight,
that the consuming repo declares the tool itself, that `--check` belongs in a dev install, and
that a peerDependency from the pack is the wrong shape — the pack links against no API, peers
auto-install on npm 7+ and pnpm 8+, and two packs with disjoint ranges make the consumer's install
fail over what is really "which template syntax was this authored against". A prescriptive
packaging section in the contract would contradict `tool-contract.md:632`, the line this plan
relies on to scope delivery out.

## The recipe this buys

**Skills repo** — templates under `templates/`, no stub `package.json`, the tool as a
devDependency for its own CI, `files` limited to the template directories.
**Project repo** — `npm i -D @acme/skills composable-skills`, `composable-skills init --write`,
then one edited line: `"sources": ["@acme/skills/templates"]`.

## Files touched

| Path | Change |
|---|---|
| `src/config.ts` | `resolvePackageRoot` walks the `node_modules` chain and resolves subpaths through `resolveContainedFile`; per-failure diagnostics; unusable source entries become errors; the source/target containment warning |
| `src/directives.ts` | `resolveContainedFile` gains `expect: "file" \| "directory"`, defaulting to `file` |
| `src/discover.ts` | an unreadable source root becomes an error |
| `test/config.test.ts` | seven resolution cases, the rewritten `:220`, and the `--check` exit-code matrix |
| `docs/specs/tool-contract.md` | delete two false claims; move two Warned bullets to errors; add the containment warning and the hard-dependency sentence |
| `docs/staging/qa-composable-skills-tooling.md` | correct the wrapper-config answer in place, marked as corrected |
| `README.md` | packaging section: the two layouts, `files`, who declares the tool, `--check` in a dev install, no peerDependency |

## Sequencing

**One commit.** The resolver widens what compiles and the severity rule widens what fails, and
bundling them means a single upgrade does both — but nothing is published and there are no
consumers to bisect for, so the argument for splitting is weak against the cost of two rounds of
spec edits.

Before anything hook-shaped is reconsidered, the roadmap's own prerequisites should be paid:
publish, run `init --write` against a real repo, and start one session under the hook it writes.
That answers the open `EPERM` question and retires two roadmap open questions. It is not in this
plan's scope, but nothing about the hook should be re-opened before it.

## Out of scope

- **Stamp exclusions to make `"sources": ["."]` gate.** Cut in revision 2; see *Not defects*.
- **Changing the hook string, and refusing to write it.** Cut in revision 2; see *Not defects*.
- **A package-supplied default config, and auto-discovery of installed skill packs.** A
  dependency that names `targets` is a supply-chain problem, and discovery brings ordering and
  precedence design with it. Delete the claim rather than implement it.
- **Per-repo override of a packaged skill's frontmatter.** Breaches invariant 1: frontmatter is
  the privilege gate and an override cannot reach it, enforced by whole-region byte-identity. The
  whole-skill shadow already covers the case.
- **Selecting or excluding individual skills from a pack.** Ship a narrow pack, or shadow.
- **`lint` (Phase 4).** It stays where it is. Revision 1 justified excluding it by claiming
  change 2 gives a skills repo a red CI; that was false — a skills repo's sources are paths, and
  under revision 2's widened rule it goes red only when *nothing* resolves. `lint` remains the
  real CI answer for a skills repo, and pulling it forward is the ambition this plan is
  deliberately not taking on.
- **`init` detecting installed packs and suggesting a `sources` entry.** A shallow scan of
  `node_modules` for directories holding `SKILL.md.tmpl`, printed as advice in the note `init`
  already emits — no prompt, no stdin, no config written, and so no reopening of the
  auto-discovery rejection, which was about a dependency silently joining the corpus with an
  undefined precedence. A genuine nicety on `init`, named here rather than dropped, and not part
  of making package sources work. Interactive prompting is rejected outright: it would break the
  property that the plan is computed once and printed verbatim, and would need a non-TTY path and
  a suppression flag in a CLI that deliberately takes none.
- **Yarn PnP.** Already out of scope; resolving by directory does not change that.

## See Also

- [`docs/plans/composable-skills-tooling.md`](composable-skills-tooling.md) — the roadmap this sits beside
- [`docs/specs/tool-contract.md`](../specs/tool-contract.md) — the contract these changes edit
- [`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md) — why the hook and the untracked output are shaped this way
