import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Locale, ReviewUser } from '@sherpa/protocol';
import { generateJsonSchemas, UI_ENDPOINTS, uiSettingsSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { FeedbackOrchestrator } from './feedback-orchestrator.js';
import { buildFeedbackPayload } from './feedback-payload.js';
import { FeedbackStore } from './feedback-store.js';


import { memoryIterationsStore } from './hosts/local/iterations-store.js';
import { LocalHost } from './hosts/local/local-host.js';
import { memoryThreadsStore } from './hosts/local/threads-store.js';
import type {
    FeedbackHost,
    FeedbackReply,
    FeedbackRound,
    FeedbackRoundContext,
    FeedbackThread,
} from './hosts/select.js';
import type { TaskRecord } from './queue.js';
import { TaskQueue } from './queue.js';
import type { SherpaServer } from './server.js';
import type { SettingsStore } from './settings-store.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Local review round orchestration with a fake `FeedbackHost`: task creation,
 * fail-closed result acceptance and reconciliation after restart. There is no real checkout here.
 * The fake provides the rounds.
 */

const PROJECT_DIR = '/tmp/project';

interface CompletedRound {
    readonly roundId: string;
    readonly replies: readonly FeedbackReply[];
    readonly summary: string;
    readonly author: ReviewUser;
}

class FakeFeedbackHost implements FeedbackHost {
    readonly completed: CompletedRound[] = [];
    rounds: FeedbackRound[] = [];
    threadsOf = new Map<string, FeedbackThread[]>();
    /** Reply write failure, as caused by a failure in `local-review.json` or the checkout itself. */
    failComplete = false;

    pendingRounds(): Promise<FeedbackRound[]> {
        return Promise.resolve([...this.rounds]);
    }

    roundContext(roundId: string): Promise<FeedbackRoundContext> {
        const round = this.rounds.find((candidate) => candidate.id === roundId);
        if (round === undefined) {
            return Promise.reject(new Error(`round ${roundId} is not found`));
        }
        return Promise.resolve({
            roundId,
            verdict: round.verdict,
            projectDir: PROJECT_DIR,
            threads: this.threadsOf.get(roundId) ?? [],
        });
    }

    completeRound(
        roundId: string,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void> {
        if (this.failComplete) {
            return Promise.reject(new Error('cannot write to the round'));
        }
        this.completed.push({ roundId, replies: result.replies, summary: result.summary, author });
        this.rounds = this.rounds.filter((round) => round.id !== roundId);
        return Promise.resolve();
    }
}

function thread(threadId: string, overrides: Partial<FeedbackThread> = {}): FeedbackThread {
    return {
        threadId,
        path: 'src/a.ts',
        file: `${PROJECT_DIR}/src/a.ts`,
        position: { side: 'new', line: 12, size: 1 },
        excerpt: '   11    12 | +const a = 2;',
        note: null,
        resolved: false,
        comments: [
            {
                author: { login: 'reviewer', displayName: null, bot: false },
                createdAt: '2026-09-11T10:00:00.000Z',
                body: 'extract the constant',
                replies: [],
            },
        ],
        ...overrides,
    };
}

describe('local review round orchestration', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let queue: TaskQueue;
    let store: FeedbackStore;
    let host: FakeFeedbackHost;
    let payloadDir: string;
    let orchestrator: FeedbackOrchestrator;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'feedback.db'));
        queue = new TaskQueue({ db });
        store = new FeedbackStore({ db });
        host = new FakeFeedbackHost();
        payloadDir = path.join(sherpaDir, 'payload', 'feedback');
        orchestrator = make();
    });

    afterEach(async () => {
        orchestrator.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function make(settings: Pick<SettingsStore, 'read'> | null = null): FeedbackOrchestrator {
        return new FeedbackOrchestrator({ host, queue, store, payloadDir, settings });
    }

    /** Settings whose language changes between task creation and result submission. */
    function settingsWithLocale(locale: () => Locale): Pick<SettingsStore, 'read'> {
        return { read: () => uiSettingsSchema.parse({ locale: locale() }) };
    }

    function seedRound(id: string, threadIds: string[], verdict: FeedbackRound['verdict'] = 'request_changes'): void {
        host.rounds.push({ id, verdict, createdAt: '2026-09-11T10:05:00.000Z', threadIds });
        host.threadsOf.set(
            id,
            threadIds.map((threadId) => thread(threadId)),
        );
    }

    function onlyTask(): TaskRecord {
        const tasks = queue.listTasks();
        expect(tasks).toHaveLength(1);
        const task = tasks[0];
        if (task === undefined) {
            throw new Error('task was not enqueued');
        }
        return task;
    }

    it('turns a round into a task with context and a result schema', async () => {
        seedRound('7', ['3']);

        await orchestrator.reconcile();

        const task = onlyTask();
        expect(task.type).toBe('review.feedback');
        expect(task.priority).toBe('interactive');
        expect(task.contextFiles).toEqual([path.join(payloadDir, '7', 'feedback.md')]);
        expect(task.resultSchemaFile).toBe(path.join(payloadDir, '7', 'result-schema.json'));

        const context = fs.readFileSync(task.contextFiles[0] ?? '', 'utf8');
        expect(context).toContain(`${PROJECT_DIR}/src/a.ts`);
        expect(context).toContain('## Thread 3');
        expect(context).toContain('extract the constant');
        expect(JSON.parse(fs.readFileSync(task.resultSchemaFile ?? '', 'utf8'))).toEqual(
            generateJsonSchemas().reviewFeedbackResult,
        );
        expect(task.instructions).toContain('Fix the code for every comment.');
    });

    it('does not duplicate a task on a second reconciliation pass', async () => {
        seedRound('7', ['3']);

        await orchestrator.reconcile();
        await orchestrator.reconcile();

        expect(queue.listTasks()).toHaveLength(1);
    });

    it('sends accepted replies to the host with the agent signature', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const task = onlyTask();

        const acceptance = orchestrator.acceptResult(
            task,
            JSON.stringify({ replies: [{ threadId: '3', body: 'extracted the constant' }], summary: 'fixed one thing' }),
        );

        expect(acceptance?.kind).toBe('accepted');
        if (acceptance?.kind !== 'accepted') {
            throw new Error('result was not accepted');
        }
        acceptance.onCommitted?.();
        await waitUntil(() => host.completed.length === 1, 'replies reached the host');

        expect(host.completed).toEqual([
            {
                roundId: '7',
                replies: [{ threadId: '3', body: 'extracted the constant' }],
                summary: 'fixed one thing',
                author: { login: 'agent', displayName: 'Agent', bot: true },
            },
        ]);
        expect(store.ofRound('7')?.state).toBe('done');
    });

    it('includes the session harness and model in the agent signature', async () => {
        const withRegistry = new FeedbackOrchestrator({
            host,
            queue,
            store,
            payloadDir,
            registry: {
                status: () => ({
                    kind: 'connected',
                    workerId: 'w-1',
                    harness: 'claude-code',
                    model: 'claude-opus-5',
                    registeredAt: '2026-09-11T10:00:00.000Z',
                    lastSeenAt: '2026-09-11T10:01:00.000Z',
                }),
            },
        });
        seedRound('7', ['3']);
        await withRegistry.reconcile();

        const acceptance = withRegistry.acceptResult(
            onlyTask(),
            JSON.stringify({ replies: [], summary: 'nothing to fix' }),
        );
        if (acceptance?.kind !== 'accepted') {
            throw new Error('result was not accepted');
        }
        acceptance.onCommitted?.();
        await waitUntil(() => host.completed.length === 1, 'replies reached the host');

        expect(host.completed[0]?.author).toEqual({
            login: 'claude-code',
            displayName: 'Agent · claude-opus-5',
            bot: true,
        });
        withRegistry.close();
    });

    it('rejects unrelated threads, duplicates and empty summaries', async () => {
        seedRound('7', ['3', '4']);
        await orchestrator.reconcile();
        const task = onlyTask();

        const foreign = orchestrator.acceptResult(
            task,
            JSON.stringify({ replies: [{ threadId: '9', body: 'reply' }], summary: 'summary' }),
        );
        expect(foreign).toEqual({
            kind: 'rejected',
            errors: [expect.stringContaining('thread 9 is not in this review round')],
        });

        const twice = orchestrator.acceptResult(
            task,
            JSON.stringify({
                replies: [
                    { threadId: '3', body: 'reply' },
                    { threadId: '3', body: 'another reply' },
                ],
                summary: 'summary',
            }),
        );
        expect(twice).toEqual({
            kind: 'rejected',
            errors: [expect.stringContaining('is answered twice')],
        });

        const empty = orchestrator.acceptResult(
            task,
            JSON.stringify({ replies: [{ threadId: '3', body: 'reply' }], summary: '' }),
        );
        expect(empty?.kind).toBe('rejected');

        const notJson = orchestrator.acceptResult(task, 'not json');
        expect(notJson).toEqual({ kind: 'rejected', errors: [expect.stringContaining('valid JSON')] });
        expect(host.completed).toEqual([]);
    });

    it('ignores unrelated task types', () => {
        const echo = queue.enqueue({
            type: 'echo',
            priority: 'background',
            instructions: 'test',
            contextFiles: [],
        });

        expect(orchestrator.acceptResult(echo, 'anything')).toBeNull();
    });

    it('keeps live tasks after restart and restores missing ones during reconciliation', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const first = onlyTask();

        const revived = make();
        await revived.reconcile();
        expect(queue.listTasks()).toHaveLength(1);

        // Acceptance after restart must know the round threads, loaded by reconciliation.
        const acceptance = revived.acceptResult(
            first,
            JSON.stringify({ replies: [{ threadId: '3', body: 'done' }], summary: 'summary' }),
        );
        expect(acceptance?.kind).toBe('accepted');
        revived.close();
    });

    it('does not enqueue a failed round again', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const task = onlyTask();
        queue.cancel(task.id);

        await orchestrator.reconcile();
        expect(store.ofRound('7')?.state).toBe('failed');

        await orchestrator.reconcile();
        expect(queue.listTasks()).toHaveLength(1);
        expect(host.rounds).toHaveLength(1);
    });

    it('keeps the round open and enqueues it again when reply writes fail', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        host.failComplete = true;
        queue.setResultAcceptor((task, result) => orchestrator.acceptResult(task, result));

        const leased = queue.next('w-1');
        const response = queue.complete(
            'w-1',
            leased?.task.id ?? 0,
            JSON.stringify({ replies: [{ threadId: '3', body: 'done' }], summary: 'summary' }),
        );

        expect(response.kind).toBe('accepted');
        // The write failed: the round stays open, and reconciliation enqueues it for the agent again.
        await waitUntil(() => queue.listTasks().length === 2, 'round enqueued again');
        expect(host.completed).toEqual([]);
        expect(store.ofRound('7')?.state).toBe('open');
    });

    it('fixes the validation language at task creation, not submission', async () => {
        let locale: Locale = 'en';
        const withSettings = make(settingsWithLocale(() => locale));
        seedRound('7', ['3']);
        await withSettings.reconcile();
        const task = onlyTask();
        expect(task.instructions).toContain('Write the replies and the summary in English.');

        // The reviewer switched languages while the agent edited code: the task requested English, so validate English.
        locale = 'ru';
        const rejected = withSettings.acceptResult(
            task,
            JSON.stringify({
                replies: [{ threadId: '3', body: 'It is worth noting that the constant is extracted.' }],
                summary: 'done',
            }),
        );

        expect(rejected).toEqual({
            kind: 'rejected',
            errors: [expect.stringContaining('it is worth noting')],
        });
        withSettings.close();
    });

    it('keeps the round directory only as long as its task', async () => {
        seedRound('7', ['3']);
        await orchestrator.reconcile();
        const roundDir = path.join(payloadDir, '7');
        expect(fs.existsSync(roundDir)).toBe(true);
        queue.cancel(onlyTask().id);

        await orchestrator.reconcile();

        expect(fs.existsSync(roundDir)).toBe(false);
    });

    it('also sends ship without comments as a task', async () => {
        seedRound('7', [], 'ship');

        await orchestrator.reconcile();

        const task = onlyTask();
        expect(task.instructions).toContain('approved the changes without comments');
        expect(fs.readFileSync(task.contextFiles[0] ?? '', 'utf8')).toContain(
            'The reviewer published no comments in this round.',
        );
    });
});

describe('round payload', () => {
    const context: FeedbackRoundContext = {
        roundId: '7',
        verdict: 'request_changes',
        projectDir: PROJECT_DIR,
        threads: [
            thread('3'),
            thread('4', {
                position: null,
                excerpt: null,
                note: 'the thread is outdated: the file changed after the comment was written',
                resolved: true,
            }),
            thread('5', { path: null, file: null, position: null, excerpt: null, note: null }),
        ],
    };

    it('matches the round context text snapshot', () => {
        expect(buildFeedbackPayload(context, 'ru').context).toMatchInlineSnapshot(`
          "# Review round

          Verdict: request_changes
          Project directory: /tmp/project
          Threads in this round: 3

          Reply to a thread by its threadId. Line numbers are the ones of the diff excerpt:
          the gutter is \`old new | line\`, \`.\` means the line does not exist on that side.

          ## Thread 3 — /tmp/project/src/a.ts, new side, line 12

          Resolved: no

          \`\`\`
             11    12 | +const a = 2;
          \`\`\`

          Comments (oldest first):

          - reviewer, 2026-09-11T10:00:00.000Z:
            extract the constant

          ## Thread 4 — /tmp/project/src/a.ts (whole file)

          Resolved: yes
          Excerpt: [UNAVAILABLE: the thread is outdated: the file changed after the comment was written]

          Comments (oldest first):

          - reviewer, 2026-09-11T10:00:00.000Z:
            extract the constant

          ## Thread 5 — pull request level, no file

          Resolved: no

          Comments (oldest first):

          - reviewer, 2026-09-11T10:00:00.000Z:
            extract the constant

          "
        `);
    });

    it('describes the verdict in the instructions', () => {
        // Local review only publishes comments, and the agent addresses each one.
        expect(buildFeedbackPayload({ ...context, verdict: 'comment' }, 'ru').instructions).toMatchInlineSnapshot(
            `"The reviewer published review comments on the local checkout /tmp/project. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema): what you did, or why you did not. Write the replies and the summary in Russian. Never edit files outside the project directory. Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is. The working tree is re-read automatically; do not run any other Sherpa command for this."`,
        );

        // Rounds with ship and request_changes remain in files published earlier.
        expect(buildFeedbackPayload(context, 'ru').instructions).toMatchInlineSnapshot(
            `"The reviewer finished a review round on the local checkout /tmp/project, verdict request_changes. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema): what you did, or why you did not. Write the replies and the summary in Russian. Never edit files outside the project directory. Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is. The working tree is re-read automatically; do not run any other Sherpa command for this."`,
        );

        expect(buildFeedbackPayload({ ...context, verdict: 'ship' }, 'ru').instructions).toContain(
            'The changes are approved. The comments are optional: apply the trivial ones, reply to the rest.',
        );
        expect(buildFeedbackPayload({ ...context, threads: [], verdict: 'ship' }, 'ru').instructions).toContain(
            'The reviewer approved the changes without comments.',
        );
    });
});

describe('publishing a local review queues a task for the agent', () => {
    const PREFIX = 'app';
    let sherpaDir: string;
    let checkout: string;
    let server: SherpaServer | null;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-feedback-')));
        server = null;
    });

    afterEach(async () => {
        await server?.close();
        fs.rmSync(checkout, { recursive: true, force: true });
        await removeTempSherpaDir(sherpaDir);
    });

    it('enqueues a review.feedback task for the new round through the publish endpoint', async () => {
        const fake = new FakeVcs({ root: checkout, prefix: PREFIX });
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });
        server = await startServer({
            prKey: 'local-git-app-0badc0de',
            sherpaDir,
            longPollSeconds: 0.1,
            reviewHostFactory: () => ({ name: 'local-git', host, refresh: () => host.refresh(), feedback: host }),
        });

        const diff = await host.getDiff();
        const comment = await host.saveDraft({
            body: 'extract the constant',
            parentId: null,
            anchor: {
                fileId: diff.files[0]?.fileId ?? '',
                path: 'src/a.ts',
                position: { side: 'new', line: 1, size: 1 },
            },
        });
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewPublish,
            { verdict: 'comment' },
            server.token,
        );
        expect(response.status).toBe(200);

        const queue = server.queue;
        await waitUntil(
            () => queue.listTasks().some((task) => task.type === 'review.feedback'),
            'round task',
        );
        const task = queue.listTasks().find((candidate) => candidate.type === 'review.feedback');
        expect(task?.priority).toBe('interactive');
        const context = fs.readFileSync(task?.contextFiles[0] ?? '', 'utf8');
        expect(context).toContain(path.join(fake.projectDir, 'src/a.ts'));
        expect(context).toContain(`## Thread ${comment.id}`);
        expect(context).toContain('extract the constant');
    });
});

/** Waits for a condition: task creation runs in the background, so a fixed delay would be a guess. */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
