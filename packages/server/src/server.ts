import http from 'node:http';
import { hostname } from 'node:os';

import type { ServerManifest } from '@sherpa/protocol';
import { LONG_POLL_DEFAULT_SECONDS, PROTOCOL_VERSION } from '@sherpa/protocol';

import { createToken } from './auth.js';
import { BlobCache } from './blob-cache.js';
import { ChatOrchestrator } from './chat-orchestrator.js';
import { createChatRoutes } from './chat-routes.js';
import { ChatStore } from './chat-store.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { createDevRoutes } from './dev-routes.js';
import { DraftBufferStore, DraftBufferWriter } from './draft-buffer.js';
import { ServerAlreadyRunningError } from './errors.js';
import { FeedbackOrchestrator } from './feedback-orchestrator.js';
import type { FeedbackChannel } from './feedback-channel.js';
import { createFeedbackRoutes, feedbackChannelState } from './feedback-routes.js';
import { FeedbackStore } from './feedback-store.js';
import type { HostPlugin } from './hosts/plugin.js';
import { selectReviewHost } from './hosts/select.js';
import type { RequestListenerOptions, Route } from './http.js';
import { createRequestListener } from './http.js';
import { DEFAULT_IDLE_SECONDS, IdleWatch } from './idle.js';
import { IterationFeed } from './iteration-feed.js';
import { IterationStore } from './iteration-store.js';
import { DEFAULT_LISTEN_HOST, uiHostForListenHost } from './listen-host.js';
import {
    claimManifest,
    cleanStaleManifests,
    isManifestServerAlive,
    readManifest,
    releaseStaleManifest,
    removeOwnManifest,
} from './manifest.js';
import {
    assertValidPrKey,
    blobsDirOf,
    chatPayloadDirOf,
    databasePathFor,
    DEFAULT_SHERPA_DIR,
    ensurePrivateDir,
    feedbackPayloadDirOf,
    manifestPathFor,
    prStateDirOf,
    routePayloadDirOf,
    serversDirOf,
    sharedPayloadDirOf,
    workerIdPathFor,
} from './paths.js';
import { PrMetaCache } from './pr-meta.js';
import { createPrStateRoutes } from './pr-state-routes.js';
import { PrStateStore } from './pr-state-store.js';
import { ProgressStore } from './progress-store.js';
import { TaskQueue } from './queue.js';
import { ReviewFeed } from './review-feed.js';
import { createReviewRoutes } from './review-routes.js';
import type { RouteConfig } from './route-orchestrator.js';
import { RouteOrchestrator } from './route-orchestrator.js';
import { createRouteRoutes } from './route-routes.js';
import { RouteStore } from './route-store.js';
import { createSettingsRoutes } from './settings-routes.js';
import { SettingsStore } from './settings-store.js';
import { holdsPayload, SharedPayloadStore } from './shared-payload.js';
import type { StaticAssets } from './static.js';
import { withDocumentSettings } from './ui-document.js';
import { UiPresence } from './ui-presence.js';
import { createUiRoutes } from './ui-routes.js';
import type { UpdateChannel } from './update-channel.js';
import type { UpdateCheckOptions } from './update-check.js';
import { UpdateChecker } from './update-check.js';
import { SERVER_VERSION } from './version.js';
import { writeWorkerIdFile } from './worker-id-file.js';
import { WorkerRegistry } from './worker-registry.js';
import { createWorkerRoutes } from './worker-routes.js';

export interface StartServerOptions {
    /** PR key in `<host>-<pr>` format, used as the manifest and state directory name. */
    prKey: string;
    /** Host plugins from the composition root (`hosts/all.ts`). An empty list means no review endpoints. */
    hosts: readonly HostPlugin[];
    /** State root, defaults to `~/.sherpa`. */
    sherpaDir?: string;
    /** TCP listen address, defaults to local IPv4 loopback. */
    host?: string;
    /** Long-poll window for `worker next`, defaults to `LONG_POLL_DEFAULT_SECONDS`. Shortened in tests. */
    longPollSeconds?: number;
    /** UI static asset source (build directory or a map embedded in the bundle). Served without a token when provided. */
    assets?: StaticAssets;
    /**
     * Injectable clock for the queue, worker lifecycle and idle tracking. Defaults to the system clock.
     * Tests need to advance past `WORKER_DEAD_AFTER_SECONDS` and the lease TTL without waiting minutes.
     */
    now?: () => Date;
    /**
     * Idle time before the server stops itself (`DEFAULT_IDLE_SECONDS`). `0` disables shutdown.
     * Internal daemon policy, outside the contract. The CLI and UI don't know about it.
     */
    idleSeconds?: number;
    /**
     * Reason for automatic shutdown, before normal shutdown begins. The entry point writes it to a log
     * that outlives the process.
     */
    onIdleStop?: (idleSeconds: number) => void;
    /**
     * Grace period between worker calls (`WORKER_GAP_GRACE_SECONDS`). For this long, a session without
     * an open connection or a lease counts as alive. Internal policy, shortened in tests.
     */
    workerGapGraceSeconds?: number;
    /** UI departure grace period. The contract default is overridden only in server tests. */
    uiGoneGraceSeconds?: number;
    /**
     * Local review project directory (`--repo`), comparison base (`--base`) and branch used by
     * the CLI to build the key (`--branch`). Needed only for `local-*` keys. Without them, the local host
     * starts from the state saved by the previous run.
     */
    repo?: string;
    base?: string;
    branch?: string;
    /**
     * Local review verdict instruction (`--verdicts`). With it, review finishes with Ship or Request
     * changes. Like the base, it only applies when `repo` is provided.
     */
    verdicts?: string;
    /** Build feedback channel from the composition root. null means no channel and no Feedback button in the UI. */
    feedbackChannel: FeedbackChannel | null;
    /**
     * Route thresholds and section batching (`DEFAULT_ROUTE_CONFIG`). Internal server policy:
     * the UI and CLI don't know about it. Latency measurements adjust section batch sizes here.
     */
    route?: Partial<RouteConfig>;
    /** Build update channel from the composition root. null disables checks and keeps `uiState.update` null. */
    updateChannel: UpdateChannel | null;
    /** Update check injection point. Tests replace the install directory, transport, clock and cache. */
    updateCheck?: UpdateCheckOptions;
}

export interface SherpaServer {
    readonly port: number;
    readonly token: string;
    readonly prKey: string;
    /** Name or address in the UI link. The manifest contains the same value. */
    readonly uiHost: string;
    /** This PR's queue, used by UI endpoints and tests until the UI channel exists. */
    readonly queue: TaskQueue;
    /** This PR's worker lifecycle: status and connected/disconnected events for the UI. */
    readonly workerRegistry: WorkerRegistry;
    /** This PR's route state machine, used by the `generate` endpoint, warmup and tests. */
    readonly route: RouteOrchestrator;
    /** Question orchestration for this PR: chat endpoints and lifecycle tests. */
    readonly chat: ChatOrchestrator;
    /** Removes the manifest and closes the port and storage. A repeated call is a no-op. */
    close: () => Promise<void>;
}

/** `/healthz` response, also used during discovery to check whether another server is alive. */
export interface HealthResponse {
    readonly ok: true;
    readonly prKey: string;
    readonly pid: number;
    readonly serverVersion: string;
    readonly protocolVersion: string;
}

/** Number of attempts to claim the manifest when a stale one is in the way. Each attempt removes one. */
const CLAIM_ATTEMPTS = 5;

/**
 * Starts the PR server at the configured address (127.0.0.1 by default), on a random port, with a bearer token on every endpoint,
 * and a discovery manifest at `<sherpaDir>/servers/<prKey>.json` (docs/protocol.md §2, §8).
 * If a server for the same PR is already alive, throws `ServerAlreadyRunningError` without starting a second process.
 */
export async function startServer(options: StartServerOptions): Promise<SherpaServer> {
    const prKey = assertValidPrKey(options.prKey);
    // Reject a channel that violates the contract before claiming the manifest or port. The UI would reject its snapshot anyway.
    const feedbackState = feedbackChannelState(options.feedbackChannel);
    const sherpaDir = options.sherpaDir ?? DEFAULT_SHERPA_DIR;
    const host = options.host ?? DEFAULT_LISTEN_HOST;
    // A link to `[::]` doesn't work, so an external listener uses the machine name in the UI.
    const uiHost = uiHostForListenHost(host, hostname());
    const serversDir = serversDirOf(sherpaDir);
    const manifestPath = manifestPathFor(sherpaDir, prKey);

    await ensurePrivateDir(sherpaDir, serversDir);
    await cleanStaleManifests(serversDir);

    const token = createToken();
    // Settings are global. The settings endpoint, update check (`dismissedVersion`)
    // and `index.html` serving read them. The first frame must use the saved theme.
    const settingsStore = new SettingsStore(sherpaDir);
    // Worker endpoints join this array after the database opens. Before claiming the manifest,
    // the server must respond only to `/healthz`, which competing processes use to check whether we're alive.
    const routes: Route[] = [healthRoute(prKey)];
    const idleSeconds = options.idleSeconds ?? DEFAULT_IDLE_SECONDS;
    const idleWatch = new IdleWatch(
        options.now === undefined ? { idleSeconds } : { idleSeconds, now: options.now },
    );
    // Until all routes are ready, unmatched requests wait for this signal instead of receiving 404:
    // the manifest is published before worker endpoints are ready, and a call using the fresh manifest can arrive
    // during that gap. Failed startup also sends the signal, or waiting requests would hang until disconnected.
    let markRoutesReady!: () => void;
    const routesReady = new Promise<void>((resolve) => {
        markRoutesReady = resolve;
    });
    const listenerOptions: RequestListenerOptions = {
        token,
        routes,
        activity: idleWatch,
        ready: routesReady,
        ...(options.assets === undefined
            ? {}
            : { assets: withDocumentSettings(options.assets, () => settingsStore.read()) }),
    };
    const httpServer = http.createServer(createRequestListener(listenerOptions));
    const shutdownController = new AbortController();
    let claimed: ServerManifest | null = null;
    let db: SherpaDatabase | null = null;

    try {
        // Listen before claiming the manifest. Once it's published, a competing process can
        // check us through `/healthz` and must get a response.
        const port = await listen(httpServer, host);
        claimed = await claimPr({
            prKey,
            manifestPath,
            manifest: {
                prKey,
                port,
                uiHost,
                pid: process.pid,
                token,
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: SERVER_VERSION,
                createdAt: new Date().toISOString(),
            },
        });

        await ensurePrivateDir(sherpaDir, prStateDirOf(sherpaDir, prKey));
        db = openDatabase(databasePathFor(sherpaDir, prKey));
        const workerIdPath = workerIdPathFor(sherpaDir, prKey);

        const queue = new TaskQueue(options.now === undefined ? { db } : { db, now: options.now });
        const workerRegistry = new WorkerRegistry({
            db,
            leaseExpiryOf: (workerId) => queue.leaseExpiryOf(workerId),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.workerGapGraceSeconds === undefined
                ? {}
                : { gapGraceSeconds: options.workerGapGraceSeconds }),
        });
        const uiPresence = new UiPresence({
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.uiGoneGraceSeconds === undefined ? {} : { graceSeconds: options.uiGoneGraceSeconds }),
        });
        // A lease is one condition for liveness, so the registry must see it appear and disappear:
        // otherwise, cancelling a task would leave the worker's death time calculated from stale data.
        const unsubscribeQueue = queue.subscribeChanges(() => {
            workerRegistry.checkNow();
        });
        // Local iteration patches and slice cache, populated wherever a diff is loaded.
        const iterationStore = new IterationStore(options.now === undefined ? { db } : { db, now: options.now });
        // Reading progress is local and exists on every server, including those without a review host.
        // It needs iteration patches to carry over marks between iterations by file path.
        const progress = new ProgressStore({
            db,
            iterations: iterationStore,
            ...(options.now === undefined ? {} : { now: options.now }),
        });
        const hostOptions = {
            sherpaDir,
            repo: options.repo ?? null,
            base: options.base ?? null,
            branch: options.branch ?? null,
            verdicts: options.verdicts ?? null,
        };
        const reviewHost = selectReviewHost(prKey, hostOptions, options.hosts);
        const advanceIteration = reviewHost?.advanceIteration;
        // Without a host, there are no review events. The SSE channel carries state only.
        // A review status change (someone else's ship) reloads metadata so verdicts reach the UI snapshot.
        const reviewFeed =
            reviewHost === null
                ? null
                : new ReviewFeed(reviewHost.host, {
                      ...(reviewHost.watchStatus === undefined ? {} : { watchStatus: reviewHost.watchStatus }),
                      onStatusChange: () => {
                          void prMeta.refresh();
                      },
                  });
        // The snapshot includes PR metadata, and `buildState` is synchronous. The network `getPr()` call uses a cache.
        const prMeta = new PrMetaCache({ host: reviewHost?.host ?? null });
        // Draft buffer: text the host hasn't accepted yet survives host failure,
        // tab reloads and server restarts.
        const draftBuffer = new DraftBufferWriter({
            host: reviewHost?.host ?? null,
            store: new DraftBufferStore(options.now === undefined ? { db } : { db, now: options.now }),
            reviewFeed,
        });
        const updateChecker = new UpdateChecker({
            ...options.updateCheck,
            channel: options.updateChannel,
            sherpaDir,
            settings: settingsStore,
            enabled: reviewHost?.disablesUpdateCheck !== true,
        });
        // The route, like reading progress, is local. Without a host, it stays in the `none` phase.
        const routeStore = new RouteStore(options.now === undefined ? { db } : { db, now: options.now });
        // Notes are created before the feed, which moves their anchors to the new iteration.
        const chatStore = new ChatStore(options.now === undefined ? { db } : { db, now: options.now });
        // PR iterations: one watcher per server supplies `uiState.iterations` and `stale`.
        const iterationFeed =
            reviewHost === null
                ? null
                : new IterationFeed({
                      host: reviewHost.host,
                      iterations: iterationStore,
                      route: routeStore,
                      notes: chatStore,
                      progress,
                  });
        // Shared context survives restarts along with tasks. Cleanup at startup and on
        // key changes preserves diffs still referenced by an open or held task.
        const sharedPayload = new SharedPayloadStore(sharedPayloadDirOf(sherpaDir, prKey), () =>
            queue.listTasks().flatMap((task) => (holdsPayload(task) ? task.contextFiles : [])),
        );
        sharedPayload.sweepDiffKeys();
        const routeOrchestrator = new RouteOrchestrator({
            store: routeStore,
            queue,
            registry: workerRegistry,
            host: reviewHost?.host ?? null,
            payloadDir: routePayloadDirOf(sherpaDir, prKey),
            shared: sharedPayload,
            progress,
            iterations: iterationStore,
            // Generation language: settings are the second fallback after the tab's request.
            settings: settingsStore,
            ...(options.route === undefined ? {} : { config: options.route }),
        });
        const chatOrchestrator = new ChatOrchestrator({
            store: chatStore,
            route: routeStore,
            queue,
            host: reviewHost?.host ?? null,
            payloadDir: chatPayloadDirOf(sherpaDir, prKey),
            iterations: iterationStore,
            iterationFeed,
            shared: sharedPayload,
            settings: settingsStore,
            registry: workerRegistry,
        });
        // Publication rounds become agent tasks only where the host supports it
        // (a local checkout). Other hosts have no orchestrator.
        const feedbackOrchestrator =
            reviewHost?.feedback === undefined
                ? null
                : new FeedbackOrchestrator({
                      host: reviewHost.feedback,
                      queue,
                      store: new FeedbackStore(
                          options.now === undefined ? { db } : { db, now: options.now },
                      ),
                      payloadDir: feedbackPayloadDirOf(sherpaDir, prKey),
                      settings: settingsStore,
                      registry: workerRegistry,
                  });
        queue.setResultAcceptor(
            (task, result) =>
                routeOrchestrator.acceptResult(task, result) ??
                chatOrchestrator.acceptResult(task, result) ??
                feedbackOrchestrator?.acceptResult(task, result) ??
                null,
        );

        const setLocalVerdicts = reviewHost?.setLocalVerdicts;
        routes.push(
            ...createWorkerRoutes({
                queue,
                registry: workerRegistry,
                presence: uiPresence,
                longPollSeconds: options.longPollSeconds ?? LONG_POLL_DEFAULT_SECONDS,
                shutdownSignal: shutdownController.signal,
                publishWorkerId: (workerId) => {
                    writeWorkerIdFile(workerIdPath, workerId);
                },
                // The mode changed. The same snapshot sends metadata with the new `publishVerdicts` to the UI.
                ...(setLocalVerdicts === undefined
                    ? {}
                    : {
                          setLocalVerdicts: (instruction: string | null) => {
                              if (setLocalVerdicts(instruction)) {
                                  void prMeta.refresh();
                              }
                          },
                      }),
            }),
            ...createUiRoutes({
                prKey,
                queue,
                registry: workerRegistry,
                reviewHost: reviewHost === null ? null : { id: reviewHost.name, ...reviewHost.ui },
                reviewFeed,
                iterationFeed,
                prMeta,
                update: updateChecker,
                feedback: feedbackState,
                progress,
                route: routeStore,
                chat: chatStore,
                presence: uiPresence,
                shutdownSignal: shutdownController.signal,
            }),
            ...createReviewRoutes({
                host: reviewHost?.host ?? null,
                reviewFeed,
                progress,
                route: routeStore,
                prMeta,
                draftBuffer,
                iterations: iterationStore,
                iterationFeed,
                blobs: new BlobCache(sherpaDir, blobsDirOf(sherpaDir, prKey)),
                ...(feedbackOrchestrator === null
                    ? {}
                    : {
                          onPublished: () => {
                              void feedbackOrchestrator.reconcile();
                          },
                      }),
            }),
            ...createFeedbackRoutes({
                channel: options.feedbackChannel,
                ...(feedbackState?.kind === 'issues'
                    ? { availability: { available: feedbackState.available, reason: feedbackState.reason } }
                    : {}),
                prKey,
                workerStatus: () => workerRegistry.status(),
                ...(reviewHost?.currentUser === undefined ? {} : { currentUser: reviewHost.currentUser }),
            }),
            // Settings are global. The endpoint depends on neither the review host nor this PR's state.
            ...createSettingsRoutes({
                settings: settingsStore,
                // The dismissed version lives in settings. Patching them must rebuild the snapshot.
                onChange: () => {
                    updateChecker.settingsChanged();
                },
            }),
            // This PR's UI state (folds, palette history) is local and doesn't need a review host.
            ...createPrStateRoutes({
                prState: new PrStateStore(options.now === undefined ? { db } : { db, now: options.now }),
            }),
            ...createRouteRoutes({ store: routeStore, orchestrator: routeOrchestrator, iterationFeed }),
            ...createChatRoutes({ store: chatStore, orchestrator: chatOrchestrator }),
            // Dev endpoints exist only for the fixture host. Other hosts don't have these routes.
            ...(advanceIteration === undefined
                ? []
                : createDevRoutes({
                      advanceIteration,
                      update: updateChecker,
                      ...(reviewHost?.setFailDraftWrites === undefined
                          ? {}
                          : { setFailDraftWrites: reviewHost.setFailDraftWrites }),
                  })),
        );
        markRoutesReady();

        const handle = createHandle({
            manifest: claimed,
            uiHost,
            manifestPath,
            httpServer,
            db,
            queue,
            workerRegistry,
            uiPresence,
            unsubscribeQueue,
            shutdownController,
            idleWatch,
            reviewFeed,
            iterationFeed,
            prMeta,
            draftBuffer,
            updateChecker,
            progress,
            routeStore,
            routeOrchestrator,
            chatStore,
            chatOrchestrator,
            feedbackOrchestrator,
        });
        // Warm up the route after building the handle, on its own timer. Server startup doesn't wait for `getDiff()`,
        // or the "diff on screen in under two seconds" target would have to wait on a host network call.
        routeOrchestrator.start();
        chatOrchestrator.start();
        // Requeue a round that didn't reach the agent during the previous run.
        void feedbackOrchestrator?.reconcile();
        // PR metadata also loads in the background. The snapshot is served immediately, and metadata arrives over SSE.
        prMeta.start();
        // Queue retries for drafts that weren't delivered during the previous run.
        draftBuffer.start();
        // The version check also runs in the background, after listen. Server startup doesn't wait for it.
        updateChecker.start();
        // Arm automatic shutdown last. Before this point, there's nothing to stop.
        idleWatch.arm(() => {
            options.onIdleStop?.(idleSeconds);
            void handle.close().catch((error: unknown) => {
                process.stderr.write(`sherpa-server: error during automatic shutdown: ${messageOf(error)}\n`);
            });
        });
        return handle;
    } catch (error) {
        markRoutesReady();
        idleWatch.close();
        shutdownController.abort();
        if (claimed !== null) {
            await removeOwnManifest(manifestPath, claimed);
        }
        await shutdown(httpServer, db);
        throw error;
    }
}

/**
 * Claims the sole server slot for this PR. Claiming and checking whether it's taken form one
 * atomic manifest creation operation, so starting two servers concurrently produces
 * exactly one winner. The loser receives `ServerAlreadyRunningError`.
 */
async function claimPr(parts: {
    prKey: string;
    manifestPath: string;
    manifest: ServerManifest;
}): Promise<ServerManifest> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
        if (await claimManifest(parts.manifestPath, parts.manifest)) {
            return parts.manifest;
        }

        const existing = await readManifest(parts.manifestPath);
        if (existing !== null && (await isManifestServerAlive(existing))) {
            throw new ServerAlreadyRunningError({
                prKey: parts.prKey,
                port: existing.port,
                pid: existing.pid,
            });
        }
        await releaseStaleManifest(parts.manifestPath, existing);
    }

    throw new Error(
        `Could not claim the manifest for PR ${parts.prKey}: on each of ${String(CLAIM_ATTEMPTS)} attempts, it was ` +
            'taken by another process.',
    );
}

function healthRoute(prKey: string): Route {
    return {
        method: 'GET',
        path: '/healthz',
        handle: () => {
            const body: HealthResponse = {
                ok: true,
                prKey,
                pid: process.pid,
                serverVersion: SERVER_VERSION,
                protocolVersion: PROTOCOL_VERSION,
            };
            return { status: 200, body };
        },
    };
}

function createHandle(parts: {
    manifest: ServerManifest;
    uiHost: string;
    manifestPath: string;
    httpServer: http.Server;
    db: SherpaDatabase;
    queue: TaskQueue;
    workerRegistry: WorkerRegistry;
    uiPresence: UiPresence;
    unsubscribeQueue: () => void;
    shutdownController: AbortController;
    idleWatch: IdleWatch;
    reviewFeed: ReviewFeed | null;
    iterationFeed: IterationFeed | null;
    prMeta: PrMetaCache;
    draftBuffer: DraftBufferWriter;
    updateChecker: UpdateChecker;
    progress: ProgressStore;
    routeStore: RouteStore;
    routeOrchestrator: RouteOrchestrator;
    chatStore: ChatStore;
    chatOrchestrator: ChatOrchestrator;
    feedbackOrchestrator: FeedbackOrchestrator | null;
}): SherpaServer {
    let closing: Promise<void> | null = null;

    return {
        port: parts.manifest.port,
        token: parts.manifest.token,
        prKey: parts.manifest.prKey,
        uiHost: parts.uiHost,
        queue: parts.queue,
        workerRegistry: parts.workerRegistry,
        route: parts.routeOrchestrator,
        chat: parts.chatOrchestrator,
        close: () => {
            closing ??= (async () => {
                // Stop the idle timer first. Shutdown is already in progress, so there's no need to call it again.
                parts.idleWatch.close();
                // Abort pending long polls first, or they'll try to write to closed sockets.
                parts.shutdownController.abort();
                // Unsubscribe from the queue and stop the worker death timer before closing storage:
                // after close(), nothing should read from it.
                parts.unsubscribeQueue();
                parts.workerRegistry.close();
                parts.uiPresence.close();
                // Stop host polling here too, or the subscription would outlive server shutdown.
                parts.reviewFeed?.close();
                parts.iterationFeed?.close();
                // The metadata load retry must not wake up after server shutdown.
                parts.prMeta.close();
                // The same applies to draft buffer retries. The next run will pick them up.
                parts.draftBuffer.close();
                parts.updateChecker.close();
                parts.progress.close();
                // Stop the route state machine before closing storage. Its delayed warmup must not
                // wake up with the database already closed.
                parts.routeOrchestrator.close();
                parts.routeStore.close();
                parts.chatOrchestrator.close();
                parts.chatStore.close();
                parts.feedbackOrchestrator?.close();
                await removeOwnManifest(parts.manifestPath, parts.manifest);
                await shutdown(parts.httpServer, parts.db);
            })();
            return closing;
        },
    };
}

async function shutdown(httpServer: http.Server, db: SherpaDatabase | null): Promise<void> {
    if (httpServer.listening) {
        // Otherwise close() waits for long-poll keep-alive connections to finish.
        httpServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }
    db?.close();
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function listen(httpServer: http.Server, host: string): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            reject(error);
        };
        httpServer.once('error', onError);
        httpServer.listen(0, host, () => {
            httpServer.removeListener('error', onError);
            resolve();
        });
    });

    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
        throw new Error('The server is not listening on a TCP port. This should never happen.');
    }
    return address.port;
}
