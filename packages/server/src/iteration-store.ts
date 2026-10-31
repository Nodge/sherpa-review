import type { HostId, Iteration, PrDiff, ReviewHost } from '@sherpa/protocol';
import { iterationSchema, prDiffSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';

/** An iteration together with its locally saved patch. */
export interface StoredIteration {
    readonly iteration: Iteration;
    readonly diff: PrDiff;
}

export interface IterationStoreOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock: patch load time in tests must not depend on system time. */
    readonly now?: () => Date;
}

interface IterationRow extends SqlRow {
    diff_id: string;
    base_commit: string;
    head_commit: string;
    created_at: string;
    status: string;
    diff_json: string;
}

interface InterdiffRow extends SqlRow {
    diff_json: string;
}

/**
 * PR iterations and their patches in the PR SQLite database (docs/product.md §4a).
 *
 * Why store the patch locally: after a force-push the host no longer returns the previous iteration, but the old
 * route snapshot must remain readable. The diff it was built from must therefore
 * be local. Interdiffs are cached here too: the host can take seconds to compute one,
 * so there is no reason to pay that cost twice.
 *
 * Fail-closed boundary, as in `route-store.ts`: writes and reads all pass through protocol
 * schemas. A corrupt row does not crash the server: warn on stderr and skip it.
 */
export class IterationStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly txSync: (statuses: ReadonlyMap<string, Iteration>, gone: readonly string[]) => void;

    constructor(options: IterationStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txSync = transaction(this.db, (statuses: ReadonlyMap<string, Iteration>, gone: readonly string[]) => {
            for (const [diffId, iteration] of statuses) {
                this.db
                    .prepare(
                        `UPDATE iterations
                            SET status = ?, base_commit = ?, head_commit = ?, created_at = ?
                          WHERE diff_id = ?`,
                    )
                    .run(iteration.status, iteration.baseCommit, iteration.headCommit, iteration.createdAt, diffId);
            }
            for (const diffId of gone) {
                this.db.prepare('UPDATE iterations SET status = ? WHERE diff_id = ?').run('gone', diffId);
            }
        });
    }

    /** Saves the iteration patch and metadata. Reloading the same iteration overwrites the row. */
    upsert(diff: PrDiff, iteration: Iteration): void {
        const parsedDiff = prDiffSchema.parse(diff);
        const parsedIteration = iterationSchema.parse(iteration);
        if (parsedIteration.diffId !== parsedDiff.diffId) {
            throw new Error(
                `iteration ${parsedIteration.diffId} and diff ${parsedDiff.diffId} refer to different iterations`,
            );
        }

        this.db
            .prepare(
                `INSERT INTO iterations (
                    diff_id, base_commit, head_commit, created_at, status, diff_json, fetched_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(diff_id) DO UPDATE SET
                    base_commit = excluded.base_commit, head_commit = excluded.head_commit,
                    created_at = excluded.created_at, status = excluded.status,
                    diff_json = excluded.diff_json, fetched_at = excluded.fetched_at`,
            )
            .run(
                parsedIteration.diffId,
                parsedIteration.baseCommit,
                parsedIteration.headCommit,
                parsedIteration.createdAt,
                parsedIteration.status,
                JSON.stringify(parsedDiff),
                this.now().toISOString(),
            );
    }

    /** Iteration with its patch. null means no local patch for this iteration (or a corrupt row). */
    get(diffId: HostId): StoredIteration | null {
        const row = this.db.prepare('SELECT * FROM iterations WHERE diff_id = ?').get(diffId) as
            | IterationRow
            | undefined;
        return row === undefined ? null : this.parseRow(row);
    }

    /** Saved iterations in order of appearance. */
    list(): Iteration[] {
        return this.rows().map((stored) => stored.iteration);
    }

    /**
     * Reconciles the host list with local storage: listed statuses come from the host, while a
     * saved iteration absent from the list becomes `gone`. Only the server sets this status
     * (`iterationStatusSchema` contract). Returns the combined list in chronological order.
     */
    sync(hostIterations: readonly Iteration[]): Iteration[] {
        const listed = hostIterations.map((iteration) => iterationSchema.parse(iteration));
        const byId = new Map(listed.map((iteration) => [iteration.diffId, iteration]));

        const stored = this.rows().map((row) => row.iteration);
        const known = new Map(stored.map((iteration) => [iteration.diffId, iteration]));
        const statuses = new Map<string, Iteration>();
        for (const iteration of listed) {
            if (known.has(iteration.diffId)) {
                statuses.set(iteration.diffId, iteration);
            }
        }
        const gone = stored
            .filter((iteration) => !byId.has(iteration.diffId))
            .map((iteration) => iteration.diffId);

        this.txSync(statuses, gone);

        const merged = [
            ...listed,
            ...stored
                .filter((iteration) => !byId.has(iteration.diffId))
                .map((iteration) => ({ ...iteration, status: 'gone' as const })),
        ];
        return merged.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    /**
     * Interdiff from the cache, or via `load` with a cache write on a miss. The caller
     * (host adapter) computes the slice, the store only remembers the result.
     */
    async getInterdiff(base: HostId, head: HostId, load: () => Promise<PrDiff>): Promise<PrDiff> {
        const cached = this.readInterdiff(base, head);
        if (cached !== null) {
            return cached;
        }

        const diff = prDiffSchema.parse(await load());
        this.db
            .prepare(
                `INSERT INTO interdiffs (base_id, head_id, diff_json, fetched_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(base_id, head_id) DO UPDATE SET
                    diff_json = excluded.diff_json, fetched_at = excluded.fetched_at`,
            )
            .run(base, head, JSON.stringify(diff), this.now().toISOString());
        return diff;
    }

    /**
     * Cached slice without a host call: generation result acceptance is synchronous and must not
     * use the network. If it was not fetched in advance, there is nothing to carry over.
     */
    peekInterdiff(base: HostId, head: HostId): PrDiff | null {
        return this.readInterdiff(base, head);
    }

    private readInterdiff(base: HostId, head: HostId): PrDiff | null {
        const row = this.db
            .prepare('SELECT diff_json FROM interdiffs WHERE base_id = ? AND head_id = ?')
            .get(base, head) as InterdiffRow | undefined;
        if (row === undefined) {
            return null;
        }

        try {
            return prDiffSchema.parse(JSON.parse(row.diff_json) as unknown);
        } catch (error) {
            process.stderr.write(
                `sherpa-review-server: slice cache ${base}→${head} is corrupt (${messageOf(error)}), recomputing\n`,
            );
            return null;
        }
    }

    private rows(): StoredIteration[] {
        const rows = this.db
            .prepare('SELECT * FROM iterations ORDER BY created_at, rowid')
            .all() as IterationRow[];
        return rows.flatMap((row) => {
            const stored = this.parseRow(row);
            return stored === null ? [] : [stored];
        });
    }

    private parseRow(row: IterationRow): StoredIteration | null {
        try {
            return {
                iteration: iterationSchema.parse({
                    diffId: row.diff_id,
                    baseCommit: row.base_commit,
                    headCommit: row.head_commit,
                    createdAt: row.created_at,
                    status: row.status,
                }),
                diff: prDiffSchema.parse(JSON.parse(row.diff_json) as unknown),
            };
        } catch (error) {
            process.stderr.write(
                `sherpa-review-server: stored iteration ${row.diff_id} is corrupt (${messageOf(error)}), skipped\n`,
            );
            return null;
        }
    }
}

/**
 * Saves a diff just loaded from the host in local patch storage. Called wherever
 * the server fetches the active diff (reader endpoint, route generation, chat), so storage
 * fills itself without a separate iteration scan.
 *
 * Never throws or waits: the endpoint response must not depend on the iteration list
 * or a SQLite write. If it fails, try next time.
 */
export async function rememberIterationDiff(
    store: IterationStore,
    host: ReviewHost,
    diff: PrDiff,
): Promise<void> {
    try {
        const iterations = await host.listIterations();
        const iteration = iterations.find((candidate) => candidate.diffId === diff.diffId);
        if (iteration === undefined) {
            // The author pushed a new diff while this one was loading: the host no longer lists this iteration metadata.
            process.stderr.write(
                `sherpa-review-server: iteration ${diff.diffId} is absent from the host list, patch not saved\n`,
            );
            return;
        }
        store.upsert(diff, iteration);
    } catch (error) {
        process.stderr.write(`sherpa-review-server: iteration patch not saved: ${messageOf(error)}\n`);
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
