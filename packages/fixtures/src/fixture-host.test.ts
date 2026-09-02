import type { Thread } from '@sherpa/protocol';
import { prDiffSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureIteration, MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2, MEDIUM_DIFF_ID_V3 } from './data/index.js';
import { makeFixtureHost } from './fixture-host.js';

// The shared `ReviewHost` contract suite runs on these same fixtures from the server package,
// where it lives: `packages/server/src/hosts/fixture-host.contract.test.ts`.

/** The first subscription snapshot is synchronous, so fixture tests can take it directly. */
function threadsOf(host: ReturnType<typeof makeFixtureHost>): Thread[] {
    let snapshot: Thread[] = [];
    const stop = host.watchThreads((threads) => {
        snapshot = threads;
    });
    stop();
    return snapshot;
}

describe('FixtureHost', () => {
    // Only checks that the host preserves the source data on reads.
    // Fixture builder purity is checked in fixtures.test.ts through two builds from scratch.
    it('two hosts for the same fixture return the same data', async () => {
        const first = makeFixtureHost('medium');
        const second = makeFixtureHost('medium');

        expect(await first.getPr()).toEqual(await second.getPr());
        expect(await first.getDiff()).toEqual(await second.getDiff());
        expect(threadsOf(first)).toEqual(threadsOf(second));
    });

    it('mutations do not leak into the next host', async () => {
        const baseline = threadsOf(makeFixtureHost('medium'));

        const first = makeFixtureHost('medium');
        await first.saveDraft({ body: 'draft', parentId: null, anchor: null });
        await first.publishBatch('ship');
        expect(threadsOf(first)).not.toEqual(baseline);

        const second = makeFixtureHost('medium');
        expect(threadsOf(second)).toEqual(baseline);
        expect((await second.getPr()).statusLabel).toBe('review_in_progress');
    });

    it('returned data is copied, so editing it does not change the host', async () => {
        const host = makeFixtureHost('medium');
        const diff = await host.getDiff();
        const file = diff.files.at(0);
        if (file === undefined) {
            throw new Error('medium fixture has no files');
        }
        file.additions = -1;
        const ownership = await host.ownershipLens();
        const zonePath = ownership?.zones?.at(0)?.paths.at(0);
        if (zonePath === undefined || ownership?.zones?.[0] === undefined) {
            throw new Error('medium fixture has no ownership zone');
        }
        ownership.zones[0].paths[0] = 'mutated/outside.ts';

        expect((await host.getDiff()).files.at(0)?.additions).toBeGreaterThan(0);
        expect((await host.ownershipLens())?.zones?.at(0)?.paths.at(0)).toBe(zonePath);
    });

    it('draft timestamps and ids come from the fixture instead of the clock', async () => {
        const host = makeFixtureHost('medium');
        const first = await host.saveDraft({ body: 'one', parentId: null, anchor: null });
        const second = await host.saveDraft({ body: 'two', parentId: null, anchor: null });

        expect(first.createdAt).toBe('2026-08-20T09:01:00.000Z');
        expect(second.createdAt).toBe('2026-08-20T09:02:00.000Z');
        expect(await makeFixtureHost('medium').saveDraft({ body: 'one', parentId: null, anchor: null })).toEqual(first);
    });

    it('draft id follows the host sign convention', async () => {
        const host = makeFixtureHost('medium');
        const diff = await host.getDiff();
        const file = diff.files.at(0);
        if (file === undefined) {
            throw new Error('medium fixture has no files');
        }

        const prLevel = await host.saveDraft({ body: 'pr level', parentId: null, anchor: null });
        const inline = await host.saveDraft({
            body: 'inline',
            parentId: null,
            anchor: { fileId: file.fileId, path: file.path, position: { side: 'new', line: 4, size: 1 } },
        });

        expect(Number(prLevel.id)).toBeLessThan(0);
        expect(Number(inline.id)).toBeGreaterThan(0);
    });

    it('stores issue for a supporting fixture, while edge ignores the flag', async () => {
        const host = makeFixtureHost('medium');
        const draft = await host.saveDraft({ body: 'issue', parentId: null, anchor: null, issue: true });
        expect(host.issueOf(draft.id)).toBe(true);

        await host.updateDraft(draft.id, 'not an issue', false);
        expect(host.issueOf(draft.id)).toBe(false);

        // A draft without the flag is not an issue, rather than "status unknown". `null` occurs only in edge.
        const plain = await host.saveDraft({ body: 'plain', parentId: null, anchor: null });
        expect(host.issueOf(plain.id)).toBe(false);

        const edge = makeFixtureHost('edge');
        const degraded = await edge.saveDraft({ body: 'ignored', parentId: null, anchor: null, issue: true });
        await edge.updateDraft(degraded.id, 'still ignored', false);
        expect(edge.issueOf(degraded.id)).toBeNull();
    });

    it('a reply to a comment in an existing thread joins its subtree', async () => {
        const host = makeFixtureHost('medium');
        const before = threadsOf(host);
        const parent = before.at(0)?.root.replies.at(0);
        if (parent === undefined) {
            throw new Error('expected a thread with replies in the medium fixture');
        }

        const reply = await host.saveDraft({ body: 'my reply', parentId: parent.id, anchor: null });
        const after = threadsOf(host);
        const stored = after.at(0)?.root.replies.at(0);

        expect(stored?.replies.map((child) => child.id)).toContain(reply.id);
        expect(after.length).toBe(before.length);
    });

    it('a published comment cannot be edited or deleted', async () => {
        const host = makeFixtureHost('medium');
        const published = threadsOf(host).at(0)?.root;
        if (published === undefined) {
            throw new Error('expected threads in the medium fixture');
        }

        await expect(host.updateDraft(published.id, 'nope')).rejects.toThrow(/already published/);
        await expect(host.deleteDraft(published.id)).rejects.toThrow(/already published/);
    });

    it('does not apply the verdict after partial publication failure (SPEC §4.5)', async () => {
        // Draft ids are deterministic, so a future draft can be set to fail in advance.
        const probe = await makeFixtureHost('medium').saveDraft({ body: 'probe', parentId: null, anchor: null });

        const host = makeFixtureHost('medium', { failPublishFor: [probe.id] });
        const doomed = await host.saveDraft({ body: 'will fail', parentId: null, anchor: null });
        const fine = await host.saveDraft({ body: 'will publish', parentId: null, anchor: null });
        expect(doomed.id).toBe(probe.id);

        const result = await host.publishBatch('ship');

        expect(result.verdictApplied).toBe(false);
        expect(result.publishedCommentIds).toEqual([fine.id]);
        expect(result.failed.map((entry) => entry.commentId)).toEqual([doomed.id]);
        expect(host.appliedVerdict()).toBeNull();
        expect((await host.getPr()).statusLabel).toBe('review_in_progress');
    });

    it('a verdict changes PR status only on complete success', async () => {
        const host = makeFixtureHost('medium');
        await host.saveDraft({ body: 'ok', parentId: null, anchor: null });

        const result = await host.publishBatch('request_changes');

        expect(result.verdictApplied).toBe(true);
        expect(host.appliedVerdict()).toBe('request_changes');
        expect((await host.getPr()).statusLabel).toBe('needs_work');
    });

    it('rejects sticky ship on a host that does not support it', async () => {
        const host = makeFixtureHost('edge');
        expect((await host.getPr()).capabilities.stickyShip).toBe(false);
        await expect(host.publishBatch('sticky_ship')).rejects.toThrow(/sticky/);
    });

    it('a host without fileViewedSync does not provide setFileViewed', async () => {
        const host = makeFixtureHost('small');
        expect((await host.getPr()).capabilities.fileViewedSync).toBe(false);
        expect(host.setFileViewed).toBeUndefined();
    });

    it('before a push the host lists one active iteration', async () => {
        const host = makeFixtureHost('medium');
        const v1 = fixtureIteration('medium').diff;

        expect(await host.listIterations()).toEqual([
            {
                diffId: v1.diffId,
                baseCommit: v1.baseCommit,
                headCommit: v1.headCommit,
                createdAt: fixtureIteration('medium').iteration.createdAt,
                status: 'active',
            },
        ]);
        expect((await host.getDiff()).diffId).toBe(v1.diffId);
    });

    it('advanceIteration makes the next iteration active and the old one previous', async () => {
        const host = makeFixtureHost('medium');

        const advanced = host.advanceIteration();

        expect(advanced.diffId).toBe(MEDIUM_DIFF_ID_V2);
        expect(advanced.status).toBe('active');
        expect(await host.listIterations()).toEqual([
            expect.objectContaining({ diffId: MEDIUM_DIFF_ID, status: 'previous' }),
            expect.objectContaining({ diffId: MEDIUM_DIFF_ID_V2, status: 'active' }),
        ]);
        expect((await host.getDiff()).diffId).toBe(MEDIUM_DIFF_ID_V2);
    });

    it('force-push removes the rewritten iteration from the list and stops at the end of the fixture', async () => {
        const host = makeFixtureHost('medium');
        host.advanceIteration();
        host.advanceIteration();

        expect((await host.listIterations()).map((iteration) => iteration.diffId)).toEqual([
            MEDIUM_DIFF_ID,
            MEDIUM_DIFF_ID_V3,
        ]);
        expect(() => host.advanceIteration()).toThrow(/no more iterations/);
    });

    it('watchIterations receives a snapshot immediately and after each push', () => {
        const host = makeFixtureHost('medium');
        const seen: string[][] = [];
        const stop = host.watchIterations((list) => seen.push(list.map((iteration) => iteration.diffId)));

        host.advanceIteration();
        stop();
        host.advanceIteration();

        expect(seen).toEqual([[MEDIUM_DIFF_ID], [MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2]]);
    });

    it('returns a slice for a declared pair and rejects an unknown pair', async () => {
        const host = makeFixtureHost('medium');
        host.advanceIteration();

        const slice = await host.getDiff({ base: MEDIUM_DIFF_ID, head: MEDIUM_DIFF_ID_V2 });
        expect(prDiffSchema.parse(slice).diffId).toBe(MEDIUM_DIFF_ID_V2);
        expect(slice.files.length).toBeGreaterThan(0);

        await expect(host.getDiff({ base: MEDIUM_DIFF_ID_V3, head: MEDIUM_DIFF_ID_V2 })).rejects.toThrow(
            /iteration 183044 is unknown to the host/,
        );
        await expect(host.getDiff({ base: MEDIUM_DIFF_ID_V2, head: MEDIUM_DIFF_ID })).rejects.toThrow(/slice .+ is absent from the fixture/);
    });

    it('threads follow the active iteration: an author reply and a thread on a removed file', () => {
        const host = makeFixtureHost('medium');
        expect(threadsOf(host).find((thread) => thread.id === '4820260')?.outdated).toBe(false);

        host.advanceIteration();
        const threads = threadsOf(host);

        const handlers = threads.find((thread) => thread.id === '4820242');
        expect(handlers?.root.replies[0]?.replies.at(-1)?.body).toMatch(/only returned for `edit-window-closed`/);
        const departed = threads.find((thread) => thread.id === '4820260');
        expect(departed?.outdated).toBe(true);
    });

    it('a fixture without iterations never returns a slice', async () => {
        const host = makeFixtureHost('small');
        const iterations = await host.listIterations();

        expect(iterations.length).toBe(1);
        expect((await host.getPr()).capabilities.iterations).toBe(false);
        await expect(
            host.getDiff({ base: iterations[0]?.diffId ?? '', head: iterations[0]?.diffId ?? '' }),
        ).rejects.toThrow(/capabilities.iterations/);
        expect(() => host.advanceIteration()).toThrow(/no more iterations/);
    });

    it('thread resolution is attributed to the current fixture user', async () => {
        const host = makeFixtureHost('medium');
        const target = threadsOf(host).find((thread) => !thread.resolved);
        if (target === undefined) {
            throw new Error('expected an unresolved thread in the medium fixture');
        }

        await host.setThreadResolved(target.id, true);
        expect(threadsOf(host).find((thread) => thread.id === target.id)?.resolvedBy).toBe('alice');

        await host.setThreadResolved(target.id, false);
        expect(threadsOf(host).find((thread) => thread.id === target.id)?.resolvedBy).toBeNull();
    });
});
