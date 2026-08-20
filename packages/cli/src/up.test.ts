import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import type { ServerStartOptions, ServerStartResult } from './up.js';
import { ensureServer, extractUiUrl, findRepoRoot, spawnServerStartWith } from './up.js';

const PR_KEY = 'github-quillmart--quillmart--777';
const UI_URL = 'UI: http://127.0.0.1:53321/#token=secret';

describe('Sherpa checkout root', () => {
    let workDir: string;
    let root: string;

    beforeEach(async () => {
        // Real tmp instead of an fs mock: the symlink case requires an actual symlink.
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-up-'));
        root = path.join(workDir, 'sherpa');
        await fs.mkdir(path.join(root, 'packages', 'skill', 'bin'), { recursive: true });
        await fs.mkdir(path.join(root, 'packages', 'cli', 'dist'), { recursive: true });
        await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
        await fs.writeFile(path.join(root, 'packages', 'skill', 'bin', 'sherpa.mjs'), '// bundle\n');
        await fs.writeFile(path.join(root, 'packages', 'cli', 'dist', 'sherpa.mjs'), '// bundle\n');
    });

    afterEach(async () => {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it('finds the root above the CLI file in both the skill package and the CLI dist', async () => {
        await expect(findRepoRoot(path.join(root, 'packages', 'skill', 'bin', 'sherpa.mjs'))).resolves.toBe(
            await fs.realpath(root),
        );
        await expect(findRepoRoot(path.join(root, 'packages', 'cli', 'dist', 'sherpa.mjs'))).resolves.toBe(
            await fs.realpath(root),
        );
    });

    it('finds the module through a symlink to the skill directory', async () => {
        // This is how the skill is installed: `~/.claude/skills/sherpa -> <root>/packages/skill`.
        const link = path.join(workDir, 'skills-sherpa');
        await fs.symlink(path.join(root, 'packages', 'skill'), link, 'dir');

        await expect(findRepoRoot(path.join(link, 'bin', 'sherpa.mjs'))).resolves.toBe(await fs.realpath(root));
    });

    it('outside a checkout, returns a readable error about running from the repository', async () => {
        const stray = path.join(workDir, 'sherpa.mjs');
        await fs.writeFile(stray, '// bundle\n');

        await expect(findRepoRoot(stray)).rejects.toThrow('checkout');
    });

    it('returns the same error for an empty or nonexistent launch path without a stack trace', async () => {
        await expect(findRepoRoot(undefined)).rejects.toThrow(CliError);
        await expect(findRepoRoot('   ')).rejects.toThrow(CliError);
        await expect(findRepoRoot(path.join(workDir, 'no-such.mjs'))).rejects.toThrow('checkout');
    });
});

describe('UI link from server startup output', () => {
    it('reads the `UI:` line among other output', () => {
        const output = [
            '> @sherpa/server@0.0.0 start',
            `sherpa: server for PR ${PR_KEY} started (PID 4242, log ~/.sherpa/prs/${PR_KEY}/server.log)`,
            UI_URL,
            '',
        ].join('\n');

        expect(extractUiUrl(output)).toBe('http://127.0.0.1:53321/#token=secret');
    });

    it('Windows line endings do not break parsing', () => {
        expect(extractUiUrl(`sherpa: server is already running\r\n${UI_URL}\r\n`)).toBe(
            'http://127.0.0.1:53321/#token=secret',
        );
    });

    it('returns null if the line is absent', () => {
        expect(extractUiUrl('sherpa: UI is not built. Build the UI: `pnpm --filter @sherpa/ui build`.\n')).toBe(null);
    });
});

describe('server startup in `up`', () => {
    function starterOf(result: ServerStartResult): {
        start: (options: ServerStartOptions) => Promise<ServerStartResult>;
        calls: ServerStartOptions[];
    } {
        const calls: ServerStartOptions[] = [];
        return {
            calls,
            start: (options) => {
                calls.push(options);
                return Promise.resolve(result);
            },
        };
    }

    const options: ServerStartOptions = { root: '/checkout', prKey: PR_KEY, sherpaDir: undefined };

    it('success returns the UI link and passes startup arguments to the command', async () => {
        const { start, calls } = starterOf({ code: 0, output: `sherpa: started\n${UI_URL}\n` });

        await expect(ensureServer(start, options)).resolves.toBe('http://127.0.0.1:53321/#token=secret');
        expect(calls).toEqual([options]);
    });

    it('nonzero code shows command output unchanged and forbids starting the loop', async () => {
        const { start } = starterOf({ code: 1, output: 'sherpa: UI is not built. Build the UI.\n' });

        await expect(ensureServer(start, options)).rejects.toThrow('sherpa: UI is not built');
        await expect(ensureServer(start, options)).rejects.toThrow('do not start the worker loop');
    });

    it('code 0 without a UI link reports a version mismatch instead of silent success', async () => {
        const { start } = starterOf({ code: 0, output: 'sherpa: server started\n' });

        await expect(ensureServer(start, options)).rejects.toThrow('UI link');
    });

    it('empty output from a failed command does not become an empty error', async () => {
        const { start } = starterOf({ code: 127, output: '   \n' });

        await expect(ensureServer(start, options)).rejects.toThrow('(no output)');
    });
});

describe('real startup command spawning', () => {
    let workDir: string;

    beforeEach(async () => {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-spawn-'));
    });

    afterEach(async () => {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    /** Executable pnpm substitute: arguments do not matter here, process behaviour does. */
    async function fakeCommand(body: string): Promise<string> {
        const file = path.join(workDir, 'fake-pnpm.mjs');
        await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
        return file;
    }

    const options: ServerStartOptions = { root: '', prKey: PR_KEY, sherpaDir: undefined };

    it('passes command output and exit code to the caller', async () => {
        const command = await fakeCommand(
            `process.stdout.write('${UI_URL}\\n'); process.stderr.write('build noise\\n'); process.exit(3);`,
        );

        const result = await spawnServerStartWith(
            { ...options, root: workDir },
            { command, timeoutMs: 10_000 },
        );

        expect(result.code).toBe(3);
        expect(result.output).toContain(UI_URL);
        expect(result.output).toContain('build noise');
    });

    it('a startup process ignoring SIGTERM does not hang the CLI: the timer returns an error', async () => {
        // The process ignores SIGTERM and leaves stdout open. Waiting for `close` would take forever.
        const command = await fakeCommand("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");

        await expect(
            spawnServerStartWith({ ...options, root: workDir }, { command, timeoutMs: 500 }),
        ).rejects.toThrow('did not start within');
    }, 10_000);

    it('a missing command returns a readable pnpm error without a stack trace', async () => {
        await expect(
            spawnServerStartWith(
                { ...options, root: workDir },
                { command: path.join(workDir, 'no-such-command'), timeoutMs: 10_000 },
            ),
        ).rejects.toThrow('pnpm');
    });
});
