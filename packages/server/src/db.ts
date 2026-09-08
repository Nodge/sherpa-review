import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';

import type { Migration } from './migrations.js';
import { MIGRATIONS, SCHEMA_VERSION_KEY } from './migrations.js';

export type SherpaDatabase = NodeSqlite.DatabaseSync;

/**
 * `node:sqlite` loads on demand instead of through a static import. The module does not exist before Node 22.13,
 * so a static import would kill the process with a raw Node error during linking, before
 * `checkNodeVersion` (see `runtime.ts`) could explain what to do. The import above
 * is for types only and is erased during the build.
 */
function loadSqlite(): typeof NodeSqlite {
    return createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;
}

/**
 * A query row as returned by node:sqlite, an unnamed record of columns. The caller defines
 * the table shape. Its row interface extends this type, otherwise TS rejects a cast
 * from the query result to that interface.
 */
export type SqlRow = Record<string, NodeSqlite.SQLOutputValue>;

/**
 * Opens (or creates) PR storage and brings its schema up to date.
 * WAL allows UI readers and worker writes to run concurrently (docs/architecture.md §1).
 */
export function openDatabase(file: string, migrations: readonly Migration[] = MIGRATIONS): SherpaDatabase {
    const db = new (loadSqlite().DatabaseSync)(file);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');

    try {
        applyMigrations(db, migrations);
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
}

/**
 * Wraps a function in a transaction. The built-in `node:sqlite` has no helper of its own.
 * `BEGIN IMMEDIATE` takes the lock up front because every server transaction intends to write,
 * instead of taking it midway through an operation. A returned value commits, an exception rolls back.
 * The queue and worker registry `Outcome` pattern relies on this: a domain error travels as a value
 * (and stays in storage), while an exception cancels everything.
 *
 * Nested calls are unsupported (no savepoints). The second `BEGIN` fails.
 */
export function transaction<A extends unknown[], R>(db: SherpaDatabase, body: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
        db.exec('BEGIN IMMEDIATE;');

        try {
            const result = body(...args);
            // Commit inside try: a failed COMMIT (I/O, disk full) must leave the connection
            // outside a transaction, otherwise every later server operation fails with "transaction within a transaction".
            db.exec('COMMIT;');
            return result;
        } catch (error) {
            try {
                db.exec('ROLLBACK;');
            } catch {
                // SQLite may have rolled back the transaction itself, leaving nothing to roll back.
            }
            throw error;
        }
    };
}

/** Applies pending migrations in order, each in its own transaction. */
export function applyMigrations(db: SherpaDatabase, migrations: readonly Migration[] = MIGRATIONS): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
        );
    `);

    const appliedRows = db.prepare('SELECT name FROM migrations').all() as { name: string }[];
    const applied = new Set(appliedRows.map((row) => row.name));

    for (const migration of migrations) {
        if (applied.has(migration.name)) {
            continue;
        }

        const run = transaction(db, () => {
            db.exec(migration.sql);
            db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
                migration.name,
                new Date().toISOString(),
            );
        });
        run();
    }

    db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(SCHEMA_VERSION_KEY, String(migrations.length));
}

/** Schema version from `meta`. `null` if storage has not been migrated yet. */
export function readSchemaVersion(db: SherpaDatabase): string | null {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as
        | { value: string }
        | undefined;
    return row?.value ?? null;
}
