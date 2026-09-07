# composable-skills

A node CLI that compiles skill templates into `SKILL.md` files and writes them where an agent
harness will find them. `README.md` is the orientation; this file is the two things that are
easy to get wrong.

## `src/` is node-only

The shipped artifact is `dist/cli.js`, produced by `bun build ./src/cli.ts --target=node`, run
under `#!/usr/bin/env node`, and `package.json` declares `engines: { "node": ">=20" }`. A Bun
API in `src/` compiles fine and then fails at runtime for everyone who installs the tool. So:

- Import from `node:*` — `node:fs`, `node:path`, `node:process`. Never `Bun.*` or `bun:*`.
- Stay inside node 20's surface. `tsconfig.src.json` pins `lib` to ES2023, which rejects a
  language-level global that is too new, but `@types/node` describes every builtin regardless of
  the version it landed in — `fs.globSync` (node 22) typechecks clean and then throws for a user
  on node 20. The `smoke` job in `.github/workflows/ci.yml` is the only thing that catches that,
  by executing every implemented verb on node 20, 22 and 24. Keep it that way.

`test/` carries no such constraint: it runs under `bun test` and nowhere else, so `Bun.*` and
`bun:*` are fine there. That split is the whole rule — Bun is how this repo is built and tested,
never what the tool runs on.

## Bun is the tooling

- `bun install`, `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bunx` —
  never their npm/yarn/pnpm/jest/vitest equivalents.
- `bun <file>` rather than `node <file>` or `ts-node <file>` for anything run ad hoc.
- Tests import from `bun:test`:

```ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

- Lint and format are biome, configured in `biome.jsonc`: `bun run lint`, `bun run format`.
- Bun loads `.env` by itself; don't add dotenv.

## Where the answers are

- [`docs/CONTEXT.md`](docs/CONTEXT.md) — the canonical vocabulary. Its definitions bind: "the
  tool", "consuming repo", "template", "compiled skill", "fragment", "slot", "override",
  "target", "marker", "stamp". Read it before writing prose, and avoid the terms it lists
  under *Avoid*.
- [`docs/specs/tool-contract.md`](docs/specs/tool-contract.md) — the behaviour contract: config
  schema, directives, resolution order, the verb surface, and what is rejected versus warned.
  It is the authority when the code and your expectation disagree.
- [`docs/decisions/0001-build-time-composition.md`](docs/decisions/0001-build-time-composition.md)
  — why the design is shaped this way, and which alternatives were rejected and on what grounds.
  [`0002-worktree-include.md`](docs/decisions/0002-worktree-include.md) amends one of its
  consequences: how a worktree gets the tool and the compiled skills.
