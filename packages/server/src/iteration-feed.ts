import type {
    HostId,
    Iteration,
    ReviewHost,
    RouteSnapshot,
    UiRouteStale,
    UiRouteState,
} from '@sherpa/protocol';

import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { affectedStops, buildIterationMap } from './iterations/index.js';
import type { ProgressStore } from './progress-store.js';
import type { RouteStore } from './route-store.js';

/**
 * One server subscription to PR iterations (M4-T4): merged host and storage list,
 * the active iteration and a stale route flag for the UI.
 *
 * Separate from `ReviewFeed` because threads and iterations have different consumers and mechanisms.
 * Iterations carry state (list, active iteration, affected stops), threads carry only a revision.
 *
 * The subscription is lazy, like `ReviewFeed`. It starts with the first SSE client and stops without clients,
 * otherwise the host would poll for no one. Before startup the list is empty and `stale` is `null`,
 * because there is no active iteration to compare the snapshot against.
 */

/** Affected stops for one snapshot → active iteration pair, computed asynchronously from the interdiff. */
interface AffectedStops {
    readonly snapshotId: string;
    readonly headDiffId: HostId;
    /** Anchors used to compute the list. Accepting sections adds them to the same snapshot. */
    readonly anchorsKey: string;
    readonly stopIds: string[];
}

export interface IterationFeedOptions {
    /** null means the PR has no host adapter and will never have iterations. */
    readonly host: ReviewHost | null;
    readonly iterations: IterationStore;
    /** Current snapshot: used to compute `stale`. Changing it recalculates affected stops. */
    readonly route: Pick<RouteStore, 'current' | 'subscribe'>;
    /** Reading progress: a push carries it to the new iteration (M4-T6). `null` means nothing to carry over. */
    readonly progress?: ProgressCarrier | null;
    /** Where to log host refusals. Defaults to stderr. */
    readonly log?: (message: string) => void;
}

/** The part of `ProgressStore` the feed needs: legacy adoption and carryover to the active iteration. */
export type ProgressCarrier = Pick<
    ProgressStore,
    'adoptLegacy' | 'latestDiffIdWithProgress' | 'carryRanges'
>;

export class IterationFeed {
    private readonly host: ReviewHost | null;
    private readonly store: IterationStore;
    private readonly route: Pick<RouteStore, 'current' | 'subscribe'>;
    private readonly progress: ProgressCarrier | null;
    private readonly log: (message: string) => void;
    private readonly listeners = new Set<(revision: number) => void>();
    /** Running affected-stop calculations, to avoid starting the same one twice. */
    private readonly pending = new Set<string>();
    /** Iteration pairs whose slice the host refused, to avoid repeating the failed request on every list. */
    private readonly refused = new Set<string>();
    /** Map of the latest iteration pair, computed once and read on every snapshot change. */
    private map: { pair: string; built: Promise<IterationMap> } | null = null;

    /** Progress carryovers in flight: no need for a second one for the same pair. */
    private readonly carrying = new Set<string>();
    /** Carryover sources whose slices the host refused, keyed by the target iteration. */
    private readonly refusedCarry = new Map<HostId, Set<HostId>>();

    private list: Iteration[] = [];
    private affected: AffectedStops | null = null;
    private revisionValue = 0;
    private unwatch: (() => void) | null = null;
    private unsubscribeRoute: (() => void) | null = null;
    /** In-flight active iteration patch load, to avoid duplicate concurrent requests. */
    private loadingDiff: { diffId: HostId; done: Promise<void> } | null = null;
    /** In-flight one-off list request, shared by all `resolveActive` calls. */
    private resolving: Promise<void> | null = null;
    private closed = false;

    constructor(options: IterationFeedOptions) {
        this.host = options.host;
        this.store = options.iterations;
        this.route = options.route;
        this.progress = options.progress ?? null;
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
    }

    get revision(): number {
        return this.revisionValue;
    }

    /** Merged host and storage list in order of appearance. Empty until the subscription starts. */
    iterations(): Iteration[] {
        return this.list.map((iteration) => ({ ...iteration }));
    }

    /** Iteration currently under review in the PR. null means the list has not arrived or there is no host. */
    active(): Iteration | null {
        const active = this.list.find((iteration) => iteration.status === 'active');
        return active === undefined ? null : { ...active };
    }

    /**
     * Active iteration on demand: write endpoints need it even without an open SSE channel.
     * Returns it immediately if known, otherwise asks the host for the list once for all
     * waiters. Without a host, returns `null`: the server can only write to `LEGACY_DIFF_ID`.
     */
    async resolveActive(): Promise<Iteration | null> {
        const host = this.host;
        const known = this.active();
        if (host === null || known !== null || this.closed) {
            return known;
        }

        this.resolving ??= host
            .listIterations()
            .then((iterations) => {
                this.onIterations(iterations);
            })
            .catch((error: unknown) => {
                this.log(`could not fetch iteration list: ${messageOf(error)}`);
            })
            .finally(() => {
                this.resolving = null;
            });
        await this.resolving;
        return this.active();
    }

    /**
     * "Stale route" for a snapshot. `affectedStopIds` arrives in a second notification once
     * the interdiff is computed: the banner cannot wait 2.8–3.7 s for the host.
     */
    staleFor(snapshot: RouteSnapshot | null): UiRouteStale | null {
        const stale = staleFor(snapshot, this.list);
        if (stale === null || snapshot === null) {
            return null;
        }

        const affected = this.affected;
        const matches =
            affected !== null &&
            affected.snapshotId === snapshot.snapshotId &&
            affected.headDiffId === stale.prDiffId;
        return matches ? { ...stale, affectedStopIds: [...affected.stopIds] } : stale;
    }

    subscribe(listener: (revision: number) => void): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.listeners.add(listener);
        this.start();

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.stop();
            }
        };
    }

    /** Stops the subscription and releases listeners as the server shuts down. */
    close(): void {
        this.closed = true;
        this.listeners.clear();
        this.stop();
    }

    private start(): void {
        if (this.host === null || this.unwatch !== null) {
            return;
        }
        this.unsubscribeRoute = this.route.subscribe(() => {
            this.refreshAffected();
        });
        this.unwatch = this.host.watchIterations((iterations) => {
            this.onIterations(iterations);
        });
    }

    private stop(): void {
        this.unwatch?.();
        this.unwatch = null;
        this.unsubscribeRoute?.();
        this.unsubscribeRoute = null;
    }

    /** Host list: reconcile with storage, fetch the active iteration patch, recalculate stale. */
    private onIterations(hostIterations: Iteration[]): void {
        let merged: Iteration[];
        try {
            merged = this.store.sync(hostIterations);
        } catch (error) {
            this.log(`could not reconcile iteration list with storage: ${messageOf(error)}`);
            return;
        }

        this.list = merged;
        const active = this.active();
        if (active !== null) {
            // Progress carryover waits for the new iteration patch: `fileId` cannot be matched without it.
            void this.rememberActiveDiff(active)
                .then(() => this.carryProgress(active))
                .catch((error: unknown) => {
                    // Carryover writes to the database: failure must not crash the process with an unhandled rejection.
                    this.log(`could not carry over progress to ${active.diffId}: ${messageOf(error)}`);
                });
        }
        this.refreshAffected();
        this.notify();
    }

    /**
     * The active iteration patch must be stored locally: after the next push, a snapshot
     * built on it can only be read from that patch (brief §4a).
     */
    private rememberActiveDiff(active: Iteration): Promise<void> {
        const host = this.host;
        if (host === null || this.store.get(active.diffId) !== null) {
            return Promise.resolve();
        }
        if (this.loadingDiff?.diffId === active.diffId) {
            return this.loadingDiff.done;
        }

        const done = host
            .getDiff()
            .then((diff) => {
                // The author may have pushed again while the patch was loading: it can no longer be stored
                // as the active iteration, much less as another iteration.
                if (this.closed || diff.diffId !== active.diffId || this.active()?.diffId !== active.diffId) {
                    return;
                }
                this.store.upsert(diff, active);
            })
            .catch((error: unknown) => {
                this.log(`patch for iteration ${active.diffId} not saved: ${messageOf(error)}`);
            })
            .finally(() => {
                if (this.loadingDiff?.diffId === active.diffId) {
                    this.loadingDiff = null;
                }
            });
        this.loadingDiff = { diffId: active.diffId, done };
        return done;
    }

    /**
     * Progress moves to the active iteration (planning decision 4a): first adopt
     * records without an iteration, then carry over ranges and file marks from the latest
     * iteration that has any.
     *
     * Each pair is carried over once and for all (`progress_carries`), so repeated host lists
     * create no duplicates.
     */
    private async carryProgress(active: Iteration): Promise<void> {
        const progress = this.progress;
        const host = this.host;
        if (progress === null || host === null || this.closed) {
            return;
        }

        progress.adoptLegacy(active.diffId);
        const refused = this.refusedSourcesFor(active.diffId);
        for (;;) {
            const from = progress.latestDiffIdWithProgress(active.diffId, [...refused]);
            if (from === null) {
                return;
            }

            const pair = `${from} ${active.diffId}`;
            if (this.carrying.has(pair)) {
                return;
            }
            this.carrying.add(pair);
            try {
                const interdiff = await this.store
                    .getInterdiff(from, active.diffId, () =>
                        host.getDiff({ base: from, head: active.diffId }),
                    )
                    .catch((error: unknown) => {
                        // The host cannot compute a slice against this iteration (usually removed by a
                        // force-push). Try the next candidate, otherwise carryover would stay blocked
                        // on an unreachable source while earlier iterations also have progress.
                        this.log(`slice ${from}→${active.diffId} unavailable: ${messageOf(error)}`);
                        refused.add(from);
                        return null;
                    });
                if (interdiff === null) {
                    continue;
                }
                if (!this.stillActive(active.diffId)) {
                    // The author pushed again while the slice was being computed: carry over to the new active iteration.
                    return;
                }

                const fromBaseCommit =
                    this.list.find((iteration) => iteration.diffId === from)?.baseCommit ??
                    this.store.get(from)?.iteration.baseCommit ??
                    active.baseCommit;
                progress.carryRanges(
                    from,
                    active.diffId,
                    buildIterationMap({ interdiff, fromBaseCommit, toBaseCommit: active.baseCommit }),
                );
                return;
            } finally {
                this.carrying.delete(pair);
            }
        }
    }

    /** The iteration is still active and the feed is alive: the network result is still needed. */
    private stillActive(diffId: HostId): boolean {
        return !this.closed && this.active()?.diffId === diffId;
    }

    /** Sources for which the host has already refused a slice against this active iteration. */
    private refusedSourcesFor(toDiffId: HostId): Set<HostId> {
        const known = this.refusedCarry.get(toDiffId);
        if (known !== undefined) {
            return known;
        }
        const empty = new Set<HostId>();
        this.refusedCarry.set(toDiffId, empty);
        return empty;
    }

    /**
     * Affected stops are computed for the current snapshot against the active iteration. Recalculate
     * on more than a snapshot or iteration change: a push during generation finds stops without anchors,
     * and the full list appears only once section acceptance has added them.
     */
    private refreshAffected(): void {
        const snapshot = this.route.current();
        const active = this.active();
        if (snapshot === null || active === null || snapshot.diffId === active.diffId) {
            this.affected = null;
            return;
        }

        const anchorsKey = anchorsKeyOf(snapshot);
        const affected = this.affected;
        const samePair =
            affected !== null &&
            affected.snapshotId === snapshot.snapshotId &&
            affected.headDiffId === active.diffId;
        if (samePair && affected.anchorsKey === anchorsKey) {
            return;
        }
        if (!samePair) {
            // The list for the previous pair does not apply. Keep the list computed from incomplete anchors:
            // it is incomplete but accurate, and stays until recalculation.
            this.affected = null;
        }

        const pair = `${snapshot.diffId} ${active.diffId}`;
        const key = `${snapshot.snapshotId} ${pair} ${anchorsKey}`;
        if (this.pending.has(key) || this.refused.has(pair)) {
            return;
        }
        this.pending.add(key);
        void this.computeAffected(snapshot, active, key);
    }

    private async computeAffected(snapshot: RouteSnapshot, active: Iteration, key: string): Promise<void> {
        const host = this.host;
        const pair = `${snapshot.diffId} ${active.diffId}`;
        if (host === null) {
            this.pending.delete(key);
            return;
        }

        try {
            const map = await this.iterationMap(host, snapshot, active);
            // While the slice was being computed, the reviewer may have rebuilt the route, the author pushed again,
            // and section acceptance added anchors: build the list from the latest snapshot.
            const current = this.route.current();
            if (
                this.closed ||
                current?.snapshotId !== snapshot.snapshotId ||
                this.active()?.diffId !== active.diffId
            ) {
                return;
            }
            this.affected = {
                snapshotId: current.snapshotId,
                headDiffId: active.diffId,
                anchorsKey: anchorsKeyOf(current),
                stopIds: affectedStops(current, map),
            };
            this.notify();
        } catch (error) {
            // A host without `capabilities.iterations`, a slice involving a `gone` iteration, or a network failure: the banner
            // keeps no stop list, and there is no point retrying a request that cannot succeed.
            this.refused.add(pair);
            this.log(
                `affected stops for snapshot ${snapshot.snapshotId} were not computed: ${messageOf(error)}`,
            );
        } finally {
            this.pending.delete(key);
        }
    }

    /**
     * Line carryover map between the snapshot iteration and the active one. Compute the pair once: a host
     * request takes 2.8–3.7 s, while recalculating the list for each submitted section must stay cheap.
     * The pair lives until the next push, so this uses a single slot rather than a cache.
     */
    private iterationMap(host: ReviewHost, snapshot: RouteSnapshot, active: Iteration): Promise<IterationMap> {
        const pair = `${snapshot.diffId} ${active.diffId}`;
        if (this.map?.pair !== pair) {
            this.map = {
                pair,
                built: this.store
                    .getInterdiff(snapshot.diffId, active.diffId, () =>
                        host.getDiff({ base: snapshot.diffId, head: active.diffId }),
                    )
                    .then((interdiff) =>
                        buildIterationMap({
                            interdiff,
                            fromBaseCommit: snapshot.baseCommit,
                            toBaseCommit: active.baseCommit,
                        }),
                    ),
            };
        }
        return this.map.built;
    }

    private notify(): void {
        this.revisionValue += 1;
        if (this.closed) {
            return;
        }
        for (const listener of [...this.listeners]) {
            listener(this.revisionValue);
        }
    }
}

/**
 * "Stale route" rule (planning decision 10): the snapshot was built on a different iteration than the one
 * the PR is reviewing now. Generation phase does not affect this. The UI handles banner priorities.
 *
 * `affectedStopIds` is always empty here: it needs an interdiff, which requires a network call (`IterationFeed`).
 */
export function staleFor(snapshot: RouteSnapshot | null, iterations: readonly Iteration[]): UiRouteStale | null {
    if (snapshot === null) {
        return null;
    }
    const active = iterations.find((iteration) => iteration.status === 'active');
    if (active === undefined || active.diffId === snapshot.diffId) {
        return null;
    }

    // The snapshot iteration is absent from the list (a force-push removed it and storage knows nothing about it): count
    // from the start of history. The schema requires at least one new iteration, and one definitely exists.
    const own = iterations.find((iteration) => iteration.diffId === snapshot.diffId);
    const since = own?.createdAt ?? '';
    const newer = iterations.filter(
        (iteration) => iteration.status !== 'gone' && iteration.createdAt.localeCompare(since) > 0,
    ).length;

    return {
        routeCommit: snapshot.commit,
        prCommit: active.headCommit,
        prDiffId: active.diffId,
        newIterations: Math.max(1, newer),
        affectedStopIds: [],
    };
}

/** Route state for the UI: `stale` is computed on read and never stored. */
export function withStale(state: UiRouteState, feed: IterationFeed | null): UiRouteState {
    return { ...state, stale: feed?.staleFor(state.snapshot) ?? null };
}

/**
 * Route revision as seen by the UI. `stale` is not stored in `RouteStore`, so its revision does not change
 * on push, yet the UI must reread the route. Both revisions are monotonic, so their sum is too.
 */
export function routeRevisionOf(store: Pick<RouteStore, 'revision'>, feed: IterationFeed | null): number {
    return store.revision + (feed?.revision ?? 0);
}

/** Snapshot anchor fingerprint: these anchors alone determine the affected stop list. */
function anchorsKeyOf(snapshot: RouteSnapshot): string {
    return snapshot.stops
        .map(
            (stop) =>
                `${stop.id}:` +
                stop.anchors
                    .map((anchor) => `${anchor.path}#${anchor.side}${String(anchor.start)}-${String(anchor.end)}`)
                    .join(','),
        )
        .join(';');
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
