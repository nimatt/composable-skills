# composable-skills tooling — design memo

**Status:** **Promoted (2026-08-20).** Every entry below has been promoted to
[`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md)
(the *why*) and [`docs/specs/tool-contract.md`](../specs/tool-contract.md) (the *what*), with
sequencing in [`docs/plans/composable-skills-tooling.md`](../plans/composable-skills-tooling.md).
Those are canonical; this file is retained for the per-question evidence and the rejected
alternatives, which are compressed there. Do not edit entries here to record new decisions —
update the ADR or spec and add a fresh entry.

Prior art, both superseded and preserved for their evidence rather than their conclusions:
[`composable-agent-skills.md`](../../composable-agent-skills.md) (original monorepo plan) and
[`REVIEW-FINDINGS.md`](../../REVIEW-FINDINGS.md) (five-way adversarial review of it).

---

## What is this repo, and what is a "consumer"?

**Answer:** This repo is **the tool** — a CLI that compiles skill templates into `SKILL.md`
and registers them with a harness. It ships no skills. A **consuming repo** installs it and
is either a **skills repo** (skills are its deliverable, e.g. a company-wide skills repo) or
a **project repo** (skills describe its own code). **The tool behaves identically for both**;
only delivery differs. The word "consumer" is retired: it was used for both *a repo that
installs the tool* and *a developer who uses the resulting skills*, which have opposite
needs. The claim "consumers never run the compiler" was true of the first and false of the
second, and that conflation produced a plan that served only the first.

**Evidence:** [`docs/CONTEXT.md`](../CONTEXT.md) "Flagged ambiguities". User correction,
2026-08-20: *"Company skills repo is not this but its own repo using this… The tool works
the same for the two use cases."*

**Confidence:** High

**Promotion target:** None — it is glossary, and it is already in CONTEXT.md.

---

## Are overrides applied at build time or at runtime?

**Answer:** **Build time.** The developer runs the compiler and their override text is merged
into the generated `SKILL.md`. Staleness is handled by an automatic rebuild on a SessionStart
hook rather than by moving expansion to runtime.

Rejected alternative — runtime injection, where the compiled skill carries
`` !`cat <override-path>` `` sites and only the maintainer ever compiles. It would have made
the "never remember to rebuild" requirement disappear by construction and deleted the stamp,
lock, drift protection, and staleness machinery. Rejected because it reaches only points the
template author declared, does not work in Codex at all (Codex has no injection mechanism),
and is disabled wholesale by a managed `disableSkillShellExecution: true`.

**Consequences to work through:** a build-time override means the compiled skill **differs
per developer**, which is what makes the tracked-vs-gitignored question live again, and which
interacts badly with plugin delivery — plugin skills *coexist* with same-named personal
skills rather than being shadowed by them.

**Evidence:** User decision, 2026-08-20: *"build time. Automatic rebuild using session hooks
solves most of the staleness."* Injection mechanics verified against Claude Code 2.1.237 —
see the verified-facts table in [the plan](../plans/composable-skills-tooling.md).

**Confidence:** High (decision), Medium (consequences not yet worked through)

**Promotion target:** ADR — hard to reverse, surprising without context, and the result of a
real trade-off against a documented alternative.

---

## Is compiled output tracked?

**Answer:** **No. Nothing generated is tracked.** Templates are tracked; every compiled
`SKILL.md` is gitignored and every developer builds. The default delivery target is the
consuming repo's own `.claude/skills/`.

Rejected alternative — tracking a canonical (override-free) compile in `.claude/skills/`
while writing the personal compile to `~/.claude/skills/` to shadow it. It would have given
a working fresh clone, a reviewable diff of what the model receives, and made building
opt-in. Rejected primarily on a cost the tool should not impose: **installing into the home
directory spends the personal-shadow slot**, which is the developer's own escape hatch for
wholesale-replacing a delivered skill. It also raises collision risk, because `~/.claude/skills/`
is global across every repo on the machine.

This preserves two independent override tiers that do not interfere:

| Tier | Mechanism | Owned by | Tool touches it? |
|---|---|---|---|
| Slot override | merged at build into the repo's `.claude/skills/` | developer | yes |
| Whole-file replacement | personal shadow in `~/.claude/skills/` | developer | **never** |

Home-directory install remains **supported but non-default**, for the case where a developer
deliberately wants a skill set available across all repos and accepts spending the slot.

**Accepted costs.** A fresh clone has no skills until the first build, and Claude Code does
not watch a top-level skills directory that did not exist at session start — so the first
session after a clone silently has none. Judged minor because clones are rare, and mitigated
by a `postinstall` build. Also accepted: no reviewable diff of the text the model actually
receives, so a broadened `description` is not visible in a PR.

**Evidence:** User decision, 2026-08-20: *"We want to allow users to install into home dir
but it should not be default. Installing into home increases collision risk and takes away
one option to override the delivered skill. It should be (a)."* Shadowing semantics
(personal > project, whole-file) and the plugin-coexistence exception verified against
Claude Code 2.1.237.

**Confidence:** High

**Promotion target:** ADR — same ADR as the build-time decision above.

---

## How does a skills repo deliver its skills to other repos?

**Answer:** **That is the skills-repo team's decision, not the tool's.** The tool must be
agnostic. Two patterns are expected, and the tool sees no difference between them:

1. **Clone and link.** Developers clone the skills repo, and it acts as a template source.
   Their tweaks live in their own override directory, not in the clone — so this is not a
   fork of shared content, and the clone stays clean and pullable.
2. **Wrapper package.** A separate npm package depends on the tool and ships skill templates,
   re-exposing the tool's CLI. The build then behaves exactly as if the developer had
   installed the tool directly, except templates resolve from the wrapper package.

The design requirement this imposes: **template resolution must be configurable**, so a
wrapper can point the tool at its own template directory. Plugin/marketplace delivery is one
option a skills-repo team may choose on top of this, not something the tool mandates or must
generate. The earlier framing — asking the tool to pick between tracked-canonical-output,
release-tag builds, or dropping plugin delivery — was mis-scoped, because all three are
downstream of a choice the tool does not make.

**Evidence:** User decision, 2026-08-20: *"This is up to the team creating the skills repo…
The tool does not see a difference here… It basically means that the tool has to be able to
be configured to be used from a wrapper that sets the template folder."*

**Confidence:** High

**Promotion target:** Spec — this is the tool's public contract, not a hard-to-reverse
architectural trade-off.

---

## How does the tool resolve templates?

**Answer:** An **ordered list of template sources**, declared in a tracked config file in the
consuming repo. Sources resolve by node module resolution or by path. **Later sources win on
skill-name collision**, and the unit of collision is the whole skill — sources never merge
within one skill.

```jsonc
// composable-skills.jsonc
{
  "id": "acme-platform",
  "sources": [
    "@acme/skill-templates",   // a wrapper/template pack
    "./skills/templates"       // repo-specific, wins on name collision
  ]
}
```

A wrapper package ships this file as its default, so a developer using one never writes it.
A single template root is just a one-element list, so the wrapper case loses nothing.

This buys three things a single root cannot: a project repo can take a company pack wholesale
*and* add its own repo-specific skills through the same tool; `explain` can report which
source a skill came from, which is otherwise unanswerable with two packs installed; and the
repo `id` — which the override directory is keyed on — has an obvious home.

Rejected: allowing sources to **merge within a single skill**, so pack A's template and repo
B's template combine. That would be a third composition mechanism competing with fragments and
slots, and it makes "which file produced this line" substantially harder to answer. Whole-skill
replacement by name only.

**Evidence:** User decision, 2026-08-20: *"ordered list"*.

**Confidence:** High

**Promotion target:** Spec — part of the tool's public contract.

---

## Where does a developer's override live?

**Answer:** Primarily **out of tree, two-tier**, keyed on the `id` declared in the repo's
config, with an **in-repo location as a fallback** when no out-of-tree override exists.

```
${XDG_CONFIG_HOME:-~/.config}/composable-skills/overrides/
  code-review/output-format.md                 # global — applies in every repo
  acme-platform/code-review/output-format.md   # this repo only
```

Relocatable via `COMPOSABLE_SKILLS_HOME`.

**The key is the declared `id`, never derived from the path.** Path-derived identity is what
breaks worktrees — `.claude/worktrees/feat-x` and the main checkout are one repo and must
resolve to the same overrides — and it would also make two unrelated repos both cloned as
`api` share a directory.

Rejected as the *primary* location: in-repo and gitignored. Gitignored files are per-worktree,
so an override would exist in exactly one worktree and vanish silently in the others. The
motivating repo has three worktrees live and its agent tooling creates more under
`.claude/worktrees/`. Retained only as a fallback, where a developer opting into it accepts
that behaviour.

Rejected: `~/.claude/agent-skills/<repo>/`, the previous plan's suggestion — it hardcodes a
Claude-specific path into a tool that claims a Codex target. XDG is harness-neutral.

**Resolution order** (first match wins):

1. `overrides/<id>/<skill>/<slot>.md` — personal, this repo
2. `<repo>/.claude/skills-local/<skill>/<slot>.md` — personal, in-tree fallback
3. `overrides/<skill>/<slot>.md` — personal, global
4. the template's default

Both repo-scoped tiers beat the global one, and out-of-tree beats in-tree at the same scope.
The alternative — global outranking a file sitting visibly in the repo — is the worse surprise.

**The in-repo fallback is a personal override regardless of whether git tracks it.** The tool
cannot control the consuming repo's `.gitignore`, so gitignoring it is advice, not a guarantee.
Two consequences: `init` offers the `.gitignore` entry, and `lint` detects a **tracked** in-repo
override (`git ls-files --error-unmatch`) and reports it, because a tracked personal override
silently applies to everyone else who builds in that repo.

Rejected: a **tracked** in-repo file as a distinct mechanism meaning "this repo pins this slot
for everyone". That is a **config value** by the glossary's definition, and it already has a
tracked, reviewable home in `composable-skills.jsonc`. Two tracked mechanisms filling the same
slot with different precedence is the kind of rule nobody recalls correctly under pressure.

`explain` flags an active in-repo override as worktree-local, because its failure mode is
"works in this worktree, silently absent in the others, no error".

**Evidence:** User decision, 2026-08-20: *"(b) two-tier primary but fallback to in repo if it
does not exist"*. Worktree behaviour of gitignored files verified in `REVIEW-FINDINGS.md` D2,
confirmed live via `git rev-parse --git-common-dir`.

**Confidence:** High on the primary location, Medium on the fallback's semantics.

**Promotion target:** Spec.

---

## What triggers a rebuild, and what executes it?

**Answer:** A **`SessionStart` hook that runs the build directly**, hardened. Not a
detect-and-ask-Claude variant.

Rejected alternative — the hook runs only a stamp comparison and prints
`SKILLS ARE STALE: run composable-skills build` to stdout, letting the model run the build
through the permission-gated Bash tool. Strictly safer, and it was the adversarial review's
recommended fix. Rejected because it is not automatic: it is "ask the agent nicely and hope
it complies", which is a weaker guarantee than the one required, and it degrades in `-p` and
other non-interactive runs where nothing may act on the message.

**The accepted risk, stated rather than omitted.** This executes a dependency's code
unsandboxed, at full privilege, with no trust prompt on the Claude Code side, every session,
unattended. That is **the same class as npm `postinstall`, not a new one** — `npm config get
ignore-scripts` is `false`, so registry code already runs at full privilege in any consuming
repo. What SessionStart adds is cadence and detectability: `postinstall` fires once at a
moment a human chose and lands in a log, whereas this fires every session forever, and its
entire job is writing into `.claude/`, so it has no anomalous signature to detect.

**Mandatory hardening:**

- **Stamp gate first.** Content hash of templates, config, overrides, and tool version.
  Match → exit 0. The common case is a no-op.
- **Fail-soft, always.** Build into a temp dir *inside* the destination directory and swap on
  success, so a failed build never destroys the last good output. Exit 0 even on failure, and
  write the diagnostic to **stdout** (so Claude reports it), **stderr**, *and* a file `explain`
  reads. The previous plan sent it only to the model's context, which means nobody notices it
  is broken.
- **Keep the hook command string byte-stable.** Codex pins hook trust to the hash of the
  command string, so any change re-prompts every developer. All logic lives inside the script,
  never in flags.
- **No dynamic `import()`** of any path derived from template or config content.

**Runtime: node, not bun.** The published binary must run under plain `node`. Bun stays the
development runtime and test runner for this repo, but a tool installed into arbitrary
consuming repos cannot assume bun is present. This requires a real build step — `tsconfig.json`
currently sets `noEmit: true` and `allowImportingTsExtensions`, so it cannot emit as-is — and
it constrains the hook command, which must not name `bun`.

**Open:** the exact hook command string. It must be stable, node-based, and survive pnpm and
Yarn PnP layouts, which rules out hardcoding `node_modules/<pkg>/dist/...`. Leading candidate
is `npx --no-install composable-skills build`.

**Evidence:** User decision, 2026-08-20: *"(i) hardened. We should not require bun but allow
node as well."* Hook trust-by-command-string-hash and the `ignore-scripts` default verified;
see `REVIEW-FINDINGS.md` B1.

**Confidence:** High on the decision, Medium on the hook command form.

**Promotion target:** ADR — the security trade-off is exactly the "surprising without context"
case, and a future reader will ask why a session hook executes a dependency.

---

## When a slot's default changes upstream, what happens to an override written against the old one?

**Answer:** **Nothing — and the design avoids the situation rather than instrumenting it.**

Two parts:

1. **Slots without defaults (pure append) are the preferred form.** A defaultless slot has
   nothing to drift under: the developer's text is additive, the team's surrounding prose can
   change freely, and the addition still applies. This removes the failure class rather than
   detecting it. `mode=replace` is not merely opt-in but actively discouraged.
2. **For slots that do carry a default, do nothing.** The override keeps applying.

Rejected — `<!-- against: <sha> -->` on the override file with a mismatch warning, the previous
plan's answer. Two independent reasons. The build runs inside a `SessionStart` hook, so its
output never reaches a context the developer reads; a warning there is unread by construction.
And the mechanism is high-maintenance for what it delivers — the adversarial review's D13
showed it decays anyway, because a hash the developer can see is a hash they can edit, and
editing is cheaper than reading.

Also rejected — escalating to auto-revert after N days. Silently withdrawing a deliberate
customisation is a worse failure than letting it drift, and the "loud banner" would land in
the same unread channel.

**Accepted cost:** a developer whose `replace` override predates a team improvement keeps the
old text indefinitely, silently. Judged acceptable because `replace` should be rare by design.

**Consequence for `explain`:** it is worth having but should not be gold-plated, and nothing
else in the design may depend on it being run. It is the tool of last resort when something is
already confusing, not a routine channel.

**Evidence:** User decision, 2026-08-20: *"It should be preferred to have slots without
defaults (i.e. pure append) which resolves this. For slots with defaults I think we have to do
(a). This will not run in a context the user sees and (b) would anyway be very high
maintenance. explain is not a bad feature but I do not think it would be used much."*

**Confidence:** High

**Promotion target:** Spec — slot semantics are part of the authoring contract.

---

## What is the slot syntax?

**Answer:** Two forms, where the bare form is the degenerate case of the fenced one.

```markdown
<!-- slot: extra-checks -->                      ← empty default; an override is purely additive

<!-- slot: output-format -->                     ← has a default; an override discards it
Report findings as a markdown table.
<!-- /slot -->

<!-- slot: output-format mode=append -->         ← has a default; an override adds after it
Report findings as a markdown table.
<!-- /slot -->
```

**`mode` defaults to `replace`, and is orthogonal to whether a default exists.** Declaring a
slot is a statement that its content is the developer's to specify, so replacement is the
honest default; `mode=append` is the opt-in for a default the team wants added to rather than
swapped. A slot with an **empty** default is legal and expected — it is a pure extension
point, where replace and append are indistinguishable in effect.

This reverses the previous plan's `append`-by-default, which the adversarial review had praised.
The review's reasoning does not survive scrutiny: it treated `replace` as *"the sharp tool that
can silently delete a guardrail"*, but **a slot's mode is scoped to that slot's own default and
cannot reach any other team text.** Deleting a guardrail via `replace` requires a template
author to have put a guardrail inside a slot, which is an authoring error under either default.
The real protection for team text outside slots is positional — see the guardrail entry.

**Accepted footgun:** an override file is plain markdown with nothing in it announcing that it
discards N lines the developer may never have read. Mitigated by `override <skill> <slot>`
seeding the new file with the current default, so the developer edits what they are replacing
instead of writing blind into an empty file.

Rejected — a single fenced form with an empty body for the defaultless case. Syntactic weight
should track semantic weight: the common case stays one line, and `mode=replace` is visible in
a diff without reading the body. A bare marker also has nothing to mis-close and cannot be
broken by a merge-conflict marker.

**Rule: no slot may be declared inside the frontmatter region**, and the emitted frontmatter
is asserted byte-identical to the template's. An extension point is therefore structurally
incapable of reaching `allowed-tools`, `hooks`, `description`, or the skill's identity — by
position rather than by policy, which is strictly stronger than the previous plan's
"strip frontmatter from override files" control.

**Evidence:** User decisions, 2026-08-20: *"(a) even though there should be slots with empty
defaults you should be able to append on the non empty ones. No slots allowed in frontmatter"*,
then *"No, the default is replace. But you should be allowed to create a template with empty
default slots and you should be allowed to append to a slot with empty default"*.

**Confidence:** High

**Promotion target:** Spec.

---

## Does the tool protect guardrail text from being outranked by an override?

**Answer:** **No — advisory only.** Documentation recommends placing slots before guardrail
blocks. There is no `<!-- guardrail -->` directive and no positional check.

Rationale: a template author who places a slot after a guardrail has made a deliberate choice
about their own skill, and the tool does not police template authors. This is consistent with
the tool's posture elsewhere — it does not decide delivery, cannot enforce `.gitignore`, and
does not track override staleness.

**This leaves exactly one enforced content rule**, and it is the right one because frontmatter
is the privilege surface: **no slots in the frontmatter region, and emitted frontmatter is
asserted byte-identical to the template's.** `allowed-tools` grants tool access with no
workspace-trust gate, and `hooks` registers session-long hooks with no dialog — neither may be
reachable from an untracked personal file.

**The resulting trust boundary, stated plainly:** the **template** is the trust boundary. It is
tracked, reviewable in a PR, and authored by whoever owns the skills repo. An **override** is
personal and untracked, can only reach slots the template declared, and can never reach
frontmatter. Everything else is the template author's responsibility.

**Evidence:** User decision, 2026-08-20: *"(b) if a template author wants to allow users to
override guardrails that is their choice"*. Guardrail examples in the corpus:
`nimatt-skills/skills/address-findings/SKILL.md:17-19`, `implement-plan/SKILL.md:17-19`,
`pr-threads/SKILL.md:25`.

**Confidence:** High

**Promotion target:** Spec, and the trust-boundary paragraph belongs in the ADR.

---

## Do `include:` fragments earn their place alongside runtime `references/`?

**Answer:** **Yes, and they are not substitutes.** The axis separating them is
**conditionality, not size** — which corrects the previous plan's "anything over ~20 lines
ships as a reference file" heuristic.

| | `include:` fragment | `references/` file |
|---|---|---|
| When | content the skill **always** needs | content needed **only under certain conditions** |
| Resolved | build time, spliced into the body | runtime, read on demand by the model |
| Context cost | every invocation | only when actually read |

A hard-rules block repeated across twelve skills in a company pack is a fragment: it must be
in the body every time, and a reference file cannot do that job. A Jira project's field-ID
table is a reference file: it is only needed once the skill reaches the step that uses it.

**Evidence:** User decision, 2026-08-20: *"include is nice and earns its place since references
are not used the same. include is for inline sections, references is for parts of the skill
that are needed only in certain conditions"*.

**Confidence:** High

**Promotion target:** Spec, and the distinction is already in [`docs/CONTEXT.md`](../CONTEXT.md).

---

## How are override locations configured?

**Answer:** **As an ordered list, symmetrical with template sources.** The earlier hardcoded
three-tier scheme becomes the shipped *default* for that list rather than a fixed rule.

```jsonc
{
  "id": "acme-platform",
  "sources":   ["@acme/skill-templates", "./skills/templates"],
  "overrides": ["${home}/global", "./.claude/skills-local", "${home}/repos/${id}"]
}
```

**Later wins in both lists**, so the two mechanisms read the same way. The unit of collision
differs and that is inherent, not accidental: template sources collide per **skill**, override
sources collide per **slot**.

Layout under `${home}` (`${XDG_CONFIG_HOME:-~/.config}/composable-skills`, relocatable via
`COMPOSABLE_SKILLS_HOME`) uses two sibling roots rather than nesting the per-repo tier inside
the global one, so no path can be ambiguously interpreted as either:

```
${home}/global/<skill>/<slot>.md
${home}/repos/<id>/<skill>/<slot>.md
```

**This subsumes the "can a tracked, per-repo mechanism fill a slot?" question.** It can, by
listing a **tracked** in-repo directory as an override source. No separate config-fills-slots
mechanism is needed: one file convention everywhere, and ownership is determined by which
source a file sits in rather than by a second syntax. It also means the tracked-vs-gitignored
distinction for `./.claude/skills-local` is the repo's choice, which is consistent with the
tool being unable to control the consuming repo's `.gitignore` anyway.

**Evidence:** User decision, 2026-08-20: *"We set template location to ordered list, why not do
the same for overrides?"*

**Confidence:** High on the ordered list; Medium on the default ordering and the `${home}`
layout, which are proposals rather than stated decisions.

**Promotion target:** Spec.

---

## Does `{{ value }}` config substitution survive?

**Answer:** **No. Dropped. Slots carry every variable point.** The directive language is
exactly two directives: `<!-- slot: … -->` and `<!-- include: … -->`.

Rationale:

1. **An inline value rephrases as a block, usually into better prose.**
   `Compare against {{ base-ref }}` becomes a one-line slot whose default is the whole
   sentence. The customisable unit is the sentence, not a token inside it — which is what a
   developer would actually want to swap.
2. **`{{ }}` would have been config-only and therefore not personally overridable**, while
   every slot is overridable by whichever source wins. That asymmetry has no principled
   justification, and it would be the one rule in the language not derivable from the
   resolution chain.

**Consequence — the config file carries only locations, never content:** `id`, `sources`,
`overrides`. Written once, then untouched. Content lives in templates and override files and
nowhere else.

**Accepted cost:** a skill with five tweakable values gets five block slots rather than five
inline tokens, so templates are more verbose. Judged honest rather than unfortunate — five
extension points is what the skill actually has. Re-adding `{{ }}` later is non-breaking if
verbosity proves painful in practice.

**Evidence:** User decision, 2026-08-20: *"Drop and rely on slots"*.

**Confidence:** High

**Promotion target:** Spec.

---

## Where does compiled output go, and is Codex in scope?

**Answer:** **An ordered list of targets in config**, symmetrical with `sources` and
`overrides`. Codex needs no dedicated emitter — it is a config entry.

```jsonc
{
  "id": "acme-platform",
  "sources":   ["@acme/skill-templates", "./skills/templates"],
  "overrides": ["${home}/global", "./.claude/skills-local", "${home}/repos/${id}"],
  "targets":   ["./.claude/skills"]
}
```

Default is `["./.claude/skills"]`. A developer adds `~/.claude/skills` when they deliberately
want a set available across every repo, or `./.agents/skills` for Codex. The compile is
identical for every target; a target is only another directory to write.

**The Codex path is `.agents/skills`, not `.codex/skills`.** Both prior documents had this
wrong. Search order: `$CWD/.agents/skills`, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`,
`/etc/codex/skills`. Confidence medium-high — docs plus binary strings, never executed. **Verify
before shipping a Codex target**: drop a `SKILL.md` at `<repo>/.agents/skills/x/` and launch
`codex`.

**Frontmatter across disjoint harness surfaces — resolved in favour of byte-identity.** Claude
Code documents ~20 frontmatter fields; Codex's public docs document `name` and `description`
only; the claude.ai Skills API **hard-errors** on anything outside a seven-field allowlist. The
tool emits **identical frontmatter to every target** and `lint` warns when a template uses a
field a configured target does not support.

Rejected — per-target frontmatter filtering. It would produce more portable output, but it
breaks the byte-identity assertion, and byte-identity is precisely what makes an override
structurally incapable of reaching `allowed-tools` or `hooks`. Silently rewriting the privilege
surface per target is the class of behaviour that makes a trust boundary impossible to reason
about; a warning is sufficient for a problem the template author can fix by not using the field.

**Evidence:** User decision, 2026-08-20: *"targets as list with (i)"*. Codex path and frontmatter
surfaces verified against `codex-cli` 0.147.0 and Claude Code 2.1.237.

**Confidence:** High on the design; Medium on the `.agents/skills` path until executed.

**Promotion target:** Spec.

---

## What verbs does the CLI expose?

**Answer:** Five, shipped in this order — `build`, `init`, `override`, then `lint`, then
`explain`. The first three are the whole product: a repo can adopt the tool and a developer
can tweak a skill with nothing else.

| Verb | Who runs it | Justification |
|---|---|---|
| `build` | the SessionStart hook, `postinstall`, rarely a human | the tool itself |
| `init` | consuming-repo maintainer, once | writes config, the hook entry, and the `.gitignore` line. Diff-first, requires `--write` |
| `override <skill> <slot>` | a developer, occasionally | nothing else can tell them where the file goes; seeds it with the current default, which is what defuses replace-by-default |
| `lint` | a **skills repo's** CI | the only channel where a warning reliably reaches a human, since build output goes to a session hook nobody reads |
| `explain [<skill>]` | anyone, when confused | last resort; ships last and stays small |

**Cut — `register`.** Generating `.claude-plugin/marketplace.json` and `plugin.json`. Delivery
is the skills-repo team's choice, so manifest generation is not the tool's job. Worth recording
that this was the previous revision's *anchor* use case, justified by the silent-failure mode of
a marketplace `skills[]` array drifting out of sync with its directory. That failure is real and
still unaddressed — it simply belongs to whoever builds a skills repo's release process, not to
this tool.

**Cut — `build --check` as a CI diff gate.** Meaningless when nothing generated is tracked.
`--check` survives only as "exit non-zero if output is stale", which is the stamp comparison
exposed for scripts.

**Evidence:** User confirmation, 2026-08-20: *"looks good"*.

**Confidence:** High

**Promotion target:** Spec.

---

## Does `include:` have path containment rules?

**Answer:** **Yes.** A fragment path resolves only within the declared `sources` roots.
Absolute paths and `..` are rejected; the result is `realpath`'d and asserted contained; each
path component is `lstat`'d and any symlink hop is rejected rather than resolving once at the
end. With an ordered `sources` list there are N roots, each resolved independently with no
fall-through between them.

**Why this and not the guardrail answer.** The two look like the same "should the tool police
template authors" question and are not. A slot's blast radius is its own default — it cannot
reach any other text, so leaving it to the author costs nothing outside the skill. `include:`
reads an arbitrary file off disk into an instruction file the model receives at session start:
`include: ../../../../.ssh/id_rsa` places a private key in context with no tool call and no
permission prompt. That is a capability that escapes the skill entirely, and containment costs
nothing legitimate because fragments live in source roots by definition.

This closes the hole the adversarial review found in the previous plan's own controls: its
security control 1 forbade taking an *override* path from a template but said nothing about
`include:`, which is equally template-supplied (`REVIEW-FINDINGS.md` B2).

**Evidence:** User decision, 2026-08-20: *"(a)"*.

**Confidence:** High

**Promotion target:** Spec, and the reasoning belongs in the ADR's trust-boundary section.

---

## What does the build reject, and what does it warn about?

**Answer:** Failure is **isolated per skill** — the build runs in a fail-soft session hook, so
a rejection must never abort the run and leave the developer's entire skill set stale. A skill
that fails validation keeps its previous output; the others build normally. Diagnostics go to
stdout, stderr, and a file.

**Reject** (that skill only): unknown directive or leftover directive syntax in the output;
unclosed `<!-- /slot -->`; a slot declared inside the frontmatter region; emitted frontmatter
not byte-identical to the template's; an `include:` resolving outside every configured source
root; **merge-conflict markers in a template**; a duplicate slot name within one skill.

**Warn:** an **override file matching no declared slot** — the typo that otherwise does nothing
at all, and which must never be an error, because the previous plan hard-failed here and
fail-soft then converted one stale personal file into a stale skill tree (`REVIEW-FINDINGS.md`
D14); a template using a frontmatter field a configured target does not support; a skill name
colliding across sources, which is informational since later-wins is the documented rule.

**Organising principle:** reject when the **output would be wrong or unsafe**; warn when the
**input is probably a mistake**. A developer's typo never breaks a build; a conflict marker
reaching the model always does.

**Explicitly not a warning: an in-repo override that git is tracking.** A tracked override
source is a legitimate, deliberate configuration — it is exactly the per-repo tracked
slot-filling mechanism that replaced a separate config-fills-slots feature. Warning about it
would contradict that design and would be the tool policing a choice it already delegated.
(This corrects an inconsistency proposed earlier in this session.)

**Evidence:** User decision, 2026-08-20: *"an in-repo override that git is tracking should not
be a warning. Otherwise good"*.

**Confidence:** High

**Promotion target:** Spec.

---

## What is the package called, and does it publish publicly?

**Answer:** **`composable-skills`, unscoped, published publicly to npm.** The name is
unclaimed — `registry.npmjs.org/composable-skills` returned 404 on 2026-08-20.

**Accepted obligations of publishing publicly:** issue triage from strangers, a cross-platform
CI matrix, and semver on the directive syntax — in a repo that currently runs no tests. Also
required before a first publish: a `LICENSE` and a real `README.md`, since both are the package
page on npm rather than repo furniture.

**Evidence:** User decision, 2026-08-20: *"Package name: composable-skills / public package"*.

**Confidence:** High

**Promotion target:** Plan — captured in Phase 0.

---

## What is the `SessionStart` hook command string?

**Answer:** `node "<project-dir>/node_modules/composable-skills/dist/cli.js" build`, written as
a literal resolved string by `init`.

**The stability requirement was misread at first.** Byte-stability exists because Codex pins hook
trust to the hash of the command string — so the string must not change *spontaneously*, not that
it must be identical across every repo. `init` may therefore detect the layout and write the best
literal form; a deliberate re-`init` causing a one-time Codex re-prompt is acceptable.

**Measured on node v24.19.0 / npm 11.17.0, 3–5 invocations each:**

| Form | Per invocation | Verdict |
|---|---|---|
| `npx --no-install <pkg>` | ~378 ms | rejected — ~290 ms of pure resolution overhead per session, 15× the stamp check it guards |
| `node_modules/.bin/<pkg>` shim | ~85 ms | rejected — `.cmd`/`.ps1` on Windows, needing a separate Codex `commandWindows` |
| `node "<path>/dist/cli.js"` | ~28 ms | **chosen** — fastest and platform-identical |

**Scope decisions that removed the remaining branches:**

- **Windows is supported.** The `node <path>` form sidesteps shim extensions entirely; forward
  slashes work in the JSON string on Windows.
- **Yarn PnP is out of scope.** No `node_modules` means every path-based form breaks, and
  supporting it would require `yarn node` or a `.pnp.cjs` preload. `init` detects `.pnp.cjs` and
  **fails loudly** rather than writing a command that silently never runs. pnpm is unaffected —
  it symlinks direct dependencies to `node_modules/<pkg>`.
- **devDependency only.** No global-install path, so resolution is always repo-relative, and the
  tool's version is pinned alongside the templates it compiles.

**Still open:** what Codex expands in a hook command. `$CLAUDE_PROJECT_DIR` is Claude-specific.
Affects only the literal string written for that harness.

**Evidence:** User decisions, 2026-08-20: *"1. Yes, windows allowed / 2. No / 3. devDependencies
only"*. Timings measured in this session.

**Confidence:** High

**Promotion target:** Plan — captured in Phase 2.

---

## Which licence?

**Answer:** **MIT.** The default expectation for a public tool intended to be depended on.

**Evidence:** User decision, 2026-08-20: *"MIT is fine"*.

**Confidence:** High

**Promotion target:** Plan — Phase 0.
