# Developing Sherpa

Build, run and submit a PR. `AGENTS.md` defines agent rules and canonical contracts,
`docs/architecture.md` explains the system, `docs/testing.md` covers tests and budgets.

## Checkout and installation

```
pnpm install --frozen-lockfile
```

Node ≥ 22.13 (`engines` in the root `package.json`), pnpm at exactly the version specified
in `packageManager`, `pnpm@11.10.0`. `corepack` installs it automatically. The registry is
`https://registry.npmjs.org/` (`.npmrc`).

## Checks

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

These must pass before every commit. E2E is not a required check: `packages/e2e` has no `test` script
by design, because the browser run is slow and is started explicitly.

## Packages

`packages/protocol` contains zod schemas and types for everything that crosses process boundaries: tasks and
worker messages, the UI snapshot, route, chat, server manifest, `ReviewHost` interface,
protocol version. Its only dependency is `zod`. All other packages depend on it.

`packages/server` serves one PR: HTTP and SSE, a `node:sqlite` database, task queue, worker
registry, route and chat orchestrators, host adapters (`src/hosts/`), update checking.
Built with esbuild into one `sherpa-server.mjs` with embedded static UI assets.

`packages/ui` is the reviewer's React app: diff, route, discussions, chat, settings,
design tokens in `src/styles/`, dev pages in `src/dev/`. Built with vite.

`packages/cli` is the thin `sherpa` CLI (`up`, `worker next` and others). The worker loop invokes it
on every call, so startup is fast and there are no runtime dependencies. One `sherpa.mjs` bundle.

`packages/skill` is the harness distribution: `SKILL.md` plus both bundles in `dist/bin/`. `dist/`
is entirely a build artifact and is not stored in the repository.

`packages/fixtures` contains deterministic PRs (`medium`, `small`, `large`, `edge`, `huge`,
`empty`), a fixture `ReviewHost` and domain object builders. They feed dev mode,
the state gallery and e2e.

`packages/e2e` contains Playwright specs that run against built artifacts.

## Development mode

Run the server with a fixture PR:

```
pnpm --filter @sherpa/server dev --pr fixture-medium
```

The key is `fixture-<small|medium|large|edge|huge|empty>` (`FIXTURE_NAMES`. Adapter selection:
`packages/server/src/hosts/select.ts`). The server prints the port, manifest path and UI link,
runs until Ctrl+C, and does not stop on idle. It does not need a built UI, which is served by
vite.

UI:

```
pnpm --filter @sherpa/ui dev
```

The dev proxy in `packages/ui/vite.config.ts` forwards `/api` to the running server. It takes the address from
`SHERPA_SERVER`, otherwise from the first manifest in `~/.sherpa/servers/*.json`. The port is ephemeral, so it cannot
be hardcoded, and a server started after `vite dev` requires restarting vite. Open
`http://localhost:5173/#t=<token>`, taking the token from the link printed by the server.

Skill from a checkout: build (`pnpm --filter @sherpa/ui build && pnpm --filter @sherpa/skill build`)
and symlink the distribution into the harness: `~/.claude/skills/sherpa` → `<repo>/packages/skill/dist`.
`SHERPA_SERVER_BIN` overrides discovery of the server bundle beside the CLI if you need a different one.

## State gallery

```
pnpm --filter @sherpa/ui dev   # http://localhost:5173/gallery.html
```

Each screen state renders deterministically from fixtures, without a server or token.
This is also where appearance is accepted: the gallery and `docs/design/Sherpa.dc.html` prototype
at the same viewport size, until they match. The URL holds the state (`#state=…`) and language (`#locale=`).

For a new state, export a list of cards from a `*-states.tsx` file in
`packages/ui/src/dev/gallery/` and add it to the `GALLERY_STATES` registry
(`packages/ui/src/dev/gallery/states.tsx`). A new component or a new state of an existing one needs
a new card, otherwise there is nothing to use for acceptance.

## E2E

Install Chromium once:

```

  pnpm --filter @sherpa/e2e exec playwright install chromium
```

```
pnpm --filter @sherpa/e2e e2e
```

`globalSetup` builds production UI assets and the CLI bundle. Each test starts a fixture server
in a temporary `--sherpa-dir`. The performance spec is excluded from the full run. Run it before a release:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

Measurements are printed as `PERF …` lines. See `docs/testing.md` and `packages/e2e/README.md` for details.

## Contracts

`AGENTS.md` is canonical. In brief:

- Everything the model reads or that crosses a process boundary has a schema in
  `packages/protocol` and passes validation. Invalid data is rejected and never consumed by the UI.
- Host-specific code stays behind `ReviewHost` (`packages/protocol/src/review-host.ts`). A new
  method needs a flag in `HostCapabilities` and a check in the contract suite
  `packages/server/src/hosts/review-host-contract.ts`.
- Bump the protocol version (`packages/protocol/src/version.ts`) for any breaking change to
  worker endpoints or the task format.

## Appearance

Design tokens in `packages/ui/src/styles/tokens.css` are checked against the table in
`docs/design/README.md` by `packages/ui/src/styles/tokens.test.ts`: changing a token without
updating the handoff (or vice versa) fails the checks. Next comes a gallery card, then comparison
with the prototype. The prototype is a reference, not a code source.

## Releasing the distribution

```
pnpm release --notes "<one sentence>"
```

`--notes` is required: the update toast shows this sentence (up to 140 characters). The script
(`scripts/release.mjs`) builds `@sherpa/ui` and `@sherpa/skill`, checks `sherpa --version`
and `version.json` against the `version` field in the root `package.json` and requires that version to be
mentioned in the root `README.md`, recreates `<target>/skill/` from `packages/skill/dist`,
and sets `releasedAt` and `whatsNew` there. The default target is the repository root,
`--target` runs it against a separate directory. `--skip-build` uses the existing `dist`.
Finally, it prints the published files and ready-to-run `git add skill` / `git commit` commands. The script
does not call `git`. A person makes the commit by hand.

The update toast compares the embedded version with `skill/version.json` from main, so the version
reaches users only through this commit.

## Decisions

If you change behaviour, a contract or an invariant, record it in `docs/decisions.md`: subsystem section,
date, what and why. Mark an overturned decision as superseded instead of deleting it.

## PR

Branch from main, pass the checks, run `gh pr create`. Describe what changes and why. If
you touched the server, UI flows or `packages/e2e`, run e2e before submitting.
