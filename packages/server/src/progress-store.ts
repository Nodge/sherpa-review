import type { UiFileProgress, UiSeenRange } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';

/** Progress change listener, consumed by the UI SSE channel (`UI_PROGRESS_EVENT`). */
export type ProgressListener = (revision: number) => void;

export interface ProgressStoreOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock: tests can check `updated_at` without real time. */
    readonly now?: () => Date;
}

interface ProgressRow extends SqlRow {
    file_id: string;
    viewed: number;
}

interface RangeRow extends SqlRow {
    file_id: string;
    side: string;
    start_line: number;
    end_line: number;
}

/**
 * PR reading progress (T8, requirements §5, decision log 2026-08-22). This PR SQLite DB is the source of truth,
 * independent of the host and tab memory.
 *
 * A file record exists only after an explicit reviewer action (`viewed: true` pins
 * `read` permanently, `viewed: false` unpins it). The UI interprets missing records. Seen ranges
 * can already be read. Writes arrive with M2 stops, and the server does not interpret them.
 *
 * The revision increases monotonically from server startup (`ReviewFeed.revision` semantics):
 * a tab must reread the endpoint if it has increased since last seen. Idempotent writes leave it
 * unchanged because there is nothing to notify other tabs about.
 */
export class ProgressStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly listeners = new Set<ProgressListener>();
    private readonly txSetViewed: (fileId: string, viewed: boolean) => boolean;

    private revisionValue = 0;
    private closed = false;

    constructor(options: ProgressStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txSetViewed = transaction(this.db, (fileId: string, viewed: boolean) =>
            this.setViewedInTransaction(fileId, viewed),
        );
    }

    get revision(): number {
        return this.revisionValue;
    }

    /**
     * All PR progress. A file with only ranges (M2) arrives with `viewed: false`:
     * it has no pin, and the UI calculates its state from ranges.
     */
    read(): UiFileProgress[] {
        const ranges = new Map<string, UiSeenRange[]>();
        const rangeRows = this.db
            .prepare('SELECT file_id, side, start_line, end_line FROM file_seen_ranges ORDER BY rowid')
            .all() as RangeRow[];
        for (const row of rangeRows) {
            const list = ranges.get(row.file_id) ?? [];
            list.push({ side: row.side === 'old' ? 'old' : 'new', start: row.start_line, end: row.end_line });
            ranges.set(row.file_id, list);
        }

        const rows = this.db.prepare('SELECT file_id, viewed FROM file_progress').all() as ProgressRow[];
        const files: UiFileProgress[] = rows.map((row) => ({
            fileId: row.file_id,
            viewed: row.viewed === 1,
            seenRanges: ranges.get(row.file_id) ?? [],
        }));

        const marked = new Set(files.map((file) => file.fileId));
        for (const [fileId, seenRanges] of ranges) {
            if (!marked.has(fileId)) {
                files.push({ fileId, viewed: false, seenRanges });
            }
        }
        return files;
    }

    /** Explicit reviewer mark. Returns the current revision for the endpoint response. */
    setFileViewed(fileId: string, viewed: boolean): number {
        if (!this.txSetViewed(fileId, viewed)) {
            return this.revisionValue;
        }

        this.revisionValue += 1;
        if (!this.closed) {
            for (const listener of [...this.listeners]) {
                listener(this.revisionValue);
            }
        }
        return this.revisionValue;
    }

    subscribe(listener: ProgressListener): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.listeners.add(listener);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
        };
    }

    /** Releases listeners: the server is shutting down, so nobody remains to notify. */
    close(): void {
        this.closed = true;
        this.listeners.clear();
    }

    /** `false` means storage is unchanged: the same value was marked again. */
    private setViewedInTransaction(fileId: string, viewed: boolean): boolean {
        const existing = this.db.prepare('SELECT viewed FROM file_progress WHERE file_id = ?').get(fileId) as
            | ProgressRow
            | undefined;
        if (existing !== undefined && (existing.viewed === 1) === viewed) {
            return false;
        }

        this.db
            .prepare(
                `INSERT INTO file_progress (file_id, viewed, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(file_id) DO UPDATE SET viewed = excluded.viewed, updated_at = excluded.updated_at`,
            )
            .run(fileId, viewed ? 1 : 0, this.now().toISOString());
        return true;
    }
}
