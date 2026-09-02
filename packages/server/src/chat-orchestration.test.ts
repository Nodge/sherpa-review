import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ChatAnchor, TaskCompleteResponse, UiChatResponse, UiState } from '@sherpa/protocol';
import {
    LEASE_TTL_SECONDS,
    RESULT_MAX_BYTES,
    UI_CHAT_EVENT,
    UI_ENDPOINTS,
    uiChatAskResponseSchema,
    uiChatCancelResponseSchema,
    uiChatEventSchema,
    uiChatResponseSchema,
    uiChatRetryResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { makeFixtureHost } from '@sherpa/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatPayloadDirOf, databasePathFor, routePayloadDirOf, sharedPayloadDirOf } from './paths.js';
import { MAX_RESULT_REJECTIONS } from './queue.js';
import { asRawText, mediumDiff, mediumRawResults, mediumReadySnapshot } from './route/fixture-support.js';
import { bannedPhrases } from './route/voice.js';
import { type SherpaServer, startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

const PR = 'fixture-medium';
const LOCAL_PR = 'github-777';
const WORKER = 'w-chat';
const ANSWER = 'The cache is cleared before the write so the next reader does not get the previous value.';
const ANCHOR: ChatAnchor = {
    // Active fixture iteration: the endpoint rejects an anchor from another iteration (M4-T4).
    diffId: mediumDiff().diffId,
    fileId: 'f-main',
    path: 'src/main.ts',
    side: 'new',
    start: 10,
    end: 12,
};

describe('chat and notes', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];
    let clockOffsetMs: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
        clockOffsetMs = 0;
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(prKey = LOCAL_PR): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.1,
            now: () => new Date(Date.now() + clockOffsetMs),
            ...(prKey === LOCAL_PR ? { reviewHostFactory: () => null } : {}),
        });
        servers.push(server);
        return server;
    }

    async function readState(server: SherpaServer): Promise<UiState> {
        const response = await get(server.port, UI_ENDPOINTS.state, server.token);
        expect(response.status).toBe(200);
        return uiStateSchema.parse(await response.json());
    }

    async function readChat(server: SherpaServer): Promise<UiChatResponse> {
        const response = await get(server.port, UI_ENDPOINTS.reviewChat, server.token);
        expect(response.status).toBe(200);
        return uiChatResponseSchema.parse(await response.json());
    }

    async function ask(server: SherpaServer, text = 'Why is the cache reset here?', anchor?: ChatAnchor) {
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatAsk,
            { text, ...(anchor === undefined ? {} : { anchor }) },
            server.token,
        );
        expect(response.status).toBe(200);
        return uiChatAskResponseSchema.parse(await response.json()).exchange;
    }

    function leaseChat(server: SherpaServer): number {
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        const leased = server.queue.next(WORKER);
        expect(leased?.task.type).toBe('chat');
        return leased?.task.id ?? 0;
    }

    function complete(server: SherpaServer, taskId: number, answer = ANSWER): TaskCompleteResponse {
        return server.queue.complete(WORKER, taskId, answer);
    }

    /** This task's question directory: its own file lives here, shared files in the `shared` directory. */
    function questionDirOf(server: SherpaServer, taskId: number): string {
        const own = server.queue
            .getTask(taskId)
            ?.contextFiles.find((file) => file.startsWith(chatPayloadDirOf(sherpaDir, server.prKey)));
        expect(own).toBeDefined();
        return path.dirname(own ?? '');
    }

    it('ask atomically creates a queued exchange and an interactive task with the full payload', async () => {
        const server = await start();
        const exchange = await ask(server, 'Explain the write order', ANCHOR);
        const [task] = server.queue.listTasks();

        expect(exchange).toMatchObject({ status: 'queued', answer: null, anchor: ANCHOR });
        expect(task).toMatchObject({ type: 'chat', priority: 'interactive', status: 'queued' });
        expect(Buffer.byteLength(task?.instructions ?? '', 'utf8')).toBeLessThan(500);
        // This server has no host: no diff or file content, only the guide is shared.
        expect(task?.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            'question.md',
            'selection.patch.md',
            'file-context.md',
            'route-context.md',
            'history.md',
        ]);
        expect(task?.contextFiles[0]?.startsWith(sharedPayloadDirOf(sherpaDir, LOCAL_PR))).toBe(true);
        expect(
            task?.contextFiles.slice(1).every((file) => file.startsWith(chatPayloadDirOf(sherpaDir, LOCAL_PR))),
        ).toBe(true);
        expect(fsSync.readFileSync(task?.contextFiles[1] ?? '', 'utf8')).toContain('Explain the write order');
        expect((await readChat(server)).exchanges).toEqual([exchange]);
    });

    it('route generation and chat questions leave each other\'s payload alone', async () => {
        const server = await start(PR);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await ask(server, 'Do not delete my context');
        const chatTask = server.queue.listTasks().find((task) => task.type === 'chat');
        // The question's own file: the guide and diff live in the shared directory and belong to both.
        const chatFile = chatTask?.contextFiles.find((file) => file.startsWith(chatPayloadDirOf(sherpaDir, PR))) ?? '';

        await server.route.warmup();
        const routeTask = server.queue.listTasks().find((task) => task.type === 'route.skeleton');
        const routeFile = routeTask?.resultSchemaFile ?? '';

        expect(chatFile.startsWith(chatPayloadDirOf(sherpaDir, PR))).toBe(true);
        expect(routeFile.startsWith(routePayloadDirOf(sherpaDir, PR))).toBe(true);
        expect(fsSync.existsSync(chatFile)).toBe(true);
        expect(fsSync.existsSync(routeFile)).toBe(true);
        // An unanchored question and the skeleton use the same shared path for the diff.
        expect(chatTask?.contextFiles[1]).toBe(routeTask?.contextFiles[1]);
        expect(chatTask?.contextFiles[1]?.startsWith(sharedPayloadDirOf(sherpaDir, PR))).toBe(true);

        await ask(server, 'Do not delete the route context');
        expect(fsSync.existsSync(chatFile)).toBe(true);
        expect(fsSync.existsSync(routeFile)).toBe(true);
        expect(fsSync.existsSync(chatTask?.contextFiles[1] ?? '')).toBe(true);
    });

    it('rolls back task enqueueing when the exchange write fails', async () => {
        const server = await start();
        const db = new DatabaseSync(databasePathFor(sherpaDir, LOCAL_PR));
        db.exec(`
            CREATE TRIGGER reject_chat_exchange
            BEFORE INSERT ON chat_exchanges
            BEGIN
                SELECT RAISE(ABORT, 'test rollback');
            END;
        `);
        try {
            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewChatAsk,
                { text: 'This question must not be saved' },
                server.token,
            );
            expect(response.status).toBe(500);
            expect(server.queue.listTasks()).toEqual([]);
            expect((await readChat(server)).exchanges).toEqual([]);
        } finally {
            db.exec('DROP TRIGGER reject_chat_exchange;');
            db.close();
        }
    });

    it('interactive chat takes priority over unclaimed route.section tasks', async () => {
        const server = await start(PR);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        const skeleton = server.queue.listTasks().find((task) => task.type === 'route.skeleton');
        expect(server.queue.next(WORKER)?.task.id).toBe(skeleton?.id);
        expect(complete(server, skeleton?.id ?? 0, asRawText(mediumRawResults().skeleton)).kind).toBe('accepted');
        expect(server.queue.listTasks().some((task) => task.type === 'route.section' && task.status === 'queued')).toBe(
            true,
        );

        const exchange = await ask(server, 'What is the biggest risk here?');
        const chatTask = server.queue.listTasks().find((task) => task.type === 'chat');

        expect(server.queue.next(WORKER)?.task.id).toBe(chatTask?.id);
        expect((await readChat(server)).exchanges.find((item) => item.id === exchange.id)?.status).toBe('running');
    });

    it('cancel formally closes the lease, the worker holds it until a late complete', async () => {
        const server = await start();
        const exchange = await ask(server);
        const taskId = leaseChat(server);

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatCancel,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatCancelResponseSchema.parse(await response.json()).outcome).toBe('cancelled');
        expect((await readState(server)).tasks).toMatchObject([
            { id: taskId, status: 'cancelled', heldByWorker: true },
        ]);
        expect((await readChat(server)).exchanges[0]).toMatchObject({
            status: 'cancelled',
            answer: null,
            taskId,
        });

        expect(complete(server, taskId).kind).toBe('noop');
        expect((await readState(server)).tasks).toMatchObject([
            { id: taskId, status: 'cancelled', heldByWorker: false },
        ]);
    });

    it('next from the same worker releases the cancelled task and issues the next question', async () => {
        const server = await start();
        const first = await ask(server, 'First question');
        const cancelledTask = leaseChat(server);
        await postJson(server.port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: first.id }, server.token);

        await ask(server, 'Second question');
        const nextTask = server.queue.next(WORKER);

        expect(nextTask?.task.id).not.toBe(cancelledTask);
        expect((await readState(server)).tasks).toMatchObject([
            { id: cancelledTask, status: 'cancelled', heldByWorker: false },
            { id: nextTask?.task.id, status: 'leased', heldByWorker: true },
        ]);
    });

    it('keeps the question directory while the task is open or held by a worker', async () => {
        const server = await start();
        const exchange = await ask(server);
        const taskId = leaseChat(server);
        const dir = questionDirOf(server, taskId);

        expect(fsSync.existsSync(dir)).toBe(true);

        await postJson(server.port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: exchange.id }, server.token);
        // The task is closed, but the worker does not know yet and is still reading its context.
        expect(fsSync.existsSync(dir)).toBe(true);

        expect(complete(server, taskId).kind).toBe('noop');
        expect(fsSync.existsSync(dir)).toBe(false);
    });

    it('removes the answered question directory when the task closes', async () => {
        const server = await start();
        await ask(server);
        const taskId = leaseChat(server);
        const dir = questionDirOf(server, taskId);

        expect(complete(server, taskId).kind).toBe('accepted');

        expect(fsSync.existsSync(dir)).toBe(false);
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'done', answer: ANSWER });
    });

    it('removes directories referenced by no task on server startup', async () => {
        const first = await start();
        await ask(first);
        const openTask = first.queue.listTasks()[0];
        const kept = questionDirOf(first, openTask?.id ?? 0);
        const stray = path.join(chatPayloadDirOf(sherpaDir, LOCAL_PR), 'stray-question');
        fsSync.mkdirSync(stray, { recursive: true });
        await first.close();

        const second = await start();

        expect(fsSync.existsSync(stray)).toBe(false);
        // The question and its task survived the restart, so its context is still there.
        expect(fsSync.existsSync(kept)).toBe(true);
        expect(second.queue.listTasks()[0]?.status).toBe('queued');
    });

    it('retry assigns a new task to a cancelled question\'s exchange', async () => {
        const server = await start();
        const exchange = await ask(server);
        const firstTask = leaseChat(server);
        await postJson(server.port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: exchange.id }, server.token);

        const retry = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatRetryResponseSchema.parse(await retry.json()).outcome).toBe('retried');

        const retried = (await readChat(server)).exchanges[0];
        expect(retried).toMatchObject({ id: exchange.id, status: 'queued' });
        expect(retried?.taskId).not.toBe(firstTask);
    });

    it('allows retry from failed and cancelled, preserving the question and anchor', async () => {
        const server = await start();
        const exchange = await ask(server, 'Keep this question', ANCHOR);
        const firstTask = leaseChat(server);
        server.queue.fail(WORKER, firstTask, 'not enough context');
        expect((await readChat(server)).exchanges[0]?.status).toBe('failed');

        const failedRetry = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatRetryResponseSchema.parse(await failedRetry.json()).outcome).toBe('retried');
        const secondTask = server.queue.listTasks().find((task) => task.type === 'chat' && task.status === 'queued');
        expect(secondTask?.id).not.toBe(firstTask);

        const cancel = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatCancel,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatCancelResponseSchema.parse(await cancel.json()).outcome).toBe('cancelled');
        const cancelledRetry = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            server.token,
        );
        expect(uiChatRetryResponseSchema.parse(await cancelledRetry.json()).outcome).toBe('retried');

        expect((await readChat(server)).exchanges[0]).toMatchObject({
            id: exchange.id,
            question: 'Keep this question',
            anchor: ANCHOR,
            status: 'queued',
        });
    });

    it('retrying an M3 question treats an anchor without an iteration as belonging to the active one', async () => {
        const first = await start(PR);
        const exchange = await ask(first, 'Question asked before iterations existed', ANCHOR);
        first.queue.fail(WORKER, leaseChat(first), 'not enough context');
        await first.close();
        // M3 exchanges stored anchors without `diffId`, so the store fills in `unknown`.
        stripAnchorIteration(sherpaDir, PR, exchange.id);

        const second = await start(PR);
        const retry = await postJson(
            second.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            second.token,
        );

        expect(retry.status).toBe(200);
        expect(uiChatRetryResponseSchema.parse(await retry.json()).outcome).toBe('retried');
    });

    it('does not use active-iteration file content for a question about a previous iteration', async () => {
        const stored = await start(PR);
        // The v1 patch is stored the first time the diff is loaded.
        await get(stored.port, UI_ENDPOINTS.reviewDiff, stored.token);
        await stored.close();

        // The host moved to v2 and returns no diff at all: the saved v1 is the only correct context.
        const pushed = makeFixtureHost('medium');
        pushed.advanceIteration();
        pushed.getDiff = () => Promise.reject(new Error('host is down'));
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.1,
            reviewHostFactory: () => ({ name: 'fixture', host: pushed }),
        });
        servers.push(server);

        await ask(server, 'What was here in the previous iteration?', ANCHOR);

        const task = server.queue.listTasks().find((candidate) => candidate.type === 'chat');
        const files = task?.contextFiles ?? [];
        const patch = files.find((file) => path.basename(file) === 'selection.patch.md') ?? '';
        const fileContext = files.find((file) => path.basename(file) === 'file-context.md') ?? '';
        expect(fsSync.readFileSync(patch, 'utf8')).toContain('src/main.ts');
        expect(fsSync.readFileSync(fileContext, 'utf8')).toContain('UNAVAILABLE');
    });

    it('retries invalid answers and moves the exchange to failed when rejections are exhausted', async () => {
        const server = await start();
        await ask(server);
        const taskId = leaseChat(server);
        const broken = 'It is worth noting: done 🎉';

        for (let rejection = 1; rejection <= MAX_RESULT_REJECTIONS; rejection += 1) {
            const result = complete(server, taskId, broken);
            expect(result.kind).toBe('rejected');
            if (rejection < MAX_RESULT_REJECTIONS) {
                expect(server.queue.getTask(taskId)?.status).toBe('leased');
            }
        }

        expect(server.queue.getTask(taskId)?.status).toBe('failed');
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'failed', answer: null });
        expect((await readChat(server)).exchanges[0]?.error).toContain('failed validation');
    });

    it('an answer over 256 KB fails both the task and exchange', async () => {
        const server = await start();
        await ask(server);
        const taskId = leaseChat(server);

        expect(() => complete(server, taskId, 'x'.repeat(RESULT_MAX_BYTES + 1))).toThrow();

        expect(server.queue.getTask(taskId)?.status).toBe('failed');
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'failed', answer: null });
        expect((await readChat(server)).exchanges[0]?.error).toContain('exceeds the limit');
    });

    it('progress updates the running exchange and the revision is monotonic', async () => {
        const server = await start();
        const initial = await readChat(server);
        await ask(server);
        const afterAsk = await readChat(server);
        const taskId = leaseChat(server);
        const afterLease = await readChat(server);

        server.queue.progress(WORKER, taskId, 'Checking cache invariants');
        const afterProgress = await readChat(server);
        expect(afterProgress.exchanges[0]).toMatchObject({
            status: 'running',
            progressText: 'Checking cache invariants',
        });
        expect([initial, afterAsk, afterLease, afterProgress].map((state) => state.chatRevision)).toEqual(
            [...new Set([initial, afterAsk, afterLease, afterProgress].map((state) => state.chatRevision))].sort(
                (left, right) => left - right,
            ),
        );
    });

    it('an accepted answer creates a note only with an anchor and the diff head commit', async () => {
        const server = await start(PR);
        const anchored = await ask(server, 'Why is this range needed?', ANCHOR);
        const anchoredTask = leaseChat(server);
        expect(complete(server, anchoredTask).kind).toBe('accepted');

        const first = await readChat(server);
        expect(first.exchanges[0]).toMatchObject({ id: anchored.id, status: 'done', answer: ANSWER });
        expect(first.notes).toEqual([
            expect.objectContaining({
                exchangeId: anchored.id,
                anchor: ANCHOR,
                text: ANSWER,
                lostAnchor: false,
                origin: { commit: mediumReadySnapshot().commit, anchor: ANCHOR },
            }),
        ]);

        await ask(server, 'Question about the whole PR');
        const plainTask = server.queue.next(WORKER)?.task.id ?? 0;
        expect(complete(server, plainTask).kind).toBe('accepted');
        expect((await readChat(server)).notes).toHaveLength(1);
    });

    it('rolls back the answer and note together, then applies the result through reconciliation after recovery', async () => {
        const server = await start();
        await ask(server, 'Need an atomic note', ANCHOR);
        const taskId = leaseChat(server);
        const db = new DatabaseSync(databasePathFor(sherpaDir, LOCAL_PR));
        db.exec(`
            CREATE TRIGGER reject_agent_note
            BEFORE INSERT ON agent_notes
            BEGIN
                SELECT RAISE(ABORT, 'test rollback');
            END;
        `);
        try {
            expect(complete(server, taskId).kind).toBe('accepted');
            expect(await readChat(server)).toMatchObject({
                exchanges: [expect.objectContaining({ status: 'running', answer: null })],
                notes: [],
            });
        } finally {
            db.exec('DROP TRIGGER reject_agent_note;');
            db.close();
        }

        const poke = server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions: 'wake up reconciliation',
            contextFiles: [],
        });
        server.queue.cancel(poke.id);
        expect(await readChat(server)).toMatchObject({
            exchanges: [expect.objectContaining({ status: 'done', answer: ANSWER })],
            notes: [expect.objectContaining({ text: ANSWER })],
        });
    });

    it('deleting a note preserves history and advances the revision', async () => {
        const server = await start();
        await ask(server, 'Pin the answer', ANCHOR);
        const taskId = leaseChat(server);
        complete(server, taskId);
        const before = await readChat(server);
        const noteId = before.notes[0]?.id ?? 0;

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatNoteDelete,
            { noteId },
            server.token,
        );
        expect(response.status).toBe(200);
        const after = await readChat(server);
        expect(after.notes).toEqual([]);
        expect(after.exchanges).toEqual(before.exchanges);
        expect(after.chatRevision).toBeGreaterThan(before.chatRevision);
    });

    it('worker displacement survives a restart and a new worker continues the question', async () => {
        const first = await start();
        await ask(first, 'Continue after reconnecting');
        const taskId = leaseChat(first);

        first.queue.releaseLeasesOf(WORKER);
        expect(first.queue.getTask(taskId)).toMatchObject({
            status: 'queued',
            attempt: 2,
            lastLeaseReturnReason: 'displaced',
        });
        await first.close();

        const second = await start();
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'queued', error: null });
        expect(second.queue.next('w-chat-next')?.task.id).toBe(taskId);
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'running', error: null });
    });

    it('restart with a chat lease: the same session submits the answer and a note appears', async () => {
        const first = await start();
        const exchange = await ask(first, 'Answer after the restart', ANCHOR);
        const taskId = leaseChat(first);
        expect((await readChat(first)).exchanges[0]).toMatchObject({ status: 'running' });
        await first.close();

        // A live lease survives startup: reconciliation does not fail a question that still has a worker.
        const second = await start();
        expect(second.queue.getTask(taskId)?.status).toBe('leased');
        expect((await readChat(second)).exchanges[0]).toMatchObject({
            id: exchange.id,
            status: 'running',
            error: null,
        });

        expect(complete(second, taskId).kind).toBe('accepted');
        const done = await readChat(second);
        expect(done.exchanges[0]).toMatchObject({ id: exchange.id, status: 'done', answer: ANSWER });
        expect(done.notes).toEqual([
            expect.objectContaining({ exchangeId: exchange.id, anchor: ANCHOR, text: ANSWER }),
        ]);
    });

    it('restart with a chat lease: the session never returns, the lease expires, then failed and retry', async () => {
        const first = await start();
        const exchange = await ask(first, 'The session will not return after the restart');
        const taskId = leaseChat(first);
        await first.close();

        const second = await start();
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'running' });

        clockOffsetMs = (LEASE_TTL_SECONDS.interactive + 1) * 1000;
        // Reading the queue reaps the expired lease. Reconciliation learns about it through the same notification.
        second.queue.listTasks();
        const failed = await readChat(second);
        expect(failed.exchanges[0]).toMatchObject({
            id: exchange.id,
            question: 'The session will not return after the restart',
            status: 'failed',
        });
        expect(failed.exchanges[0]?.error).toContain('stopped responding');
        expect(second.queue.getTask(taskId)?.status).toBe('cancelled');

        const retry = await postJson(
            second.port,
            UI_ENDPOINTS.reviewChatRetry,
            { exchangeId: exchange.id },
            second.token,
        );
        expect(uiChatRetryResponseSchema.parse(await retry.json()).outcome).toBe('retried');
        const retried = second.queue.listTasks().find((task) => task.type === 'chat' && task.status === 'queued');
        expect(retried?.id).not.toBe(taskId);
        expect((await readChat(second)).exchanges[0]).toMatchObject({ status: 'queued', error: null });
    });

    it('task fail and lease expiry produce failed while preserving the question', async () => {
        const explicit = await start();
        await ask(explicit, 'Do not lose me');
        const explicitTask = leaseChat(explicit);
        explicit.queue.fail(WORKER, explicitTask, 'no access to the file');
        expect((await readChat(explicit)).exchanges[0]).toMatchObject({
            question: 'Do not lose me',
            status: 'failed',
        });
        expect((await readChat(explicit)).exchanges[0]?.error).toContain('no access to the file');

        await explicit.close();
        const expired = await start();
        await ask(expired, 'Worker died');
        const expiredTask = leaseChat(expired);
        clockOffsetMs = (LEASE_TTL_SECONDS.interactive + 1) * 1000;
        expired.queue.listTasks();
        expect(expired.queue.getTask(expiredTask)).toMatchObject({
            status: 'cancelled',
            lastLeaseReturnReason: 'expired',
        });
        expect((await readChat(expired)).exchanges[1]).toMatchObject({
            question: 'Worker died',
            status: 'failed',
        });
    });

    it('reconnecting the same worker after lease expiry does not fail the question', async () => {
        const server = await start();
        await ask(server, 'Reconnect');
        const taskId = leaseChat(server);
        clockOffsetMs = (LEASE_TTL_SECONDS.interactive + 1) * 1000;
        // next() reaps the expired lease and immediately leases the same task again in the same call.
        // There is no notification between "expired" and "leased again", so the orchestrator never sees
        // the intermediate queued+expired state. A live renewed lease must not be failed as a dead worker.
        expect(server.queue.next(WORKER)?.task.id).toBe(taskId);
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', lastLeaseReturnReason: null });
        expect((await readChat(server)).exchanges[0]).toMatchObject({ status: 'running', error: null });
    });

    it('restart preserves history and moves an open exchange without a task to failed', async () => {
        const first = await start();
        await ask(first, 'Completed answer', ANCHOR);
        complete(first, leaseChat(first));
        const done = await readChat(first);
        await ask(first, 'Lost task');
        await first.close();

        const db = new DatabaseSync(databasePathFor(sherpaDir, LOCAL_PR));
        db.prepare("DELETE FROM tasks WHERE status = 'queued'").run();
        db.close();

        const second = await start();
        const restarted = await readChat(second);
        expect(restarted.exchanges[0]).toEqual(done.exchanges[0]);
        expect(restarted.notes).toEqual(done.notes);
        expect(restarted.exchanges[1]).toMatchObject({
            question: 'Lost task',
            status: 'failed',
        });
        expect(restarted.exchanges[1]?.error).toContain('lost after the server restart');
    });

    it('SSE chat arrives immediately and after a change', async () => {
        const server = await start();
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        const first = uiChatEventSchema.parse(JSON.parse((await nextChat(stream)).data));

        await ask(server);

        const changed = uiChatEventSchema.parse(JSON.parse((await nextChat(stream)).data));
        expect(changed.chatRevision).toBeGreaterThan(first.chatRevision);
        expect(changed.chatRevision).toBe((await readChat(server)).chatRevision);
    });
});

async function nextChat(stream: SseStream): Promise<SseEvent> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_CHAT_EVENT) {
            return event;
        }
    }
}

interface SseEvent {
    readonly event: string;
    readonly data: string;
}

interface SseStream {
    readonly next: () => Promise<SseEvent>;
    readonly close: () => void;
}

async function openSse(url: string): Promise<SseStream> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200 || response.body === null) {
        throw new Error(`SSE channel did not open: ${String(response.status)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ready: SseEvent[] = [];
    let buffer = '';

    return {
        next: async () => {
            for (;;) {
                const event = ready.shift();
                if (event !== undefined) {
                    return event;
                }
                const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
                if (chunk.done) {
                    throw new Error('SSE channel closed before the expected event');
                }
                buffer += decoder.decode(chunk.value, { stream: true });
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    ready.push(parseSseEvent(buffer.slice(0, boundary)));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        },
        close: () => {
            controller.abort();
        },
    };
}

function parseSseEvent(raw: string): SseEvent {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) {
            event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
        }
    }
    return { event, data: data.join('\n') };
}

/** Remove `diffId` from an exchange anchor, as stored before M4. The store fills in `unknown`. */
function stripAnchorIteration(sherpaDir: string, prKey: string, exchangeId: number): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        const row = db.prepare('SELECT anchor FROM chat_exchanges WHERE id = ?').get(exchangeId) as {
            anchor: string;
        };
        const { diffId: _iteration, ...rest } = JSON.parse(row.anchor) as ChatAnchor;
        db.prepare('UPDATE chat_exchanges SET anchor = ? WHERE id = ?').run(JSON.stringify(rest), exchangeId);
    } finally {
        db.close();
    }
}
