# @sherpa/e2e

`@sherpa/e2e` holds the Sherpa end-to-end tests. They are Playwright specs that run in Chromium against the production `@sherpa/ui` build and the `@sherpa/cli` bundle.

## Running the tests

The tests need Playwright Chromium. Install it first:

```
pnpm --filter @sherpa/e2e exec playwright install chromium
```

Then run the suite:

```
pnpm --filter @sherpa/e2e e2e
```

`globalSetup` builds the production `@sherpa/ui` and the `@sherpa/cli` bundle once for the whole run.

## How a test gets its server and agent

Each test starts `FixtureHost` with its own temporary `--sherpa-dir` and removes that directory afterward. The agent session comes from `server.worker`, which uses the CLI bundle and `FakeWorker`.

The test itself writes the worker loop. `worker next` waits a long time for a task, so a test calls it only when the server is known to have enqueued one.

To simulate a push, a test calls the development endpoint `POST /api/dev/fixture/advance-iteration` (`advanceIteration`). The next declared fixture iteration becomes active, and the tab learns about it through SSE.

The F3 specs (`f3.spec.ts`, `f3-forcepush.spec.ts`) set `test.setTimeout(240_000)`. Each of them builds two complete routes through the CLI bundle, and on a slow machine that takes longer than the shared 120 s timeout.

## Performance fixture

The `fixture-huge` performance fixture has 100 files and 25 274 changed lines. The performance spec measures time to the first diff frame, worker parsing, cold and warm scrolling frame times in both views, and DOM node count.

The measurement does not cover the whole PR. Of the 100 file cards, 24 are collapsed for a reason (14 `viewed`, 10 `generated`) and request no parsing. That leaves 76 files and 21 260 lines that reach the worker and line rendering, and `@sherpa/fixtures` records both counts as `HUGE_PARSED_FILE_COUNT` and `HUGE_PARSED_LINE_COUNT`. Read the run figures as a load of that size.

To run only the performance spec:

```
pnpm --filter @sherpa/e2e e2e src/performance.spec.ts
```

The spec prints its figures as `PERF …` lines and repeats them in `performance` annotations. On `huge` it enforces the budget from [`docs/testing.md`](../../docs/testing.md) §5 (avg ≤ 16.7 ms, p95 ≤ 33 ms) through `HUGE_BUDGET_ENFORCED`, so a run that exceeds the budget fails the spec. The spec also runs in the full `e2e` suite, where it adds about a minute and a half.
