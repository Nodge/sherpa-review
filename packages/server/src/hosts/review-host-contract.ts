import type { Comment, Iteration, ReviewHost, Thread, Verdict } from '@sherpa/protocol';
import {
    fileContentSchema,
    fileImageSchema,
    IMAGE_BLOB_MAX_BYTES,
    iterationSchema,
    lensSchema,
    prDiffSchema,
    prMetaSchema,
    reviewUserSchema,
    threadSchema,
    verdictSchema,
} from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

/**
 * Shared `ReviewHost` contract suite (`docs/testing.md §3`): the same list of tests
 * runs against all implementations: `FixtureHost`, recorded remote host responses and `LocalHost`
 * with each VCS backend (fake and real).
 *
 * Checks interface promises rather than internals: response shapes
 * (fail-closed through protocol schemas), the `watchThreads` promise of an initial snapshot and a snapshot
 * after every change, the two-stage draft model and verdict semantics
 * (`docs/design/SPEC-elements.md §4.5`).
 */

export interface ReviewHostContractOptions<H extends ReviewHost> {
    /** Host supports writes (drafts, resolve, publication). Read-only mocks use `false`. */
    readonly writes?: boolean;
    /**
     * "Author pushed": advance the host to the next iteration (fixture uses
     * `advanceIteration()`, remote host mocks have their own "push"). Without this hook, skip iteration-change
     * tests: a host with one iteration has nothing to test them on.
     */
    readonly advance?: (host: H) => void | Promise<void>;
    /** Expected login in `PrMeta.viewer`. If absent, check only the general field requirements. */
    readonly viewer?: string | null;
    /** Skip the entire suite: the required tool (real `git`) is missing from the machine. */
    readonly skip?: boolean;
    /**
     * Implementation calls an external process (real `git`): each call spawns about ten processes,
     * so raise test and wait timeouts.
     */
    readonly slow?: boolean;
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

/** Convergence wait limits: one call to a host backed by an external process takes seconds. */
const WAIT_MS = 2_000;
const SLOW_WAIT_MS = 20_000;

/** Per-test timeout for a slow implementation. Fast implementations keep the Vitest default. */
const SLOW_TIMEOUT_MS = 60_000;

/**
 * Wait for a condition: `watchThreads` transport is an adapter detail (synchronous in the fixture,
 * polling in a remote host), and the contract promises only convergence.
 */
async function waitWithin(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

interface IterationFeed {
    readonly snapshots: Iteration[][];
    readonly stop: () => void;
}

function subscribeIterations(host: ReviewHost): IterationFeed {
    const snapshots: Iteration[][] = [];
    const stop = host.watchIterations((iterations) => {
        snapshots.push(iterations);
    });
    return { snapshots, stop };
}

function activeOf(iterations: readonly Iteration[]): Iteration {
    const active = iterations.filter((iteration) => iteration.status === 'active');
    if (active.length !== 1 || active[0] === undefined) {
        throw new Error(`expected exactly one active iteration, got ${String(active.length)}`);
    }
    return active[0];
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

/**
 * Verdict used by the contract to publish drafts: `comment` if the host accepts it, otherwise the first
 * in `publishVerdicts`. null means the host has no way to publish on this PR.
 */
async function publishingVerdict(host: ReviewHost): Promise<Verdict | null> {
    const { publishVerdicts } = (await host.getPr()).capabilities;
    return publishVerdicts.includes('comment') ? 'comment' : (publishVerdicts[0] ?? null);
}

function commentsOf(comment: Comment): Comment[] {
    return [comment, ...comment.replies.flatMap(commentsOf)];
}

/**
 * Host rule with `commentResolve`: a thread is resolved if it has issues and all of them are resolved.
 * Restated here instead of imported from the adapter: the contract checks the promise, not its code.
 */
function threadResolvedByRule(thread: Thread): boolean {
    const issues = commentsOf(thread.root).filter((comment) => comment.issue === true);
    return issues.length > 0 && issues.every((comment) => comment.resolved === true);
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

export function describeReviewHostContract<H extends ReviewHost>(
    name: string,
    makeHost: () => H,
    options: ReviewHostContractOptions<H> = {},
): void {
    const writes = options.writes ?? true;
    const advance = options.advance;
    const slow = options.slow ?? false;
    const waitMs = slow ? SLOW_WAIT_MS : WAIT_MS;

    /** Wait for convergence within this implementation's limit. */
    const waitUntil = (condition: () => boolean, what: string): Promise<void> =>
        waitWithin(condition, what, waitMs);

    /**
     * Waits for the subscription to send a **new** snapshot after a mutation with the result visible in it.
     * The increase in `snapshots.length` is checked separately. A host that returns a live reference to its
     * thread array once and then silently mutates it breaks the promise of a snapshot on every change,
     * even though the final state in `lastSnapshot` would still match.
     */
    const waitFreshSnapshot = (
        feed: ThreadFeed,
        seen: number,
        condition: () => boolean,
        what: string,
    ): Promise<void> => waitUntil(() => feed.snapshots.length > seen && condition(), what);

    const suite = describe.skipIf(options.skip ?? false);
    suite(`ReviewHost contract: ${name}`, slow ? { timeout: SLOW_TIMEOUT_MS } : {}, () => {
        it('getPr returns a valid PR header', async () => {
            const pr = await makeHost().getPr();
            expect(() => prMetaSchema.parse(pr)).not.toThrow();
        });

        it('viewer identifies the reviewer and is required for editPublished', async () => {
            const pr = await makeHost().getPr();

            if (pr.viewer !== null) {
                expect(() => reviewUserSchema.parse(pr.viewer)).not.toThrow();
                expect(pr.viewer.login.trim()).not.toBe('');
                expect(pr.viewer.bot).toBe(false);
            }
            // Editing your own published comments requires an identity to check ownership against.
            if (pr.capabilities.editPublished) {
                expect(pr.viewer).not.toBeNull();
            }
            if (options.viewer !== undefined) {
                expect(pr.viewer?.login ?? null).toBe(options.viewer);
            }
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

        it('getBlob agrees with capabilities.blobs', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const getBlob = host.getBlob?.bind(host);

            if (!pr.capabilities.blobs) {
                expect(getBlob).toBeUndefined();
                // Images cannot be displayed without bytes, so a host without them never marks files as images.
                expect((await host.getDiff()).files.every((file) => file.image === null)).toBe(true);
                return;
            }
            if (getBlob === undefined) {
                throw new Error('host declared blobs but did not provide getBlob');
            }

            expect(await getBlob('no-such-blob')).toBeNull();

            for (const file of (await host.getDiff()).files) {
                if (file.image === null) {
                    continue;
                }
                expect(() => fileImageSchema.parse(file.image)).not.toThrow();
                for (const side of [file.image.before, file.image.after]) {
                    if (side === null) {
                        continue;
                    }
                    const bytes = await getBlob(side.blobId);
                    if (side.size > IMAGE_BLOB_MAX_BYTES) {
                        expect(bytes, `${file.path}: side exceeds the limit`).toBeNull();
                        continue;
                    }
                    if (bytes === null) {
                        throw new Error(`host did not return bytes for the image side ${file.path}`);
                    }
                    expect(bytes.length, `${file.path}: byte length disagrees with size`).toBe(side.size);
                }
            }
        });

        it('listIterations has exactly one active iteration, none gone, and nondecreasing timestamps', async () => {
            const iterations = await makeHost().listIterations();

            expect(iterations.length).toBeGreaterThan(0);
            for (const iteration of iterations) {
                expect(() => iterationSchema.parse(iteration)).not.toThrow();
            }
            // Only the server sets `gone`, by comparing the host list with its storage.
            expect(iterations.filter((iteration) => iteration.status === 'gone')).toEqual([]);
            expect(activeOf(iterations)).toBeDefined();

            const created = iterations.map((iteration) => iteration.createdAt);
            expect([...created].sort((left, right) => left.localeCompare(right))).toEqual(created);
        });

        it('slices between iterations agree with capabilities.iterations', async () => {
            const host = makeHost();
            const [pr, iterations] = await Promise.all([host.getPr(), host.listIterations()]);

            if (!pr.capabilities.iterations) {
                expect(iterations).toHaveLength(1);
                const only = activeOf(iterations).diffId;
                await expect(host.getDiff({ base: only, head: only })).rejects.toThrow();
                return;
            }
            if (iterations.length < 2) {
                return;
            }

            const head = activeOf(iterations);
            const base = iterations.filter((iteration) => iteration.diffId !== head.diffId).at(-1);
            if (base === undefined) {
                throw new Error('list has no iteration other than the active one');
            }

            const slice = await host.getDiff({ base: base.diffId, head: head.diffId });
            expect(() => prDiffSchema.parse(slice)).not.toThrow();
            expect(slice.diffId).toBe(head.diffId);
            const ids = new Set(slice.files.map((file) => file.fileId));
            expect(ids.size).toBe(slice.files.length);
        });

        // Slice paths are checked here. There is no separate endpoint for the previous iteration diff,
        // so the only way to learn its files through the interface is to read them before the "push".
        it.runIf(advance !== undefined)('a slice between old and new iterations uses paths from their union', async () => {
            const host = makeHost();
            if (!(await host.getPr()).capabilities.iterations) {
                return;
            }

            const before = await host.getDiff();
            await advance?.(host);
            const after = await host.getDiff();

            const slice = await host.getDiff({ base: before.diffId, head: after.diffId });
            expect(() => prDiffSchema.parse(slice)).not.toThrow();
            expect(slice.diffId).toBe(after.diffId);

            const union = new Set([...before.files, ...after.files].map((file) => file.path));
            for (const file of slice.files) {
                expect(union.has(file.path), `${file.path} is absent from both iterations`).toBe(true);
            }
        });

        it('a slice with an unknown iteration is rejected instead of returning an empty diff', async () => {
            const host = makeHost();
            const head = activeOf(await host.listIterations()).diffId;
            await expect(host.getDiff({ base: 'no-such-iteration', head })).rejects.toThrow();
        });

        it('watchIterations sends the initial list immediately', async () => {
            const host = makeHost();
            const feed = subscribeIterations(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial iteration list');

            const first = feed.snapshots[0] ?? [];
            for (const iteration of first) {
                expect(() => iterationSchema.parse(iteration)).not.toThrow();
            }
            expect(activeOf(first)).toBeDefined();
            feed.stop();
        });

        it.runIf(advance !== undefined)('a push delivers a list with a different active iteration', async () => {
            const host = makeHost();
            const feed = subscribeIterations(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial iteration list');
            const before = activeOf(feed.snapshots[0] ?? []);

            await advance?.(host);
            await waitUntil(
                () =>
                    feed.snapshots.length > 1 &&
                    activeOf(feed.snapshots.at(-1) ?? []).diffId !== before.diffId,
                'iteration list with a new active iteration',
            );

            const after = activeOf(feed.snapshots.at(-1) ?? []);
            expect(after.diffId).not.toBe(before.diffId);
            expect(() => iterationSchema.parse(after)).not.toThrow();
            feed.stop();
        });

        it.runIf(advance !== undefined)('after a push, the diff and threads belong to the new iteration', async () => {
            const host = makeHost();
            const before = await host.getDiff();

            await advance?.(host);

            const after = await host.getDiff();
            expect(() => prDiffSchema.parse(after)).not.toThrow();
            expect(after.diffId).not.toBe(before.diffId);
            expect(after.diffId).toBe(activeOf(await host.listIterations()).diffId);

            // Thread contents in the new iteration are up to the implementation. The contract promises their shape.
            for (const thread of await host.getThreads()) {
                expect(() => threadSchema.parse(thread)).not.toThrow();
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
            if (ownership !== null) {
                expect(host.ownershipSource, 'the ownership lens has a name for its zone source').not.toBeNull();
            }
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

            const supportsIssues = (await host.getPr()).capabilities.commentIssues;
            let seen = feed.snapshots.length;
            const created = await host.saveDraft({
                body: 'contract draft',
                parentId: null,
                anchor: null,
                ...(supportsIssues ? { issue: true } : {}),
            });
            expect(created.draft).toBe(true);
            // `null` is only for hosts without issue support. Where issues exist, "unknown" is not a valid state, and the UI
            // renders a disabled toggle instead of hiding it.
            expect(created.issue).toBe(supportsIssues ? true : null);

            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id) !== null,
                'draft in the new thread snapshot',
            );
            expect(findInThreads(lastSnapshot(feed), created.id)?.draft).toBe(true);
            expect(lastSnapshot(feed).find((thread) => thread.id === created.id)?.resolved).toBe(false);

            seen = feed.snapshots.length;
            if (supportsIssues) {
                await host.updateDraft(created.id, 'contract draft, edited', false);
            } else {
                await host.updateDraft(created.id, 'contract draft, edited');
            }
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id)?.body === 'contract draft, edited',
                'draft edit in the new snapshot',
            );
            expect(findInThreads(lastSnapshot(feed), created.id)?.issue).toBe(supportsIssues ? false : null);

            // Issue status can also be edited on a reply, not just the thread root.
            seen = feed.snapshots.length;
            const reply = await host.saveDraft({ body: 'contract reply draft', parentId: created.id, anchor: null });
            if (supportsIssues) {
                await host.updateDraft(reply.id, 'contract reply draft, edited', true);
                await waitFreshSnapshot(
                    feed,
                    seen,
                    () => findInThreads(lastSnapshot(feed), reply.id)?.issue === true,
                    'reply issue in the new snapshot',
                );
            }
            await host.deleteDraft(reply.id);

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

        // A retry from the draft buffer uses the key from the first attempt. The host
        // must accept the parameter even if it does not handle duplicates itself (fixture).
        it.runIf(writes)('saveDraft accepts an idempotency key', async () => {
            const host = makeHost();
            const idempotencyKey = 'contract-idempotency-key';

            const created = await host.saveDraft(
                { body: 'contract idempotency', parentId: null, anchor: null },
                { idempotencyKey },
            );
            expect(created.draft).toBe(true);

            const repeated = await host.saveDraft(
                { body: 'contract idempotency', parentId: null, anchor: null },
                { idempotencyKey },
            );
            expect(repeated.draft).toBe(true);

            await host.deleteDraft(created.id);
            if (repeated.id !== created.id) {
                await host.deleteDraft(repeated.id);
            }
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

        it('setCommentResolved agrees with capabilities.commentResolve', async () => {
            const host = makeHost();
            const pr = await host.getPr();
            const setResolved = host.setCommentResolved?.bind(host);

            if (!pr.capabilities.commentResolve) {
                expect(setResolved).toBeUndefined();
            } else if (setResolved === undefined) {
                throw new Error('host declared commentResolve but did not provide setCommentResolved');
            }

            for (const thread of await host.getThreads()) {
                for (const comment of commentsOf(thread.root)) {
                    // `null` is only for hosts without per-comment resolution. Where it exists,
                    // "unknown" is not a valid state, just as with `issue`.
                    expect(comment.resolved === null, `${comment.id}: resolved disagrees with capabilities`).toBe(
                        !pr.capabilities.commentResolve,
                    );
                }
                if (pr.capabilities.commentResolve) {
                    expect(thread.resolved, `thread ${thread.id}: resolved disagrees with the rule`).toBe(
                        threadResolvedByRule(thread),
                    );
                }
            }
        });

        it('updateComment and deleteComment agree with capabilities.editPublished', async () => {
            const host = makeHost();
            const pr = await host.getPr();

            const update = host.updateComment?.bind(host);
            const remove = host.deleteComment?.bind(host);

            if (pr.capabilities.editPublished) {
                if (update === undefined || remove === undefined) {
                    throw new Error('host declared editPublished but did not provide editing or deletion');
                }
                return;
            }
            expect(update).toBeUndefined();
            expect(remove).toBeUndefined();
        });

        it.runIf(writes)('resolving a comment resolves both the comment and its thread', async () => {
            const host = makeHost();
            const setResolved = host.setCommentResolved?.bind(host);
            if (setResolved === undefined || !(await host.getPr()).capabilities.commentIssues) {
                return;
            }

            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');

            const seen = feed.snapshots.length;
            const created = await host.saveDraft({
                body: 'contract issue',
                parentId: null,
                anchor: null,
                issue: true,
            });
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), created.id) !== null,
                'issue comment in the new snapshot',
            );
            expect(findInThreads(lastSnapshot(feed), created.id)?.resolved).toBe(false);
            expect(lastSnapshot(feed).find((thread) => thread.id === created.id)?.resolved).toBe(false);

            const afterCreate = feed.snapshots.length;
            await setResolved(created.id, true);
            await waitFreshSnapshot(
                feed,
                afterCreate,
                () => findInThreads(lastSnapshot(feed), created.id)?.resolved === true,
                'resolved issue in the new snapshot',
            );
            expect(lastSnapshot(feed).find((thread) => thread.id === created.id)?.resolved).toBe(true);

            feed.stop();
        });

        it.runIf(writes)('a reply can also open an issue', async () => {
            const host = makeHost();
            if (!(await host.getPr()).capabilities.commentIssues) {
                return;
            }

            const root = await host.saveDraft({ body: 'contract issue root', parentId: null, anchor: null });
            const reply = await host.saveDraft({
                body: 'contract issue reply',
                parentId: root.id,
                anchor: null,
                issue: true,
            });
            expect(reply.issue).toBe(true);
            expect(findInThreads(await host.getThreads(), reply.id)?.issue).toBe(true);
        });

        it.runIf(writes)('a published comment can be edited and deleted', async () => {
            const host = makeHost();
            const updateComment = host.updateComment?.bind(host);
            const deleteComment = host.deleteComment?.bind(host);
            const verdict = await publishingVerdict(host);
            if (updateComment === undefined || deleteComment === undefined || verdict === null) {
                return;
            }

            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');

            const draft = await host.saveDraft({ body: 'contract published', parentId: null, anchor: null });
            const published = await host.publishBatch(verdict);
            expect(published.failed).toEqual([]);
            await waitUntil(
                () => findInThreads(lastSnapshot(feed), draft.id)?.draft === false,
                'published comment in the snapshot',
            );

            let seen = feed.snapshots.length;
            await updateComment(draft.id, 'contract published, edited');
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), draft.id)?.body === 'contract published, edited',
                'published comment edit in the new snapshot',
            );

            seen = feed.snapshots.length;
            await deleteComment(draft.id);
            await waitFreshSnapshot(
                feed,
                seen,
                () => findInThreads(lastSnapshot(feed), draft.id) === null,
                'published comment removal in the new snapshot',
            );

            feed.stop();
        });

        it.runIf(writes)('publishBatch publishes drafts as one batch', async () => {
            const host = makeHost();
            const verdict = await publishingVerdict(host);
            if (verdict === null) {
                return;
            }
            const feed = subscribe(host);
            await waitUntil(() => feed.snapshots.length > 0, 'initial thread snapshot');

            const draft = await host.saveDraft({ body: 'contract publish', parentId: null, anchor: null });
            const seen = feed.snapshots.length;
            const result = await host.publishBatch(verdict);

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

        it('publishVerdicts has no duplicates', async () => {
            const { publishVerdicts } = (await makeHost().getPr()).capabilities;
            expect(new Set(publishVerdicts).size).toBe(publishVerdicts.length);
        });

        it.runIf(writes)('a verdict outside publishVerdicts is rejected and drafts remain drafts', async () => {
            const host = makeHost();
            const { publishVerdicts } = (await host.getPr()).capabilities;
            const outside = verdictSchema.options.filter((verdict) => !publishVerdicts.includes(verdict));
            if (outside.length === 0) {
                return;
            }

            const draft = await host.saveDraft({ body: 'contract refused', parentId: null, anchor: null });
            for (const verdict of outside) {
                await expect(host.publishBatch(verdict), verdict).rejects.toThrow();
            }
            expect(findInThreads(await host.getThreads(), draft.id)?.draft).toBe(true);
        });

        it.runIf(writes)('comment without drafts does nothing', async () => {
            const host = makeHost();
            if (!(await host.getPr()).capabilities.publishVerdicts.includes('comment')) {
                return;
            }
            // Remove drafts from the host data beforehand to test an empty batch.
            if (countDrafts(await host.getThreads()) > 0) {
                await host.publishBatch('comment');
            }
            const before = await host.getThreads();
            expect(countDrafts(before)).toBe(0);

            expect(await host.publishBatch('comment')).toEqual({
                publishedCommentIds: [],
                failed: [],
                verdictApplied: true,
            });
            expect(await host.getThreads()).toEqual(before);
        });

        it.runIf(writes)('each verdict in publishVerdicts publishes a draft and takes effect', async () => {
            const { publishVerdicts } = (await makeHost().getPr()).capabilities;
            for (const verdict of publishVerdicts.filter((candidate) => candidate !== 'comment')) {
                const host = makeHost();
                const draft = await host.saveDraft({ body: `contract ${verdict}`, parentId: null, anchor: null });

                const result = await host.publishBatch(verdict);

                expect(result.failed, verdict).toEqual([]);
                expect(result.publishedCommentIds, verdict).toContain(draft.id);
                expect(result.verdictApplied, verdict).toBe(true);
            }
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
