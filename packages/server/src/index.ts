/**
 * Sherpa local server (spec §1/C2): discovery manifest, bearer authentication, storage.
 * Queue, worker endpoints and UI channel arrive in M0-T4…T7.
 */
export { createToken, extractBearerToken, tokenMatches } from './auth.js';
export type { SherpaDatabase } from './db.js';
export { applyMigrations, openDatabase, readSchemaVersion } from './db.js';
export { ServerAlreadyRunningError } from './errors.js';
export type { JsonResponse, RequestContext, Route, RouteHandler } from './http.js';
export { createRequestListener, rpcError } from './http.js';
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
export type { HealthResponse, SherpaServer, StartServerOptions } from './server.js';
export { startServer } from './server.js';
export { SERVER_VERSION } from './version.js';
