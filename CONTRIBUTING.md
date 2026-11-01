# Developing Sherpa

Build, run and send a PR. Agent rules and canonical contracts are in `AGENTS.md`, system design is in `docs/architecture.md`, and tests and budgets are in `docs/testing.md`.

## Checkout and installation

```
pnpm install --frozen-lockfile
```

Node ≥ 22.13 (`engines` in the root `package.json`), and the exact pnpm version recorded in `packageManager`, `pnpm@12.16.1`. `corepack` installs it automatically.

## Checks

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

These must pass before every commit. E2E is outside the required checks. `packages/e2e` deliberately has no `test` script because browser tests take time and run explicitly.

## Packages

`packages/protocol` contains zod schemas and types for everything that crosses a process boundary: worker tasks and messages, the UI snapshot, route, chat, server manifest, `ReviewHost` interface and protocol version. Its only dependency is `zod`. Every other package depends on it.

`packages/server` runs the server for one PR: HTTP and SSE, a `node:sqlite` database, task queue, worker registry, route and chat orchestrators, host adapters (`src/hosts/`) and update checks. esbuild bundles it into one `sherpa-review-server.mjs` module with the UI assets embedded. The `runServer` export starts the server. The CLI calls it through `sherpa-review server`.

`packages/ui` is the reviewer's React application: diff, route, discussions, chat, settings, design tokens in `src/styles/` and development pages in `src/dev/`. vite builds it.

`packages/cli` is the thin `sherpa-review` CLI (`up`, `worker next` and other commands). The worker loop calls it on every invocation, so startup is fast and there are no runtime dependencies. It builds into one `sherpa-review.mjs` bundle. Host adapters live in `src/hosts/` in the server and CLI.

`packages/skill` is the harness distribution: `SKILL.md` plus the CLI and server module in `dist/bin/`. `dist/` is a build artifact and is not versioned (`.gitignore` excludes `dist/`).

`packages/fixtures` contains deterministic PRs (`medium`, `small`, `large`, `edge`, `huge`, `empty`), a fixture `ReviewHost` and domain object builders. Development mode, the state gallery and e2e use them.

`packages/e2e` contains Playwright specs that run against built artifacts.

## Development mode

Run the server with a fixture PR:

```
pnpm --filter @sherpa/server dev --pr fixture-medium
```

The key is `fixture-<small|medium|large|edge|huge|empty>` (`FIXTURE_NAMES`, plugin at `packages/server/src/hosts/fixture/plugin.ts`). The server prints its port, manifest path and UI link, runs until Ctrl+C, and does not stop when idle. It does not need a built UI because vite serves it.

UI:

```
pnpm --filter @sherpa/ui dev
```

The development proxy in `packages/ui/vite.config.ts` forwards `/api` to a running server. It takes the address from `SHERPA_SERVER`, or from the first manifest in `~/.sherpa/servers/*.json`. The port is ephemeral and cannot be hardcoded. Starting a server after `vite dev` requires restarting vite. Open `http://localhost:5173/#t=<token>` with the token from the link the server printed.

To use the skill from a checkout, build it (`pnpm --filter @sherpa/ui build && pnpm --filter @sherpa/skill build`) and symlink the distribution into the harness: `~/.claude/skills/sherpa-review` (Claude Code) or `~/.agents/skills/sherpa-review` (Codex) → `<repo>/packages/skill/dist`. `SHERPA_SERVER_BIN` overrides the server module lookup beside the CLI if you need a different module.

## State gallery

```
pnpm --filter @sherpa/ui dev   # http://localhost:5173/gallery.html
```

The gallery renders every screen state deterministically using fixtures, without a server or token. Use it to verify appearance against the prototype in `docs/design/Sherpa.dc.html`, in the same viewport, until they match. The URL stores the state (`#state=…`) and language (`#locale=`).

To add a state, export a list of cards from a `*-states.tsx` file in `packages/ui/src/dev/gallery/` and register it in `GALLERY_STATES` (`packages/ui/src/dev/gallery/states.tsx`). A new component or a new state of an existing one needs a new card so its appearance can be verified.

## E2E

Install Chromium once:

```
pnpm --filter @sherpa/e2e exec playwright install chromium
```

```
pnpm --filter @sherpa/e2e e2e
```

`globalSetup` builds the production UI assets and CLI bundle. Each test starts a fixture server in a temporary `--sherpa-dir`. The performance spec runs with the full suite. To run it separately:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

Measurements are printed as `PERF …` lines. See `docs/testing.md` and `packages/e2e/README.md` for details.

## Contracts

`AGENTS.md` is canonical. In brief:

- Everything the model reads or that crosses a process boundary has a schema in `packages/protocol` and passes validation. The server rejects invalid data, and the UI does not consume it.
- Host-specific behaviour stays inside `ReviewHost` (`packages/protocol/src/review-host.ts`). A new method needs a flag in `HostCapabilities` and a check in the contract test suite at `packages/server/src/hosts/review-host-contract.ts`.
- Hosts and channels are plugins registered through composition roots.
- Increment the protocol version (`packages/protocol/src/version.ts`) whenever worker endpoints or the task format change incompatibly.

## Appearance

The test in `packages/ui/src/styles/tokens.test.ts` compares the design tokens in `packages/ui/src/styles/tokens.css` with the table in `docs/design/README.md`. Changing a token without updating the design handoff, or vice versa, fails the checks. Then add a gallery card and compare it with the prototype. The prototype is a reference, not a source of code.

## Decisions

When you change behaviour, a contract or an invariant, record it in `docs/decisions.md`: subsystem section, date, what and why. Mark a superseded decision as superseded, without deleting it.

## PR

Branch from main, pass the checks, then run `gh pr create`. CI (`.github/workflows/ci.yml`) runs the same checks on Node 22, 24 and 26, and `main` accepts only PRs with green CI. Describe what changes and why. If the change touches the server, UI flows or `packages/e2e`, run e2e before submitting.
