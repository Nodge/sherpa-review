import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
// The distribution has one version, taken from the root package.json `version` field.
// Package versions aren't the source.
const version = JSON.parse(readFileSync(resolve(root, '../../package.json'), 'utf8')).version;
const outfile = resolve(root, 'dist/sherpa-review.mjs');

// The CLI produces a single self-contained ESM file with everything inlined.
// Only Node built-in modules are available at runtime (docs/protocol.md §11 item 1).
const result = await build({
    entryPoints: [resolve(root, 'src/index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.13',
    packages: 'bundle',
    banner: { js: '#!/usr/bin/env node' },
    define: { __SHERPA_VERSION__: JSON.stringify(version) },
    // Metafile input paths are relative to it.
    absWorkingDir: root,
    metafile: true,
    logLevel: 'info',
});

chmodSync(outfile, 0o755);
// What went into the bundle, for the third-party license notices of the npm package.
writeFileSync(resolve(root, 'dist/sherpa-review.meta.json'), JSON.stringify(result.metafile));
