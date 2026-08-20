import { chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const outfile = resolve(root, 'dist/sherpa.mjs');

// The CLI produces a single self-contained ESM file with everything inlined.
// Only Node built-in modules are available at runtime (rpc-design §11.1).
await build({
    entryPoints: [resolve(root, 'src/index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.13',
    packages: 'bundle',
    banner: { js: '#!/usr/bin/env node' },
    define: { __SHERPA_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'info',
});

chmodSync(outfile, 0o755);
