/// <reference types="vitest/config" />
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import type { Plugin, ProxyOptions, Rolldown } from 'vite';
import { defineConfig } from 'vite';

// The distribution has one version, the `version` of the published package, `packages/npm/package.json`.
const distributionPackageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL('../npm/package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * UI build. Only `index.html` goes into the production build: `gallery.html` (the state gallery)
 * and `dev.html` (the echo loop demo) are development pages available in `vite dev`, and they do not
 * increase the server bundle's size.
 *
 * Fonts arrive in an npm package and go into `dist/assets`, so no network is needed at runtime.
 */
const proxy = devProxy();
const bundled = bundledModules();

export default defineConfig({
    plugins: [react(), bundled.main],
    worker: { plugins: () => [bundled.worker()] },
    build: {
        // Package assets are always emitted, so their source reaches the license notices. Inlined, they would leave no trace.
        assetsInlineLimit: (file) => (file.split(/[\\/]/u).includes('node_modules') ? false : undefined),
    },
    define: { __SHERPA_VERSION__: JSON.stringify(distributionPackageJson.version) },
    server: proxy === null ? {} : { proxy },
    // The default 5 s is too short: progress scenario tests run dozens of rerenders and time out on
    // a busy machine (`pnpm -r test` runs all packages at once),
    // though they take 1–2 s alone. This still catches a hung test, just later.
    test: { testTimeout: 20_000, hookTimeout: 20_000 },
});

/**
 * Writes the modules whose code ended up in the build, the files the build emitted and the sources of its assets to
 * `build/bundled-modules.json` for the third-party license notices of the npm package. It lives outside `dist/`
 * because the server bundle embeds all of `dist/`. Only a build written to `dist/` updates it, so the list always
 * describes the assets the server embeds. Worker bundles are separate builds and report through `worker.plugins`.
 */
function bundledModules(): { main: Plugin; worker: () => Plugin } {
    const modules = new Set<string>();
    const workerFiles = new Set<string>();
    let active = false;
    let root = '';

    const collect = (bundle: Rolldown.OutputBundle): void => {
        for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') {
                continue;
            }
            for (const [id, module] of Object.entries(output.modules)) {
                // Extracted CSS reports no rendered length, so node_modules CSS imported from JS/TS counts as bundled.
                // `@import` inside CSS never shows up here: `src/styles/package-imports.test.ts` forbids package imports there.
                const packageCss = id.includes('/node_modules/') && /\.css(\?|$)/u.test(id);
                if (module.renderedLength > 0 || packageCss) {
                    modules.add(id);
                }
            }
        }
    };

    const main: Plugin = {
        name: 'sherpa-bundled-modules',
        apply: 'build',
        configResolved(config) {
            root = config.root;
            const outDir = path.resolve(root, config.build.outDir);
            active = config.build.write && outDir === fileURLToPath(new URL('dist', import.meta.url));
        },
        buildStart() {
            modules.clear();
            workerFiles.clear();
        },
        generateBundle(_options, bundle) {
            collect(bundle);
        },
        writeBundle(_options, bundle) {
            if (!active) {
                return;
            }
            const file = fileURLToPath(new URL('build/bundled-modules.json', import.meta.url));
            mkdirSync(path.dirname(file), { recursive: true });
            // Source files of emitted assets (fonts, images), as absolute paths: their packages need notices too.
            // Rolldown reports them relative to the root or absolute.
            const assets = Object.fromEntries(
                Object.values(bundle)
                    .filter((output) => output.type === 'asset')
                    .sort((a, b) => (a.fileName < b.fileName ? -1 : 1))
                    .map((asset) => [asset.fileName, asset.originalFileNames.map((file) => path.resolve(root, file)).sort()]),
            );
            const list = {
                files: Object.keys(bundle).sort(),
                modules: [...modules].sort(),
                assets,
                workerFiles: [...workerFiles].sort(),
            };
            writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
        },
    };
    const worker = (): Plugin => ({
        name: 'sherpa-bundled-worker-modules',
        apply: 'build',
        generateBundle(_options, bundle) {
            collect(bundle);
            // The main build emits worker chunks as assets without a source. These names exempt them in the npm build.
            for (const output of Object.values(bundle)) {
                if (output.type === 'chunk') {
                    workerFiles.add(output.fileName);
                }
            }
        },
    });
    return { main, worker };
}

/**
 * Development proxy to a running Sherpa server: `dev.html` uses the same `/api` endpoints as the main page.
 * The address comes from `SHERPA_SERVER`, otherwise from the running server's manifest
 * (`~/.sherpa/servers/<PR key>.json`, docs/protocol.md §8): the port is ephemeral and cannot be hardcoded.
 * A server started after `vite dev` requires restarting the development server.
 */
function devProxy(): Record<string, ProxyOptions> | null {
    const target = process.env.SHERPA_SERVER ?? runningServerOrigin();
    return target === null ? null : { '/api': { target, changeOrigin: false } };
}

/** First live manifest: development mode usually has one open PR. `null` means no server. */
function runningServerOrigin(): string | null {
    const dir = path.join(homedir(), '.sherpa', 'servers');

    let names: readonly string[];
    try {
        names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
        return null;
    }

    for (const name of names) {
        try {
            const manifest = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as { port?: unknown };
            if (typeof manifest.port === 'number') {
                return `http://127.0.0.1:${String(manifest.port)}`;
            }
        } catch {
            // Skip corrupt or unrelated files.
        }
    }
    return null;
}
