# Testing

Sherpa has two tiers of checks. The required tier runs typecheck, lint and vitest unit tests in every package before each commit. The e2e tier drives the built server, CLI bundle and UI through Playwright, and it runs before a release and after changes to the flows it covers.

## 1. Checks

These must pass before any commit:

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

- `typecheck` runs `tsc --noEmit` for each package. `npm` has nothing to typecheck, so its script prints that and exits.
- `lint` runs eslint for each package.
- `test` runs `vitest run` in 6 packages: `protocol`, `fixtures`, `cli`, `server`, `ui`, `npm`.

E2E isn't part of the required checks: `packages/e2e` has no `test` script, only `e2e`. Run Playwright separately before a release and after changes to `packages/e2e`, the server, or UI flows covered by e2e. The performance spec is part of the regular e2e suite (§5).

Tests must not use live hosts or a live model. Host calls use recorded responses, and generation uses raw outputs from fixtures.

## 2. Unit tests by package

There is no shared vitest configuration, and each package runs with its own. `protocol` and `fixtures` have no configuration at all and use the defaults (the `node` environment, forks, isolation). No package has setup files.

### `protocol`

`protocol` has one file for all schemas. It covers the handshake version and compatibility, tasks and leases, `complete`, the discovery manifest, review domain types (PR, diff, threads, lenses), routes, chat and notes, iterations and snapshots, settings/onboarding/updates, and JSON Schema generation.

The tests check both sides of each schema: valid data passes and malformed data is rejected. The cases include limits (`RESULT_MAX_BYTES` counts bytes, not characters), zero attempts, unknown task types, and a malformed node deep in a thread tree, which must reject the whole thread.

### `server`

`server` has the largest suite. Its `vitest.config.ts` sets only `globalSetup: ['./src/bundle.global-setup.ts']`. Test files run in parallel forks and esbuild overwrites the bundle nonatomically, so the build runs once for the whole suite. The global setup builds the UI (skipping it if `packages/ui/dist/index.html` already exists) and the server bundle.

The suite tests HTTP endpoints only through live HTTP, with no direct handler calls. A test uses one of 3 forms:

- The full app runs through `startServer`: a real `http.createServer` on `listen(0, '127.0.0.1')` with its own database, manifest and fixture host.
- A bare HTTP listener uses manually assembled endpoints and stubbed orchestrators.
- A separate OS process in `bundle.test.ts` starts the built `dist/sherpa-review-server.mjs` module through a 2-line wrapper (`import()` and a `runServer` call), reads the port and token from the manifest and makes ordinary `fetch` requests. The same test checks that importing the module alone starts nothing.

Request and temporary-directory helpers are in `packages/server/src/test-support.ts`.

Storage uses the built-in `node:sqlite`. An append-only migration list (`packages/server/src/migrations.ts`) builds the schema, and the schema version equals the number of applied migrations. `db.test.ts` checks:

- creation from scratch and WAL mode, confirmed through a separate connection
- idempotent reopening
- upgrades **from every prefix of the list**, in a loop through all intermediate states
- specific data migrations
- atomic failure: a broken migration leaves no half-built table
- list consistency: unique names, the `NNN-name` format, consecutive numbering

The route validator has coverage from 2 sides: the golden suite (§3) and the negative corpus in `packages/server/src/route/corpus.test.ts`. The corpus is a table of handwritten malformed results with exact comparison of error messages. Every case of "the model returned something strange" adds a corpus entry.

### `cli`

`cli` also configures only a global setup, which builds the bundle. Unit tests cover argument parsing, Node version checks, opening the browser, task text format, the `next` timeout, PR discovery through host plugins, finding and loading the server module, and the absence of external imports and server code in the built bundle. `up.test.ts` spawns the real built CLI as a daemon and replaces only the server module.

`cli.integration.test.ts` calls commands as functions, but against a real server:

- `up` finds a running server, doesn't reopen the tab, and reports "incomplete distribution" when the adjacent server module is missing.
- `server` passes arguments to the module unchanged and reports "incomplete distribution" for a module without `runServer`.
- `worker register` covers the state file and its permissions, `--lang`, reconnection and session eviction.
- `task complete/progress/fail` covers the text limit, another task's number, another session's token and a dead manifest.

`protocol.scenarios.test.ts` tests the C1↔C2 protocol against a live server, with the built bundle acting as the worker. `src/fake-worker.ts` runs each command in a separate node process, so no memory survives between calls, exactly as in an agent session. The server clock is mocked, so leases expire instantly. The scenarios:

- **died silently**: the lease expires, and a new session receives the same task on its second attempt
- **returned garbage**: the validator rejects `complete`, the task stays leased, and the second attempt is accepted
- **repeated complete**: the second call is a no-op, and the first result isn't overwritten
- **exceeded the lease**: the submission is rejected, the task returns to the queue without an owner, and no work is lost
- cancellation during a lease
- reconnection with slot takeover
- exhausted attempts

`guide.test.ts` checks the loop marker contract. It extracts all quoted strings from the guide text, requires `stop the loop` among them, and requires each phrase plus `DONE` to appear verbatim in CLI output. If the wording drifts, the harness loop silently stops recognizing these situations.

### `ui`

`ui` has no separate configuration. The `test` block sits in `vite.config.ts` and raises timeouts to 20 s. A file selects its environment with a `// @vitest-environment jsdom` docblock, and other files run in `node`.

The project doesn't use Testing-library. DOM tests mount components manually with `createRoot` + `act`, and pure rendering tests use `renderToStaticMarkup` to render a string. There are no snapshot tests. Every expectation is explicit.

The tests cover diff parsing and highlighting, rendering lines and file cards, threads and notes, and the route model (coverage is recalculated from anchors and the diff instead of being taken from the snapshot). They also cover reading progress, the palette and keyboard shortcuts, i18n, stores and URL parsing, and `App`-level integration in jsdom against a stubbed transport.

The UI tests check the implementation and shared style rules:

- `src/styles/tokens.test.ts` reads `tokens.css` and checks that themes declare the same token set without duplicates. It checks the rem font scale, the minimum text size and its exception, and text contrast against CSS colours.
- `src/icons/icon.test.tsx` checks that each `Icon` name has exactly one sprite symbol and renders a reference to it. It also checks size and accessibility attributes. Neither test reads design documents or prototypes.
- `src/i18n/no-cyrillic.test.ts` and `src/styles/component-styles.test.ts` allow Cyrillic only in the dictionary and comments, forbid colour literals outside `tokens.css`, and require every `var(--x)` to have a declaration somewhere.

### `fixtures`

`fixtures` tests data invariants rather than examples: deterministic builds, consistent hunk counters and line numbers, reconstruction of the full file text from a patch, and agreement between inter-iteration slices and the iterations' own patches. Route fixtures are checked against the diff: the test recalculates coverage from added and deleted lines and compares it with the handoff counts.

### `npm`

`npm` sets `fileParallelism: false` in `vitest.config.mjs` because both suites rebuild `dist/`. `build.test.mjs` checks:

- the package contents: `package.json`, `README.md`, `LICENSE`, `THIRD-PARTY-LICENSES.txt`, and `bin/` with an executable command and a nonexecutable server module
- third-party notices for bundled packages, including IBM Plex fonts, with their license text and no workspace or build-only packages
- the published manifest: name and version from `packages/npm/package.json`, one bin, no dependencies or scripts
- that `skills/sherpa-review/SKILL.md` stays a stub calling `guide`
- that the built CLI runs with plain node
- that the server and UI haven't leaked into the CLI bundle: the CLI is smaller than the server and contains no `node:sqlite`

The end-to-end checks pack `dist/` with `npm pack`, install the tarball offline into a temporary directory, and run it through `node_modules/.bin`, as npx does. A cold `up` starts a server, and a warm one reuses it. Printed commands point at the real file behind the link and run from any cwd. `worker next` doesn't load the server module, while `server` does.

`third-party-licenses.test.mjs` covers mapping module and asset source paths to packages. It also checks that a package without a license, or an asset without a known source, fails the build.

## 3. The `ReviewHost` contract suite

`packages/server/src/hosts/review-host-contract.ts` defines a function rather than a test: `describeReviewHostContract(name, makeHost, { writes?, advance?, viewer?, skip?, slow? })`. Adapter tests use a relative import. All 3 implementations call it: `FixtureHost` (in a loop over all fixtures), `GithubHost` against the recorded GitHub API, and `LocalHost` against real `git` in a temporary repository. One set of checks covers all 3 implementations, so it catches adapter differences where they arise (`docs/architecture.md §5`).

### Git-backed suites

The shared `LocalHost` scenarios (`local-host.test.ts`, `local-host-threads.test.ts`, `local-host-rounds.test.ts`, `local-iterations.test.ts`, `local-git-carry.test.ts`, the publishing block in `feedback-orchestration.test.ts`) and the Git backend suites (`git-vcs.test.ts`, `local-git-host*.test.ts`) run against real `git` through the `git-fixture.ts`, `git-project.ts` and `git-contract-host.ts` helpers.

The helpers create a repository in a system temporary directory, never inside another VCS checkout, with an isolated environment. They still invoke the backend as in production, with the machine's config. Only the author name is set in the temporary repository's config, so the login in tests doesn't depend on the machine.

These scenarios are skipped entirely if `git` isn't installed. Each snapshot takes several `git` invocations, so the Git suites have their own timeouts: 30 s per test and 15 s to wait for a polling tick.

### What the contract checks

- **Schemas.** `getPr` and `getDiff` pass schema validation, and file identifiers are unique.
- **Method ⇔ capability flag.** Each `HostCapabilities` flag (`fileViewedSync`, `fileContent`, `blobs`, `iterations`, `commentIssues`, `commentResolve`, `editPublished`) is checked both ways. When the flag is off, the host must have no corresponding method, and its data must reflect that (viewed mark `null`, image `null`, exactly one iteration, slices rejected). When the flag is on, the method must exist. Declaring a capability without its method is as invalid as providing the method without the flag.
- **Behavioural consequences.** `getFileContent` returns `null` for binary files. For text files, patch context lines appear at their exact line numbers in the text, otherwise context expansion would draw the wrong lines. A missing blob returns `null`, the byte length matches the declared size, and an oversized image side returns `null`.
- **Iterations.** Exactly one is active, none is marked missing (the server sets that mark, not the host), and timestamps never decrease. A slice with an unknown iteration is rejected instead of returning an empty diff. After a "push", slice paths belong to the union of the two iterations.
- **Subscriptions.** The initial snapshot arrives immediately, `getThreads` matches it, and each write delivers a **new** snapshot. The delivery count is checked separately, so returning a live reference to the host's array doesn't satisfy the contract. Unsubscribing stops the stream.
- **Writes**, when the host supports them: the draft lifecycle (including a reply's issue status), idempotent saves by key, thread replies, resolving threads and individual issue comments, editing and deleting published comments, batch publishing (no drafts remain), and viewed marks appearing in the next `getDiff`.
- **Publishing modes.** `publishVerdicts` contains `comment` and has no duplicates. The host rejects every verdict outside the list, and the draft stays a draft after rejection. `comment` with no drafts returns `{[], [], true}` without changing the thread snapshot. Every listed verdict except `comment` publishes a draft on a fresh host with `verdictApplied: true`.
- **Per-comment resolution.** `Comment.resolved === null` exactly on hosts without `commentResolve`. On other hosts, each thread's `Thread.resolved` matches "there is at least one issue and all issues are resolved", computed from its comments.

### `GithubHost` mock

`GithubHost` runs twice against the same kind of `fetch` mock: on another author's PR and on the token owner's PR, where only `comment` remains available. The mock dispatches `/graphql` by operation name and variables, and REST by three routes (files, `compare`, content bytes). Mutations change subsequent responses, and a "push" moves the branch head to a new commit. An unknown operation fails the test: the adapter must not request anything the mock doesn't cover.

### Golden tests

The golden tests cover the route validator, not review rules. `packages/server/src/route/golden.test.ts` takes raw model output from fixtures (the skeleton and section results, exactly as an agent would return them) and the expected finished route snapshot. It runs the raw text through the production validator and compares the result verbatim.

The cases include the plan from the skeleton with the synthetic "Other" stop, identical results when sections are split into batches, stop digests that discard unsupported claims, anchors resolving to files in the active iteration, a second pass after a push, and English generation. There is no regeneration mode, so edit goldens by hand. `packages/fixtures/src/route.test.ts` checks the fixtures themselves.

## 4. E2E

`packages/e2e` uses Playwright. Run it with `pnpm --filter @sherpa/e2e e2e`. Chromium is required:

```
pnpm --filter @sherpa/e2e exec playwright install chromium
```

`global-setup.ts` builds, once per run, the artifacts that e2e tests run as production: the UI static assets and the CLI bundle.

Each test starts its own server on `FixtureHost` with a separate temporary `--sherpa-dir` and working directory, and both are removed after the test. The test reads the address and bearer token from the server output. Direct endpoint calls use the same token as the UI.

`FakeWorker` plays the agent session through the built CLI bundle, with the same shell commands the model runs in its harness. The test drives the loop itself, because `worker next` waits a long time for a task. It calls `worker next` only when it knows the server has queued one.

Dev endpoints are declared in the protocol and registered only for the fixture host. These routes don't exist for a real PR:

| Endpoint | Purpose |
|---|---|
| `POST /api/dev/fixture/advance-iteration` | "the author pushed": the next declared iteration becomes active, and the tab learns about it through SSE |
| `POST /api/dev/fixture/fail-draft-writes` | the host rejects a draft write to test buffering |
| `POST /api/dev/update-available` | announce an available update without touching the disk cache |

Specs for the end-to-end scenarios from `docs/product.md §7`:

| Spec | Coverage | Scenario |
|---|---|---|
| `f1.spec.ts` | Full queue → validator → snapshot → SSE → UI path: skeleton and sections through the CLI bundle, progressive rendering, coverage, tour, drafts, guardrail, finishing a review. Failure cases: three invalid plans, raw output display, retry | F1 |
| `f2.spec.ts` | Line selection → question to the agent → answer → agent note at the lines survives reload → blocking draft → requesting changes publishes one comment | F2 |
| `f2-queue.spec.ts` | Question during generation: queue banner, chat task issued next, cancellation in flight, late submission as a no-op, retry | F2 |
| `f3.spec.ts` | Push while reading: stale-route banner through SSE, rebuild with mark carryover, "what is new" filter with a change explanation and thread link, what happens to notes, outdated thread on the old commit | F3 |
| `f3-forcepush.spec.ts` | Force-push removes an iteration: reading the route from a local patch, progress carryover through the missing iteration's head, arbitrary slice, read-only snapshot of the missing iteration | F3 |
| `f5.spec.ts` | Full review without an agent, run in two languages: tabs, lenses, filter, palette search, marks after reload, draft, ship | F5 |

There is no separate F4 spec. Threads from colleagues and the AI review bot are checked in `f1`, `f2`, `f3`, `f5`, `keyboard`, `draft-buffer` and `image-diff`, but no end-to-end pass covers "other people's discussions + filters". This is a known gap.

The remaining specs cover element behaviour from `docs/design/SPEC-elements.md`: `action-bar-dock`, `context-expansion`, `draft-buffer`, `empty-pr`, `file-menu`, `icons`, `image-diff`, `keyboard` (the full key map), `line-wrapping`, `locale`, `onboarding`, `route-file-collapse`, `route-fill-stop`, `route-regeneration`, `route-unmount`, `scroll-stability`, `sticky-file-header`, `ui-pr-state`, `ui-settings`, `update-toast`.

Each test gets 120 s, and each `expect` gets 10 s. The suite runs one worker with no parallelism, because the servers occupy real ports. The viewport is 1440×900. The browser locale is pinned to `ru-RU`, because the UI language defaults to automatic and Chromium starts with `en-US`. The system theme is pinned to dark, because the UI theme defaults to `auto` and the specs check dark palette colours (the theme spec switches it itself).

Both F3 specs raise their timeout to 240 s, because each one generates two full routes through the CLI bundle. Traces and screenshots are saved only on failure.

## 5. Performance budgets

`packages/e2e/src/performance.spec.ts` runs in the full e2e suite. To run it separately:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

The spec takes about a minute and a half. Its internal timeout for the huge tests is raised to 600 s.

The `huge` fixture has 100 files and 25 274 changed lines, but the measurement doesn't cover the entire PR. Twenty-four cards are collapsed for a reason (a viewed or generated file) and don't request parsing, so 76 files and 21 260 lines reach the worker and the renderer. Constants in `@sherpa/fixtures` fix these counts and the test checks them, so the numbers from a run describe a load of exactly this size.

The spec measures:

- time to the first diff frame.
- patch parsing in the worker: total, mean, p95, maximum, number of parsed files (cache hits don't count).
- cold and warm scrolling frame times, in two series: frame work (measured around position assignment with forced layout) and the interval between adjacent frames.
- DOM node count.
- heap size, if the Chromium build exposes it.

All measurements print as `PERF …` lines and also appear as report annotations.

The budget is mean ≤ 16.7 ms and p95 ≤ 33 ms (`docs/architecture.md §6`). It is enabled and fails the run:

- on `large` (64 files), only for frame work. Intervals between frames aren't checked.
- on `huge`, for both metrics, on cold and warm passes, in both huge tests. The route also has a DOM node limit.

The `HUGE_BUDGET_ENFORCED` switch at the top of the spec is currently `true`. It exists as one place to disable the budget temporarily, and its presence doesn't mean the budget is only recorded.

## 6. State gallery

The state gallery (`packages/ui/gallery.html` and `packages/ui/src/dev/gallery/`) renders screen states deterministically from `@sherpa/fixtures`, with static props only and no server or token. To run it:

```
pnpm --filter @sherpa/ui dev
```

Then open `/gallery.html`. The left side lists states grouped by subsystem, and the right side shows the selected state. State, language, theme and text size live in the address bar (`#state=…&locale=ru&theme=auto|dark|light&textsize=m|l`), so a link to a specific state can be shared. The theme defaults to dark so that cards don't depend on the system theme.

Changing the state or the language remounts the render and reapplies the initial props. The gallery isn't included in the production build, which builds only `index.html`.

The gallery is used for visual acceptance. Open it beside the `docs/design/Sherpa.dc.html` prototype at the same viewport size and fix differences until they match. A new state or component needs a new gallery card.

Each state group has a `*-states.test.tsx` test, which checks markup without image comparisons. The test first checks that exactly the states the group creates are registered, in a fixed order, so adding a state outside the registry fails it. It then checks the visible contract from the specification: labels, chips, counters, and whether elements are present or absent. Most files render to a string, and a few mount in jsdom where focus and input behaviour need checking.

A shared registry test checks that identifiers are unique and that every state mounts and unmounts without exceptions in both languages, which catches missing dictionary keys.
