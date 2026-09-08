# Developing Sherpa

Build, run and send a PR. Agent rules and canonical contracts are in `AGENTS.md`, system design is in `docs/architecture.md`, and tests and budgets are in `docs/testing.md`.

## Checkout and installation

```
pnpm install --frozen-lockfile
```

Node ≥ 22.13 (`engines` in the root `package.json`), and the exact pnpm version recorded in `packageManager`, `pnpm@11.10.0`. `corepack` installs it automatically.

## Checks

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

These must pass before every commit. E2E is outside the required checks: `packages/e2e` deliberately has no `test` script because browser runs take a long time and are started explicitly.

## Packages

`packages/protocol` contains zod schemas and types for everything that crosses a process boundary: worker tasks and messages, the UI snapshot, route, chat, server manifest, `ReviewHost` interface and protocol version. Its only dependency is `zod`. Every other package depends on it.

`packages/server` is a single-PR server: HTTP and SSE, a `node:sqlite` database, task queue, worker registry, route and chat orchestrators, host adapters (`src/hosts/`), update check. esbuild builds it into one `sherpa-server.mjs` with embedded UI assets.

`packages/ui` is the reviewer's React application: diff, route, discussions, chat, settings, design tokens in `src/styles/` and development pages in `src/dev/`. vite builds it.

`packages/cli` is the thin `sherpa` CLI (`up`, `worker next`, and others). The worker loop calls it each time, so it starts fast and has no runtime dependencies. One `sherpa.mjs` bundle.

`packages/skill` is the harness distribution: `SKILL.md` and both bundles in `dist/bin/`. All of `dist/` is a build artifact and is not stored in the repository.

`packages/fixtures` provides deterministic PRs (`medium`, `small`, `large`, `edge`, `huge`, `empty`), a fixture `ReviewHost` and domain object builders. Dev mode, the state gallery and e2e use them.

`packages/e2e` contains Playwright specs that run against built artifacts.

## Development mode

Run the server with a fixture PR:

```
pnpm --filter @sherpa/server dev --pr fixture-medium
```

The key is `fixture-<small|medium|large|edge|huge|empty>` (`FIXTURE_NAMES`, adapter selection in `packages/server/src/hosts/select.ts`). The server prints the port, manifest path and UI link, and runs until Ctrl+C. It has no idle shutdown. It doesn't need the built UI, which vite serves.

UI:

```
pnpm --filter @sherpa/ui dev
```

The development proxy in `packages/ui/vite.config.ts` forwards `/api` to a running server. It takes the address from `SHERPA_SERVER`, or from the first manifest in `~/.sherpa/servers/*.json`. The port is ephemeral and cannot be hardcoded. Starting a server after `vite dev` requires restarting vite. Open `http://localhost:5173/#t=<token>` with the token from the link the server printed.

Skill from a checkout: build (`pnpm --filter @sherpa/ui build && pnpm --filter @sherpa/skill build`) and link the distribution into the harness, `~/.claude/skills/sherpa` → `<repo>/packages/skill/dist`. `SHERPA_SERVER_BIN` overrides server-bundle discovery next to the CLI if you need a different one.

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

`globalSetup` builds the production UI assets and CLI bundle. Each test starts a fixture server with a temporary `--sherpa-dir`. The performance spec is outside the normal run and runs before releases:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

Measurements are printed as `PERF …` lines. See `docs/testing.md` and `packages/e2e/README.md` for details.

## Contracts

`AGENTS.md` is canonical. In brief:

- Everything the model reads or that crosses a process boundary has a schema in `packages/protocol` and passes validation. The server rejects invalid data, and the UI does not consume it.
- Host-specific behaviour stays inside `ReviewHost` (`packages/protocol/src/review-host.ts`). A new method needs a flag in `HostCapabilities` and a check in the contract test suite at `packages/server/src/hosts/review-host-contract.ts`.
- Increment the protocol version (`packages/protocol/src/version.ts`) whenever worker endpoints or the task format change incompatibly.

## Appearance

The test in `packages/ui/src/styles/tokens.test.ts` checks design tokens in `packages/ui/src/styles/tokens.css` against the table in `docs/design/README.md`. Changing a token without changing the handoff (or vice versa) fails the checks. Then add a gallery card and compare it with the prototype. The prototype is a reference, not a source of code.

## Releasing the distribution

```
pnpm release --notes "<one sentence>"
```

`--notes` is required. The update toast shows this sentence (up to 140 characters). The script (`scripts/release.mjs`) builds `@sherpa/ui` and `@sherpa/skill`, checks `sherpa --version` and `version.json` against the root `package.json` version, and requires the same version in the root `README.md`. It recreates `<target>/skill/` from `packages/skill/dist` and sets `releasedAt` and `whatsNew`. The target defaults to the repository root. Use `--target` to write to a separate directory, or `--skip-build` to use an existing `dist`. Finally, it prints the list of published files and ready-to-run `git add skill` / `git commit` commands. The script does not call `git`. A person commits manually.

The update toast compares the embedded version with `skill/version.json` from main, so this commit is what delivers the version to users.

## Decisions

When you change behaviour, a contract or an invariant, record it in `docs/decisions.md`: subsystem section, date, what and why. Mark a superseded decision as superseded, without deleting it.

## PR

Branch from main, pass the checks, then run `gh pr create`. The description says what changes and why. If the change touches the server, UI flows or `packages/e2e`, run e2e before submitting.
