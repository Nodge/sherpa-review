import type { Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureData } from './data/index.js';
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

    it('rejects an arbitrary diff slice with a clear error', async () => {
        const host = makeFixtureHost('medium');
        await expect(host.getDiff({ base: 'deadbeef' })).rejects.toThrow(/one iteration/);
        await expect(host.getDiff({ base: fixtureData('medium').diff.baseCommit })).resolves.toBeDefined();
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
