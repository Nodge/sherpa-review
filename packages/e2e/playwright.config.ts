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
        // defaults to `en-US` without this, while the specs look for Russian strings (M5-T2).
        locale: 'en-US',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
