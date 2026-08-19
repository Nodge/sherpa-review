/**
 * Sherpa local server (spec §1/C2): discovery manifest, bearer authentication, storage,
 * queue with leases and worker endpoints. UI channel arrives in M0-T7.
 */
export { createToken, extractBearerToken, tokenMatches } from './auth.js';
export type { SherpaDatabase } from './db.js';
export { applyMigrations, openDatabase, readSchemaVersion } from './db.js';
export { RpcFailure, ServerAlreadyRunningError } from './errors.js';
export type { JsonResponse, RequestContext, Route, RouteHandler } from './http.js';
export {
    createRequestListener,
    handlingRpcFailures,
    readJsonBody,
    REQUEST_BODY_MAX_BYTES,
    rpcError,
    rpcFailureResponse,
} from './http.js';
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
export type {
    CancelOutcome,
    EnqueueInput,
    LeasedTask,
    TaskQueueOptions,
    TaskRecord,
    TaskStatus,
} from './queue.js';
export { TaskQueue } from './queue.js';
export type { HealthResponse, SherpaServer, StartServerOptions } from './server.js';
export { startServer } from './server.js';
export { SERVER_VERSION } from './version.js';
export type { WorkerRegistryOptions, WorkerStatusListener } from './worker-registry.js';
export { WorkerRegistry } from './worker-registry.js';
export type { WorkerRoutesOptions } from './worker-routes.js';
export { createWorkerRoutes } from './worker-routes.js';
