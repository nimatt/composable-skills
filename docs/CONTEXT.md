# composable-skills Glossary

Canonical vocabulary for this project. Terms here override casual usage in
conversation and PRs. When a term is ambiguous, the definition in this file wins;
flag conflicts under "Flagged ambiguities" with a resolution.

## Language

### The product

**The tool**:
This repo. An npm CLI that compiles skill templates into `SKILL.md` files
and writes them where an agent harness will find them. It ships no skills of its own.
_Avoid_: the package (ambiguous — a consuming repo is also a package), the compiler
(that is one of its verbs, not the whole thing)

**Consuming repo**:
Any repo that installs the tool. Two kinds — see **Skills repo** and **Project repo**.
_Avoid_: consumer (ambiguous — see Flagged ambiguities)

**Skills repo**:
A repo whose *product* is skills, authored for other repos to use. Its templates and
compiled skills are its deliverable. A company-wide skills repo is this kind.
_Avoid_: skill library, plugin repo (it may or may not be delivered as a plugin)

**Project repo**:
A repo with skills for its own use, where the templates live alongside the code they
describe. The skills are not a deliverable.
_Avoid_: product repo, app repo

### Composition

**Template**:
A tracked authoring source carrying directives — exactly one per skill, at
`<source>/<skill>/SKILL.md.tmpl`. Never loaded by an agent harness directly; every other file in
the skill directory is copied verbatim to each target.
_Avoid_: source skill, skill source

**Template source**:
A root that templates resolve from — an npm package or a path — listed in the config's
`sources`, where a later entry replaces an earlier one's skill of the same name wholesale.
_Avoid_: skill source (see Flagged ambiguities), pack

**Compiled skill**:
A generated `SKILL.md`. The artifact a harness actually loads.
_Avoid_: output, built skill, final skill

**Fragment**:
A shared markdown block spliced into several templates at build time via `include:`.
For content that is **unconditionally part of the skill body**.
_Avoid_: partial, snippet

**Reference file**:
A markdown file under a skill's `references/` directory, pointed at by the skill body
and read on demand by the model. For content needed **only under certain conditions**.
Costs no context until used.
_Avoid_: fragment (that is build-time), attachment

> The axis separating these is **conditionality, not size**. If the skill always needs
> the text, it is a fragment; if the model needs it only when some condition holds, it is
> a reference file.

**Slot**:
A point in a template where the template author has declared that a developer may extend or
replace the text, with a mode — `replace` (default) or `append`.
_Avoid_: hook (means something specific in Claude Code), variable, placeholder

**Override**:
The file that fills a slot, found by searching the `overrides` roots in reverse order; usually a
developer's own untracked file, but a tracked in-repo root is how a repo fills a slot for
everyone who builds there.
_Avoid_: customisation, local (the previous plan's directory name), patch

**Seed**:
The text `override` writes into an override file when it creates one — whatever the slot resolves
to at that moment — so that a developer who edits nothing changes nothing; see
[the spec's *What it seeds the file with*](specs/tool-contract.md#what-it-seeds-the-file-with).
_Avoid_: scaffold, stub, template (that is the authoring source)

**Config file**:
The tracked `composable-skills.jsonc` in a consuming repo, carrying only locations — `id`,
`sources`, `overrides`, `targets` — and never content.
_Avoid_: config value (nothing is substituted into a template; a repo pins a slot with a tracked
override root), settings

### Delivery

**Target**:
A directory compiled skills are written to, listed in the config's `targets`; every target is
written on every build, and the default is the consuming repo's own `.claude/skills/`. A target
may be shared by several repos, so what the tool may overwrite there and what it may delete are
governed separately — see **Marker**, and
[the spec's *Ownership and pruning*](specs/tool-contract.md#ownership-and-pruning) for the
authoritative statement.
_Avoid_: install location, output (ambiguous with the compiled skill itself)

**Marker**:
The file the tool leaves inside every skill directory it emits, naming the tool and the repo that
built it; a directory without one is never overwritten — nor is a target entry that is a
symlink, whose marker is not read through it — and only a directory whose marker names *this*
build is ever pruned.
_Avoid_: lock file, manifest (it records one directory's ownership, not a list of skills)

**Stamp**:
The record of the last real build — a content hash of the tool version, the declared `id`, every
configured root and the path it resolved to, the config file, and every source and override
tree, plus which skills failed, their diagnostics, and **one outcome per skill per target**: a
hash of the `SKILL.md` written there, or a decline where the target held something that was not
this build's to replace. Kept with the build log in the `.composable-skills/` state directory at
the consuming repo's root. A matching hash gates a rebuild only where the recorded outcomes still
hold — every recorded hash re-read and unchanged, every recorded decline still facing a non-owned
entry at that path — and a record that confirms nothing against the disk gates nothing. A gated
run compiles nothing, but replays those diagnostics and still writes the log.
_Avoid_: cache, lockfile

**Session hook**:
The `SessionStart` entry `init` writes into a consuming repo's tracked `.claude/settings.json`,
running `build` at the start of every agent session; it resolves through `node_modules`, so each
`git worktree` needs its own install — see
[the spec's *`SessionStart` hook*](specs/tool-contract.md#the-sessionstart-hook).
_Avoid_: the hook (ambiguous — Claude Code has many), git hook (rejected as the trigger)

**Delivery**:
How a skills repo's skills reach another repo — its team's choice of clone-and-link or a wrapper
package, which the tool is deliberately agnostic about.
_Avoid_: distribution (used for how the *tool* reaches a repo, via npm)

## Relationships

- **The tool** is installed by a **consuming repo**, which is either a **skills repo**
  or a **project repo**. The tool behaves identically for both; only the configured
  **targets** differ.
- A **template** plus its **fragments** compiles to a **compiled skill**, written to every
  **target**.
- A **slot** in a template becomes an extension point in the compiled skill; an **override**
  fills it, and the template's own default applies when none does.
- **Template sources**, **overrides**, and **targets** are ordered lists in the **config file**;
  later entries win in the first two, and every target is written.

## Flagged ambiguities

**"Consumer"** — resolved. Used during design to mean both *a repo that installs the tool*
and *a developer who uses the resulting skills*. These have opposite needs: a consuming repo
never needs to compile, a developer who tweaks may. The claim "consumers never run the
compiler" was true of the first and false of the second, and the conflation produced a plan
that served only the first. Use **consuming repo** and **developer**; never "consumer" alone.

**"Skill source"** — avoid entirely. Claude Code has no settings key that registers an
additional skills directory (`permissions.additionalDirectories` grants file access only,
and `--add-dir` cannot be persisted). The only non-`.claude/skills/` mechanism is a plugin's
`skills` field. Saying "add it as a skill source" implies a capability that does not exist. The
config's `sources` are **template sources** — roots the *tool* reads — never directories a
harness scans.
