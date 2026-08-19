import fs from 'node:fs/promises';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, readSchemaVersion } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { databasePathFor } from './paths.js';
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
        servers.push(await startServer({ prKey: 'github-quillmart--quillmart--42', sherpaDir }));
        const file = databasePathFor(sherpaDir, 'github-quillmart--quillmart--42');

        await expect(fs.stat(file)).resolves.toBeDefined();

        const reader = new Database(file, { readonly: true });
        try {
            expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');
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

        const db = new Database(file, { readonly: true });
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
