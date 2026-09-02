/** Schema migration: the name is fixed forever. SQL runs once and is never rewritten. */
export interface Migration {
    readonly name: string;
    readonly sql: string;
}

/**
 * Migrations run in order. The schema version equals the number of applied migrations
 * and lives in `meta.schema_version`. The list is append-only. Applied migrations are never rewritten.
 */
export const MIGRATIONS: readonly Migration[] = [
    {
        name: '001-meta',
        sql: `
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `,
    },
    {
        // Queue with leases (rpc-design §5). `id` is the contract TaskId, shown as `sherpa/<id>` in the UI and prompts.
        name: '002-queue',
        sql: `
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                priority TEXT NOT NULL CHECK (priority IN ('interactive', 'background')),
                instructions TEXT NOT NULL,
                context_files TEXT NOT NULL,
                result_schema_file TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'cancelled')),
                attempt INTEGER NOT NULL CHECK (attempt >= 1),
                worker_id TEXT,
                lease_expires_at TEXT,
                progress_text TEXT,
                result TEXT,
                fail_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX tasks_scheduler ON tasks (status, priority, id);
        `,
    },
    {
        // PR worker (rpc-design §7). Exactly one row because there is one server and one worker per PR.
        // Session history is unnecessary in M0. Reconnection overwrites the slot.
        name: '003-worker',
        sql: `
            CREATE TABLE worker (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                worker_id TEXT NOT NULL,
                harness TEXT,
                registered_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );
        `,
    },
    {
        // Worker model name beside its harness: the session reports it and the UI shows it in the status.
        name: '004-worker-model',
        sql: `
            ALTER TABLE worker ADD COLUMN model TEXT;
        `,
    },
    {
        // PR reading progress (T8, requirements §5). One DB per PR, so there are no prKey keys inside.
        // A row in `file_progress` appears only after an explicit reviewer action. Its absence means
        // the default state, which the UI interprets. `file_seen_ranges` prepares for M2 stops:
        // range writes arrive with them, while reads already work.
        // Boundary columns are `start_line`/`end_line` because `end` is an SQLite keyword.
        name: '005-progress',
        sql: `
            CREATE TABLE file_progress (
                file_id TEXT PRIMARY KEY,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL
            );

            CREATE TABLE file_seen_ranges (
                file_id TEXT NOT NULL,
                side TEXT NOT NULL CHECK (side IN ('old', 'new')),
                start_line INTEGER NOT NULL CHECK (start_line >= 1),
                end_line INTEGER NOT NULL CHECK (end_line >= start_line)
            );

            CREATE INDEX file_seen_ranges_file ON file_seen_ranges (file_id);
        `,
    },
    {
        // PR route (M2-T4). Exactly one row: one database per PR, one snapshot in M2
        // (snapshot versioning belongs to M4). The snapshot and stop intents are JSON blobs.
        // Protocol schemas describe their shape, so there is no need to duplicate it in columns. On input and
        // output, they pass through `routeSnapshotSchema` (a fail-closed boundary).
        // `route_tasks` links a queued task to the stops it fills. The orchestrator uses this
        // link to restore stop statuses after a restart and avoid scheduling duplicates.
        // `rejections` counts result rejections within one lease. A rejection does not release the lease,
        // but the model cannot keep fixing the result forever (rpc-design §3).
        name: '006-route',
        sql: `
            CREATE TABLE route_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                phase TEXT NOT NULL CHECK (phase IN ('none', 'reading', 'filling', 'ready', 'failed')),
                small_pr INTEGER CHECK (small_pr IN (0, 1)),
                snapshot TEXT,
                failure_message TEXT,
                failure_raw_output TEXT,
                intents TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE route_tasks (
                task_id INTEGER PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('skeleton', 'section')),
                plan_indexes TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            ALTER TABLE tasks ADD COLUMN rejections INTEGER NOT NULL DEFAULT 0;
        `,
    },
    {
        // Route stop progress (M2-T7, requirements §3.1). The stop mark persists per PR, and
        // the seen ranges it adds carry its `stop_id`. Clearing the mark removes
        // exactly that stop's ranges, leaving other stops' ranges and manual file marks alone.
        // `source_stop_id IS NULL` means a range did not come from a stop (nothing writes these now, but
        // clearing stop progress must still distinguish them).
        name: '007-stop-progress',
        sql: `
            CREATE TABLE stop_progress (
                stop_id TEXT PRIMARY KEY,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL
            );

            ALTER TABLE file_seen_ranges ADD COLUMN source_stop_id TEXT;

            CREATE INDEX file_seen_ranges_stop ON file_seen_ranges (source_stop_id);
        `,
    },
    {
        // Chat exchanges and local agent notes (M3-T3). Anchors are JSON blobs: their
        // canonical shape lives in `chatAnchorSchema`, which the store validates on reads and writes.
        // `task_id` is the exchange's current attempt. A retry replaces it with a new task.
        name: '008-chat',
        sql: `
            CREATE TABLE chat_exchanges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question TEXT NOT NULL,
                anchor TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
                answer TEXT,
                progress_text TEXT,
                error TEXT,
                task_id INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
                head_commit TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX chat_exchanges_task ON chat_exchanges (task_id) WHERE task_id IS NOT NULL;

            CREATE TABLE agent_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exchange_id INTEGER NOT NULL REFERENCES chat_exchanges (id) ON DELETE CASCADE,
                anchor TEXT NOT NULL,
                text TEXT NOT NULL,
                commit_hash TEXT,
                created_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX agent_notes_exchange ON agent_notes (exchange_id);
        `,
    },
    {
        // The attempt count grows both when a worker dies and when it is routinely preempted. The reason for the last
        // lease return lets orchestrators distinguish these cases after a restart.
        name: '009-task-lease-return-reason',
        sql: `
            ALTER TABLE tasks ADD COLUMN last_lease_return_reason TEXT
                CHECK (last_lease_return_reason IN ('expired', 'displaced'));
        `,
    },
    {
        // PR iterations and multiple snapshots (M4-T3, brief §4a, F3).
        //
        // `iterations` stores a local patch for each iteration. The host no longer serves it
        // after a force-push, but old snapshots must remain readable. `interdiffs` caches slices
        // (the review host computes a slice in 2.8–3.7 s, so there is no reason to pay for it twice).
        //
        // Route snapshots move from the `route_state.snapshot` blob to their own table. A PR has
        // many snapshots (one per generation), while `route_state` keeps only the current ID.
        // The migration copies the existing dogfooding database row, preserving the route.
        // The condition uses `json_valid`: a corrupted blob (a manual database edit) must leave
        // "no route" instead of crashing server startup during migration. If the blob did not move, reset the phase
        // too. "ready"/"filling" without a snapshot would falsely tell the UI a route is ready.
        name: '010-iterations',
        sql: `
            CREATE TABLE iterations (
                diff_id TEXT PRIMARY KEY,
                base_commit TEXT NOT NULL,
                head_commit TEXT NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('active', 'previous', 'gone')),
                diff_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );

            CREATE TABLE interdiffs (
                base_id TEXT NOT NULL,
                head_id TEXT NOT NULL,
                diff_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (base_id, head_id)
            );

            CREATE TABLE route_snapshots (
                snapshot_id TEXT PRIMARY KEY,
                diff_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                previous_snapshot_id TEXT,
                snapshot_json TEXT NOT NULL,
                content_hash TEXT
            );

            CREATE INDEX route_snapshots_created ON route_snapshots (created_at);

            ALTER TABLE route_state ADD COLUMN current_snapshot_id TEXT;

            INSERT INTO route_snapshots (
                snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash
            )
            SELECT
                json_extract(snapshot, '$.snapshotId'),
                json_extract(snapshot, '$.diffId'),
                json_extract(snapshot, '$.createdAt'),
                json_extract(snapshot, '$.previousSnapshotId'),
                snapshot,
                json_extract(snapshot, '$.contentHash')
            FROM route_state
            WHERE snapshot IS NOT NULL
              AND json_valid(snapshot)
              AND json_extract(snapshot, '$.snapshotId') IS NOT NULL
              AND json_extract(snapshot, '$.diffId') IS NOT NULL
              AND json_extract(snapshot, '$.createdAt') IS NOT NULL;

            UPDATE route_state
               SET current_snapshot_id = (
                   SELECT snapshot_id FROM route_snapshots
                    WHERE snapshot_json = route_state.snapshot
               )
             WHERE snapshot IS NOT NULL;

            UPDATE route_state
               SET phase = 'none'
             WHERE current_snapshot_id IS NULL AND phase IN ('ready', 'filling');

            ALTER TABLE route_state DROP COLUMN snapshot;
        `,
    },
    {
        // Route task iteration (M4-T4): acceptance must resolve anchors against the same
        // diff used to build the task payload. After a server restart, there is nowhere else
        // to recover it. Old bindings do not name an iteration, so they are deleted. Their tasks
        // become orphans, and the orchestrator cancels them and schedules generation again.
        name: '011-route-task-iteration',
        sql: `
            ALTER TABLE route_tasks ADD COLUMN diff_id TEXT;

            DELETE FROM route_tasks;
        `,
    },
];

/** Schema version key in the `meta` table. */
export const SCHEMA_VERSION_KEY = 'schema_version';
