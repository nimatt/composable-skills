# Skills are composed at build time, and nothing generated is tracked

**Status:** Accepted (2026-08-20)

For the user-facing surface — config schema, directives, resolution order, verbs — see
[`docs/specs/tool-contract.md`](../specs/tool-contract.md). This document records *why* the
design is shaped the way it is.

## Context

An agent skill is a single tracked `SKILL.md`. Changing it for yourself means diverging from
everyone; receiving updates means giving up your changes. There is no `extends`, `import`, or
`include` in the frontmatter of either Claude Code or Codex, and a same-name collision between
skill levels is a whole-file shadow rather than a merge. So a skill is all-or-nothing: take the
team's version, or take yours.

This tool exists to make a skill extensible at points its author declares. It is **tooling
only** — it ships no skills. A consuming repo owns its templates and is either a **skills repo**
(skills are its deliverable) or a **project repo** (skills describe its own code); the tool
behaves identically for both.

Two harness facts constrain everything below, both verified against Claude Code 2.1.237:

- **Claude Code supports shell injection in a skill body.** `` !`cmd` `` and a fenced ` ```! `
  form run before the content reaches the model. It is permission-gated and **fail-closed** —
  anything other than an allow aborts the *entire* skill invocation. This made a
  no-build-step design genuinely possible, so rejecting it required a reason.
- **Frontmatter is a privilege surface.** `allowed-tools` grants tool access and *"workspace
  trust doesn't gate this field"*; `hooks` registers hooks that persist for the rest of the
  session, with no dialog. Neither may be reachable from an untracked personal file.

A prior design ([`composable-agent-skills.md`](../../composable-agent-skills.md)) is preserved
for its evidence rather than its conclusions. The five-way adversarial review it went through
is cited under *Alternatives Considered* below but is no longer kept in the repo: its headline
recommendation rests on reading "injected commands never prompt" as "always run", which is
backwards. The reasoning that produced this ADR is in
[`docs/staging/qa-composable-skills-tooling.md`](../staging/qa-composable-skills-tooling.md).

## Decision

**Overrides are merged into the generated `SKILL.md` at build time, on the machine of the
developer who owns them. Nothing generated is tracked. A hardened `SessionStart` hook keeps
output current.**

1. **Build-time composition.** A developer's override text is compiled into the output, not
   read at invocation. The alternative — compiling injection sites that `cat` a per-user file
   at runtime — is rejected under *Alternatives Considered*.
2. **Nothing generated is tracked.** Templates are tracked; every compiled `SKILL.md` is
   gitignored, and every developer builds. The default target is the consuming repo's own
   `.claude/skills/`.
3. **The home directory is deliberately left empty by default.** Writing to
   `~/.claude/skills/` is supported but never the default, because it spends the developer's
   personal-shadow slot and is global across every repo on the machine.
4. **A `SessionStart` hook runs the build directly**, guarded by a content-hash stamp, failing
   soft, with a byte-stable command string and no dynamic `import()` of content-derived paths.
5. **Emitted frontmatter is byte-identical to the template's**, and no slot may be declared in
   the frontmatter region. This is the only rule the tool enforces about *what the output
   says*; the rejections in decision 7 are about inputs it cannot safely compile, not about the
   prose an author chose.
6. **The template is the trust boundary.** It is tracked, reviewable in a PR, and its author's
   responsibility. An override is personal and untracked, reaches only slots the template
   declared, and can never reach frontmatter.
7. **The tool does not police a template author's judgement.** What it does reject is a short
   list of inputs that make a build unsafe or unpredictable rather than merely unwise: emitted
   frontmatter that is not the template's, a slot in the frontmatter region, an `include:` or an
   override escaping its own root, a merge-conflict marker in any compiled input, a duplicate
   slot name, an unknown or malformed directive, directive syntax left in the output, and a
   source skill directory supplying one of the files the compiler writes itself. Every one of
   them is a shape the compiler cannot process safely, not a judgement about the prose. The
   spec's *Rejected* list is the enumerated version and the one to trust. Beyond
   those the tool takes no view: it does not decide delivery, cannot enforce `.gitignore`, does
   not track override staleness, and does not protect guardrail text from a slot placed after
   it.

## Consequences

**A developer's tweaks survive every team update, which is the point.** A slot override is
re-applied on every build, so the team can rewrite everything around it and the personal delta
persists without a fork. No one clones the skills repo to edit it.

**Personal overrides survive `git worktree add`.** Because the primary override location is
outside the working tree and keyed on a declared `id` rather than a path, all worktrees of one
clone resolve the same overrides. The obvious alternative — a gitignored directory in the repo —
fails here, and the motivating repo has three worktrees live with its agent tooling creating
more.

**The hook does not survive it, and neither do the compiled skills.** A worktree receives only
what git tracks, and nothing this tool writes is tracked: the path the hook names is absent, so it
fails at every session start, silently, being fail-soft — and the targets are absent too, which an
install does not fix, since a skills directory that was not there at session start is not picked up
either way. Overrides resolve in a worktree because they are keyed on a declared `id`; a package
named in `sources` resolves because its `node_modules` walk runs upward and reaches the main
checkout. **Amended by [ADR 0002](0002-worktree-include.md) (2026-09-07)**, which closes both halves
for a worktree Claude Code creates by having `init` write a `.worktreeinclude`; a worktree made by
hand with `git worktree add` still needs its own install. See
[the spec's *`SessionStart` hook*](../specs/tool-contract.md#the-sessionstart-hook).

**The tool executes a dependency's code at session start, unsandboxed, with no trust prompt.**
This is the honest cost of decision 4 and it is accepted knowingly. It is **the same class as
npm `postinstall`, not a new one** — `ignore-scripts` defaults to false, so registry code
already runs at full privilege in any consuming repo. What `SessionStart` adds is cadence and
detectability: `postinstall` fires once, at a moment a human chose, into a log; this fires every
session forever, and because its entire job is writing into `.claude/`, it has no anomalous
signature. Mitigation is limited to the guards in decision 4 and to the fact that the tool is a
dependency teams audit like any other.

**Amendment (2026-09-04): decision 4's stamp guard verifies per-target outcomes.** The guard
named above records, for each skill and each target separately, either a content hash of the
`SKILL.md` written there or a decline where the target held something that was not this tool's to
replace; it previously folded one boolean across every target into a single hash per skill. This
is a strengthening rather than a relaxation. One state per skill cannot represent *written in
target A, declined in target B*, and resolving that pair to *declined* would have dropped the
integrity check from a compiled skill that really exists — arrangeable by anyone able to create a
directory in a shared target such as `~/.claude/skills`, which decision 3 supports as a
non-default. A still-standing decline is not a gap in that check: re-reading one asks whether a
non-owned entry is still at the path, which confirms the record and counts as verification done,
the same way a re-read hash that still matches does — so a corpus whose every skill is declined
gates. The floor was never that *some* skill verifies, and no such floor is a trust boundary:
whoever can write the stamp can equally plant a `SKILL.md` in a target and record *its* hash as
written, which re-reads, matches and gates. What the per-target change leaves untouched is the
narrower property this mitigation rests on — **a record naming no path to go and look at gates
nothing**, a `failed` list or an empty per-target map being exactly that — and the guard's job,
which is correctness against ordinary staleness and detectability, not defence against an actor
who can already write the state directory. The enumerated behaviour is in
[the spec's *`SessionStart` hook*](../specs/tool-contract.md#the-sessionstart-hook).

**A fresh clone has no skills until the first build.** Claude Code does not watch a top-level
skills directory that did not exist at session start, so the first session after a clone
silently has none. Judged minor because clones are rare, and **narrowed by a notice rather than
closed**: `build` names any target directory that did not exist before the run, saying the skills
it just compiled become available in the next session. That reaches the person it happens to.
`build` runs at `SessionStart` and its stdout reaches the model, so it is the one channel that
speaks to *the cloner*, in the session where the fact matters — where advice printed by `init`
only ever reaches the maintainer, once. The first session is still without skills; it is no
longer without a signal.

A `postinstall` build was the obvious mitigation and was **declined**. `package.json` is a repo's
identity and a far riskier merge than `settings.json` — `scripts.postinstall` may already be a
chain — many consuming repos are not npm packages at all and have no `package.json` to add it to,
and `--ignore-scripts` voids it entirely, which the motivating repo's Docker builds are one flag
away from. So it would have been a mitigation and never a guarantee, bought with the tool's
riskiest write. A repo that is an application rather than a package can add one itself, and
`init` prints the line to add; the tool does not write it.

**A broadened `description` is invisible in review.** With no tracked output there is no diff
showing what the model actually receives. Decision 5 is the compensating control: frontmatter
can only come from a tracked template, so the routing contract and the privilege grant are
always reviewable even though the body is not.

**A `replace` override silently outlives improvements to the text it replaced.** There is no
staleness tracking. This is accepted rather than instrumented, because the build runs inside a
session hook whose output no developer reads, so any warning would be unread by construction.
The design's answer is to prefer slots with empty defaults, where nothing can drift.

**Codex is nearly free, and injection would have excluded it.** Codex has no injection
mechanism at all — its `injection.rs` is skill-content-into-prompt, a different thing under the
same word. Build-time output is identical for both harnesses, so Codex support is a target
directory rather than a code path.

**Every developer who overrides needs the tool installed and working.** There is no
zero-setup path for them. A developer who never overrides still builds, because nothing is
tracked.

## Alternatives Considered

**Runtime injection — compile `` !`cat <override-path> 2>/dev/null || true` `` into the output,
so only the maintainer ever compiles.** The most serious alternative, and the one the
adversarial review recommended. It satisfies "never remember to rebuild" *by construction* and
deletes the stamp, the lock, drift protection, and the entire staleness question. Rejected on
three grounds. It reaches only points the template author declared as injection sites, so it
cannot express a developer's deeper change at all. **Codex does not support it**, which would
have made a whole harness second-class. And a managed `disableSkillShellExecution: true`
neuters every extension point at once, org-wide and unoverridable, replacing each with a
literal placeholder. A fourth, smaller reason: because failure is total — a failed injected
command aborts the whole skill invocation — a developer's own `permissions.deny` rule matching
an override path would cost them the skill, not the slot.

**Tracking a canonical (override-free) compile and writing the personal compile to
`~/.claude/skills/`.** Seductive, because it gives a working fresh clone, a reviewable diff, and
makes building opt-in for people who actually override. Rejected because it spends the
developer's personal-shadow slot — the one place they can wholesale-replace a delivered skill —
and because `~/.claude/skills/` is global, so an override intended for one repo would apply
everywhere. It also does not compose with plugin delivery: plugin skills are namespaced and
*coexist* with same-named personal skills rather than being shadowed by them, and no per-skill
disable exists, so the personal copy would be a permanent unsuppressable duplicate.

**A `SessionStart` hook that only compares a stamp and prints `SKILLS ARE STALE` to stdout,
letting the model run the build through the permission-gated Bash tool.** Strictly safer, and
the review's proposed fix for the security cost above. Rejected because it is not automatic: it
is "ask the agent nicely and hope it complies", a materially weaker guarantee, and it degrades
in `-p` and other non-interactive runs where nothing may act on the message.

**Git hooks (`post-merge`/`post-checkout`) as the trigger.** Rejected on an empirical matrix:
they miss `git reset --hard`, `git stash pop`, `git am`, and every plain editor edit of a
template. Also rejected on security — `post-merge` executes freshly-fetched content at full
privilege with a zero-second window, for people who never open an agent, including CI runners
that pull.

**`against: <sha>` staleness tracking on override files.** The previous plan's answer to
replace-drift. Rejected as high-maintenance for no delivered value: a hash a developer can see
is a hash they will edit, because editing is cheaper than reading, and the warning lands in a
channel nobody reads. Escalating to auto-revert was also rejected — silently withdrawing a
deliberate customisation is a worse failure than letting it drift.

**`append` as the default slot mode.** The review praised this as a genuine insight, on the
grounds that `replace` is the sharp tool that can silently delete a guardrail. The reasoning
does not survive scrutiny: **a slot's mode is scoped to that slot's own default and cannot
reach any other team text.** Deleting a guardrail via `replace` requires a template author to
have put a guardrail inside a slot, which is an authoring error under either default. Declaring
a slot is a statement that its content is the developer's to specify, so `replace` is the
honest default.

**A general templating engine (Handlebars/Mustache/Liquid).** Conditionals, loops, and helpers
are each a way to produce a prompt you cannot predict by reading the template, and the core
failure mode here is debuggability. Mustache-family engines also HTML-escape by default, which
bites exactly once, confusingly, on somebody's `<tag>`. A skill compiler must be
byte-transparent.

**Symlinking a tracked source directory to `.claude/skills/<name>`.** Documented and supported,
and it deletes the trigger problem entirely — but it supports no transformation at all, which
is the whole point.

**Generating plugin manifests (`register`).** Scoped out rather than rejected on merit. A
marketplace entry's `skills[]` array is a list that must stay in sync with a directory and
whose drift silently drops a skill — a generator's job by definition. But delivery is the
skills-repo team's decision, so this belongs to whoever builds that repo's release process.

## See Also

- [`docs/decisions/0002-worktree-include.md`](0002-worktree-include.md) — how a worktree gets the
  tool and the compiled skills, amending the consequence above
- [`docs/specs/tool-contract.md`](../specs/tool-contract.md) — the config schema, directives,
  resolution chains, and verb surface this decision produces
- [`docs/staging/qa-composable-skills-tooling.md`](../staging/qa-composable-skills-tooling.md) —
  the grilling session this was promoted from, with per-question evidence
- [`docs/CONTEXT.md`](../CONTEXT.md) — glossary; "consuming repo" vs "developer" in particular
