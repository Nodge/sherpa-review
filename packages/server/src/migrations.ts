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
];

/** Schema version key in the `meta` table. */
export const SCHEMA_VERSION_KEY = 'schema_version';
