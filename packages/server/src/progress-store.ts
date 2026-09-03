import type {
    HostId,
    PrDiff,
    RouteAnchor,
    UiFileProgress,
    UiSeenRange,
    UiStopProgress,
    UiStopSeenRange,
} from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { LEGACY_DIFF_ID } from './iterations/index.js';
import type { ChangedFile } from './route/diff-index.js';
import { indexDiff } from './route/diff-index.js';
import type { LineRange } from './route/ranges.js';

/** Progress change listener, consumed by the UI SSE channel (`UI_PROGRESS_EVENT`). */
export type ProgressListener = (revision: number) => void;

export interface ProgressStoreOptions {
    readonly db: SherpaDatabase;
    /** Iteration patches: carryover maps `fileId` between iterations through `path`. */
    readonly iterations?: Pick<IterationStore, 'get'> | null;
    /** Injectable clock: tests can check `updated_at` without real time. */
    readonly now?: () => Date;
    /** Where to write carryover counters. Defaults to stderr. */
    readonly log?: (message: string) => void;
}

/** Result of range carryover between iterations. `skipped` means nothing was written to storage. */
export interface CarryResult {
    readonly ranges: number;
    readonly files: number;
    readonly skipped: boolean;
}

/** Inputs for carrying stop marks over to a new snapshot (`carryStopsInTransaction`). */
export interface StopCarryInput {
    readonly snapshotId: string;
    /** Snapshot iteration: carried ranges and file marks are stored under it. */
    readonly diffId: HostId;
    readonly stops: readonly StopAnchors[];
    /** Snapshot iteration diff: provides changed lines and `fileId` for an anchor path. */
    readonly diff: PrDiff;
}

export interface StopAnchors {
    readonly id: string;
    readonly anchors: readonly RouteAnchor[];
}

/** Stop mark carryover result. The revision takes effect only after the shared transaction commits. */
export interface StopCarryResult {
    readonly kept: number;
    readonly afterCommit: () => void;
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

/** The same row with the mark's source: null for carryover or file reading, otherwise a stop id. */
interface SourcedRangeRow extends RangeRow {
    source_stop_id: string | null;
}

interface StopRow extends SqlRow {
    stop_id: string;
    viewed: number;
}

/** The same row with a flag marking the stop as already counted in carryover to this snapshot. */
interface CarriedStopRow extends StopRow {
    carried: number;
}

interface SourceStopRow extends SqlRow {
    source_stop_id: string;
}

interface DiffIdRow extends SqlRow {
    diff_id: string;
}

/** A range in the coordinates of one side of an iteration file. */
interface SeenRange {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
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
 * Everything is scoped to an iteration (M4-T6): files and ranges are keyed by `diffId`, stop marks
 * by snapshot. Endpoints know which iteration is active. The store receives it as an argument.
 * After a push, progress moves to a new iteration through `carryRanges`, while stop marks for the new
 * snapshot are set by `carryStopsInTransaction` during route acceptance.
 *
 * The revision increases monotonically from server startup (`ReviewFeed.revision` semantics):
 * a tab must reread the endpoint if it has increased since last seen. Idempotent writes leave it
 * unchanged because there is nothing to notify other tabs about.
 */
export class ProgressStore {
    private readonly db: SherpaDatabase;
    private readonly iterations: Pick<IterationStore, 'get'> | null;
    private readonly now: () => Date;
    private readonly log: (message: string) => void;
    private readonly listeners = new Set<ProgressListener>();
    private readonly txSetViewed: (
        diffId: HostId,
        fileId: string,
        viewed: boolean,
        snapshotId: string | null,
    ) => boolean;
    private readonly txSetStopViewed: (
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => boolean;
    private readonly txAdoptLegacy: (diffId: HostId) => boolean;
    private readonly txCarryRanges: (from: HostId, to: HostId, map: IterationMap) => CarryResult;

    private revisionValue = 0;
    private closed = false;

    constructor(options: ProgressStoreOptions) {
        this.db = options.db;
        this.iterations = options.iterations ?? null;
        this.now = options.now ?? ((): Date => new Date());
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
        this.txSetViewed = transaction(
            this.db,
            (diffId: HostId, fileId: string, viewed: boolean, snapshotId: string | null) =>
                this.setViewedInTransaction(diffId, fileId, viewed, snapshotId),
        );
        this.txSetStopViewed = transaction(
            this.db,
            (
                snapshotId: string,
                diffId: HostId,
                stopId: string,
                viewed: boolean,
                ranges: readonly UiStopSeenRange[],
            ) => this.setStopViewedInTransaction(snapshotId, diffId, stopId, viewed, ranges),
        );
        this.txAdoptLegacy = transaction(this.db, (diffId: HostId) => this.adoptLegacyInTransaction(diffId));
        this.txCarryRanges = transaction(this.db, (from: HostId, to: HostId, map: IterationMap) =>
            this.carryRangesInTransaction(from, to, map),
        );
    }

    get revision(): number {
        return this.revisionValue;
    }

    /**
     * Progress for one iteration. A file with only ranges (M2) arrives
     * with `viewed: null`: the reviewer has made no decision, so the UI applies defaults and counts
     * ranges when needed.
     */
    read(diffId: HostId): UiFileProgress[] {
        const ranges = new Map<string, UiSeenRange[]>();
        const rangeRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line FROM file_seen_ranges
                  WHERE diff_id = ? ORDER BY rowid`,
            )
            .all(diffId) as RangeRow[];
        for (const row of rangeRows) {
            const list = ranges.get(row.file_id) ?? [];
            list.push({ side: sideOf(row.side), start: row.start_line, end: row.end_line });
            ranges.set(row.file_id, list);
        }

        const rows = this.db
            .prepare('SELECT file_id, viewed FROM file_progress WHERE diff_id = ?')
            .all(diffId) as ProgressRow[];
        const files: UiFileProgress[] = rows.map((row) => ({
            fileId: row.file_id,
            viewed: row.viewed === 1,
            seenRanges: ranges.get(row.file_id) ?? [],
        }));

        const marked = new Set(files.map((file) => file.fileId));
        for (const [fileId, seenRanges] of ranges) {
            if (!marked.has(fileId)) {
                files.push({ fileId, viewed: null, seenRanges });
            }
        }
        return files;
    }

    /** Snapshot stop marks. The UI treats a missing record as unviewed. */
    readStops(snapshotId: string): UiStopProgress[] {
        const rows = this.db
            .prepare('SELECT stop_id, viewed FROM stop_progress WHERE snapshot_id = ? ORDER BY stop_id')
            .all(snapshotId) as StopRow[];
        return rows.map((row) => ({ stopId: row.stop_id, viewed: row.viewed === 1 }));
    }

    /**
     * An explicit reviewer mark. Clearing a file also clears all stops whose ranges touched it:
     * the link lives here and must work outside the route view. The caller names the snapshot,
     * which keys stop marks. `null` means there is no route and nothing to clear.
     */
    setFileViewed(diffId: HostId, fileId: string, viewed: boolean, snapshotId: string | null = null): number {
        return this.bumped(this.txSetViewed(diffId, fileId, viewed, snapshotId));
    }

    /**
     * A stop mark and its seen ranges in one transaction (decision log, 2026-08-26).
     * The UI computes ranges. The server stores only their link to the stop without interpreting them,
     * so clearing the mark deletes exactly those ranges. With `viewed: false`, incoming ranges are ignored.
     */
    setStopViewed(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ): number {
        return this.bumped(this.txSetStopViewed(snapshotId, diffId, stopId, viewed, ranges));
    }

    /**
     * Progress recorded without an iteration (pre-M4 database or server running without a host) moves
     * to the active one. Idempotent: the active iteration's record wins on conflict.
     */
    adoptLegacy(activeDiffId: HostId): number {
        if (activeDiffId === LEGACY_DIFF_ID) {
            return this.revisionValue;
        }
        return this.bumped(this.txAdoptLegacy(activeDiffId));
    }

    /**
     * Iteration worth carrying progress from: the latest stored one with at least one record,
     * excluding `exclude` and `skip`. `null` means nothing to carry over.
     *
     * An iteration lost after a force-push can also be a source: its progress is the latest
     * and must be preserved. Not every host can produce a slice against it. After refusal, the caller
     * asks again with the rejected source in `skip`.
     */
    latestDiffIdWithProgress(exclude: HostId, skip: readonly HostId[] = []): HostId | null {
        const skipped = skip.length === 0 ? '' : `AND i.diff_id NOT IN (${skip.map(() => '?').join(', ')})`;
        const row = this.db
            .prepare(
                `SELECT i.diff_id FROM iterations i
                  WHERE i.diff_id <> ? ${skipped}
                    AND (EXISTS (SELECT 1 FROM file_progress p WHERE p.diff_id = i.diff_id)
                      OR EXISTS (SELECT 1 FROM file_seen_ranges r WHERE r.diff_id = i.diff_id))
                  ORDER BY i.created_at DESC, i.rowid DESC
                  LIMIT 1`,
            )
            .get(exclude, ...skip) as DiffIdRow | undefined;
        return row?.diff_id ?? null;
    }

    /**
     * Carry seen ranges and file marks from one iteration to another (planning decision 4).
     * Files are matched by `path` and lines through `map`: lines touched by the interdiff
     * are not carried over at all.
     *
     * A pair is carried over exactly once (`progress_carries`): recalculating would restore a mark
     * the reviewer has already cleared. If either iteration's patch is missing from storage, carryover is incomplete
     * and retried on the next event.
     */
    carryRanges(fromDiffId: HostId, toDiffId: HostId, map: IterationMap): CarryResult {
        const result = this.txCarryRanges(fromDiffId, toDiffId, map);
        if (!result.skipped) {
            this.bumped(result.ranges > 0 || result.files > 0);
            this.log(
                `progress carryover ${fromDiffId} → ${toDiffId}: ranges ${String(result.ranges)}, ` +
                    `files ${String(result.files)}`,
            );
        }
        return result;
    }

    /**
     * Stop marks for the new snapshot, within its already open acceptance transaction
     * (server copy of the UI's `stopCoveredByProgress`). A stop counts as viewed
     * when each changed range is covered by seen ranges in the snapshot's iteration or by a file
     * pin. Its ranges are recorded as its own seen ranges so clearing
     * a file also clears the carried stop mark.
     *
     * An existing stop record in this snapshot is never rewritten: carryover does not override
     * the reviewer's decision. It counts in `kept` only if covered by other ranges:
     * while the snapshot was being filled, the tab could mark a stop covered by carryover itself,
     * and the banner count must not depend on who wrote the row first. A decided stop's own ranges
     * do not count in this check, otherwise "N carried over" would include stops
     * read manually in the new iteration.
     *
     * `kept` counts stops credited in this pass: filling a stop freezes the snapshot again,
     * and the caller sums the passes. A counted stop is flagged
     * in `stop_progress.carried` so the next pass does not count it again.
     */
    carryStopsInTransaction(input: StopCarryInput): StopCarryResult {
        const index = indexDiff(input.diff);
        const decided = new Map(
            (
                this.db
                    .prepare('SELECT stop_id, viewed, carried FROM stop_progress WHERE snapshot_id = ?')
                    .all(input.snapshotId) as CarriedStopRow[]
            ).map((row) => [row.stop_id, { viewed: row.viewed === 1, carried: row.carried === 1 }]),
        );
        const rows = this.seenRangesOf(input.diffId);
        const covered = mergeRanges(rows);
        const pinned = new Set(
            (
                this.db
                    .prepare('SELECT file_id FROM file_progress WHERE diff_id = ? AND viewed = 1')
                    .all(input.diffId) as ProgressRow[]
            ).map((row) => row.file_id),
        );

        let kept = 0;
        for (const stop of input.stops) {
            const required = requiredRanges(stop.anchors, index);
            if (required.length === 0) {
                continue;
            }
            const already = decided.get(stop.id);
            if (already?.carried === true) {
                continue;
            }
            if (already !== undefined) {
                const others = mergeRanges(rows.filter((row) => row.source_stop_id !== stop.id));
                if (already.viewed && coversAll(required, others, pinned)) {
                    this.markStopCarried(input.snapshotId, stop.id);
                    kept += 1;
                }
                continue;
            }
            if (!coversAll(required, covered, pinned)) {
                continue;
            }
            this.writeCarriedStop(input.snapshotId, input.diffId, stop.id, required);
            kept += 1;
        }

        return {
            kept,
            afterCommit: () => {
                this.bumped(kept > 0);
            },
        };
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
    private setViewedInTransaction(
        diffId: HostId,
        fileId: string,
        viewed: boolean,
        snapshotId: string | null,
    ): boolean {
        // Unpinning clears all viewed progress for the file, including stop ranges and carried ranges.
        const sourceStops = viewed
            ? []
            : (this.db
                  .prepare(
                      `SELECT DISTINCT source_stop_id FROM file_seen_ranges
                       WHERE diff_id = ? AND file_id = ? AND source_stop_id IS NOT NULL`,
                  )
                  .all(diffId, fileId) as SourceStopRow[]);
        const existing = this.db
            .prepare('SELECT viewed FROM file_progress WHERE diff_id = ? AND file_id = ?')
            .get(diffId, fileId) as ProgressRow | undefined;
        const fileChanged = existing === undefined || (existing.viewed === 1) !== viewed;
        const updatedAt = this.now().toISOString();

        if (fileChanged) {
            this.db
                .prepare(
                    `INSERT INTO file_progress (diff_id, file_id, viewed, updated_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT(diff_id, file_id) DO UPDATE SET
                        viewed = excluded.viewed, updated_at = excluded.updated_at`,
                )
                .run(diffId, fileId, viewed ? 1 : 0, updatedAt);
        }

        let rangesDropped = false;
        if (!viewed) {
            const removed = this.db
                .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND file_id = ?')
                .run(diffId, fileId);
            rangesDropped = removed.changes > 0;
        }
        for (const row of sourceStops) {
            // The stop also spans other files: clearing its mark removes all its ranges.
            this.db
                .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND source_stop_id = ?')
                .run(diffId, row.source_stop_id);
            if (snapshotId !== null) {
                this.db
                    .prepare(
                        `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, updated_at)
                         VALUES (?, ?, 0, ?)
                         ON CONFLICT(snapshot_id, stop_id) DO UPDATE SET
                            viewed = 0, updated_at = excluded.updated_at`,
                    )
                    .run(snapshotId, row.source_stop_id, updatedAt);
            }
        }
        return fileChanged || rangesDropped || sourceStops.length > 0;
    }

    /**
     * `false` means the same mark with the same set of ranges, so no tabs need notifying. Compares
     * canonical sets, so request order and duplicates do not affect the revision.
     */
    private setStopViewedInTransaction(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ): boolean {
        const next = viewed ? canonicalRanges(ranges) : [];
        const existing = this.db
            .prepare('SELECT stop_id, viewed FROM stop_progress WHERE snapshot_id = ? AND stop_id = ?')
            .get(snapshotId, stopId) as StopRow | undefined;
        const currentRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line FROM file_seen_ranges
                  WHERE diff_id = ? AND source_stop_id = ?`,
            )
            .all(diffId, stopId) as RangeRow[];
        const current = canonicalRanges(
            currentRows.map((row) => ({
                fileId: row.file_id,
                side: sideOf(row.side),
                start: row.start_line,
                end: row.end_line,
            })),
        );
        if (existing !== undefined && (existing.viewed === 1) === viewed && sameRanges(current, next)) {
            return false;
        }

        this.db
            .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND source_stop_id = ?')
            .run(diffId, stopId);
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line, source_stop_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const range of next) {
            insert.run(diffId, range.fileId, range.side, range.start, range.end, stopId);
        }
        this.db
            .prepare(
                `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(snapshot_id, stop_id) DO UPDATE SET
                    viewed = excluded.viewed, updated_at = excluded.updated_at`,
            )
            .run(snapshotId, stopId, viewed ? 1 : 0, this.now().toISOString());
        return true;
    }

    private adoptLegacyInTransaction(activeDiffId: HostId): boolean {
        const files = this.db
            .prepare(
                `INSERT OR IGNORE INTO file_progress (diff_id, file_id, viewed, updated_at)
                 SELECT ?, file_id, viewed, updated_at FROM file_progress WHERE diff_id = ?`,
            )
            .run(activeDiffId, LEGACY_DIFF_ID);
        const droppedFiles = this.db
            .prepare('DELETE FROM file_progress WHERE diff_id = ?')
            .run(LEGACY_DIFF_ID);
        // Ranges have no key, so duplicates are filtered by comparing rows.
        this.db
            .prepare(
                `DELETE FROM file_seen_ranges
                  WHERE diff_id = ?
                    AND EXISTS (
                        SELECT 1 FROM file_seen_ranges other
                         WHERE other.diff_id = ?
                           AND other.file_id = file_seen_ranges.file_id
                           AND other.side = file_seen_ranges.side
                           AND other.start_line = file_seen_ranges.start_line
                           AND other.end_line = file_seen_ranges.end_line
                    )`,
            )
            .run(LEGACY_DIFF_ID, activeDiffId);
        const ranges = this.db
            .prepare('UPDATE file_seen_ranges SET diff_id = ? WHERE diff_id = ?')
            .run(activeDiffId, LEGACY_DIFF_ID);
        return files.changes > 0 || droppedFiles.changes > 0 || ranges.changes > 0;
    }

    private carryRangesInTransaction(fromDiffId: HostId, toDiffId: HostId, map: IterationMap): CarryResult {
        const done = this.db
            .prepare('SELECT 1 AS ok FROM progress_carries WHERE from_diff_id = ? AND to_diff_id = ?')
            .get(fromDiffId, toDiffId);
        if (done !== undefined) {
            return { ranges: 0, files: 0, skipped: true };
        }

        const from = this.iterations?.get(fromDiffId) ?? null;
        const to = this.iterations?.get(toDiffId) ?? null;
        if (from === null || to === null) {
            this.log(`progress carryover ${fromDiffId} → ${toDiffId} deferred: iteration patch not stored`);
            return { ranges: 0, files: 0, skipped: true };
        }

        const pathOf = new Map(from.diff.files.map((file) => [file.fileId, file.path]));
        const idOfPath = new Map<string, string>();
        for (const file of to.diff.files) {
            // The first file with this path wins, as in `indexDiff`.
            if (!idOfPath.has(file.path)) {
                idOfPath.set(file.path, file.fileId);
            }
        }

        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, carried_from
             ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        );
        const written = new Set<string>();
        const rangeRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line FROM file_seen_ranges
                  WHERE diff_id = ? ORDER BY rowid`,
            )
            .all(fromDiffId) as RangeRow[];
        for (const row of rangeRows) {
            const path = pathOf.get(row.file_id);
            const fileId = path === undefined ? undefined : idOfPath.get(path);
            if (path === undefined || fileId === undefined) {
                continue;
            }
            const side = sideOf(row.side);
            const mapped = map.mapRange(path, side, { start: row.start_line, end: row.end_line });
            for (const range of mapped.carried) {
                const key = `${fileId} ${side} ${String(range.start)} ${String(range.end)}`;
                if (written.has(key)) {
                    continue;
                }
                written.add(key);
                insert.run(toDiffId, fileId, side, range.start, range.end, fromDiffId);
            }
        }

        let files = 0;
        const fileRows = this.db
            .prepare('SELECT file_id, viewed FROM file_progress WHERE diff_id = ?')
            .all(fromDiffId) as ProgressRow[];
        for (const row of fileRows) {
            const path = pathOf.get(row.file_id);
            const fileId = path === undefined ? undefined : idOfPath.get(path);
            if (path === undefined || fileId === undefined) {
                continue;
            }
            // The `read` pin survives only on an unchanged file. Unpinning is the reviewer's decision,
            // so it always carries over.
            if (row.viewed === 1 && map.fileStatus(path) !== 'unchanged') {
                continue;
            }
            const inserted = this.db
                .prepare(
                    `INSERT OR IGNORE INTO file_progress (diff_id, file_id, viewed, updated_at)
                     VALUES (?, ?, ?, ?)`,
                )
                .run(toDiffId, fileId, row.viewed, this.now().toISOString());
            files += inserted.changes > 0 ? 1 : 0;
        }

        this.db
            .prepare(
                'INSERT INTO progress_carries (from_diff_id, to_diff_id, carried_at) VALUES (?, ?, ?)',
            )
            .run(fromDiffId, toDiffId, this.now().toISOString());
        return { ranges: written.size, files, skipped: false };
    }

    /** Iteration seen ranges in merge order. `source_stop_id` identifies the mark's source. */
    private seenRangesOf(diffId: HostId): SourcedRangeRow[] {
        return this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line, source_stop_id FROM file_seen_ranges
                  WHERE diff_id = ? ORDER BY file_id, side, start_line`,
            )
            .all(diffId) as SourcedRangeRow[];
    }

    /** A carried stop mark with its ranges, just like a manual mark. */
    private writeCarriedStop(
        snapshotId: string,
        diffId: HostId,
        stopId: string,
        required: readonly SeenRange[],
    ): void {
        this.db
            .prepare('DELETE FROM file_seen_ranges WHERE diff_id = ? AND source_stop_id = ?')
            .run(diffId, stopId);
        const dropCarried = this.db.prepare(
            `DELETE FROM file_seen_ranges
              WHERE diff_id = ? AND file_id = ? AND side = ? AND start_line = ? AND end_line = ?
                AND source_stop_id IS NULL`,
        );
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (diff_id, file_id, side, start_line, end_line, source_stop_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const range of required) {
            // The same range is already stored as carried: it now belongs to the stop, with no duplicate.
            dropCarried.run(diffId, range.fileId, range.side, range.start, range.end);
            insert.run(diffId, range.fileId, range.side, range.start, range.end, stopId);
        }
        this.db
            .prepare(
                `INSERT INTO stop_progress (snapshot_id, stop_id, viewed, carried, updated_at)
                 VALUES (?, ?, 1, 1, ?)
                 ON CONFLICT(snapshot_id, stop_id) DO UPDATE SET
                    viewed = 1, carried = 1, updated_at = excluded.updated_at`,
            )
            .run(snapshotId, stopId, this.now().toISOString());
    }

    /** Flags an existing mark as counted in carryover, leaving ranges and the reviewer's decision intact. */
    private markStopCarried(snapshotId: string, stopId: string): void {
        this.db
            .prepare('UPDATE stop_progress SET carried = 1 WHERE snapshot_id = ? AND stop_id = ?')
            .run(snapshotId, stopId);
    }
}

/**
 * Changed diff lines within stop anchors, exactly those the UI marks as viewed
 * (`coveredChangedRanges`: added lines belong to `new`, removed to `old`). The server copy of the rule
 * is needed for mark carryover and tests that simulate a reviewer marking lines.
 */
export function requiredSeenRanges(anchors: readonly RouteAnchor[], diff: PrDiff): UiStopSeenRange[] {
    return requiredRanges(anchors, indexDiff(diff));
}

function requiredRanges(anchors: readonly RouteAnchor[], index: ReadonlyMap<string, ChangedFile>): SeenRange[] {
    const lines = new Map<string, { fileId: string; side: 'old' | 'new'; numbers: number[] }>();
    for (const anchor of anchors) {
        const file = index.get(anchor.path);
        if (file === undefined) {
            continue;
        }
        const key = `${file.fileId} ${anchor.side}`;
        const bucket = lines.get(key) ?? { fileId: file.fileId, side: anchor.side, numbers: [] };
        for (const line of anchor.side === 'old' ? file.old : file.new) {
            if (line >= anchor.start && line <= anchor.end) {
                bucket.numbers.push(line);
            }
        }
        lines.set(key, bucket);
    }

    const ranges: SeenRange[] = [];
    for (const bucket of lines.values()) {
        const sorted = [...new Set(bucket.numbers)].sort((left, right) => left - right);
        for (const line of sorted) {
            const last = ranges.at(-1);
            if (last?.fileId === bucket.fileId && last.side === bucket.side && line === last.end + 1) {
                ranges[ranges.length - 1] = { ...last, end: line };
                continue;
            }
            ranges.push({ fileId: bucket.fileId, side: bucket.side, start: line, end: line });
        }
    }
    return ranges;
}

/** Ranges by file and side, merged into continuous spans. The query orders the rows. */
function mergeRanges(rows: readonly SourcedRangeRow[]): Map<string, LineRange[]> {
    const covered = new Map<string, LineRange[]>();
    for (const row of rows) {
        const key = `${row.file_id} ${sideOf(row.side)}`;
        const spans = covered.get(key) ?? [];
        const last = spans.at(-1);
        if (last !== undefined && row.start_line <= last.end + 1) {
            spans[spans.length - 1] = { start: last.start, end: Math.max(last.end, row.end_line) };
        } else {
            spans.push({ start: row.start_line, end: row.end_line });
        }
        covered.set(key, spans);
    }
    return covered;
}

/** Each required range lies within a merged seen range or is covered by a file pin. */
function coversAll(
    required: readonly SeenRange[],
    covered: ReadonlyMap<string, LineRange[]>,
    pinned: ReadonlySet<string>,
): boolean {
    return required.every((range) => {
        if (pinned.has(range.fileId)) {
            return true;
        }
        const spans = covered.get(`${range.fileId} ${range.side}`) ?? [];
        return spans.some((span) => span.start <= range.start && span.end >= range.end);
    });
}

function sideOf(value: string): 'old' | 'new' {
    return value === 'old' ? 'old' : 'new';
}

/** Ranges in comparable form: deduplicated and in a consistent order. */
function canonicalRanges(ranges: readonly UiStopSeenRange[]): UiStopSeenRange[] {
    const unique = new Map<string, UiStopSeenRange>();
    for (const range of ranges) {
        unique.set(`${range.fileId} ${range.side} ${String(range.start)} ${String(range.end)}`, range);
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
