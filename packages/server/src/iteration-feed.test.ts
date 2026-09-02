import path from 'node:path';

import { chatFixtures, fixtureData, fixtureIteration, makeFixtureHost } from '@sherpa/fixtures';
import type { AgentNote, Iteration, RouteSnapshot } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatStore } from './chat-store.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { NoteCarrier } from './iteration-feed.js';
import { IterationFeed, staleFor } from './iteration-feed.js';
import { IterationStore } from './iteration-store.js';
import { ProgressStore } from './progress-store.js';
import type { RouteListener } from './route-store.js';
import { mediumReadySnapshot } from './route/fixture-support.js';
import { makeTempSherpaDir, removeTempSherpaDir, seedAgentNotes } from './test-support.js';

/**
 * Push detection (M4-T4): merged iteration list, stale route flag and affected
 * stops. The `medium` fixture has 3 iterations, the third force-pushes over the second.
 */

/** Iteration metadata for the `medium` fixture: v1, a regular push v2 and a force-push v3 over the second. */
function fixtureIterationMeta(index: number): Omit<Iteration, 'status'> {
    const meta = fixtureData('medium').iterations[index]?.iteration;
    if (meta === undefined) {
        throw new Error(`medium fixture has no iteration ${String(index + 1)}`);
    }
    return meta;
}

const V1 = fixtureIterationMeta(0);
const V2 = fixtureIterationMeta(1);
const V3 = fixtureIterationMeta(2);
const NOTES = chatFixtures('medium')?.notes ?? [];
const NOTES_AFTER_PUSH = chatFixtures('medium')?.notesAfterPush ?? [];

function iterationOf(source: Omit<Iteration, 'status'>, status: Iteration['status']): Iteration {
    return { ...source, status };
}

function snapshotOn(iteration: Omit<Iteration, 'status'>): RouteSnapshot {
    return { ...mediumReadySnapshot(), diffId: iteration.diffId, commit: iteration.headCommit };
}

/** Waits for a condition to hold. The interdiff is computed asynchronously and emits no event of its own. */
async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(condition()).toBe(true);
}

describe('stale rule', () => {
    it('without a snapshot, there is nothing to compare', () => {
        expect(staleFor(null, [iterationOf(V1, 'active')])).toBeNull();
    });

    it('an unknown active iteration means the feed has not started yet', () => {
        expect(staleFor(snapshotOn(V1), [])).toBeNull();
    });

    it('a snapshot on the active iteration is not stale', () => {
        expect(staleFor(snapshotOn(V1), [iterationOf(V1, 'active')])).toBeNull();
    });

    it('a snapshot of a previous iteration is stale and names both sides', () => {
        expect(staleFor(snapshotOn(V1), [iterationOf(V1, 'previous'), iterationOf(V2, 'active')])).toEqual({
            routeCommit: V1.headCommit,
            prCommit: V2.headCommit,
            prDiffId: V2.diffId,
            newIterations: 1,
            affectedStopIds: [],
        });
    });

    it('a force-push counts as one iteration, excluding the overwritten one', () => {
        const stale = staleFor(snapshotOn(V1), [
            iterationOf(V1, 'previous'),
            iterationOf(V2, 'gone'),
            iterationOf(V3, 'active'),
        ]);
        expect(stale).toMatchObject({ newIterations: 1, prDiffId: V3.diffId });
    });

    it('a snapshot on an overwritten iteration is still stale', () => {
        const stale = staleFor(snapshotOn(V2), [
            iterationOf(V1, 'previous'),
            iterationOf(V2, 'gone'),
            iterationOf(V3, 'active'),
        ]);
        expect(stale).toMatchObject({ newIterations: 1, routeCommit: V2.headCommit });
    });

    it('an unlisted snapshot iteration counts from the start of history, with a minimum of one', () => {
        const stale = staleFor(snapshotOn(V1), [iterationOf(V3, 'active')]);
        expect(stale).toMatchObject({ newIterations: 1, prDiffId: V3.diffId });
    });
});

describe('iteration feed', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let store: IterationStore;
    let feed: IterationFeed;
    let snapshot: RouteSnapshot | null;
    let routeListeners: Set<RouteListener>;
    let routeRevision: number;
    let revisions: number[];
    let logs: string[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'feed.db'));
        store = new IterationStore({ db });
        snapshot = null;
        routeListeners = new Set();
        routeRevision = 0;
        revisions = [];
        logs = [];
    });

    afterEach(async () => {
        feed.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    /** Feed over the fixture host. The route snapshot is replaced directly in the test. */
    function makeFeed(
        host = makeFixtureHost('medium'),
        notes: NoteCarrier | null = null,
        progress: ProgressStore | null = null,
        carryRetryMs = 5,
    ): { host: ReturnType<typeof makeFixtureHost> } {
        feed = new IterationFeed({
            host,
            notes,
            progress,
            carryRetryMs,
            iterations: store,
            route: {
                current: () => snapshot,
                subscribe: (listener) => {
                    routeListeners.add(listener);
                    return () => {
                        routeListeners.delete(listener);
                    };
                },
            },
            log: (message) => logs.push(message),
        });
        return { host };
    }

    /** Changes the route snapshot and notifies the feed, just as `RouteStore` does. */
    function setSnapshot(next: RouteSnapshot): void {
        snapshot = next;
        routeRevision += 1;
        for (const listener of [...routeListeners]) {
            listener(routeRevision);
        }
    }

    function listen(): () => void {
        return feed.subscribe((revision) => revisions.push(revision));
    }

    it('the list is empty before subscription and arrives from the host afterwards', () => {
        makeFeed();
        expect(feed.iterations()).toEqual([]);
        expect(feed.active()).toBeNull();

        listen();

        expect(feed.iterations().map((iteration) => iteration.diffId)).toEqual([V1.diffId]);
        expect(feed.active()?.diffId).toBe(V1.diffId);
        expect(revisions).toEqual([1]);
    });

    it('the active iteration patch is stored', async () => {
        makeFeed();
        listen();

        await waitFor(() => store.get(V1.diffId) !== null);
        expect(store.get(V1.diffId)?.diff.headCommit).toBe(V1.headCommit);
    });

    it('a different iteration patch is neither stored nor returned to the caller', async () => {
        const host = makeFixtureHost('medium');
        // The author pushed while the v1 patch was loading, so the host now returns the v2 patch.
        host.getDiff = (slice) =>
            slice === undefined
                ? Promise.resolve(fixtureIteration('medium', 1).diff)
                : makeFixtureHost('medium').getDiff(slice);
        makeFeed(host);
        listen();

        await waitFor(() => logs.length > 0);
        expect(logs.some((message) => message.includes(V2.diffId))).toBe(true);
        expect(store.get(V1.diffId)).toBeNull();
        expect(store.get(V2.diffId)).toBeNull();
    });

    it('a push makes the snapshot stale and affected stops arrive in a second notification', async () => {
        const { host } = makeFeed();
        snapshot = snapshotOn(V1);
        listen();
        expect(feed.staleFor(snapshot)).toBeNull();

        host.advanceIteration();

        expect(feed.active()?.diffId).toBe(V2.diffId);
        // Publish the iteration list immediately: the banner cannot wait for the host interdiff (2.8–3.7 s).
        expect(feed.staleFor(snapshot)).toEqual({
            routeCommit: V1.headCommit,
            prCommit: V2.headCommit,
            prDiffId: V2.diffId,
            newIterations: 1,
            affectedStopIds: [],
        });
        const beforeInterdiff = revisions.length;

        await waitFor(() => (feed.staleFor(snapshot)?.affectedStopIds.length ?? 0) > 0);

        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual(['s02', 's03', 's06']);
        expect(revisions.length).toBeGreaterThan(beforeInterdiff);
    });

    it('accepting a section adds snapshot anchors and recalculates affected stops', async () => {
        const { host } = makeFeed();
        // A push arrived during generation. The skeleton is already accepted, but stops have no anchors yet.
        const bare = { ...snapshotOn(V1), stops: mediumReadySnapshot().stops.map((stop) => ({ ...stop, anchors: [] })) };
        setSnapshot(bare);
        listen();
        host.advanceIteration();

        // The first calculation correctly returns an empty list because there is nothing to compare the interdiff against.
        await waitFor(() => revisions.length >= 3);
        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual([]);

        setSnapshot(snapshotOn(V1));

        await waitFor(() => (feed.staleFor(snapshot)?.affectedStopIds.length ?? 0) > 0);
        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual(['s02', 's03', 's06']);
    });

    it('after a force-push, the overwritten iteration becomes gone and the previous snapshot becomes stale', async () => {
        const { host } = makeFeed();
        snapshot = snapshotOn(V1);
        listen();
        host.advanceIteration();
        await waitFor(() => store.get(V2.diffId) !== null);

        host.advanceIteration();

        expect(feed.iterations().map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [V1.diffId, 'previous'],
            [V2.diffId, 'gone'],
            [V3.diffId, 'active'],
        ]);
        expect(feed.staleFor(snapshot)).toMatchObject({ newIterations: 1, prDiffId: V3.diffId });
    });

    it('a host without slices leaves the banner without stops and logs once', async () => {
        const host = makeFixtureHost('medium');
        host.getDiff = (slice) =>
            slice === undefined
                ? makeFixtureHost('medium').getDiff()
                : Promise.reject(new Error('slices are unavailable for this host'));
        makeFeed(host);
        snapshot = snapshotOn(V1);
        listen();
        host.advanceIteration();

        await waitFor(() => logs.length > 0);
        host.advanceIteration();
        await waitFor(() => feed.active()?.diffId === V3.diffId);

        expect(feed.staleFor(snapshot)?.affectedStopIds).toEqual([]);
        expect(logs.filter((message) => message.includes('affected stops'))).toHaveLength(1);
    });

    /**
     * Fixture notes in the same DB. The returned carrier is the same store, but records carryover
     * pairs so the test can check that the feed calls migration once and with the right pair.
     */
    function makeNotes(seed: readonly AgentNote[]): { chat: ChatStore; carrier: NoteCarrier; calls: string[] } {
        const chat = new ChatStore({ db });
        seedAgentNotes(db, seed);
        const calls: string[] = [];
        const carrier: NoteCarrier = {
            adoptLegacyAnchors: (diffId) => chat.adoptLegacyAnchors(diffId),
            read: () => chat.read(),
            migrateNotes: (from, to, map, fileIdOf, headCommit) => {
                calls.push(`${from} ${to}`);
                return chat.migrateNotes(from, to, map, fileIdOf, headCommit);
            },
        };
        return { chat, carrier, calls };
    }

    it('a push carries note anchors to the active iteration once and with the same pair', async () => {
        const notes = makeNotes(NOTES);
        const { host } = makeFeed(makeFixtureHost('medium'), notes.carrier);
        listen();
        // There is nothing to carry over on its own iteration because there is no `from → to` pair yet.
        expect(notes.calls).toEqual([]);

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH);
        expect(notes.calls).toEqual([`${V1.diffId} ${V2.diffId}`]);
    });

    it('the host receives one slice request per pair, shared by stops and anchors', async () => {
        const host = makeFixtureHost('medium');
        const slices: string[] = [];
        const original = host.getDiff.bind(host);
        host.getDiff = async (slice) => {
            if (slice === undefined) {
                return original(slice);
            }
            slices.push(`${slice.base} ${slice.head}`);
            // A slice from the review host takes seconds. Without a delay, the 2 consumers do not overlap.
            await new Promise((resolve) => setTimeout(resolve, 20));
            return original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        // The route snapshot is on the same iteration as the notes, so they share a slice pair.
        snapshot = snapshotOn(V1);
        listen();

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        await waitFor(() => (feed.staleFor(snapshot)?.affectedStopIds.length ?? 0) > 0);
        expect(slices).toEqual([`${V1.diffId} ${V2.diffId}`]);
    });

    it('a host slice failure does not lose anchors and carryover is retried', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let refusals = 0;
        host.getDiff = (slice) => {
            if (slice !== undefined && refusals < 1) {
                refusals += 1;
                return Promise.reject(new Error('slice unavailable: network'));
            }
            return original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        listen();

        host.advanceIteration();

        // There will be no new push. The timer retry carries the anchors over, without waiting for the next list.
        await waitFor(() => logs.some((message) => message.includes('note anchors')));
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH);
    });

    it('a host without slices cannot carry notes over, so notes from the previous iteration lose their anchors', async () => {
        const host = makeFixtureHost('medium');
        const pr = await host.getPr();
        host.getPr = () => Promise.resolve({ ...pr, capabilities: { ...pr.capabilities, iterations: false } });
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        listen();

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.every((note) => note.lostAnchor));
        // The anchor keeps its last valid value. The note leaves the code but remembers its location.
        expect(notes.chat.read().notes.map((note) => note.anchor)).toEqual(NOTES.map((note) => note.anchor));
    });

    /** Reading progress in the same DB. Completed carryovers are visible in `progress_carries`. */
    function makeProgress(): ProgressStore {
        return new ProgressStore({ db, iterations: store, log: (message) => logs.push(message) });
    }

    /** A viewed file range, as the reader would record it. */
    function seedSeenRange(diffId: string, fileId: string): void {
        db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line)
             VALUES (?, ?, 'new', 1, 2)`,
        ).run(diffId, fileId);
    }

    /** Source → target pairs with completed progress carryover. */
    function progressCarries(): string[] {
        const rows = db
            .prepare('SELECT from_diff_id, to_diff_id FROM progress_carries ORDER BY rowid')
            .all() as { from_diff_id: string; to_diff_id: string }[];
        return rows.map((row) => `${row.from_diff_id} ${row.to_diff_id}`);
    }

    /** `fileId` of the first file in a fixture iteration. Progress is matched by its path. */
    function fixtureFileId(index: number): string {
        const fileId = fixtureIteration('medium', index).diff.files[0]?.fileId;
        if (fileId === undefined) {
            throw new Error(`iteration ${String(index + 1)} of the medium fixture has no files`);
        }
        return fileId;
    }

    it('a source removed by force-push is permanently rejected, notes lose anchors and no retry runs', async () => {
        const notes = makeNotes(NOTES);
        const { host } = makeFeed(makeFixtureHost('medium'), notes.carrier);
        listen();
        host.advanceIteration();
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));

        // Force-push removes v2 from the host list, so the host will never compute the v2→v3 slice again.
        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.every((note) => note.lostAnchor));
        // The anchor and origin keep their last valid values, so the note remembers its location in v2.
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH.map((note) => ({ ...note, lostAnchor: true })));
        expect(notes.calls.filter((call) => call === `${V2.diffId} ${V3.diffId}`)).toHaveLength(1);
        expect(
            logs.some((message) => message.includes(`host permanently refused slice ${V2.diffId}→${V3.diffId}`)),
        ).toBe(true);

        const calls = [...notes.calls];
        await new Promise((resolve) => setTimeout(resolve, 40));

        // No retry timer is set after a permanent refusal because there is nothing to retry.
        expect(notes.calls).toEqual(calls);
        expect(logs.some((message) => message.includes('will retry'))).toBe(false);
    });

    it('a temporary progress slice failure retries without falling back to an older source', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let refusals = 0;
        host.getDiff = (slice) => {
            if (slice !== undefined && refusals < 1) {
                refusals += 1;
                return Promise.reject(new Error('slice unavailable: network'));
            }
            return original(slice);
        };
        makeFeed(host, null, makeProgress());
        listen();

        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));
        // An older iteration also has progress. A network failure is no reason to fall back to it.
        const older = iterationOf(
            { ...V1, diffId: 'iter-older', createdAt: '2000-01-01T00:00:00.000Z' },
            'previous',
        );
        store.upsert({ ...fixtureIteration('medium', 0).diff, diffId: older.diffId }, older);
        seedSeenRange(older.diffId, fixtureFileId(0));

        host.advanceIteration();

        await waitFor(() => progressCarries().length > 0);
        expect(progressCarries()).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(logs.some((message) => message.includes(`could not fetch slice ${V1.diffId}→${V2.diffId}, will retry`))).toBe(
            true,
        );
        expect(logs.some((message) => message.includes(older.diffId))).toBe(false);
    });

    it('a retry restarts both note anchor and progress carryover', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let refusals = 0;
        host.getDiff = (slice) => {
            if (slice !== undefined && refusals < 2) {
                refusals += 1;
                return Promise.reject(new Error('slice unavailable: network'));
            }
            return original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier, makeProgress());
        listen();
        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));

        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));
        await waitFor(() => progressCarries().length > 0);
        expect(notes.chat.read().notes).toEqual(NOTES_AFTER_PUSH);
        expect(progressCarries()).toEqual([`${V1.diffId} ${V2.diffId}`]);
        expect(logs.some((message) => message.includes('note anchors from iteration') && message.includes('will retry'))).toBe(
            true,
        );
        expect(logs.some((message) => message.includes(', will retry'))).toBe(true);
    });

    it('an active iteration patch failure does not lose anchors even if a force-push removed the source', async () => {
        const host = makeFixtureHost('medium');
        const original = host.getDiff.bind(host);
        let activeDown = false;
        host.getDiff = (slice) => {
            if (slice === undefined) {
                return activeDown ? Promise.reject(new Error('host is down')) : original(slice);
            }
            // The fixture cannot compute a slice with v2 (the iteration is absent from the list), so replace the response
            // to let carryover reach the active iteration patch. That is the request that must fail.
            return slice.base === V2.diffId
                ? Promise.resolve(fixtureIteration('medium', 2).diff)
                : original(slice);
        };
        const notes = makeNotes(NOTES);
        makeFeed(host, notes.carrier);
        listen();
        host.advanceIteration();
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));

        const before = notes.chat.read().notes;

        activeDown = true;
        host.advanceIteration();

        await waitFor(() =>
            logs.some((message) => message.includes('note anchors from iteration') && message.includes('will retry')),
        );
        // The active patch failed, not the slice. This says nothing about the source, so anchors remain intact.
        expect(notes.chat.read().notes).toEqual(before);
        expect(logs.some((message) => message.includes('host permanently rejected'))).toBe(false);
    });

    it('a write failure after permanent refusal does not silently discard the source, a retry reaches lost_anchor', async () => {
        const notes = makeNotes(NOTES);
        const attempts: string[] = [];
        let failWrite = false;
        const carrier: NoteCarrier = {
            adoptLegacyAnchors: (diffId) => notes.carrier.adoptLegacyAnchors(diffId),
            read: () => notes.carrier.read(),
            migrateNotes: (from, to, map, fileIdOf, headCommit) => {
                attempts.push(`${from} ${to}`);
                if (failWrite) {
                    failWrite = false;
                    throw new Error('DB is busy');
                }
                return notes.carrier.migrateNotes(from, to, map, fileIdOf, headCommit);
            },
        };
        const { host } = makeFeed(makeFixtureHost('medium'), carrier);
        listen();
        host.advanceIteration();
        await waitFor(() => notes.chat.read().notes.some((note) => note.anchor.diffId === V2.diffId));

        failWrite = true;
        host.advanceIteration();

        await waitFor(() => notes.chat.read().notes.every((note) => note.lostAnchor));
        expect(logs.some((message) => message.includes('note anchors from iteration') && message.includes('will retry'))).toBe(
            true,
        );
        // The source is marked as refused only after a successful write. A DB failure allows a second attempt.
        expect(attempts.filter((call) => call === `${V2.diffId} ${V3.diffId}`)).toHaveLength(2);
    });

    it('a host without slices does not retry progress carryover forever', async () => {
        const host = makeFixtureHost('medium');
        const pr = await host.getPr();
        host.getPr = () => Promise.resolve({ ...pr, capabilities: { ...pr.capabilities, iterations: false } });
        const slices: string[] = [];
        const original = host.getDiff.bind(host);
        host.getDiff = (slice) => {
            if (slice !== undefined) {
                slices.push(`${slice.base} ${slice.head}`);
            }
            return original(slice);
        };
        makeFeed(host, null, makeProgress());
        listen();
        await waitFor(() => store.get(V1.diffId) !== null);
        seedSeenRange(V1.diffId, fixtureFileId(0));

        host.advanceIteration();

        await waitFor(() => logs.some((message) => message.includes('host has no slices')));
        // Retrying every 5 ms would produce dozens of requests. A host without slices is a permanent refusal.
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(slices).toEqual([]);
        expect(logs.filter((message) => message.includes('progress not carried over'))).toHaveLength(1);
        expect(progressCarries()).toEqual([]);
    });

    it('the last listener leaving stops the host subscription', () => {
        const { host } = makeFeed();
        const release = listen();
        const before = revisions.length;

        release();
        host.advanceIteration();

        expect(revisions).toHaveLength(before);
    });
});
