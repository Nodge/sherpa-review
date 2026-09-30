import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PROGRESS_TEXT_MAX_CHARS, RESULT_MAX_BYTES } from '@sherpa/protocol';
import type { SherpaServer } from '@sherpa/server';
import { startServer } from '@sherpa/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliIo } from './cli.js';
import { run } from './cli.js';
import { localPrKey } from './local.js';
import { taskResultDirFor, taskResultFileFor, taskResultRootFor } from './paths.js';

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
        // Tests must not call a live review host. Without a host, route warm-up makes no network requests,
        // and this suite only needs the CLI↔server protocol.
        server = await startServer({ prKey: PR_KEY, sherpaDir, longPollSeconds, reviewHostFactory: () => null });
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
        readonly ensureServer?: NonNullable<CliIo['ensureServer']>;
        readonly openBrowser?: NonNullable<CliIo['openBrowser']>;
        readonly runCommand?: NonNullable<CliIo['runCommand']>;
        readonly tmpDir?: string;
    }

    async function sherpaWith(overrides: Overrides, ...argv: string[]): Promise<Invocation> {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const io: CliIo = {
            env: { SHERPA_DIR: sherpaDir, SHERPA_PR: PR_KEY, ...overrides.extraEnv },
            out: (text) => stdout.push(text),
            err: (text) => stderr.push(text),
            // No server bundle beside the test file: it is not needed when the server is already running.
            entry: fileURLToPath(import.meta.url),
            // Result files go into the test working directory instead of the system tmp.
            tmpDir: overrides.tmpDir ?? workDir,
            ...(overrides.ensureServer === undefined ? {} : { ensureServer: overrides.ensureServer }),
            ...(overrides.openBrowser === undefined ? {} : { openBrowser: overrides.openBrowser }),
            ...(overrides.runCommand === undefined ? {} : { runCommand: overrides.runCommand }),
        };

        const code = await run(argv, io);
        return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    }

    /** Executable server bundle substitute: these tests only care about process behaviour. */
    async function fakeServerBin(body: string): Promise<string> {
        const file = path.join(workDir, 'sherpa-server.mjs');
        await fs.writeFile(file, `${body}\n`, { mode: 0o755 });
        return file;
    }

    async function readManifestPid(): Promise<number> {
        const raw = await fs.readFile(path.join(sherpaDir, 'servers', `${PR_KEY}.json`), 'utf8');
        return (JSON.parse(raw) as { pid: number }).pid;
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

    /** Path `worker next` gives the current session for the task result. */
    async function resultFileOf(taskId: number, attempt = 1): Promise<string> {
        const dir = taskResultDirFor(workDir, sherpaDir, PR_KEY, await readWorkerIdFile());
        return taskResultFileFor(dir, { id: taskId, attempt });
    }

    async function writeFile(name: string, content: string): Promise<string> {
        const file = path.join(workDir, name);
        await fs.writeFile(file, content);
        return file;
    }

    it('up finds a live server, opens no new tab and prints a link with instructions', async () => {
        const running = await start();
        const opened: string[] = [];

        const result = await sherpaWith(
            { openBrowser: ({ uiUrl }) => opened.push(uiUrl) },
            'up',
            '--harness',
            'claude-code',
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`http://127.0.0.1:${String(running.port)}/#t=`);
        expect(result.stdout).toContain('Show this link to the user in full');
        expect(result.stdout).toContain(`sherpa worker next --pr ${PR_KEY}`);
        // Output never mentions the server or registration. The model has no need to know about them.
        expect(result.stdout).not.toContain('register');
        expect(opened).toEqual([]);

        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId: await readWorkerIdFile(),
            harness: 'claude-code',
        });
    });

    // `--local` names a directory, not a PR. The key comes from the directory and branch and overrides even SHERPA_PR.
    it('up --local starts a directory review and names the directory in output', async () => {
        const localKey = localPrKey('git', await fs.realpath(workDir), 'feature', 'main~3');
        server = await startServer({
            prKey: localKey,
            sherpaDir,
            longPollSeconds: 0.2,
            reviewHostFactory: () => null,
        });
        const git: NonNullable<CliIo['runCommand']> = (_command, args) =>
            Promise.resolve({
                exitCode: 0,
                stdout:
                    args[0] === 'root'
                        ? `${workDir}\n`
                        : JSON.stringify({ branch: 'feature', user_login: 'alice', hash: 'a'.repeat(40) }),
                stderr: '',
                failure: null,
            });

        const result = await sherpaWith({ runCommand: git }, 'up', '--local', workDir, '--base', 'main~3');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`http://127.0.0.1:${String(server.port)}/#t=`);
        expect(result.stdout).toContain('Reviewing the working tree of');
        expect(result.stdout).toContain('on branch feature, base main~3');
        expect(result.stdout).toContain(`sherpa worker next --pr ${localKey}`);
        expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected' });
    });

    it('opens the browser only on a cold start and without --no-open', async () => {
        const running = await start();
        const uiUrl = `http://127.0.0.1:${String(running.port)}/#t=${running.token}`;
        const open = vi.fn();

        const cold = await sherpaWith(
            { ensureServer: () => Promise.resolve({ uiUrl, started: true }), openBrowser: open },
            'up',
        );
        expect(cold.code).toBe(0);
        expect(open).toHaveBeenCalledWith({ uiUrl });

        open.mockClear();
        await sherpaWith({ ensureServer: () => Promise.resolve({ uiUrl, started: false }), openBrowser: open }, 'up');
        expect(open).not.toHaveBeenCalled();

        await sherpaWith(
            { ensureServer: () => Promise.resolve({ uiUrl, started: true }), openBrowser: open },
            'up',
            '--no-open',
        );
        expect(open).not.toHaveBeenCalled();
    });

    it('opener failure does not fail up and the link stays in stdout', async () => {
        const running = await start();
        const uiUrl = `http://127.0.0.1:${String(running.port)}/#t=${running.token}`;

        const result = await sherpaWith(
            {
                ensureServer: () => Promise.resolve({ uiUrl, started: true }),
                openBrowser: () => {
                    throw new Error('no graphical session');
                },
            },
            'up',
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(uiUrl);
        expect(result.stderr).toBe('');
    });

    it('passes --model to worker status and strips wrapping', async () => {
        const running = await start();

        // The model names itself in whatever form it chooses, here in backticks.
        const result = await sherpaWith({}, 'up', '--harness', 'claude-code', '--model', '`claude-opus-5[1m]`');

        expect(result.code).toBe(0);
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            harness: 'claude-code',
            model: 'claude-opus-5[1m]',
        });
    });

    it('leaves status without a model when --model is missing or empty', async () => {
        const running = await start();

        const blank = await sherpaWith({}, 'up', '--harness=claude-code', '--model=   ');

        expect(blank.code).toBe(0);
        expect(running.workerRegistry.status()).not.toHaveProperty('model');
    });

    it('repeated up takes over its own slot without starting a second server', async () => {
        const running = await start();
        // No pinned identity. Each CLI invocation takes a fresh id, as in real use.
        await sherpaWith({}, 'up', '--harness', 'claude-code');
        const workerId = await readWorkerIdFile();

        const again = await sherpaWith({}, 'up', '--harness', 'claude-code');

        expect(again.code).toBe(0);
        expect(again.stdout).toContain('http://127.0.0.1:');
        // A live session holds the slot, but the fresh session still takes it. There is no conflict here anymore.
        const renewed = await readWorkerIdFile();
        expect(renewed).not.toBe(workerId);
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: renewed });
        // No second server started. The PR manifest still describes the same process.
        expect(await readManifestPid()).toBe(process.pid);
    });

    it('up after a session disconnect takes over its live slot without waiting for it to die', async () => {
        const running = await start();
        // The previous session registered and disconnected. The server still considers it alive.
        running.workerRegistry.register('session-from-a-past-life', 'claude-code');
        await fs.mkdir(path.join(sherpaDir, 'prs', PR_KEY), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'prs', PR_KEY, 'worker-id'), 'session-from-a-past-life\n');

        const result = await sherpaWith({}, 'up', '--harness', 'codex');

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('http://127.0.0.1:');
        // The identity from the file is not reused. A fresh identity takes the slot and now owns the file.
        const workerId = await readWorkerIdFile();
        expect(workerId).not.toBe('session-from-a-past-life');
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId,
            harness: 'codex',
        });
    });

    it('up takes the slot from another live worker: the new session always wins', async () => {
        const running = await start();
        running.workerRegistry.register('other-session', 'codex');

        const second = await sherpaWith({}, 'up', '--harness', 'claude-code');

        expect(second.code).toBe(0);
        expect(second.stdout).toContain('http://127.0.0.1:');
        expect(second.stderr).toBe('');
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId: await readWorkerIdFile(),
            harness: 'claude-code',
        });
    });

    it('two consecutive sessions: the second up takes the first slot and owns the worker file', async () => {
        const running = await start();
        await sherpaWith({ extraEnv: { SHERPA_WORKER_ID: 'session-1' } }, 'up', '--harness', 'claude-code');
        expect(await readWorkerIdFile()).toBe('session-1');

        const second = await sherpaWith({ extraEnv: { SHERPA_WORKER_ID: 'session-2' } }, 'up', '--harness', 'codex');

        expect(second.code).toBe(0);
        expect(await readWorkerIdFile()).toBe('session-2');
        expect(running.workerRegistry.status()).toMatchObject({ workerId: 'session-2', harness: 'codex' });

        // The first session gets an instruction to stop when it resumes the loop.
        const displaced = await sherpaWith({ extraEnv: { SHERPA_WORKER_ID: 'session-1' } }, 'worker', 'next');
        expect(displaced.code).toBe(1);
        expect(displaced.stderr).toContain('stop the loop');
    });

    it('up without a server beside the CLI reports an incomplete distribution and never starts the loop', async () => {
        // The server is not running and its bundle is missing beside the CLI, so there is no way forward.
        const result = await sherpaWith({}, 'up');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('skill distribution is incomplete');
        expect(result.stderr).toContain('do not start the worker loop');
    });

    it('up with a failed server bundle passes its output to the model unchanged', async () => {
        const failing = await fakeServerBin("console.error('cannot open storage'); process.exit(1);");

        const result = await sherpaWith({ extraEnv: { SHERPA_SERVER_BIN: failing } }, 'up');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('cannot open storage');
        expect(result.stderr).toContain('do not start the worker loop');
    }, 20_000);

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

    // Third session label. The agent names the language it uses with the reviewer, and the UI uses it as a hint.
    it('register passes --lang to worker status, omits the label without the flag and rejects unsupported languages', async () => {
        const running = await start();

        expect((await sherpa('worker', 'register', '--harness', 'claude-code', '--lang', 'ru')).code).toBe(0);
        expect(running.workerRegistry.status()).toMatchObject({ harness: 'claude-code', lang: 'ru' });

        expect((await sherpaWithEnv({ SHERPA_WORKER_ID: 'session-without-language' }, 'worker', 'register')).code).toBe(0);
        expect(running.workerRegistry.status()).not.toHaveProperty('lang');

        const rejected = await sherpa('worker', 'register', '--lang', 'de');
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain('--lang expects `ru` or `en`, got `de`');
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
        enqueueEcho(running);
        await sherpa('worker', 'next');
        expect(running.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId });
    });

    it('a second live session takes the slot and owns the worker file', async () => {
        const running = await start();
        await sherpa('worker', 'register', '--harness', 'claude-code');
        const first = await readWorkerIdFile();

        const second = await sherpa('worker', 'register', '--harness', 'codex');

        expect(second.code).toBe(0);
        expect(second.stdout).toContain('sherpa worker next');
        const workerId = await readWorkerIdFile();
        expect(workerId).not.toBe(first);
        expect(running.workerRegistry.status()).toMatchObject({
            kind: 'connected',
            workerId,
            harness: 'codex',
        });
    });

    it('two sessions register at once: the worker file describes the slot owner', async () => {
        const running = await start();

        // Both registrations succeed, and one gets the slot. The file must belong to that session:
        // network response order does not determine registration order, so the server writes the file.
        const [first, second] = await Promise.all([
            sherpaWithEnv({ SHERPA_WORKER_ID: 'session-1' }, 'worker', 'register', '--harness', 'claude-code'),
            sherpaWithEnv({ SHERPA_WORKER_ID: 'session-2' }, 'worker', 'register', '--harness', 'codex'),
        ]);

        expect(first.code).toBe(0);
        expect(second.code).toBe(0);
        const status = running.workerRegistry.status();
        expect(await readWorkerIdFile()).toBe(status.kind === 'never' ? null : status.workerId);

        // The slot owner continues the loop. Its next command reads the id from the file without a conflict.
        enqueueEcho(running);
        const next = await sherpa('worker', 'next');
        expect(next.code).toBe(0);
        expect(next.stderr).toBe('');
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

    it('empty queue: next silently handles consecutive idle responses and returns on the first task', async () => {
        // The server window is 0.1 s, so it returns idle several times while the test waits.
        const running = await start(0.1);
        let settled = false;
        const pending = sherpa('worker', 'next').finally(() => {
            settled = true;
        });

        await delay(600);
        expect(settled).toBe(false);
        const taskId = enqueueEcho(running, 'The task arrived after several empty windows.');

        const issued = await pending;
        expect(issued.code).toBe(0);
        expect(issued.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 1`);
        expect(issued.stdout).not.toContain('No tasks');
        expect(issued.stderr).toBe('');
    });

    it('loop: task → work → submission → next `next`', async () => {
        const running = await start();
        const taskId = enqueueEcho(running, 'Summarize the diff in one paragraph.');

        const issued = await sherpa('worker', 'next');
        expect(issued.code).toBe(0);
        expect(issued.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 1`);
        expect(issued.stdout).toContain('Summarize the diff in one paragraph.');
        expect(issued.stdout).toContain('Context: /tmp/sherpa/task-context.md');
        const resultFile = await resultFileOf(taskId);
        expect(issued.stdout).toContain(`Write the result to ${resultFile} and submit it:`);
        expect(issued.stdout).toContain(`sherpa task complete ${String(taskId)} --file ${resultFile}`);

        const progress = await sherpa('task', 'progress', String(taskId), '--text', 'reading the diff');
        expect(progress.code).toBe(0);
        expect(running.queue.getTask(taskId)?.progressText).toBe('reading the diff');

        await fs.writeFile(resultFile, 'Finished answer.');
        const completed = await sherpa('task', 'complete', String(taskId), '--file', resultFile);
        expect(completed.code).toBe(0);
        expect(completed.stdout).toContain('accepted');
        expect(completed.stdout).toContain('sherpa worker next');
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Finished answer.' });

        // A submitted task is never issued again. The next `next` call takes a new one.
        const nextTaskId = enqueueEcho(running, 'Second task.');
        const again = await sherpa('worker', 'next');
        expect(again.stdout).toContain(`TASK sherpa/${String(nextTaskId)} (echo), attempt 1`);
    });

    it('issued path: creates directories accessible only to the owner', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);

        const issued = await sherpa('worker', 'next');

        expect(issued.code).toBe(0);
        const resultFile = await resultFileOf(taskId);
        expect(issued.stdout).toContain(`--file ${resultFile}`);
        expect(path.dirname(path.dirname(resultFile))).toBe(path.join(taskResultRootFor(workDir), PR_KEY));
        expect((await fs.stat(taskResultRootFor(workDir))).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.dirname(resultFile))).mode & 0o777).toBe(0o700);
    });

    it('reissuing the same lease leaves an already written result untouched', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');
        const resultFile = await resultFileOf(taskId);
        await fs.writeFile(resultFile, 'Finished answer.');

        const again = await sherpa('worker', 'next');

        expect(again.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 1`);
        expect(again.stdout).toContain(`--file ${resultFile}`);
        expect(await fs.readFile(resultFile, 'utf8')).toBe('Finished answer.');
    });

    it('a retry in a new session gets a different path in a different directory', async () => {
        const running = await start();
        await sherpa('worker', 'register');
        const taskId = enqueueEcho(running);
        const first = await sherpa('worker', 'next');
        const firstFile = await resultFileOf(taskId, 1);
        expect(first.stdout).toContain(`--file ${firstFile}`);

        // A new session takes over the slot. The previous lease returns to the queue as the next attempt.
        await sherpa('worker', 'register');
        const second = await sherpa('worker', 'next');

        expect(second.stdout).toContain(`TASK sherpa/${String(taskId)} (echo), attempt 2`);
        const secondFile = await resultFileOf(taskId, 2);
        expect(path.dirname(secondFile)).not.toBe(path.dirname(firstFile));
        expect(second.stdout).toContain(`--file ${secondFile}`);
    });

    it('result root is accessible to others or a symlink: no task is issued, and the next step is named', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        const root = taskResultRootFor(workDir);
        await fs.mkdir(root);
        await fs.chmod(root, 0o777);

        const open = await sherpa('worker', 'next');

        expect(open.code).toBe(1);
        expect(open.stderr).toContain(`${root} is open to other users`);
        expect(open.stderr).toContain('call `sherpa worker next` again');
        expect(running.queue.getTask(taskId)?.status).toBe('queued');

        await fs.rm(root, { recursive: true });
        const target = await fs.mkdtemp(path.join(workDir, 'target-'));
        await fs.symlink(target, root);

        const linked = await sherpa('worker', 'next');

        expect(linked.code).toBe(1);
        expect(linked.stderr).toContain(`${root} is not a directory`);
        expect(await fs.readdir(target)).toEqual([]);
        expect(running.queue.getTask(taskId)?.status).toBe('queued');
    });

    it('result directory cannot be created: no task is issued, and the next step is named', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        const notADir = await writeFile('not-a-dir', '');

        const result = await sherpaWith({ tmpDir: notADir }, 'worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('cannot prepare the directory for task results');
        expect(result.stderr).toContain('call `sherpa worker next` again');
        expect(running.queue.getTask(taskId)?.status).toBe('queued');
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
        expect(rejected.stdout).toContain(`sherpa task complete ${String(taskId)} --file ${file}`);
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
        expect(refused.stderr).toContain('The task stays yours');
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
        expect(repeated.stdout).toContain('is already finished');
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

    it('missing result file: clear error, nothing sent to the server', async () => {
        const running = await start();
        const taskId = enqueueEcho(running);
        await sherpa('worker', 'next');
        const missing = await resultFileOf(taskId);

        const result = await sherpa('task', 'complete', String(taskId), '--file', missing);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`Write the result to ${missing}`);
        expect(result.stderr).toContain(`sherpa task complete ${String(taskId)} --file ${missing}`);
        expect(running.queue.getTask(taskId)).toMatchObject({ status: 'leased', result: null });
    });

    it('no server: CLI says to run the skill again', async () => {
        const result = await sherpa('worker', 'next');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`the Sherpa server for PR ${PR_KEY} is not found or not responding`);
        expect(result.stderr).toContain('Run the Sherpa skill again');
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
        expect(result.stderr).toContain('not found or not responding');
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
