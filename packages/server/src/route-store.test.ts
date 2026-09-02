import path from 'node:path';

import type { PrDiff, RouteStop } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { AcceptedSkeletonInput } from './route-store.js';
import { RouteStore } from './route-store.js';
import type { AcceptedSkeleton } from './route/index.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Route snapshot history (M4-T3): `route_snapshots` stores every generation, `route_state`
 * keeps only the current one. Also covers dogfooding database compatibility, a snapshot written before M4.
 */

function stop(planIndex: number): RouteStop {
    return {
        id: `stop-${String(planIndex)}`,
        planIndex,
        tier: 'high',
        title: `Stop ${String(planIndex)}`,
        status: 'queued',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

function skeleton(): AcceptedSkeleton {
    return {
        summary: 'PR about columns',
        stops: [stop(1)],
        tourOrder: ['stop-1'],
        intents: new Map([[1, 'check the count']]),
    };
}

function diffOf(diffId: string, headCommit: string): PrDiff {
    return { diffId, baseCommit: 'base-commit', headCommit, files: [] };
}

function accepted(snapshotId: string, previousSnapshotId: string | null, diffId: string): AcceptedSkeletonInput {
    return {
        skeleton: skeleton(),
        diff: diffOf(diffId, `head-${diffId}`),
        provenance: { harness: 'claude-code', model: 'opus' },
        snapshotId,
        previousSnapshotId,
    };
}

describe('route store: snapshot history', () => {
    let sherpaDir: string;
    let file: string;
    const opened: SherpaDatabase[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        file = path.join(sherpaDir, 'route.db');
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

    it('two generations create two snapshots, with the second current and previousSnapshotId stored', () => {
        const store = new RouteStore({ db: open() });

        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        store.markReady();
        store.acceptSkeleton(accepted('snap-2', 'snap-1', 'iter-2'));

        expect(store.listSnapshots().map((snapshot) => snapshot.snapshotId)).toEqual(['snap-1', 'snap-2']);
        expect(store.current()?.snapshotId).toBe('snap-2');
        expect(store.current()?.previousSnapshotId).toBe('snap-1');
        expect(store.getSnapshot('snap-1')?.previousSnapshotId).toBeNull();
        // The previous generation's ready snapshot stays ready. Its content hash is preserved.
        expect(store.getSnapshot('snap-1')?.contentHash).not.toBeNull();
        expect(store.getSnapshot('no such snapshot')).toBeNull();
    });

    it('filling updates the current snapshot row without adding new rows', () => {
        const store = new RouteStore({ db: open() });

        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        store.setStopStatuses(new Map([[1, { status: 'ready' }]]));
        store.markReady();

        expect(store.listSnapshots()).toHaveLength(1);
        expect(store.getSnapshot('snap-1')?.stops[0]?.status).toBe('ready');
        expect(store.getSnapshot('snap-1')?.contentHash).toBe(store.current()?.contentHash);
    });

    it('reset and cancelSkeleton leave history unchanged', () => {
        const store = new RouteStore({ db: open() });

        store.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        store.markReady();
        store.reset();

        expect(store.current()).toBeNull();
        expect(store.read().snapshot).toBeNull();
        expect(store.listSnapshots().map((snapshot) => snapshot.snapshotId)).toEqual(['snap-1']);
    });

    it('the current snapshot survives reopening the database', () => {
        const first = new RouteStore({ db: open() });
        first.acceptSkeleton(accepted('snap-1', null, 'iter-1'));
        first.acceptSkeleton(accepted('snap-2', 'snap-1', 'iter-2'));
        first.markReady();

        const restored = new RouteStore({ db: open() });

        expect(restored.read().phase).toBe('ready');
        expect(restored.current()?.snapshotId).toBe('snap-2');
        expect(restored.listSnapshots()).toHaveLength(2);
    });

    /** Pre-M4 snapshot shape: no `baseCommit`, `previousSnapshotId`/`carried`, or stop `change`. */
    function legacySnapshotJson(diffId: string): string {
        return JSON.stringify({
            snapshotId: 'snap-legacy',
            commit: 'head-legacy',
            diffId,
            createdAt: '2026-08-25T10:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'opus' },
            summary: 'route built before iterations',
            stops: [
                {
                    id: 'stop-1',
                    planIndex: 1,
                    tier: 'high',
                    title: 'Stop 1',
                    status: 'ready',
                    paragraph: 'paragraph',
                    bridge: null,
                    anchors: [],
                    tests: [],
                    droppedClaims: 0,
                    validationNotes: [],
                    provenance: null,
                },
            ],
            tourOrder: ['stop-1'],
            contentHash: 'abcdef123456',
        });
    }

    function insertLegacySnapshot(db: SherpaDatabase, diffId: string): void {
        db.prepare(
            `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash)
             VALUES (?, ?, ?, NULL, ?, ?)`,
        ).run('snap-legacy', diffId, '2026-08-25T10:00:00.000Z', legacySnapshotJson(diffId), 'abcdef123456');
        db.prepare(
            `INSERT INTO route_state (id, phase, small_pr, current_snapshot_id, intents, updated_at)
             VALUES (1, 'ready', 0, 'snap-legacy', '[]', '2026-08-25T10:00:00.000Z')`,
        ).run();
    }

    it('reads a pre-M4 snapshot with baseCommit from the saved iteration and defaults for the rest', () => {
        const db = open();
        db.prepare(
            `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
             VALUES ('iter-legacy', 'base-of-iter', 'head-legacy', '2026-08-25T09:00:00.000Z', 'active', '{}', '2026-08-25T09:00:00.000Z')`,
        ).run();
        insertLegacySnapshot(db, 'iter-legacy');

        const store = new RouteStore({ db });
        const snapshot = store.current();

        expect(store.read().phase).toBe('ready');
        expect(snapshot?.baseCommit).toBe('base-of-iter');
        expect(snapshot?.previousSnapshotId).toBeNull();
        expect(snapshot?.carried).toBeNull();
        expect(snapshot?.stops[0]?.change).toBeNull();
    });

    // Defaults apply only to new M4 fields: filling in `stops` would turn
    // a corrupt row into a valid empty route.
    it('the schema rejects a corrupt snapshot instead of filling it with an empty stops list', () => {
        const db = open();
        const broken = JSON.stringify({
            ...(JSON.parse(legacySnapshotJson('iter-legacy')) as Record<string, unknown>),
            stops: 'garbage',
        });
        db.prepare(
            `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash)
             VALUES ('snap-broken', 'iter-legacy', '2026-08-25T10:00:00.000Z', NULL, ?, 'abcdef123456')`,
        ).run(broken);
        db.prepare(
            `INSERT INTO route_state (id, phase, small_pr, current_snapshot_id, intents, updated_at)
             VALUES (1, 'ready', 0, 'snap-broken', '[]', '2026-08-25T10:00:00.000Z')`,
        ).run();

        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            const store = new RouteStore({ db });

            expect(store.getSnapshot('snap-broken')).toBeNull();
            expect(store.read().phase).toBe('none');
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('snap-broken'))).toBe(true);
        } finally {
            stderr.mockRestore();
        }
    });

    it('a pre-M4 snapshot without a stored iteration has an unknown base', () => {
        const db = open();
        insertLegacySnapshot(db, 'iter-forgotten');

        expect(new RouteStore({ db }).current()?.baseCommit).toBe('unknown');
    });
});
