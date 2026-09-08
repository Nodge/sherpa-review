import { randomUUID } from 'node:crypto';

import type {
    HostId,
    Iteration,
    Locale,
    PrDiff,
    PrMeta,
    ReviewHost,
    RouteCarriedZeroReason,
    RouteProvenance,
    RouteSnapshot,
    Thread,
    UiRouteFillStopResponse,
    UiRouteGenerateResponse,
    WorkerStatus,
} from '@sherpa/protocol';

import { RpcFailure } from './errors.js';
import { resolveGenerationLocale } from './generation-locale.js';
import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, identityMap } from './iterations/index.js';
import type { ProgressStore } from './progress-store.js';
import type { EnqueueInput, TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import { RoutePayloadWriter } from './route-payload.js';
import type { RouteRegenerationContext } from './route-regeneration.js';
import type {
    RouteStopStatusUpdate,
    RouteStore,
    RouteTaskBinding,
    SnapshotAcceptance,
} from './route-store.js';
import type { RouteStrings } from './route/index.js';
import { routeStrings, validateSection, validateSkeleton } from './route/index.js';
import type { SettingsStore } from './settings-store.js';
import type { SharedPayloadStore } from './shared-payload.js';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * Route orchestration: a state machine from "no route → skeleton → sections → ready".
 *
 * The state of `RouteStore` alongside the queue state is the single source of truth for what
 * to do next. Reconciliation (`reconcile`) computes transitions instead of recording them as events. Reconciliation
 * is idempotent, so a server restart during generation, agent death and session eviction
 * recover on their own, with no special-case code (docs/design/SPEC-elements.md §4.4).
 *
 * Result acceptance attaches to the queue through a synchronous acceptor: validation runs inside
 * the `complete` transaction (fail-closed, rejection leaves the model holding the lease), and the accepted result is written
 * after it commits.
 */

/** Route thresholds and section batching: latency measurements kept the batch at one stop. */
export interface RouteConfig {
    /** At or below this many changed lines (additions + deletions), the PR is small and needs no route (docs/architecture.md §7.6). */
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
 * Delay for a one-time check after server startup: "diff on screen in under two seconds",
 * so startup does not wait for `getDiff()`. Warmup moves to a deferred timer that does not keep
 * the process alive (`unref`) and does not count as activity for idle tracking.
 */
const WARMUP_DELAY_MS = 200;

/** The part of `ProgressStore` the orchestrator needs: carrying marks over to a new snapshot. */
export type StopProgressCarry = Pick<ProgressStore, 'carryStopsInTransaction' | 'hasViewedMarks'>;

/**
 * Ongoing generation: its iteration and everything needed to carry progress over to its snapshot.
 * The map is built ahead of time (interdiff is a network call), because the result acceptor is synchronous.
 */
interface GenerationContext {
    readonly diff: PrDiff;
    /** The snapshot current at generation start. null means the route is being built for the first time. */
    readonly previousSnapshotId: string | null;
    /** Line mapping "previous snapshot iteration → generation iteration". null means there is no interdiff. */
    readonly map: IterationMap | null;
    /** The same slice as patches: sent to the model as a context file. */
    readonly interdiff: PrDiff | null;
    /** PR threads at generation start. null means no previous snapshot, a host failure or a restart. */
    readonly threads: readonly Thread[] | null;
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
     * Reading progress: carryover sets the new snapshot's stop marks when it is accepted.
     * `null` means there is nowhere to carry them to (tests without progress).
     */
    readonly progress?: StopProgressCarry | null;
    /** Local storage for iteration patches. `null` means there is nowhere to save the generation diff (tests without a DB). */
    readonly iterations?: IterationStore | null;
    /**
     * Global UI settings provide the generation language when the request does not specify one.
     * `null` means settings are unavailable, so the fallback order continues with the agent hint and English.
     */
    readonly settings?: Pick<SettingsStore, 'read'> | null;
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
    private readonly progress: StopProgressCarry | null;
    private readonly iterations: IterationStore | null;
    private readonly settings: Pick<SettingsStore, 'read'> | null;
    private readonly config: RouteConfig;
    private readonly warmupDelayMs: number;

    /**
     * Context for the generation running in this process. Section acceptance is synchronous, while `getDiff`
     * and interdiff are network calls. The generation iteration is fixed when generation starts and does not change,
     * even if the author pushes (generation runs to completion, and the snapshot
     * is already stale when created).
     */
    private generation: GenerationContext | null = null;
    /**
     * Latest diff of the active iteration, used to start the next generation. It does not become the diff
     * of the running generation. The task binding names its iteration and is the only source after a restart.
     */
    private activeDiff: PrDiff | null = null;
    /** Active diff load in progress. Concurrent calls share one host request. */
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
        this.settings = options.settings ?? null;
        this.config = resolveConfig(options.config);
        this.warmupDelayMs = options.warmupDelayMs ?? WARMUP_DELAY_MS;
    }

    /** State machine subscriptions and a one-time warmup. Called once during server composition. */
    start(): void {
        this.unsubscribeQueue = this.queue.subscribeChanges(() => {
            this.reconcile();
        });
        // Once an agent connects, someone can execute generation tasks.
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

        const context = await this.generationContextFor(diff);
        // Another warmup or endpoint may have started generation while the slice was being calculated. A second start
        // would cancel its task and rebuild the plan.
        if (this.isClosed() || this.store.read().phase !== 'none' || this.hasOpenRouteTask()) {
            return;
        }
        // The server initiated automatic enqueueing without a locale, so the fallback order applies.
        this.startSkeleton(context, this.resolveLocale(undefined));
    }

    /**
     * The `review/route/generate` endpoint starts and restarts generation. From `ready`, the old route
     * remains readable until the new skeleton is accepted, and its progress carries over to the new snapshot
     * during acceptance.
     *
     * `requestedLocale` is the effective language of the tab where the button was clicked. Without it,
     * `resolveGenerationLocale` chooses the language using the fallback order.
     */
    async generate(requestedLocale?: Locale): Promise<UiRouteGenerateResponse['outcome']> {
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

        const context = await this.generationContextFor(diff);
        // Warmup or another endpoint request may have started generation while the slice was being calculated.
        const phaseNow = this.store.read().phase;
        if (phaseNow === 'reading' || phaseNow === 'filling') {
            return 'already_running';
        }
        this.startSkeleton(context, this.resolveLocale(requestedLocale));
        return 'started';
    }

    /**
     * Fill a single failed stop through the regular `filling` phase and reconciliation. Anchors resolve
     * against the snapshot iteration diff. The PR may have advanced, but this fills the old route.
     */
    async fillStop(snapshotId: string, planIndex: number): Promise<UiRouteFillStopResponse['outcome']> {
        if (this.host === null) {
            throw new RpcFailure('no_review_host', 'This PR has no host adapter, so there is no source for building a route.');
        }

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
        // Fill the route for its own iteration. The active iteration may have advanced, so anchors
        // must not resolve against its diff.
        await this.ensureDiff(state.snapshot.diffId);

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
        const binding = this.store.bindings().get(task.id);
        if (binding?.kind !== 'skeleton') {
            return { kind: 'rejected', errors: [STALE_GENERATION] };
        }

        // There is no snapshot yet, and only the task binding knows its iteration. After a server restart,
        // using the active iteration would accept a plan read from a different diff.
        const diff = binding.diffId === null ? null : this.diffOf(binding.diffId);
        if (diff === null) {
            return this.deferUntilDiff();
        }

        const locale = this.skeletonLocale();
        const validation = validateSkeleton(result, locale);
        if (!validation.ok) {
            return { kind: 'rejected', errors: validation.errors };
        }

        const skeleton = validation.value;
        const provenance = provenanceOf(this.registry.status(), locale);
        return {
            kind: 'accepted',
            onCommitted: () => {
                const previous = this.store.current();
                const snapshotId = randomUUID();
                // Do not calculate mark carryover yet. Stops have no anchors, and `carried` with zero
                // would make the banner say "0 of 7". Counts appear when the snapshot is frozen (`markReady`).
                this.store.acceptSkeleton({
                    skeleton,
                    diff,
                    provenance,
                    snapshotId,
                    previousSnapshotId: previous?.snapshotId ?? null,
                });
                // The generation cap belongs to the snapshot, not the task. The snapshot id is only available here.
                this.store.setGenerationCap(snapshotId, this.payload.generationCap({ diff, meta: this.meta }));
                this.reconcile();
            },
        };
    }

    private acceptSection(task: TaskRecord, result: string): TaskResultAcceptance {
        const snapshot = this.store.read().snapshot;
        const binding = this.store.bindings().get(task.id);
        if (snapshot === null || binding?.kind !== 'section') {
            return { kind: 'rejected', errors: [STALE_GENERATION] };
        }

        const diff = this.diffOf(snapshot.diffId);
        if (diff === null) {
            return this.deferUntilDiff();
        }

        const generation = this.acceptanceContext(diff, snapshot.previousSnapshotId);
        // Sections use the skeleton language, so the entire snapshot has one language.
        const locale = snapshotLocale(snapshot);
        const validation = validateSection(result, snapshot.stops, binding.planIndexes, diff, {
            locale,
            map: generation.map,
            knownThreadIds: new Set((generation.threads ?? []).map((thread) => thread.id)),
        });
        if (!validation.ok) {
            return { kind: 'rejected', errors: validation.errors };
        }

        const fillings = validation.value;
        const provenance = provenanceOf(this.registry.status(), locale);
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
        const strings = routeStrings(snapshotLocale(snapshot));
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
            updates.set(stop.planIndex, stopStatusOf(task, strings));
        }
        this.store.setStopStatuses(updates);

        if (pending.length > 0) {
            this.enqueueSections(pending);
            return;
        }
        // No open section tasks remain, so the snapshot can be frozen
        // (failure of an individual section does not fail the phase, and the stop keeps `status: 'failed'`).
        const stops = this.store.read().snapshot?.stops ?? [];
        if (!stops.some((stop) => stop.status === 'queued' || stop.status === 'filling')) {
            this.markReadyCarryingProgress();
        }
    }

    /**
     * Freeze the snapshot and carry over stop marks. Anchors appear only
     * in filled sections, so carryover is calculated here, after skeleton acceptance.
     */
    private markReadyCarryingProgress(): void {
        const snapshot = this.store.read().snapshot;
        const previousId = snapshot?.previousSnapshotId ?? null;
        const previous = previousId === null ? null : this.store.getSnapshot(previousId);
        if (snapshot === null || previous === null || this.progress === null) {
            this.store.markReady();
            return;
        }

        const diff = this.diffOf(snapshot.diffId);
        const map = diff === null ? null : this.acceptanceContext(diff, previousId).map;
        this.store.markReady((ready) => this.carryProgressInto(ready, previous, map));
    }

    /**
     * Acceptance context uses the map prepared at generation start, or the slice cache
     * after a restart. The "previous snapshot → generation iteration" pair must match, or the map is for another pair.
     */
    private acceptanceContext(diff: PrDiff, previousSnapshotId: string | null): GenerationContext {
        const prepared = this.generation;
        if (
            prepared !== null &&
            prepared.diff.diffId === diff.diffId &&
            prepared.previousSnapshotId === previousSnapshotId
        ) {
            return prepared;
        }
        // Generation context was lost with the process. Look up the previous snapshot by id,
        // because a newer one may already be current.
        return this.cachedContextFor(
            diff,
            previousSnapshotId === null ? null : this.store.getSnapshot(previousSnapshotId),
        );
    }

    /**
     * Carry progress over to the snapshot within its write transaction. `carried` counts marked
     * stops against stops with anchors (second pass banner, docs/design/README.md §9).
     * Carryover cannot cover the synthetic "Other" stop or unfilled stops, so they do not belong
     * in the denominator. When carryover is zero, include the reason.
     */
    private carryProgressInto(
        snapshot: RouteSnapshot,
        previous: RouteSnapshot | null,
        map: IterationMap | null,
    ): SnapshotAcceptance {
        const progress = this.progress;
        const total = snapshot.stops.filter((stop) => stop.anchors.length > 0).length;
        if (previous === null || progress === null) {
            // First snapshot of the PR. There is no source for carryover.
            return { carried: null };
        }

        const diff = this.diffOf(snapshot.diffId);
        if (map === null || diff === null) {
            process.stderr.write(
                `sherpa-server: cannot carry over marks: no interdiff ${previous.diffId}→${snapshot.diffId}\n`,
            );
            const keptBefore = snapshot.carried?.kept ?? 0;
            // A missing slice matters only where there were marks to carry over.
            const zeroReason = zeroCarryReason(keptBefore, progress, previous.diffId, 'no_interdiff');
            return { carried: { kept: keptBefore, total, zeroReason } };
        }

        const carried = progress.carryStopsInTransaction({
            snapshotId: snapshot.snapshotId,
            diffId: snapshot.diffId,
            stops: snapshot.stops,
            diff,
        });
        // Marks may have carried over in several passes (freezing, filling a stop).
        const kept = (snapshot.carried?.kept ?? 0) + carried.kept;
        const zeroReason = zeroCarryReason(kept, progress, previous.diffId, 'no_overlap');
        return {
            carried: { kept, total, zeroReason },
            afterCommit: () => {
                carried.afterCommit();
                process.stderr.write(
                    `sherpa-server: snapshot ${snapshot.snapshotId}: carried over ${String(kept)} of ` +
                        `${String(total)} stops from ${previous.snapshotId}` +
                        `${zeroCarryNote(zeroReason)}\n`,
                );
            },
        };
    }

    /** The `reading` phase lasts until the skeleton task reaches its outcome. */
    private reconcileSkeleton(): void {
        const skeletons = this.routeTasks().filter((task) => task.binding.kind === 'skeleton');
        if (skeletons.some(({ record }) => record.status === 'queued' || record.status === 'leased')) {
            return;
        }

        const last = skeletons.at(-1)?.record;
        if (last === undefined) {
            // The server restarted with no task for this phase. Queue the skeleton again.
            this.restartSkeletonTask(skeletons.length, null);
            return;
        }
        if (last.status === 'failed') {
            this.store.fail(skeletonFailureMessage(last, routeStrings(this.skeletonLocale())), last.result);
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
                routeStrings(this.skeletonLocale()).skeletonNotApplied(MAX_SKELETON_TASKS),
                rawOutput,
            );
            return;
        }
        this.startSkeletonTask();
    }

    /** New generation cancels previous tasks and keeps the live snapshot until a new one is accepted. */
    private startSkeleton(context: GenerationContext, locale: Locale): void {
        this.generation = context;
        // Store the language in storage, not a field. The next process may accept the skeleton task.
        this.store.setGenerationLocale(locale);
        this.cancelOpenRouteTasks();
        this.store.clearBindings();
        this.store.beginSkeleton();
        // The previous generation payload is no longer needed. Its tasks were just cancelled.
        // Write regeneration context once here. The skeleton and all sections share it.
        this.payload.beginGeneration(this.regenerationOf(context));
        this.startSkeletonTask();
    }

    /**
     * Generation context maps lines from the current snapshot iteration to the new generation iteration.
     * Calculate it ahead of time because interdiff is a network call and result acceptance is synchronous.
     * Generation proceeds even if the slice is unavailable, but stop marks will not carry over.
     */
    private async generationContextFor(diff: PrDiff): Promise<GenerationContext> {
        const previous = this.store.current();
        if (previous === null) {
            return { diff, previousSnapshotId: null, map: null, interdiff: null, threads: null };
        }

        // Only regeneration needs threads. They explain why the author changed a stop. Fetch them
        // alongside the slice. Generation waits for both, so sequential requests would add unnecessary latency.
        const threads = this.loadThreads();
        const base = async (): Promise<Pick<GenerationContext, 'diff' | 'previousSnapshotId' | 'threads'>> => ({
            diff,
            previousSnapshotId: previous.snapshotId,
            threads: await threads,
        });
        if (previous.diffId === diff.diffId) {
            // Regeneration on the same iteration. Lines have not moved.
            return { ...(await base()), map: identityMap(), interdiff: null };
        }

        const host = this.host;
        const iterations = this.iterations;
        if (host === null || iterations === null) {
            return { ...(await base()), map: null, interdiff: null };
        }
        try {
            const interdiff = await iterations.getInterdiff(previous.diffId, diff.diffId, () =>
                host.getDiff({ base: previous.diffId, head: diff.diffId }),
            );
            return {
                ...(await base()),
                interdiff,
                map: buildIterationMap({
                    interdiff,
                    fromBaseCommit: previous.baseCommit,
                    toBaseCommit: diff.baseCommit,
                }),
            };
        } catch (error) {
            process.stderr.write(
                `sherpa-server: could not fetch slice ${previous.diffId}→${diff.diffId}: ${messageOf(error)}\n`,
            );
            return { ...(await base()), map: null, interdiff: null };
        }
    }

    /** PR threads for regeneration context. Host failure does not break generation, it just leaves the file absent. */
    private async loadThreads(): Promise<Thread[] | null> {
        const host = this.host;
        if (host === null) {
            return null;
        }
        try {
            return await host.getThreads();
        } catch (error) {
            process.stderr.write(
                `sherpa-server: could not fetch threads for regeneration context: ${messageOf(error)}\n`,
            );
            return null;
        }
    }

    /**
     * Generation context without a host request. Use the map from the slice cache, or leave it absent.
     * The caller names the previous snapshot, which is not always the current one.
     */
    private cachedContextFor(diff: PrDiff, previous: RouteSnapshot | null): GenerationContext {
        if (previous === null) {
            return { diff, previousSnapshotId: null, map: null, interdiff: null, threads: null };
        }
        if (previous.diffId === diff.diffId) {
            return {
                diff,
                previousSnapshotId: previous.snapshotId,
                map: identityMap(),
                interdiff: null,
                threads: null,
            };
        }

        const interdiff = this.iterations?.peekInterdiff(previous.diffId, diff.diffId) ?? null;
        return {
            diff,
            previousSnapshotId: previous.snapshotId,
            interdiff,
            // Threads require network requests, so restored context omits them. Acceptance will remove
            // any model references to them.
            threads: null,
            map:
                interdiff === null
                    ? null
                    : buildIterationMap({
                          interdiff,
                          fromBaseCommit: previous.baseCommit,
                          toBaseCommit: diff.baseCommit,
                      }),
        };
    }

    /**
     * Regeneration context for the payload: the previous snapshot and everything the task uses to explain the push.
     * null means there is no previous route, and the task is built as for the first generation.
     */
    private regenerationOf(context: GenerationContext | null): RouteRegenerationContext | null {
        const previousId = context?.previousSnapshotId ?? null;
        const previous = previousId === null ? null : this.store.getSnapshot(previousId);
        if (context === null || previous === null) {
            return null;
        }
        return {
            previous,
            interdiff: context.interdiff,
            map: context.map,
            threads: context.threads,
        };
    }

    private startSkeletonTask(): void {
        // Rescheduling after a restart starts the plan again and uses the active iteration. The previous
        // iteration was known by its task binding, which no longer exists at this point.
        const diff = this.generation?.diff ?? this.activeDiff;
        if (diff === null) {
            // The server restarted during generation. There is no diff to build the payload from, so scheduling
            // waits for it. Warmup finishes the work and calls reconciliation again at the end.
            this.warmupInBackground();
            return;
        }
        // Server restart: the generation context was lost with the process. Only a map already saved
        // in the slice cache remains.
        this.generation ??= this.cachedContextFor(diff, this.store.current());
        this.enqueueRouteTask(
            'skeleton',
            diff.diffId,
            [],
            this.payload.skeletonTask({
                diff,
                meta: this.meta,
                locale: this.skeletonLocale(),
                regeneration: this.regenerationOf(this.generation),
            }),
        );
    }

    /**
     * Queue sections in plan order. The first submitted result wins a range conflict
     * between results (the validator's `planOccupancy` invariant), so the queue must
     * offer stops in ascending plan number order.
     */
    private enqueueSections(planIndexes: readonly number[]): void {
        const snapshot = this.store.read().snapshot;
        if (snapshot === null) {
            return;
        }
        const diff = this.diffOf(snapshot.diffId);
        if (diff === null) {
            this.awaitOrAbandonDiff(snapshot.diffId);
            return;
        }

        const intents = this.store.stopIntents();
        const context = {
            diff,
            meta: this.meta,
            // Sections continue the skeleton, using the snapshot language instead of the current tab selection.
            locale: snapshotLocale(snapshot),
            regeneration: this.regenerationOf(this.acceptanceContext(diff, snapshot.previousSnapshotId)),
        };
        const ordered = [...planIndexes].sort((left, right) => left - right);
        for (let from = 0; from < ordered.length; from += this.config.sectionBatchSize) {
            const batch = ordered.slice(from, from + this.config.sectionBatchSize);
            const input = this.payload.sectionTask(context, batch, snapshot.stops, intents);
            this.enqueueRouteTask('section', snapshot.diffId, batch, input);
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
        diffId: HostId,
        planIndexes: readonly number[],
        input: EnqueueInput,
    ): void {
        const outer = this.reconciling;
        this.reconciling = true;
        try {
            const record = this.queue.enqueue(input);
            this.store.bindTask(record.id, kind, diffId, planIndexes);
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
     * Language of the generation enqueueing the plan, as sent in its prompt. A server restart
     * does not lose it. Only a DB that has never had a generation lacks the stored record.
     */
    private skeletonLocale(): Locale {
        return this.store.generationLocale() ?? this.resolveLocale(undefined);
    }

    /** Generation language fallback order: tab request → settings → agent hint → English. */
    private resolveLocale(requested: Locale | undefined): Locale {
        const status = this.registry.status();
        return resolveGenerationLocale({
            requested,
            setting: this.settings?.read().locale,
            agentLang: status.kind === 'never' ? undefined : status.lang,
        });
    }

    /** The iteration patch is lost. Explain why in the language of the affected route. */
    private lostDiffMessage(diffId: HostId): string {
        const snapshot = this.store.read().snapshot;
        const locale = snapshot === null ? this.skeletonLocale() : snapshotLocale(snapshot);
        return routeStrings(locale).lostDiff(diffId);
    }

    /** Iteration diff from process memory, or from local patch storage. */
    private diffOf(diffId: HostId): PrDiff | null {
        for (const candidate of [this.generation?.diff ?? null, this.activeDiff]) {
            if (candidate?.diffId === diffId) {
                return candidate;
            }
        }
        return this.iterations?.get(diffId)?.diff ?? null;
    }

    /**
     * Make the iteration diff available synchronously. A cache miss has exactly one recovery path:
     * ask the host for the active iteration, in case that is the requested one and its patch is not yet stored
     * (a database carried over from M3). The host cannot provide a complete previous iteration (`getDiff` only accepts a
     * slice), so failure is the only remaining option.
     */
    private async ensureDiff(diffId: HostId): Promise<PrDiff> {
        const known = this.diffOf(diffId);
        if (known !== null) {
            return known;
        }

        await this.loadDiff();
        const loaded = this.diffOf(diffId);
        if (loaded === null) {
            throw new RpcFailure('host_unavailable', this.lostDiffMessage(diffId));
        }
        return loaded;
    }

    /**
     * The snapshot iteration patch is missing from both memory and storage. Until the active diff loads,
     * wait for warmup, the only chance to recover it. If the active diff is already known and belongs to
     * another iteration, the patch is permanently lost. Stop generation with a reason,
     * otherwise reconciliation would keep warming up in a loop and monopolize the process.
     */
    private awaitOrAbandonDiff(diffId: HostId): void {
        if (this.activeDiff === null) {
            this.warmupInBackground();
            return;
        }
        this.store.fail(this.lostDiffMessage(diffId), null);
    }

    /**
     * Fetch the active iteration diff along with PR metadata and the iteration list. Store the patch
     * synchronously after the response. A snapshot built on this iteration must remain
     * readable after the next push (docs/product.md §4a), and generation cannot start before the write.
     *
     * Do not cache it for the process lifetime. `generationDiff` holds the generation iteration. Concurrent
     * calls share one request so warmup and the `generate` endpoint do not query the host twice.
     */
    private async loadDiff(): Promise<PrDiff> {
        const host = this.host;
        if (host === null) {
            throw new RpcFailure('no_review_host', 'This PR has no host adapter, so there is no source for building a route.');
        }

        // Keep the promise locally. The inner `finally` clears the field before we could read it.
        const load = (this.diffLoad ??= (async () => {
            try {
                // PR metadata supplements the payload (title, author, branches), while the iteration list provides
                // metadata for the active iteration. Failure of either request does not break the route.
                const [diff, meta, iterations] = await Promise.all([
                    host.getDiff(),
                    host.getPr().then(
                        (value) => value,
                        () => null,
                    ),
                    host.listIterations().then(
                        (value) => value,
                        (error: unknown): Iteration[] => {
                            process.stderr.write(
                                `sherpa-server: could not fetch iteration list: ${messageOf(error)}\n`,
                            );
                            return [];
                        },
                    ),
                ]);
                this.meta = meta;
                this.remember(diff, iterations);
                this.activeDiff = diff;
                return diff;
            } catch (error) {
                if (error instanceof RpcFailure) {
                    throw error;
                }
                throw new RpcFailure('host_unavailable', `Host adapter did not return the diff: ${messageOf(error)}`);
            } finally {
                // A failure must not persist for the process lifetime, and a success must not hide the next push.
                this.diffLoad = null;
            }
        })());

        return load;
    }

    /**
     * Store the active iteration patch. Metadata comes from the host list. If it is missing
     * (the list was unavailable or the author pushed between the 2 requests), reconstruct it from the
     * diff. The patch must be saved regardless. The next `sync` will fix the status and timestamp.
     */
    private remember(diff: PrDiff, iterations: readonly Iteration[]): void {
        const store = this.iterations;
        if (store === null) {
            return;
        }

        const listed = iterations.find((candidate) => candidate.diffId === diff.diffId);
        if (listed === undefined) {
            process.stderr.write(
                `sherpa-server: host did not list iteration ${diff.diffId}, reconstructed its metadata from the diff\n`,
            );
        }
        const iteration: Iteration = listed ?? {
            diffId: diff.diffId,
            baseCommit: diff.baseCommit,
            headCommit: diff.headCommit,
            createdAt: new Date().toISOString(),
            status: 'active',
        };
        try {
            store.upsert(diff, iteration);
        } catch (error) {
            process.stderr.write(
                `sherpa-server: iteration patch ${diff.diffId} not saved: ${messageOf(error)}\n`,
            );
        }
    }
}

/**
 * Snapshot language. Skeleton acceptance sets `provenance.locale`, while snapshots in the old format carry `null`
 * from before M5, which are in Russian.
 */
function snapshotLocale(snapshot: RouteSnapshot): Locale {
    return snapshot.provenance.locale ?? 'en';
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
 * Route threshold (docs/architecture.md §7.6). A tiny PR can be read in full, and a route adds overhead.
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

/** Stop status from the state of the task filling it. Notes use the snapshot language. */
function stopStatusOf(task: TaskRecord, strings: RouteStrings): RouteStopStatusUpdate {
    switch (task.status) {
        case 'queued':
            return { status: 'queued' };
        case 'leased':
            return { status: 'filling' };
        case 'cancelled':
            return { status: 'failed', note: strings.stopFillCancelled };
        case 'failed':
            return { status: 'failed', note: strings.stopFillFailed(task.failReason) };
        default:
            // The task finished successfully but the slot is empty. The model submitted a result without this stop.
            return { status: 'failed', note: strings.stopMissingInResult };
    }
}

/**
 * Why mark carryover yielded zero. "Carried over 0 of 8" reads as "everything changed", but
 * there are 2 distinct reasons: the reviewer marked nothing in the previous iteration, or marked stops
 * but none remained fully viewed.
 *
 * Query the source iteration, not the destination. Carryover may have preserved no lines (the interdiff
 * touched every range, conservative mode, or regeneration on the same iteration), and "there were
 * no marks" would be false for a reviewer who had marked stops.
 */
function zeroCarryReason(
    kept: number,
    progress: StopProgressCarry,
    sourceDiffId: HostId,
    whenMarked: RouteCarriedZeroReason,
): RouteCarriedZeroReason | null {
    if (kept > 0) {
        return null;
    }
    return progress.hasViewedMarks(sourceDiffId) ? whenMarked : 'no_marks';
}

/** The same reason in words, appended to the carryover line in stderr. */
function zeroCarryNote(reason: RouteCarriedZeroReason | null): string {
    switch (reason) {
        case null:
            return '';
        case 'no_marks':
            return ': there were no viewed marks in the previous iteration';
        case 'no_overlap':
            return ': marks from the previous iteration did not fully cover any stop';
        case 'no_interdiff':
            return ': there is no interdiff between iterations';
    }
}

/**
 * Generation failure reason for the red card (docs/design/README.md §12), one sentence
 * in the route language.
 */
function skeletonFailureMessage(task: TaskRecord, strings: RouteStrings): string {
    return strings.skeletonFailed((task.failReason ?? '').trim());
}

function provenanceOf(status: WorkerStatus, locale: Locale): RouteProvenance {
    if (status.kind === 'never') {
        return { harness: null, model: null, locale };
    }
    return { harness: status.harness ?? null, model: status.model ?? null, locale };
}
