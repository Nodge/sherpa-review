import path from 'node:path';

import type { FileDiff, PrDiff, RouteAnchor } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { StoredIteration } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, identityMap } from './iterations/index.js';
import { ProgressStore } from './progress-store.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Reading progress (T8) by iteration (M4-T6): persists explicit marks, carries ranges
 * and file marks over to a new iteration, marks stops in a new snapshot.
 */

const V1 = 'iter-1';
const V2 = 'iter-2';
const BASE = 'base-a1b2c3';
const CLOCK = 'services/orders/src/infra/clock.ts';
const ORDER = 'services/orders/src/domain/order.ts';
const HEADERS = ['--- a/x.ts', '+++ b/x.ts'];

/** Changes to lines 12–13 of `CLOCK` in the interdiff: one deleted, two added (delta +1). */
const CLOCK_PATCH = [
    ...HEADERS,
    '@@ -10,6 +10,7 @@',
    ' ctx10',
    ' ctx11',
    '-del12',
    '+add12',
    '+add13',
    ' ctx13',
    ' ctx14',
    ' ctx15',
].join('\n');

/** Iteration patch: lines 1–5 added, which the reviewer marks as viewed in tests. */
const ADDED_LINES = [...HEADERS, '@@ -1,0 +1,5 @@', '+one', '+two', '+three', '+four', '+five'].join('\n');

describe('reading progress store', () => {
    let sherpaDir: string;
    let file: string;
    const opened: SherpaDatabase[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        file = path.join(sherpaDir, 'progress.db');
    });

    afterEach(async () => {
        for (const db of opened.splice(0)) {
            db.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    function open(): SherpaDatabase {
        const db = openDatabase(file);
        opened.push(db);
        return db;
    }

    function insertRange(db: SherpaDatabase, diffId: string, fileId: string, start: number, end: number): void {
        db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line)
             VALUES (?, ?, 'new', ?, ?)`,
        ).run(diffId, fileId, start, end);
    }

    /** This iteration's route snapshot: its anchors map paths for carryover without a patch. */
    function insertSnapshot(
        db: SherpaDatabase,
        diffId: string,
        anchors: readonly { fileId: string; path: string }[],
        createdAt = '2026-09-01T10:00:00.000Z',
    ): void {
        const snapshot = {
            snapshotId: `snap-${diffId}`,
            diffId,
            createdAt,
            stops: [{ id: 's01', anchors: anchors.map((a) => ({ ...a, side: 'new', start: 1, end: 5 })) }],
        };
        db.prepare(
            `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, snapshot_json)
             VALUES (?, ?, ?, ?)`,
        ).run(snapshot.snapshotId, diffId, createdAt, JSON.stringify(snapshot));
    }

    /**
     * A chat note with an anchor: `anchor` is its current location, `origin` is where it was created.
     * Note carryover rewrites the former and leaves the latter alone.
     */
    function insertNote(
        db: SherpaDatabase,
        anchor: { diffId: string; fileId: string; path: string },
        origin: { diffId: string; fileId: string; path: string } = anchor,
    ): void {
        const at = '2026-09-01T10:00:00.000Z';
        const exchange = db
            .prepare(
                `INSERT INTO chat_exchanges (question, anchor, status, answer, created_at, updated_at)
                 VALUES ('question', ?, 'done', 'answer', ?, ?)`,
            )
            .run(JSON.stringify(origin), at, at);
        db.prepare(
            `INSERT INTO agent_notes (
                exchange_id, anchor, text, commit_hash, lost_anchor, origin_anchor, origin_commit, created_at
             ) VALUES (?, ?, 'answer', NULL, 0, ?, NULL, ?)`,
        ).run(exchange.lastInsertRowid, JSON.stringify(anchor), JSON.stringify(origin), at);
    }

    /** Paths recorded on iteration ranges. NULL becomes an empty string. */
    function pathsOfRanges(db: SherpaDatabase, diffId: string): string[] {
        const rows = db
            .prepare('SELECT path FROM file_seen_ranges WHERE diff_id = ? ORDER BY rowid')
            .all(diffId) as { path: string | null }[];
        return rows.map((row) => row.path ?? '');
    }

    it('starts with no records and revision zero', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.read(V1)).toEqual([]);
        expect(store.revision).toBe(0);
    });

    it('writes and clears a mark and preserves it across database reopen', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-2', false);

        expect(store.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [] },
            { fileId: 'file-2', viewed: false, seenRanges: [] },
        ]);

        // A new server process: the revision starts over, while records remain.
        const restarted = new ProgressStore({ db: open() });
        expect(restarted.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [] },
            { fileId: 'file-2', viewed: false, seenRanges: [] },
        ]);
        expect(restarted.revision).toBe(0);
    });

    it('keeps progress from one iteration invisible to another', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed(V1, 'file-1', true);
        insertRange(open(), V1, 'file-9', 1, 2);

        expect(store.read(V2)).toEqual([]);
        expect(store.read(V1)).toHaveLength(2);
    });

    it('overwrites the value when marking again instead of adding rows', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-1', false);

        expect(store.read(V1)).toEqual([{ fileId: 'file-1', viewed: false, seenRanges: [] }]);
    });

    it('increments the revision on each change and leaves it unchanged on an idempotent write', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.setFileViewed(V1, 'file-1', true)).toBe(1);
        expect(store.setFileViewed(V1, 'file-1', false)).toBe(2);
        // Nothing changed, so there is nothing to notify other tabs about.
        expect(store.setFileViewed(V1, 'file-1', false)).toBe(2);
        expect(store.revision).toBe(2);
    });

    it('notifies a subscriber of the new revision and supports unsubscribe', () => {
        const store = new ProgressStore({ db: open() });
        const seen: number[] = [];
        const stop = store.subscribe((revision) => {
            seen.push(revision);
        });

        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-1', true);
        store.setFileViewed(V1, 'file-2', true);
        stop();
        store.setFileViewed(V1, 'file-3', true);

        expect(seen).toEqual([1, 2]);
    });

    it('reads seen ranges with marks and leaves a file with only ranges unpinned', () => {
        const db = open();
        insertRange(db, V1, 'file-1', 10, 20);
        db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line)
             VALUES (?, ?, 'old', ?, ?)`,
        ).run(V1, 'file-2', 1, 3);
        const store = new ProgressStore({ db });
        store.setFileViewed(V1, 'file-1', true);

        expect(store.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [{ side: 'new', start: 10, end: 20 }] },
            { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'old', start: 1, end: 3 }] },
        ]);
    });

    it('stores a stop mark with its ranges and preserves it across database reopen', () => {
        const store = new ProgressStore({ db: open() });

        expect(
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
                { fileId: 'file-2', side: 'old', start: 3, end: 3 },
            ]),
        ).toBe(1);

        const restarted = new ProgressStore({ db: open() });
        expect(restarted.readStops('snap-1')).toEqual([{ stopId: 's01', viewed: true }]);
        // Marks for another snapshot belong to another route.
        expect(restarted.readStops('snap-2')).toEqual([]);
        expect(restarted.read(V1)).toEqual([
            { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 10, end: 14 }] },
            { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'old', start: 3, end: 3 }] },
        ]);
    });

    it('keeps the revision unchanged when marking the same set of ranges again', () => {
        const store = new ProgressStore({ db: open() });
        const ranges = [
            { fileId: 'file-1', side: 'new' as const, start: 10, end: 14 },
            { fileId: 'file-1', side: 'old' as const, start: 2, end: 4 },
        ];

        expect(store.setStopViewed('snap-1', V1, 's01', true, ranges)).toBe(1);
        // Order and duplicates in the request do not change the store.
        expect(store.setStopViewed('snap-1', V1, 's01', true, [...ranges].reverse())).toBe(1);
        expect(store.setStopViewed('snap-1', V1, 's01', true, [...ranges, ...ranges])).toBe(1);
        // A different set does change it.
        expect(store.setStopViewed('snap-1', V1, 's01', true, ranges.slice(0, 1))).toBe(2);
    });

    it('clears a mark by deleting only that stop\'s ranges', () => {
        const store = new ProgressStore({ db: open() });
        store.setStopViewed('snap-1', V1, 's01', true, [{ fileId: 'file-1', side: 'new', start: 10, end: 14 }]);
        store.setStopViewed('snap-1', V1, 's02', true, [{ fileId: 'file-1', side: 'new', start: 40, end: 41 }]);
        store.setFileViewed(V1, 'file-1', true, 'snap-1');

        store.setStopViewed('snap-1', V1, 's01', false, []);

        expect(store.readStops('snap-1')).toEqual([
            { stopId: 's01', viewed: false },
            { stopId: 's02', viewed: true },
        ]);
        // The manual file mark and neighbouring stop ranges remain.
        expect(store.read(V1)).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [{ side: 'new', start: 40, end: 41 }] },
        ]);
    });

    it('clears affected stops and all their ranges in one revision when clearing a file', () => {
        const store = new ProgressStore({ db: open() });
        store.setStopViewed('snap-1', V1, 's01', true, [
            { fileId: 'file-1', side: 'new', start: 10, end: 14 },
            { fileId: 'file-2', side: 'old', start: 3, end: 5 },
        ]);
        store.setStopViewed('snap-1', V1, 's02', true, [
            { fileId: 'file-1', side: 'old', start: 20, end: 21 },
            { fileId: 'file-3', side: 'new', start: 7, end: 9 },
        ]);
        const before = store.revision;

        expect(store.setFileViewed(V1, 'file-1', false, 'snap-1')).toBe(before + 1);
        expect(store.readStops('snap-1')).toEqual([
            { stopId: 's01', viewed: false },
            { stopId: 's02', viewed: false },
        ]);
        expect(store.read(V1)).toEqual([{ fileId: 'file-1', viewed: false, seenRanges: [] }]);
        // Repeating changes nothing: no linking ranges remain and the file flag is unchanged.
        expect(store.setFileViewed(V1, 'file-1', false, 'snap-1')).toBe(before + 1);
    });

    it('also deletes carried ranges with no source stop when clearing a file', () => {
        const db = open();
        insertRange(db, V1, 'file-1', 10, 14);
        const store = new ProgressStore({ db });

        expect(store.setFileViewed(V1, 'file-1', false, 'snap-1')).toBe(1);

        expect(store.read(V1)).toEqual([{ fileId: 'file-1', viewed: false, seenRanges: [] }]);
    });

    it('clears a file with no linked stops using the previous file-write behaviour', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.setFileViewed(V1, 'standalone', false, 'snap-1')).toBe(1);
        expect(store.readStops('snap-1')).toEqual([]);
        expect(store.read(V1)).toEqual([{ fileId: 'standalone', viewed: false, seenRanges: [] }]);
        expect(store.setFileViewed(V1, 'standalone', false, 'snap-1')).toBe(1);
    });

    it('does not notify subscribers after close', () => {
        const store = new ProgressStore({ db: open() });
        let calls = 0;
        store.subscribe(() => {
            calls += 1;
        });

        store.close();
        store.setFileViewed(V1, 'file-1', true);

        expect(calls).toBe(0);
    });

    describe('carrying ranges over to a new iteration', () => {
        /** A range marked in v1 as seen by v2 after carryover. */
        function carried(
            store: ProgressStore,
            map: IterationMap,
            marked: { start: number; end: number; side?: 'old' | 'new' },
        ): { side: string; start: number; end: number }[] {
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: marked.side ?? 'new', start: marked.start, end: marked.end },
            ]);
            store.carryRanges(V1, V2, map);
            return store.read(V2).flatMap((progress) => progress.seenRanges);
        }

        it('carries a range entirely before the edit over unchanged', () => {
            const store = storeWith(open(), twoIterations());

            expect(carried(store, clockMap(), { start: 1, end: 5 })).toEqual([
                { side: 'new', start: 1, end: 5 },
            ]);
        });

        it('carries a range after the edit over with an offset', () => {
            const store = storeWith(open(), twoIterations());

            expect(carried(store, clockMap(), { start: 20, end: 25 })).toEqual([
                { side: 'new', start: 21, end: 26 },
            ]);
        });

        it('carries only the untouched part of a range overlapping an edit', () => {
            const store = storeWith(open(), twoIterations());

            expect(carried(store, clockMap(), { start: 5, end: 15 })).toEqual([
                { side: 'new', start: 5, end: 11 },
                { side: 'new', start: 14, end: 16 },
            ]);
        });

        it('carries nothing over for a file absent from the new iteration', () => {
            const store = storeWith(
                open(),
                iterations({
                    [V1]: diffOf(V1, [CLOCK, ORDER]),
                    [V2]: diffOf(V2, [ORDER]),
                }),
            );

            expect(carried(store, identityMap(), { start: 1, end: 5 })).toEqual([]);
        });

        it('counts an author-deleted file separately from a path resolver failure', () => {
            const db = open();
            const logs: string[] = [];
            const store = storeWith(
                db,
                iterations({ [V1]: diffOf(V1, [CLOCK]), [V2]: diffOf(V2, [ORDER]) }),
                (message) => logs.push(message),
            );
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            // The source patch provides the path, but the file is absent from the new iteration: "no path"
            // means a failed mapping, not an author edit.
            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 0,
                sourceRanges: 1,
                unmappedRanges: 0,
                missingRanges: 1,
                touchedRanges: 0,
            });
            expect(logs).toContain(
                `progress carryover ${V1} → ${V2}: carried 0 ranges out of 1 ` +
                    '(no path: 0, absent from new iteration: 1, touched by interdiff: 0)',
            );
        });

        it('reads a note anchor from origin_anchor after carryover has moved it to the target', () => {
            const db = open();
            const store = storeWith(db, iterations({ [V2]: diffOf(V2, [CLOCK]) }));
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            // Note carryover runs alongside progress carryover and finished first: `anchor`
            // already points to the target, and the path for the source `fileId` remains only in `origin_anchor`.
            insertNote(
                db,
                { diffId: V2, fileId: fileIdOf(V2, CLOCK), path: CLOCK },
                { diffId: V1, fileId: fileIdOf(V1, CLOCK), path: CLOCK },
            );

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 1,
                unmappedRanges: 0,
            });
        });

        it('does not inherit progress for a renamed file', () => {
            const store = storeWith(
                open(),
                iterations({
                    [V1]: diffOf(V1, [CLOCK]),
                    [V2]: diffOf(V2, ['services/orders/src/infra/time.ts']),
                }),
            );
            const map = buildIterationMap({
                interdiff: interdiffOf([
                    fileDiff({
                        path: 'services/orders/src/infra/time.ts',
                        oldPath: CLOCK,
                        changeType: 'move',
                    }),
                ]),
                fromBaseCommit: BASE,
                toBaseCommit: BASE,
            });

            expect(carried(store, map, { start: 1, end: 5 })).toEqual([]);
        });

        it('carries over the new side but not the old side when the base changes', () => {
            const db = open();
            const store = storeWith(db, twoIterations());
            const map = buildIterationMap({ interdiff: null, fromBaseCommit: BASE, toBaseCommit: 'base-other' });
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'old', start: 1, end: 3 },
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 3 },
            ]);

            store.carryRanges(V1, V2, map);

            expect(store.read(V2).flatMap((progress) => progress.seenRanges)).toEqual([
                { side: 'new', start: 1, end: 3 },
            ]);
        });

        it('carries file pins over only for unchanged files and always carries unpinning over', () => {
            const store = storeWith(open(), twoIterations());
            store.setFileViewed(V1, fileIdOf(V1, CLOCK), true);
            store.setFileViewed(V1, fileIdOf(V1, ORDER), true);

            store.carryRanges(V1, V2, clockMap());

            // The interdiff touches `CLOCK`, so its pin is lost. `ORDER` is untouched.
            expect(store.read(V2)).toEqual([{ fileId: fileIdOf(V2, ORDER), viewed: true, seenRanges: [] }]);

            store.setFileViewed(V1, fileIdOf(V1, CLOCK), false);
            store.carryRanges(V1, 'iter-3', clockMap());
            expect(store.read('iter-3')).toContainEqual({
                fileId: fileIdOf('iter-3', CLOCK),
                viewed: false,
                seenRanges: [],
            });
        });

        it('does not restore a reviewer-cleared mark when repeating carryover for a pair', () => {
            const store = storeWith(open(), twoIterations());
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            const first = store.carryRanges(V1, V2, identityMap());
            expect(first).toMatchObject({ ranges: 1, skipped: false });

            // The reviewer cleared the mark in the new iteration.
            store.setFileViewed(V2, fileIdOf(V2, CLOCK), false, 'snap-2');
            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({ ranges: 0, files: 0, skipped: true });
            expect(store.read(V2)).toEqual([{ fileId: fileIdOf(V2, CLOCK), viewed: false, seenRanges: [] }]);
        });

        it('skips carryover without the stored target iteration patch and retries it', () => {
            const store = storeWith(open(), iterations({ [V1]: diffOf(V1, [CLOCK]) }));
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({ ranges: 0, files: 0, skipped: true });

            // The patch has arrived, so the same call carries progress over.
            const ready = storeWith(open(), twoIterations());
            expect(ready.carryRanges(V1, V2, identityMap())).toMatchObject({ ranges: 1, skipped: false });
        });

        it('gets source file paths from snapshot anchors when the source patch is missing', () => {
            const db = open();
            // Exact shape of the M5-T20 finding: server 0.3.x recorded progress, with no iteration row,
            // its patch is missing for good, so only the route snapshot knows the path for `fileId`.
            const store = storeWith(db, iterations({ [V2]: diffOf(V2, [CLOCK]) }));
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            insertSnapshot(db, V1, [{ fileId: fileIdOf(V1, CLOCK), path: CLOCK }]);

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 1,
                sourceRanges: 1,
                unmappedRanges: 0,
                skipped: false,
            });
            expect(store.read(V2)).toEqual([
                { fileId: fileIdOf(V2, CLOCK), viewed: null, seenRanges: [{ side: 'new', start: 1, end: 5 }] },
            ]);
        });

        it('counts a range on a file without an anchor as unmapped and carries the rest over', () => {
            const db = open();
            const store = storeWith(db, iterations({ [V2]: diffOf(V2, [CLOCK, ORDER]) }));
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            insertRange(db, V1, fileIdOf(V1, ORDER), 1, 5);
            insertSnapshot(db, V1, [{ fileId: fileIdOf(V1, CLOCK), path: CLOCK }]);

            expect(store.carryRanges(V1, V2, identityMap())).toMatchObject({
                ranges: 1,
                sourceRanges: 2,
                unmappedRanges: 1,
            });
            expect(store.read(V2).map((progress) => progress.fileId)).toEqual([fileIdOf(V2, CLOCK)]);
        });

        it('records paths on carried rows and uses them for the next carryover', () => {
            const db = open();
            const store = storeWith(db, twoIterations());
            store.setStopViewed('snap-1', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);
            store.carryRanges(V1, V2, identityMap());

            expect(pathsOfRanges(db, V2)).toEqual([CLOCK]);

            // The next server has neither the V2 patch nor its anchors: the record itself holds the path.
            const next = storeWith(db, iterations({ 'iter-3': diffOf('iter-3', [CLOCK]) }));
            expect(next.carryRanges(V2, 'iter-3', identityMap())).toMatchObject({
                ranges: 1,
                unmappedRanges: 0,
            });
            expect(pathsOfRanges(db, 'iter-3')).toEqual([CLOCK]);
        });
    });

    describe('adopting legacy progress', () => {
        it('moves records without an iteration to the active one, keeping its values on conflict', () => {
            const db = open();
            const store = new ProgressStore({ db });
            store.setFileViewed('unknown', 'file-1', true);
            store.setFileViewed('unknown', 'file-2', true);
            insertRange(db, 'unknown', 'file-1', 10, 14);
            insertRange(db, V1, 'file-1', 10, 14);
            store.setFileViewed(V1, 'file-1', false);

            store.adoptLegacy(V1);

            expect(store.read('unknown')).toEqual([]);
            expect(store.read(V1)).toEqual([
                // Adoption does not override a decision already made in the active iteration.
                { fileId: 'file-1', viewed: false, seenRanges: [{ side: 'new', start: 10, end: 14 }] },
                { fileId: 'file-2', viewed: true, seenRanges: [] },
            ]);
            // Repeating changes nothing.
            const revision = store.revision;
            store.adoptLegacy(V1);
            expect(store.revision).toBe(revision);
        });
    });

    describe('carryover source iteration', () => {
        it('uses the latest iteration with progress other than the active one', () => {
            const db = open();
            const store = new ProgressStore({ db });
            rememberIteration(db, V1, '2026-09-01T10:00:00.000Z');
            rememberIteration(db, V2, '2026-09-02T10:00:00.000Z');
            rememberIteration(db, 'iter-3', '2026-09-03T10:00:00.000Z');

            expect(store.latestDiffIdWithProgress('iter-3')).toBeNull();

            store.setFileViewed(V1, 'file-1', true);
            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V1);

            insertRange(db, V2, 'file-2', 1, 2);
            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V2);
            expect(store.latestDiffIdWithProgress(V2)).toBe(V1);
        });

        it('also accepts a force-pushed-away iteration and skips a rejected one for the next', () => {
            const db = open();
            const store = new ProgressStore({ db });
            rememberIteration(db, V1, '2026-09-01T10:00:00.000Z');
            rememberIteration(db, V2, '2026-09-02T10:00:00.000Z', 'gone');
            rememberIteration(db, 'iter-3', '2026-09-03T10:00:00.000Z');
            store.setFileViewed(V1, 'file-1', true);
            insertRange(db, V2, 'file-2', 1, 2);

            // The missing iteration has the latest progress: not every host can produce a slice against it,
            // but source selection does not decide that.
            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V2);
            expect(store.latestDiffIdWithProgress('iter-3', [V2])).toBe(V1);
            expect(store.latestDiffIdWithProgress('iter-3', [V1, V2])).toBeNull();
        });

        it('also accepts an iteration without a row in iterations', () => {
            const db = open();
            const store = new ProgressStore({ db });
            // Server 0.3.x progress: it never saved iterations, but the marks remain (M5-T20).
            insertRange(db, V1, 'file-1', 1, 2);

            expect(store.latestDiffIdWithProgress(V2)).toBe(V1);
        });

        it('orders iterations without rows in iterations by snapshot, then by file mark', () => {
            const db = open();
            const store = new ProgressStore({ db, now: () => new Date('2026-09-01T10:00:00.000Z') });
            insertRange(db, V1, 'file-1', 1, 2);
            insertSnapshot(db, V1, [], '2026-09-01T09:00:00.000Z');
            insertRange(db, V2, 'file-2', 1, 2);
            insertSnapshot(db, V2, [], '2026-09-02T09:00:00.000Z');

            expect(store.latestDiffIdWithProgress('iter-3')).toBe(V2);

            // The third iteration has no snapshot, so its file mark time sets its place in the order.
            const later = new ProgressStore({ db, now: () => new Date('2026-09-03T10:00:00.000Z') });
            later.setFileViewed('iter-3', 'file-3', true);
            expect(later.latestDiffIdWithProgress('iter-4')).toBe('iter-3');
        });

        it('never uses the legacy iteration as a source because adoptLegacy adopts it', () => {
            const db = open();
            const store = new ProgressStore({ db });
            insertRange(db, 'unknown', 'file-1', 1, 2);

            expect(store.latestDiffIdWithProgress(V1)).toBeNull();
        });
    });

    describe('whether an iteration has viewed marks', () => {
        it('counts ranges and file pins but not cleared pins', () => {
            const db = open();
            const store = new ProgressStore({ db });

            expect(store.hasViewedMarks(V1)).toBe(false);

            store.setFileViewed(V1, 'file-1', false);
            expect(store.hasViewedMarks(V1)).toBe(false);

            insertRange(db, V1, 'file-1', 1, 2);
            expect(store.hasViewedMarks(V1)).toBe(true);
            expect(store.hasViewedMarks(V2)).toBe(false);

            store.setFileViewed(V2, 'file-2', true);
            expect(store.hasViewedMarks(V2)).toBe(true);
        });
    });

    describe('carrying stop marks over to a new snapshot', () => {
        const anchors: RouteAnchor[] = [
            { fileId: fileIdOf(V1, CLOCK), path: CLOCK, side: 'new', start: 1, end: 5, collapsed: false },
        ];

        function diffWithAddedLines(): PrDiff {
            return interdiffOf([fileDiff({ path: CLOCK, patch: ADDED_LINES, fileId: fileIdOf(V1, CLOCK) })], V1);
        }

        it('marks a stop covered by ranges as viewed and assigns it its ranges', () => {
            const store = new ProgressStore({ db: open() });
            insertRange(open(), V1, fileIdOf(V1, CLOCK), 1, 5);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            });
            carried.afterCommit();

            expect(carried.kept).toBe(1);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
            // The range now belongs to the stop, with no duplicate.
            expect(store.read(V1)).toEqual([
                { fileId: fileIdOf(V1, CLOCK), viewed: null, seenRanges: [{ side: 'new', start: 1, end: 5 }] },
            ]);
        });

        it('does not carry a half-covered stop over or a stop without anchors', () => {
            const store = new ProgressStore({ db: open() });
            insertRange(open(), V1, fileIdOf(V1, CLOCK), 1, 3);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [
                    { id: 's01', anchors },
                    { id: 'other', anchors: [] },
                ],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(0);
            expect(store.readStops('snap-2')).toEqual([]);
        });

        it('lets a file pin cover the entire stop without overriding the reviewer\'s decision', () => {
            const db = open();
            const store = new ProgressStore({ db });
            store.setFileViewed(V1, fileIdOf(V1, CLOCK), true);
            store.setStopViewed('snap-2', V1, 's01', false, []);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [
                    { id: 's01', anchors },
                    { id: 's02', anchors },
                ],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(1);
            expect(store.readStops('snap-2')).toEqual([
                { stopId: 's01', viewed: false },
                { stopId: 's02', viewed: true },
            ]);
        });

        it('counts a tab\'s mark for the same ranges as carried without rewriting it', () => {
            const db = open();
            const store = new ProgressStore({ db });
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            // The tab marked the stop based on carried ranges before the snapshot was frozen.
            store.setStopViewed('snap-2', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(1);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('does not count a manually read stop as carried because its own mark does not count', () => {
            const store = new ProgressStore({ db: open() });
            // Nothing to carry over: the reviewer read the stop while the snapshot was being filled.
            store.setStopViewed('snap-2', V1, 's01', true, [
                { fileId: fileIdOf(V1, CLOCK), side: 'new', start: 1, end: 5 },
            ]);

            const carried = store.carryStopsInTransaction({
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            });

            expect(carried.kept).toBe(0);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('does not count carryover again when refreezing a snapshot after filling a stop', () => {
            const db = open();
            const store = new ProgressStore({ db });
            insertRange(db, V1, fileIdOf(V1, CLOCK), 1, 5);
            const input = {
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            };

            expect(store.carryStopsInTransaction(input).kept).toBe(1);
            expect(store.carryStopsInTransaction(input).kept).toBe(0);
            expect(store.readStops('snap-2')).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('does not double-count a stop covered by a file pin when refreezing', () => {
            const db = open();
            const store = new ProgressStore({ db });
            store.setFileViewed(V1, fileIdOf(V1, CLOCK), true);
            const input = {
                snapshotId: 'snap-2',
                diffId: V1,
                stops: [{ id: 's01', anchors }],
                diff: diffWithAddedLines(),
            };

            expect(store.carryStopsInTransaction(input).kept).toBe(1);
            expect(store.carryStopsInTransaction(input).kept).toBe(0);
        });
    });
});

/** Fixture `fileId` changes with each iteration. Only the path is stable. */
function fileIdOf(diffId: string, filePath: string): string {
    return `${diffId}:${filePath}`;
}

function fileDiff(overrides: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
    return {
        fileId: `file:${overrides.path}`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
        ...overrides,
    };
}

function interdiffOf(files: readonly FileDiff[], diffId = 'interdiff'): PrDiff {
    return { diffId, baseCommit: BASE, headCommit: 'head-b', files: [...files] };
}

/** Iteration patch: the same paths with distinct `fileId` values, as in the fixtures. */
function diffOf(diffId: string, paths: readonly string[]): PrDiff {
    return {
        diffId,
        baseCommit: BASE,
        headCommit: `head-${diffId}`,
        files: paths.map((filePath) => fileDiff({ path: filePath, fileId: fileIdOf(diffId, filePath) })),
    };
}

/** Iteration patch store as used by carryover: `get` is enough. */
function iterations(diffs: Record<string, PrDiff>): { get: (diffId: string) => StoredIteration | null } {
    return {
        get: (diffId) => {
            const diff = diffs[diffId];
            return diff === undefined
                ? null
                : {
                      diff,
                      iteration: {
                          diffId,
                          baseCommit: diff.baseCommit,
                          headCommit: diff.headCommit,
                          createdAt: '2026-09-02T10:00:00.000Z',
                          status: 'active',
                      },
                  };
        },
    };
}

function twoIterations(): { get: (diffId: string) => StoredIteration | null } {
    return iterations({
        [V1]: diffOf(V1, [CLOCK, ORDER]),
        [V2]: diffOf(V2, [CLOCK, ORDER]),
        'iter-3': diffOf('iter-3', [CLOCK, ORDER]),
    });
}

function storeWith(
    db: SherpaDatabase,
    store: { get: (diffId: string) => StoredIteration | null },
    log: (message: string) => void = () => undefined,
): ProgressStore {
    return new ProgressStore({ db, iterations: store, log });
}

/** A map whose interdiff edits lines 12–13 of `CLOCK`. */
function clockMap(): IterationMap {
    return buildIterationMap({
        interdiff: interdiffOf([fileDiff({ path: CLOCK, patch: CLOCK_PATCH })]),
        fromBaseCommit: BASE,
        toBaseCommit: BASE,
    });
}

/** Stored iteration row: `latestDiffIdWithProgress` gets its order from here. */
function rememberIteration(
    db: SherpaDatabase,
    diffId: string,
    createdAt: string,
    status: 'previous' | 'gone' = 'previous',
): void {
    db.prepare(
        `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?)`,
    ).run(diffId, BASE, `head-${diffId}`, createdAt, status, createdAt);
}
