import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROGRESS_TEXT_MAX_CHARS, RESULT_MAX_BYTES } from '@sherpa/protocol';
import type { SherpaServer } from '@sherpa/server';
import { startServer } from '@sherpa/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliIo } from './cli.js';
import { run } from './cli.js';
import type { ServerStartOptions } from './up.js';

const PR_KEY = 'github-quillmart--quillmart--777';

interface Invocation {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** Full loop against a real server. Commands are function calls, HTTP is real. */
describe('CLI against server', () => {
    let sherpaDir: string;
    let workDir: string;
    let server: SherpaServer | null;

    beforeEach(async () => {
        sherpaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-state-'));
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-work-'));
        server = null;
    });

    afterEach(async () => {
        await server?.close();
        await fs.rm(sherpaDir, { recursive: true, force: true });
        await fs.rm(workDir, { recursive: true, force: true });
    });

    async function start(longPollSeconds = 0.2): Promise<SherpaServer> {
        server = await startServer({ prKey: PR_KEY, sherpaDir, longPollSeconds });
        return server;
    }

    async function sherpa(...argv: string[]): Promise<Invocation> {
        return sherpaWithEnv({}, ...argv);
    }

    /** The same call with extra environment variables to simulate a second session on the same PR. */
    async function sherpaWithEnv(
        extraEnv: Record<string, string>,
        ...argv: string[]
    ): Promise<Invocation> {
        return sherpaWith({ extraEnv }, ...argv);
    }

    interface Overrides {
        readonly extraEnv?: Record<string, string>;
        /** Mock server startup: the test already runs it in-process, so there is no need to call pnpm. */
        readonly startServer?: CliIo['startServer'];
    }

    async function sherpaWith(overrides: Overrides, ...argv: string[]): Promise<Invocation> {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const io: CliIo = {
            env: { SHERPA_DIR: sherpaDir, SHERPA_PR: PR_KEY, ...overrides.extraEnv },
            out: (text) => stdout.push(text),
            err: (text) => stderr.push(text),
            // The test file is in a Sherpa checkout: find the root from it just as from the CLI bundle.
            entry: fileURLToPath(import.meta.url),
            ...(overrides.startServer === undefined ? {} : { startServer: overrides.startServer }),
        };

        const code = await run(argv, io);
        return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    }

    /** Server startup as `up` would see it: a live server is already running, and the output matches `start`. */
    function fakeStart(calls: ServerStartOptions[]): CliIo['startServer'] {
        return async (options) => {
            calls.push(options);
            const manifest = JSON.parse(
                await fs.readFile(path.join(sherpaDir, 'servers', `${PR_KEY}.json`), 'utf8'),
            ) as { port: number; token: string };
            return {
                code: 0,
                output:
                    `sherpa: server for PR ${PR_KEY} is already running (PID 4242)\n` +
                    `UI: http://127.0.0.1:${String(manifest.port)}/#token=${manifest.token}\n`,
            };
        };
    }

    async function readWorkerIdFile(): Promise<string> {
        return (await fs.readFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'utf8')).trim();
    }

    function enqueueEcho(running: SherpaServer, instructions = 'Return the file contents unchanged.'): number {
        return running.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions,
            contextFiles: ['/tmp/sherpa/task-context.md'],
        }).id;
    }

    async function writeFile(name: string, content: string): Promise<string> {
        const file = path.join(workDir, name);
        await fs.writeFile(file, content);
        return file;
    }

    it('up starts the server, registers the worker and prints the link with instructions', async () => {
        const running = await start();
        const calls: ServerStartOptions[] = [];

        const result = await sherpaWith({ startServer: fakeStart(calls) }, 'up', '--harness', 'claude-code');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`http://127.0.0.1:${String(running.port)}/#token=`);
        expect(result.stdout).toContain('Show this link to the user in full');
        expect(result.stdout).toContain(`sherpa worker next --pr ${PR_KEY}`);
        // Output never mentions the server or registration. The model has no need to know about them.
        expect(result.stdout).not.toContain('register');

        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId: await readWorkerIdFile(),
            harness: 'claude-code',
        });
        // Pass the state directory from the environment to the server: it does not read SHERPA_DIR itself.
        expect(calls).toEqual([{ root: expect.any(String) as string, prKey: PR_KEY, sherpaDir }]);
    });

    it('repeated up renews the same slot without starting another server', async () => {
        const running = await start();
        const calls: ServerStartOptions[] = [];
        // No pinned identity. Each CLI invocation takes a fresh id, as in real use.
        await sherpaWith({ startServer: fakeStart(calls) }, 'up', '--harness', 'claude-code');
        const workerId = await readWorkerIdFile();

        const again = await sherpaWith({ startServer: fakeStart(calls) }, 'up', '--harness', 'claude-code');

        expect(again.code).toBe(0);
        expect(again.stdout).toContain('http://127.0.0.1:');
        // The live slot for this PR is ours: renew it instead of rejecting it with a conflict.
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId });
        expect(await readWorkerIdFile()).toBe(workerId);
        // Server startup is itself idempotent: both calls found the live server through the manifest.
        expect(calls).toHaveLength(2);
    });

    it('up after a session breaks picks up the previous session\'s live slot without waiting for its death', async () => {
        const running = await start();
        // The previous session registered and disconnected. The server still considers it alive.
        running.workerRegistry.register('session-from-a-past-life', 'claude-code');
        await fs.mkdir(path.join(sherpaDir, 'prs', PR_KEY), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'session-from-a-past-life\n');

        const result = await sherpaWith({ startServer: fakeStart([]) }, 'up', '--harness', 'codex');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('http://127.0.0.1:');
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId: 'session-from-a-past-life',
            harness: 'codex',
        });
    });

    it('up with another live worker returns the server text and code 1', async () => {
        const running = await start();
        running.workerRegistry.register('other-session', 'codex');
        // The state file holds a different session, so it cannot be used to pick up another session's slot.
        await fs.mkdir(path.join(sherpaDir, 'prs', PR_KEY), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'our-previous-session\n');

        const second = await sherpaWith({ startServer: fakeStart([]) }, 'up', '--harness', 'claude-code');

        expect(second.code).toBe(1);
        expect(second.stderr).toContain('another live session');
        expect(second.stdout).not.toContain('http://127.0.0.1:');
        expect(running.workerRegistry.status()).toMatchObject({ workerId: 'other-session' });
    });

    it('up with a pinned SHERPA_WORKER_ID does not pick up another slot: all commands use the pinned id', async () => {
        const running = await start();
        await sherpaWith({ startServer: fakeStart([]) }, 'up');
        const workerId = await readWorkerIdFile();

        const pinned = await sherpaWith({ extraEnv: { SHERPA_WORKER_ID: 'session-2' }, startServer: fakeStart([]) }, 'up');

        expect(pinned.code).toBe(1);
        expect(pinned.stderr).toContain('another live session');
        expect(running.workerRegistry.status()).toMatchObject({ workerId });
    });

    it('up without a server: startup errors reach the model unchanged', async () => {
        const failing: CliIo['startServer'] = () =>
            Promise.resolve({ code: 1, output: 'sherpa: UI is not built. Build the UI.\n' });

        const result = await sherpaWith({ startServer: failing }, 'up');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('sherpa: UI is not built');
        expect(result.stderr).toContain('do not start the worker loop');
    });

    it('register makes the session a worker and saves it in the state file', async () => {
        const running = await start();

        const result = await sherpa('worker', 'register', '--harness', 'claude-code');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('sherpa worker next');
        const workerId = await readWorkerIdFile();
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId,
            harness: 'claude-code',
        });

        const stats = await fs.stat(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'));
        expect(stats.mode & 0o777).toBe(0o600);
    });

    it('reconnection creates a new identity: register does not reuse the previous id', async () => {
        const running = await start();
        await fs.mkdir(path.join(sherpaDir, 'prs', PR_KEY), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'session-from-a-past-life\n');

        await sherpa('worker', 'register');

        const workerId = await readWorkerIdFile();
        expect(workerId).not.toBe('session-from-a-past-life');
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId });

        // Subsequent commands use the saved id, so the server sees the same worker.
        await sherpa('worker', 'next');
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId });
    });

    it('rejects a second live session and keeps the worker file owned by the first', async () => {
        await start();
        await sherpa('worker', 'register', '--harness', 'claude-code');
        const first = await readWorkerIdFile();

        const second = await sherpa('worker', 'register', '--harness', 'codex');

        expect(second.code).toBe(1);
        expect(second.stderr).toContain('another live session');
        expect(second.stderr).toContain('claude-code');
        // The server says to wait and restart the skill. Adding "stop the loop" would contradict that.
        // and is also wrong because this session was never a worker.
        expect(second.stderr).toContain('start the Sherpa skill again');
        expect(second.stderr).not.toContain('stop the loop');
        expect(await readWorkerIdFile()).toBe(first);
    });

    it('a displaced session gets an instruction to stop instead of advice to retry', async () => {
        const running = await start();
        await sherpa('worker', 'register');
        const taskId = enqueueEcho(running);

        const displaced = await sherpaWithEnv({ SHERPA_WORKER_ID: 'other-session' }, 'worker', 'next');

        expect(displaced.code).toBe(1);
        expect(displaced.stderr).toContain('stop the loop');
        expect(displaced.stderr).not.toContain('worker_conflict');
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'queued', workerId: null });
    });

    it('empty queue: next returns on timeout and asks to be called again', async () => {
        await start();

        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('worker next');
        expect(result.stdout).not.toContain('TASK');
    });

    it('loop: task → work → submission → next `next`', async () => {
        const running = await start();
        const taskId = enqueueEcho(running, 'Summarize the diff in one paragraph.');

        const issued = await sherpa('worker', 'next');
        expect(issued.code).toBe(0);
        expect(issued.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 1`);
        expect(issued.stdout).toContain('Summarize the diff in one paragraph.');
        expect(issued.stdout).toContain('Context: /tmp/sherpa/task-context.md');
        expect(issued.stdout).toContain(`sherpa task complete ${String(taskId)} --file <path>`);

        const progress = await sherpa('task', 'progress', String(taskId), '--text', 'reading the diff');
        expect(progress.code).toBe(0);
        expect(running.queue.getTask(taskId)?.progressText).toBe('reading the diff');

        const file = await writeFile('answer.md', 'Completed answer.');
        const completed = await sherpa('task', 'complete', String(taskId), '--file', file);
        expect(completed.code).toBe(0);
        expect(completed.stdout).toContain('accepted');
        expect(completed.stdout).toContain('sherpa worker next');
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Finished answer.' });

        const again = await sherpa('worker', 'next');
        expect(again.stdout).not.toContain('TASK');
    });

    it('server rejects an empty result with a list of errors, and the task stays leased', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const file = await writeFile('empty.md', '   \n');
        const rejected = await sherpa('task', 'complete', String(taskId), '--file', file);

        // rejected is a dialogue with the model, not a failure. The exit code is zero.
        expect(rejected.code).toBe(0);
        expect(rejected.stdout).toContain('rejected');
        expect(rejected.stdout).toContain('1. ');
        expect(rejected.stdout).toContain(`sherpa task complete ${String(taskId)} --file <path>`);
        expect(running.queue.getTask(taskId)?.status).toBe('leased');
    });

    it('rejects an oversized result locally before sending it', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const file = await writeFile('big.md', 'é'.repeat(RESULT_MAX_BYTES));
        const refused = await sherpa('task', 'complete', String(taskId), '--file', file);

        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('the limit is 256 KB');
        expect(refused.stderr).toContain('stays yours');
        // The server never saw the attempt. The task is still leased, not failed.
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'leased', result: null });
    });

    it('rejects --text beyond the contract limit before sending it', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const long = 't'.repeat(PROGRESS_TEXT_MAX_CHARS + 1);
        const result = await sherpa('task', 'progress', String(taskId), '--text', long);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('contract');
        expect(running.queue.getTask(taskId)?.progressText).toBe(null);
    });

    it('repeated complete on a closed task is a no-op', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');
        const file = await writeFile('answer.md', 'Answer.');
        await sherpa('task', 'complete', String(taskId), '--file', file);

        const repeated = await sherpa('task', 'complete', String(taskId), '--file', file);

        expect(repeated.code).toBe(0);
        expect(repeated.stdout).toContain('already complete');
        expect(repeated.stdout).toContain('sherpa worker next');
    });

    it('task refusal reaches the queue with its reason', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');

        const failed = await sherpa('task', 'fail', String(taskId), '--reason', 'no access to the repository');

        expect(failed.code).toBe(0);
        expect(failed.stdout).toContain('refusal');
        expect(running.queue.getTask(taskId)).toMatchObject({
            status: 'failed',
            failReason: 'no access to the repository',
        });
    });

    it('unknown task number: readable server error, exit code 1', async () => {
        await start();

        const result = await sherpa('task', 'fail', '999', '--reason', 'x');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('sherpa/999');
        expect(result.stderr).not.toContain('unknown_task');
    });

    it('missing result file gives a clear error without contacting the server', async () => {
        await start();

        const result = await sherpa('task', 'complete', '1', '--file', path.join(workDir, 'missing.md'));

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('missing.md');
        expect(result.stderr).toContain('sherpa task complete 1 --file');
    });

    it('no server: CLI says to run the skill again', async () => {
        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`Sherpa server for PR ${PR_KEY} was not found or is not responding`);
        expect(result.stderr).toContain('Restart the Sherpa skill');
    });

    it('manifest exists but the server is dead: the same error', async () => {
        const running = await start();
        const manifest = JSON.parse(
            await fs.readFile(path.join(sherpaDir, 'servers', `${PR_KEY}.json`), 'utf8'),
        ) as Record<string, unknown>;
        await running.close();
        server = null;
        await fs.mkdir(path.join(sherpaDir, 'servers'), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'servers', `${PR_KEY}.json`), JSON.stringify(manifest));

        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not found or is not responding');
    });

    it('wrong token: server rejects it, CLI hides the error code', async () => {
        const running = await start();
        const manifestPath = path.join(sherpaDir, 'servers', `${PR_KEY}.json`);
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, token: 'wrong token' }));
        enqueueEcho(running);

        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('sherpa:');
        expect(result.stderr).not.toContain('unauthorized');
    });
});
