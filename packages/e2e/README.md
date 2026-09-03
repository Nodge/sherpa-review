Run: `pnpm --filter @sherpa/e2e e2e`.
Requires Playwright Chromium: `pnpm --filter @sherpa/e2e exec playwright install chromium`.
The production build of `@sherpa/ui` and the `@sherpa/cli` bundle are built automatically once in `globalSetup`.
Each test starts FixtureHost with a separate temporary `--sherpa-dir` and removes it after the run.
`server.worker` provides the agent session (CLI bundle, `FakeWorker`). The test writes the loop itself: `worker next`
waits a long time for a task, so only claim one when the server is known to have queued it.
A "push" is simulated by the dev endpoint `POST /api/dev/fixture/advance-iteration` (`advanceIteration` helper):
the fixture's next declared iteration becomes active, and the tab learns about it through SSE.
The F3 specs (`f3.spec.ts`, `f3-forcepush.spec.ts`) set `test.setTimeout(240_000)`. Each runs 2
full route generations through the CLI bundle, which exceed the shared 120 s on a slow machine.
The `fixture-huge` performance fixture has 100 files and 25 274 changed lines (M5-T12). It measures
time to first diff frame, worker parsing, cold and warm scroll frame times in both views,
and the DOM node count. The measurement covers only part of the PR: 24 cards are collapsed for a reason (14 `viewed`,
10 `generated`) and do not request parsing, so the worker and line rendering receive
76 files and 21 260 lines (`HUGE_PARSED_FILE_COUNT`, `HUGE_PARSED_LINE_COUNT` in `@sherpa/fixtures`).
Read the run's numbers as a load of that size.
Run: `pnpm --filter @sherpa/e2e e2e src/performance.spec.ts`. Numbers print
as `PERF …` lines and also appear as `performance` annotations. The requirements budget (avg ≤ 16.7 ms, p95 ≤ 33 ms)
on `huge` is only recorded for now (`HUGE_BUDGET_ENFORCED`). Only breakage fails the spec.
The run is long (about 1.5 minutes). The general `e2e` command does not treat it separately. Run it manually before release.
