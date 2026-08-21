import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vite';

const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * UI build. Only `index.html` goes into the production build: `gallery.html` (the state gallery)
 * and `dev.html` (M0 echo loop demo) are development pages, available in `vite dev` and not
 * increase the server bundle's size.
 *
 * Fonts arrive in an npm package and go into `dist/assets`, so no network is needed at runtime.
 */
const proxy = devProxy();

export default defineConfig({
    plugins: [react()],
    define: { __SHERPA_VERSION__: JSON.stringify(packageJson.version) },
    server: proxy === null ? {} : { proxy },
});

/**
 * Development proxy to a running Sherpa server: `dev.html` uses the same `/api` endpoints as the main page.
 * The address comes from `SHERPA_SERVER`, otherwise from the running server's manifest
 * (`~/.sherpa/servers/<PR key>.json`, rpc-design §8). The port is ephemeral and cannot be hardcoded.
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
