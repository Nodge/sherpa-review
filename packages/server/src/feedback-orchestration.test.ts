import fs from 'node:fs';
import path from 'node:path';

import type { Locale, ReviewUser } from '@sherpa/protocol';
import { generateJsonSchemas, UI_ENDPOINTS, uiSettingsSchema } from '@sherpa/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { FeedbackOrchestrator } from './feedback-orchestrator.js';
import { buildFeedbackPayload } from './feedback-payload.js';
import { FeedbackStore } from './feedback-store.js';
import { gitAvailable } from './hosts/local/git-fixture.js';
import { localGitHostPlugin } from './hosts/local/git-plugin.js';
import { disposeGitProjectTemplate, GIT_PR_KEY, GitProject } from './hosts/local/git-project.js';
import type {
    FeedbackHost,
    FeedbackReply,
    FeedbackRound,
    FeedbackRoundContext,
    FeedbackThread,
} from './hosts/plugin.js';
import type { TaskRecord } from './queue.js';
import { TaskQueue } from './queue.js';
import type { SherpaServer } from './server.js';
import type { SettingsStore } from './settings-store.js';
import { startServer } from './server.js';
import { hostPluginOf, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

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
            instruction: null,
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
                author: { login: 'reviewer', displayName: null, bot: false, avatarUrl: null },
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
                author: { login: 'agent', displayName: 'Agent', bot: true, avatarUrl: null },
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
            avatarUrl: null,
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
        instruction: null,
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

        // request_changes covers verdict mode (`--verdicts`) and rounds published before comment-only mode.
        expect(buildFeedbackPayload(context, 'ru').instructions).toMatchInlineSnapshot(
            `"The reviewer finished a review round on the local checkout /tmp/project, verdict request_changes. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema): what you did, or why you did not. Write the replies and the summary in Russian. Never edit files outside the project directory. Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is. The working tree is re-read automatically; do not run any other Sherpa command for this."`,
        );
    });

    it('ship without instructions: changes are approved, with generic instructions for approval', () => {
        const ship = buildFeedbackPayload({ ...context, verdict: 'ship' }, 'en').instructions;
        expect(ship).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict ship. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema). Write the replies and the summary in English. Never edit files outside the project directory. The changes are approved. If the user asked you earlier to do something once the changes are approved (for example, commit them and open a pull request), do it now and say what you did in the summary. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
        // Ship does not prohibit code changes: approval still allows carrying out user instructions.
        expect(ship).not.toContain('do not change the code');
        expect(buildFeedbackPayload({ ...context, verdict: 'sticky_ship' }, 'en').instructions).not.toContain(
            'do not change the code',
        );
    });

    it('ship without comments: empty replies, a one-line summary and generic approval instructions', () => {
        expect(
            buildFeedbackPayload({ ...context, threads: [], verdict: 'ship' }, 'en').instructions,
        ).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict ship. The reviewer approved the changes without comments. If the user asked you earlier to do something once the changes are approved (for example, commit them and open a pull request), do it now and say what you did in the summary. Submit a result with an empty replies list and a one-line summary. Write the replies and the summary in English. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
    });

    it('prints ship instructions verbatim instead of generic text', () => {
        const withInstruction = { ...context, instruction: 'on ship, commit and open a PR' };

        expect(buildFeedbackPayload({ ...withInstruction, verdict: 'ship' }, 'en').instructions).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict ship. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema). Write the replies and the summary in English. Never edit files outside the project directory. The changes are approved. The user's instruction for the outcome of this review: "on ship, commit and open a PR". Carry out the part that applies to verdict ship now and say what you did in the summary. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
        expect(
            buildFeedbackPayload({ ...withInstruction, threads: [], verdict: 'sticky_ship' }, 'en').instructions,
        ).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict sticky_ship. The reviewer approved the changes without comments. The user's instruction for the outcome of this review: "on ship, commit and open a PR". Carry out the part that applies to verdict sticky_ship now and say what you did in the summary. Submit a result with an empty replies list and a one-line summary. Write the replies and the summary in English. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
    });

    it('request_changes with instructions: address comments first, then follow the instructions', () => {
        const withInstruction = { ...context, instruction: 'on request changes, fix and run the tests' };

        expect(buildFeedbackPayload(withInstruction, 'en').instructions).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict request_changes. The review comments are in feedback.md, each with the absolute file path, line and code excerpt. Reply to every thread by threadId in the result file (see schema): what you did, or why you did not. Write the replies and the summary in English. Never edit files outside the project directory. Fix the code for every comment. If a comment is unclear or you disagree, reply in the thread and leave the code as is. The user's instruction for the outcome of this review: "on request changes, fix and run the tests". Carry out the part that applies to verdict request_changes now and say what you did in the summary. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
        expect(buildFeedbackPayload({ ...withInstruction, threads: [] }, 'en').instructions).toMatchInlineSnapshot(`"The reviewer finished a review round on the local checkout /tmp/project, verdict request_changes. The reviewer left no comments in this round, so there is nothing to fix. The user's instruction for the outcome of this review: "on request changes, fix and run the tests". Carry out the part that applies to verdict request_changes now and say what you did in the summary. Submit a result with an empty replies list and a one-line summary. Write the replies and the summary in English. The working tree is re-read automatically; do not run any other Sherpa command for this."`);
    });

    it('prints instructions with quotes, a backslash and a newline verbatim', () => {
        const instruction = 'on ship, commit with message "PROJ-61: done" in C:\\work\nthen open a PR';
        const instructions = buildFeedbackPayload({ ...context, verdict: 'ship', instruction }, 'en').instructions;

        expect(instructions).toContain(`outcome of this review: "${instruction}". Carry out`);
    });

    it('still requests no fixes for empty comment and request_changes rounds', () => {
        expect(buildFeedbackPayload({ ...context, threads: [], verdict: 'comment' }, 'en').instructions).toContain(
            'The reviewer published no comments in this round. Nothing to fix: submit a result with an empty replies list and a one-line summary.',
        );
        expect(buildFeedbackPayload({ ...context, threads: [] }, 'en').instructions).toContain(
            'The reviewer left no comments in this round. Nothing to fix: submit a result with an empty replies list and a one-line summary.',
        );
    });
});

// The host uses real `git`: each endpoint spawns several processes, so the test timeout exceeds the default.
describe.skipIf(!gitAvailable)('publishing a local review enqueues an agent task', { timeout: 30_000 }, () => {
    let sherpaDir: string;
    let project: GitProject;
    let server: SherpaServer | null;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        project = new GitProject('sherpa-feedback-');
        server = null;
    });

    afterEach(async () => {
        await server?.close();
        project.cleanup();
        await removeTempSherpaDir(sherpaDir);
    });

    afterAll(() => {
        disposeGitProjectTemplate();
    });

    it('enqueues a review.feedback task for the new round through the publish endpoint', async () => {
        project.seedOneFile();
        const host = project.makeHost();
        server = await startServer({
            updateChannel: null,
            feedbackChannel: null,
            prKey: GIT_PR_KEY,
            sherpaDir,
            longPollSeconds: 0.1,
            hosts: [
                hostPluginOf({
                    name: localGitHostPlugin.name,
                    ui: localGitHostPlugin.ui,
                    host,
                    refresh: () => host.refresh(),
                    feedback: host,
                }),
            ],
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
            15_000,
        );
        const task = queue.listTasks().find((candidate) => candidate.type === 'review.feedback');
        expect(task?.priority).toBe('interactive');
        const context = fs.readFileSync(task?.contextFiles[0] ?? '', 'utf8');
        expect(context).toContain(path.join(project.dir, 'src/a.ts'));
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
