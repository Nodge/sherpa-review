import type {
    HostCapabilities,
    HostId,
    Iteration,
    PrDiff,
    ReviewHost,
    RouteSnapshot,
    UiRouteStale,
    UiRouteState,
} from '@sherpa/protocol';

import type { ChatStore } from './chat-store.js';
import { RpcFailure } from './errors.js';
import type { IterationStore } from './iteration-store.js';
import type { IterationMap } from './iterations/index.js';
import { affectedStops, buildIterationMap, opaqueMap } from './iterations/index.js';
import type { ProgressStore } from './progress-store.js';
import type { RouteStore } from './route-store.js';
import { UNKNOWN_BASE_COMMIT } from './route-store.js';

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

/** Everything the feed needs from chat storage to carry note anchors to a new iteration. */
export type NoteCarrier = Pick<ChatStore, 'adoptLegacyAnchors' | 'migrateNotes' | 'read'>;

/** Delay before retrying carryover when a temporary host failure prevents fetching a slice. */
const CARRY_RETRY_MS = 30_000;

/** Host slice refusal. `permanent` means the source is unreachable forever, so there is nothing to retry. */
type CarryRefusal = 'permanent' | 'temporary';

export interface IterationFeedOptions {
    /** null means the PR has no host adapter and will never have iterations. */
    readonly host: ReviewHost | null;
    readonly iterations: IterationStore;
    /**
     * Current snapshot, used to compute `stale`. Changing it recalculates affected stops.
     * Snapshot history is the last place to find the base of a forgotten iteration.
     */
    readonly route: Pick<RouteStore, 'current' | 'subscribe' | 'listSnapshots'>;
    /** Notes whose anchors move to a new iteration (M4-T11). null means there is nobody to move them. */
    readonly notes?: NoteCarrier | null;
    /** Delay before retrying carryovers after a temporary host refusal. */
    readonly carryRetryMs?: number;
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
    private readonly route: Pick<RouteStore, 'current' | 'subscribe' | 'listSnapshots'>;
    private readonly notes: NoteCarrier | null;
    private readonly carryRetryMs: number;
    private readonly progress: ProgressCarrier | null;
    private readonly log: (message: string) => void;
    private readonly listeners = new Set<(revision: number) => void>();
    /** Running affected-stop calculations, to avoid starting the same one twice. */
    private readonly pending = new Set<string>();
    /** Iteration pairs whose slices the host permanently refused, so futile requests are not retried. */
    private readonly refused = new Set<string>();
    /** Map of the latest iteration pair, computed once and read on every snapshot change. */
    private map: { pair: string; built: Promise<IterationMap> } | null = null;
    /**
     * In-flight slice requests by iteration pair. A slice from the review host takes 2.8–3.7 s. After a push,
     * two consumers request it at once: affected stops and note anchor carryover. The store cache shares the result
     * only after the first response, so in-flight requests need separate deduplication.
     */
    private readonly interdiffs = new Map<string, Promise<PrDiff>>();

    /**
     * In-flight carryovers for one iteration pair, to avoid duplicates. The key starts with the carrier
     * name (`notes` / `progress`) because progress and note anchors are carried over independently.
     */
    private readonly carrying = new Set<string>();
    /** Carryover sources whose slices the host refused, keyed by the target iteration. */
    private readonly refusedCarry = new Map<HostId, Set<HostId>>();
    /** Iterations already logged as "source not found", so many watcher events produce one log line. */
    private readonly reportedNoSource = new Set<HostId>();

    private list: Iteration[] = [];
    private affected: AffectedStops | null = null;
    private revisionValue = 0;
    private unwatch: (() => void) | null = null;
    private unsubscribeRoute: (() => void) | null = null;
    /** In-flight active iteration patch load, to avoid duplicate concurrent requests. */
    private diffLoad: { diffId: HostId; patch: Promise<PrDiff> } | null = null;
    /** Scheduled carryover retry after a temporary host refusal. null means there is nothing to retry. */
    private carryRetry: ReturnType<typeof setTimeout> | null = null;
    /** Host capabilities, fetched once to determine whether anchor carryover is possible. */
    private capabilities: Promise<HostCapabilities> | null = null;
    /** In-flight one-off list request, shared by all `resolveActive` calls. */
    private resolving: Promise<void> | null = null;
    private closed = false;

    constructor(options: IterationFeedOptions) {
        this.host = options.host;
        this.store = options.iterations;
        this.route = options.route;
        this.notes = options.notes ?? null;
        this.carryRetryMs = options.carryRetryMs ?? CARRY_RETRY_MS;
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
        if (this.carryRetry !== null) {
            clearTimeout(this.carryRetry);
            this.carryRetry = null;
        }
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
            void this.activeDiff(active)
                .then(() => this.carryProgress(active))
                .catch((error: unknown) => {
                    // Carryover writes to the database: failure must not crash the process with an unhandled rejection.
                    this.log(`could not carry over progress to ${active.diffId}: ${messageOf(error)}`);
                });
            // Notes wait for their own patch: anchor carryover retries after a host refusal.
            this.carryNotes(active);
        }
        this.refreshAffected();
        this.notify();
    }

    /**
     * The active iteration patch must be stored locally: after the next push, a snapshot
     * built on it can only be read from that patch (brief §4a). Read it from storage. On
     * a miss, fetch it from the host and store it immediately. Concurrent requests share one call.
     */
    private activeDiff(active: Iteration): Promise<PrDiff> {
        const stored = this.store.get(active.diffId);
        if (stored !== null) {
            return Promise.resolve(stored.diff);
        }
        const host = this.host;
        if (host === null) {
            return Promise.reject(new Error(`cannot fetch patch for iteration ${active.diffId}: no host`));
        }
        if (this.diffLoad?.diffId === active.diffId) {
            return this.diffLoad.patch;
        }

        const patch = host
            .getDiff()
            .then((diff) => {
                // The author may have pushed again while the patch was loading, so the host returned another
                // iteration: neither store it nor return it to the caller as the `active` patch,
                // or the wrong patch would put the wrong fileId values into note anchors.
                if (diff.diffId !== active.diffId) {
                    throw new Error(`host returned patch for iteration ${diff.diffId} instead of ${active.diffId}`);
                }
                if (!this.closed && this.active()?.diffId === active.diffId) {
                    this.store.upsert(diff, active);
                }
                return diff;
            })
            .catch((error: unknown) => {
                this.log(`patch for iteration ${active.diffId} not saved: ${messageOf(error)}`);
                throw error;
            })
            .finally(() => {
                if (this.diffLoad?.diffId === active.diffId) {
                    this.diffLoad = null;
                }
            });
        this.diffLoad = { diffId: active.diffId, patch };
        return patch;
    }

    /**
     * Note anchors move to the active iteration (M4-T11). Usually they move from one
     * iteration, but 2 pushes in a row without an open UI leave notes on different ones, hence
     * a set instead of a single pair. A note that has already lost its anchor never migrates again.
     */
    private carryNotes(active: Iteration): void {
        const notes = this.notes;
        if (notes === null) {
            return;
        }

        try {
            notes.adoptLegacyAnchors(active.diffId);
        } catch (error) {
            this.log(`M3 note anchors not adopted: ${messageOf(error)}`);
            return;
        }

        const refused = this.refusedSourcesFor(active.diffId);
        const stale = new Set(
            notes
                .read()
                .notes.filter((note) => !note.lostAnchor && note.anchor.diffId !== active.diffId)
                .map((note) => note.anchor.diffId),
        );
        for (const from of stale) {
            if (refused.has(from)) {
                continue;
            }
            const pair = `notes ${from} ${active.diffId}`;
            if (this.carrying.has(pair)) {
                continue;
            }
            this.carrying.add(pair);
            void this.carryNotesFrom(notes, from, active, pair);
        }
    }

    private async carryNotesFrom(
        notes: NoteCarrier,
        from: HostId,
        active: Iteration,
        pair: string,
    ): Promise<void> {
        try {
            const host = this.host;
            // Without host slices there is no way to carry over: the map is empty and notes lose their anchors.
            const blind = host === null || !(await this.hostCapabilities(host)).iterations;
            const carry = blind ? { map: opaqueMap(), refusal: null } : await this.noteCarry(host, from, active);
            if (carry === null) {
                return;
            }
            // An empty map needs no files: everything is touched and the anchor is lost regardless of `fileId`.
            const fileIdOf = carry.refusal === null ? await this.activeFileIds(active) : (): null => null;
            // The author may have pushed while the slice was being computed: do not carry over to an inactive iteration.
            if (this.closed || this.active()?.diffId !== active.diffId) {
                return;
            }
            const migration = notes.migrateNotes(from, active.diffId, carry.map, fileIdOf, active.headCommit);
            if (carry.refusal !== null) {
                // Reject the source only after a successful write: otherwise there will be no retry, and
                // notes would keep anchors on an iteration the host no longer has.
                this.refusedSourcesFor(active.diffId).add(from);
                this.log(
                    `host permanently refused slice ${from}→${active.diffId}, ` +
                        `notes without anchors ${String(migration.lost)}: ${carry.refusal}`,
                );
            }
        } catch (error) {
            // The active iteration patch and database write say nothing about the source: retry only.
            this.log(`could not carry over note anchors from iteration ${from}, will retry: ${messageOf(error)}`);
            this.scheduleCarryRetry();
        } finally {
            this.carrying.delete(pair);
        }
    }

    /**
     * Anchor carryover map from the source: `refusal` is the reason for a permanent host refusal,
     * which leaves the map empty and notes without anchors. `null` in place of a map means a temporary refusal, with a retry
     * scheduled: a network error must not falsely mark an anchor as lost, since that is irreversible.
     */
    private async noteCarry(
        host: ReviewHost,
        from: HostId,
        active: Iteration,
    ): Promise<{ map: IterationMap; refusal: string | null } | null> {
        try {
            return { map: await this.noteMap(host, from, active), refusal: null };
        } catch (error) {
            if (this.carryRefusal(from, error) === 'temporary') {
                this.log(`could not carry over note anchors from iteration ${from}, will retry: ${messageOf(error)}`);
                this.scheduleCarryRetry();
                return null;
            }
            // Empty map: everything is considered touched, just as with a host without slices.
            return { map: opaqueMap(), refusal: messageOf(error) };
        }
    }

    /** Path → `fileId` in the active iteration patch. null means the file is absent. */
    private async activeFileIds(active: Iteration): Promise<(path: string) => string | null> {
        const files = new Map((await this.activeDiff(active)).files.map((file) => [file.path, file.fileId]));
        return (path) => files.get(path) ?? null;
    }

    /**
     * Retry carryover after a temporary host refusal, for both note anchors and progress: they share
     * a slice, so they share its refusal. Cannot wait for the next iteration list: the watcher wakes the feed
     * only on a new push. Until then, a note anchored to a previous iteration cannot find its
     * file in the active diff and disappears from the code, with no banner or mark in chat.
     */
    private scheduleCarryRetry(): void {
        if (this.closed || this.unwatch === null || this.carryRetry !== null) {
            return;
        }
        this.carryRetry = setTimeout(() => {
            this.carryRetry = null;
            const active = this.active();
            if (this.closed || this.unwatch === null || active === null) {
                return;
            }
            this.carryNotes(active);
            void this.activeDiff(active)
                .then(() => this.carryProgress(active))
                .catch((error: unknown) => {
                    this.log(`could not carry over progress to ${active.diffId}: ${messageOf(error)}`);
                });
        }, this.carryRetryMs);
        // The timer neither keeps the process alive nor counts as server activity (see idle.ts).
        this.carryRetry.unref();
    }

    /**
     * Line carryover map for notes. Only exposes a host refusal of the slice, which
     * determines whether to retry carryover or discard the anchors.
     */
    private async noteMap(host: ReviewHost, from: HostId, active: Iteration): Promise<IterationMap> {
        const fromIteration =
            this.list.find((iteration) => iteration.diffId === from) ?? this.store.get(from)?.iteration ?? null;
        if (fromIteration === null) {
            // The iteration is absent from both the list and storage: there is no way to compare its base.
            return opaqueMap();
        }
        const interdiff = await this.interdiff(host, from, active.diffId);
        return buildIterationMap({
            interdiff,
            fromBaseCommit: fromIteration.baseCommit,
            toBaseCommit: active.baseCommit,
        });
    }

    /**
     * Slice for an iteration pair: read from the storage cache, or make one host request per pair on a miss.
     * Affected stops and note anchor carryover start together after a push, and until
     * the first response the storage cache is empty, so the second identical request waits for the first.
     */
    private interdiff(host: ReviewHost, base: HostId, head: HostId): Promise<PrDiff> {
        const pair = `${base} ${head}`;
        const inflight = this.interdiffs.get(pair);
        if (inflight !== undefined) {
            return inflight;
        }
        const loading = this.store
            .getInterdiff(base, head, () => host.getDiff({ base, head }))
            .finally(() => {
                // Storage serves the slice from now on: there is no need to keep the patch in memory too.
                this.interdiffs.delete(pair);
            });
        this.interdiffs.set(pair, loading);
        return loading;
    }

    private hostCapabilities(host: ReviewHost): Promise<HostCapabilities> {
        this.capabilities ??= host
            .getPr()
            .then((pr) => pr.capabilities)
            .catch((error: unknown) => {
                this.capabilities = null;
                throw error;
            });
        return this.capabilities;
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
                if (!this.reportedNoSource.has(active.diffId)) {
                    this.reportedNoSource.add(active.diffId);
                    this.log(
                        `progress carryover to ${active.diffId}: no source found, ` +
                            'no progress on other iterations',
                    );
                }
                return;
            }
            if (!(await this.progressSlices(host, active))) {
                return;
            }

            const pair = `progress ${from} ${active.diffId}`;
            if (this.carrying.has(pair)) {
                return;
            }
            this.carrying.add(pair);
            try {
                const slice = await this.interdiff(host, from, active.diffId).then(
                    (interdiff) => ({ interdiff }),
                    (error: unknown) => {
                        const refusal = this.carryRefusal(from, error);
                        this.log(
                            `could not fetch slice ${from}→${active.diffId}` +
                                `${refusal === 'temporary' ? ', will retry' : ', will not retry'}: ${messageOf(error)}`,
                        );
                        return { refusal };
                    },
                );
                if ('refusal' in slice) {
                    if (slice.refusal === 'temporary') {
                        // A network failure is no reason to use an older source: an earlier iteration has
                        // older progress, which must not silently replace newer progress.
                        this.scheduleCarryRetry();
                        return;
                    }
                    // The source no longer exists (usually removed by a force-push): take the next
                    // candidate, since earlier iterations have progress too.
                    refused.add(from);
                    continue;
                }
                const interdiff = slice.interdiff;
                if (!this.stillActive(active.diffId)) {
                    // The author pushed again while the slice was being computed: carry over to the new active iteration.
                    return;
                }

                const fromBaseCommit = this.baseCommitOf(from);
                const result = progress.carryRanges(
                    from,
                    active.diffId,
                    buildIterationMap({ interdiff, fromBaseCommit, toBaseCommit: active.baseCommit }),
                );
                if (fromBaseCommit === null && !result.skipped) {
                    this.log(
                        `progress carryover ${from} → ${active.diffId}: base of iteration ${from} is unknown, ` +
                            'old-side ranges are not carried over',
                    );
                }
                return;
            } finally {
                this.carrying.delete(pair);
            }
        }
    }

    /**
     * Iteration base: host list, saved patch, route snapshot built on it.
     * `null` means unknown: using the active iteration base would produce a knowingly
     * incorrect line map and silently carry over the old side with it.
     */
    private baseCommitOf(diffId: HostId): string | null {
        const known =
            this.list.find((iteration) => iteration.diffId === diffId)?.baseCommit ??
            this.store.get(diffId)?.iteration.baseCommit;
        if (known !== undefined) {
            return known;
        }
        // A snapshot recorded before M4 has no base, and `RouteStore` fills it with a
        // placeholder. Treating it as a commit is the same as choosing a base at random.
        const stored = this.route.listSnapshots().findLast((snapshot) => snapshot.diffId === diffId);
        const base = stored?.baseCommit;
        return base === undefined || base === UNKNOWN_BASE_COMMIT ? null : base;
    }

    /**
     * Whether progress can be carried over. A host without slices rejects every pair, so trying
     * sources is pointless. A failed capabilities request concerns the host, not the source: retry.
     */
    private async progressSlices(host: ReviewHost, active: Iteration): Promise<boolean> {
        try {
            const { iterations } = await this.hostCapabilities(host);
            if (!iterations) {
                this.log(`progress not carried over to ${active.diffId}: host has no slices`);
            }
            return iterations;
        } catch (error) {
            this.log(`progress not carried over to ${active.diffId}, will retry: ${messageOf(error)}`);
            this.scheduleCarryRetry();
            return false;
        }
    }

    /** The iteration is still active and the feed is alive: the network result is still needed. */
    private stillActive(diffId: HostId): boolean {
        return !this.closed && this.active()?.diffId === diffId;
    }

    /**
     * Shared host refusal policy for all carryovers (M4-T16). A permanent refusal means the source
     * is no longer on the host: a force-push removed the iteration (`gone`) or the host called it unknown
     * (`bad_request`). Everything else is a temporary failure that a retry can resolve.
     *
     * Only a slice refusal counts: a failure to fetch the active iteration patch or write to the database says
     * nothing about the source and must not irreversibly mark an anchor as lost.
     */
    private carryRefusal(from: HostId, error: unknown): CarryRefusal {
        if (error instanceof RpcFailure && error.code === 'bad_request') {
            return 'permanent';
        }
        const known = this.list.find((iteration) => iteration.diffId === from);
        return known?.status === 'gone' ? 'permanent' : 'temporary';
    }

    /** Sources whose slices the host permanently refused for this active iteration. */
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
            if (!(await this.hostCapabilities(host)).iterations) {
                // The host has no slices at all: the list cannot be computed now or later, like a permanent refusal.
                this.refused.add(pair);
                this.log(`could not compute affected stops for snapshot ${snapshot.snapshotId}: host has no slices`);
                return;
            }
            let map: IterationMap;
            try {
                map = await this.iterationMap(host, snapshot, active);
            } catch (error) {
                this.refuseAffected(snapshot, pair, error);
                return;
            }
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
            // Host capabilities and computing the list itself say nothing about the snapshot iteration:
            // the pair may still work, so recalculate on the next event.
            this.log(
                `could not compute affected stops for snapshot ${snapshot.snapshotId}, will recalculate: ${messageOf(error)}`,
            );
        } finally {
            this.pending.delete(key);
        }
    }

    /**
     * The slice for affected stops failed to arrive: the banner stays without a stop list. A slice with a
     * `gone` iteration cannot recover, while a network failure is retried on the next event. Discard the map along with
     * the pair, otherwise recalculation would read the same error from memory without asking
     * the host again.
     */
    private refuseAffected(snapshot: RouteSnapshot, pair: string, error: unknown): void {
        const refusal = this.carryRefusal(snapshot.diffId, error);
        if (refusal === 'permanent') {
            this.refused.add(pair);
        } else if (this.map?.pair === pair) {
            this.map = null;
        }
        this.log(
            `could not compute affected stops for snapshot ${snapshot.snapshotId}` +
                `${refusal === 'temporary' ? ', will recalculate' : ''}: ${messageOf(error)}`,
        );
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
                built: this.interdiff(host, snapshot.diffId, active.diffId).then((interdiff) =>
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
