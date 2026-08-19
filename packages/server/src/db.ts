import Database from 'better-sqlite3';

import type { Migration } from './migrations.js';
import { MIGRATIONS, SCHEMA_VERSION_KEY } from './migrations.js';

export type SherpaDatabase = Database.Database;

/**
 * Opens (or creates) PR storage and brings its schema up to date.
 * WAL allows concurrent UI reads and worker writes (spec §1/C2).
 */
export function openDatabase(file: string, migrations: readonly Migration[] = MIGRATIONS): SherpaDatabase {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    try {
        applyMigrations(db, migrations);
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
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

        const run = db.transaction(() => {
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
