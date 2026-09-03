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
    /** Number of source ranges, against which the result is counted. */
    readonly sourceRanges: number;
    /** Ranges whose `fileId` no resolver layer could map to a path: mapping failures. */
    readonly unmappedRanges: number;
    /** Ranges with a known path but no file in the target iteration: an author edit. */
    readonly missingRanges: number;
    /** Source ranges touched by the interdiff: carried over partly or not at all. */
    readonly touchedRanges: number;
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

/** The same row with a file path: filled for 0.5.x records and empty for all earlier ones. */
interface PathedRangeRow extends RangeRow {
    path: string | null;
}

interface PathedProgressRow extends ProgressRow {
    path: string | null;
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

interface CountRow extends SqlRow {
    count: number;
}

/** Route snapshot or note anchor JSON blob: parsed manually without the protocol schema. */
interface JsonRow extends SqlRow {
    json: string;
}

/** Both note anchors: current and original (`014-notes-anchors` migration). */
interface NoteAnchorRow extends SqlRow {
    anchor: string;
    origin_anchor: string | null;
}

/** All carryover needs from an external anchor: a mapping from opaque `fileId` to path. */
interface AnchorPath {
    readonly fileId: string;
    readonly path: string;
}

/** Where a source record lands in the target iteration (`carryRangesInTransaction`). */
type Resolution =
    | { readonly kind: 'mapped'; readonly path: string; readonly fileId: string }
    | { readonly kind: 'unmapped' }
    | { readonly kind: 'missing' };

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

    /** Last parsed iteration path map: patch parsing is expensive and the patch is immutable. */
    private pathCache: { diffId: HostId; paths: ReadonlyMap<string, string> } | null = null;
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
     * An iteration worth carrying progress from: the latest with at least one record,
     * excluding `exclude`, `skip` and `LEGACY_DIFF_ID`. `null` means there is nothing to carry over.
     *
     * Candidates come from progress records themselves rather than `iterations`: a row there exists
     * only for an iteration active while 0.4.x was running (`IterationStore.upsert`), so
     * progress recorded by server 0.3.x would never become a source (M5-T20). For freshness,
     * recency comes from the iteration's route snapshots, or as a last resort,
     * from the time of the latest file mark.
     *
     * An iteration lost after a force-push can also be a source: its progress is the latest
     * and must be preserved. Not every host can produce a slice against it. After refusal, the caller
     * asks again with the rejected source in `skip`.
     */
    latestDiffIdWithProgress(exclude: HostId, skip: readonly HostId[] = []): HostId | null {
        const skipped = skip.length === 0 ? '' : `AND d.diff_id NOT IN (${skip.map(() => '?').join(', ')})`;
        const row = this.db
            .prepare(
                `SELECT d.diff_id FROM (
                        SELECT diff_id FROM file_seen_ranges
                        UNION
                        SELECT diff_id FROM file_progress
                    ) d
                  WHERE d.diff_id <> ? AND d.diff_id <> ? ${skipped}
                  ORDER BY COALESCE(
                        (SELECT i.created_at FROM iterations i WHERE i.diff_id = d.diff_id),
                        (SELECT MAX(s.created_at) FROM route_snapshots s WHERE s.diff_id = d.diff_id),
                        (SELECT MAX(p.updated_at) FROM file_progress p WHERE p.diff_id = d.diff_id)
                    ) DESC, d.diff_id DESC
                  LIMIT 1`,
            )
            .get(exclude, LEGACY_DIFF_ID, ...skip) as DiffIdRow | undefined;
        return row?.diff_id ?? null;
    }

    /**
     * How many ranges the iteration received through carryover. Answers "0 stops carried over:
     * did no ranges arrive, or did they arrive without covering a single stop?" (M5-T20).
     */
    carriedRangeCount(diffId: HostId): number {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS count FROM file_seen_ranges
                  WHERE diff_id = ? AND carried_from IS NOT NULL`,
            )
            .get(diffId) as CountRow | undefined;
        return row?.count ?? 0;
    }

    /**
     * Carry seen ranges and file marks from one iteration to another (planning decision 4).
     * Files are matched by `path` and lines through `map`: lines touched by the interdiff
     * are not carried over at all.
     *
     * A pair is carried over exactly once (`progress_carries`): recalculating would restore a mark
     * the reviewer has already cleared. Without a stored target iteration patch, carryover is skipped
     * and retried on the next event.
     */
    carryRanges(fromDiffId: HostId, toDiffId: HostId, map: IterationMap): CarryResult {
        const result = this.txCarryRanges(fromDiffId, toDiffId, map);
        if (!result.skipped) {
            this.bumped(result.ranges > 0 || result.files > 0);
            this.log(`progress carryover ${fromDiffId} → ${toDiffId}: ${carrySummary(result)}`);
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
                    `INSERT INTO file_progress (diff_id, file_id, viewed, updated_at, path)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(diff_id, file_id) DO UPDATE SET
                        viewed = excluded.viewed, updated_at = excluded.updated_at,
                        path = COALESCE(excluded.path, file_progress.path)`,
                )
                .run(diffId, fileId, viewed ? 1 : 0, updatedAt, this.pathsOf(diffId).get(fileId) ?? null);
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
        const paths = this.pathsOf(diffId);
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, path
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const range of next) {
            insert.run(
                diffId,
                range.fileId,
                range.side,
                range.start,
                range.end,
                stopId,
                paths.get(range.fileId) ?? null,
            );
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
                `INSERT OR IGNORE INTO file_progress (diff_id, file_id, viewed, updated_at, path)
                 SELECT ?, file_id, viewed, updated_at, path FROM file_progress WHERE diff_id = ?`,
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
            // The pair was already carried over. This is normal: many watcher events trigger a single
            // carryover, and repeating it would restore a mark the reviewer has cleared. Skip without logging.
            return skippedCarry();
        }

        const to = this.iterations?.get(toDiffId) ?? null;
        if (to === null) {
            // The target is the active iteration, whose patch the server stores itself: we get here only while
            // it is still loading. Carryover needs no source patch: the resolver layers provide the path.
            this.log(`progress carryover ${fromDiffId} → ${toDiffId} deferred: iteration patch not stored`);
            return skippedCarry();
        }

        const pathOf = this.sourcePaths(fromDiffId);
        const idOfPath = new Map<string, string>();
        for (const file of to.diff.files) {
            // The first file with this path wins, as in `indexDiff`.
            if (!idOfPath.has(file.path)) {
                idOfPath.set(file.path, file.fileId);
            }
        }
        /**
         * Where source records land in the target iteration. Two failure cases are distinct:
         * `unmapped` means the resolver does not know this `fileId`'s path, so mapping has failed,
         * `missing` means the path is known but the file is absent in the new iteration, an ordinary author edit.
         */
        const targetOf = (fileId: string, path: string | null): Resolution => {
            const known = path ?? pathOf.get(fileId) ?? null;
            if (known === null) {
                return { kind: 'unmapped' };
            }
            const target = idOfPath.get(known);
            return target === undefined ? { kind: 'missing' } : { kind: 'mapped', path: known, fileId: target };
        };

        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, carried_from, path
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        );
        const written = new Set<string>();
        let unmappedRanges = 0;
        let missingRanges = 0;
        let touchedRanges = 0;
        const rangeRows = this.db
            .prepare(
                `SELECT file_id, side, start_line, end_line, path FROM file_seen_ranges
                  WHERE diff_id = ? ORDER BY rowid`,
            )
            .all(fromDiffId) as PathedRangeRow[];
        for (const row of rangeRows) {
            const target = targetOf(row.file_id, row.path);
            if (target.kind !== 'mapped') {
                unmappedRanges += target.kind === 'unmapped' ? 1 : 0;
                missingRanges += target.kind === 'missing' ? 1 : 0;
                continue;
            }
            const side = sideOf(row.side);
            const mapped = map.mapRange(target.path, side, { start: row.start_line, end: row.end_line });
            touchedRanges += mapped.touched.length > 0 ? 1 : 0;
            for (const range of mapped.carried) {
                const key = `${target.fileId} ${side} ${String(range.start)} ${String(range.end)}`;
                if (written.has(key)) {
                    continue;
                }
                written.add(key);
                insert.run(toDiffId, target.fileId, side, range.start, range.end, fromDiffId, target.path);
            }
        }

        let files = 0;
        const fileRows = this.db
            .prepare('SELECT file_id, viewed, path FROM file_progress WHERE diff_id = ?')
            .all(fromDiffId) as PathedProgressRow[];
        for (const row of fileRows) {
            const target = targetOf(row.file_id, row.path);
            if (target.kind !== 'mapped') {
                continue;
            }
            // The `read` pin survives only on an unchanged file. Unpinning is the reviewer's decision,
            // so it always carries over.
            if (row.viewed === 1 && map.fileStatus(target.path) !== 'unchanged') {
                continue;
            }
            const inserted = this.db
                .prepare(
                    `INSERT OR IGNORE INTO file_progress (diff_id, file_id, viewed, updated_at, path)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(toDiffId, target.fileId, row.viewed, this.now().toISOString(), target.path);
            files += inserted.changes > 0 ? 1 : 0;
        }

        this.db
            .prepare(
                'INSERT INTO progress_carries (from_diff_id, to_diff_id, carried_at) VALUES (?, ?, ?)',
            )
            .run(fromDiffId, toDiffId, this.now().toISOString());
        return {
            ranges: written.size,
            files,
            skipped: false,
            sourceRanges: rangeRows.length,
            unmappedRanges,
            missingRanges,
            touchedRanges,
        };
    }

    /**
     * Fallback chain from the source iteration's `fileId` to a path. The review host's `fileId` is opaque,
     * so records from two iterations can only be matched through a path. Layers: the stored iteration
     * patch, followed by anchors left in its route snapshots and chat notes.
     * An iteration recorded by server 0.3.x has no patch and no way to retrieve it (M4-T4), so
     * anchors are the only option here, rather than a fallback.
     *
     * The record's own `path` column (0.5.x and later) is more precise than any layer and is checked
     * first. It is not part of this map.
     */
    private sourcePaths(diffId: HostId): ReadonlyMap<string, string> {
        const paths = new Map<string, string>();
        for (const anchor of this.anchorsOf(diffId)) {
            if (!paths.has(anchor.fileId)) {
                paths.set(anchor.fileId, anchor.path);
            }
        }
        for (const file of this.iterations?.get(diffId)?.diff.files ?? []) {
            paths.set(file.fileId, file.path);
        }
        return paths;
    }

    /**
     * Iteration anchors from route snapshots and chat notes: they have both `fileId` and `path`.
     *
     * Both note columns are queried. Note carryover moves `anchor` to the new iteration
     * and runs alongside this (`IterationFeed.onIterations`): if it finishes first,
     * `anchor` no longer holds source anchors. `origin_anchor` keeps the iteration where
     * the note was created and is never rewritten by carryover.
     */
    private anchorsOf(diffId: HostId): AnchorPath[] {
        const snapshots = this.db
            .prepare('SELECT snapshot_json AS json FROM route_snapshots WHERE diff_id = ? ORDER BY rowid')
            .all(diffId) as JsonRow[];
        const notes = this.db
            .prepare('SELECT anchor, origin_anchor FROM agent_notes')
            .all() as NoteAnchorRow[];
        return snapshots
            .flatMap((row) => snapshotAnchors(row.json))
            .concat(
                notes.flatMap((row) =>
                    [row.anchor, row.origin_anchor].flatMap((json) =>
                        json === null ? [] : noteAnchors(json, diffId),
                    ),
                ),
            );
    }

    /**
     * `fileId → path` in the iteration patch: new progress records store these paths so
     * the next carryover does not depend on the patch surviving. Patch parsing is expensive, while
     * the iteration patch is immutable, so the last parsed one stays in memory.
     */
    private pathsOf(diffId: HostId): ReadonlyMap<string, string> {
        if (this.pathCache?.diffId === diffId) {
            return this.pathCache.paths;
        }
        const stored = this.iterations?.get(diffId) ?? null;
        if (stored === null) {
            // The patch has not arrived: the path will be stored as NULL. Cache nothing, as it will appear later.
            return new Map();
        }
        const paths = new Map(stored.diff.files.map((file) => [file.fileId, file.path]));
        this.pathCache = { diffId, paths };
        return paths;
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
        const paths = this.pathsOf(diffId);
        const insert = this.db.prepare(
            `INSERT INTO file_seen_ranges (
                diff_id, file_id, side, start_line, end_line, source_stop_id, path
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const range of required) {
            // The same range is already stored as carried: it now belongs to the stop, with no duplicate.
            dropCarried.run(diffId, range.fileId, range.side, range.start, range.end);
            insert.run(
                diffId,
                range.fileId,
                range.side,
                range.start,
                range.end,
                stopId,
                paths.get(range.fileId) ?? null,
            );
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

/** Carryover did not happen: nothing was written to storage and there is nothing to count. */
function skippedCarry(): CarryResult {
    return {
        ranges: 0,
        files: 0,
        skipped: true,
        sourceRanges: 0,
        unmappedRanges: 0,
        missingRanges: 0,
        touchedRanges: 0,
    };
}

/**
 * Carryover result in words. Zero ranges alone explains nothing, so it always comes
 * with reasons: how many source records existed, how many could not map to a path, how many
 * had no file in the new iteration, and how many the interdiff touched.
 */
function carrySummary(result: CarryResult): string {
    const counters: readonly (readonly [string, number])[] = [
        ['no path', result.unmappedRanges],
        ['absent from new iteration', result.missingRanges],
        ['touched by interdiff', result.touchedRanges],
    ];
    const words = (pairs: readonly (readonly [string, number])[]): string =>
        pairs.map(([name, count]) => `${name}: ${String(count)}`).join(', ');
    if (result.ranges === 0 && result.files === 0) {
        // An empty result lists all reasons, including zero counts: zero for
        // each means none of the known reasons applied.
        return `carried 0 ranges out of ${String(result.sourceRanges)} (${words(counters)})`;
    }
    const reasons = counters.filter(([, count]) => count > 0);
    const tail = reasons.length === 0 ? '' : ` (${words(reasons)})`;
    return `ranges ${String(result.ranges)}, files ${String(result.files)}${tail}`;
}

/** Route snapshot stop anchors. Reads the blob as is: only `fileId` and `path` are needed. */
function snapshotAnchors(json: string): AnchorPath[] {
    const snapshot = parseJson(json);
    return arrayOf(isRecord(snapshot) ? snapshot.stops : null)
        .flatMap((stop) => arrayOf(isRecord(stop) ? stop.anchors : null))
        .flatMap((anchor) => {
            const parsed = anchorPath(anchor);
            return parsed === null ? [] : [parsed];
        });
}

function arrayOf(value: unknown): unknown[] {
    return Array.isArray(value) ? (value as unknown[]) : [];
}

/** A chat note anchor if it points to the requested iteration, otherwise empty if unrelated or corrupt. */
function noteAnchors(json: string, diffId: HostId): AnchorPath[] {
    const anchor = parseJson(json);
    if (!isRecord(anchor) || anchor.diffId !== diffId) {
        return [];
    }
    const parsed = anchorPath(anchor);
    return parsed === null ? [] : [parsed];
}

function anchorPath(value: unknown): AnchorPath | null {
    if (!isRecord(value)) {
        return null;
    }
    const { fileId, path } = value;
    return typeof fileId === 'string' && fileId !== '' && typeof path === 'string' && path !== ''
        ? { fileId, path }
        : null;
}

/** A corrupt blob must not break carryover: its anchor is simply left out of the map. */
function parseJson(json: string): unknown {
    try {
        return JSON.parse(json) as unknown;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
