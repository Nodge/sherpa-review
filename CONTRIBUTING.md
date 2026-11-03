# Developing Sherpa

This page covers building, running and testing Sherpa from a checkout, and what a pull request needs. The rules for agents and the canonical contracts live in `AGENTS.md`, the system design in `docs/architecture.md`, and tests and budgets in `docs/testing.md`.

## Checkout and installation

```
pnpm install --frozen-lockfile
```

You need Node 22.13 or later (`engines` in the root `package.json`) and the exact pnpm version recorded in `packageManager`, which is `pnpm@12.16.1`. Any pnpm 10 or later reads that field and switches to the recorded version on its own. `corepack` does not work with pnpm 12, so install pnpm with `npm install -g pnpm` instead.

## Checks

Before every commit, these must pass:

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

E2E is not part of the required checks. `packages/e2e` deliberately has no `test` script, because browser tests take time and are run on purpose. See "E2E" below for when to run them.

## Packages

The monorepo has 7 packages.

`packages/protocol` holds the zod schemas and types for everything that crosses a process boundary: worker tasks and messages, the UI snapshot, the route, chat, the server manifest, the `ReviewHost` interface and the protocol version. Its only dependency is `zod`, and every other package depends on it.

`packages/server` runs the server for one PR. It contains the HTTP and SSE layer, a `node:sqlite` database, the task queue, the worker registry, the route and chat orchestrators, host adapters in `src/hosts/` and update checks. esbuild bundles it into one `sherpa-review-server.mjs` module with the UI assets embedded. The `runServer` export starts the server, and the CLI calls it through `sherpa-review server`.

`packages/ui` is the reviewer's React application: diff, route, discussions, chat and settings, with design tokens in `src/styles/` and development pages in `src/dev/`. vite builds it.

`packages/cli` is the thin `sherpa-review` command (`guide`, `up`, `worker next` and the other commands). The worker loop runs it on every invocation, so startup has to be fast, which is why it has no runtime dependencies and builds into one `sherpa-review.mjs` bundle. Host adapters for the CLI live in its `src/hosts/`, separate from the server's.

`packages/npm` builds the published `sherpa-review` npm package: a manifest plus the CLI and server module in `dist/bin/`. `dist/` is a build artifact and is not versioned (`.gitignore` excludes it). The skill is a small stub in `skills/sherpa-review/SKILL.md` that runs `sherpa-review guide` through npx.

`packages/fixtures` holds deterministic PRs (`medium`, `small`, `large`, `edge`, `huge`, `empty`), a fixture `ReviewHost` and builders for domain objects. Development mode, the state gallery and e2e all use them.

`packages/e2e` holds the Playwright specs, which run against built artifacts.

## Development mode

Run the server against a fixture PR:

```
pnpm --filter @sherpa/server dev --pr fixture-medium
```

The key is `fixture-<small|medium|large|edge|huge|empty>` (the list is `FIXTURE_NAMES`, the plugin is `packages/server/src/hosts/fixture/plugin.ts`). The server prints its port, manifest path and UI link, runs until Ctrl+C and does not stop when idle. It does not need a built UI, because vite serves it.

Run the UI:

```
pnpm --filter @sherpa/ui dev
```

The development proxy in `packages/ui/vite.config.ts` forwards `/api` to a running server. It takes the address from `SHERPA_SERVER`, or from the first manifest in `~/.sherpa/servers/*.json`. The port is ephemeral and cannot be hardcoded, so if you start a server after `vite dev`, restart vite. Then open `http://localhost:5173/#t=<token>` with the token from the link the server printed.

To run a checkout build in an agent session, build the package:

```
pnpm --filter @sherpa/ui build && pnpm --filter @sherpa/npm build
```

Then ask the agent to run `node <repo>/packages/npm/dist/bin/sherpa-review.mjs guide` and follow its output instead of invoking the installed skill. Outside the npx cache, the guide prints `node <path>` commands, so the whole session uses the checkout build. If you need a different server module, `SHERPA_SERVER_BIN` overrides the lookup beside the CLI.

## State gallery

```
pnpm --filter @sherpa/ui dev   # http://localhost:5173/gallery.html
```

The gallery renders every screen state deterministically from fixtures, with no server and no token. Use it to compare the UI with the prototype in `docs/design/Sherpa.dc.html`, in the same viewport, until they match. The URL stores the state (`#state=…`) and the language (`#locale=`).

To add a state, export a list of cards from a `*-states.tsx` file in `packages/ui/src/dev/gallery/` and register it in `GALLERY_STATES` (`packages/ui/src/dev/gallery/states.tsx`). A new component, or a new state of an existing one, needs a new card so its appearance can be checked.

## E2E

Install Chromium once:

```
pnpm --filter @sherpa/e2e exec playwright install chromium
```

Then run the suite:

```
pnpm --filter @sherpa/e2e e2e
```

`globalSetup` builds the production UI assets and the CLI bundle. Each test starts a fixture server in a temporary `--sherpa-dir`. The performance spec runs as part of the full suite. To run it on its own:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

Measurements print as `PERF …` lines. `docs/testing.md` and `packages/e2e/README.md` have the details.

## Contracts

`AGENTS.md` is canonical. In brief:

- Everything the model reads or that crosses a process boundary has a schema in `packages/protocol` and passes validation. The server rejects invalid data, and the UI does not consume it.
- Host-specific behaviour stays inside `ReviewHost` (`packages/protocol/src/review-host.ts`). A new method needs a flag in `HostCapabilities` and a check in the contract test suite at `packages/server/src/hosts/review-host-contract.ts`.
- Hosts and channels are plugins registered through composition roots.
- Increment the protocol version (`packages/protocol/src/version.ts`) whenever worker endpoints or the task format change incompatibly.

## Appearance

Edit design-token values in `packages/ui/src/styles/tokens.css` and icons in `packages/ui/src/icons/sprite.svg`. Tests check theme completeness, duplicate declarations, font-size rules, contrast and the agreement between `Icon` names and sprite symbols. Design documents explain decisions, and prototypes provide a visual reference. For a new state or component, add a gallery card and compare it with the prototype at the same viewport.

## README media

The README shows a demo video and 2 screenshots of Sherpa 0.11.1 at commit `ecbe204`, in Chromium, on the `medium` fixture PR. The route, the review comment and the agent note are prepared demo data. No live repository, GitHub credentials or model service is involved.

The files are GitHub attachments, not repository files, because `npx skills add` clones the repository tree on every install. To replace one, drag the new file into any comment field on GitHub, copy the `https://github.com/user-attachments/assets/…` URL it produces and put it into the README. A video URL goes on its own line, and GitHub renders a player for it.

| Capture | Content |
|---|---|
| Demo video | Overview fills with the summary and route stops. The reviewer opens the route, scrolls from stop 01 to stop 02, comments on lines 6–9 in `edit-policy.ts` and clicks "Request changes". Dark theme, about 30 seconds at 2560 × 1600 and 30 fps, H.264 with CRF 16 and fast start |
| Test digest | Route stop 04, captured as an element so the whole test digest fits. Dark theme |
| Full diff | The same file and agent note in the full diff. Dark theme, 1280 × 800 |

To refresh a capture, start the fixture server with a separate `--sherpa-dir` in a temporary directory. Build the route through the CLI using the prepared results in `packages/fixtures/src/data/route-medium*.ts`, the same way the e2e helpers in `packages/e2e/src/route-worker.ts` do. Use English and the default text size. Capture the real UI without changing its markup or styles.

For the video, use a 1280 × 800 viewport at device scale factor 2. Keep the initial Overview, the summary and each route stop arriving, and the click on "Open the route". Record the scroll from stop 01 to stop 02 as one continuous movement. Select lines 6–9, write a comment, save the draft and click "Request changes". Speed up generation and cut pauses between actions. Leave the "Changes requested" screen visible for several seconds.

## Release

Bump `version` in the root `package.json`, then prepare the package:

```
pnpm release
```

`scripts/release.mjs` builds `@sherpa/ui` and `@sherpa/npm`. It checks that `sherpa-review --version` and `packages/npm/dist/package.json` match the root version, lists what `npm publish` would upload, and prints the publish command. Use `pnpm release --skip-build` to check an existing `dist`.

The script neither publishes nor runs git. To publish the package, run the printed `npm publish packages/npm/dist` command. Users get the release in their next agent session because the skill runs `npx -y sherpa-review@latest`.

## Decisions

When you change behaviour, a contract or an invariant, record it in `docs/decisions.md` under the subsystem section with the date, what changed and why. Mark a superseded decision as superseded without deleting it.

## Sending a PR

Branch from `main`, pass the checks, then run `gh pr create`. CI (`.github/workflows/ci.yml`) runs typecheck, lint and the npm package build on Node 24, then tests on Node 22, 24 and 26. `main` accepts only PRs with green CI. Describe what changes and why. If the change touches the server, UI flows or `packages/e2e`, run e2e before submitting.
