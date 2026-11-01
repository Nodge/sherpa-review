import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Both suites rebuild `dist/`. Running in parallel would make them compete for one directory.
        fileParallelism: false,
    },
});
