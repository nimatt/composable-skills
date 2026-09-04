# `composable-skills` tool contract

## Overview

`composable-skills` is a node CLI that compiles skill templates into `SKILL.md` files and
writes them where an agent harness will find them. It ships no skills.

A **consuming repo** installs it and is either a **skills repo** (skills are its deliverable)
or a **project repo** (skills describe its own code). The tool behaves identically for both —
only the configured targets differ. A **wrapper package** may depend on the tool, ship its own
templates, and re-expose the CLI; the tool sees no difference.

For *why* the design is shaped this way — especially build-time composition, untracked output,
and the session-hook trigger — see
[`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md).
Vocabulary is pinned in [`docs/CONTEXT.md`](../CONTEXT.md).

## Shape

```
template + fragments  ──compile──>  SKILL.md  ──write──>  each target
       ^                   ^
       │                   │
   sources[]          overrides[]
```

Three ordered lists drive everything. **Later entries win in the first two; every target is
written.**

| List | Unit of collision | Owner |
|---|---|---|
| `sources` | a whole skill, by name | the repo / a wrapper package |
| `overrides` | a single slot | the developer (or the repo, if a tracked source is listed) |
| `targets` | — (all are written) | the developer |

## Configuration

A tracked file in the consuming repo, named `composable-skills.jsonc` (or
`composable-skills.json`), found by walking up from the working directory and **stopping at the
first directory holding a `.git`** — so a nested checkout, a submodule, or a worktree never
inherits an enclosing repo's config. **It carries only locations — never content.** Its directory
is the repo root every relative entry resolves against; with no config file found, the repo root
is the nearest enclosing git checkout, or the working directory itself where there is no `.git`
anywhere above it, and the defaults below apply. An unknown key warns and is ignored.

```jsonc
// composable-skills.jsonc
{
  "id": "acme-platform",
  "sources":   ["@acme/skill-templates", "./skills/templates"],
  "overrides": ["${home}/global", "./.claude/skills-local", "${home}/repos/${id}"],
  "targets":   ["./.claude/skills"]
}
```

| Key | Meaning |
|---|---|
| `id` | Stable identity for this repo. **Declared, never derived from the path** — a worktree at `.claude/worktrees/feat-x` and the main checkout are one repo and must resolve the same overrides, and two unrelated repos both cloned as `api` must not collide. It is interpolated into a path, so it must be a single path segment of `[A-Za-z0-9._-]`, and neither `.` nor `..`; a violation is **fatal**. |
| `sources` | Template roots. Resolved by node module resolution or by path. |
| `overrides` | Override roots. Scanned in reverse, so a later entry takes precedence. |
| `targets` | Output directories. All are written on every build. |

`${home}` is `${XDG_CONFIG_HOME:-~/.config}/composable-skills`, relocatable via
`COMPOSABLE_SKILLS_HOME`. The two personal roots are siblings — `${home}/global` and
`${home}/repos/<id>` — so no path is ambiguously interpretable as either. An entry containing
`${id}` is skipped with a warning where the config declares no `id`, which leaves the default
`${home}/repos/${id}` root inert until one is declared. An entry that spells `${home}` is
asserted to resolve *inside* it; one that escapes by `..` is dropped with an error — that entry
only, not the run. A leading `~` or `~/` expands to the home directory in any entry; a `~/…`
entry names no root to be contained by and so carries no containment check.

Defaults, so a consuming repo using a wrapper package need not write this file at all:
`sources` empty, `overrides` as shown, `targets` `["./.claude/skills"]`.

### Targets

Default is the repo's own `.claude/skills/`. A developer may add:

| Target | Effect |
|---|---|
| `~/.claude/skills` | available in every repo. **Non-default**: it spends the personal-shadow slot and is global. |
| `./.agents/skills` | Codex. Its search order is `$CWD/.agents/skills`, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills` — **not** `.codex/skills`. |

**A target's capabilities are classified from its configured spec string, never from the path it
resolves to.** A target counts as Codex when its spec contains a `.agents` or `.codex` path
segment and no `.claude` segment; every other target is treated as Claude Code, which supports
every frontmatter field the tool emits and therefore never warns about one. Classifying from the
spec is deliberate: a repo checked out beneath a directory named `.agents` still writes
Claude-Code skills to its own `./.claude/skills`. This is the tool's only capability model, and
the unsupported-frontmatter-field warning below is its only consequence — it fires for a Codex
target on any field other than `name` and `description`.

Compiled output is **never tracked**. `init` offers the `.gitignore` lines — the state directory,
and every target that resolves inside the repo.

## Template language

A skill is a directory under a `sources` root, and its template is the single file
**`<source>/<skill>/SKILL.md.tmpl`**. A directory without one is not a skill and is skipped —
silently, unless it holds a `SKILL.md` or some other `*.tmpl`, which warns: that shape is far
more likely a misnamed template than a coincidence.
**Every other file in the skill directory is copied verbatim to every target** — that is what
makes a `references/` directory reach the harness alongside the compiled `SKILL.md`. Two names
are reserved at the directory's top level — `SKILL.md` and the ownership marker, **in any case**,
since `skill.md` is the same file as `SKILL.md` on macOS and Windows — because the compiler
writes those itself; supplying either is a rejection. The template's own `SKILL.md.tmpl` is not a
collision and is simply consumed. A symlink inside a skill directory is not copied, and warns; a
skill directory that is *itself* a symlink is not followed, warns, and blocks pruning for that
run, since following it would read a template from outside every configured source root.

Two directives. Both are HTML comments, so a template remains valid, readable markdown.

### `slot`

Declares a point a developer may fill.

```markdown
<!-- slot: extra-checks -->

<!-- slot: output-format -->
Report findings as a markdown table: file:line, severity, one-line summary.
<!-- /slot -->

<!-- slot: output-format mode=append -->
Report findings as a markdown table: file:line, severity, one-line summary.
<!-- /slot -->
```

- The **bare form** is the degenerate case of the fenced form with an empty default. Legal and
  expected — it is a pure extension point.
- **`mode` defaults to `replace`** and is orthogonal to whether a default exists. Declaring a
  slot states that its content is the developer's to specify. `mode=append` is the opt-in for a
  default the team wants added to rather than swapped; it emits the default first, then one
  blank line, then the override.
- A slot with an empty default behaves identically under either mode.
- **No slot may be declared in the frontmatter region.**
- Slot names are unique within a skill. A name becomes a filename in an override root, so it
  starts with a letter or digit and continues with letters, digits, `-`, `_` or `.`.
- `mode` is the only attribute defined. Any other is a rejection rather than something ignored,
  because a silently dropped attribute is a template that does not do what it says.

Syntactic weight tracks semantic weight: the common case is one line, and `mode=append` is
visible in a diff without reading the body.

### `include`

Splices a shared fragment into the body at build time.

```markdown
<!-- include: fragments/hard-rules.md -->
```

Use `include:` for content the skill **always** needs. Use a runtime `references/` file for
content needed **only under certain conditions** — the axis is conditionality, not size.

**Expansion is a single pass.** A fragment may not itself `include:` another. A fragment's own
`include:` line is copied through unexpanded, where the leftover-directive scan rejects the
skill — so the failure is named and located rather than silent.

**Path containment is enforced.** A fragment path resolves only within **the `sources` root the
skill itself came from** — there is no fall-through to another root, consistent with sources
never merging within a single skill. Absolute paths and `..` are rejected, the result is
`realpath`'d and asserted contained, and every path component is `lstat`'d with any symlink hop
rejected.

### There is no variable substitution

Every variable point is a slot. A value that reads naturally inline becomes a one-line slot
whose default is the whole sentence.

### Directives are not fence-aware

A directive is recognised wherever it appears, including inside a fenced code block, so a
template cannot quote directive syntax as example text — it is expanded, or rejected as leftover
syntax. A skill that documents this tool's own conventions must therefore describe them without
showing them literally. Making the scanners fence-aware would be a language change and is not
proposed here.

## Resolution

**Skill identity** is the directory name. A skill present in more than one `sources` entry is
replaced wholesale by the later entry — sources never merge within a single skill.

**A slot's content** is the first match, scanning `overrides` in reverse order:

```
overrides[n] … overrides[0]  →  <root>/<skill>/<slot>.md
                                     ↓ none found
                             the template's default
```

A root that does not exist, or one holding no file for that slot, is **not** an error — the scan
simply falls through to the next. Containment is asserted on the paths it does find, the same way
`include:` is: every component of `<root>/<skill>/<slot>.md` is `lstat`'d, and an override that
escapes its root by `..` or a symlink hop, or that names something other than a regular file,
rejects the skill. An override root whose own last component is a symlink is rejected too:
containment is asserted against the root's `realpath`, so a symlinked root would silently widen
to wherever it points. Source roots are deliberately exempt from that last rule — a symlinked
package directory is ordinary under pnpm and workspaces.

Whether a given override root is tracked by git is the repo's choice and carries no special
meaning — a tracked root is how a repo fills a slot for everyone who builds there.

**Frontmatter** comes only from the template and is asserted **byte-identical** in the output.
It is emitted unchanged to every target, even where a target's harness does not support a
field.

**The opening `---` must be the file's first line.** The rule is on the shape, not on its
causes: a `---` fence reached before the file's first non-blank content, in a file that did not
already open with one, is rejected — whatever put it off line 1. A UTF-8 BOM is the exception,
and is stripped rather than rejected, before anything else and in the stamp's byte-level twin as
well: a Windows editor or a PowerShell redirect writes one invisibly, and the file the author
sees should be the file the compiler reads. The reason to refuse the rest is that byte-identity
is enforced by comparing the template's frontmatter *region* against the output's: a file whose fence is not on line 1 has no
such region, every check guarding it passes vacuously, and a slot between the two fences becomes
ordinary body an override may fill. Refusing that shape closes the class rather than the
particular ways of reaching it.

## Public API

This table is the contract, not a status report: **`build`, `init` and `override` exist; `lint`
and `explain` do not.** The two that do not are specified here all the same — the README carries
the phase each is planned for, and running one prints that and exits non-zero.

| Command | Run by | Behaviour |
|---|---|---|
| `build [--check]` | the `SessionStart` hook, a `postinstall` a repo added itself, rarely a human | compiles every skill to every target. `--check` writes nothing and exits non-zero if the output is stale, if the last build had errors, or if this run's own config produced an error. |
| `init [--write\|--dry-run]` | consuming-repo maintainer, once | writes the config, the `.gitignore` lines, and the `SessionStart` hook entry. Diff-first: prints exactly what it would do, and writes nothing without `--write`. |
| `override <skill> <slot> [--write\|--dry-run]` | a developer | creates and seeds the override file for one slot in the highest-precedence override root, and prints the path. Writes by default; never overwrites a file that exists. |
| `lint` | a skills repo's CI | validates templates without building. Non-zero on any rejection. |
| `explain [<skill>]` | anyone, when confused | provenance: which source, which overrides are active, which slots exist and which are filled. |

**The two writing verbs default in opposite directions**, because they do different things.
`init` merges into files the repo already has and tracks, where the diff is the thing worth
seeing, so it writes nothing without `--write`. `override` only ever creates one file and refuses
to overwrite one that exists, so a dry run has nothing to protect and it writes by default. The
vocabulary is nonetheless shared: each verb accepts the other's flag as an explicit spelling of
its own default, and only the contradiction `--write --dry-run` is an error.

### `init`

Wires one repo up — the config file, the `.gitignore` lines covering the state directory and
every in-repo target, and the `SessionStart` hook entry in `.claude/settings.json`. It is
**idempotent**: a second run reports there is nothing to do.

**It writes only inside the repo it is run in**, and only those three paths. It never writes
another repo's settings; it never writes `.claude/settings.local.json` or the user-level settings
file, though it *reads* both, to warn that a hook already installed there would make every
session build twice; and it never writes `permissions.deny`, CODEOWNERS, `package.json`, or any
other file it cannot know is correct.

It **refuses to run at all**, writing nothing and exiting non-zero, when:

- the repo root it resolved **is the user's home directory**. There `.claude/settings.json` is
  Claude Code's *user-level* file, so a per-repo hook merged into it would run in every session
  in every repo. Compared by `realpath` as well as by text, since a home reached through an
  automount or a `/home` symlink is the ordinary case rather than the exotic one.
- the checkout uses **Yarn Plug'n'Play** — a `.pnp.cjs` or `.pnp.js` found anywhere from the repo
  root up to the git root, because a config in `packages/api` puts the repo root there while the
  file deciding whether `node_modules` exists sits at the top of the checkout. PnP has no
  `node_modules`, so the hook would be written, would silently never run, and no session would
  report it. Out of scope by decision, not by oversight.

It **warns and proceeds** where no `.git` was found at or above the repo root — "the repo" is
then that one directory, which is worth saying out loud — and where
`node_modules/composable-skills/dist/cli.js` does not exist, which is the same silent-hook
failure the PnP refusal exists to prevent, reached by not having installed yet or by a fresh
`git worktree` (see *The `SessionStart` hook*). Unlike PnP that is a state which ends by itself,
and it changes nothing about the string written, which must stay byte-stable whatever is on disk.

It **refuses one step rather than overwriting a file**, letting the other two proceed and exiting
non-zero, where that file is not writable by the process — `rename(2)` does not consult a mode,
so a mode that says *do not write me* has to be honoured deliberately — or where any component of
its path is a symlink, which is invariant 8 applied to a path that does not exist yet. No symlink
is followed, and where `.claude` is one the settings file it points at is not even read: a verdict
about the path outranks any verdict about contents. `.claude/settings.json` is refused for three
more reasons of its own — it is malformed, it is valid JSONC rather than JSON (a rewrite would
silently delete the comments), or it carries a `hooks` shape this tool does not recognise. And a
hook that already runs this tool under a *different* command string is reported and left alone
rather than duplicated, since two would build twice at every session start and only the developer
knows which string they meant to keep; that one exits 0, because nothing is broken.

What a merge preserves: every unrelated key, key order, the file's own indent width, its dominant
line endings, a leading BOM, and its mode.

### `override`

Creates the file that fills one slot, in the **highest-precedence override root** — the last
usable `overrides` entry, which is the one the resolution scan reaches first — and prints its
path alongside what the slot resolves to today. It **never overwrites**: an existing file is
reported, left byte-identical, and the run exits 0, because the developer asked for an override
file at that path and one is there.

An unknown skill, or an unknown slot, is an error that lists what does exist. A template that
does not compile is refused rather than seeded from, since the seed is that template's own text.
And the verb says so whenever the root it chose resolves **inside the repo**: the highest entry
is normally personal and outside the working tree, but `${home}/repos/${id}` goes inert where the
config declares no `id`, and the file then lands where git will offer it to the whole team.

#### What it seeds the file with

**The seed is what the slot resolves to today** — specifically the winning override file's *own*
lines, never the composed result. One rule, holding in both modes:

| | nothing currently overrides the slot | a lower-precedence root fills it |
|---|---|---|
| `mode=replace` | the template's default | that root's text |
| `mode=append` | empty | that root's text |

For `replace` the two are the same text, since it composes to the override alone. `append`
composes to *default, blank line, override*, so seeding the composed result would put the default
in the compiled skill twice — and with nothing yet overriding an `append` slot, the override half
is simply empty. That is why an `append` file starts empty: it is this rule applied, not an
exception to it. The default is shown either way — it is *in* the file for `replace`, and printed
beside the path for `append`.

**The property this exists for: an unedited `override` followed by a build produces a
byte-identical compiled skill, in both modes.** That is the whole reason seeding exists. It is
what defuses replace-by-default, by making a developer edit the text they are shadowing rather
than write blind into an empty file — and the text at risk is often the team's rather than the
template's, since a tracked override root is how a repo fills a slot for everyone who builds
there.

Seeded lines are trimmed at the block edges, so the new file is not necessarily byte-identical to
the file it was seeded from. The compiled output is, because the build applies the same trim.

## Build behaviour

**Failure is isolated per skill.** The build runs inside a fail-soft session hook, so a
rejection must never abort the run: a skill that fails validation keeps its previous output and
every other skill builds normally. The stamp records which skills failed and the diagnostics of
the last real build, so one broken template neither forces a full recompile of everything at
every session start nor goes quiet — a stamp-gated run **replays** those diagnostics, and an
error is re-reported every session until it is fixed. A replayed line is prefixed `[last build]`:
the report's main consumer is a model reading a session hook's stdout, and stored text must never
pass for something the tool just observed. A run that found the lock held replays them too, for
the same reason — it compiled nothing, so the last real build is still the truth about the tree.

**Rejected** (that skill only): unknown directive, a directive lookalike, or leftover directive
syntax in the output; a malformed `slot` directive — an invalid slot name, or an attribute other
than `mode=replace|append`; a `<!-- /slot -->` closing no open slot; frontmatter opened with
`---` and never closed, or a `---` fence that opens the file only after one or more blank lines;
a template that cannot be read, or an `include:` naming a fragment that
cannot be read; a slot declared in the frontmatter region; emitted
frontmatter not byte-identical to the template's; an `include:` resolving outside its own source
root, or an override resolving outside its own override root — by `..`, by a symlink hop, by a
symlinked override root, or by naming something other than a regular file; merge-conflict
markers in any compiled input — a
template, an included fragment, or an override file; a duplicate slot name within one skill; a
`SKILL.md` or an ownership marker, in any case, in the source skill directory, which would
collide with what the compiler writes.

**Fatal (nothing is built).** Per-skill isolation has one limit: the config is what says where
the skills *are*, so a config the tool cannot make sense of leaves it with nothing to isolate.
Five conditions abort the whole run — nothing is compiled, nothing is pruned, no stamp is
written, and the previous output is left exactly as it stands:

- the config file exists but cannot be read;
- it cannot be parsed as JSONC;
- it does not parse to a JSON object;
- `id` is present but is not a non-empty string, or is not a single path segment of
  `[A-Za-z0-9._-]`, or is `.` or `..`;
- `sources`, `overrides`, or `targets` is present but is not an array of strings.

The distinction is between a config the tool cannot read and a config entry it cannot use: a
single unusable *entry* — a missing source root, a `${home}` escape, an unknown key — is a
warning or an error against that entry alone and the run proceeds. A fatal config still exits 0
under `build`, because the build runs inside a fail-soft session hook; `--check` exits non-zero.
It is reported on all three channels like anything else — the state directory's location is
recovered from the repo root rather than the config, precisely because a fatal config is the
likeliest real failure in the context the file channel exists for.

**Warned**, among others — the list below is illustrative, not the enumerated set:

- *config* — an unknown key; an empty entry in any list; an entry using `${id}` where no `id` is
  declared; a `sources` entry that resolves to no package; a `sources` root that does not exist;
  no usable source root at all; no targets configured.
- *discovery and compilation* — a directory holding a `SKILL.md` or a `*.tmpl` but no
  `SKILL.md.tmpl`; a skill directory that is a symlink, which is not followed; a template or a
  skill directory that cannot be read; a skill name colliding across sources; a symlink inside a
  skill directory, which is not copied; an override file matching no declared slot; an override
  file that cannot be read; a template using a frontmatter field a configured target does not
  support (see *Targets*).
- *writing and pruning* — a directory of that name that exists and carries no marker, left
  untouched; a stale directory that cannot be removed; nothing pruned this run because the
  corpus could not be enumerated in full, or because the config resolved to no source root at
  all while the stamp still remembers compiled skills.
- *locking* — another build holds the lock, so nothing was built; the state directory cannot be
  written, so the build proceeds unlocked.

The organising principle: **reject when the output would be wrong or unsafe; warn when the
input is probably a mistake.** A developer's typo never breaks a build. A conflict marker
reaching the model always does.

**A target that did not exist before the run is named in the summary**, where anything was in
fact built. A skills directory that was not there when the session started is not picked up, so
those skills become available only in the next session — the fresh-clone case ADR-0001 records.
It is a summary line rather than a per-skill diagnostic because it is information about the
session and not a fault, and a warm repo stays silent, which is what makes it mean something when
it appears.

**Diagnostics go to stdout, stderr, and a file** — stdout so the agent can report it, stderr for
a human running the command, and a file because the first two are frequently unread. `init` and
`override` print their own output to the two streams only: the build log is the record of the
last *build*, and a human-run verb whose answer is already on their terminal has no claim on it.

Two qualifications. **Where the two streams name one destination, only stderr is written**, so
nothing is said twice: the test is whether the descriptors share a `dev`/`ino`, not whether they
are a terminal. A terminal is only the familiar case; `> log 2>&1`, `npm postinstall`, and a hook
capturing combined output are the ones that matter, because there the duplicate is what the
reader keeps. Where the descriptors cannot be `fstat`'d the old both-a-TTY test stands in —
inside a fail-soft hook, saying something twice beats not building. And **`--check` writes no
file**, the single exception being a crash escaping the build: the log is then the only channel
that survives, so it is written whatever the flags said. The log is created `0600`, since it
quotes template and override text.

### Ownership and pruning

The tool records what it wrote by leaving a marker file (`.composable-skills-owner`) inside every
skill directory it emits. **Overwriting and deleting are governed separately**, because a target
may be shared:

- **Overwrite** — any directory carrying a valid marker may be rewritten, whichever repo wrote
  it. An **unmarked** directory never is: a build that would have written a skill of that name
  warns and moves on, so a hand-written skill sitting in `.claude/skills/` is safe.
- **Prune** — only a directory whose marker names *this* build is removed, and only once its
  skill no longer exists in any `sources` root. A foreign marker, or one that will not parse, is
  not this build's to delete. That is what makes a shared target such as `~/.claude/skills`
  usable: two repos writing there do not erase each other. Two repos publishing a skill of the
  *same name* still collide on content, last writer wins; the tool does not arbitrate that.
- **A build identifies itself by `id`** where both the marker and the current config declare one,
  and by repo root path otherwise. With no `id`, a worktree therefore does not recognise the main
  checkout's output and declines to prune it — the conservative direction, and one more reason
  invariant 5 wants `id` declared.
- If the source corpus could not be enumerated end to end, **nothing is pruned for that entire
  run** — a source root that did not resolve, one that cannot be read, a skill directory whose
  template cannot be read, or a skill directory that turned out to be a symlink. What the build
  could not read is indistinguishable from what was deleted upstream.
- **Zero usable source roots plus a stamp that remembers skills is not an emptied corpus**, and
  nothing is pruned. A corpus genuinely emptied one template at a time never reaches zero
  *roots*; a config that lost its `sources` key does, and pruning on that reading would delete
  every compiled skill on the machine. The build warns and names what it declined to remove.

Pruning is the only destructive operation the tool performs, and it is what stops a renamed or
removed template leaving a stale skill in front of the model forever. Each of the guards above
is a case where "this skill is gone" and "I could not see this skill" are the same observation,
and the tool always reads it the second way.

**One build at a time, where it can be.** A build holds a lock in the state directory; a second
build that finds it held warns, compiles nothing, leaves the existing output untouched, and
exits 0. The lock is best-effort: where the state directory cannot be written the build warns and
proceeds **unlocked**, because refusing to build over a lock it could not take is the worse
failure. **Only an `EEXIST` on the lock directory itself reads as *held*.** Every other
state-directory failure of every errno — including the state directory existing as a regular
file — reports as *unlocked* and builds. The two were once the same error, and reading that one
as "held" wedges the repo permanently: every session reports a lock that does not exist and
compiles nothing. A lock left
behind by a crashed or killed build is detected and broken automatically, for the same reason: a
build can never wedge permanently. `--check` never takes the lock, since it writes nothing.

The **state directory** is `.composable-skills/` at the consuming repo's root, holding the
stamp, the build log, and that lock. Like compiled output it is generated, never tracked.

## The `SessionStart` hook

`init` writes a hook that runs `build` on every session start, as one command string:

```
node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build
```

**`$CLAUDE_PROJECT_DIR` is written literally, not resolved.** Claude Code expands it at session
start. The reason it is not resolved is that `.claude/settings.json` is a **tracked** file: an
absolute path would be committed, and would be wrong for every other clone on the team. The hook
group carries no `matcher`, so it runs for every session source — `resume` and `clear` can have
output just as stale as `startup`.

**A `git worktree` needs its own install.** `git worktree add` produces a tree with no
`node_modules`, so the path above does not exist there and the hook fails at every session start
— silently, because it is fail-soft. Overrides survive a worktree by design, since they are keyed
on the declared `id` rather than on a path; the *hook* does not, and installing this package in
the worktree is what fixes it. `init` warns when that file is missing, and does not vary the
string it writes, which must stay byte-stable whatever is on disk today.

1. **A content-hash stamp is compared first.** The hashed inputs are the tool version, the
   declared `id`, every configured root's spec *and* the path it resolved to, the config file's
   own bytes, and the full contents of every source and override tree — with a symlink's
   destination recorded rather than followed, since retargeting one changes what the build
   refuses to do. A matching hash is **necessary but not sufficient**: the stamp also records a
   content hash of every `SKILL.md` it emitted, and each is re-read and re-hashed before the gate
   closes, so editing or deleting a compiled skill by hand rebuilds it with the stamp intact.
   Only `SKILL.md` is hashed — a `references/` tree dominates corpus bytes, and hashing it would
   put the gated path's cost back where the stamp exists to avoid it. A skill that failed carries
   its *previous* hash forward rather than dropping to none, so it stays integrity-checked while
   it is broken; a record of no output at all is honoured only where no output is in fact there.
   A `failed` list therefore cannot hide a file from the check, and **a record that verifies
   nothing gates nothing** — if no skill hashes clean the build runs, which is what closes a
   crafted stamp, since claiming every skill failed is the cheapest way to claim there is nothing
   to check. A gated
   run is not a silent one — it replays the last real build's diagnostics, and it still writes
   the log.
2. **The build stages each skill in a temp directory inside the target** and swaps it into place
   on success, so a failed build never destroys the last good output.
3. **It exits 0 unconditionally**, including on failure.
4. **The command string is byte-stable.** Codex pins hook trust to the hash of the command
   string, so any change re-prompts every developer. All logic lives in the tool, never in
   flags — and nothing about the string varies with what is on disk when `init` runs.
5. **No dynamic `import()`** of any path derived from template or config content.

## Constraints and invariants

1. **Emitted frontmatter is byte-identical to its template's.** The only rule the tool enforces
   about *what the output says* — the rejections elsewhere are about inputs the compiler cannot
   safely process. It exists because `allowed-tools` grants tool access with no workspace-trust
   gate and `hooks` registers session-long hooks with no dialog. An override is structurally
   incapable of reaching either — by position, not by policy. See
   [ADR-0001](../decisions/0001-build-time-composition.md).
2. **The template is the trust boundary.** Tracked, reviewable, its author's responsibility.
3. **The config file never carries content.**
4. **A slot's mode affects only that slot's own default** and can reach no other text.
5. **`id` is declared, never derived from a path.**
6. **Nothing generated is tracked.** A convention `init` supports rather than a property the
   tool enforces: it offers the `.gitignore` lines and cannot do more (see *Not in the
   contract*).
7. **The tool never writes outside the repo it is run in, except to the configured override and
   target roots.**
8. **No symlink is ever followed or copied, and none is followed silently.** One containment
   discipline covers `include:` and overrides alike — every path component is `lstat`'d and any
   symlink hop rejects, an override root that is itself a symlink included. A symlink inside a
   skill directory is warned about and skipped rather than copied. A symlinked skill directory is
   not discovered as a skill, warns, and blocks pruning for that run — its compiled output would
   otherwise be deleted as a skill that no longer exists. And the stamp records a symlink's
   destination without reading through it, since retargeting one changes what the build refuses
   to do. The single exception is a source root's own last component, where a symlinked package
   directory is ordinary under pnpm and workspaces.
9. **Every diagnostic names a file, and a line that exists in that file.** Splicing a fragment
   moves text between coordinate spaces, so every line carries the file and line number it
   actually came from, and a diagnostic is reported in those terms — never in the expanded
   body's coordinates, which are nobody's file.

## Not in the contract

The tool does not choose how a skills repo delivers skills to other repos, generate plugin or
marketplace manifests, enforce `.gitignore`, track override staleness, or protect guardrail text
from a slot placed after it. `init` writes exactly one `settings.json` — the tracked
`.claude/settings.json` of the repo it is run in, and only its `hooks.SessionStart` entry. No
other repo's, not the user-level file, not `settings.local.json`, and no other key in any of
them.

## See Also

- [`docs/decisions/0001-build-time-composition.md`](../decisions/0001-build-time-composition.md) — why
- [`docs/plans/composable-skills-tooling.md`](../plans/composable-skills-tooling.md) — sequencing
- [`docs/CONTEXT.md`](../CONTEXT.md) — glossary
- [`docs/staging/qa-composable-skills-tooling.md`](../staging/qa-composable-skills-tooling.md) — evidence
