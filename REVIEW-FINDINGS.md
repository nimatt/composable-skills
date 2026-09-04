# Adversarial review — findings and recommendations

Companion to [`composable-agent-skills.md`](./composable-agent-skills.md). **Read this
first — the plan has not been revised in light of it.** The plan is preserved verbatim
apart from a banner pointing here.

Produced by five independent reviewers, each instructed to attack rather than approve:
a claim auditor (re-verified every cited fact and re-ran the git-hook matrix from
scratch in a throwaway repo), a security adversary, an architecture adversary, a
repo-convention adversary, and a premise adversary assigned to argue the plan should
not be built.

---

## Recommendation

**Build the extension points with runtime injection now. Gate the compiler on evidence.**

Three reviewers independently reached this conclusion from different starting points,
and the claim auditor named the mechanism the plan never considered. Claude Code
supports shell injection in a skill body:

> The `` !`<command>` `` syntax runs shell commands before the skill content is sent to
> Claude. The command output replaces the placeholder, so Claude receives actual data,
> not the command itself. — `code.claude.com/docs/en/skills`

So a **tracked** `SKILL.md` containing:

```markdown
### Output format

Report findings as a markdown table: file:line, severity, one-line summary.
Group by file, most severe first.

!`cat "${CLAUDE_PROJECT_DIR}/.claude/skills-local/code-review/output-format.md" 2>/dev/null || true`
```

...is already an extension point. The team declares where extension is permitted and
owns the default; the personal file is gitignored; every other team edit flows through
untouched. For `mode=replace`, swap the inline default for a fallback `cat` of a tracked
default file.

This satisfies the hard requirement — "never have to remember to rebuild" — *by
construction*, because expansion happens per invocation. It deletes `build.ts`, the
SessionStart hook, the stamp gate, the lock, drift protection, the gitignored generated
output, and the unsettled tracked-vs-gitignored question. Frontmatter becomes
structurally unreachable from an override **by position** rather than by policy, which is
strictly stronger than the plan's control 2.

### What the compiler still buys, honestly

1. **Codex.** Injection is a Claude Code extension; in Codex the line reaches the model as
   literal text. This is the one irreducible reason to build. It is also currently
   unexercised — there is no `.codex/` directory in the repo, and the plan's own open
   question asks whether the team uses Codex at all.
2. **Typo detection.** A misnamed override file silently does nothing under injection.
3. **Cross-skill fragments** without repeating the path.
4. **`explain`** provenance output.

### Where injection is worse, and the mitigation

The path lives in the template, so a merged PR could point that `cat` at `~/.ssh/id_rsa`,
and **injected commands never prompt for permission**. This is exactly the threat the
plan's security control 1 was written for, and it cuts against injection harder than
against the compiler. The premise adversary conceded this squarely as the strongest
argument against its own position.

The mitigation is confirmed real and was already Phase 0 work — see "Settled questions"
below: `permissions.deny` outranks everything, so deny rules on credential paths stop it.

### Suggested trigger for revisiting the compiler

Codex actually adopted, **or** slot count crossing ~10 across ≥3 skills, **or** a
typo'd-override incident that costs someone real time. Every retrofit on the requirement
side is cheap — a `!`cat`` line converts to a slot directive mechanically. Every
component on the build-time side disappears rather than deferring.

---

## A. Falsified premises

**A1. The Objective's causal claim is false, and there is contrary evidence on disk.**

> "That trade-off is why the repo has exactly one skill — extension is impossible, so
> nobody invests in a second." — plan, Objective

`~/dev/private/nimatt-skills/` holds **11 skills, 2,143 lines of SKILL.md**, by the same
author, with **zero extension mechanism of any kind**. They reach `~/.claude/skills/` as
symlinks created by that repo's `install.sh`. Its own `CLAUDE.md` documents the design
tensions the author actually hit — invocation control, reference-file splitting,
cross-skill file contracts — and per-developer overrides are not among them.

The repo has one skill because skills live in a *personal* repo and are distributed by
symlink. **The binding constraint is distribution and ownership, not extension.** A plan
that fixes extension will not, on this evidence, produce a second team skill.

**A2. The divergence is happening on a surface the plan does not touch.**

`.claude/agents/` holds **11 agents, 3 tracked** — the other 8 are hidden by
`.git/info/exclude`. Combined with A1: people are investing heavily in agent config and
keeping it private. The plan targets the surface where divergence isn't happening yet
(N=1 skill) and is silent about the one where it already has (N=11 agents, 8 divergent).
Two reviewers flagged this independently as the strongest single reason to think the
requirement was mis-scoped. **Settle this before writing any compiler.**

**A3. The motivating case may already be solved.** The real skill `code-review` maps to is
`nimatt-skills/skills/branch-review/SKILL.md`, whose step 8 already persists a
fully-specified JSON artifact to `docs/review/<branch-slug>.json` (`n`, `severity`, `file`,
`line`, `title`, `detail`, `specialist`, `status`) *and* prints a markdown table for
humans. A triage script has its JSON today. Note what that skill did when it needed
machine-readable output: **it emitted both** — a team improvement, not a personal
divergence. That suggests the motivating case was misclassified.

---

## B. Blocking security findings

**B1. The Codex trust gate is inverted, and the plan's own advice makes it permanently
meaningless.**

The plan states as Background that project-local Codex hooks require trust "recorded
against the hook's current hash — a modified definition needs re-approval", then builds on
it: *"Keep the hook command string stable... All logic goes inside `build.ts`."*

Read from the shipped binary's serde structs:

```
HookHandlerConfig { command, commandWindows, timeout, async,
                    statusMessage, additionalContextLimit, prompt, agent }
HookStateToml     { enabled, trusted_hash }
```

The hash covers the **command string**, not the file it names. Trust is granted once to
`bun run …/build.ts`; `build.ts` is thereafter rewritable without limit, on every
developer's machine, executing unprompted and unsandboxed at session start. On the Claude
side there is no gate at all. `bun run file.ts` also executes the whole module graph, so
CODEOWNERS on `tools/agent-skills/**` does not cover an added import.

This is the plan's own control 4 turned on itself: it rejects `post-merge` because it
"executes freshly-fetched attacker-controlled content at full privilege, outside any
sandbox" — which is also what SessionStart does, with a one-session-boundary window
instead of zero. The choice is still right; presenting it as *safe* rather than *same
class, smaller radius* is not.

**Fix (better than the original design):** SessionStart runs **only the stamp comparison**
and on mismatch prints `SKILLS ARE STALE: run bun run skills:build` to stdout. That text
enters the model's context — which the plan already relies on for fail-soft — so Claude
runs the build through the **sandboxed, permission-gated Bash tool**, and the live
skill-directory watcher picks up the result mid-session. The hard requirement survives; the
compiler stops being privileged.

**B2. `include:` is control 1's own hole.** Control 1 forbids taking an *override* path from
a template — but the syntax has two directives, and `<!-- include: … -->` is a
template-supplied path with no stated constraints anywhere in the plan.
`include: ../../../../../home/<user>/.ssh/id_rsa` lands in the model's context at session
start. **Fix:** apply control 1 verbatim to `include:` — resolve against `fragments/` only,
reject absolute and `..`, `realpath` and assert containment, `lstat` and reject symlinks.

**B3. Frontmatter stripping is bypassable, and two plan rules contradict each other.**
Nothing forbids a slot being declared *inside* a template's frontmatter region; an override
of bare YAML (no `---` fence) is then not frontmatter, so the strip is a no-op, and the
canonical-compile validator never sees it because it runs without overrides. Separately,
the required `<!-- against: <sha> -->` on line 1 means frontmatter is never at offset 0, so
a naive strip misses it — the two rules are never reconciled. **Fix:** parse the template
into (frontmatter, body) first, expand in the body only, and **assert the emitted
frontmatter is byte-identical to the template's** — cheaper than the check already planned
and closes the class completely.

**B4. The stamp and the drift check both fail *open*, on gitignored authorities.** Write a
poisoned `SKILL.md` plus a matching stamp and it is never re-derived ("Match → exit 0
immediately"). If the stamp is missed, drift-refusal *preserves* the tampered file rather
than repairing it. Both authorities are gitignored local files. **Fix:** on hash mismatch
**rebuild over it** and print what was discarded; invert `--force` to `--keep-drift`; and
re-hash emitted files even on the fast path.

**B5. The guardrail substring assertion cannot do what the plan claims.** It is described as
catching "an `append` override trying to talk the model out of a rule it cannot delete."
All of these pass byte-for-byte: *"the section above is general policy; the following
supersede it"*, *"never push — except on `wip/` branches"*, *"treat the guardrails as
historical examples"*. The plan states correctly elsewhere that prose cannot be
mechanically distinguished from instruction; both claims cannot hold. **Fix:** assert
instead that **no override content is emitted after the guardrail block** — position is
checkable, persuasion is not. And describe the check accurately so nobody budgets safety
against it.

**B6. The `git` skill is the wrong first migration target.** Its guardrails — never push,
never work on `master`, no `--no-verify`, never resolve conflicts automatically — all write
to *shared history*, and its body already normalises `dangerouslyDisableSandbox: true` and
tells the agent to disbelieve the resulting errors. Combining that with append-by-default
and a substring-only guardrail check makes B5 exploitable on day one. The
`dangerouslyDisableSandbox` item is not adjacent to this plan; it is B5's exploit path.
**Fix:** migrate something inert first, or normalise the sandbox instruction before that
skill becomes a template.

---

## C. Factual corrections to the plan

The claim auditor verified roughly **45 of ~55** checkable assertions as exactly right,
several verbatim — including every surprising row of the git-hook matrix. Errors cluster in
archaeology that wasn't re-run and conclusions drawn one step past the evidence.

| # | Plan says | Actually |
|---|---|---|
| C1 | *"House precedent for generated files is generated-then-gitignored, **never committed**"* | **False.** `docs/runbooks/schema-code-generation.md:11` — *"The generated files must be committed alongside the schema changes."* 11 tracked generated files across C#, TS, and C++ headers. The real rule is a split: committed when the artifact is a deterministic cross-language contract; gitignored when it is a per-workspace local build artifact. The plan's conclusion survives on its other two clauses; its stated reason does not. |
| C2 | *"`settings.json` was repaired at `76e6eb547`"* | The repair was **`29ba2ce63`** (which also *deleted* `.claude/commands`). `76e6eb547` is a routine edit removing `Bash(yarn:*)`. |
| C3 | *"became an empty blob three times"* | **Twice** on master. `282cababc` is a dangling wip commit, not an ancestor of HEAD. |
| C4 | mtime rejected because `find -newer` "costs 5× more" | **Apples-to-oranges** — whole-repo `find` vs scoped git commands. Scoped like-for-like, `find -newer` on `.claude` is **1.07 ms, ~3× cheaper**. The other reason (git sets mtime to checkout time, so a revert is indistinguishable from a change) is correct and sufficient on its own. |
| C5 | stamp gate costs ~11 ms | `bun run` on a trivial script is **11 ms by itself**, so the hook floor is **~19 ms**. |
| C6 | *"the formats are byte-identical"* | Overstated, and the evidence is circular — both `web-perf` files were written by the same skill pack. Codex's `SkillMetadataFile` accepts `interface`/`dependencies`/`policy`/`transport`; Claude Code's table lists 20 fields including `allowed-tools`/`hooks`/`paths`. True narrow claim: a `name`+`description` SKILL.md loads in both. The frontmatter surfaces are **disjoint**, which undercuts "capability-tagged fragments not needed at the start". |
| C7 | *"Claude Code stops re-running a `command`-source plugin until re-accepted, for the same reason"* | Verbatim true, but about a **different mechanism**. For settings-file hooks — the plan's actual choice — *"Direct edits to hooks in settings files are normally picked up automatically by the file watcher."* No re-acceptance. The advice survives on the Codex half alone. |
| C8 | Frontmatter privilege analysis covers `description`, `allowed-tools`, `name` | Omits **`hooks`**, a documented frontmatter field that registers session-long hooks; the trust table marks a project skill's `hooks` and `allowed-tools` both "Used" with no dialog. Reinforces the conclusion; the security section reads as if `allowed-tools` were the ceiling. Also: the `allowed-tools` grant is **per-turn**. |
| C9 | *"this repo already has evidence of a symlink not surviving"* | **Unsupported.** No symlink has ever been tracked (`git ls-files -s` has no `120000` entries). |
| C10 | Codex event list (10 events) | Missing **`Stop`** — eleven total. |
| C11 | `git am` fires `post-applypatch` only | Fires **three**: `applypatch-msg`, `pre-applypatch`, `post-applypatch`. |
| C12 | `git reset --hard` / `git stash` fire "nothing" | They fire **`post-index-change`**. Useless as a trigger (`git status` fires it too), so the conclusion is unaffected — arguably strengthened — but "nothing" is wrong as written. |
| C13 | `allowed-tools` quote | Silently truncated: drops the leading *"Workspace trust doesn't gate this field"* and cuts the final clause *"before you run Claude Code there"* mid-sentence with no ellipsis. Meaning preserved; presentation is not verbatim. |
| C14 | *"capped at 1,536 chars"* | A **configurable default** (`skillListingMaxDescChars`); also `skillListingBudgetFraction` and `skillOverrides: "name-only"`. The competing-routing argument for non-slottable `description` is the strong one and stands. |
| C15 | *"the binary exposes a bare `.codex/skills` string"* | All three occurrences are inside embedded prompt text referring to `$CODEX_HOME/skills`. No relative project-path constant exists. The conclusion ("only user-level confirmed") is right; the evidence framing is not. |
| C16 | Plugin symlinks "restricted to the plugin's own directory" | Conditional: within-plugin → preserved; elsewhere in the same marketplace → **dereferenced and copied**; outside → skipped. The "own directory only" rule applies to `--plugin-dir`, local-path, and copy-mode command sources. |

**Verified clean, do not re-litigate:** `.claude/commands` = `100644 e69de29…` 0 bytes tracked;
`.gitignore:241-245` and the `agent-memory` vs `agent-memory-local` miss; `permissions.deny: []`;
no CODEOWNERS/CONTRIBUTING/SECURITY; `azure-pipelines.yml:20` `pr: none`; husky hooks are LFS
shims + lint-staged; `package.json:23` and `:42`; `.gitignore:84` and `build-shader.ps1:55-57`;
AGENTS.md; `.mcp.json` + `enableAllProjectMcpServers: true`; four Dockerfiles with
`bun install --frozen-lockfile` and no `--ignore-scripts`; Claude Code skill precedence,
whole-file shadowing, symlink following, live watching + restart caveat, no `extends`/`import`
field, SessionStart matchers, non-blocking, stdout-into-context, project hooks with no trust
prompt; Codex `hooks stable true`, `<repo>/.codex/hooks.json`, trust-by-hash, `async: true`,
600s default, `additionalContextLimit` in `HookMetadata`.

**Git-hook matrix reproduced exactly**, including the surprising rows: `git pull --rebase`
with no local commits **does** fire `post-merge`; divergent `--rebase` fires
`post-checkout`/`post-commit`/`post-rewrite` but **not** `post-merge`; `checkout -- <file>`
fires `post-checkout` with flag **0**; plain editor edit fires nothing.

---

## D. Failure modes the plan does not model

**D1. Merge conflict markers compile straight into the model's context.** Slot defaults live
inside HTML comments, so a conflict produces `<<<<<<< HEAD` / `=======` / `>>>>>>>` *inside* a
structurally valid template. The validator rejects a default containing `-->` but nothing
rejects conflict markers, so the build succeeds and the emitted SKILL.md feeds conflict markers
to the model as instructions. One-line validator fix; silent; certain to happen.

**D2. Personal overrides do not survive `git worktree add` — the one thing the design promises
to preserve.** `local/` is gitignored, therefore per-worktree. The repo has three worktrees
live, and its agent tooling creates more under `.claude/worktrees/`. An override exists in
exactly one worktree and silently vanishes in the others, with no explanation. **Fix:** put
overrides in a per-user, per-repo location outside the worktree (e.g. `~/.claude/agent-skills/<repo>/`),
or ship a documented link step and have `explain` report which override root is in play.

**D3. CRLF breaks every hash the design depends on.** `.gitattributes` has rules for `*.ts`,
`*.cs`, `*.ps1` and many others but **no rule for `*.md`** (verified). With Git-for-Windows'
usual `core.autocrlf=true`, every `against: <sha>` mismatches permanently for Windows
developers — a permanent false "the default changed underneath you", which trains everyone to
ignore the one warning the design relies on. Drift-refusal and the guardrail substring check
misfire the same way. **Fix:** `*.md text eol=lf` and `*.tmpl text eol=lf` in Phase 0 **and**
normalise before hashing.

**D4. Fresh clone gets no skills at all.** After untracking, `.claude/skills/` does not exist at
session start — and the plan's own Background quotes the caveat that a top-level skills directory
that did not exist at session start is not watched until restart. **By construction, every first
session after every clone hits this.** Add a tracked `.claude/skills/.gitkeep` and a smoke
assertion that at least one `SKILL.md` was emitted.

**D5. The lock has no stale recovery and exits silently.** A killed build leaves the `mkdir` lock
forever; every subsequent session then exits 0 quietly and skills stop updating permanently with
no signal. Also a one-command local DoS. Write pid+timestamp, break locks older than N seconds,
and print the staleness line even when the lock is held.

**D6. `mv` atomicity assumptions.** Atomic only within a filesystem — build into a `mkdtemp`
*inside the destination directory*, not `$TMPDIR`, which is frequently a different mount where
`mv` degrades to copy+unlink and a session starting mid-copy reads a truncated `SKILL.md`. On
Windows, directory rename-over-existing fails outright; swap files, not directories.

**D7. Skill removal never propagates.** The plan never states that the builder owns
`.claude/skills/` exclusively. If it only writes and never prunes, deleting a template removes the
skill for nobody — the generated directory persists on every machine forever.

**D8. The output still lands in a sandbox-masked directory, and is now invisible.** Templates were
moved out of `.claude/` for exactly the right reason, but the *output* goes to `.claude/skills/`.
The same bind-mount hazard applies — and because the output is now untracked, the failure mode
changes from "shows up in `git status` as a zero-byte blob" (how it was caught twice) to
**completely silent**. Then drift-refusal sees a 0-byte file, refuses to overwrite it, and exits 0.

**D9. Phase 0's hygiene fix does not cover the failure it diagnoses.** Live in the worktree at
review time, untracked *and un-ignored*: `.claude/hooks`, `.claude/loop.md`, `.claude/output-styles`,
`.claude/routines`, `.claude/workflows`. And `git hash-object .claude/loop.md` returns **the exact
empty blob** sitting in `.claude/commands` — the causal mechanism is now *verified*, stronger than
the plan's own evidence. The only `.gitignore` change in Phase 0 (`agent-memory` → `agent-memory*`)
covers none of these five.

**D10. Naming the Phase 3 skill `code-review` shadows a bundled skill.** A project `code-review`
skill replaces the bundled `/code-review`, and the bundled alias `/review` then never runs yours.
The motivating example silently disables a working skill. Pick another name.

**D11. `tools/*` is not a workspace member, and SessionStart can fire before `bun install`.** The
builder must have **zero runtime dependencies**, including hand-rolled frontmatter scanning rather
than a YAML package. Separately, `.claude/skills` appears under `denyWithinAllow` in Claude Code's
own sandbox policy, so an in-session `bun run skills:build` may hit an EPERM that fail-soft then
swallows. Worth a Phase 1 check.

**D12. Fail-soft is also "nobody notices it's broken".** Exit 0, message into the *model's* context,
output gitignored so `git log` shows nothing, and no named maintenance owner. Write the diagnostic
to a file `explain` reads, print to stderr as well, and stamp a `STALE — build failed <date>` line
into the emitted skill body.

**D13. Decay is the design's stable state, not its failure mode.** `against: <sha>` covers only
`replace` (append rots too), the warning lands in the model's context rather than the human's, it
repeats every session with no acknowledge action and never escalates, and there is no restamp
command — so the cheapest resolution is to edit the sha without reading the new default. Needs
`skills:review <skill>` showing old-default / new-default / your-override, append coverage, and
escalation to falling back to canonical with a loud banner.

**D14. Slot lifecycle is undefined.** A slot is a public API with gitignored consumers. The plan
says who declares slots but never how one is deprecated, whether removal is breaking, or what the
build does with an override for a removed slot — currently it **hard-fails**, and fail-soft then
converts that into silently stale skills for the developer's *entire* tree. Removal must degrade to
a warning plus canonical fallback, never a hard failure.

**D15. The escape hatch reintroduces the problem, and `explain` cannot see it.** Personal skills
shadow project skills with no indication anywhere, and `explain` reads only templates + `local/` —
so in the single scenario it was built for it will confidently describe a composition the model
never loaded. Ten-line fix: `stat ~/.claude/skills/<name>` and lead with "SHADOWED".

**D16. The fragment strategy and the extension strategy pull in opposite directions.** The plan
(correctly) says anything over ~20 lines ships as a referenced `references/` file — but slots exist
only in the template body. The more the team follows that guidance, the less of a skill is
slottable, and the motivating output-format block is exactly the ~20-line kind that migrates out.

---

## E. Settled questions — remove from the plan

**E1. `permissions.deny` **does** outrank skill `allowed-tools`.** Documented three ways:
*"A matching ask or deny rule still aborts the invocation regardless of `allowed-tools`"*;
*"To block tools across all skills and prompts, add deny rules in your permission settings"*;
*"If a tool is denied at any level, no other level can allow it."* Security control 3 is sound and
needs no verification. This also underwrites the injection alternative in the Recommendation.

**E2. Codex `SessionStart` and `additionalContext`.** `HookHandlerConfig` carries
`additionalContextLimit` as a first-class field alongside `command`/`timeout`/`async`, and
`SessionStart` is in the event list. Strong evidence for yes; still worth the two-minute check.

**E3. Repo-local plugin auto-install.** *"You can configure your repository so Claude Code adds
your marketplace for team members once they trust the project folder, with no separate prompt"* via
`extraKnownMarketplaces` + `enabledPlugins`. No per-developer `claude plugin install`. Only matters
if the plugin route is revisited.

---

## F. What survived review

Named explicitly by multiple reviewers as correct and worth keeping regardless of which direction
the work goes:

- **Frontmatter has zero overridable keys**, and the reasoning behind it (routing contract /
  privilege grant / identity). Called "the best thinking in the document." The injection alternative
  gets this property for free, which *agrees* with the plan rather than refuting it.
- **`append` by default, `replace` opt-in and declared by the template author.** A genuine insight;
  keep the idea even if the machinery goes.
- **Default lives inside the directive**, so an unfilled slot is unrepresentable — eliminates a
  whole failure class by construction.
- **`SessionStart` over `post-merge`**, for the stated reasons (CI runners that pull, non-agent
  users, zero-second window).
- **The empirical git-hook matrix** — real work, reproduced independently, including the
  counter-intuitive rows.
- **Content hash over mtime**, for the revert-indistinguishability reason (not the timing one).
- **Rejecting general templating engines** on byte-transparency grounds.
- **`explain` before any convenience feature.**
- **The honesty of the Open questions section**, which anticipates several reviewer objections
  rather than hiding them.

---

## G. Document-type finding

The convention reviewer's verdict, independent of the technical direction: `docs/plans/` is the
wrong container for roughly half this content, and the plan half-concedes it. Two repo-specific
consequences: plans are *"explicitly transient"* and slated for deletion on ship, and
`publish-docs-to-confluence.yml` publishes `docs/specs/**`, `docs/reference/**`, `docs/decisions/**`
and `docs/help-centre/**` — **not** `docs/plans/**`. So every durable fact here is invisible outside
the repo, and the rationale for two ship-now security controls (`permissions.deny`, CODEOWNERS)
would end up documented nowhere permanent.

Suggested split, if the work returns to the Twinfinity repo:

1. `docs/reference/agent-tooling-capabilities.md` — the Claude Code / Codex capability facts, the
   git-hook matrix, the timing measurements.
2. `docs/decisions/composable-agent-skills.md` — frontmatter non-overridability, append-vs-replace,
   `SessionStart`-not-`post-merge`, the gitignored-output position (rewritten per C1), and Rejected
   alternatives. The repo's ADR anatomy already exists in
   `docs/decisions/dwg-coarse-product-granularity.md`.
3. `docs/plans/composable-agent-skills.md` — ~120 lines: Objective, a Background that cites 1 and 2,
   layout, mechanics, sequencing, and a `Files touched` list (currently missing; required by the
   plan format and present in other plans).
4. `docs/staging/qa-composable-agent-skills.md` — the open questions in the mandated
   Answer / Evidence / Confidence / Promotion target format.

Also: no prior ADR, spec, or staging memo touches `.claude/` config anywhere in `docs/` — the plan
ignores no existing knowledge. And `qdrant.last-indexed` does not exist locally, so the semantic
index has never been built here; all negative findings above rest on direct `grep`, not search.

---

## H. Phase 0 — do this regardless of direction

Every reviewer endorsed Phase 0 independently of the compiler question, and two expanded it:

- `git rm --cached .claude/commands`, as its own commit.
- Fix `.gitignore` `.claude/agent-memory` → `agent-memory*`, **and add the five live un-ignored
  paths from D9** (`hooks`, `loop.md`, `output-styles`, `routines`, `workflows`), plus
  `.claude/agents/` and `.claude/worktrees/` — currently hidden only by per-machine
  `.git/info/exclude`, the same class of miss.
- Add `*.md text eol=lf` and `*.tmpl text eol=lf` to `.gitattributes` (D3).
- Populate `permissions.deny` — `~/.aws/**`, `~/.ssh/**`, `~/.claude.json`, `./**/.env`,
  `~/.config/gcloud/**`. Confirmed effective per E1.
- Add `CODEOWNERS` for `.claude/**`, `.mcp.json`, `.husky/**`, `package.json`. **Confirm which
  remote is authoritative for merges first** — CODEOWNERS is GitHub-only, does nothing without
  branch protection, and this repo also pushes to Bitbucket. Without that confirmation it is not a
  control.
- Consider dropping `enableAllProjectMcpServers: true` and relying on the explicit
  `enabledMcpjsonServers` list that already exists and already excludes `playwright-test`. A tracked
  `.mcp.json` executing a relative path into `node_modules/.bin` unprompted at session start is what
  makes "unprompted session-start execution from a tracked file" feel normal in this repo — which is
  the reason a `build.ts` hook reads as uncontroversial.
