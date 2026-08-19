/** Schema migration: the name is fixed forever. SQL runs once and is never rewritten. */
export interface Migration {
    readonly name: string;
    readonly sql: string;
}

/**
 * Migrations run in order. The schema version equals the number of applied migrations
 * and is stored in `meta.schema_version`. Queue tables arrive in M0-T4.
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
];

/** Schema version key in the `meta` table. */
export const SCHEMA_VERSION_KEY = 'schema_version';
