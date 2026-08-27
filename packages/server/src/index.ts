/**
 * Sherpa local server (spec §1/C2): discovery manifest, bearer authentication, storage,
 * leased task queue, worker endpoints and a UI channel (REST + SSE, serving the built UI).
 */
export { createToken, extractBearerToken, tokenMatches } from './auth.js';
export type { SherpaDatabase } from './db.js';
export { applyMigrations, openDatabase, readSchemaVersion, transaction } from './db.js';
export { RpcFailure, ServerAlreadyRunningError } from './errors.js';
export type {
    JsonResponse,
    JsonRoute,
    RequestContext,
    RequestListenerOptions,
    Route,
    RouteAuth,
    RouteHandler,
    StreamContext,
    StreamHandler,
    StreamRoute,
} from './http.js';
export {
    abortOnDisconnect,
    createRequestListener,
    handlingRpcFailures,
    readJsonBody,
    REQUEST_BODY_MAX_BYTES,
    rpcError,
    rpcFailureResponse,
} from './http.js';






export type { ReviewHostFactory, SelectedHost } from './hosts/select.js';
export { selectReviewHost } from './hosts/select.js';
export {
    claimManifest,
    cleanStaleManifests,
    isManifestServerAlive,
    isProcessAlive,
    readManifest,
    releaseStaleManifest,
    removeOwnManifest,
} from './manifest.js';
export type { Migration } from './migrations.js';
export { MIGRATIONS, SCHEMA_VERSION_KEY } from './migrations.js';
export {
    assertValidPrKey,
    databasePathFor,
    DEFAULT_SHERPA_DIR,
    manifestPathFor,
    prStateDirOf,
    serversDirOf,
} from './paths.js';
export type { PrMetaCacheOptions } from './pr-meta.js';
export { PrMetaCache } from './pr-meta.js';
export type {
    CancelOutcome,
    EnqueueInput,
    LeasedTask,
    TaskQueueOptions,
    TaskRecord,
    TaskResultAcceptance,
    TaskResultAcceptor,
} from './queue.js';
export { MAX_RESULT_REJECTIONS, TaskQueue } from './queue.js';
export { ReviewFeed } from './review-feed.js';
export type { ReviewRoutesOptions } from './review-routes.js';
export { createReviewRoutes } from './review-routes.js';
export type { RouteConfig, RouteOrchestratorOptions } from './route-orchestrator.js';
export { DEFAULT_ROUTE_CONFIG, isSmallPr, RouteOrchestrator } from './route-orchestrator.js';
export type { RouteRoutesOptions } from './route-routes.js';
export { createRouteRoutes } from './route-routes.js';
export type { AcceptedSkeletonInput, RouteListener, RouteStoreOptions } from './route-store.js';
export { contentHashOf, RouteStore } from './route-store.js';
export type { HealthResponse, SherpaServer, StartServerOptions } from './server.js';
export { startServer } from './server.js';
export type { StaticAsset, StaticAssets } from './static.js';
export { bundledAssets, contentTypeOf, directoryAssets, isStaticPath, serveStatic } from './static.js';
export type { PrMetaSource, UiRoutesOptions } from './ui-routes.js';
export { createUiRoutes } from './ui-routes.js';
export { SERVER_VERSION } from './version.js';
export type { WorkerRegistryOptions, WorkerStatusListener } from './worker-registry.js';
export { WorkerRegistry } from './worker-registry.js';
export type { WorkerRoutesOptions } from './worker-routes.js';
export { createWorkerRoutes } from './worker-routes.js';
