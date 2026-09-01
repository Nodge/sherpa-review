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
];

/** Schema version key in the `meta` table. */
export const SCHEMA_VERSION_KEY = 'schema_version';
