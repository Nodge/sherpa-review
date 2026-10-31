# Testing

## 1. Checks

These must pass before any commit:

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

- `typecheck` runs `tsc --noEmit` for each package (`skill` has nothing to typecheck, so its script prints that and exits).
- `lint` runs eslint for each package.
- `test` runs `vitest run` in 6 packages: `protocol`, `fixtures`, `cli`, `server`, `ui`, `skill`.

E2E isn't part of the required checks. `packages/e2e` has no `test` script, only `e2e`. Run Playwright separately before a release and after changes to `packages/e2e`, the server, or UI flows covered by e2e. The performance spec is part of the regular e2e suite (§5).

Tests must not use live hosts or a live model. Host calls use recorded responses, and generation uses raw outputs from fixtures.

## 2. Unit tests by package

There is no shared vitest configuration. Each package runs with its own. `protocol` and `fixtures` have no configuration at all and use defaults (the `node` environment, forks, isolation). No package has setup files.

**`protocol`** has one file for all schemas: handshake version and compatibility, tasks and leases, `complete`, the discovery manifest, review domain types (PR, diff, threads, lenses), routes, chat and notes, iterations and snapshots, settings/onboarding/updates, and JSON Schema generation. Tests check both sides: valid data passes and malformed data is rejected. Cases include limits (`RESULT_MAX_BYTES` counts bytes, not characters), zero attempts, unknown task types, and a malformed node deep in a thread tree rejecting the whole thread.

**`server`** has the largest suite. `vitest.config.ts` sets only `globalSetup: ['./src/bundle.global-setup.ts']`. Test files run in parallel forks, and esbuild overwrites the bundle nonatomically, so the build runs once for the whole suite. Global setup builds the UI (skipping it if `packages/ui/dist/index.html` already exists) and the server bundle.

HTTP endpoints are tested only through live HTTP, with no direct handler calls. There are 3 forms. The full app runs through `startServer` (a real `http.createServer` on `listen(0, '127.0.0.1')`, its own database, manifest, and fixture host). A bare HTTP listener uses manually assembled endpoints and stubbed orchestrators. A separate OS process in `bundle.test.ts` starts the built `dist/sherpa-review-server.mjs` module through a 2-line wrapper (`import()` and a `runServer` call), reads the port and token from the manifest, and makes ordinary `fetch` requests. It also checks that importing the module alone starts nothing. Request and temporary-directory helpers are in `packages/server/src/test-support.ts`.

Storage uses built-in `node:sqlite`. An append-only migration list (`packages/server/src/migrations.ts`) builds the schema, with the version equal to the number applied. `db.test.ts` checks creation from scratch and WAL mode (confirmed through a separate connection), idempotent reopening, upgrades **from every prefix of the list** (a loop through all intermediate states), specific data migrations, atomic failure (a broken migration leaves no half-built table), and list consistency (unique names, the `NNN-name` format, consecutive numbering).

The route validator has coverage from 2 sides: the golden suite (§3) and the negative corpus in `packages/server/src/route/corpus.test.ts`, a table of handwritten malformed results with exact error-message comparisons. Every case of "the model returned something strange" adds a corpus entry.

**`cli`** also configures only global setup to build the bundle. Unit tests cover argument parsing, Node version checks, opening the browser, task text format, the `next` timeout, PR discovery through host plugins, finding and loading the server module, and the absence of external imports and server code in the built bundle. `up.test.ts` spawns the real built CLI as a daemon, replacing only the server module.

`cli.integration.test.ts` calls commands as functions but uses a real server: `up` (finds a running server, doesn't reopen the tab, reports "incomplete distribution" when the adjacent server module is missing), `server` (passes arguments unchanged to the module, reports "incomplete distribution" for a module without `runServer`), `worker register` (state file and permissions, `--lang`, reconnection, session eviction), `task complete/progress/fail` (text limit, another task's number, another session's token, a dead manifest).

`protocol.scenarios.test.ts` tests the C1↔C2 protocol against a live server, with the built bundle acting as the worker. `src/fake-worker.ts` runs each command in a separate node process, so no memory survives between calls, exactly like an agent session. The server clock is mocked, so leases expire instantly. Scenarios: **died silently** (the lease expires, a new session receives the same task on its second attempt), **returned garbage** (the validator rejects `complete`, the task stays leased, the second attempt is accepted), **repeated complete** (the second call is a no-op, the first result isn't overwritten), **exceeded the lease** (submission is rejected, the task returns to the queue without an owner, no work is lost), cancellation during a lease, reconnection with slot takeover, and exhausted attempts.

**`ui`** has no separate configuration. The `test` block is in `vite.config.ts` and raises timeouts to 20 s. The environment is selected per file with a `// @vitest-environment jsdom` docblock. Other files run in `node`. The project doesn't use Testing-library. DOM tests mount components manually with `createRoot` + `act`, while pure rendering tests use `renderToStaticMarkup` to render a string. There are no snapshot tests. Every expectation is explicit.

Topics: diff parsing and highlighting, rendering lines and file cards, threads and notes, the route model (coverage is recalculated from anchors and the diff instead of being taken from the snapshot), reading progress, the palette and keyboard shortcuts, i18n, stores and URL parsing, and `App`-level integration in jsdom against a stubbed transport.

Three separate guards check:

- `src/styles/tokens.test.ts` stores the token table from `docs/design/README.md` as a literal. The test reads `tokens.css`, extracts `--*` declarations from `:root`, and requires exact agreement on the set of names and agreement on values after normalizing colour notation. Extra and missing tokens both fail.
- `src/icons/icon.test.tsx` extracts the hidden sprite block from `docs/design/Sherpa Additions.dc.html` and requires a byte-for-byte match with the local `sprite.svg` copy. It also checks the list of symbol IDs and the `Icon` component markup.
- `src/i18n/no-cyrillic.test.ts` and `src/styles/component-styles.test.ts` allow Cyrillic only in the dictionary and comments, forbid colour literals outside `tokens.css`, and require every `var(--x)` to have a declaration somewhere.

**`fixtures`** tests data invariants rather than examples: deterministic builds, consistent hunk counters and line numbers, reconstruction of the full file text from a patch, and agreement between inter-iteration slices and the iterations' own patches. Route fixtures are checked against the diff. Coverage is recalculated from added and deleted lines and compared with the handoff counts.

**`skill`** sets `fileParallelism: false` in `vitest.config.mjs`. Both suites rebuild `dist/`. `build.test.mjs` checks the distribution contents (`SKILL.md`, `bin/` with an executable command and a nonexecutable server module, `version.json`), byte-for-byte equality between `SKILL.md` and its source, the contents of `version.json`, running the built CLI with plain node, and that the server and UI haven't leaked into the CLI bundle (the CLI is smaller than the server and contains no `node:sqlite`). End-to-end checks use a copy of the built `dist/` in a temporary directory. A cold `up` starts a server, and a warm one reuses it. `worker next` doesn't load the server module, while `server` does. The same suite tests loop marker phrases. It extracts all quoted strings from `SKILL.md`, requires `stop the loop` among them, and requires each phrase plus `DONE` to appear verbatim in the built bundles. If the wording drifts, the harness loop silently stops recognizing these situations. `release.test.mjs` runs `scripts/release.mjs` into a temporary directory. It checks file layout, the executable bit only on `bin/sherpa-review.mjs`, printed publication commands ready to run (a person publishes), removal of stale files on rerun, `builtFrom` matching the working tree state, and `releasedAt` and `whatsNew` being added to `version.json` without entering `dist/`.

## 3. The `ReviewHost` contract suite

`packages/server/src/hosts/review-host-contract.ts` is a function, `describeReviewHostContract(name, makeHost, { writes?, advance?, viewer?, skip?, slow? })`, rather than a test. Adapter tests use a relative import. All 3 implementations call it: `FixtureHost` (a loop over all fixtures), `GithubHost` against the recorded GitHub API, and `LocalHost` against real `git` in a temporary repository. One set of checks covers 3 implementations, catching adapter differences where they arise (`docs/architecture.md §5`).

The shared `LocalHost` scenarios (`local-host.test.ts`, `local-host-threads.test.ts`, `local-host-rounds.test.ts`, `local-iterations.test.ts`, `local-git-carry.test.ts`, the publishing block in `feedback-orchestration.test.ts`) and Git backend suites (`git-vcs.test.ts`, `local-git-host*.test.ts`) run against real `git` through the `git-fixture.ts`, `git-project.ts` and `git-contract-host.ts` helpers. They create a repository in a system temporary directory (never inside another VCS checkout) with an isolated environment, but invoke the backend as in production, with the machine's config. Only the author name is set in the temporary repository's config so the login in tests doesn't depend on the machine. These scenarios are skipped entirely if `git` isn't installed. Each snapshot takes several `git` invocations, so Git suites have their own timeouts: 30 s per test and 15 s to wait for a polling tick.

What the tests check:

- `getPr` and `getDiff` pass schema validation, and file identifiers are unique.
- **Method ⇔ capability flag.** Each `HostCapabilities` flag (`fileViewedSync`, `fileContent`, `blobs`, `iterations`, `commentIssues`, `commentResolve`, `editPublished`) is checked both ways. When the flag is off, the host must have no corresponding method, and its data must reflect that (viewed mark `null`, image `null`, exactly one iteration, slices rejected). When the flag is on, the method must exist. Declaring a capability without its method is as invalid as providing the method without the flag.
- Behavioural consequences: `getFileContent` returns `null` for binary files. For text files, patch context lines appear at their exact line numbers in the text (otherwise context expansion would draw the wrong lines). A missing blob returns `null`, byte length matches the declared size, and an oversized image side returns `null`.
- Iterations: exactly one is active, none are marked missing (the server sets that, not the host), and timestamps never decrease. A slice with an unknown iteration is rejected instead of returning an empty diff. After a "push", slice paths belong to the union of the two iterations.
- Subscriptions: the initial snapshot arrives immediately, `getThreads` matches it, and each write delivers a **new** snapshot (the delivery count is checked separately, so returning a live reference to the host's array doesn't satisfy the contract). Unsubscribing stops the stream.
- Writes (when the host supports them): the draft lifecycle (including a reply's issue status), idempotent saves by key, thread replies, resolving threads and individual issue comments, editing and deleting published comments, batch publishing (no drafts remain), and viewed marks appearing in the next `getDiff`.
- Publishing modes: `publishVerdicts` contains `comment` and has no duplicates. The host rejects every verdict outside the list, and the draft stays a draft after rejection. `comment` with no drafts returns `{[], [], true}` without changing the thread snapshot. Every listed verdict except `comment` publishes a draft on a fresh host with `verdictApplied: true`.
- Per-comment resolution: `Comment.resolved === null` exactly on hosts without `commentResolve`. On other hosts, each thread's `Thread.resolved` matches "there is at least one issue and all issues are resolved", computed from its comments.

`GithubHost` runs twice, on another author's PR and on the token owner's PR (only `comment` remains available for the latter), against the same kind of `fetch` mock. `/graphql` dispatches by operation name and variables, REST by three routes (files, `compare`, content bytes). Mutations change subsequent responses, and a "push" moves the branch head to a new commit. An unknown operation fails the test. The adapter must not request anything the mock doesn't cover.



**Golden tests** cover the route validator, not review rules. `packages/server/src/route/golden.test.ts` takes raw model output from fixtures (the skeleton and section results, exactly as an agent would return them) and the expected finished route snapshot, runs the raw text through the production validator and compares the result verbatim. Coverage includes the plan from the skeleton with the synthetic "Other" stop, identical results when sections are split into batches, stop digests that discard unsupported claims, anchors resolving to files in the active iteration, a second pass after a push, and English generation. There is no regeneration mode. Edit goldens by hand. `packages/fixtures/src/route.test.ts` checks the fixtures themselves.



## 4. E2E

`packages/e2e` uses Playwright. Run `pnpm --filter @sherpa/e2e e2e`. Chromium is required:

```
pnpm --filter @sherpa/e2e exec playwright install chromium
```

`global-setup.ts` builds the artifacts that e2e tests run as production once per run: UI static assets and the CLI bundle.

Each test starts its own server on `FixtureHost` with a separate temporary `--sherpa-dir` and working directory. Both are removed after the test. The test reads the address and bearer token from server output. Direct endpoint calls use the same token as the UI. `FakeWorker` plays the agent session through the built CLI bundle, using the same shell commands the model runs in its harness. The test writes the loop itself because `worker next` waits a long time for a task, so it is called only when the server is known to have queued one.

Dev endpoints are declared in the protocol and registered only for the fixture host. These routes don't exist for a real PR:

| Endpoint | Purpose |
|---|---|
| `POST /api/dev/fixture/advance-iteration` | "the author pushed": the next declared iteration becomes active, and the tab learns about it through SSE |
| `POST /api/dev/fixture/fail-draft-writes` | the host rejects a draft write to test buffering |
| `POST /api/dev/update-available` | announce an available update without touching the disk cache |

Specs for end-to-end scenarios (`docs/product.md §7`):

| Spec | Coverage | Scenario |
|---|---|---|
| `f1.spec.ts` | Full queue → validator → snapshot → SSE → UI path: skeleton and sections through the CLI bundle, progressive rendering, coverage, tour, drafts, guardrail, finishing a review. Failure cases: three invalid plans, raw output display, retry | F1 |
| `f2.spec.ts` | Line selection → question to the agent → answer → agent note at the lines survives reload → blocking draft → requesting changes publishes one comment | F2 |
| `f2-queue.spec.ts` | Question during generation: queue banner, chat task issued next, cancellation in flight, late submission as a no-op, retry | F2 |
| `f3.spec.ts` | Push while reading: stale-route banner through SSE, rebuild with mark carryover, "what is new" filter with a change explanation and thread link, what happens to notes, outdated thread on the old commit | F3 |
| `f3-forcepush.spec.ts` | Force-push removes an iteration: reading the route from a local patch, progress carryover through the missing iteration's head, arbitrary slice, read-only snapshot of the missing iteration | F3 |
| `f5.spec.ts` | Full review without an agent, run in two languages: tabs, lenses, filter, palette search, marks after reload, draft, ship | F5 |

There is no separate F4 spec. Threads from colleagues and the AI review bot are checked in `f1`, `f2`, `f3`, `f5`, `keyboard`, `draft-buffer` and `image-diff`, but there is no end-to-end pass for "other people's discussions + filters". This is a known gap.

The remaining specs cover element behaviour from `docs/design/SPEC-elements.md`: `action-bar-dock`, `context-expansion`, `draft-buffer`, `empty-pr`, `file-menu`, `icons`, `image-diff`, `keyboard` (the full key map), `line-wrapping`, `locale`, `onboarding`, `route-file-collapse`, `route-fill-stop`, `route-regeneration`, `route-unmount`, `scroll-stability`, `sticky-file-header`, `ui-pr-state`, `ui-settings`, `update-toast`.

Timeouts: 120 s per test, 10 s for `expect`, one worker with no parallelism (servers occupy real ports), viewport 1440×900, browser locale pinned to `ru-RU` (the UI language defaults to automatic, and Chromium starts with `en-US`), system theme pinned to dark (the UI theme defaults to `auto`, and specs check dark palette colours. The theme spec switches it itself). Both F3 specs raise their timeout to 240 s because each generates two full routes through the CLI bundle. Traces and screenshots are saved only on failure.

## 5. Performance budgets

`packages/e2e/src/performance.spec.ts` runs in the full e2e suite. To run it separately:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

The spec takes about a minute and a half. The internal timeout for huge tests is raised to 600 s.

The `huge` fixture has 100 files and 25 274 changed lines. The measurement doesn't cover the entire PR. Twenty-four cards are collapsed for a reason (viewed or generated file) and don't request parsing, so 76 files and 21 260 lines reach the worker and renderer. Constants in `@sherpa/fixtures` fix these counts, and the test checks them, so the run's numbers describe a load of exactly this size.

What is measured:

- time to the first diff frame.
- patch parsing in the worker: total, mean, p95, maximum, number of parsed files (cache hits don't count).
- cold and warm scrolling frame times, in two series: frame work (measured around position assignment with forced layout) and the interval between adjacent frames.
- DOM node count.
- heap size, if the Chromium build exposes it.

All measurements print as `PERF …` lines and also appear as report annotations.

The budget is mean ≤ 16.7 ms, p95 ≤ 33 ms (`docs/architecture.md §6`). It is enabled and fails the run:

- on `large` (64 files), only for frame work. Intervals between frames aren't checked.
- on `huge`, for both metrics, on cold and warm passes, in both huge tests. The route also has a DOM node limit.

The `HUGE_BUDGET_ENFORCED` switch at the top of the spec is currently `true`. It provides one place to temporarily disable the budget. Its presence doesn't mean the budget is only recorded.

## 6. State gallery

`packages/ui/gallery.html` and `packages/ui/src/dev/gallery/` render screen states deterministically from `@sherpa/fixtures`, using only static props, with no server or token. Run:

```
pnpm --filter @sherpa/ui dev
```

and open `/gallery.html`. States grouped by subsystem are on the left, the selected state is on the right. State, language, theme and text size live in the address bar (`#state=…&locale=ru&theme=auto|dark|light&textsize=m|l`. The theme defaults to dark so cards don't depend on the system theme), so a link to a specific state can be shared. Changing the state or language remounts the render and reapplies initial props. The gallery isn't included in the production build, which builds only `index.html`.

The gallery is used for visual acceptance. Open it beside the `docs/design/Sherpa.dc.html` prototype at the same viewport size and fix differences until they match. A new state or component needs a new gallery card.

Each state group has a `*-states.test.tsx` test. These check markup without image comparisons. Each test first checks that exactly the states created by the group are registered, in a fixed order. Adding a state outside the registry fails the test. It then checks the visible contract from the specification: labels, chips, counters, and whether elements are present or absent. Most files render to a string. A few mount in jsdom where focus and input behaviour need checking. A shared registry test checks unique identifiers and that every state mounts and unmounts without exceptions in both languages, catching missing dictionary keys.
