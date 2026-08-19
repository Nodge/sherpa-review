import http from 'node:http';

import type { ServerManifest } from '@sherpa/protocol';
import { PROTOCOL_VERSION } from '@sherpa/protocol';

import { createToken } from './auth.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { ServerAlreadyRunningError } from './errors.js';
import type { Route } from './http.js';
import { createRequestListener } from './http.js';
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
    databasePathFor,
    DEFAULT_SHERPA_DIR,
    ensurePrivateDir,
    manifestPathFor,
    prStateDirOf,
    serversDirOf,
} from './paths.js';
import { SERVER_VERSION } from './version.js';

export interface StartServerOptions {
    /** PR key in `<host>-<pr>` format, used as the manifest and state directory name. */
    prKey: string;
    /** State root, defaults to `~/.sherpa`. */
    sherpaDir?: string;
}

export interface SherpaServer {
    readonly port: number;
    readonly token: string;
    readonly prKey: string;
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
    const httpServer = http.createServer(createRequestListener({ token, routes: createRoutes(prKey) }));
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

        return createHandle({ manifest: claimed, manifestPath, httpServer, db });
    } catch (error) {
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

function createRoutes(prKey: string): Route[] {
    return [
        {
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
        },
    ];
}

function createHandle(parts: {
    manifest: ServerManifest;
    manifestPath: string;
    httpServer: http.Server;
    db: SherpaDatabase;
}): SherpaServer {
    let closing: Promise<void> | null = null;

    return {
        port: parts.manifest.port,
        token: parts.manifest.token,
        prKey: parts.manifest.prKey,
        close: () => {
            closing ??= (async () => {
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
