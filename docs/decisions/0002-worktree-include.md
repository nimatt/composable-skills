# A worktree is given the tool and the compiled skills by `.worktreeinclude`

**Status:** Accepted (2026-09-07)

Amends the *The hook does not survive it* consequence of
[ADR 0001](0001-build-time-composition.md). For the resulting behaviour — what `init` writes and
what it refuses — see [the spec's *The `.worktreeinclude` lines*](../specs/tool-contract.md#the-worktreeinclude-lines)
and [*The `SessionStart` hook*](../specs/tool-contract.md#the-sessionstart-hook). This document
records why.

## Context

ADR 0001 decision 2 makes everything this tool writes gitignored, and a worktree receives only
what git tracks. The consequence was recorded then as one problem — "the hook does not survive it,
each worktree needs its own install" — and both halves of that sentence turn out to be wrong.
The following was verified empirically against a Claude-Code-created worktree at
`<repo>/.claude/worktrees/<name>` on Claude Code 2.1.263, not reasoned from the code.

**What already works, and needed no fixing:**

- **Repo root resolution.** `findRepoRoot` looks for a `.git` at each level and a worktree's
  `.git` is a regular file, so the walk stops at the worktree. Build output lands in the worktree,
  never in the main checkout.
- **Overrides**, keyed on the declared `id`, exactly as designed.
- **A package named in `sources`** — which the ADR 0001 sentence did not claim and the README's
  did. `findPackageRoot` walks `node_modules` from the repo root *upward*, and the worktree is
  nested inside the main checkout, so `@acme/skills/templates` resolves through the main
  checkout's install. A package-source skill compiled correctly inside a worktree.

**What is broken, and it is two things rather than one:**

- **The `SessionStart` hook.** `HOOK_COMMAND` is the fixed literal
  `node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build` and walks no chain.
  `node_modules` is gitignored, so it is absent in a fresh worktree and the hook fails at every
  session start — silently, because it is fail-soft.
- **The first session has no skills at all**, which an install does not fix. `build` already
  reports it: *"`<target>` did not exist before this build — a skills directory that was not there
  when the session started is not picked up, so these skills become available in the next
  session."* Targets are gitignored, so every fresh worktree hits this, hook or no hook.

Claude Code offers a mechanism for exactly this shape: a **`.worktreeinclude`** at the project
root, in `.gitignore` syntax, naming files to copy into a worktree it creates. Only a file that
matches a pattern there **and** is gitignored is copied, so tracked files are never duplicated —
which makes it the precise counterpart of decision 2 rather than a second list to maintain.

One hazard governs the shape of what we write. **A copied skill directory that arrives without its
`.composable-skills-owner` marker is permanently frozen.** Reproduced:

```
warning [demo] …/.claude/skills/demo exists and was not written by this tool — left untouched
```

An unmarked directory is never overwritten, so that build and every build after it in that
worktree leaves the stale skill in front of the model, with nothing but a warning in a log nobody
reads. The Claude Code documentation's own worked example (`**/.claude/skills/*.md`) has exactly
that shape.

## Decision

**`init` writes a fourth file: a `.worktreeinclude` at the repo root, naming the tool's own
package directory and every in-repo target, contents and ownership marker.**

1. **A step, not advice.** It is `gitignoreStep`'s twin — a repo-root, line-oriented file in
   gitignore syntax, appended to and never rewritten, its dominant line endings preserved, and
   refused rather than overwritten where it is a symlink, unwritable, or unreadable. The dedup is
   where the twinning stops: the two files are read by different matchers, so they normalise
   differently, and this one errs towards a redundant line rather than a suppressed one — a
   redundant line costs nothing, a suppressed one costs the worktree the thing this ADR exists to
   deliver. Decision 6 has the rest.
2. **The whole package directory**, `/node_modules/composable-skills/**`, derived from the path
   the hook names rather than written out a second time — by dropping `dist/cli.js` from its tail,
   so that a package published under a scope one day would not yield `/node_modules/@acme/**` and
   copy an entire npm scope into every worktree. Not its `dist/` alone: the shipped bundle is ESM
   and what makes node read it as ESM is the `"type": "module"` in the `package.json` beside it,
   so a `dist/` copied on its own throws
   `SyntaxError: Cannot use import statement outside a module` before it does anything.
3. **Every in-repo target, twice** — `/<target>/**` for the contents and
   `/<target>/**/.composable-skills-owner` for the ownership markers. The second line is the
   answer to the freezing hazard above, and it is **redundant on the version measured**: on Claude
   Code 2.1.263 a `**` copies the marker, tested in an isolated repo with no `settings.json`, so
   no hook and no build could have manufactured one. It is kept because that behaviour is
   undocumented and this copier has already changed here once, at 2.1.239 — insurance against
   drift rather than cover for ignorance, bought for one line, against a failure that is permanent
   and reported only in a log. Both patterns also name their directory rather than leading with
   `**/`, which is what the Claude Code documentation recommends: the `**/` form *does* reach
   inside a wholly-ignored directory where the first name after it appears in that directory's
   path — `**/.claude/skills/*.md` is the documentation's own worked example — but that is a rule
   easy to get subtly wrong, and an anchored pattern does not depend on it. A target outside the
   repo is skipped exactly as it is for the `.gitignore`: no copy reaches it, and this repo's file
   cannot speak about it.
4. **Not a package named in `sources`.** It already resolves, by the upward walk described above.
   Every worktree this file governs is nested under the main checkout, so the walk reaches its
   `node_modules`; and the one arrangement that puts a worktree elsewhere — a `WorktreeCreate`
   hook — is also the one case where `.worktreeinclude` is not read at all. There is no case in
   which copying a source package would help.
5. **The hook command string does not change.** Decision 4 of ADR 0001 stands unamended: the
   string stays byte-stable and all logic stays in the tool.
6. **This file's dedup is stricter than the `.gitignore`'s**, and the two are separate functions
   rather than one with an argument. A `.gitignore` line is covered by the same pattern with or
   without its anchoring and trailing `/`; a `.worktreeinclude` line only by the same pattern with
   or without the anchoring `/`, so a hand-written `dir/` does not suppress a wanted `dir/**`.
   Only one of these files is read by git. `dir/` covering `dir/**` is git's equivalence, and it
   is earned by pruning the tree during traversal; a copier that enumerates candidate files and
   tests each path could read `dir/` as naming the directory alone, and nothing here has tested
   which it does. The asymmetry decides it: too strict costs a redundant line, too loose omits a
   line the worktree needs — which is the silent breakage this whole ADR exists to end.

## Consequences

**A worktree Claude Code creates opens working, in its first session.** The tool is where the hook
looks, and the targets are on disk before the session starts rather than being created by its first
build. Verified in two passes, because they prove different halves and only the second can prove
the copy.

*The build half*, by hand: a scratch consuming repo, `init --write`, `git worktree add`, exactly
the files the emitted patterns select copied across, then a build inside the worktree. It claimed
the copied skill, updated it from a worktree-only template edit, and left the main checkout's
output untouched. This says nothing about the copier — `git worktree add` is precisely the case
this ADR records as reading no `.worktreeinclude` — and is recorded as the build-side test it is.

*The copy half*, on **Claude Code 2.1.263**, from real `claude -p --worktree` runs:

- The anchored patterns are honoured end to end. The worktree received
  `node_modules/composable-skills/{dist/cli.js,package.json}` and
  `.claude/skills/demo/{SKILL.md,.composable-skills-owner,references/notes.md}`. The `SessionStart`
  hook then fired *inside the worktree*, found the tool at the literal path the string names, and
  logged `1 skill → 1 target` — with **zero** `not written by this tool` warnings and **zero**
  `did not exist before this build` notices. Those two zeros are the whole claim of this ADR: the
  first is the freezing hazard not firing, the second is the first session having its skills.
- `**` matches dotfiles. In an isolated repo with no `settings.json` — so no hook and no build
  could have manufactured a marker — a `.worktreeinclude` containing only `/.claude/skills/**`
  still brought the marker across. That is what makes decision 3's second line redundant on this
  version, and the 2.1.239 change in this same area is why it is kept anyway.

**Declaring `id` matters more than it did.** Every copied skill directory carries the *main
checkout's* marker. Writing is unaffected — a foreign marker is still a marker, and only an
unmarked directory is never overwritten — but pruning matches by declared `id`, or by repo root
path where either side declares none. So in a worktree with no `id`, a template removed upstream
leaves its compiled skill in place for the life of the worktree. Both directions verified. This is
one more consequence of invariant 5 rather than a new rule.

**Four honest limits, each a property of the mechanism rather than of this tool.**

- **A worktree entered mid-session is never reached.** `SessionStart` has already fired, and
  `$CLAUDE_PROJECT_DIR` deliberately stays at the directory the session was launched in — so the
  hook, had it fired, would have built the main checkout. Nothing here changes that.
- **A worktree made by hand with `git worktree add` is not covered.** It is created by something
  that does not read `.worktreeinclude`, and still needs its own install. `init`'s warning names
  both remedies and says which applies.
- **A `WorktreeCreate` hook disables the mechanism**, since it replaces worktree creation
  entirely.
- **The copy is a snapshot.** Reinstall the tool in the main checkout and an existing worktree
  keeps the bundle it was created with. This degrades safely rather than silently: the tool
  version is a stamp input, so the older copy rebuilds instead of reporting another version's
  output as fresh.

**Everything above is measured against Claude Code 2.1.263**, following ADR 0001's convention of
pinning the version a harness fact was verified on. The copier's treatment of a wholly-ignored
directory changed at 2.1.239, which is a concrete reason to read these as observations rather than
as a contract, and the reason decision 3 keeps a line it does not currently need.

**Claude Code only, like the hook.** There is no Codex equivalent of `.worktreeinclude`, which is
consistent with the already-deferred Codex hook: both halves of "how a build gets triggered and
supplied" are deferred together rather than one being half-done.

**One more file in a consuming repo's root.** It is tracked, three lines plus a header for the
default configuration, and it is the only place the copy set is stated — a repo that adds a target
re-runs `init` and gets the lines appended.

## Alternatives Considered

**Change the hook to resolve upward through `node_modules`, the way `sources` does.** The direct
fix, and rejected on the same grounds that fixed the string in the first place: Codex pins hook
trust to the hash of the command string and `.claude/settings.json` is tracked, so a string that
changes re-prompts every developer on the team. It also puts logic in the hook, which ADR 0001
decision 4 deliberately keeps in the tool. And it would fix only the hook half — the first session
would still have no skills.

**A `WorktreeCreate` hook that installs into each new worktree.** Rejected because it *replaces*
git worktree creation entirely: the repo would have to reimplement creating the worktree, and
getting that wrong is worse than the problem. It also disables `.worktreeinclude` as a side
effect, so it is not a mechanism that can be added beside this one.

**Copy all of `node_modules`.** Unnecessary. The shipped artifact is a zero-dependency single-file
bundle and the package declares `files: ["dist"]`, so one package directory is the whole of what
the hook needs — and copying a monorepo's `node_modules` into every worktree is a real cost paid
for nothing.

**Copy `.composable-skills/` too, so the worktree starts with a warm stamp.** Rejected because a
copied stamp can never match. The hash covers each configured root's *resolved absolute path*, and
outcomes are keyed by resolved target path; both differ in a worktree, so the copy is guaranteed
stale on arrival. It would also drag a possibly-held lock along with it.

**Do nothing and keep documenting "a worktree needs its own install".** The honest cost of that is
now measurable: the documented remedy is incomplete in both directions — it is not needed for
package sources, and it does not fix the first session — so a developer who follows it still gets
a session with no skills and has no way to know why.

## See Also

- [`docs/decisions/0001-build-time-composition.md`](0001-build-time-composition.md) — the decision
  this amends; "nothing generated is tracked" is what makes a worktree empty
- [the spec's *The `.worktreeinclude` lines*](../specs/tool-contract.md#the-worktreeinclude-lines)
  — what `init` writes, deduplicates and refuses
- [`docs/CONTEXT.md`](../CONTEXT.md) — glossary; **worktree include**, **marker**, **target**
