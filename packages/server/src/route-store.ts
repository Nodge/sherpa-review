import { createHash } from 'node:crypto';

import type {
    HostId,
    Locale,
    PrDiff,
    RouteCarried,
    RouteProvenance,
    RouteSnapshot,
    RouteStop,
    RouteStopStatus,
    UiGenerationCap,
    UiRouteState,
} from '@sherpa/protocol';
import { localeSchema, routeSnapshotSchema, uiGenerationCapSchema, uiRouteStateSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import type { AcceptedSkeleton, RouteStopFilling } from './route/index.js';
import { applyFilling } from './route/index.js';

/** Route change listener consumed by the UI SSE channel (`UI_ROUTE_EVENT`). */
export type RouteListener = (revision: number) => void;

/** The only `route_state` row. A PR has one generation state and many snapshots. */
const SLOT_ID = 1;

/**
 * Fallback for `baseCommit` in an older snapshot when its iteration is not yet stored.
 * It cannot support comparisons, but an unrelated commit would be worse than "unknown".
 */
export const UNKNOWN_BASE_COMMIT = 'unknown';

/** Generation cap key in `meta`. One row per snapshot, with no migration needed. */
function generationCapKey(snapshotId: string): string {
    return `generation_cap:${snapshotId}`;
}

/** Fixed `meta` key for the latest started generation's language. A PR has one generation. */
const GENERATION_LOCALE_KEY = 'generation_locale';

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
    /**
     * The iteration whose diff supplied the task payload. Acceptance resolves anchors against that diff.
     * `null` means the binding predates migration 011, which deletes such bindings. This only guards reads.
     */
    readonly diffId: HostId | null;
    readonly planIndexes: number[];
}

/**
 * Progress carryover result for a snapshot. Computed inside its write transaction, so
 * the progress revision advances in a separate effect after commit.
 */
export interface SnapshotAcceptance {
    readonly carried: RouteCarried | null;
    readonly afterCommit?: () => void;
}

/** Snapshot acceptance hook. Receives the prepared snapshot and returns its `carried` value. */
export type SnapshotHook = (snapshot: RouteSnapshot) => SnapshotAcceptance;

/** Work inside the state write transaction: snapshot replacement and a post-commit effect. */
interface TransactionStep {
    readonly snapshot?: RouteSnapshot;
    readonly afterCommit?: () => void;
}

export interface AcceptedSkeletonInput {
    readonly skeleton: AcceptedSkeleton;
    /** Diff used to build the route. Supplies the snapshot's commit and iteration. */
    readonly diff: PrDiff;
    readonly provenance: RouteProvenance;
    readonly snapshotId: string;
    /** Snapshot that was current at acceptance. null means this is the first route generation. */
    readonly previousSnapshotId: string | null;
}

interface RouteStateRow extends SqlRow {
    phase: string;
    small_pr: number | null;
    current_snapshot_id: string | null;
    failure_message: string | null;
    failure_raw_output: string | null;
    intents: string;
}

interface RouteSnapshotRow extends SqlRow {
    snapshot_id: string;
    snapshot_json: string;
}

interface RouteTaskRow extends SqlRow {
    task_id: number;
    kind: string;
    diff_id: string | null;
    plan_indexes: string;
}

// `stale` is always null in storage. `IterationFeed` computes it when reading (`withStale`).
const EMPTY_STATE: UiRouteState = { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null };

/**
 * PR route state: generation phase, snapshot and failure reason. The source of truth for the UI.
 *
 * Follows `ProgressStore`. The revision is monotonic from server startup and increases only on a real
 * change. Subscribers receive a `route` event, then the tab rereads the endpoint. The snapshot
 * passes through `routeSnapshotSchema` on database writes and reads, so invalid data is neither stored
 * nor returned (docs/product.md §3, principle 3).
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
        inTransaction?: () => TransactionStep,
    ) => { state: UiRouteState; afterCommit: (() => void) | undefined };

    private state: UiRouteState;
    private intents: ReadonlyMap<number, string>;
    private revisionValue = 0;
    private closed = false;

    constructor(options: RouteStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txWrite = transaction(
            this.db,
            (state: UiRouteState, intents: ReadonlyMap<number, string>, inTransaction?: () => TransactionStep) => {
                // The step runs before the write so its replacement snapshot is stored in the same transaction.
                const step = inTransaction?.() ?? {};
                const written =
                    step.snapshot === undefined
                        ? state
                        : uiRouteStateSchema.parse({ ...state, snapshot: step.snapshot });
                this.writeInTransaction(written, intents);
                return { state: written, afterCommit: step.afterCommit };
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

    /** Current PR snapshot. null means no route now (generation never started, was reset or failed). */
    current(): RouteSnapshot | null {
        return this.state.snapshot === null ? null : structuredClone(this.state.snapshot);
    }

    /**
     * All PR snapshots in creation order. History is never cleared because an old snapshot is
     * the only way to read a previous iteration's route (docs/product.md §7, scenario F3).
     * A corrupt row is skipped with a warning, leaving the rest of history readable.
     */
    listSnapshots(): RouteSnapshot[] {
        const rows = this.db
            .prepare('SELECT snapshot_id, snapshot_json FROM route_snapshots ORDER BY created_at, rowid')
            .all() as RouteSnapshotRow[];
        return rows.flatMap((row) => {
            const snapshot = this.parseSnapshotRow(row);
            return snapshot === null ? [] : [snapshot];
        });
    }

    getSnapshot(snapshotId: string): RouteSnapshot | null {
        const row = this.db
            .prepare('SELECT snapshot_id, snapshot_json FROM route_snapshots WHERE snapshot_id = ?')
            .get(snapshotId) as RouteSnapshotRow | undefined;
        return row === undefined ? null : this.parseSnapshotRow(row);
    }

    /**
     * Draft stop intents from the accepted skeleton. The snapshot contract excludes them,
     * but the section scheduler needs them to build a prompt.
     */
    stopIntents(): Map<number, string> {
        return new Map(this.intents);
    }

    /** New generation. The old snapshot stays readable until the new plan is accepted. */
    beginSkeleton(): void {
        this.commit({ ...this.state, phase: 'reading', failure: null }, new Map());
    }

    /**
     * Skeleton accepted. The new snapshot and progress carryover commit together.
     * Adds a row to `route_snapshots` without changing or deleting previous rows.
     *
     * `onSnapshot` runs inside the transaction, before serialization. Its `carried` must be stored
     * in the snapshot JSON instead of arriving in a second request.
     */
    acceptSkeleton(input: AcceptedSkeletonInput, onSnapshot?: SnapshotHook): void {
        const snapshot: RouteSnapshot = {
            snapshotId: input.snapshotId,
            commit: input.diff.headCommit,
            baseCommit: input.diff.baseCommit,
            diffId: input.diff.diffId,
            createdAt: this.now().toISOString(),
            provenance: input.provenance,
            previousSnapshotId: input.previousSnapshotId,
            carried: null,
            summary: input.skeleton.summary,
            stops: input.skeleton.stops,
            tourOrder: input.skeleton.tourOrder,
            contentHash: null,
        };
        this.commit(
            { ...this.state, phase: 'filling', snapshot, failure: null },
            new Map(input.skeleton.intents),
            stepOf(snapshot, onSnapshot),
        );
    }

    /**
     * Accepted section contents fill the planned slots. Provenance is written to the stop only when
     * it differs from the snapshot's because the agent changed mid-generation (docs/design/SPEC-elements.md §4.4).
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

    /** Returns an unfinished stop to the normal filling phase without resetting the rest of the route. */
    beginStopFill(planIndex: number): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null) {
            return;
        }

        const stops = snapshot.stops.map((stop) =>
            stop.planIndex === planIndex && stop.tier !== 'other'
                ? { ...stop, status: 'queued' as const, validationNotes: [] }
                : stop,
        );
        this.commit(
            { ...this.state, phase: 'filling', snapshot: { ...snapshot, stops, contentHash: null } },
            this.intents,
            () => {
                this.deleteSectionBindingsFor(planIndex);
                return {};
            },
        );
    }

    /**
     * All sections are closed. The snapshot becomes immutable, and only now is `contentHash` computed.
     * Before this point there is nothing final to hash because content is still arriving.
     *
     * Stop mark carryover is also computed here. Only filled stops have anchors,
     * so there is nothing to carry over earlier (`onSnapshot` is the same hook used for skeleton acceptance).
     */
    markReady(onSnapshot?: SnapshotHook): void {
        const snapshot = this.state.snapshot;
        if (snapshot === null) {
            return;
        }
        const ready: RouteSnapshot = { ...snapshot, contentHash: contentHashOf(snapshot) };
        this.commit(
            { ...this.state, phase: 'ready', snapshot: ready },
            this.intents,
            stepOf(ready, onSnapshot),
        );
    }

    /**
     * Route generation failure (docs/design/README.md §12). There is no skeleton, and the reader is unaffected.
     * The reason is one Russian sentence. Raw model output is available through "Open raw output".
     */
    fail(message: string, rawOutput: string | null): void {
        this.commit({ ...this.state, phase: 'failed', failure: { message, rawOutput } });
    }

    /** PR below the route threshold (docs/architecture.md §7.6). Computed from the diff, so it arrives separately from the phase. */
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

    /**
     * Snapshot generation cap: how much of the diff the skeleton saw in full. Stored in `meta`
     * under the snapshot key, outside the snapshot itself. The snapshot is a UI contract without a payload
     * metric. Written on skeleton acceptance and read when assembling state.
     */
    setGenerationCap(snapshotId: string, cap: UiGenerationCap): void {
        this.db
            .prepare(
                `INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(generationCapKey(snapshotId), JSON.stringify(cap));
    }

    /** Current snapshot's cap. null means no snapshot or generation before this metric existed. */
    currentGenerationCap(): UiGenerationCap | null {
        const snapshotId = this.state.snapshot?.snapshotId;
        return snapshotId === undefined ? null : this.generationCap(snapshotId);
    }

    /** A specific snapshot's cap. A corrupt record is read as absent (principle 3). */
    generationCap(snapshotId: string): UiGenerationCap | null {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(generationCapKey(snapshotId)) as
            | { value: string }
            | undefined;
        if (row === undefined) {
            return null;
        }
        try {
            const parsed = uiGenerationCapSchema.safeParse(JSON.parse(row.value));
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }

    /**
     * Language of the latest started generation. Stored in `meta`, outside process memory, because the skeleton
     * task and its binding survive a server restart. Result acceptance must know
     * the language actually sent in the prompt. Otherwise the snapshot gets the wrong `provenance.locale`
     * and sections in different languages.
     */
    setGenerationLocale(locale: Locale): void {
        this.db
            .prepare(
                `INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(GENERATION_LOCALE_KEY, locale);
    }

    /** Latest generation language. null means no generation or a corrupt record (principle 3). */
    generationLocale(): Locale | null {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_LOCALE_KEY) as
            | { value: string }
            | undefined;
        if (row === undefined) {
            return null;
        }
        const parsed = localeSchema.safeParse(row.value);
        return parsed.success ? parsed.data : null;
    }

    /** Maps a generation task to the stops it fills. Does not change UI state, so the revision stays unchanged. */
    bindTask(
        taskId: number,
        kind: RouteTaskBinding['kind'],
        diffId: HostId,
        planIndexes: readonly number[],
    ): void {
        this.db
            .prepare(
                `INSERT INTO route_tasks (task_id, kind, diff_id, plan_indexes, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(task_id) DO UPDATE SET kind = excluded.kind, diff_id = excluded.diff_id,
                    plan_indexes = excluded.plan_indexes`,
            )
            .run(taskId, kind, diffId, JSON.stringify([...planIndexes]), this.now().toISOString());
    }

    /** Current generation's task bindings in enqueue order. */
    bindings(): Map<number, RouteTaskBinding> {
        const rows = this.db
            .prepare('SELECT task_id, kind, diff_id, plan_indexes FROM route_tasks ORDER BY task_id')
            .all() as RouteTaskRow[];
        const bindings = new Map<number, RouteTaskBinding>();
        for (const row of rows) {
            bindings.set(row.task_id, {
                kind: row.kind === 'skeleton' ? 'skeleton' : 'section',
                diffId: row.diff_id,
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

    /** A closed task from a previous fill must not count as a task for the new reconciliation pass. */
    private deleteSectionBindingsFor(planIndex: number): void {
        for (const [taskId, binding] of this.bindings()) {
            if (binding.kind === 'section' && binding.planIndexes.includes(planIndex)) {
                this.db.prepare('DELETE FROM route_tasks WHERE task_id = ?').run(taskId);
            }
        }
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
        inTransaction?: () => TransactionStep,
    ): void {
        const parsed = uiRouteStateSchema.parse(next);
        if (
            inTransaction === undefined &&
            JSON.stringify(parsed) === JSON.stringify(this.state) &&
            sameIntents(intents, this.intents)
        ) {
            return;
        }

        const { state, afterCommit } = this.txWrite(parsed, intents, inTransaction);
        this.state = state;
        this.intents = intents;
        this.revisionValue += 1;
        if (!this.closed) {
            for (const listener of [...this.listeners]) {
                listener(this.revisionValue);
            }
        }
        afterCommit?.();
    }

    /**
     * The current snapshot has its own row in `route_snapshots` (keyed by id), while `route_state`
     * holds only a reference to it. PR snapshot history is never overwritten.
     */
    private writeInTransaction(state: UiRouteState, intents: ReadonlyMap<number, string>): void {
        const snapshot = state.snapshot === null ? null : routeSnapshotSchema.parse(state.snapshot);
        if (snapshot !== null) {
            this.db
                .prepare(
                    `INSERT INTO route_snapshots (
                        snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash
                     ) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(snapshot_id) DO UPDATE SET
                        diff_id = excluded.diff_id, created_at = excluded.created_at,
                        previous_snapshot_id = excluded.previous_snapshot_id,
                        snapshot_json = excluded.snapshot_json, content_hash = excluded.content_hash`,
                )
                .run(
                    snapshot.snapshotId,
                    snapshot.diffId,
                    snapshot.createdAt,
                    snapshot.previousSnapshotId,
                    JSON.stringify(snapshot),
                    snapshot.contentHash,
                );
        }

        this.db
            .prepare(
                `INSERT INTO route_state (
                    id, phase, small_pr, current_snapshot_id, failure_message, failure_raw_output,
                    intents, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    phase = excluded.phase, small_pr = excluded.small_pr,
                    current_snapshot_id = excluded.current_snapshot_id,
                    failure_message = excluded.failure_message,
                    failure_raw_output = excluded.failure_raw_output,
                    intents = excluded.intents, updated_at = excluded.updated_at`,
            )
            .run(
                SLOT_ID,
                state.phase,
                state.smallPr ? 1 : 0,
                snapshot?.snapshotId ?? null,
                state.failure?.message ?? null,
                state.failure?.rawOutput ?? null,
                JSON.stringify([...intents]),
                this.now().toISOString(),
            );
    }

    /**
     * Snapshot from a storage row. Snapshots written by an older version (without `baseCommit`, `previousSnapshotId`,
     * `carried`, `stops[].change`) get defaults. Otherwise the schema would reject
     * the whole snapshot and silently turn the accumulated route into "no route".
     * A corrupt row produces a warning and `null`, leaving the rest of history readable.
     */
    private parseSnapshotRow(row: RouteSnapshotRow): RouteSnapshot | null {
        try {
            return routeSnapshotSchema.parse(
                withSnapshotDefaults(JSON.parse(row.snapshot_json) as unknown, (diffId) =>
                    this.baseCommitOf(diffId),
                ),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(
                `sherpa-server: stored route snapshot ${row.snapshot_id} is corrupt (${message}), skipped\n`,
            );
            return null;
        }
    }

    /** Iteration's review base from local patch storage. null means the iteration is absent. */
    private baseCommitOf(diffId: string): string | null {
        const row = this.db.prepare('SELECT base_commit FROM iterations WHERE diff_id = ?').get(diffId) as
            | { base_commit: string }
            | undefined;
        return row?.base_commit ?? null;
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
                row.current_snapshot_id === null ? null : this.getSnapshot(row.current_snapshot_id);
            if (row.current_snapshot_id !== null && snapshot === null) {
                // The current snapshot row is missing or unreadable. A phase without a snapshot would falsely tell
                // the UI that a route is ready when none exists.
                throw new Error(`snapshot ${row.current_snapshot_id} is unreadable`);
            }
            const state = uiRouteStateSchema.parse({
                phase: row.phase,
                smallPr: row.small_pr === 1,
                snapshot,
                failure:
                    row.failure_message === null
                        ? null
                        : { message: row.failure_message, rawOutput: row.failure_raw_output },
                // `IterationFeed` compares the snapshot with the active iteration. Storage does not.
                stale: null,
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

/** Acceptance hook as a transaction step. Adds `carried` to the snapshot before serialization. */
function stepOf(snapshot: RouteSnapshot, onSnapshot?: SnapshotHook): (() => TransactionStep) | undefined {
    if (onSnapshot === undefined) {
        return undefined;
    }
    return () => {
        const acceptance = onSnapshot(snapshot);
        return {
            snapshot: { ...snapshot, carried: acceptance.carried },
            ...(acceptance.afterCommit === undefined ? {} : { afterCommit: acceptance.afterCommit }),
        };
    };
}

/**
 * Fields absent from older snapshots. `baseCommit` comes from the locally saved iteration
 * (it may not have been written yet, in which case it is "unknown"). The rest default to null because there is no basis for carrying over progress
 * or computing `change` from a snapshot built without these data.
 */
function withSnapshotDefaults(raw: unknown, baseCommitOf: (diffId: string) => string | null): unknown {
    if (typeof raw !== 'object' || raw === null) {
        return raw;
    }

    const snapshot = raw as Record<string, unknown>;
    const diffId = snapshot.diffId;
    const stops = snapshot.stops;
    return {
        ...snapshot,
        baseCommit:
            snapshot.baseCommit ??
            (typeof diffId === 'string' ? baseCommitOf(diffId) : null) ??
            UNKNOWN_BASE_COMMIT,
        previousSnapshotId: snapshot.previousSnapshotId ?? null,
        carried: snapshot.carried ?? null,
        // Return non-arrays as is. A default would turn a corrupt row into a valid empty
        // route, but the schema must reject it.
        stops: Array.isArray(stops)
            ? (stops as unknown[]).map((stop) =>
                  typeof stop === 'object' && stop !== null
                      ? {
                            ...(stop as Record<string, unknown>),
                            change: (stop as Record<string, unknown>).change ?? null,
                        }
                      : stop,
              )
            : stops,
    };
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
