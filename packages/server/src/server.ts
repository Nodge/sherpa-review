import http from 'node:http';

import type { ServerManifest } from '@sherpa/protocol';
import { LONG_POLL_DEFAULT_SECONDS, PROTOCOL_VERSION } from '@sherpa/protocol';

import { createToken } from './auth.js';
import { ChatOrchestrator } from './chat-orchestrator.js';
import { createChatRoutes } from './chat-routes.js';
import { ChatStore } from './chat-store.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { ServerAlreadyRunningError } from './errors.js';
import type { FeedbackIntegrationOptions } from './feedback-routes.js';
import { createFeedbackRoutes, feedbackAvailability } from './feedback-routes.js';
import type { ReviewHostFactory } from './hosts/select.js';
import { selectReviewHost } from './hosts/select.js';
import type { RequestListenerOptions, Route } from './http.js';
import { createRequestListener } from './http.js';
import { DEFAULT_IDLE_SECONDS, IdleWatch } from './idle.js';
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
    chatPayloadDirOf,
    databasePathFor,
    DEFAULT_SHERPA_DIR,
    ensurePrivateDir,
    manifestPathFor,
    prStateDirOf,
    routePayloadDirOf,
    serversDirOf,
    workerIdPathFor,
} from './paths.js';
import { PrMetaCache } from './pr-meta.js';
import { ProgressStore } from './progress-store.js';
import { TaskQueue } from './queue.js';
import { ReviewFeed } from './review-feed.js';
import type { EditorOptions } from './review-routes.js';
import { createReviewRoutes } from './review-routes.js';
import type { RouteConfig } from './route-orchestrator.js';
import { RouteOrchestrator } from './route-orchestrator.js';
import { createRouteRoutes } from './route-routes.js';
import { RouteStore } from './route-store.js';
import type { StaticAssets } from './static.js';
import { UiPresence } from './ui-presence.js';
import { createUiRoutes } from './ui-routes.js';
import { SERVER_VERSION } from './version.js';
import { writeWorkerIdFile } from './worker-id-file.js';
import { WorkerRegistry } from './worker-registry.js';
import { createWorkerRoutes } from './worker-routes.js';

export interface StartServerOptions {
    /** PR key in `<host>-<pr>` format, used as the manifest and state directory name. */
    prKey: string;
    /** State root, defaults to `~/.sherpa`. */
    sherpaDir?: string;
    /**
     * Long-poll window for `worker next` when the call provides no `waitSeconds`.
     * Defaults to `LONG_POLL_DEFAULT_SECONDS`. Shortened in tests.
     */
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
     * Selects a host adapter by PR key. Defaults to `selectReviewHost`. Tests can inject a host
     * without a live service (`() => null` runs the server without review endpoints).
     */
    reviewHostFactory?: ReviewHostFactory;
    /** Feedback channel transport and environment. Tests replace fetch and credentials without a live issue service. */
    feedback?: FeedbackIntegrationOptions;
    /** "Open in external editor" settings. Defaults to the server's cwd and `SHERPA_EDITOR`. */
    editor?: EditorOptions;
    /**
     * Route thresholds and section batching (`DEFAULT_ROUTE_CONFIG`). Internal server policy:
     * neither the UI nor the CLI knows about it. The M2-T12 latency measurement adjusts section batches here.
     */
    route?: Partial<RouteConfig>;
}

export interface SherpaServer {
    readonly port: number;
    readonly token: string;
    readonly prKey: string;
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
 * Starts the local PR server: 127.0.0.1 only, random port, bearer token on every endpoint,
 * discovery manifest in `<sherpaDir>/servers/<prKey>.json` (rpc-design §2, §8).
 * If a server for the same PR is already alive, throws `ServerAlreadyRunningError` without starting a second process.
 */
export async function startServer(options: StartServerOptions): Promise<SherpaServer> {
    const prKey = assertValidPrKey(options.prKey);
    const sherpaDir = options.sherpaDir ?? DEFAULT_SHERPA_DIR;
    const serversDir = serversDirOf(sherpaDir);
    const manifestPath = manifestPathFor(sherpaDir, prKey);

    await ensurePrivateDir(sherpaDir, serversDir);
    await cleanStaleManifests(serversDir);

    const token = createToken();
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
        ...(options.assets === undefined ? {} : { assets: options.assets }),
    };
    const httpServer = http.createServer(createRequestListener(listenerOptions));
    const shutdownController = new AbortController();
    let claimed: ServerManifest | null = null;
    let db: SherpaDatabase | null = null;

    try {
        // Listen before claiming the manifest. Once it's published, a competing process can
        // check us through `/healthz` and must get a response.
        const port = await listen(httpServer);
        claimed = await claimPr({
            prKey,
            manifestPath,
            manifest: {
                prKey,
                port,
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
        // Reading progress is local and exists on every server, including those without a review host.
        const progress = new ProgressStore(options.now === undefined ? { db } : { db, now: options.now });
        const reviewHost = (options.reviewHostFactory ?? selectReviewHost)(prKey);
        // Without a host, there are no review events. The SSE channel keeps serving M0 state only.
        const reviewFeed = reviewHost === null ? null : new ReviewFeed(reviewHost.host);
        // The snapshot includes PR metadata, and `buildState` is synchronous. The network `getPr()` call uses a cache.
        const prMeta = new PrMetaCache({ host: reviewHost?.host ?? null });
        // The route, like reading progress, is local. Without a host, it stays in the `none` phase.
        const routeStore = new RouteStore(options.now === undefined ? { db } : { db, now: options.now });
        const routeOrchestrator = new RouteOrchestrator({
            store: routeStore,
            queue,
            registry: workerRegistry,
            host: reviewHost?.host ?? null,
            payloadDir: routePayloadDirOf(sherpaDir, prKey),
            progress,
            ...(options.route === undefined ? {} : { config: options.route }),
        });
        const chatStore = new ChatStore(options.now === undefined ? { db } : { db, now: options.now });
        const chatOrchestrator = new ChatOrchestrator({
            store: chatStore,
            queue,
            host: reviewHost?.host ?? null,
            payloadDir: chatPayloadDirOf(sherpaDir, prKey),
        });
        queue.setResultAcceptor(
            (task, result) =>
                routeOrchestrator.acceptResult(task, result) ?? chatOrchestrator.acceptResult(task, result),
        );

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
            }),
            ...createUiRoutes({
                prKey,
                queue,
                registry: workerRegistry,
                reviewHost: reviewHost?.name ?? null,
                reviewFeed,
                prMeta,
                feedback: feedbackAvailability(options.feedback?.env ?? process.env),
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
                ...(options.editor === undefined ? {} : { editor: options.editor }),
            }),
            ...createFeedbackRoutes({
                prKey,
                workerStatus: () => workerRegistry.status(),
                ...(reviewHost?.currentUser === undefined ? {} : { currentUser: reviewHost.currentUser }),
                ...options.feedback,
            }),
            ...createRouteRoutes({ store: routeStore, orchestrator: routeOrchestrator }),
            ...createChatRoutes({ store: chatStore, orchestrator: chatOrchestrator }),
        );
        markRoutesReady();

        const handle = createHandle({
            manifest: claimed,
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
            prMeta,
            progress,
            routeStore,
            routeOrchestrator,
            chatStore,
            chatOrchestrator,
        });
        // Warm up the route after building the handle, on its own timer. Server startup doesn't wait for `getDiff()`,
        // otherwise the "diff on screen in under two seconds" requirement (§7) would wait on the host's network call.
        routeOrchestrator.start();
        chatOrchestrator.start();
        // PR metadata also loads in the background. The snapshot is served immediately, and metadata arrives over SSE.
        prMeta.start();
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
    prMeta: PrMetaCache;
    progress: ProgressStore;
    routeStore: RouteStore;
    routeOrchestrator: RouteOrchestrator;
    chatStore: ChatStore;
    chatOrchestrator: ChatOrchestrator;
}): SherpaServer {
    let closing: Promise<void> | null = null;

    return {
        port: parts.manifest.port,
        token: parts.manifest.token,
        prKey: parts.manifest.prKey,
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
                // The metadata load retry must not wake up after server shutdown.
                parts.prMeta.close();
                parts.progress.close();
                // Stop the route state machine before closing storage. Its delayed warmup must not
                // wake up with the database already closed.
                parts.routeOrchestrator.close();
                parts.routeStore.close();
                parts.chatOrchestrator.close();
                parts.chatStore.close();
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

async function listen(httpServer: http.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            reject(error);
        };
        httpServer.once('error', onError);
        httpServer.listen(0, '127.0.0.1', () => {
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
