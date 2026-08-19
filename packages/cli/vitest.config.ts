import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Both build.test.ts and protocol.scenarios.test.ts need the bundle. Build it before any test files.
        globalSetup: ['./src/bundle.global-setup.ts'],
    },
});
