# `composable-skills` tool contract

## Overview

`composable-skills` is a node CLI that compiles skill templates into `SKILL.md` files and
writes them where an agent harness will find them. It ships no skills.

A **consuming repo** installs it and is either a **skills repo** (skills are its deliverable)
or a **project repo** (skills describe its own code). The tool behaves identically for both —
only the configured targets differ. A **wrapper package** may depend on the tool and ship its own
templates; a consuming repo reaches those templates by naming the package in `sources`.

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
| `id` | Stable identity for this repo. **Declared, and resolved from the declaration alone** — no verb ever derives it from the path it is run in, which is what makes a worktree at `.claude/worktrees/feat-x` and the main checkout one repo that resolves one set of overrides. `init` *seeds* a fresh config from the directory name, and says beside the value that it did: a seed is a starting point, not an identity, so two unrelated repos both cloned as `api` are seeded alike and would collide — where that matters, changing the declaration is the developer's to do and nothing later re-derives it. It is interpolated into a path, so it must be a single path segment of `[A-Za-z0-9._-]`, and neither `.` nor `..`; a violation is **fatal**. |
| `sources` | Template roots. Each entry is resolved as an installed package or as a path. |
| `overrides` | Override roots. Scanned in reverse, so a later entry takes precedence. |
| `targets` | Output directories. All are written on every build. |

`${home}` is `${XDG_CONFIG_HOME:-~/.config}/composable-skills`, relocatable via
`COMPOSABLE_SKILLS_HOME`. The two personal roots are siblings — `${home}/global` and
`${home}/repos/<id>` — so no path is ambiguously interpretable as either. An entry containing
`${id}` is skipped where the config declares no `id`: an **error** for a `sources` entry, which
names a source the tool cannot use, and a **warning** for an override or a target, which leaves
the default `${home}/repos/${id}` root inert until one is declared — the designed behaviour of a
shipped default rather than a mistake. An entry that spells `${home}` is asserted to resolve
*inside* it, and the question is asked twice: of the resolved text, which catches a `..` that walks
out lexically, and of the **real** path, which catches an entry that leads out through a symlink.
Either escape drops that entry with an error — that entry only, not the run — in any of the three
lists: a source read from outside `${home}`, an override read from outside it, and a target written
outside it are one mistake wearing three hats. This is the one check that reaches a named root's
own last component, which nothing `lstat`s (see [invariant 8](#constraints-and-invariants)). A
leading `~` or `~/` expands to the home directory in any entry; a `~/…` entry names no root to be
contained by and so carries no containment check.

Defaults: `sources` empty, `overrides` as shown, `targets` `["./.claude/skills"]`.
**Every consuming repo writes this file itself.** Discovery walks *up* from the working directory
and stops at the first `.git`, so a config shipped inside `node_modules/<pkg>` is never reached; a
package's entire contribution is the one `sources` entry the repo adds. The empty `sources`
default is what makes a repo with no config inert — it compiles nothing rather than guessing.

**A `sources` entry that is not path-like is an installed package.** The entry is split on `/`
and `\` alike — a Windows separator names the same subpath, and splitting on `/` only would let
`skills\templates` through as a bare package name whose subpath is never resolved at all — into a
package name (two segments where it is scoped, one otherwise) and an optional subpath. The name
resolves by walking the `node_modules` chain from the repo root upward — `<dir>/node_modules/<name>`,
first directory carrying a `package.json` winning — and by nothing else. `main` and `exports` are
never consulted: a templates-only package has no entry point, so module resolution is the wrong
instrument. A directory of that name carrying no `package.json` is not a package, and the walk
continues past it rather than stopping there — recording it as a level it stepped over, since
something that is there and is not a package is a broken install rather than an absence. Node's
global fallbacks — `~/.node_modules`, `~/.node_libraries`, `/usr/lib/node` — are deliberately not
honoured, so a globally installed package cannot become a source of skills; that is the same
stance the tool takes on installing itself. The walk may find the package *above* the repo root,
which is what makes a workspace child with a hoisted dependency work; the walk only reads, so
nothing is written outside the repo.

Two things are refused rather than resolved. Each has its own diagnostic, each is an error, and
each skips that entry alone:

- **Not a package name.** A scoped name is `@scope/name`; no segment may be empty, `.` or `..`;
  and the name path joined to `<repoRoot>/node_modules` is asserted — lexically, once, before
  anything is stat'd — to still be under it. That assert is the durable form of the segment rules,
  since it stays answered however a platform's `path.join` reads what it is handed, and a
  violation reports as the same not-a-package-name failure.
- **A subpath that does not resolve.** Where the entry names one — `@acme/skills/templates` — it
  is resolved under the same containment discipline as `include:`: the package root is
  `realpath`'d once, every component is `lstat`'d with any symlink hop refused, the result is
  asserted to be inside the package, and it must be a directory.

A third thing is **stepped over rather than refused: a level of the chain the walk took no answer
from.** `<dir>/node_modules` and every component of the name *bar the last* are `lstat`'d, and one
that is a link, or that this process cannot read, is not looked *through*. Neither is a level that
is there and is not a usable package — a directory carrying no readable `package.json`, which is a
dangling workspace link or a half-restored cache rather than an absence. In each case the walk
carries on to the level above, because a link at one level says nothing about the level above: so
the entry still resolves where a higher `node_modules` holds the package, and fails only where none
does. Which paths here may be a symlink and which may not is
[invariant 8](#constraints-and-invariants)'s table of routes; what is *said* about a level that was
stepped over is settled below.

**Where the entry resolved, a stepped-over level is confirmed before anything is said about it.**
The tool `stat`s *through* the level, purely to ask whether a copy of the package is sitting behind
it. That opens no compile path — the answer picks a diagnostic, and nothing is ever read from what
it found — so invariant 8, which governs what a build reads into its output, is untouched.
Resolution itself still refuses to look through such a level; what compiles is not changed by
asking. Four outcomes:

- a package really is behind the level: a **warning** naming both the path the entry resolved to
  and the nearer copy, and saying that the nearer copy would have won — so this build is not
  compiling the one installed for this repo;
- nothing is behind it: **silence**. Invariant 8 asks that no symlink be walked past *silently*,
  and where the confirming `stat` finds nothing behind the level there is nothing that was passed
  over. The ordinary pnpm and shared-`node_modules` layouts are this case, which is what makes the
  warning above mean something when it does appear;
- the level itself is what cannot be read: a **warning** saying so — that whether a nearer copy is
  installed behind it could not be checked — rather than asserting a copy nobody saw;
- the level is an entry that is not a usable package **in this repo's own `node_modules`**: a
  **warning** naming it as this repo's own install of the package and pointing at a reinstall. The
  same shape above the repo root is silent, deliberately: an ancestor's install is governed by no
  lockfile this developer controls, so naming it names them no action.

**A level that confirms as anything but harmless leaves the run incomplete**, and an incomplete run
prunes nothing (see *Ownership and pruning*): the corpus that resolved may not be the corpus that
exists, and a substituted package with no skills of its own must not take the compiled skills with
it. The three outcomes that speak are warnings, so `--check` still exits 0 and the suppressed
prune is the only other consequence.

**Where the entry resolved nowhere, nothing is confirmed and every stepped-over level rides as a
warning under the failure.** There is nothing to confirm: the note claims only that a copy
installed behind the level was not considered, which holds whether or not one is there. The
headline is never the skipped level — it is the ordinary not-installed error, or, where a level
could not be read, an error saying *that* rather than asking whether the package is installed,
missing and unreadable being kept apart here as they are everywhere else, since a directory this
build was refused entry to is not a package the developer forgot to install.

**The path a source root resolves to is normalised by its shape**, which is worth stating because
that path is hashed into the stamp and printed in every diagnostic naming the root. A bare package
entry keeps the path the walk built, `<dir>/node_modules/<name>`, symlinks and all — resolving it
further would undo the exemption that let it resolve. A subpath entry keeps `realpath`'s answer,
because the containment discipline resolves before it asserts. A path entry is resolved lexically
against the repo root and `realpath`'d nowhere. So under pnpm one install reports a path inside the
repo's `node_modules` when named bare and a path inside the store when named with a subpath; and
re-spelling a `sources` entry from one form to the other changes the stamp and costs one
rebuild.

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
collision and is simply consumed — **in any case** as well, and for the same reason: where
`skill.md.tmpl` is the file that was found and compiled, an exact-case reading would not
recognise it as the template and would copy it verbatim, putting the raw slot and include
directives into the emitted skill directory beside the `SKILL.md` compiled from them. A symlink
inside a skill directory is not copied, and warns; a skill directory that is *itself* a symlink
is not followed, since following it would read a template from outside every configured source
root. Where that directory holds a template or otherwise looks like a skill, the refusal is said
out loud — it warns, and blocks pruning for that run, because what was refused may be a skill
some target still holds output for. Where nothing about it looks like one, it is skipped as
silently as any other directory without a template, since there is nothing to have lost.

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
simply falls through to the next. **A root, or a file, that exists but cannot be read is a
different observation**, and is warned about. The scan still falls through, so no lower-precedence
root is abandoned and the compiled skill is what it would have been; but existence and readability
are separate questions, and a slot quietly losing the override meant to fill it is exactly what a
diagnostic is for. Not finding a file and not being able to read one must never reach the model as
the same silence. Containment is asserted on the paths it does find, the same way
`include:` is: every component of `<root>/<skill>/<slot>.md` is `lstat`'d, and an override that
escapes its root by `..` or a symlink hop, or that names something other than a regular file,
rejects the skill. An override root whose own last component is a symlink is rejected too —
containment is asserted against the root's `realpath`, so a symlinked root would widen silently to
wherever it points. That is the one root a config entry named that the tool checks anyway; which
other paths may be a symlink, and what happens to each that may not, is
[invariant 8](#constraints-and-invariants)'s table of routes.

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
| `build [--check]` | the `SessionStart` hook, a `postinstall` a repo added itself, rarely a human | compiles every skill to every target. `--check` writes nothing and exits non-zero if the output is stale, if the last build had errors, or if this run produced an error of its own — from its own config (an entry it cannot use) or from discovery (a source root that resolved but cannot be read). A skill the build declined to write, because a target held something that was not this tool's to replace, is not stale output: the decline is reported and `--check` still exits 0 unless something else failed. Neither is a source that resolved to a copy the build cannot vouch for — a warning, whose one consequence is that the run prunes nothing. |
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
so a mode that says *do not write me* has to be honoured deliberately — where any component of
its path is a symlink, which is invariant 8 applied to a path that does not exist yet, or where
the file **exists but cannot be read**: a merge is defined against the text already in the file,
and a step that cannot see that text can only overwrite it. No symlink is followed, and where
`.claude` is one the settings file it points at is not even read: a verdict about the path
outranks any verdict about contents.

**Existence is decided by `lstat`, never by a successful read.** A read that failed is otherwise
indistinguishable from a file that is not there, and reading it that way costs two things at once:
the unwritable refusal goes unreachable for exactly the files it was written for, since a mode
that refuses a read usually refuses a write too, and the diff-first promise turns false, as the
dry run announces it is *creating* a file that is already there. All three refusals are scoped to
**the three paths `init` writes** — the config file, the `.gitignore`, and the repo's tracked
`.claude/settings.json`. They do not reach the two files it only reads,
`.claude/settings.local.json` and the user-level settings file, where one that cannot be read
costs a warning that the duplicate-hook check could not be made, and nothing more: refusing to
write a file this tool never writes would be a refusal about somebody else's permissions.

`.claude/settings.json` is refused for three more reasons of its own — it is malformed, it is
valid JSONC rather than JSON (a rewrite would silently delete the comments), or it carries a `hooks` shape this tool does not recognise. And a
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
markers in any compiled input — a template, an included fragment, or an override file — meaning a
`<<<<<<<` or `|||||||` line anywhere in it, and a `=======` or `>>>>>>>` line below a `<<<<<<<` in
that same input; a duplicate slot name within one skill; a
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
warning or an error against that entry alone and the run proceeds. Which of the two is not
arbitrary: **a source the tool cannot use is an error**, whether it is named as a package or as a
path. That covers a `sources` entry that is not a package name at all; one naming a package found
in no `node_modules` from the repo root upward, and one where a level of that chain could not be
read, so whether the package is installed there was not a question this build was allowed to ask;
one whose subpath is absent, refused for a symlink hop, cannot be read, or is not a directory; a
`sources` path root that does not exist; a `sources` entry using `${id}` where no `id` is declared;
and — the same rule reaching into discovery — a source root that resolved but cannot be read. A
repo that has silently lost skills it asked for must not report success on `--check`, the one
channel a human or a CI job reads.

The rule has an exception at each end. An **empty** entry only warns, in `sources` as in the other
two lists: an empty string names nothing that could be unusable, so there is no source to have
lost. And an entry spelling `${home}` that resolves outside it is an error in **any** of the three
lists — not by this rule but by containment, which is not a `sources` question. Everything else at
entry level warns, *no usable source root at all* included: that line still has to cover a config
declaring no sources, which is the inert default rather than a mistake. **A named source is
therefore a hard dependency of the build** — a repo that installs without devDependencies must not
name one.

**Severity is `--check`'s vocabulary, and `--check` is the only thing that reads it.** `build`
exits 0 whatever it reported. `init` and `override` load the same config and print its
diagnostics — all but the source-root-contains-output warning below, which is a statement about
what the next build's stamp will hash and so is reported by `build` alone — but neither consults
their severity: `init` exits non-zero only where it refused a step, `override` only where it could
not create the file it was asked for. So a second `init` in a
repo it has already wired up prints `error source root "./skills/templates" does not exist` — about
the directory the config it wrote invites the developer to create — and exits 0, having done its
own job. The word grades the observation, not the verb's outcome.

A fatal config still exits 0 under `build`, because the build runs inside a fail-soft session
hook; `--check` exits non-zero. It is reported on all three channels like anything else — the state directory's location is
recovered from the repo root rather than the config, precisely because a fatal config is the
likeliest real failure in the context the file channel exists for.

**Warned**, among others — the list below is illustrative, not the enumerated set:

- *config* — an unknown key; an empty entry in any list; an override or target entry using
  `${id}` where no `id` is declared; no usable source root at all; no targets configured; a level
  of a package entry's `node_modules` chain that was stepped over — where the entry resolved, only
  once a `stat` through the level confirmed a nearer copy of the package, a level that could not be
  checked, or an entry that is not a usable package in this repo's own `node_modules`; where it
  resolved nowhere, every stepped-over level, as context beneath the error; and — reported by
  `build` alone, being about a build and nothing else — a source root that contains a target root
  or the state directory: both are
  written by the build and hashed as inputs by the next one, so a build recompiles when nothing
  changed, and where the build state is inside a source root `--check` reports stale forever.
- *discovery and compilation* — a directory holding a `SKILL.md` or a `*.tmpl` but no
  `SKILL.md.tmpl`; a skill directory that is a symlink holding a template or otherwise looking
  like a skill, which is not followed; a template or a skill directory that cannot be read; a
  skill name colliding across sources; a symlink inside a skill directory, which is not copied;
  a `=======` or `>>>>>>>` line with no `<<<<<<<` above it in the same input, which is either a
  hand-resolved conflict's remnant or legal Markdown and cannot be told apart from the line alone;
  an override file matching no declared slot; an override file, or an override root, that exists
  but cannot be read — distinct from a root that simply
  does not exist, which is the ordinary fall-through and not a diagnostic; a template using a
  frontmatter field a configured target does not support (see *Targets*).
- *writing and pruning* — a directory of that name that exists and carries no marker, left
  untouched; an entry of that name that is a symlink, left untouched and not read through; a
  target holding a compiled skill of this build's name under another build's marker; a stale
  directory that cannot be removed; a target directory that exists but could not be enumerated,
  so nothing in it was considered for pruning; nothing pruned this run because the
  corpus could not be enumerated in full or a source resolved to a copy the build cannot vouch
  for, or because the config resolved to no source root at all while the stamp still remembers
  compiled skills.
- *locking* — another build holds the lock, so nothing was built; the state directory cannot be
  written, so the build proceeds unlocked.

The organising principle: **reject when the output would be wrong or unsafe; warn when the
input is probably a mistake; and decline, with a warning, when something already in a target is
not this tool's to replace.** The first two classify *inputs*; the third classifies what the
build finds standing where it is about to write, which is neither the developer's mistake nor a
reason to fail that skill everywhere else. A developer's typo never breaks a build. A conflict
marker reaching the model always does — with one carve-out. A `=======` or `>>>>>>>` line with no
`<<<<<<<` above it in the same input is warned rather than rejected, because each of those two
lines is also legal Markdown — a setext H1 underline, and a seven-deep blockquote — and the scan
reads one input at a time, so from the line alone it cannot tell a hand-resolved conflict's
remnant from a correct document. Rejecting there failed builds over correct documents, which is
the worse trade: the warning still names the line, so nothing reaches the model unremarked, and it
spells out both readings for the one person who can settle which it is. And an unmarked directory,
or a symlink, occupying the place a compiled skill would take keeps that place — the build says so
and writes the skill to every other target.

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

**Every report line is normalised to one line as it is rendered.** A diagnostic quotes template,
override and marker text, replays messages read back from the stamp, and names skills after
directories on disk — none of which this tool wrote. `build` runs at `SessionStart` and its
stdout is fed to a model as instructions, so borrowed text carrying a newline could forge a line
that reads as the tool's own report. Line terminators, control characters and format characters
are escaped to a visible `\n`, `\r` or `\uXXXX` at the single point every channel renders
through; tab is left alone, since it cannot start a line. It is a display rule and not a
validation one — nothing is dropped, and what was quoted stays readable.

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
  warns and moves on, so a hand-written skill sitting in `.claude/skills/` is safe. **An entry
  that is a symlink is never rewritten either, and no marker is read through it**: the entry is
  `lstat`'d and recognised as a link before anything about its destination is consulted, and the
  build warns and moves on exactly as it does for an unmarked directory. A marker found by
  following the link would be a claim about the link's *destination*, and the question asked here
  is whether this entry, in this target, is the tool's to replace. The warning names it as a
  symlink, which is invariant 8's requirement that none is ever followed *silently*.
- **Prune** — only a directory whose marker names *this* build is removed, and only once its
  skill no longer exists in any `sources` root. A foreign marker, or one that will not parse, is
  not this build's to delete. That is what makes a shared target such as `~/.claude/skills`
  usable: two repos writing there do not erase each other. Two repos publishing a skill of the
  *same name* still collide on content, last writer wins; the tool does not arbitrate that, but
  it does **name it**. Where a target holds a compiled skill of a name this build also publishes,
  carrying a marker that names *another* build, the stamp check reports the collision and the
  owner it found rather than bare staleness. Neither build's stamp can verify that file, so each
  recompiles in full at every session start, indefinitely — the accepted cost of not arbitrating.
  Saying whose marker is on the file is what turns a permanent unexplained rebuild into something
  a developer can act on. The foreign content never gates a build: its hash is not the recorded
  one, so the record does not describe the disk.
- **A marker's fields are read as untrusted text, and what makes a file a marker is a closed
  list.** It is written by another build — that is the point of it — so `id` is a string this
  tool never validated and `repo` a path it never resolved, and the collision warning above
  quotes whichever of them names the owner. A file at that path is a marker only where it is a
  regular file, no larger than a marker could be, that this build could read end to end, and that
  parses as a JSON object that: names this tool, in a `tool` field spelled exactly
  `composable-skills`; carries a `skill` that fits the name of the directory it sits in — equal to
  it, for the directory a compiled skill stands in — since a marker naming some other skill was
  copied there rather than written there; and declares at least one of `id` and `repo`, because a
  marker naming no owner at all would otherwise make an unmarked directory overwritable. A field of either longer than a path can be is not that
  field — that length is the bound on how much borrowed text one warning can put in front of a
  model — so where the one that remains names nobody the file is not a marker. A declared `id`
  outside the shape invariant 5 requires is not an `id`, and where `repo` is then absent too the
  file names nobody and is not a marker. **Regular file** is the whole of what is
  read: an entry of that name that is a symlink, a FIFO, a socket or a directory is refused on the
  `stat` before anything opens it — which is also what keeps a named pipe planted in a shared
  target from blocking a build that would otherwise wait for a writer. **No larger than a marker
  could be** is a bound taken from those same field bounds, so a file over it is padding around a
  marker rather than one, however valid the JSON inside it; and a file that cannot be opened or
  read is simply a file this build has learnt nothing from. Anything failing that list reads as
  **unmarked**, the conservative end, so the directory is neither overwritten nor pruned.
  **The scratch sweep below asks that same list with the one clause put differently.** A scratch
  directory's name is not a skill name and can never be equal to one, so where such an entry is
  being weighed, `skill` fits the name by the name being one this build's own naming would have
  produced for the skill declared — `<prefix><skill>-<suffix>`. It is the same question the
  equality asks, put to the only name a scratch directory has, and it is asked for the same
  reason: a marker copied out of any owned skill directory into any scratch name would otherwise
  hand this build the right to delete it. `skill` is weighed against a name either way and never
  taken on the field's own word, which is what keeps it bounded by a filename rather than by
  nothing — the reading the size bound above rests on. Every other clause of the list is
  unchanged.
  **A control character is not one of the failures.** `skill` is a directory name and `repo` a
  repo root: both are copied from the filesystem rather than chosen, and a TAB, a ZWJ or a soft
  hyphen is legal in either — so refusing one here would void markers this tool had just written
  itself, leaving skill directories it had compiled a moment earlier neither rewritable nor
  prunable, under a warning blaming the developer for them. Keeping borrowed text from forging a
  line is the renderer's job and not the reader's: **every report line is normalised to one line
  as it is rendered**, stated above and applied at the single point every channel renders through,
  so no field quoted from a marker can end a line or move a cursor. **The marker file is opened
  without following a symlink**, and a link at that path reads as unmarked for the same reason —
  invariant 8 one level below the skill directory it already covers, since what the link named
  would otherwise be read as a claim about *this* directory.
- **A build identifies itself by `id`** where both the marker and the current config declare one,
  and by repo root path otherwise. With no `id`, a worktree therefore does not recognise the main
  checkout's output and declines to prune it — the conservative direction, and one more reason
  invariant 5 wants `id` declared.
- If the source corpus could not be enumerated end to end, **nothing is pruned for that entire
  run** — a source root that did not resolve, one that cannot be read, a skill directory whose
  template cannot be read, or a skill directory that turned out to be a symlink *and* held a
  template or otherwise looked like a skill. What the build could not read is indistinguishable
  from what was deleted upstream. A symlink with nothing skill-shaped behind it is not that case:
  it is a directory this build would have skipped whether or not it was a link, so it leaves
  pruning alone. **A source root that resolved doubtfully counts the same way**: where the walk
  stepped over a level a nearer copy of the package could have been sitting behind, the corpus
  that resolved may not be the corpus that exists, and a substituted package with no skills of
  its own would otherwise empty the target.
- A **target** that exists but cannot be enumerated is that same observation pointed the other
  way, and **nothing in that target is pruned** — the build warns, naming the target, and goes on
  writing to the others. The scope differs because the cause does: a source root that cannot be
  read leaves the corpus unknowable for every target at once, while a target that cannot be read
  says nothing about any other. A target that does not exist at all is not this case; there is
  nothing there to prune, and nothing to say.
- **Zero usable source roots plus a stamp that remembers skills is not an emptied corpus**, and
  nothing is pruned. A corpus genuinely emptied one template at a time never reaches zero
  *roots*; a config that lost its `sources` key does, and pruning on that reading would delete
  every compiled skill on the machine. The build warns and names what it declined to remove.

Pruning is one of the two destructive operations the tool performs, and it is what stops a
renamed or removed template leaving a stale skill in front of the model forever. Each of the
guards above is a case where "this skill is gone" and "I could not see this skill" are the same
observation, and the tool always reads it the second way.

The other is the **scratch sweep**, which runs in the same pass. A build stages each skill in a
temp directory inside the target and swaps it into place, parking the live output under a second
scratch name for the length of the swap; a build that dies between those steps leaves one of
those directories behind, and nothing else would ever remove it. They are named
`.composable-skills-tmp-<skill>-<suffix>` and `.composable-skills-old-<skill>-<suffix>`, and
neither is ever a compiled skill, so the question the pruning rule asks — does this skill still
exist in a `sources` root — is not asked of them and the keep set is not consulted. Every guard
above that blocks pruning for a run still stops the sweep, since it is that same pass: a build
that could not enumerate the corpus, or could not read a target, sweeps nothing there either, and
the litter waits for a run that can. It deletes, so it is gated instead on four things, **all**
of which must hold:

- The entry is **not a symlink**. Nothing is read through one, and a marker found by following
  one would be a claim about its destination rather than about this entry — invariant 8 again.
- It carries a **marker that names this build**, read by the closed list above and matched by
  declared `id`, or by repo root where either side declares none, exactly as pruning matches one.
  A foreign marker, or none at all, is not this build's to delete: two repos sharing
  `~/.claude/skills` each leave scratch there, and a build of the other one killed between the
  two renames leaves behind the only copy of its last good output.
- That marker's `skill` **fits the entry's own name**, by the scratch reading given above — the
  name is one this build's own naming would have produced for the skill the marker declares.
- The directory is **older than an hour**, dated by the creation time recorded in its name, and
  by `mtime` only for a name that records none — every scratch name written before the tool
  recorded one, and nothing it writes today. `rename(2)` preserves `mtime`, so a parked copy
  inherits the age of the output it was made from and would otherwise read as stale the instant
  it was created. The window is what keeps the sweep off a concurrent build's staging area, and
  off a parked copy whose swap is still in flight.

Anything failing any of those stays exactly where it is, and the sweep says nothing either way:
removing this build's own litter is housekeeping, not news. So that the marker gate does not
turn every interrupted build into permanent litter, **a staging directory is marked before any
content is written into it** — a build that dies mid-copy still leaves something the next sweep
can attribute.

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
stamp, the build log, and that lock. A fourth entry appears there only while a stale lock is
being broken: a `lock.breaking-…` directory named after the lock it is breaking, created with
the same `mkdir` the lock itself is, so that two builds finding one stale lock cannot both
remove it and both take its place. It lives for the two syscalls the break takes and is then
removed. One left behind by a build killed inside that window is aged out by a later build,
which is what keeps "a build can never wedge permanently" true of the break as well as of the
lock. Like compiled output the whole directory is generated, never tracked.

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
   refuses to do. A matching hash is **necessary but not sufficient**: the stamp also records
   **one outcome per skill per target** — a content hash where a `SKILL.md` was written there,
   and a decline where the target held something that was not this tool's to replace. Every
   recorded hash is re-read and re-hashed before the gate closes, so editing or deleting a
   compiled skill by hand rebuilds it with the stamp intact.
   Only `SKILL.md` is hashed — a `references/` tree dominates corpus bytes, and hashing it would
   put the gated path's cost back where the stamp exists to avoid it. A skill that failed carries
   its *previous* record forward rather than dropping to none, so it stays integrity-checked while
   it is broken. **The outcome is recorded per target because it differs per target.** A skill
   written to one target and declined in another has no single state, and collapsing the pair to
   *declined* would strip the integrity check from a compiled skill that really is there — which
   anyone able to create a directory in a shared target such as `~/.claude/skills`, an
   arrangement the rules above deliberately support, could arrange for themselves. A recorded
   decline is re-checked by asking whether **a non-owned entry still exists at that path**, never
   whether the path is still unmarked. A path that has since been emptied also reads as unmarked,
   so the weaker test would honour the decline forever and never write the skill to a target that
   is now free — and it would break the promise above, that deleting a compiled skill by hand
   rebuilds it. A decline that still holds is exactly what a fresh build would find and decline
   over again, so re-reading one **confirms the record** and counts as verification done, the
   same way a hash that still matches does. A corpus whose every skill is declined therefore
   gates, which is what the `build [--check]` row above promises: a decline is not stale output.
   A `failed` list cannot hide a file from the check, since a target carrying no recorded outcome
   at all must hold no `SKILL.md`; and **a record that confirms nothing against the disk gates
   nothing** — a `failed` list names no path to go and look at, so a stamp claiming every skill
   failed is claiming there was never anything to check, and the build runs. That floor is not
   the trust boundary and is not sold as one: whoever can write the stamp can also write a
   `SKILL.md` of their own into a target and record *its* hash as `written`, which re-reads,
   matches, and gates. The stamp is trusted exactly as far as the directory it lives in, which is
   why nothing read back from it is rendered without going through the normalisation under
   *Diagnostics* below. A gated run is not a silent one — it replays the last real build's
   diagnostics, and it still writes the log. **A `--check` that finds the output stale while the
   inputs hash unchanged replays them too**: staleness is then a verdict about the *output*, and
   the last build's account is the only one of why — a template that has failed to compile every
   run since leaves nothing on disk to verify, and a bare "stale, run the build" names a remedy
   that cannot clear it.
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
5. **`id` is declared, and never re-derived from a path.** Every verb reads it from the config
   and nothing recomputes it from where it was run, which is what makes a worktree and its main
   checkout agree about the overrides they resolve. `init` may *seed* a fresh config's value from
   the directory name — it has to write something, and the file says so beside it — but a seed is
   the developer's starting point, not the tool's opinion: two unrelated repos cloned as `api`
   seed the same `id` and collide, and only a changed declaration separates them.
6. **Nothing generated is tracked.** A convention `init` supports rather than a property the
   tool enforces: it offers the `.gitignore` lines and cannot do more (see *Not in the
   contract*).
7. **The tool never writes outside the repo it is run in, except to the configured override and
   target roots.**
8. **No symlink is ever followed or copied, and none is followed silently.** What the tool checks
   is what it **derived**. A root a config entry *names* is a destination the tool did not
   construct: nothing `lstat`s it — not its last component, and for a path entry not any component
   of it — and it is reached however the filesystem reaches it. Everything the tool derived, by
   joining further names onto a root it must then vouch for, is `lstat`'d in full, its own last
   component included. That is why `@acme/skills` resolves cleanly through a symlinked package
   directory while `@acme/skills/templates` does not: the subpath entry's source root is the
   *derived* `<package>/templates`, whose own last component is checked like any other. The one
   path the tool builds in order to *reach* a named destination is the `node_modules` chain it
   walks for a package name, and that is derived too — every level of it is `lstat`'d bar the
   package directory the name lands on. One named root is `lstat`'d all the same, because the code
   that reads it asks for that and not because this rule requires it — an **override root**, whose
   only job is to bound what may be read, and which would otherwise widen silently to wherever it
   pointed.

   Position is not what decides this, so the rule is a table of routes rather than a sentence.
   The verdicts are three — never `lstat`'d, stepped over, refused:

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

   One check reaches a named root's own last component without `lstat`ing it: an entry spelling
   `${home}` is asserted contained against its **real** path as well as its resolved text, which
   is what stops `${home}/x` reading or writing outside `${home}` through a link.
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
- [`docs/CONTEXT.md`](../CONTEXT.md) — glossary
- [`docs/staging/qa-composable-skills-tooling.md`](../staging/qa-composable-skills-tooling.md) — evidence
