Run: `pnpm --filter @sherpa/e2e e2e`.
Requires Playwright Chromium: `pnpm --filter @sherpa/e2e exec playwright install chromium`.
The production build of `@sherpa/ui` and the `@sherpa/cli` bundle are built automatically once in `globalSetup`.
Each test starts FixtureHost with a separate temporary `--sherpa-dir` and removes it after the run.
`server.worker` provides the agent session (CLI bundle, `FakeWorker`). The test writes the loop itself: `worker next`
waits a long time for a task, so only claim one when the server is known to have queued it.
