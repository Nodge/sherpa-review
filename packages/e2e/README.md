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
