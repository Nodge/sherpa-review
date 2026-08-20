import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // bundle.test.ts needs the server bundle. Build it once per run before any test files.
        globalSetup: ['./src/bundle.global-setup.ts'],
    },
});
