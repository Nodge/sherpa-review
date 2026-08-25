Run: `pnpm --filter @sherpa/e2e e2e`.
Requires Playwright Chromium: `pnpm --filter @sherpa/e2e exec playwright install chromium`.
The `@sherpa/ui` production build runs automatically once in `globalSetup`.
Each test starts FixtureHost with a separate temporary `--sherpa-dir` and removes it after the run.
