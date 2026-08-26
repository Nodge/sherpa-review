import type { UiFileProgress, UiSeenRange, UiStopProgress, UiStopSeenRange } from '@sherpa/protocol';

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

interface StopRow extends SqlRow {
    stop_id: string;
    viewed: number;
}

/**
 * PR reading progress (T8, requirements §5, decision log 2026-08-22). This PR SQLite DB is the source of truth,
 * independent of the host and tab memory.
 *
 * A file record exists only after an explicit reviewer action (`viewed: true` pins
 * `read` permanently, `viewed: false` unpins it). The UI interprets missing records. Seen ranges
 * come from stop marks (M2-T7): the UI calculates them from its diff model, the server stores them
 * bound to the stop without interpreting them.
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
    private readonly txSetStopViewed: (
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => boolean;
    private readonly txClearStops: () => boolean;

    private revisionValue = 0;
    private closed = false;

    constructor(options: ProgressStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txSetViewed = transaction(this.db, (fileId: string, viewed: boolean) =>
            this.setViewedInTransaction(fileId, viewed),
        );
        this.txSetStopViewed = transaction(
            this.db,
            (stopId: string, viewed: boolean, ranges: readonly UiStopSeenRange[]) =>
                this.setStopViewedInTransaction(stopId, viewed, ranges),
        );
        this.txClearStops = transaction(this.db, () => this.clearStopsInTransaction());
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

    /** Route stop marks. The UI treats a missing record as "not viewed". */
    readStops(): UiStopProgress[] {
        const rows = this.db.prepare('SELECT stop_id, viewed FROM stop_progress ORDER BY stop_id').all() as StopRow[];
        return rows.map((row) => ({ stopId: row.stop_id, viewed: row.viewed === 1 }));
    }

    /** Explicit reviewer mark. Returns the current revision for the endpoint response. */
    setFileViewed(fileId: string, viewed: boolean): number {
        return this.bumped(this.txSetViewed(fileId, viewed));
    }

    /**
     * A stop mark and its seen ranges in one transaction (decision log, 2026-08-26).
     * The UI computes ranges. The server stores only their link to the stop without interpreting them,
     * so clearing the mark deletes exactly those ranges. With `viewed: false`, incoming ranges are ignored.
     */
    setStopViewed(stopId: string, viewed: boolean, ranges: readonly UiStopSeenRange[]): number {
        return this.bumped(this.txSetStopViewed(stopId, viewed, ranges));
    }

    /**
     * A new route generation removes old stops, so their marks and ranges
     * are erased (progress carryover is M4). Manual file marks stay untouched.
     */
    clearStopProgress(): number {
        return this.bumped(this.txClearStops());
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

    /** The revision increases and notifies tabs only on an actual storage change. */
    private bumped(changed: boolean): number {
        if (!changed) {
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

    /**
     * `false` means the same mark with the same set of ranges, so no tabs need notifying. Compares
     * canonical sets, so request order and duplicates do not affect the revision.
     */
    private setStopViewedInTransaction(
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ): boolean {
        const next = viewed ? canonicalRanges(ranges) : [];
        const existing = this.db.prepare('SELECT stop_id, viewed FROM stop_progress WHERE stop_id = ?').get(stopId) as
            | StopRow
            | undefined;
        const currentRows = this.db
            .prepare('SELECT file_id, side, start_line, end_line FROM file_seen_ranges WHERE source_stop_id = ?')
            .all(stopId) as RangeRow[];
        const current = canonicalRanges(
            currentRows.map((row) => ({
                fileId: row.file_id,
                side: row.side === 'old' ? 'old' : 'new',
                start: row.start_line,
                end: row.end_line,
            })),
        );
        if (existing !== undefined && (existing.viewed === 1) === viewed && sameRanges(current, next)) {
            return false;
        }

        this.db.prepare('DELETE FROM file_seen_ranges WHERE source_stop_id = ?').run(stopId);
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (file_id, side, start_line, end_line, source_stop_id)
             VALUES (?, ?, ?, ?, ?)`,
        );
        for (const range of next) {
            insert.run(range.fileId, range.side, range.start, range.end, stopId);
        }
        this.db
            .prepare(
                `INSERT INTO stop_progress (stop_id, viewed, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(stop_id) DO UPDATE SET viewed = excluded.viewed, updated_at = excluded.updated_at`,
            )
            .run(stopId, viewed ? 1 : 0, this.now().toISOString());
        return true;
    }

    private clearStopsInTransaction(): boolean {
        const ranges = this.db.prepare('DELETE FROM file_seen_ranges WHERE source_stop_id IS NOT NULL').run();
        const stops = this.db.prepare('DELETE FROM stop_progress').run();
        return ranges.changes > 0 || stops.changes > 0;
    }
}

/** Ranges in comparable form: deduplicated and in a consistent order. */
function canonicalRanges(ranges: readonly UiStopSeenRange[]): UiStopSeenRange[] {
    const unique = new Map<string, UiStopSeenRange>();
    for (const range of ranges) {
        unique.set(`${range.fileId}\u0000${range.side}\u0000${String(range.start)}\u0000${String(range.end)}`, range);
    }
    return [...unique.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([, range]) => range);
}

function sameRanges(left: readonly UiStopSeenRange[], right: readonly UiStopSeenRange[]): boolean {
    return (
        left.length === right.length &&
        left.every((range, index) => {
            const other = right[index];
            return (
                other?.fileId === range.fileId &&
                other.side === range.side &&
                other.start === range.start &&
                other.end === range.end
            );
        })
    );
}
