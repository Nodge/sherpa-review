import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const uiDist = resolve(root, '../ui/dist');
const assetsModule = resolve(root, 'src/ui-assets.ts');
const outfile = resolve(root, 'dist/sherpa-server.mjs');

let assets;
try {
    assets = collectUiAssets(uiDist);
} catch (error) {
    // Missing UI means a forgotten step, not a broken build. The user needs instructions, not a stack trace.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
}

/**
 * Server bundle: one self-contained ESM file with embedded UI assets. No native dependencies:
 * storage uses built-in `node:sqlite`, so the whole server builds into one file (rpc-design §2).
 */
await build({
    entryPoints: [resolve(root, 'src/bundle.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.13',
    packages: 'bundle',
    banner: { js: '#!/usr/bin/env node' },
    plugins: [inlineUiAssets(assetsModule, assets)],
    logLevel: 'info',
});

chmodSync(outfile, 0o755);

/**
 * Replaces the `src/ui-assets.ts` module: the map is empty in source, filled with `ui/dist` contents in the bundle.
 * Development serves the UI from disk, the distribution serves it from memory, with no mode branches in the code.
 */
function inlineUiAssets(modulePath, files) {
    return {
        name: 'sherpa-ui-assets',
        setup(pluginBuild) {
            pluginBuild.onLoad({ filter: /src[\\/]ui-assets\.ts$/ }, (args) => {
                if (resolve(args.path) !== modulePath) {
                    return null;
                }
                return {
                    contents: `export const UI_ASSETS = ${JSON.stringify(files)};\n`,
                    loader: 'ts',
                };
            });
        },
    };
}

/** Map of "path within the build → base64". An empty UI build is an error with instructions. */
function collectUiAssets(distDir) {
    const files = {};
    for (const file of walk(distDir)) {
        const pathname = `/${relative(distDir, file).split(sep).join(posix.sep)}`;
        files[pathname] = readFileSync(file).toString('base64');
    }

    if (files['/index.html'] === undefined) {
        throw new Error(
            `@sherpa/server: no built UI in ${distDir}. Run \`pnpm --filter @sherpa/ui build\` first, ` +
                'then build the server bundle.',
        );
    }
    return files;
}

function walk(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    const files = [];
    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...walk(full));
        } else {
            files.push(full);
        }
    }
    return files;
}
