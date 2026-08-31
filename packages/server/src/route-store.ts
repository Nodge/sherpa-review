import { createHash } from 'node:crypto';

import type {
    PrDiff,
    RouteProvenance,
    RouteSnapshot,
    RouteStop,
    RouteStopStatus,
    UiRouteState,
} from '@sherpa/protocol';
import { routeSnapshotSchema, uiRouteStateSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import type { AcceptedSkeleton, RouteStopFilling } from './route/index.js';
import { applyFilling } from './route/index.js';

/** Route change listener consumed by the UI SSE channel (`UI_ROUTE_EVENT`). */
export type RouteListener = (revision: number) => void;

/** The only row in the table: a PR has one snapshot in M2. */
const SLOT_ID = 1;

/** Content hash length in hex characters, displayed in the snapshot selector ("snapshot 3f2a… · current"). */
const CONTENT_HASH_LENGTH = 12;

export interface RouteStoreOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock so snapshot `createdAt` in tests does not depend on system time. */
    readonly now?: () => Date;
}

/** Changes an unfilled stop's status. `note` is appended to `validationNotes` once. */
export interface RouteStopStatusUpdate {
    readonly status: RouteStopStatus;
    readonly note?: string;
}

/** A generation task and the stops it fills, which never include "Other". */
export interface RouteTaskBinding {
    readonly kind: 'skeleton' | 'section';
    readonly planIndexes: number[];
}

export interface AcceptedSkeletonInput {
    readonly skeleton: AcceptedSkeleton;
    /** Diff used to build the route. Supplies the snapshot's commit and iteration. */
    readonly diff: PrDiff;
    readonly provenance: RouteProvenance;
    readonly snapshotId: string;
}

interface RouteStateRow extends SqlRow {
    phase: string;
    small_pr: number | null;
    snapshot: string | null;
    failure_message: string | null;
    failure_raw_output: string | null;
    intents: string;
}

interface RouteTaskRow extends SqlRow {
    task_id: number;
    kind: string;
    plan_indexes: string;
}

const EMPTY_STATE: UiRouteState = { phase: 'none', smallPr: false, snapshot: null, failure: null };

/**
 * PR route state (M2-T4): generation phase, snapshot and failure reason, the source of truth for the UI.
 *
 * Follows `ProgressStore`. The revision is monotonic from server startup and increases only on a real
 * change. Subscribers receive a `route` event, then the tab rereads the endpoint. The snapshot
 * passes through `routeSnapshotSchema` on database writes and reads, so invalid data is neither stored
 * nor returned to callers (brief principle 3).
 *
 * Mutators apply whole states. The orchestrator computes the entire target state and applies it in one
 * call, so each state-machine step produces exactly one channel event.
 */
export class RouteStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly listeners = new Set<RouteListener>();
    private readonly txWrite: (
        state: UiRouteState,
        intents: ReadonlyMap<number, string>,
        inTransaction?: () => () => void,
    ) => (() => void) | undefined;

    private state: UiRouteState;
    private intents: ReadonlyMap<number, string>;
    private revisionValue = 0;
    private closed = false;

    constructor(options: RouteStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txWrite = transaction(
            this.db,
            (state: UiRouteState, intents: ReadonlyMap<number, string>, inTransaction?: () => () => void) => {
                this.writeInTransaction(state, intents);
                return inTransaction?.();
            },
        );

        const loaded = this.load();
        this.state = loaded.state;
        this.intents = loaded.intents;
    }

    get revision(): number {
        return this.revisionValue;
    }

    /** UI state. Returns a copy the consumer can mutate. */
    read(): UiRouteState {
        return structuredClone(this.state);
    }

    /**
     * Draft stop intents from the accepted skeleton. The snapshot contract excludes them,
     * but the section scheduler needs them to build the prompt (T5).
     */
    stopIntents(): Map<number, string> {
        return new Map(this.intents);
    }

    /** New generation. The old snapshot stays readable until the new plan is accepted. */
    beginSkeleton(): void {
        this.commit({ ...this.state, phase: 'reading', failure: null }, new Map());
    }

    /** Skeleton accepted: commit the new snapshot and clear previous stop progress together. */
    acceptSkeleton(input: AcceptedSkeletonInput, clearStopProgress?: () => () => void): void {
        const snapshot: RouteSnapshot = {
            snapshotId: input.snapshotId,
            commit: input.diff.headCommit,
            diffId: input.diff.diffId,
            createdAt: this.now().toISOString(),
            provenance: input.provenance,
            summary: input.skeleton.summary,
            stops: input.skeleton.stops,
            tourOrder: input.skeleton.tourOrder,
            contentHash: null,
        };
        this.commit(
            { ...this.state, phase: 'filling', snapshot, failure: null },
            new Map(input.skeleton.intents),
            clearStopProgress,
        );
    }

    /**
     * Accepted section contents fill the planned slots. Provenance is written to the stop only when
     * it differs from the snapshot's: the agent changed during generation (SPEC §4.4).
     */
    applyFillings(fillings: readonly RouteStopFilling[], provenance: RouteProvenance): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null) {
            return;
        }

        const byIndex = new Map(fillings.map((filling) => [filling.planIndex, filling]));
        const stops = snapshot.stops.map((stop) => {
            const filling = byIndex.get(stop.planIndex);
            if (filling === undefined || stop.tier === 'other') {
                return stop;
            }
            return {
                ...applyFilling(stop, filling),
                provenance: sameProvenance(provenance, snapshot.provenance) ? null : provenance,
            };
        });
        this.commit({ ...this.state, snapshot: { ...snapshot, stops } });
    }

    /** Stop statuses follow their tasks: `queued` → `filling` → `ready`/`failed`. */
    setStopStatuses(updates: ReadonlyMap<number, RouteStopStatusUpdate>): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null || updates.size === 0) {
            return;
        }

        const stops = snapshot.stops.map((stop) => {
            const update = updates.get(stop.planIndex);
            if (update === undefined || stop.tier === 'other') {
                return stop;
            }
            return { ...stop, status: update.status, validationNotes: withNote(stop, update.note) };
        });
        this.commit({ ...this.state, snapshot: { ...snapshot, stops } });
    }

    /**
     * All sections are closed. The snapshot becomes immutable, and only now is `contentHash` computed.
     * Before this point there is nothing final to hash because content is still arriving.
     */
    markReady(): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null) {
            return;
        }
        this.commit({
            ...this.state,
            phase: 'ready',
            snapshot: { ...snapshot, contentHash: contentHashOf(snapshot) },
        });
    }

    /**
     * Route generation failure (README §12): no skeleton, the reader is unaffected.
     * The reason is one Russian sentence. Raw model output is available through "Open raw output".
     */
    fail(message: string, rawOutput: string | null): void {
        this.commit({ ...this.state, phase: 'failed', failure: { message, rawOutput } });
    }

    /** PR below the route threshold (requirements §3.6), computed from the diff separately from the phase. */
    setSmallPr(smallPr: boolean): void {
        this.commit({ ...this.state, smallPr });
    }

    /** Skeleton cancellation. Rebuild restores the old route, first generation restores an empty state. */
    cancelSkeleton(): void {
        if (this.state.snapshot === null) {
            this.reset();
            return;
        }
        this.commit({ ...this.state, phase: 'ready', failure: null }, new Map());
    }

    /** No generation now or in the past. Prompts the reviewer to run the skill. */
    reset(): void {
        this.commit({ ...this.state, phase: 'none', snapshot: null, failure: null }, new Map());
    }

    /** Maps a generation task to the stops it fills. Does not change UI state, so the revision stays unchanged. */
    bindTask(taskId: number, kind: RouteTaskBinding['kind'], planIndexes: readonly number[]): void {
        this.db
            .prepare(
                `INSERT INTO route_tasks (task_id, kind, plan_indexes, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(task_id) DO UPDATE SET kind = excluded.kind, plan_indexes = excluded.plan_indexes`,
            )
            .run(taskId, kind, JSON.stringify([...planIndexes]), this.now().toISOString());
    }

    /** Current generation's task bindings in enqueue order. */
    bindings(): Map<number, RouteTaskBinding> {
        const rows = this.db
            .prepare('SELECT task_id, kind, plan_indexes FROM route_tasks ORDER BY task_id')
            .all() as RouteTaskRow[];
        const bindings = new Map<number, RouteTaskBinding>();
        for (const row of rows) {
            bindings.set(row.task_id, {
                kind: row.kind === 'skeleton' ? 'skeleton' : 'section',
                planIndexes: parsePlanIndexes(row.plan_indexes),
            });
        }
        return bindings;
    }

    /**
     * Forgets previous generation tasks because their plan numbers overlap with the new plan.
     * Keeping a binding would make a cancelled task look like a task for a new stop.
     */
    clearBindings(): void {
        this.db.prepare('DELETE FROM route_tasks').run();
    }

    subscribe(listener: RouteListener): () => void {
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

    /**
     * State write order: contract validation, storage, revision, then notification.
     * A mutator that changes nothing stays silent because there is nothing to notify tabs about.
     */
    private commit(
        next: UiRouteState,
        intents: ReadonlyMap<number, string> = this.intents,
        inTransaction?: () => () => void,
    ): void {
        const parsed = uiRouteStateSchema.parse(next);
        if (
            inTransaction === undefined &&
            JSON.stringify(parsed) === JSON.stringify(this.state) &&
            sameIntents(intents, this.intents)
        ) {
            return;
        }

        const afterCommit = this.txWrite(parsed, intents, inTransaction);
        this.state = parsed;
        this.intents = intents;
        this.revisionValue += 1;
        if (!this.closed) {
            for (const listener of [...this.listeners]) {
                listener(this.revisionValue);
            }
        }
        afterCommit?.();
    }

    private writeInTransaction(state: UiRouteState, intents: ReadonlyMap<number, string>): void {
        this.db
            .prepare(
                `INSERT INTO route_state (
                    id, phase, small_pr, snapshot, failure_message, failure_raw_output, intents, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    phase = excluded.phase, small_pr = excluded.small_pr, snapshot = excluded.snapshot,
                    failure_message = excluded.failure_message,
                    failure_raw_output = excluded.failure_raw_output,
                    intents = excluded.intents, updated_at = excluded.updated_at`,
            )
            .run(
                SLOT_ID,
                state.phase,
                state.smallPr ? 1 : 0,
                state.snapshot === null ? null : JSON.stringify(routeSnapshotSchema.parse(state.snapshot)),
                state.failure?.message ?? null,
                state.failure?.rawOutput ?? null,
                JSON.stringify([...intents]),
                this.now().toISOString(),
            );
    }

    /**
     * Reads state at server startup. A corrupt row (manual database edit or version rollback)
     * means "no route" because generation can rebuild the route. Failing server startup
     * over it would cost more than losing a snapshot.
     */
    private load(): { state: UiRouteState; intents: ReadonlyMap<number, string> } {
        const row = this.db.prepare('SELECT * FROM route_state WHERE id = ?').get(SLOT_ID) as
            | RouteStateRow
            | undefined;
        if (row === undefined) {
            return { state: EMPTY_STATE, intents: new Map() };
        }

        try {
            const snapshot =
                row.snapshot === null ? null : routeSnapshotSchema.parse(JSON.parse(row.snapshot) as unknown);
            const state = uiRouteStateSchema.parse({
                phase: row.phase,
                smallPr: row.small_pr === 1,
                snapshot,
                failure:
                    row.failure_message === null
                        ? null
                        : { message: row.failure_message, rawOutput: row.failure_raw_output },
            });
            return { state, intents: parseIntents(row.intents) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: stored route state is corrupt (${message}), reset\n`);
            return { state: EMPTY_STATE, intents: new Map() };
        }
    }
}

/**
 * Ready snapshot content hash. Uses sha256 of model contents (summary, plan, filled sections),
 * taking the first 12 hex characters for the snapshot selector. Metadata
 * (snapshot id, time, provenance, iteration) is excluded because identical routes built
 * by different sessions must have the same hash. Field order is explicit here and must not depend
 * on key order in stored objects.
 */
export function contentHashOf(snapshot: RouteSnapshot): string {
    const payload = JSON.stringify({
        summary: snapshot.summary,
        tourOrder: snapshot.tourOrder,
        stops: snapshot.stops.map((stop) => ({
            id: stop.id,
            planIndex: stop.planIndex,
            tier: stop.tier,
            title: stop.title,
            status: stop.status,
            paragraph: stop.paragraph,
            bridge: stop.bridge,
            anchors: stop.anchors.map((anchor) => ({
                fileId: anchor.fileId,
                path: anchor.path,
                side: anchor.side,
                start: anchor.start,
                end: anchor.end,
                collapsed: anchor.collapsed,
            })),
            tests: stop.tests.map((claim) => ({
                kind: claim.kind,
                text: claim.text,
                anchor:
                    claim.anchor === null
                        ? null
                        : { fileId: claim.anchor.fileId, path: claim.anchor.path, line: claim.anchor.line },
            })),
            droppedClaims: stop.droppedClaims,
            validationNotes: stop.validationNotes,
        })),
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, CONTENT_HASH_LENGTH);
}

function withNote(stop: RouteStop, note: string | undefined): string[] {
    if (note === undefined || stop.validationNotes.includes(note)) {
        return stop.validationNotes;
    }
    return [...stop.validationNotes, note];
}

function sameProvenance(left: RouteProvenance, right: RouteProvenance): boolean {
    return left.harness === right.harness && left.model === right.model;
}

function sameIntents(left: ReadonlyMap<number, string>, right: ReadonlyMap<number, string>): boolean {
    if (left.size !== right.size) {
        return false;
    }
    for (const [key, value] of left) {
        if (right.get(key) !== value) {
            return false;
        }
    }
    return true;
}

function parseIntents(raw: string): Map<number, string> {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('stop intents are not stored as [number, text] pairs');
    }

    const intents = new Map<number, string>();
    for (const entry of parsed as unknown[]) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'number' || typeof entry[1] !== 'string') {
            throw new Error('stop intents are not stored as [number, text] pairs');
        }
        intents.set(entry[0], entry[1]);
    }
    return intents;
}

function parsePlanIndexes(raw: string): number[] {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || (parsed as unknown[]).some((item) => typeof item !== 'number')) {
        throw new Error(`Route task stop list is corrupt: ${raw}`);
    }
    return parsed as number[];
}
