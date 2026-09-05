# composable-skills

A node CLI that compiles skill templates into `SKILL.md` files and writes them where an agent
harness — Claude Code, Codex — will find them. Templates declare **slots**: named points at
which an individual developer may replace or extend the text. Each developer's personal
overrides are merged in at build time, so a team can share one skill while individuals adapt it
at the points its author chose, and neither side's edits are lost when the other side changes.
The tool ships no skills of its own — it compiles whatever templates the repo installing it
points at.

## Status: unreleased, work in progress

Nothing is published yet, and the CLI is incomplete. **Three of the five verbs work** — the
compiler, the setup verb, and the one a developer uses day to day.

| Verb | State |
|---|---|
| `build [--check]` | implemented (unreleased) |
| `init [--write\|--dry-run]` | implemented (unreleased) — Claude Code only |
| `override <skill> <slot> [--write\|--dry-run]` | implemented (unreleased) |
| `lint` | planned (Phase 4) |
| `explain [<skill>]` | planned (Phase 5) |

Everything marked planned is specified but does not exist; running it says so and exits non-zero.
`init` writes the Claude Code `SessionStart` hook; the Codex equivalent is deliberately deferred,
so a Codex target is written on every build but nothing triggers that build automatically. The
directive syntax and config schema are settled in the spec, but nothing is under a semver promise
until a `1.0.0` release.

## Install

Nothing is on the registry yet, so this command will not work today. It is how the tool will be
installed from the first published release onwards.

```bash
npm install --save-dev composable-skills
```

**As a devDependency only.** There is no global-install path: resolution is always
repo-relative, which also pins the tool's version alongside the templates it compiles. Yarn PnP
is out of scope — it has no `node_modules`, so the path-based invocation breaks.

## A worked example

A repo that installs the tool is a **consuming repo** — either a **skills repo**, whose product
is skills authored for other repos, or a **project repo**, whose skills describe its own code.
The tool behaves identically for both; only the configured targets differ. Configuration is a
tracked file at the repo root, carrying only locations and never content.

```jsonc
// composable-skills.jsonc
{
  "id": "acme-platform",
  "sources":   ["./skills/templates"],
  "overrides": ["${home}/global", "./.claude/skills-local", "${home}/repos/${id}"],
  "targets":   ["./.claude/skills"]
}
```

`id` is declared, never derived from the path, so a git worktree and the main checkout resolve
the same overrides. `${home}` is `${XDG_CONFIG_HOME:-~/.config}/composable-skills`, relocatable
via `COMPOSABLE_SKILLS_HOME`. All three lists are ordered; **later entries win in the first two,
and every target is written on every build**. For Codex, add `./.agents/skills` (not
`.codex/skills`).

Each skill is a directory under a `sources` root holding exactly one template, always named
`SKILL.md.tmpl`. Everything else in that directory — a `references/` folder, for instance — is
copied verbatim to every target. Here is `skills/templates/code-review/SKILL.md.tmpl`:

```markdown
---
name: code-review
description: Review a diff for correctness bugs and style.
---

Read the whole diff before commenting on any part of it.

<!-- include: fragments/hard-rules.md -->

<!-- slot: extra-checks -->

<!-- slot: output-format -->
Report findings as a markdown table: file:line, severity, one-line summary.
<!-- /slot -->
```

The `include:` line names a **fragment**, resolved inside the same `sources` root. Here is all of
`skills/templates/fragments/hard-rules.md`:

```markdown
Never flag a line you have not read in context.
```

A developer who wants a different report format writes one file — no repo edit, nothing to
commit — at `~/.config/composable-skills/repos/acme-platform/code-review/output-format.md`.
`composable-skills override code-review output-format` creates that file, seeded with the text
the slot resolves to today, and prints its path:

```markdown
Report findings as a flat list, most severe first. Skip anything cosmetic.
```

`build` compiles that to `.claude/skills/code-review/SKILL.md`:

```markdown
---
name: code-review
description: Review a diff for correctness bugs and style.
---

Read the whole diff before commenting on any part of it.

Never flag a line you have not read in context.

Report findings as a flat list, most severe first. Skip anything cosmetic.
```

The `extra-checks` slot had no default and no override, so it contributed nothing. The
frontmatter is byte-identical to the template's — asserted, not merely intended, and an override
is structurally incapable of reaching it. Compiled output is **never tracked**: it is regenerated
on each machine from the template plus that machine's overrides.

## Shipping skills as a package

A skills repo can publish its templates to the registry, and a project repo names the package as
one `sources` entry. Two layouts work, and neither needs a stub `package.json` beside the
templates:

```jsonc
"sources": ["@acme/skills"]             // templates at the package root
"sources": ["@acme/skills/templates"]   // templates in a subdirectory
```

A `sources` entry that is not path-like resolves by walking the `node_modules` chain from the repo
root upward — so a dependency hoisted above a workspace child is still found — and never through
`main` or `exports`, which a templates-only package has no reason to declare. Only the package
directory itself may be a symlink, which is what makes a pnpm store or a workspace link ordinary:
`node_modules` and every earlier component of the name are not looked *through* where they are
links, or where the tool cannot read them — and neither is an entry that is there but is not a
usable package, the dangling link an `rm -rf node_modules/.pnpm` or a branch switch leaves behind.
None of these fails the entry. The walk steps over the level and carries on to the next
`node_modules` up, so the entry still resolves if a higher one holds the package, and is an error
only if none of them does.

**What you are told when it resolves from further up.** The build then looks *through* the level it
stepped over — one `stat`, whose only job is to decide what to print — and says what it found:

- a package really is installed behind it: a warning naming both the copy it compiled and the
  nearer one that would have won, so you can see that this build is not compiling what your
  lockfile installed;
- nothing behind it: nothing said. A pnpm store and a shared `node_modules` are this case, which is
  what makes the warning above worth reading when it does appear;
- the level could not be read at all: a warning saying exactly that, since the tool will not claim
  a copy it never saw;
- your own `node_modules` holds a broken entry for the package: a warning naming it and telling you
  to reinstall. The same wreckage in a directory *above* your repo says nothing — no lockfile of
  yours put it there.

Any of those warnings also stops that run pruning: it writes skills and deletes none, so a source
that resolved to a copy the tool cannot vouch for can never empty your skills directory. Where the
package resolves nowhere at all, the error is the ordinary "no such package — is it installed?",
or, where a level could not be read, one saying that instead, since a directory the tool was
refused entry to is not a package you forgot to install; every level stepped over comes along as
context beneath it.

A subpath is resolved inside the package under the same rules as `include:` — every component
`lstat`'d, no symlink followed, the result asserted inside the package and required to be a
directory — so a published tarball carrying `templates -> /elsewhere` is refused rather than
compiled. A subpath failure is an error, named individually, and skips that entry alone.

Keep the package's `files` limited to the template directories. The build hashes **every** file
under a source root to decide whether the compiled output is stale, so anything else the package
ships is work the freshness check does for nothing.

For the same reason, **a source root must not contain a target, or the `.composable-skills/` state
directory the build keeps at the repo root.** Both are written by the build and hashed as inputs by
the next one, so a build changes the very thing that was supposed to say nothing had changed. A
target inside a source root costs one extra rebuild before the layout settles; the state directory
inside one — which is what `"sources": ["."]` gives you — never settles at all, because the stamp
and the build log are rewritten every run, so `--check` reports stale forever. The tool warns when
it sees either — a `./skills/templates` subdirectory costs nothing and avoids it.

**The consuming repo declares `composable-skills` itself.** A peerDependency from the templates
package is the wrong shape: that package links against no API of the tool, it ships text. Peers
auto-install on npm 7+ and pnpm 8+, so the consuming repo would silently acquire a tool version it
never chose, and two template packages with disjoint ranges would fail the install outright over
what is really only "which template syntax was this authored against".

**Declaring the tool is not the same as having it where the hook looks.** The `SessionStart` hook
`init` writes is the fixed literal `node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build`,
which looks in the repo the session opened and walks no chain of its own. So in exactly the layout
the `sources` walk makes work — a workspace child whose dependencies are hoisted to the monorepo
root — the source resolves while the hook silently never runs; declaring the dependency in the
child does not stop npm hoisting it out. The same gap opens when the tool arrives only as a
transitive dependency of the templates package. What matters is that the path above exists in the
repo a session actually opens: `init` warns when it does not, and a fresh `git worktree` needs its
own install for the same reason.

Both belong in `devDependencies`, and so does the check: **`--check` belongs in a dev install**,
because a source the tool cannot use is an error, which makes a named source a hard dependency of
the build. A production `--omit=dev` install has neither the templates package nor the tool — which
is why the `postinstall` line `init` prints is fail-soft, and why a repo that installs that way
must not name a source it will not have.

```bash
npm install --save-dev @acme/skills composable-skills
composable-skills init --write   # then edit one line: "sources": ["@acme/skills/templates"]
```

## The two directives

Both are HTML comments, so a template stays valid, readable markdown.

### `slot`

Declares a point a developer may fill, either bare (`<!-- slot: name -->`) or fenced with a
default:

```markdown
<!-- slot: output-format -->
Report findings as a markdown table: file:line, severity, one-line summary.
<!-- /slot -->
```

The bare form is the fenced form with an empty default — legal, expected, and the purest kind of
extension point. **`mode` defaults to `replace`**: declaring a slot says its content is the
developer's to specify. `<!-- slot: output-format mode=append -->` is the opt-in for a default
the team wants added to rather than swapped, and a slot with an empty default behaves the same
under either mode. Slot names are unique within a skill, and no slot may be declared in the
frontmatter region.

There is no variable substitution — every variable point is a slot, and a value that reads
naturally inline becomes a one-line slot whose default is the whole sentence.

### `include`

`<!-- include: fragments/hard-rules.md -->` splices a shared **fragment** into the body at build
time. Use it for content the skill **always** needs, and a runtime `references/` file for
content the model needs **only under certain conditions** — the axis is conditionality, not
size. A fragment path must resolve inside the `sources` root the skill came from — there is no
fall-through to another root; absolute paths, `..`, and symlink hops are rejected. Expansion is a
single pass: a fragment may not itself `include:` another, and one that tries is rejected as
directive syntax left in the output.

## Overrides and resolution order

A skill's identity is its directory name. A skill present in more than one `sources` entry is
replaced wholesale by the later entry — sources never merge within one skill.

A slot's content is the first match found while scanning `overrides` **in reverse order**,
looking for `<root>/<skill>/<slot>.md`. If no root has one, the template's default is used. With
the default configuration that means, highest precedence first:

1. `${home}/repos/<id>/` — personal, for this repo only
2. `./.claude/skills-local/` — in-repo, typically gitignored
3. `${home}/global/` — personal, every repo on the machine

Whether an override root is tracked by git is the repo's choice and carries no special meaning —
a tracked root is simply how a repo fills a slot for everyone who builds there.

## The two verbs you run by hand

`build` is meant to run from a session hook. The other two are for people, and they default in
opposite directions on purpose. Both are specified in full in
[the spec's *Public API*](docs/specs/tool-contract.md#public-api); this is the orientation.

**`composable-skills init`** wires one repo up — the config file, the `.gitignore` lines, and the
`SessionStart` hook entry — and is run once by whoever maintains the repo. It is **diff-first**:
it prints exactly what it would do to each file and writes nothing until you add `--write`. It
merges rather than replaces, preserving unrelated keys, indent, line endings and file mode, and
it is idempotent, so a second run reports there is nothing to do. Where it cannot be sure — a
`settings.json` it cannot parse, one carrying comments a rewrite would delete, one reached
through a symlink, one a hook already runs this tool from — it refuses that file and says why
rather than overwriting it. It writes only inside the repo it is run in, and it refuses outright
in a home directory or a Yarn PnP checkout.

**`composable-skills override <skill> <slot>`** creates the file that fills one slot, in the
highest-precedence override root, and prints the path. It **writes by default** — there is
nothing to protect, because it never overwrites a file that exists — and takes `--dry-run` to
print without writing. The file is **seeded with whatever the slot resolves to today**: the
template's default where nothing overrides it, or the winning override root's own text where
something does. That is what makes it safe to run before you know what you want to change — edit
nothing, rebuild, and the compiled skill is byte-identical. (An `append` slot with nothing
overriding it is seeded empty and its default printed instead, since the build already emits the
default ahead of your text.)

```bash
composable-skills init --write
composable-skills override code-review output-format
```

## Build behaviour

Failure is isolated per skill: one that fails validation keeps its previous output while every
other skill builds normally. The organising rule is **reject when the output would be wrong or
unsafe, warn when the input is probably a mistake**. Rejections cover unknown, malformed or
leftover directive syntax, a `<!-- /slot -->` closing no open slot, a slot in the frontmatter
region, non-identical frontmatter, a `---` fence that opens the file only after a blank line
rather than on line 1, an `include:` or an override escaping its own root,
merge-conflict markers in any compiled input — a template, an included fragment, or an override
file — duplicate slot names, and a source skill directory supplying a `SKILL.md` or an ownership
marker of its own (whatever the case). Warnings are more numerous and less interesting; among
them are an override file matching no declared slot, an unsupported frontmatter field, a skill
name colliding across sources, a symlink that was not copied, and an entry in a target the build
declined to overwrite because it was not this tool's to replace — a directory nothing marked as
this tool's, or a symlink, which is never rewritten and never read through. A developer's typo
never breaks the build; a conflict marker reaching the model always does.

Isolation has one limit: **a config the tool cannot read is fatal to the whole run.** An
unreadable or unparseable config file, one that does not hold a JSON object, an `id` that is not
a usable single path segment, or a `sources`/`overrides`/`targets` that is not an array of
strings — on any of these nothing is compiled, nothing is pruned, and the previous output is
left exactly as it stands. `build` still exits 0; `build --check` does not. A single unusable
*entry* is a different thing and costs only that entry.

Diagnostics go to stdout, stderr, and a file, because the first two are frequently unread — with
two qualifications. Where the two streams point at one destination, only stderr is written, so a
terminal, a `> log 2>&1`, or a hook capturing combined output does not see everything twice. And
`--check` writes no file, except when a crash escapes the build: the log is then the only channel
left, so it is written whatever the flags said.

### What the build owns, and what it deletes

The build leaves a marker file inside every skill directory it emits, naming the tool and the
repo that built it. That marker is the whole of its claim on a target, and it governs writing and
deleting differently.

**Writing.** A directory with no marker — a skill you wrote by hand in `.claude/skills/` — is
never overwritten. A build that would have written a skill of that name warns and moves on,
leaving it exactly as it is.

**Deleting.** The build removes a directory only when the marker names *that* build and the
skill no longer exists in any `sources` root, so a renamed or removed template cannot leave a
stale skill sitting in front of the model. Another repo's skills are not its to delete, which is
what makes a shared target such as `~/.claude/skills` usable by several repos at once. (Two
repos publishing a skill of the *same name* there still collide on content; last writer wins.) A
build identifies itself by `id` only where the marker and the current config **both** declare
one, and by repo root path otherwise — so a directory written before an `id` was declared is
still matched by path. It is one more reason to declare `id`: without it a worktree will not
recognise the main checkout's output. And if a configured source root cannot be read — or resolved
past a level a nearer copy of the package could have been sitting behind — nothing is pruned that
run: a missing `node_modules` must not read as "every skill was deleted". The full
rules are in [the spec](docs/specs/tool-contract.md#ownership-and-pruning).

Alongside the compiled output, the build keeps a `.composable-skills/` directory at the repo
root holding the stamp, the build log, and a lock that stops two builds running over each other.
A lock left behind by a crashed or killed build is broken automatically, so the build can never
wedge permanently. Like the compiled skills themselves the directory is generated, and belongs in
`.gitignore`.

## How it runs

`init` writes a `SessionStart` hook that runs `build` at the start of every agent session, so
compiled skills stay current without anyone remembering to rebuild:

```
node "$CLAUDE_PROJECT_DIR/node_modules/composable-skills/dist/cli.js" build
```

`$CLAUDE_PROJECT_DIR` is written **literally** and expanded by Claude Code. It is deliberately not
resolved to an absolute path: `.claude/settings.json` is a tracked file, so that path would be
committed and would be wrong for every other clone on the team. The string is byte-stable for a
second reason too — Codex pins hook trust to its hash, so a string that changes re-prompts every
developer, which is also why all the logic lives in the tool rather than in flags.

**A `git worktree` needs its own install.** `git worktree add` produces a tree with no
`node_modules`, so the path above does not exist there and the hook fails at every session start
— silently, because it is fail-soft. Personal overrides *do* survive a worktree, being keyed on
the declared `id` rather than on a path; the hook is the part that does not. `init` warns when
that file is missing.

This is the Claude Code hook. **The Codex equivalent is deliberately deferred**: a Codex target is
written on every build, but nothing triggers that build automatically, so there `build` is still
run by hand.

What `build` already does is everything that makes it safe to run that way. A content hash — of
the tool version, the declared `id`, every configured root and the path it resolved to, the
config file, and every source and override tree — is checked first. A match is necessary but not
sufficient: the stamp also records a hash of every compiled `SKILL.md`, and each is re-read
before the gate closes, so editing or deleting one by hand rebuilds it even with the stamp
intact. When both hold the build recompiles nothing — though not in silence: the stamp also
records which skills failed last time and what they said, and a gated run replays those
diagnostics under a `[last build]` prefix, so a broken template is re-reported every session
until it is fixed rather than forcing a full recompile forever. Each
skill is staged in a temp directory inside the target and swapped into place on success, so a
failed build never destroys the last good output. And `build` exits 0 unconditionally, so a
fail-soft session hook can never break a session — `build --check` is the variant that writes
nothing and exits non-zero when the output is stale, when the last build had errors, or when this
run produced an error of its own — from its config, or from a source root that resolved but could
not be read.

One thing the hook cannot fix from inside a session: a harness does not pick up a skills
directory that did not exist when the session started, so the first session after a fresh clone
has no skills however early the build runs. `build` at least says so, naming any target directory
it had to create and noting that those skills arrive in the next session.

## Documentation

- [`docs/specs/tool-contract.md`](docs/specs/tool-contract.md) — the full contract
- [`docs/decisions/0001-build-time-composition.md`](docs/decisions/0001-build-time-composition.md) — the rationale
- [`docs/plans/composable-skills-tooling.md`](docs/plans/composable-skills-tooling.md) — the roadmap
- [`docs/CONTEXT.md`](docs/CONTEXT.md) — glossary

## License

MIT — see [`LICENSE`](LICENSE).
