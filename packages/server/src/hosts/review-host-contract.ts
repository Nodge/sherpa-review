import type { Comment, ReviewHost, Thread } from '@sherpa/protocol';
import { lensSchema, prDiffSchema, prMetaSchema, threadSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

/**
 * Shared `ReviewHost` contract suite (requirements §7): the same tests run against every
 * implementation, currently `FixtureHost`, later review host mocks (M1-T10/T12).
 *
 * Checks interface promises rather than internals: response shapes
 * (fail-closed through protocol schemas), the `watchThreads` promise of an initial snapshot and a snapshot
 * after every change, the two-stage draft model and verdict semantics (SPEC §4.5).
 */

export interface ReviewHostContractOptions {
    /** Host supports writes (drafts, resolve, publication). Read-only mocks use `false`. */
    readonly writes?: boolean;
}

interface ThreadFeed {
    /** Snapshots in arrival order: the contract promises the first immediately after subscribing. */
    readonly snapshots: Thread[][];
    readonly stop: () => void;
}

function subscribe(host: ReviewHost): ThreadFeed {
    const snapshots: Thread[][] = [];
    const stop = host.watchThreads((threads) => {
        snapshots.push(threads);
    });
    return { snapshots, stop };
}

/**
 * Wait for a condition: `watchThreads` transport is an adapter detail (synchronous in the fixture,
 * polling in the review host). The contract promises only convergence.
 */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/**
 * Waits for the subscription to deliver a **new** snapshot showing the mutation result.
 * Checks `snapshots.length` growth separately: a host that returns a live reference to its
 * thread array once and then mutates it silently breaks the "snapshot on every change" promise,
 * even though the final state in `lastSnapshot` converges.
 */
async function waitFreshSnapshot(
    feed: ThreadFeed,
    seen: number,
    condition: () => boolean,
    what: string,
): Promise<void> {
    await waitUntil(() => feed.snapshots.length > seen && condition(), what);
}

function lastSnapshot(feed: ThreadFeed): Thread[] {
    const snapshot = feed.snapshots.at(-1);
    if (snapshot === undefined) {
        throw new Error('subscription has not sent any snapshots');
    }
    return snapshot;
}

function findComment(comments: readonly Comment[], id: string): Comment | null {
    for (const comment of comments) {
        if (comment.id === id) {
            return comment;
        }
        const found = findComment(comment.replies, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function findInThreads(threads: readonly Thread[], id: string): Comment | null {
    return findComment(
        threads.map((thread) => thread.root),
        id,
    );
}

function countDraftsIn(comment: Comment): number {
    return comment.replies.reduce((total, reply) => total + countDraftsIn(reply), comment.draft ? 1 : 0);
}

function countDrafts(threads: readonly Thread[]): number {
    return threads.reduce((total, thread) => total + countDraftsIn(thread.root), 0);
}

export function describeReviewHostContract(
    name: string,
    makeHost: () => ReviewHost,
    options: ReviewHostContractOptions = {},
): void {
    const writes = options.writes ?? true;

    describe(`ReviewHost contract: ${name}`, () => {
        it('getPr returns a valid PR header', async () => {
            const pr = await makeHost().getPr();
            expect(() => prMetaSchema.parse(pr)).not.toThrow();
        });

        it('getDiff returns a valid diff with unique fileId values', async () => {
            const diff = await makeHost().getDiff();
            expect(() => prDiffSchema.parse(diff)).not.toThrow();
            const ids = new Set(diff.files.map((file) => file.fileId));
            expect(ids.size).toBe(diff.files.length);
        });

        it('file viewed values agree with capabilities.fileViewedSync', async () => {
            const host = makeHost();
            const [pr, diff] = await Promise.all([host.getPr(), host.getDiff()]);
            for (const file of diff.files) {
                expect(file.viewed === null).toBe(!pr.capabilities.fileViewedSync);
            }
        });

        it('watchThreads sends an initial snapshot that passes schema validation', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');
            for (const thread of lastSnapshot(feed)) {
                expect(() => threadSchema.parse(thread)).not.toThrow();
            }
            feed.stop();
        });

        it('lenses pass schema validation', async () => {
            const host = makeHost();
            const ownership = await host.ownershipLens();
            if (ownership !== null) {
                expect(() => lensSchema.parse(ownership)).not.toThrow();
            }
            for (const lens of await host.extraLenses()) {
                expect(() => lensSchema.parse(lens)).not.toThrow();
            }
        });

        it.runIf(writes)('draft lifecycle: save, edit, delete', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');

            let seen = feed.snapshots.length;
            const created = await host.saveDraft({ body: 'contract draft', parentId: null, anchor: null });
            expect(created.draft).toBe(true);

            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id) !== null,
                'draft in the new thread snapshot',
            );
            expect(findInThreads(lastSnapshot(feed), created.id)?.draft).toBe(true);

            seen = feed.snapshots.length;
            await host.updateDraft(created.id, 'contract draft, edited');
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id)?.body === 'contract draft, edited',
                'draft edit in the new snapshot',
            );

            seen = feed.snapshots.length;
            await host.deleteDraft(created.id);
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id) === null,
                'draft removal in the new snapshot',
            );

            feed.stop();
        });

        it.runIf(writes)('a reply using parentId appears in the reply tree', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');

            let seen = feed.snapshots.length;
            const root = await host.saveDraft({ body: 'contract root', parentId: null, anchor: null });
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), root.id) !== null,
                'thread root in the new snapshot',
            );

            seen = feed.snapshots.length;
            const reply = await host.saveDraft({ body: 'contract reply', parentId: root.id, anchor: null });
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), reply.id) !== null,
                'reply in the new snapshot',
            );
            const storedRoot = findInThreads(lastSnapshot(feed), root.id);
            expect(storedRoot?.replies.map((child) => child.id)).toContain(reply.id);

            feed.stop();
        });

        it.runIf(writes)('unsubscribe stops the snapshot stream', async () => {
            const host = makeHost();
            const stopped = subscribe(host);
            // The second subscription confirms delivery. Without it, "the stopped one received nothing" means
            // only "the update has not arrived yet". A polling host interval can exceed any
            // fixed wait in the test.
            const control = subscribe(host);
            await waitUntil(
                () => stopped.snapshots.length > 0 && control.snapshots.length > 0,
                'initial snapshots of both subscriptions',
            );

            stopped.stop();
            const stoppedSeen = stopped.snapshots.length;
            const controlSeen = control.snapshots.length;

            const created = await host.saveDraft({ body: 'after unsubscribe', parentId: null, anchor: null });
            await waitFreshSnapshot(
                control,
                controlSeen,
                () => findInThreads(lastSnapshot(control), created.id) !== null,
                'draft in the control subscription',
            );
            expect(stopped.snapshots.length).toBe(stoppedSeen);

            control.stop();
        });

        it.runIf(writes)('resolving a thread is visible in the next snapshot', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');

            const target = lastSnapshot(feed).find((thread) => !thread.resolved);
            if (target === undefined) {
                feed.stop();
                return;
            }

            const seen = feed.snapshots.length;
            await host.setThreadResolved(target.id, true);
            await waitFreshSnapshot(
                feed,
                seen,
                () => lastSnapshot(feed).find((thread) => thread.id === target.id)?.resolved === true,
                'resolved in the new snapshot',
            );

            feed.stop();
        });

        it.runIf(writes)('publishBatch publishes drafts and applies the verdict', async () => {
            const host = makeHost();
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');

            const draft = await host.saveDraft({ body: 'contract publish', parentId: null, anchor: null });
            const seen = feed.snapshots.length;
            const result = await host.publishBatch('ship');

            expect(result.failed).toEqual([]);
            expect(result.publishedCommentIds).toContain(draft.id);
            expect(result.verdictApplied).toBe(true);

            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), draft.id)?.draft === false,
                'published comment in the new snapshot',
            );

            // No drafts remain after a full publication.
            expect(countDrafts(lastSnapshot(feed))).toBe(0);

            feed.stop();
        });

        it.runIf(writes)('setFileViewed is reflected in the next getDiff', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const setViewed = host.setFileViewed?.bind(host);

            if (!pr.capabilities.fileViewedSync) {
                expect(setViewed).toBeUndefined();
                return;
            }
            if (setViewed === undefined) {
                throw new Error('host declared fileViewedSync but did not provide setFileViewed');
            }

            const before = await host.getDiff();
            const file = before.files.find((candidate) => candidate.viewed === false);
            if (file === undefined) {
                return;
            }

            await setViewed(file.fileId, true);
            const after = await host.getDiff();
            expect(after.files.find((candidate) => candidate.fileId === file.fileId)?.viewed).toBe(true);
        });
    });
}
