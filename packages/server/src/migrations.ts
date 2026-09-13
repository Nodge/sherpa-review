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
        // Queue with leases (docs/protocol.md §5). `id` is also the contract's TaskId, shown as `sherpa/<id>` in the UI and prompts.
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
        // PR worker (docs/protocol.md §7). Exactly one row: each server handles one PR, and each PR has one worker.
        // No session history is needed. Reconnection overwrites the slot.
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
        // PR reading progress (docs/architecture.md §3). One database per PR, so no internal prKey keys.
        // A row in `file_progress` appears only after an explicit reviewer action. Its absence means
        // the default state, interpreted by the UI. `file_seen_ranges` prepares for route stops:
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
        // PR route. Exactly one row: one database per PR and, at the time, one snapshot
        // (snapshot versioning arrived in migration `010`). The snapshot and stop intents are JSON blobs.
        // Protocol schemas describe their shape, so there is no need to duplicate it in columns. On input and
        // output, they pass through `routeSnapshotSchema` (a fail-closed boundary).
        // `route_tasks` links a queued task to the stops it fills. The orchestrator uses this
        // link to restore stop statuses after a restart and avoid scheduling duplicates.
        // `rejections` counts result rejections within one lease. A rejection does not release the lease,
        // but the model cannot keep fixing forever (docs/protocol.md §3).
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
        // Route stop progress (docs/architecture.md §7.1). A stop's mark persists per PR, and
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
        // Chat exchanges and local agent notes. Anchors are JSON blobs. Their
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
        // PR iterations and multiple snapshots (docs/product.md §4a, F3).
        //
        // `iterations` stores a local patch for each iteration. The host no longer serves it
        // after a force-push, but old snapshots must remain readable. `interdiffs` caches slices
        // (the review host computes a slice in 2.8–3.7 s, so there is no reason to pay for it twice).
        //
        // Route snapshots move from the `route_state.snapshot` blob to their own table. A PR has
        // many snapshots (one per generation), while `route_state` keeps only the current ID.
        // Migration data moves the existing row from the accumulated database, preserving the route.
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
        // UI state for this PR: collapsed directories and cards, recent palette commands.
        // Key-value storage: the contract schema defines the keys, so a new field needs no migration.
        // No prKey column, since the database already belongs to one PR.
        name: '011-ui-pr-state',
        sql: `
            CREATE TABLE ui_pr_state (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `,
    },
    {
        // Route task iteration: the result handler must resolve anchors against the exact
        // diff used to build the task payload. After a server restart, there is nowhere else
        // to recover it. Old bindings do not name an iteration, so they are deleted. Their tasks
        // become orphans, and the orchestrator cancels them and schedules generation again.
        name: '012-route-task-iteration',
        sql: `
            ALTER TABLE route_tasks ADD COLUMN diff_id TEXT;

            DELETE FROM route_tasks;
        `,
    },
    {
        // Adds iteration to reading progress. File marks and
        // seen ranges are keyed by iteration, stop marks by snapshot. After a push, progress
        // in the previous iteration must stay readable, and stops in the new snapshot receive their
        // marks through carryover. `progress_carries` records completed carryovers. Recalculating would restore
        // a mark the reviewer had already cleared.
        //
        // SQLite cannot change a PK, so tables are recreated with a copy (as in `010`).
        // Rows from the accumulated database move to the active iteration, or, if absent, the current
        // snapshot's iteration, or, if that is absent too, `unknown` (`LEGACY_DIFF_ID`). Such a server has no host,
        // and this is its only "iteration". Stop marks without a snapshot have no meaning
        // and are deleted.
        name: '013-progress-iterations',
        sql: `
            CREATE TABLE file_progress_next (
                diff_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (diff_id, file_id)
            );

            INSERT INTO file_progress_next (diff_id, file_id, viewed, updated_at)
            SELECT COALESCE(
                       (SELECT diff_id FROM iterations WHERE status = 'active' LIMIT 1),
                       (SELECT s.diff_id FROM route_snapshots s
                          JOIN route_state r ON r.current_snapshot_id = s.snapshot_id LIMIT 1),
                       'unknown'
                   ),
                   file_id, viewed, updated_at
              FROM file_progress;

            DROP TABLE file_progress;
            ALTER TABLE file_progress_next RENAME TO file_progress;

            CREATE TABLE file_seen_ranges_next (
                diff_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                side TEXT NOT NULL CHECK (side IN ('old', 'new')),
                start_line INTEGER NOT NULL CHECK (start_line >= 1),
                end_line INTEGER NOT NULL CHECK (end_line >= start_line),
                source_stop_id TEXT,
                carried_from TEXT
            );

            INSERT INTO file_seen_ranges_next (
                diff_id, file_id, side, start_line, end_line, source_stop_id, carried_from
            )
            SELECT COALESCE(
                       (SELECT diff_id FROM iterations WHERE status = 'active' LIMIT 1),
                       (SELECT s.diff_id FROM route_snapshots s
                          JOIN route_state r ON r.current_snapshot_id = s.snapshot_id LIMIT 1),
                       'unknown'
                   ),
                   file_id, side, start_line, end_line, source_stop_id, NULL
              FROM file_seen_ranges;

            DROP TABLE file_seen_ranges;
            ALTER TABLE file_seen_ranges_next RENAME TO file_seen_ranges;

            CREATE INDEX file_seen_ranges_file ON file_seen_ranges (diff_id, file_id);
            CREATE INDEX file_seen_ranges_stop ON file_seen_ranges (source_stop_id);

            CREATE TABLE stop_progress_next (
                snapshot_id TEXT NOT NULL,
                stop_id TEXT NOT NULL,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (snapshot_id, stop_id)
            );

            INSERT INTO stop_progress_next (snapshot_id, stop_id, viewed, updated_at)
            SELECT (SELECT current_snapshot_id FROM route_state), stop_id, viewed, updated_at
              FROM stop_progress
             WHERE (SELECT current_snapshot_id FROM route_state) IS NOT NULL;

            DROP TABLE stop_progress;
            ALTER TABLE stop_progress_next RENAME TO stop_progress;

            CREATE TABLE progress_carries (
                from_diff_id TEXT NOT NULL,
                to_diff_id TEXT NOT NULL,
                carried_at TEXT NOT NULL,
                PRIMARY KEY (from_diff_id, to_diff_id)
            );
        `,
    },
    {
        // Note anchors after a push. `anchor` and `commit_hash` describe the note's current
        // location and move to the new iteration, so the original location gets its own
        // columns. The contract's `origin` never changes. `lost_anchor` means a push rewrote the actual
        // lines, leaving nowhere to carry the note. It leaves the code and stays in chat with a label.
        //
        // Number 013 is taken by the progress carryover migration.
        name: '014-notes-anchors',
        sql: `
            ALTER TABLE agent_notes ADD COLUMN lost_anchor INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE agent_notes ADD COLUMN origin_anchor TEXT;
            ALTER TABLE agent_notes ADD COLUMN origin_commit TEXT;

            UPDATE agent_notes SET origin_anchor = anchor, origin_commit = commit_hash;
        `,
    },
    {
        // Tracks mark carryover to a snapshot. Snapshot freezing repeats when
        // a stop is filled, while "N of M carried over" adds up across passes. Without recording
        // that a stop has already been counted, the second pass would count it again.
        name: '015-stop-carried',
        sql: `
            ALTER TABLE stop_progress ADD COLUMN carried INTEGER NOT NULL DEFAULT 0;
        `,
    },
    {
        // File path beside its `fileId` in progress records. The review host's `fileId` is
        // opaque id, so records from two iterations can only be matched through a path.
        // The path came from the saved source iteration patch, but iterations recorded by server
        // 0.3.x have no patch and never will. Carryover silently returned zero.
        //
        // No backfill for the same reason: there is nothing to resolve old `fileId` values against. The carryover
        // resolver handles them through fallbacks (source patch, snapshot and note anchors). New
        // records contain the path and no longer depend on retaining the patch.
        name: '016-progress-paths',
        sql: `
            ALTER TABLE file_seen_ranges ADD COLUMN path TEXT;
            ALTER TABLE file_progress ADD COLUMN path TEXT;
        `,
    },
    {
        // The language the agent uses with the reviewer: a third session label beside the harness
        // and model. The UI uses it as a hint in locale selection, not an instruction.
        name: '017-worker-lang',
        sql: `
            ALTER TABLE worker ADD COLUMN lang TEXT;
        `,
    },
    {
        // Draft buffer (docs/architecture.md §6, "drafts are never lost"): text the server
        // accepted but has not delivered to the host. `id` is the composer's `clientKey`, so repeating the same
        // write upserts the row instead of adding another. `idempotency_key` is created with the
        // row and survives every attempt. If the host has already accepted the write, retrying with the same
        // key creates no duplicate. `draft_json` is a `commentDraftSchema` blob, like a route snapshot:
        // the contract describes its shape, so there is no need to duplicate it in columns.
        name: '018-draft-buffer',
        sql: `
            CREATE TABLE draft_buffer (
                id TEXT PRIMARY KEY,
                comment_id TEXT,
                draft_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('pending', 'failed')),
                error TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                idempotency_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `,
    },
    {
        // Drafts created from buffer entries: `id` is the same composer `clientKey`,
        // and the pair survives deletion of the buffer row. Without it, another write with the same key would reach
        // the host as a create operation. The idempotency key would return the existing comment with
        // its old text, silently losing the new text (the server would consider the write saved).
        name: '019-draft-buffer-saved',
        sql: `
            CREATE TABLE draft_buffer_saved (
                id TEXT PRIMARY KEY,
                comment_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        `,
    },
    {
        // Requested response language: the retry prompt must use the language of
        // the original question, or the answer would switch languages mid-feed. NULL means the exchange predates the column,
        // so its language was not recorded. There is no backfill. The reader interprets NULL as `en`.
        name: '020-chat-locale',
        sql: `
            ALTER TABLE chat_exchanges ADD COLUMN locale TEXT;
        `,
    },
    {
        // Links a local review round to its `review.feedback` task. The rounds themselves live in
        // the host file. This only links to the queue, and it must survive a restart. Otherwise,
        // reconciliation would schedule a second task for the same round. `state` distinguishes an open task from
        // a failed one. Failure leaves the round `pending`, but nothing schedules it again,
        // or the loop would keep running the same unmanageable task. `locale` is the language in which
        // the task requested an answer. It also determines validation of the submitted result, so a settings change
        // between scheduling and submission must not affect validation.
        name: '021-feedback-tasks',
        sql: `
            CREATE TABLE feedback_tasks (
                round_id TEXT PRIMARY KEY,
                task_id INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('open', 'done', 'failed')),
                locale TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `,
    },
];

/** Schema version key in the `meta` table. */
export const SCHEMA_VERSION_KEY = 'schema_version';
