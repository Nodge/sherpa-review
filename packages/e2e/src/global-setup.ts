import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Builds the production UI once before the entire Playwright run. */
export default async function globalSetup(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn('pnpm', ['--filter', '@sherpa/ui', 'build'], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`UI build exited with code=${String(code)} signal=${String(signal)}`));
        });
    });
}
