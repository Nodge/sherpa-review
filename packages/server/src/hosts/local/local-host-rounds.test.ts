import path from 'node:path';

import type { Thread } from '@sherpa/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitAvailable } from './git-fixture.js';
import { GIT_USER_NAME } from './git-fixture.js';
import { disposeGitProjectTemplate, draftOnA, GitProject, PROJECT_PREFIX } from './git-project.js';
import type { LocalHost, LocalHostOptions } from './local-host.js';
import { emptyReviewData, memoryThreadsStore } from './threads-store.js';

/**
 * Local review rounds using real `git`: publishing comments and verdicts (`--verdicts`),
 * round context for the agent, agent replies and editing published comments.
 */

const PREFIX = PROJECT_PREFIX;
const ON_SHIP = 'on ship, commit and open a PR';

/** Each host endpoint invokes `git` several times. The default five-second timeout is too short. */
const TIMEOUT_MS = 30_000;

afterAll(() => {
    disposeGitProjectTemplate();
});

describe.skipIf(!gitAvailable)('local review rounds', { timeout: TIMEOUT_MS }, () => {
    let project: GitProject;
    let projectDir: string;

    beforeEach(() => {
        project = new GitProject('sherpa-local-rounds-');
        projectDir = project.dir;
    });

    afterEach(() => {
        project.cleanup();
    });

    function makeHost(overrides: Partial<LocalHostOptions> = {}): LocalHost {
        return project.makeHost(overrides);
    }

    it('a verdict from an old file belongs to its iteration: a new diff clears it', async () => {
        project.seedOneFile();
        const { diffId } = await makeHost().getDiff();
        // Without `--verdicts`, ship cannot be published, but previously written files must remain readable.
        const host = makeHost({
            threads: memoryThreadsStore({ ...emptyReviewData(), verdict: { verdict: 'ship', diffId } }),
        });

        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: GIT_USER_NAME, displayName: null, bot: false, avatarUrl: null }, verdict: 'ship' },
        ]);

        project.repo.write(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();
        expect((await host.getPr()).verdicts).toEqual([]);
    });

    it('only comments can be published: rejects the verdict and keeps the draft', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const draft = await host.saveDraft({ body: 'about B', parentId: null, anchor: null });

        for (const verdict of ['ship', 'sticky_ship', 'request_changes'] as const) {
            await expect(host.publishBatch(verdict)).rejects.toThrow(/only publishes comments/);
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
        expect(await host.pendingRounds()).toEqual([]);

        await host.publishBatch('comment');
        // Publishing without a verdict does not count as a reviewer verdict.
        expect((await host.getPr()).verdicts).toEqual([]);
    });

    it('with --verdicts the modes match a PR: Request changes and Ship, without Comment', async () => {
        project.seedTwoFiles();

        expect((await makeHost({ verdicts: ON_SHIP }).getPr()).capabilities.publishVerdicts).toEqual([
            'request_changes',
            'ship',
        ]);
        expect((await makeHost({ verdicts: null }).getPr()).capabilities.publishVerdicts).toEqual(['comment']);
    });

    it('with --verdicts, comment and sticky_ship are rejected and the draft remains', async () => {
        project.seedTwoFiles();
        const host = makeHost({ verdicts: ON_SHIP });
        const draft = await host.saveDraft({ body: 'about B', parentId: null, anchor: null });

        for (const verdict of ['comment', 'sticky_ship'] as const) {
            await expect(host.publishBatch(verdict)).rejects.toThrow(/through Request changes/);
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
        expect(await host.pendingRounds()).toEqual([]);
    });

    it('a verdict creates a round even without comments: the session must receive it', async () => {
        project.seedTwoFiles();
        const host = makeHost({ verdicts: ON_SHIP });

        expect(await host.publishBatch('ship')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(await host.publishBatch('request_changes')).toEqual({
            publishedCommentIds: [],
            failed: [],
            verdictApplied: true,
        });

        const rounds = await host.pendingRounds();
        expect(rounds.map((round) => [round.verdict, round.threadIds])).toEqual([
            ['ship', []],
            ['request_changes', []],
        ]);
        // The latest iteration verdict appears in the header.
        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: GIT_USER_NAME, displayName: null, bot: false, avatarUrl: null }, verdict: 'request_changes' },
        ]);
    });

    it('ship publishes drafts and includes their threads in the round', async () => {
        project.seedTwoFiles();
        const host = makeHost({ verdicts: ON_SHIP });
        const draft = await host.saveDraft({ body: 'about B', parentId: null, anchor: null });

        const result = await host.publishBatch('ship');

        expect(result.publishedCommentIds).toEqual([draft.id]);
        expect(await host.pendingRounds()).toMatchObject([{ verdict: 'ship', threadIds: [draft.id] }]);
        expect((await host.roundContext((await host.pendingRounds())[0]?.id ?? '')).verdict).toBe('ship');
    });

    it('round context includes the current host instruction', async () => {
        project.seedTwoFiles();
        const host = makeHost({ verdicts: ON_SHIP });
        await host.publishBatch('ship');
        const roundId = (await host.pendingRounds())[0]?.id ?? '';

        expect((await host.roundContext(roundId)).instruction).toBe(ON_SHIP);

        host.setVerdicts('on ship, merge into main');
        expect((await host.roundContext(roundId)).instruction).toBe('on ship, merge into main');

        host.setVerdicts(null);
        expect((await host.roundContext(roundId)).instruction).toBeNull();
    });

    it('the mode switches on a running host and reports the change', async () => {
        project.seedTwoFiles();
        const changes: (string | null)[] = [];
        const host = makeHost({ onVerdictsChanged: (verdicts) => changes.push(verdicts) });

        expect(host.setVerdicts(null)).toBe(false);
        expect(host.setVerdicts(ON_SHIP)).toBe(true);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['request_changes', 'ship']);
        await expect(host.publishBatch('comment')).rejects.toThrow();

        // A new instruction with the mode already enabled is saved, but does not require rereading metadata.
        expect(host.setVerdicts('on ship, merge into main')).toBe(false);
        expect(host.setVerdicts('on ship, merge into main')).toBe(false);

        expect(host.setVerdicts(null)).toBe(true);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);
        expect(changes).toEqual([ON_SHIP, 'on ship, merge into main', null]);
    });

    // A failed write leaves the mode in memory unchanged. Otherwise another `up` would consider it enabled.
    it('a repeated call retries saving a mode after the previous save failed', async () => {
        project.seedTwoFiles();
        const stored: (string | null)[] = [];
        let calls = 0;
        const host = makeHost({
            onVerdictsChanged: (verdicts) => {
                calls += 1;
                if (calls === 1) {
                    throw new Error('disk full');
                }
                stored.push(verdicts);
            },
        });

        expect(() => host.setVerdicts(ON_SHIP)).toThrow('disk full');
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);

        expect(host.setVerdicts(ON_SHIP)).toBe(true);
        expect(calls).toBe(2);
        expect(stored).toEqual([ON_SHIP]);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['request_changes', 'ship']);
    });

    it('publishing opens a round with threads from own comments', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const diff = await host.getDiff();
        const onA = await host.saveDraft(draftOnA(diff));
        // The second thread was published earlier, so it stays out of the new round.
        await host.saveDraft({ body: 'about B', parentId: null, anchor: null });
        await host.publishBatch('comment');

        const reply = await host.saveDraft({ body: 'what about here?', parentId: onA.id, anchor: null });
        await host.publishBatch('comment');

        const rounds = await host.pendingRounds();
        expect(rounds).toHaveLength(2);
        expect(rounds[0]?.verdict).toBe('comment');
        expect(rounds[0]?.threadIds.length).toBe(2);
        expect(rounds[1]).toMatchObject({ verdict: 'comment', threadIds: [onA.id] });
        expect(reply.draft).toBe(true);
    });

    it('publishing without any comments opens no round and writes nothing', async () => {
        project.seedTwoFiles();
        const threads = memoryThreadsStore();
        const host = makeHost({ threads });

        expect(await host.publishBatch('comment')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(await host.pendingRounds()).toEqual([]);
        expect(await threads.read()).toEqual(emptyReviewData());
    });

    it('round context includes the absolute path, line and patch excerpt', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const diff = await host.getDiff();
        const comment = await host.saveDraft(draftOnA(diff));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        const context = await host.roundContext(round?.id ?? '');

        expect(context.verdict).toBe('comment');
        expect(context.projectDir).toBe(projectDir);
        const thread = context.threads[0];
        expect(thread?.threadId).toBe(comment.id);
        expect(thread?.file).toBe(path.join(projectDir, 'src/a.ts'));
        expect(thread?.position).toEqual({ side: 'new', line: 1, size: 1 });
        expect(thread?.excerpt).toContain('+const a = 2;');
        expect(thread?.note).toBeNull();
        expect(thread?.comments[0]?.body).toBe('question about A');
    });

    it('an outdated thread enters the round with a marker instead of an excerpt', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        project.repo.write(`${PREFIX}/src/a.ts`, 'const a = 42;\n');
        await host.refresh();

        const thread = (await host.roundContext(round?.id ?? '')).threads[0];
        expect(thread?.excerpt).toBeNull();
        expect(thread?.note).toContain('outdated');
    });

    // Round context is read when the task is queued, not when publishing: unpublished
    // thread text never leaves the host.
    it('a draft written after publication stays out of round context', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        await host.saveDraft({ body: 'not sent yet', parentId: comment.id, anchor: null });
        const round = (await host.pendingRounds())[0];

        const thread = (await host.roundContext(round?.id ?? '')).threads[0];

        expect(thread?.comments).toHaveLength(1);
        expect(thread?.comments[0]?.replies).toEqual([]);
    });

    it('an agent reply becomes a bot comment and the round closes', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];
        const seen: Thread[][] = [];
        const stop = host.watchThreads((threads) => seen.push(threads));

        await host.completeRound(
            round?.id ?? '',
            { replies: [{ threadId: comment.id, body: 'extracted a constant' }], summary: 'fixed one thing' },
            { login: 'claude-code', displayName: 'Agent · claude-opus-5', bot: true, avatarUrl: null },
        );
        stop();

        const thread = (await host.getThreads()).find((candidate) => candidate.id === comment.id);
        expect(thread?.root.replies).toHaveLength(1);
        expect(thread?.root.replies[0]).toMatchObject({
            body: 'extracted a constant',
            draft: false,
            author: { login: 'claude-code', displayName: 'Agent · claude-opus-5', bot: true, avatarUrl: null },
        });
        expect(await host.pendingRounds()).toEqual([]);
        // The round summary is a PR-level discussion by the same author.
        const summary = (await host.getThreads()).find((candidate) => candidate.anchor === null);
        expect(summary?.root).toMatchObject({
            body: 'fixed one thing',
            draft: false,
            author: { login: 'claude-code', bot: true },
        });
        expect(summary?.pinnedTo).toBeNull();
        // Thread subscribers saw the reply without waiting for a polling tick.
        expect(seen.at(-1)?.find((candidate) => candidate.id === comment.id)?.root.replies).toHaveLength(1);
    });

    it('a published comment by the reviewer can be edited and physically deleted', async () => {
        project.seedTwoFiles();
        const threads = memoryThreadsStore();
        const host = makeHost({ threads });
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');

        await host.updateComment(comment.id, 'question about A, rewritten');
        const edited = (await host.getThreads()).find((candidate) => candidate.id === comment.id);
        expect(edited?.root.body).toBe('question about A, rewritten');
        expect(edited?.root.editedAt).not.toBeNull();

        await host.deleteComment(comment.id);
        expect((await host.getThreads()).some((candidate) => candidate.id === comment.id)).toBe(false);
        // Deletion is physical: the comment no longer exists in storage.
        expect((await threads.read()).threads).toEqual([]);
    });

    it('comments by others and drafts cannot be edited or deleted', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));

        await expect(host.updateComment(comment.id, 'draft edit')).rejects.toThrow('is a draft');

        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];
        await host.completeRound(
            round?.id ?? '',
            { replies: [{ threadId: comment.id, body: 'fixed' }], summary: 'summary' },
            { login: 'claude-code', displayName: 'Agent', bot: true, avatarUrl: null },
        );
        const reply = (await host.getThreads()).find((candidate) => candidate.id === comment.id)?.root.replies[0];

        await expect(host.deleteComment(reply?.id ?? '')).rejects.toThrow('belongs to claude-code');
    });

    it('rejects a reply to a thread outside the round', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        await expect(
            host.completeRound(
                round?.id ?? '',
                { replies: [{ threadId: 'not-ours', body: 'reply' }], summary: 'summary' },
                { login: 'agent', displayName: 'Agent', bot: true, avatarUrl: null },
            ),
        ).rejects.toThrow('is not in review round');
    });
});
