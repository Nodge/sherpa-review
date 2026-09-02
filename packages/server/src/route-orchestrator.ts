import { randomUUID } from 'node:crypto';

import type {
    PrDiff,
    PrMeta,
    ReviewHost,
    RouteProvenance,
    UiRouteFillStopResponse,
    UiRouteGenerateResponse,
    WorkerStatus,
} from '@sherpa/protocol';

import { RpcFailure } from './errors.js';
import type { IterationStore } from './iteration-store.js';
import { rememberIterationDiff } from './iteration-store.js';
import type { EnqueueInput, TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import { RoutePayloadWriter } from './route-payload.js';
import type { RouteStopStatusUpdate, RouteStore, RouteTaskBinding } from './route-store.js';
import { validateSection, validateSkeleton } from './route/index.js';
import type { SharedPayloadStore } from './shared-payload.js';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * Route orchestration (M2-T4): a state machine, "no route → skeleton → sections → ready".
 *
 * The state of `RouteStore` alongside the queue state is the single source of truth for what
 * to do next. Reconciliation (`reconcile`) computes transitions instead of recording them as events. Reconciliation
 * is idempotent, so a server restart during generation, agent death and session eviction
 * recover automatically, with no special-case code (SPEC §4.4).
 *
 * Result acceptance attaches to the queue through a synchronous acceptor: validation runs inside
 * the `complete` transaction (fail-closed, rejection leaves the model holding the lease), and the accepted result is written
 * after it commits.
 */

/** Route thresholds and section batching. T12 will tune the batch size while measuring latency. */
export interface RouteConfig {
    /** At most this many changed lines (additions + deletions): small PR, no route needed (requirements §3.6). */
    readonly smallPrMaxChangedLines: number;
    /** How many plan stops go into one `route.section` task. */
    readonly sectionBatchSize: number;
}

export const DEFAULT_ROUTE_CONFIG: RouteConfig = {
    smallPrMaxChangedLines: 40,
    sectionBatchSize: 1,
};

/**
 * How many times the server enqueues a plan task within one generation. Usually one is enough:
 * the counter prevents a loop where "the result was accepted but could not be applied". Otherwise a failed
 * snapshot write would send the agent through full generation forever.
 */
export const MAX_SKELETON_TASKS = 3;

/** Common prefix of route task types (`route.skeleton`, `route.section`). */
const ROUTE_TASK_PREFIX = 'route.';

/**
 * Delay for the one-off check after server startup: "diff on screen in under 2 seconds" (requirements §7),
 * so startup does not wait for `getDiff()`. Warmup moves to a deferred timer that does not keep
 * the process alive (`unref`) and does not count as activity for idle tracking.
 */
const WARMUP_DELAY_MS = 200;

/** The part of `ProgressStore` the orchestrator needs to clear previous stop progress. */
export interface StopProgressReset {
    readonly clearStopProgress: () => number;
    /** Called within the `RouteStore.acceptSkeleton` transaction. Apply the effect only after commit. */
    readonly clearStopProgressInTransaction: () => () => void;
}

export interface RouteOrchestratorOptions {
    readonly store: RouteStore;
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** The PR's review host. With `null`, this server has nowhere to get a route from. */
    readonly host: ReviewHost | null;
    /** Directory owned exclusively by `RoutePayloadWriter` (`routePayloadDirOf`). */
    readonly payloadDir: string;
    /** Shared PR context: the guide and diff use a stable path, not a copy per task. */
    readonly shared: SharedPayloadStore;
    /**
     * Reading progress: a new generation clears previous stop marks and their seen ranges
     * when the new plan is accepted (progress carryover is M4). `null` means nothing to clear (tests).
     */
    readonly progress?: StopProgressReset | null;
    /** Local storage for iteration patches. `null` means there is nowhere to save the generation diff (tests without a DB). */
    readonly iterations?: IterationStore | null;
    readonly config?: Partial<RouteConfig>;
    /** Warmup delay after startup. Tests call warmup explicitly (`warmup`). */
    readonly warmupDelayMs?: number;
}

export class RouteOrchestrator {
    private readonly store: RouteStore;
    private readonly queue: TaskQueue;
    private readonly registry: WorkerRegistry;
    private readonly host: ReviewHost | null;
    private readonly payload: RoutePayloadWriter;
    private readonly progress: StopProgressReset | null;
    private readonly iterations: IterationStore | null;
    private readonly config: RouteConfig;
    private readonly warmupDelayMs: number;

    /**
     * Generation diff in process memory: section acceptance is synchronous, while `getDiff` is a network call,
     * so the diff is loaded in advance and kept until generation finishes.
     */
    private diff: PrDiff | null = null;
    private diffLoad: Promise<PrDiff> | null = null;
    /** PR metadata for the payload. `null` means the host did not provide it, so the route uses only the diff. */
    private meta: PrMeta | null = null;

    private unsubscribeQueue: (() => void) | null = null;
    private unsubscribeWorker: (() => void) | null = null;
    private warmupTimer: NodeJS.Timeout | null = null;

    private closed = false;
    private reconciling = false;
    private reconcileAgain = false;

    constructor(options: RouteOrchestratorOptions) {
        this.store = options.store;
        this.queue = options.queue;
        this.registry = options.registry;
        this.host = options.host;
        this.payload = new RoutePayloadWriter({ payloadDir: options.payloadDir, shared: options.shared });
        this.progress = options.progress ?? null;
        this.iterations = options.iterations ?? null;
        this.config = resolveConfig(options.config);
        this.warmupDelayMs = options.warmupDelayMs ?? WARMUP_DELAY_MS;
    }

    /** State machine subscriptions and a one-time warmup. Called once during server composition. */
    start(): void {
        this.unsubscribeQueue = this.queue.subscribeChanges(() => {
            this.reconcile();
        });
        // Once the agent connects, someone can execute generation tasks (requirements §8).
        this.unsubscribeWorker = this.registry.subscribe((status: WorkerStatus) => {
            if (status.kind === 'connected') {
                this.warmupInBackground();
            }
        });

        const timer = setTimeout(() => {
            this.warmupTimer = null;
            this.warmupInBackground();
        }, this.warmupDelayMs);
        timer.unref();
        this.warmupTimer = timer;
    }

    close(): void {
        this.closed = true;
        this.unsubscribeQueue?.();
        this.unsubscribeWorker?.();
        if (this.warmupTimer !== null) {
            clearTimeout(this.warmupTimer);
            this.warmupTimer = null;
        }
    }

    /** Warmup from a timer or subscription catches its own exceptions because there is no caller to catch them. */
    private warmupInBackground(): void {
        void this.warmup().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: route warmup failed: ${message}\n`);
        });
    }

    /**
     * Warmup calculates the small PR threshold, queues missing tasks for interrupted generation,
     * and queues the skeleton if there is no route and an agent is connected. Host errors do not escape here.
     * Warmup runs in the background and must not make other operations fail.
     */
    async warmup(): Promise<void> {
        if (this.isClosed() || this.host === null) {
            return;
        }

        let diff: PrDiff;
        try {
            diff = await this.loadDiff();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: route not warmed up, diff unavailable: ${message}\n`);
            return;
        }
        if (this.isClosed()) {
            return;
        }

        this.store.setSmallPr(isSmallPr(diff, this.config));
        if (this.store.read().smallPr) {
            return;
        }

        // Repair interrupted generation before automatic enqueueing. The `filling` phase without tasks means
        // the server restarted, so the existing generation must resume.
        this.reconcile();

        const phase = this.store.read().phase;
        // Only the button recovers `failed`, otherwise the server would retry the same failure forever.
        if (phase !== 'none' || this.registry.status().kind !== 'connected' || this.hasOpenRouteTask()) {
            return;
        }
        this.startSkeleton();
    }

    /**
     * The `review/route/generate` endpoint starts and restarts generation. From `ready`, the old route
     * stays readable until the new skeleton is accepted. Its progress carryover remains in M4.
     */
    async generate(): Promise<UiRouteGenerateResponse['outcome']> {
        if (this.host === null) {
            throw new RpcFailure(
                'no_review_host',
                'This PR has no host adapter, so there is no source for building a route.',
            );
        }

        const diff = await this.loadDiff();
        this.store.setSmallPr(isSmallPr(diff, this.config));
        if (this.store.read().smallPr) {
            return 'small_pr';
        }

        const phase = this.store.read().phase;
        if (phase === 'reading' || phase === 'filling') {
            return 'already_running';
        }

        this.startSkeleton();
        return 'started';
    }

    /** Fills a failed stop through the regular `filling` phase and reconciliation. */
    async fillStop(snapshotId: string, planIndex: number): Promise<UiRouteFillStopResponse['outcome']> {
        await this.loadDiff();

        const state = this.store.read();
        if (state.phase !== 'ready') {
            return 'already_running';
        }
        if (state.snapshot?.snapshotId !== snapshotId) {
            return 'stale_snapshot';
        }

        const stop = state.snapshot.stops.find((candidate) => candidate.planIndex === planIndex);
        if (stop?.status !== 'failed') {
            return 'not_unfilled';
        }

        // Keep progress. The UI cannot mark an unfilled stop, and marks on other stops remain valid.
        this.store.beginStopFill(planIndex);
        this.reconcile();
        return 'started';
    }

    /**
     * Which planned stops the task fills. `null` means the task is not from the current generation.
     * Exposed for diagnostics and tests. Within the task, plan numbers are included in the prompt text.
     */
    stopsOfTask(taskId: number): number[] | null {
        return this.store.bindings().get(taskId)?.planIndexes ?? null;
    }

    /**
     * Fail-closed acceptance of a generation task result (called by the queue inside the
     * `complete` transaction). Other task types return `null`, leaving `echo` acceptance unchanged.
     */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type === 'route.skeleton') {
            return this.acceptSkeleton(task, result);
        }
        if (task.type === 'route.section') {
            return this.acceptSection(task, result);
        }
        return null;
    }

    private acceptSkeleton(task: TaskRecord, result: string): TaskResultAcceptance {
        const diff = this.diff;
        if (diff === null) {
            return this.deferUntilDiff();
        }
        if (this.store.bindings().get(task.id)?.kind !== 'skeleton') {
            return { kind: 'rejected', errors: [STALE_GENERATION] };
        }

        const validation = validateSkeleton(result);
        if (!validation.ok) {
            return { kind: 'rejected', errors: validation.errors };
        }

        const skeleton = validation.value;
        const provenance = provenanceOf(this.registry.status());
        return {
            kind: 'accepted',
            onCommitted: () => {
                const progress = this.progress;
                const current = this.store.read().snapshot;
                const clearStopProgress =
                    current === null || progress === null
                        ? undefined
                        : () => progress.clearStopProgressInTransaction();
                this.store.acceptSkeleton(
                    {
                        skeleton,
                        diff,
                        provenance,
                        snapshotId: randomUUID(),
                        // M4-T6 carries progress and `carried` over from this snapshot.
                        previousSnapshotId: current?.snapshotId ?? null,
                    },
                    clearStopProgress,
                );
                this.reconcile();
            },
        };
    }

    private acceptSection(task: TaskRecord, result: string): TaskResultAcceptance {
        const diff = this.diff;
        if (diff === null) {
            return this.deferUntilDiff();
        }

        const snapshot = this.store.read().snapshot;
        const binding = this.store.bindings().get(task.id);
        if (snapshot === null || binding?.kind !== 'section') {
            return { kind: 'rejected', errors: [STALE_GENERATION] };
        }

        const validation = validateSection(result, snapshot.stops, binding.planIndexes, diff);
        if (!validation.ok) {
            return { kind: 'rejected', errors: validation.errors };
        }

        const fillings = validation.value;
        const provenance = provenanceOf(this.registry.status());
        return {
            kind: 'accepted',
            onCommitted: () => {
                this.store.applyFillings(fillings, provenance);
                this.reconcile();
            },
        };
    }

    /**
     * No diff in memory means no way to validate the result: a transient server failure (restart during
     * generation or a failed warmup), not a model error, so rejection does not consume the budget.
     * Also trigger diff loading, otherwise a retry would hit the same failure.
     */
    private deferUntilDiff(): TaskResultAcceptance {
        this.warmupInBackground();
        return { kind: 'deferred', errors: [DIFF_NOT_READY] };
    }

    /**
     * Reconcile route state with queue state: stop statuses, enqueueing missing
     * sections, and transitions to `ready`/`failed`. Idempotent, so it runs on every queue
     * change. Reentry (enqueueing wakes subscribers) is deferred to another pass.
     */
    private reconcile(): void {
        if (this.isClosed()) {
            return;
        }
        if (this.reconciling) {
            this.reconcileAgain = true;
            return;
        }

        this.reconciling = true;
        try {
            do {
                this.reconcileAgain = false;
                this.reconcileOnce();
            } while (this.needsAnotherPass());
        } catch (error) {
            // Reconciliation runs in a queue subscriber. An exception would break another operation.
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: route reconciliation failed: ${message}\n`);
        } finally {
            this.reconciling = false;
        }
    }

    /** Read flags through a method, because type narrowing on a field hides changes made by other calls. */
    private isClosed(): boolean {
        return this.closed;
    }

    private needsAnotherPass(): boolean {
        return this.reconcileAgain && !this.closed;
    }

    private reconcileOnce(): void {
        this.cancelOrphanRouteTasks();

        const state = this.store.read();
        if (state.phase === 'reading') {
            this.reconcileSkeleton();
            return;
        }
        if (state.phase !== 'filling' || state.snapshot === null) {
            // In `none`/`failed`/`ready`, the state machine is idle. Only the `generate` endpoint advances it.
            return;
        }

        const snapshot = state.snapshot;
        const tasks = this.routeTasks();
        const sectionOf = new Map<number, TaskRecord>();
        for (const { record, binding } of tasks) {
            if (binding.kind !== 'section') {
                continue;
            }
            for (const planIndex of binding.planIndexes) {
                sectionOf.set(planIndex, record);
            }
        }

        const updates = new Map<number, RouteStopStatusUpdate>();
        const pending: number[] = [];
        for (const stop of snapshot.stops) {
            if (stop.tier === 'other' || stop.status === 'ready' || stop.status === 'failed') {
                continue;
            }

            const task = sectionOf.get(stop.planIndex);
            if (task === undefined) {
                pending.push(stop.planIndex);
                updates.set(stop.planIndex, { status: 'queued' });
                continue;
            }
            updates.set(stop.planIndex, stopStatusOf(task));
        }
        this.store.setStopStatuses(updates);

        if (pending.length > 0) {
            this.enqueueSections(pending);
            return;
        }
        // No open section tasks remain, so the snapshot can be frozen (decision 4:
        // a section failure does not fail the phase, and its stop keeps `status: 'failed'`).
        const stops = this.store.read().snapshot?.stops ?? [];
        if (!stops.some((stop) => stop.status === 'queued' || stop.status === 'filling')) {
            this.store.markReady();
        }
    }

    /** The `reading` phase lasts until the skeleton task reaches its outcome. */
    private reconcileSkeleton(): void {
        const skeletons = this.routeTasks().filter((task) => task.binding.kind === 'skeleton');
        if (skeletons.some(({ record }) => record.status === 'queued' || record.status === 'leased')) {
            return;
        }

        const last = skeletons.at(-1)?.record;
        if (last === undefined) {
            // Server restarted during a phase with no task: enqueue the skeleton again (decision 8).
            this.restartSkeletonTask(skeletons.length, null);
            return;
        }
        if (last.status === 'failed') {
            this.store.fail(skeletonFailureMessage(last), last.result);
            return;
        }
        if (last.status === 'cancelled') {
            this.store.cancelSkeleton();
            return;
        }
        // The task is `done`, but the phase is still `reading`: applying the accepted result failed (the server died
        // between acceptance and writing the snapshot, or the write failed). The accepted result is no longer
        // available, so build the plan again.
        this.restartSkeletonTask(skeletons.length, last.result);
    }

    /**
     * Requeue the plan after a failed attempt to apply it. Count previously queued tasks
     * through their bindings, which live for exactly one generation. The count needs no storage
     * or reset. `generate` clears the bindings and restores the full set of attempts.
     */
    private restartSkeletonTask(alreadyEnqueued: number, rawOutput: string | null): void {
        if (alreadyEnqueued >= MAX_SKELETON_TASKS) {
            this.store.fail(
                `The route did not come together: the server queued the plan ${String(MAX_SKELETON_TASKS)} times and never ` +
                    'managed to apply the result.',
                rawOutput,
            );
            return;
        }
        this.startSkeletonTask();
    }

    /** New generation cancels previous tasks and keeps the live snapshot until a new one is accepted. */
    private startSkeleton(): void {
        const hasSnapshot = this.store.read().snapshot !== null;
        this.cancelOpenRouteTasks();
        this.store.clearBindings();
        this.store.beginSkeleton();
        // The previous generation payload is no longer needed. Its tasks were just cancelled.
        this.payload.beginGeneration();
        // Keep the previous clearing point for initial generation. During a rebuild, old stops
        // live until the new plan is accepted and are cleared atomically with its snapshot.
        if (!hasSnapshot) {
            this.progress?.clearStopProgress();
        }
        this.startSkeletonTask();
    }

    private startSkeletonTask(): void {
        const diff = this.diff;
        if (diff === null) {
            // The server restarted during generation. There is no diff to build the payload from, so scheduling
            // waits for it. Warmup finishes the work and calls reconciliation again at the end.
            this.warmupInBackground();
            return;
        }
        this.enqueueRouteTask('skeleton', [], this.payload.skeletonTask({ diff, meta: this.meta }));
    }

    /**
     * Queue sections in plan order. The first submitted result wins a range conflict
     * between results (the validator's `planOccupancy` invariant), so the queue must
     * offer stops in ascending plan number order.
     */
    private enqueueSections(planIndexes: readonly number[]): void {
        const snapshot = this.store.read().snapshot;
        const diff = this.diff;
        if (snapshot === null) {
            return;
        }
        if (diff === null) {
            // As with the skeleton: no diff means no payload, so stops remain `queued` until warmup.
            this.warmupInBackground();
            return;
        }

        const intents = this.store.stopIntents();
        const context = { diff, meta: this.meta };
        const ordered = [...planIndexes].sort((left, right) => left - right);
        for (let from = 0; from < ordered.length; from += this.config.sectionBatchSize) {
            const batch = ordered.slice(from, from + this.config.sectionBatchSize);
            const input = this.payload.sectionTask(context, batch, snapshot.stops, intents);
            this.enqueueRouteTask('section', batch, input);
        }
    }

    /**
     * Enqueue a route task with its stop binding. Suppress reconciliation during enqueueing:
     * between `enqueue` and writing the binding, the task looks unrelated, and reconciliation
     * triggered by enqueueing would queue a duplicate. The writes use separate transactions
     * (`node:sqlite` does not support nesting), so a process crash between them leaves an orphan
     * that `cancelOrphanRouteTasks` catches.
     */
    private enqueueRouteTask(
        kind: RouteTaskBinding['kind'],
        planIndexes: readonly number[],
        input: EnqueueInput,
    ): void {
        const outer = this.reconciling;
        this.reconciling = true;
        try {
            const record = this.queue.enqueue(input);
            this.store.bindTask(record.id, kind, planIndexes);
        } finally {
            this.reconciling = outer;
        }

        if (outer) {
            this.reconcileAgain = true;
        } else {
            this.reconcile();
        }
    }

    private cancelOpenRouteTasks(): void {
        for (const { record } of this.routeTasks()) {
            if (record.status === 'queued' || record.status === 'leased') {
                this.queue.cancel(record.id);
            }
        }
    }

    /**
     * A route task without a binding is an orphan. The process died between enqueueing and writing the binding
     * (2 consecutive transactions with no atomicity between them). The state machine cannot see this task,
     * but the queue would still offer it to an agent, so cancel open orphans.
     */
    private cancelOrphanRouteTasks(): void {
        const bindings = this.store.bindings();
        for (const record of this.queue.listTasks()) {
            const open = record.status === 'queued' || record.status === 'leased';
            if (open && record.type.startsWith(ROUTE_TASK_PREFIX) && !bindings.has(record.id)) {
                this.queue.cancel(record.id);
            }
        }
    }

    private hasOpenRouteTask(): boolean {
        return this.routeTasks().some(
            ({ record }) => record.status === 'queued' || record.status === 'leased',
        );
    }

    /** Current generation route tasks with their bindings, in enqueue order. */
    private routeTasks(): { record: TaskRecord; binding: RouteTaskBinding }[] {
        const bindings = this.store.bindings();
        if (bindings.size === 0) {
            return [];
        }

        // `listTasks` also lazily requeues tasks whose lease expired. An agent that died silently
        // leaves stops ready to be filled again, without a single timer.
        return this.queue.listTasks().flatMap((record) => {
            const binding = bindings.get(record.id);
            return binding === undefined ? [] : [{ record, binding }];
        });
    }

    /**
     * Generation diff. Cached per process: the route is built for one iteration, and section acceptance
     * must resolve anchors against the same diff the skeleton saw.
     */
    private async loadDiff(): Promise<PrDiff> {
        const host = this.host;
        if (host === null) {
            throw new RpcFailure('no_review_host', 'This PR has no host adapter, so there is no source for building a route.');
        }
        if (this.diff !== null) {
            return this.diff;
        }

        this.diffLoad ??= (async () => {
            try {
                // PR metadata enriches the payload (title, author, branches). Its failure must not break the route,
                // so it is fetched alongside the diff and silently left `null` on failure.
                const [diff, meta] = await Promise.all([
                    host.getDiff(),
                    host.getPr().then(
                        (value) => value,
                        () => null,
                    ),
                ]);
                this.meta = meta;
                // The patch of the iteration used to build the route must survive the next push:
                // it is needed to read the old snapshot (brief §4a).
                if (this.iterations !== null) {
                    void rememberIterationDiff(this.iterations, host, diff);
                }
                return diff;
            } catch (error) {
                // A failure must not persist for the whole process: the next call tries again.
                this.diffLoad = null;
                if (error instanceof RpcFailure) {
                    throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new RpcFailure('host_unavailable', `The host adapter did not return the diff: ${message}`);
            }
        })();

        const diff = await this.diffLoad;
        this.diff = diff;
        return diff;
    }
}

/** The server has not received the diff yet and cannot validate the result. The model must retry the call. */
const DIFF_NOT_READY =
    'The server has not loaded the diff of this pull request yet and cannot validate the result. ' +
    'Wait a few seconds and call `complete` again with the same result.';

/** The task belongs to cancelled or restarted generation, so there is nowhere to put its result. */
const STALE_GENERATION =
    'The route generation this task belongs to is no longer running: it was restarted or cancelled. ' +
    'Call `worker next` and work on the task it gives you.';

/**
 * Route threshold (requirements §3.6): a tiny PR can be read in full, so a route adds overhead.
 * Measure only the size of the change across all files. A single 500-line file also needs a route.
 */
export function isSmallPr(diff: PrDiff, config: RouteConfig): boolean {
    const changedLines = diff.files.reduce((total, file) => total + file.additions + file.deletions, 0);
    return changedLines <= config.smallPrMaxChangedLines;
}

function resolveConfig(overrides: Partial<RouteConfig> | undefined): RouteConfig {
    const config = { ...DEFAULT_ROUTE_CONFIG, ...overrides };
    // A zero batch is a configuration typo, not an empty workload. It would make section enqueueing loop forever.
    return { ...config, sectionBatchSize: Math.max(1, Math.trunc(config.sectionBatchSize)) };
}

/** Stop status from the state of the task filling it. */
function stopStatusOf(task: TaskRecord): RouteStopStatusUpdate {
    switch (task.status) {
        case 'queued':
            return { status: 'queued' };
        case 'leased':
            return { status: 'filling' };
        case 'cancelled':
            return { status: 'failed', note: 'Filling this stop was cancelled.' };
        case 'failed':
            return {
                status: 'failed',
                note: `The stop was not filled: ${task.failReason ?? 'the agent gave no reason'}`,
            };
        default:
            // The task finished successfully but the slot is empty. The model submitted a result without this stop.
            return {
                status: 'failed',
                note: 'The agent submitted a result without this stop. The slot was not filled.',
            };
    }
}

/** Generation failure reason for the red card in README §12, in one Russian sentence. */
function skeletonFailureMessage(task: TaskRecord): string {
    const reason = (task.failReason ?? '').trim();
    return reason === ''
        ? 'The agent did not build a route plan and gave no reason.'
        : `The agent did not build a route plan: ${reason}`;
}

function provenanceOf(status: WorkerStatus): RouteProvenance {
    if (status.kind === 'never') {
        return { harness: null, model: null };
    }
    return { harness: status.harness ?? null, model: status.model ?? null };
}
