import type { Comment, ReviewHost, Thread } from '@sherpa/protocol';
import { fileContentSchema, lensSchema, prDiffSchema, prMetaSchema, threadSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

/**
 * Shared `ReviewHost` contract suite (requirements §7): the same tests run against every
 * implementations, using `FixtureHost` and recorded host responses (M1-T10/T12).
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

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Patch context lines with their new-side line numbers. */
function patchContextLines(patch: string): { line: number; text: string }[] {
    const found: { line: number; text: string }[] = [];
    let line = 0;

    for (const raw of patch.split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header !== null) {
            line = Number(header[1]);
            continue;
        }
        if (line === 0) {
            continue;
        }

        const prefix = raw.slice(0, 1);
        if (prefix === '+') {
            line += 1;
        } else if (prefix === ' ') {
            found.push({ line, text: raw.slice(1) });
            line += 1;
        }
    }
    return found;
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

        it('getFileContent agrees with capabilities.fileContent', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const getContent = host.getFileContent?.bind(host);

            if (!pr.capabilities.fileContent) {
                expect(getContent).toBeUndefined();
                return;
            }
            if (getContent === undefined) {
                throw new Error('host declared fileContent but did not provide getFileContent');
            }

            const diff = await host.getDiff();
            const binary = diff.files.find((file) => file.binary);
            if (binary !== undefined) {
                expect(await getContent(binary.fileId)).toBeNull();
            }

            // A text file with hunks must have text that matches the patch by line
            // number, otherwise "Expand context" would show context from the wrong place.
            const text = diff.files.find((file) => !file.binary && file.patch !== null && file.changeType === 'modify');
            if (text?.patch == null) {
                return;
            }

            const content = await getContent(text.fileId);
            if (content === null) {
                throw new Error(`host did not return the contents of text file ${text.path}`);
            }
            expect(() => fileContentSchema.parse(content)).not.toThrow();

            const newLines = content.newText?.split('\n') ?? [];
            expect(newLines.length).toBeGreaterThan(0);
            for (const context of patchContextLines(text.patch)) {
                expect(newLines[context.line - 1], `${text.path}:${String(context.line)}`).toBe(context.text);
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

        it('getThreads returns the same state as the initial subscription snapshot', async () => {
            const host = makeHost();
            const threads = await host.getThreads();
            for (const thread of threads) {
                expect(() => threadSchema.parse(thread)).not.toThrow();
            }
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');
            expect(threads).toEqual(feed.snapshots[0]);
            feed.stop();
        });

        it('lenses pass schema validation and zones reference only diff files without duplicates', async () => {
            const host = makeHost();
            const [diff, ownership, extra] = await Promise.all([
                host.getDiff(),
                host.ownershipLens(),
                host.extraLenses(),
            ]);
            const lenses = ownership === null ? extra : [ownership, ...extra];
            const diffPaths = new Set(diff.files.map((file) => file.path));

            for (const lens of lenses) {
                expect(() => lensSchema.parse(lens)).not.toThrow();
                const zonedPaths = new Set<string>();
                for (const zone of lens.zones ?? []) {
                    expect(zone.paths.length).toBeGreaterThan(0);
                    for (const path of zone.paths) {
                        expect(diffPaths.has(path), `${lens.id}: unknown zone path ${path}`).toBe(true);
                        expect(zonedPaths.has(path), `${lens.id}: path ${path} belongs to two zones`).toBe(false);
                        zonedPaths.add(path);
                    }
                }
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
