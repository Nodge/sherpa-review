import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Artifacts e2e runs as in production: UI static files and the CLI bundle the fake worker uses. */
export default async function globalSetup(): Promise<void> {
    await run('pnpm', ['--filter', '@sherpa/ui', 'build'], 'UI build');
    await run(process.execPath, ['build.mjs'], 'CLI build', path.join(REPO_ROOT, 'packages/cli'));
}

function run(command: string, args: readonly string[], what: string, cwd: string = REPO_ROOT): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], { cwd, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${what} exited with code=${String(code)} signal=${String(signal)}`));
        });
    });
}
