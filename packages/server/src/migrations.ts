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
];

/** Schema version key in the `meta` table. */
export const SCHEMA_VERSION_KEY = 'schema_version';
