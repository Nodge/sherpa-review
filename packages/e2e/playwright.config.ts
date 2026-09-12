import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './src',
    globalSetup: './src/global-setup.ts',
    workers: 1,
    fullyParallel: false,
    timeout: 120_000,
    expect: { timeout: 10_000 },
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        // Fix the browser locale: the default UI language setting is `auto`, and chromium
        // otherwise uses `en-US` anyway. These specs look for English strings.
        locale: 'en-US',
        // Fix the system theme for the same reason: the default theme setting is `auto`,
        // and the specs check dark palette colors. The theme spec switches it itself (`emulateMedia`).
        colorScheme: 'dark',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
