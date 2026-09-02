import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, readSchemaVersion } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { databasePathFor } from './paths.js';
import { RouteStore } from './route-store.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

describe('storage', () => {
    let sherpaDir: string;
    const servers: SherpaServer[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    it('creates the PR database in WAL mode on the server', async () => {
        // Live review hosts are forbidden in tests (requirements §7): without a host, route warmup makes no calls.
        servers.push(await startServer({ prKey: 'github-quillmart--quillmart--42', sherpaDir, reviewHostFactory: () => null }));
        const file = databasePathFor(sherpaDir, 'github-quillmart--quillmart--42');

        await expect(fs.stat(file)).resolves.toBeDefined();

        const reader = new DatabaseSync(file, { readOnly: true });
        try {
            expect(reader.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
        } finally {
            reader.close();
        }
    });

    it('applies migrations once and records the schema version', () => {
        const file = `${sherpaDir}/migrations.db`;

        const first = openDatabase(file);
        const appliedAfterFirst = first.prepare('SELECT name FROM migrations ORDER BY id').all() as { name: string }[];
        expect(appliedAfterFirst.map((row) => row.name)).toEqual(MIGRATIONS.map((migration) => migration.name));
        expect(readSchemaVersion(first)).toBe(String(MIGRATIONS.length));
        first.close();

        const second = openDatabase(file);
        const appliedAfterSecond = second.prepare('SELECT COUNT(*) AS count FROM migrations').get() as {
            count: number;
        };
        expect(appliedAfterSecond.count).toBe(MIGRATIONS.length);
        second.close();
    });

    // The PR database survives skill upgrades. New migrations apply to existing state.
    it('applies the latest migration to an existing database without losing its data', () => {
        const file = `${sherpaDir}/upgrade.db`;

        const before = openDatabase(file, MIGRATIONS.slice(0, -1));
        before
            .prepare('INSERT INTO worker (id, worker_id, harness, registered_at, last_seen_at) VALUES (1, ?, ?, ?, ?)')
            .run('w-1', 'claude-code', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        before.close();

        const after = openDatabase(file);
        try {
            expect(readSchemaVersion(after)).toBe(String(MIGRATIONS.length));
            expect(after.prepare('SELECT worker_id, harness, model FROM worker').get()).toMatchObject({
                worker_id: 'w-1',
                harness: 'claude-code',
                model: null,
            });
        } finally {
            after.close();
        }
    });

    /** Schema before the named migration. Later migrations have not been applied yet. */
    function migrationsBefore(name: string): typeof MIGRATIONS {
        const index = MIGRATIONS.findIndex((migration) => migration.name === name);
        expect(index).toBeGreaterThan(0);
        return MIGRATIONS.slice(0, index);
    }

    // The dogfooding database keeps its route when migrating to multiple snapshots (M4-T3).
    it('moves the snapshot from route_state to route_snapshots during the iteration migration', () => {
        const file = `${sherpaDir}/route-snapshot.db`;
        const snapshot = {
            snapshotId: 'snap-legacy',
            commit: 'head-legacy',
            diffId: 'iter-legacy',
            createdAt: '2026-08-25T10:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'opus' },
            summary: 'route before iterations',
            stops: [],
            tourOrder: [],
            contentHash: 'abcdef123456',
        };

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, ?, '[]', '2026-08-25T10:00:00.000Z')`,
            )
            .run(JSON.stringify(snapshot));
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT * FROM route_snapshots').all()).toEqual([
                {
                    snapshot_id: 'snap-legacy',
                    diff_id: 'iter-legacy',
                    created_at: '2026-08-25T10:00:00.000Z',
                    previous_snapshot_id: null,
                    snapshot_json: JSON.stringify(snapshot),
                    content_hash: 'abcdef123456',
                },
            ]);
            expect(after.prepare('SELECT phase, current_snapshot_id FROM route_state').get()).toMatchObject({
                phase: 'ready',
                current_snapshot_id: 'snap-legacy',
            });
            // The snapshot blob is gone from `route_state` entirely. `route_snapshots` is the source of truth.
            const columns = after.prepare('PRAGMA table_info(route_state)').all() as { name: string }[];
            expect(columns.map((column) => column.name)).not.toContain('snapshot');

            const store = new RouteStore({ db: after });
            expect(store.current()?.snapshotId).toBe('snap-legacy');
            expect(store.listSnapshots()).toHaveLength(1);
        } finally {
            after.close();
        }
    });

    // Old bindings do not name the task iteration, so generation cannot continue with them.
    it('removes previously saved bindings during the task iteration migration', () => {
        const file = `${sherpaDir}/route-tasks.db`;

        const before = openDatabase(file, migrationsBefore('012-route-task-iteration'));
        before
            .prepare(
                'INSERT INTO tasks (id, type, priority, instructions, context_files, status, attempt, ' +
                    'created_at, updated_at) ' +
                    "VALUES (7, 'route.skeleton', 'background', '', '[]', 'queued', 1, " +
                    "'2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z')",
            )
            .run();
        before
            .prepare("INSERT INTO route_tasks (task_id, kind, plan_indexes, created_at) " +
                "VALUES (7, 'skeleton', '[]', '2026-08-25T10:00:00.000Z')")
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT COUNT(*) AS count FROM route_tasks').get()).toMatchObject({ count: 0 });
            // The task itself remains. The orchestrator cancels the orphan without a binding.
            expect(after.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toMatchObject({ count: 1 });
            const columns = after.prepare('PRAGMA table_info(route_tasks)').all() as { name: string }[];
            expect(columns.map((column) => column.name)).toContain('diff_id');
        } finally {
            after.close();
        }
    });

    // Manual database edits must not crash server startup during migration.
    it('handles a corrupt snapshot blob during the iteration migration', () => {
        const file = `${sherpaDir}/route-broken.db`;

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, 'this is not json', '[]', '2026-08-25T10:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT COUNT(*) AS count FROM route_snapshots').get()).toMatchObject({ count: 0 });
            expect(after.prepare('SELECT current_snapshot_id FROM route_state').get()).toMatchObject({
                current_snapshot_id: null,
            });
            // The blob was not moved, so there is no route. `ready` without a snapshot would falsely tell the UI a route is ready.
            const store = new RouteStore({ db: after });
            expect(store.read().phase).toBe('none');
            expect(store.current()).toBeNull();
        } finally {
            after.close();
        }
    });

    // Dogfooding database progress is preserved when its tables gain an iteration dimension (M4-T6).
    it('moves progress records to the active iteration and stop marks to the current snapshot during migration', () => {
        const file = `${sherpaDir}/progress-iterations.db`;

        const before = openDatabase(file, migrationsBefore('013-progress-iterations'));
        before
            .prepare(
                `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
                 VALUES ('iter-old', 'base', 'head-old', '2026-08-30T10:00:00.000Z', 'previous', '{}', '2026-08-30T10:00:00.000Z'),
                        ('iter-live', 'base', 'head-live', '2026-08-31T10:00:00.000Z', 'active', '{}', '2026-08-31T10:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, snapshot_json)
                 VALUES ('snap-1', 'iter-live', '2026-08-31T11:00:00.000Z', '{}')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, current_snapshot_id, intents, updated_at)
                 VALUES (1, 'ready', 0, 'snap-1', '[]', '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_progress (file_id, viewed, updated_at)
                 VALUES ('file-1', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
                 VALUES ('file-1', 'new', 3, 7, 's01')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO stop_progress (stop_id, viewed, updated_at)
                 VALUES ('s01', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT diff_id, file_id, viewed FROM file_progress').all()).toEqual([
                { diff_id: 'iter-live', file_id: 'file-1', viewed: 1 },
            ]);
            expect(
                after.prepare('SELECT diff_id, source_stop_id, carried_from FROM file_seen_ranges').all(),
            ).toEqual([{ diff_id: 'iter-live', source_stop_id: 's01', carried_from: null }]);
            expect(after.prepare('SELECT snapshot_id, stop_id, viewed FROM stop_progress').all()).toEqual([
                { snapshot_id: 'snap-1', stop_id: 's01', viewed: 1 },
            ]);
            expect(after.prepare('SELECT COUNT(*) AS count FROM progress_carries').get()).toMatchObject({
                count: 0,
            });
        } finally {
            after.close();
        }
    });

    // A server without a host knows no iterations. Its progress lives on `LEGACY_DIFF_ID`.
    it('moves records to unknown and deletes stops when migrating progress without iterations or a snapshot', () => {
        const file = `${sherpaDir}/progress-legacy.db`;

        const before = openDatabase(file, migrationsBefore('013-progress-iterations'));
        before
            .prepare(
                `INSERT INTO file_progress (file_id, viewed, updated_at)
                 VALUES ('file-1', 0, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO stop_progress (stop_id, viewed, updated_at)
                 VALUES ('s01', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT diff_id, file_id FROM file_progress').all()).toEqual([
                { diff_id: 'unknown', file_id: 'file-1' },
            ]);
            // A stop mark without a snapshot has nothing to refer to.
            expect(after.prepare('SELECT COUNT(*) AS count FROM stop_progress').get()).toMatchObject({
                count: 0,
            });
        } finally {
            after.close();
        }
    });

    it('includes service tables and a task queue with a scheduler index in the schema', () => {
        const db = openDatabase(`${sherpaDir}/tables.db`);
        try {
            const objects = db
                .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
                .all() as { name: string }[];

            expect(objects.map((row) => row.name)).toEqual(
                expect.arrayContaining(['meta', 'migrations', 'tasks', 'tasks_scheduler', 'worker']),
            );
        } finally {
            db.close();
        }
    });

    it('leaves no open connection or partial schema after a migration failure', () => {
        const file = `${sherpaDir}/broken.db`;

        expect(() =>
            openDatabase(file, [
                { name: '001-meta', sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' },
                { name: '002-broken', sql: 'CREATE TABLE ok (id INTEGER); SYNTAX GARBAGE;' },
            ]),
        ).toThrow();

        const db = new DatabaseSync(file, { readOnly: true });
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
                name: string;
            }[];
            expect(tables.map((row) => row.name)).not.toContain('ok');
        } finally {
            db.close();
        }
    });
});
