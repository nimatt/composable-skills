# Plan: Composable agent skills

> **Superseded — historical.** This is the original design note, written for the monorepo
> that motivated the tool, before this repo existed. A five-way adversarial review found
> several of its facts wrong and four of its security controls unsound, and the design that
> shipped is not this one: see
> [`docs/decisions/0001-build-time-composition.md`](docs/decisions/0001-build-time-composition.md)
> for what was decided instead and [`docs/specs/tool-contract.md`](docs/specs/tool-contract.md)
> for what the tool does. It is kept for the harness, git and timing evidence it gathered,
> which is repo-independent and still stands. Everything it said about the motivating repo's
> own files has been removed — nothing here cites a file from the motivating repo.

## Objective

Skills that the team maintains together, that individual developers can extend at
declared points, without either side losing the other's work. Today a skill is a
single tracked file: changing it for yourself means diverging from everyone, and
receiving team updates means giving up your changes. That trade-off is why the
motivating repo had exactly one skill — extension is impossible, so nobody invests
in a second.

The concrete case that motivates this: a shared `code-review` skill whose output
format one developer needs to change (JSON for a triage script instead of a markdown
table), while still receiving every other improvement the team makes to that skill.

A secondary requirement, stated as hard: a developer must never have to remember to
rebuild after templates change.

## Background

A section recording the motivating repo's own tracked files, ignore patterns, CI configuration
and git hooks stood here and has been removed with the rest of that repo's specifics. What
follows is repo-independent and still holds.

### Tooling facts established during design

**Claude Code** (v2.1.237)

- Skill precedence: enterprise > personal (`~/.claude/skills`) > project
  (`.claude/skills`). Same-name collision is a whole-file shadow, not a merge.
- `.claude/skills/<name>` **may be a symlink**; Claude Code follows it and reads
  `SKILL.md` from the target, loading once even if reachable from two locations.
- Skill directories are **watched live** — adds, edits, and removals are picked up
  mid-session without a restart. Caveat: a top-level skills directory that did not
  exist at session start is not watched until restart.
- There is **no `extends`/`import`/`include`** field in SKILL.md frontmatter.
- `description` (+ `when_to_use`) is the only text in context before a skill fires,
  and the combined text is **truncated at 1,536 characters** in the skill listing.
- `allowed-tools` **widens** effective permissions: *"Claude Code applies a project
  skill's `allowed-tools` whenever you or Claude invoke the skill, including in a
  `-p` run in a folder you've never trusted. A skill can grant itself broad tool
  access, so review the `allowed-tools` of skills checked into a repository."*
- `SessionStart` matchers: `startup`, `resume`, `clear`, `compact`, `fork`. It
  cannot block the session; its stdout is added to Claude's context. Project-settings
  hooks run without a per-user trust prompt.
- There is no git-pull hook. `PreToolUse`/`PostToolUse` on `Bash` only fire when
  *Claude* runs git, never when the developer does.

**Codex** (`codex-cli 0.147.0`)

- `codex features list` → `hooks  stable  true`. Events: `session_start`,
  `session_end`, `subagent_start`, `subagent_stop`, `pre_tool_use`, `post_tool_use`,
  `permission_request`, `user_prompt_submit`, `pre_compact`, `post_compact`.
- Project-level hooks live at `<repo>/.codex/hooks.json` (or `.codex/config.toml`);
  user-level at `~/.codex/hooks.json`. All matching layers load.
- **Project-local hooks require trust**, recorded against the hook's current hash —
  a modified definition needs re-approval. Managed hooks bypass this. `/hooks`
  manages trust.
- `async: true` runs a hook in the background, off the session-start critical path,
  up to eight concurrent per session. Default timeout 600s.
- **The skill format is byte-identical to Claude Code's.** Verified:
  `diff -q ~/.codex/skills/web-perf/SKILL.md ~/.claude/skills/web-perf/SKILL.md`
  reports no difference — same `<name>/SKILL.md` layout, same `name`/`description`
  frontmatter.

**Empirical git-hook matrix** (git 2.53.0, every row executed)

| Operation | fires |
|---|---|
| `git pull` (ff, merge, or `--ff-only`) | `post-merge` |
| `git pull --rebase` with **no** local commits (ff) | `post-merge` |
| `git pull --rebase` with divergent commits | `post-checkout`, `post-commit`, `post-rewrite` — **not** `post-merge` |
| `git checkout`/`switch`/`worktree add` | `post-checkout` (flag 1) |
| `git checkout -- <file>` / `git restore` | `post-checkout` (flag **0**) |
| **`git reset --hard`** | **nothing** |
| **`git stash` / `git stash pop`** | **nothing** |
| `git am` | `post-applypatch` only |
| **plain editor edit of a template** | **nothing** |

Staleness-check timings in the motivating repo: `git ls-files -s .claude | sha1sum` 4.7–5.6 ms,
`git status --porcelain .claude` 6.5 ms, `find -newer` 28.5 ms.

## Approach

### Layout

```
tools/agent-skills/            # tracked — source of truth
  templates/
    code-review/SKILL.md.tmpl
  fragments/
    sandbox-network.md
  local/                       # gitignored — personal slot overrides
    code-review/output-format.md
  build.ts
  explain.ts

.claude/skills/<name>/SKILL.md # generated, gitignored
.codex/skills/<name>/SKILL.md  # generated, gitignored
```

Templates live outside `.claude/` deliberately. Claude Code's sandbox has been seen
bind-mounting `/dev/null` over a path inside `.claude/`, and a `git add -A` run during
such a session commits the result as the empty blob — observed three times, twice
unrepaired. Generating into a directory that can happen to is asking for it.

### Template syntax

Two directives, both HTML comments so a `.tmpl` remains valid readable markdown:

```markdown
<!-- include: fragments/sandbox-network.md -->

<!-- slot: output-format mode=replace
Report findings as a markdown table: file:line, severity, one-line summary.
Group by file, most severe first.
-->
```

The critical property: **the default lives inside the directive**, so the template
body *is* the fallback and an empty `local/` compiles to exactly the team-canonical
skill. A literal unfilled `{{slot}}` cannot reach the output, because the syntax has
no way to express one.

Override files are markdown, one file per slot, at a path fixed by convention:
`tools/agent-skills/local/<skill>/<slot>.md`. Path is never templated, never
absolute, `..` rejected — see Security controls.

**`append` is the default; `mode=replace` is opt-in and declared by the template
author.** Most personal modification is additive; replace is the sharp tool that can
silently delete a guardrail. Letting the team decide per extension point is what
makes these extension points in the open/closed sense rather than arbitrary local
patching, and it is the entire justification for a compiler over "just edit the file".

Override files carry `<!-- against: <sha> -->` on line 1 — the hash of the default
body they were written against. The compiler warns when a `replace` default changes
underneath an override, so a personal delta cannot silently discard a team
improvement forever.

### What is not templatable

**Frontmatter has zero overridable keys.** Frontmatter is a contract with the harness;
the body is a contract with the model. Prose degrades gracefully, a routing table does
not.

- `description` is the trigger contract, the only pre-fire context, capped at 1,536
  chars, and it *competes* with neighbouring skills — a personal edit is a change to
  global routing, not a local preference. "The skill didn't fire" is only debuggable
  if everyone's string is the same string.
- `allowed-tools` widens permissions (see Background). A privilege grant living in a
  gitignored file is invisible to review.
- `name` is identity; skills reference each other by name.

Guardrail blocks in the body are also non-slotted, with a compile-time assertion that
the canonical guardrail text still appears in the output — a ~5-line substring check
that catches an `append` override trying to talk the model out of a rule it cannot
delete.

A developer who needs a materially different skill shadows the whole thing in
`~/.claude/skills/` (personal wins over project). That escape hatch is what lets this
policy be strict.

### Fragments are referenced at runtime, not inlined at build time

Shared detail ships as files the skill points at (`references/*.md`), not as text
spliced into every skill. One copy at one path, no drift, and no context cost until
the detail is actually needed — build-time inlining pays tokens in every session the
skill fires, for text that might be read once in twenty runs. `include:` exists for
short shared blocks only; anything over ~20 lines ships as a referenced file.

### Build and triggers

One script, three registrations:

| Tool | Registration |
|---|---|
| Claude Code | `SessionStart` hook in tracked `.claude/settings.json` |
| Codex | `SessionStart` hook in tracked `.codex/hooks.json`, `async: true` |
| Manual / anything else | `bun run skills:build` in root `package.json` |

```json
"hooks": {
  "SessionStart": [{
    "hooks": [{
      "type": "command",
      "command": "bun run $CLAUDE_PROJECT_DIR/tools/agent-skills/build.ts",
      "timeout": 15
    }]
  }]
}
```

**Keep the hook command string stable.** Codex pins trust to the hook's hash and
re-prompts every developer when the definition changes; Claude Code stops re-running
a `command`-source plugin until re-accepted for the same reason. All logic goes inside
`build.ts`, never into flags on the command line.

**Stamp gate.** The build's first act is a ~11 ms content fingerprint — hash of
`git ls-files -s`, `git diff`, and `git status --porcelain -uall` over the template
tree, plus the local override files, the builder itself, and a manually-bumped format
version — compared against a gitignored stamp at the repo root. Match → exit 0
immediately. Content hash, not mtime: git sets mtime to checkout time, so `find -newer`
cannot distinguish "changed" from "reverted", and costs 5× more.

**Fail-soft, always.** Build into a temp dir and `mv` into place only on success, so a
failed build never destroys the last good output. On failure exit 0 and write the
diagnostic to **stdout** — SessionStart stdout enters the model's context, so Claude
itself reports `SKILLS MAY BE STALE: <error>`; a non-zero exit only flashes stderr and
scrolls away.

**Concurrency.** Two sessions can start at once. Use `mkdir` as the lock (atomic on
POSIX, unlike `flock` which is absent on macOS) or rely on the atomic `mv`; treat
"lock held" as "someone else is building" and exit 0 quietly.

**Drift protection.** The compiler refuses to overwrite an output file whose hash does
not match what it last wrote, and says to port the edit back to the template or pass
`--force`. Hand-editing the generated file is the most likely failure mode, because
that is literally what happens today. Every output carries an autogenerated banner, matching the
generated-then-gitignored convention the repo already used for its other build outputs.

### `explain` is not optional

`bun run skills:explain <skill>` prints the template path and SHA, every fragment and
whether it came from team or local, every slot with default-vs-override and the
override's path, and the resolved text with provenance markers. Personal overrides are
gitignored, so when two developers get different behaviour from "the same" skill,
`git log` tells them nothing. This is the only debugging tool that will exist. It ships
before any convenience feature.

### Validator

Runs in `build.ts` and, separately, over the canonical compile (no local overrides) as
a check: frontmatter parses; `name` matches directory; `description` non-empty and
unchanged from the template; guardrail assertions hold; no unknown directives; no
leftover directive syntax; a default body containing `-->` is rejected at compile time;
and — the silent one — **no file in `local/` that matches no declared slot**, which is
otherwise a typo that quietly does nothing.

### Security controls

Must-have, in order:

1. **The compiler never takes an override path from a template.** Fixed convention,
   never templated, never absolute, `..` rejected. Otherwise a merged PR decides which
   local file gets inlined into an instruction file read at session start — point it at
   `~/.aws/credentials` and the secret is in the transcript before anyone types a
   prompt, with no tool call and no permission prompt.
2. **The compiler strips frontmatter from override files entirely.** A personal
   override must be structurally incapable of widening `allowed-tools`, not merely
   forbidden from it by a rule.
3. **Populate the adopting repo's `permissions.deny`**, which was empty: `~/.aws/**`,
   `~/.ssh/**`, `~/.claude.json`, `./**/.env`, `~/.config/gcloud/**`. One small PR, and
   the only control that holds regardless of what any skill says — conditional on deny
   outranking skill `allowed-tools` (see Open questions).
4. **`SessionStart`, never `post-merge`.** `post-merge` executes freshly-fetched
   attacker-controlled content at full privilege with a zero-second window, outside any
   sandbox, for people who never open an agent — including CI runners that pull. The
   "we already run husky hooks" defence does not apply: `pre-commit` fires on content
   the developer staged themselves.
5. **A `CODEOWNERS` rule over every path an agent reads at session start** — the
   `.claude/` and `.codex/` trees, the MCP manifest, the git-hook directory, the package
   manifest, and the template tree. Worth doing irrespective of this plan.

Deliberately *not* attempted: a rule forbidding "tool-invoking instructions" in override
prose. You cannot mechanically distinguish prose from instruction in a file an LLM
reads. Enforce the frontmatter and path rules, which are enforceable.

### Sequencing

**Phase 0 — hygiene, independent of everything else.** Untrack the zero-byte `.claude/`
blobs, one commit each. Widen the ignore pattern that was missing the agent-memory
directory. Populate `permissions.deny`. Add `CODEOWNERS`.

**Phase 1 — verify the two unknowns** (below). Both are ~2 minutes and one of them can
change the emitter.

**Phase 2 — compiler and one real skill.** Move the one existing tracked skill into
`templates/` and untrack it — a generator writing into `.claude/skills/` collides with a
tracked file there on day one. Build `build.ts` + validator + `explain.ts`. Wire
`.claude/settings.json`, `.codex/hooks.json`, and the `skills:build` script. Add the setup
step to the repo's onboarding doc.

**Phase 3 — the motivating case.** Author `code-review` with a real `mode=replace`
output-format slot and confirm one developer's override survives a template update.

### Rejected alternatives

- **Git hooks as the mechanism** (`post-merge`/`post-checkout`, via the husky bootstrap
  the repo already ran). Rejected on the matrix above: silently misses `git reset --hard`,
  `git stash pop`, `git am`, and every plain editor edit. Also rejected on the security
  ground in control 4. Considered as an *accelerator* for the pull-during-an-open-session
  gap and dropped — that gap is one session boundary wide and the live skill-directory
  watcher plus the next `SessionStart` closes it.
- **`postinstall` chained after the existing husky bootstrap.** Proven to run for
  everyone, but it only fires on `bun install`, so a pulled template change sits stale
  indefinitely. That fails the hard requirement outright. It also ran inside Docker builds
  calling `bun install --frozen-lockfile` without `--ignore-scripts`, so it would need to be
  fail-soft in CI regardless. Kept only as the
  manual escape hatch's sibling, not as a trigger.
- **A general templating engine** (Handlebars/Mustache/Liquid). Conditionals, loops, and
  helpers are each a way to produce a prompt you cannot predict by reading the template,
  and the core failure mode here is *debuggability*. Mustache-family engines also
  HTML-escape by default, which bites exactly once, confusingly, on somebody's `<tag>`.
  A skill compiler must be byte-transparent. The real work is the validator, which is
  engine-independent.
- **Symlinking `.claude/skills/<name>` to a tracked source dir.** Documented and
  supported, and it deletes the trigger problem entirely — but it supports no
  transformation at all, which is the whole point. Also fragile on Windows, and the
  motivating repo already had evidence of a symlink not surviving.
- **Committing the generated output** with a CI `git diff --exit-code` check. Correct in
  principle for review tractability, but compiled output differs per developer once
  overrides exist, so it cannot be a tracked artifact. The underlying requirement — a
  broadened `description` must be visible in a diff — is met instead by frontmatter
  coming only from tracked templates, plus the canonical-compile validator.
- **Native plugin marketplace** (`.claude-plugin/marketplace.json` with `./relative`
  sources, `extraKnownMarketplaces` + `enabledPlugins`). Genuinely covers distribution
  and versioning, and should be reconsidered if this grows past a handful of skills — but
  it does not provide per-developer extension at declared points, which is the
  requirement. Plugin-local symlinks are also restricted to resolving within the plugin's
  own directory, so a repo-local plugin cannot reach shared repo content.
- **Capability-tagged fragments for cross-tool differences.** Not needed at the start:
  the Claude and Codex skill formats are byte-identical and both have subagents, tool
  hooks, and a sandbox. Revisit only when a real skill needs it, so the expander stays
  free of conditionals.

## Open questions

**Does Codex read a repo-level `<repo>/.codex/skills/`?** The binary exposes a bare
`.codex/skills` string; only the user-level path is confirmed. Drop one `SKILL.md`
there, launch `codex`, see if it lists. If it does not, project skills must go via an
`.agents/plugins/marketplace.json` plugin instead, which changes the emitter. **Blocks
Phase 2's Codex target.**

**Does Codex's `SessionStart` support an `additionalContext` return?** There is an
`additionalContextLimit` field in its `HookMetadata` struct. This is how the fail-soft
"skills may be stale" message reaches the model on the Codex side, mirroring Claude's
stdout-into-context behaviour. If it does not, the Codex path needs a different failure
signal.

**Is `permissions.deny` evaluated ahead of skill `allowed-tools`?** Unresolved from the
docs. Security control 3 is worthless if `allowed-tools` outranks it.

**Does a relative-path plugin in a repo-local marketplace auto-install from committed
`enabledPlugins`, or does each developer still run `claude plugin install` once?**
Settleable with a fresh clone. Only matters if the plugin route is revisited.

**Tracked vs gitignored generated output — unsettled disagreement.** One position: the
output must be tracked and diffable, because a broadened `description` is a one-line
diff that is invisible if only templates are reviewed, and CI should recompile and run
`git diff --exit-code`. The other: this repo has no precedent for generated-then-committed
files, and per-developer compiles make the output non-reproducible, so tracking it
guarantees permanent phantom diffs — the bind-mounted-blob failure mode again. This plan
takes the second position and mitigates the first by never slotting frontmatter, but the
mitigation is weaker than a diff and the choice should be made deliberately rather than
inherited. Note also that the pipeline the repo ran did not build pull requests at all, so
there was no PR gate for a diff check to hang off.

**Which skills get extension points, and who decides?** Extension points are authored
deliberately by the team — that is the maintenance cost of the design. There is no
process for proposing one, no owner for skill quality, and no eval practice. Phase 3
covers one skill; beyond that this is unaddressed.

**Does the team actually use Codex, or is this insurance?** The plan builds both targets
because the format is identical and the marginal cost is a second output path. If nobody
uses Codex, Phase 2 can ship the Claude target alone without changing any other decision.

## Out of scope

- **opencode.** Installed on the developer machines but not investigated. It would plug in
  as a third output path and a third registration if it ever matters.
- **`AGENTS.md`.** Skills and AGENTS.md are different surfaces with different lifecycles;
  this plan neither touches one nor generates one.
- **Sharing skills across sibling repos.** The motivating repo already depended on a
  sibling checkout by relative path, so a multi-repo convention may exist. Not addressed.
- **A tracked MCP manifest combined with `enableAllProjectMcpServers: true`.** Together
  they make one added JSON object unprompted local process execution at session start for
  every developer — strictly worse than anything a skill can do, and pre-existing wherever
  it holds. It deserves its own ticket; the `CODEOWNERS` control above partially covers it.
- **A skill that normalises `dangerouslyDisableSandbox`.** Repeatedly instructing the agent
  to disable the sandbox and to read the resulting errors as noise trains the team to click
  through exactly the prompt a malicious skill would need. Worth addressing; not by this
  plan.
- **Untracked reviewer agents hidden per-machine rather than shared.** Whether they should
  be tracked is a team-process call.
- **Skill-listing token budget.** Every skill's description sits in context every session.
  Not quantified here.

## See Also

- [`docs/decisions/0001-build-time-composition.md`](docs/decisions/0001-build-time-composition.md)
  — the decision that superseded this note, and which of its arguments survived
- [`docs/specs/tool-contract.md`](docs/specs/tool-contract.md) — the tool as it was actually
  built: config schema, directives, resolution order, verbs
- [`docs/CONTEXT.md`](docs/CONTEXT.md) — glossary
