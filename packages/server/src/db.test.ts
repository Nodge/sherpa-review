import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixtureIteration, makeFixtureHost } from '@sherpa/fixtures';

import { ChatStore } from './chat-store.js';
import { openDatabase, readSchemaVersion } from './db.js';
import { IterationFeed } from './iteration-feed.js';
import { IterationStore } from './iteration-store.js';
import { MIGRATIONS } from './migrations.js';
import { databasePathFor } from './paths.js';
import { ProgressStore } from './progress-store.js';
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
        // Live hosts are forbidden in tests (docs/testing.md). Without a host, route warmup makes no requests.
        servers.push(await startServer({ updateChannel: null, feedbackChannel: null, prKey: 'pr-42', sherpaDir, hosts: [] }));
        const file = databasePathFor(sherpaDir, 'pr-42');

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
            expect(after.prepare('SELECT worker_id, harness, model, lang FROM worker').get()).toMatchObject({
                worker_id: 'w-1',
                harness: 'claude-code',
                model: null,
                lang: null,
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

    // An existing database must retain its route when switching to multiple snapshots.
    it('moves the snapshot from route_state to route_snapshots during the iteration migration', () => {
        const file = `${sherpaDir}/route-snapshot.db`;
        const snapshot = {
            snapshotId: 'snap-legacy',
            commit: 'head-legacy',
            diffId: 'iter-legacy',
            createdAt: '2026-08-25T10:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'opus', locale: null },
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

    // Existing database progress survives when an iteration dimension is added to its tables.
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

    // An existing database note stays where it was pinned. The schema previously had no original location.
    it('fills the original location with a copy of the current one during the note anchor migration', () => {
        const file = `${sherpaDir}/notes-anchors.db`;
        const anchor = {
            diffId: 'iter-1',
            fileId: 'file-1',
            path: 'src/main.ts',
            side: 'new',
            start: 10,
            end: 12,
        };

        const before = openDatabase(file, migrationsBefore('014-notes-anchors'));
        before
            .prepare(
                `INSERT INTO chat_exchanges (
                    id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    created_at, updated_at
                 ) VALUES (1, 'question', ?, 'done', 'answer', NULL, NULL, NULL, 'head-1', ?, ?)`,
            )
            .run(JSON.stringify(anchor), '2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z');
        before
            .prepare(
                `INSERT INTO agent_notes (id, exchange_id, anchor, text, commit_hash, created_at)
                 VALUES (1, 1, ?, 'answer', 'head-1', ?)`,
            )
            .run(JSON.stringify(anchor), '2026-08-25T10:00:00.000Z');
        before.close();

        const after = openDatabase(file);
        try {
            const store = new ChatStore({ db: after });
            const note = store.read().notes[0];
            expect(note?.anchor).toEqual(anchor);
            expect(note?.origin).toEqual({ commit: 'head-1', anchor });
            expect(note?.lostAnchor).toBe(false);
            store.close();
        } finally {
            after.close();
        }
    });

    // The draft buffer arrives as an empty table and leaves existing state alone.
    it('creates a table with state validation during the draft buffer migration', () => {
        const file = `${sherpaDir}/draft-buffer.db`;

        const before = openDatabase(file, migrationsBefore('018-draft-buffer'));
        before.close();

        const after = openDatabase(file);
        try {
            const insert = after.prepare(
                `INSERT INTO draft_buffer (
                    id, comment_id, draft_json, state, error, attempts, idempotency_key, created_at, updated_at
                 ) VALUES (?, NULL, '{}', ?, NULL, 0, 'key-1', ?, ?)`,
            );
            insert.run('ck-1', 'pending', '2026-09-03T10:00:00.000Z', '2026-09-03T10:00:00.000Z');
            expect(after.prepare('SELECT id, state, attempts FROM draft_buffer').all()).toEqual([
                { id: 'ck-1', state: 'pending', attempts: 0 },
            ]);
            expect(() => {
                insert.run('ck-2', 'sent', '2026-09-03T10:00:00.000Z', '2026-09-03T10:00:00.000Z');
            }).toThrow();

            // Pairs of "record key → created draft" live separately. The buffer record disappears after
            // success, but the created comment must still be remembered.
            after.prepare('INSERT INTO draft_buffer_saved (id, comment_id, created_at) VALUES (?, ?, ?)').run(
                'ck-1',
                'c-42',
                '2026-09-03T10:00:01.000Z',
            );
            expect(after.prepare('SELECT id, comment_id FROM draft_buffer_saved').all()).toEqual([
                { id: 'ck-1', comment_id: 'c-42' },
            ]);
        } finally {
            after.close();
        }
    });

    // The exchange language arrives as an empty column. Existing exchanges remain in Russian.
    it('creates the chat language column and reads old exchanges as Russian during migration', () => {
        const file = `${sherpaDir}/chat-locale.db`;
        const at = '2026-09-04T10:00:00.000Z';

        const before = openDatabase(file, migrationsBefore('020-chat-locale'));
        before
            .prepare(
                `INSERT INTO chat_exchanges (
                    id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    created_at, updated_at
                 ) VALUES (1, 'question from an old exchange', NULL, 'done', 'answer', NULL, NULL, NULL, 'head-1', ?, ?)`,
            )
            .run(at, at);
        before.close();

        const after = openDatabase(file);
        try {
            expect(readSchemaVersion(after)).toBe(String(MIGRATIONS.length));
            expect(after.prepare('SELECT id, locale FROM chat_exchanges').all()).toEqual([
                { id: 1, locale: null },
            ]);

            const store = new ChatStore({ db: after });
            // `null` in the column means an exchange predating language support. The contract returns it as "language unknown".
            expect(store.read().exchanges[0]?.locale).toBeNull();
            store.close();
        } finally {
            after.close();
        }
    });

    // The full chain of migrations 010…015 upgrades an existing pre-iteration database in one go.
    it('upgrades a pre-iteration database through the migration chain without losing anything', () => {
        const file = `${sherpaDir}/legacy-to-iterations.db`;
        const at = '2026-08-25T10:00:00.000Z';
        const snapshot = {
            snapshotId: 'snap-legacy-iter',
            commit: 'head-legacy',
            diffId: 'iter-legacy',
            createdAt: at,
            provenance: { harness: 'claude-code', model: 'opus', locale: null },
            summary: 'route built before iterations',
            stops: [],
            tourOrder: [],
            contentHash: 'abcdef123456',
        };
        // An old note anchor does not name an iteration. That field did not exist in the schema yet.
        const anchor = { fileId: 'file-1', path: 'src/main.ts', side: 'new', start: 10, end: 12 };

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, ?, '[]', ?)`,
            )
            .run(JSON.stringify(snapshot), at);
        before.prepare('INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, 1, ?)').run('s01', at);
        before.prepare('INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, 1, ?)').run('s03', at);
        before.prepare('INSERT INTO file_progress (file_id, viewed, updated_at) VALUES (?, 1, ?)').run('file-1', at);
        before
            .prepare(
                `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
                 VALUES ('file-1', 'new', 3, 7, 's01')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO chat_exchanges (
                    id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    created_at, updated_at
                 ) VALUES (1, 'question', ?, 'done', 'answer', NULL, NULL, NULL, 'head-legacy', ?, ?)`,
            )
            .run(JSON.stringify(anchor), at, at);
        before
            .prepare(
                `INSERT INTO agent_notes (id, exchange_id, anchor, text, commit_hash, created_at)
                 VALUES (1, 1, ?, 'answer', 'head-legacy', ?)`,
            )
            .run(JSON.stringify(anchor), at);
        before.close();

        const after = openDatabase(file);
        try {
            expect(readSchemaVersion(after)).toBe(String(MIGRATIONS.length));

            // The snapshot moved as an unchanged blob and remained the current PR route.
            const store = new RouteStore({ db: after });
            expect(store.current()?.snapshotId).toBe('snap-legacy-iter');
            expect(after.prepare('SELECT snapshot_json FROM route_snapshots').get()).toMatchObject({
                snapshot_json: JSON.stringify(snapshot),
            });

            // Stop marks are keyed by snapshot, not PR. `carried` describes carryover, which
            // these marks never underwent. The reviewer set them by hand.
            expect(after.prepare('SELECT snapshot_id, stop_id, carried FROM stop_progress ORDER BY stop_id').all()).toEqual([
                { snapshot_id: 'snap-legacy-iter', stop_id: 's01', carried: 0 },
                { snapshot_id: 'snap-legacy-iter', stop_id: 's03', carried: 0 },
            ]);

            // This database has no iterations at all, so progress moves to the snapshot iteration,
            // the one the reviewer read. `LEGACY_DIFF_ID` is only for a database without a route.
            expect(after.prepare('SELECT diff_id, file_id, viewed FROM file_progress').all()).toEqual([
                { diff_id: 'iter-legacy', file_id: 'file-1', viewed: 1 },
            ]);
            expect(
                after.prepare('SELECT diff_id, start_line, end_line, carried_from FROM file_seen_ranges').all(),
            ).toEqual([{ diff_id: 'iter-legacy', start_line: 3, end_line: 7, carried_from: null }]);
            expect(after.prepare('SELECT COUNT(*) AS count FROM progress_carries').get()).toMatchObject({ count: 0 });

            // An anchor without an iteration reads as `LEGACY_DIFF_ID`. The feed adopts it when the host
            // names the active iteration. The original note location is filled with a copy of the current one.
            const chat = new ChatStore({ db: after });
            const note = chat.read().notes[0];
            expect(note?.anchor).toEqual({ ...anchor, diffId: 'unknown' });
            expect(note?.origin).toEqual({ commit: 'head-legacy', anchor: { ...anchor, diffId: 'unknown' } });
            expect(note?.lostAnchor).toBe(false);
            chat.close();
        } finally {
            after.close();
        }
    });

    // Upgrading an existing 0.3.x database: progress exists but iterations do not. Carryover must find it.
    it('moves marks to the iteration the server started on after a 0.3.x upgrade', async () => {
        const file = `${sherpaDir}/legacy-carry.db`;
        const at = '2026-08-25T10:00:00.000Z';
        const v1 = fixtureIteration('medium', 0);
        const v2 = fixtureIteration('medium', 1);
        // The v1→v2 slice does not touch this file. Its marks must carry over in full.
        const source = v1.diff.files[0];
        const target = v2.diff.files[0];
        if (source === undefined || target === undefined) {
            throw new Error('medium fixture has no files');
        }
        const snapshot = {
            snapshotId: 'snap-legacy-iter',
            commit: v1.iteration.headCommit,
            diffId: v1.iteration.diffId,
            createdAt: at,
            provenance: { harness: 'claude-code', model: 'opus' },
            summary: 'route built before iterations',
            stops: [
                {
                    id: 's01',
                    planIndex: 1,
                    tier: 'high',
                    title: 'Editing window',
                    status: 'ready',
                    paragraph: 'what changed',
                    bridge: null,
                    anchors: [
                        {
                            fileId: source.fileId,
                            path: source.path,
                            side: 'new',
                            start: 1,
                            end: 5,
                            collapsed: false,
                        },
                    ],
                    tests: [],
                    droppedClaims: 0,
                    validationNotes: [],
                    provenance: null,
                },
            ],
            tourOrder: ['s01'],
            contentHash: 'abcdef123456',
        };

        const before = openDatabase(file, migrationsBefore('010-iterations'));
        before
            .prepare(
                `INSERT INTO route_state (id, phase, small_pr, snapshot, intents, updated_at)
                 VALUES (1, 'ready', 0, ?, '[]', ?)`,
            )
            .run(JSON.stringify(snapshot), at);
        before.prepare('INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, 1, ?)').run('s01', at);
        before
            .prepare('INSERT INTO file_progress (file_id, viewed, updated_at) VALUES (?, 1, ?)')
            .run(source.fileId, at);
        before
            .prepare(
                `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
                 VALUES (?, 'new', 1, 5, 's01')`,
            )
            .run(source.fileId);
        before.close();

        const db = openDatabase(file);
        try {
            // A 0.3.x database has no iterations at all. Looking for a source in `iterations` is pointless.
            expect(db.prepare('SELECT COUNT(*) AS count FROM iterations').get()).toMatchObject({ count: 0 });

            const iterations = new IterationStore({ db });
            const route = new RouteStore({ db });
            const progress = new ProgressStore({ db, iterations, log: () => undefined });
            const host = makeFixtureHost('medium');
            // The push happened while the server was down. It starts on the second iteration.
            host.advanceIteration();
            const feed = new IterationFeed({
                host,
                iterations,
                route,
                progress,
                log: () => undefined,
            });
            const release = feed.subscribe(() => undefined);
            try {
                for (let attempt = 0; attempt < 200; attempt += 1) {
                    if (progress.read(v2.iteration.diffId).length > 0) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 5));
                }

                expect(progress.read(v2.iteration.diffId)).toEqual([
                    { fileId: target.fileId, viewed: true, seenRanges: [{ side: 'new', start: 1, end: 5 }] },
                ]);
                expect(
                    db.prepare('SELECT from_diff_id, to_diff_id FROM progress_carries').all(),
                ).toEqual([{ from_diff_id: v1.iteration.diffId, to_diff_id: v2.iteration.diffId }]);
            } finally {
                release();
                feed.close();
                progress.close();
                route.close();
            }
        } finally {
            db.close();
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

    // The list is append-only. The name is the permanent key of an applied migration, the number is its position.
    it('has unique migration names, consecutive numbers and non-empty sql', () => {
        const names = MIGRATIONS.map((migration) => migration.name);

        expect(new Set(names).size).toBe(names.length);
        expect(names.map((name) => Number(name.slice(0, 3)))).toEqual(
            MIGRATIONS.map((_migration, index) => index + 1),
        );
        for (const migration of MIGRATIONS) {
            expect(migration.name).toMatch(/^\d{3}-[a-z0-9-]+$/);
            expect(migration.sql.trim()).not.toBe('');
        }
    });

    // A skill upgrade can find the database at any previous version. Each must upgrade to the current one.
    it('upgrades a database at any prefix of the migration list to the full schema', () => {
        for (let applied = 1; applied <= MIGRATIONS.length; applied += 1) {
            const file = `${sherpaDir}/prefix-${String(applied)}.db`;

            const partial = openDatabase(file, MIGRATIONS.slice(0, applied));
            expect(readSchemaVersion(partial)).toBe(String(applied));
            partial.close();

            const full = openDatabase(file);
            try {
                expect(readSchemaVersion(full)).toBe(String(MIGRATIONS.length));
                expect(full.prepare('SELECT COUNT(*) AS count FROM migrations').get()).toMatchObject({
                    count: MIGRATIONS.length,
                });
            } finally {
                full.close();
            }
        }
    });

    // The server started without an iteration host but built a route. Its snapshot names the iteration.
    it('moves progress records to the current snapshot iteration when no active iteration exists', () => {
        const file = `${sherpaDir}/progress-snapshot.db`;

        const before = openDatabase(file, migrationsBefore('013-progress-iterations'));
        before
            .prepare(
                `INSERT INTO iterations (diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at)
                 VALUES ('iter-snap', 'base', 'head-snap', '2026-08-30T10:00:00.000Z', 'previous', '{}', '2026-08-30T10:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO route_snapshots (snapshot_id, diff_id, created_at, snapshot_json)
                 VALUES ('snap-1', 'iter-snap', '2026-08-31T11:00:00.000Z', '{}')`,
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
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT diff_id, file_id FROM file_progress').all()).toEqual([
                { diff_id: 'iter-snap', file_id: 'file-1' },
            ]);
            expect(after.prepare('SELECT diff_id, file_id FROM file_seen_ranges').all()).toEqual([
                { diff_id: 'iter-snap', file_id: 'file-1' },
            ]);
        } finally {
            after.close();
        }
    });

    // Carryover tracking starts at zero. Stops that predate it have never been carried over.
    it('sets carried = 0 for existing stops during the carryover tracking migration', () => {
        const file = `${sherpaDir}/stop-carried.db`;

        const before = openDatabase(file, migrationsBefore('015-stop-carried'));
        before
            .prepare(
                `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, updated_at)
                 VALUES ('snap-1', 's01', 1, '2026-08-31T11:00:00.000Z'),
                        ('snap-1', 's02', 0, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT stop_id, viewed, carried FROM stop_progress ORDER BY stop_id').all()).toEqual([
                { stop_id: 's01', viewed: 1, carried: 0 },
                { stop_id: 's02', viewed: 0, carried: 0 },
            ]);
        } finally {
            after.close();
        }
    });

    // No path backfill: old `fileId` values cannot be resolved, and the migration must not invent paths.
    it('creates empty columns during the progress path migration', () => {
        const file = `${sherpaDir}/progress-paths.db`;

        const before = openDatabase(file, migrationsBefore('016-progress-paths'));
        before
            .prepare(
                `INSERT INTO file_progress (diff_id, file_id, viewed, updated_at)
                 VALUES ('iter-1', 'file-1', 1, '2026-08-31T11:00:00.000Z')`,
            )
            .run();
        before
            .prepare(
                `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line, source_stop_id, carried_from)
                 VALUES ('iter-1', 'file-1', 'new', 3, 7, 's01', NULL)`,
            )
            .run();
        before.close();

        const after = openDatabase(file);
        try {
            expect(after.prepare('SELECT file_id, path FROM file_progress').all()).toEqual([
                { file_id: 'file-1', path: null },
            ]);
            expect(after.prepare('SELECT file_id, path FROM file_seen_ranges').all()).toEqual([
                { file_id: 'file-1', path: null },
            ]);
        } finally {
            after.close();
        }
    });
});
