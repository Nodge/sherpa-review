import { activeT } from '../i18n/index.js';
import type { DiffFileModel, DiffParseRequest } from './model.js';

/**
 * Client wrapper for the diff worker: "parse file" request → model.
 *
 * Uses one worker. A pool based on `hardwareConcurrency` is an optimization to add
 * when a performance run shows the need. The transport is abstracted (like `connect` in `store.ts`):
 * `postMessage` in the browser, a direct parser call in tests.
 */

export interface DiffParseMessage {
    /** Request number: worker replies arrive in any order. */
    id: number;
    file: DiffParseRequest;
}

export type DiffParseReply =
    | { id: number; ok: true; model: DiffFileModel }
    | { id: number; ok: false; error: string };

export interface DiffWorkerHandlers {
    readonly onMessage: (reply: DiffParseReply) => void;
    /** The whole worker failed: could not load, crashed, or could not clone the reply. */
    readonly onError: (error: Error) => void;
}

export interface DiffWorkerConnection {
    readonly post: (message: DiffParseMessage) => void;
    readonly close: () => void;
}

export interface DiffClientOptions {
    /** Worker connection: substituted in tests, `Worker` in the browser. */
    readonly connect?: (handlers: DiffWorkerHandlers) => DiffWorkerConnection;
}

export interface DiffClient {
    /**
     * File model from the cache or worker. Cache uses the `diffId` + `fileId` pair:
     * a PR iteration is immutable, so its diff is parsed once.
     */
    readonly parseFile: (diffId: string, file: DiffParseRequest) => Promise<DiffFileModel>;
    readonly close: () => void;
}

export function createDiffClient(options: DiffClientOptions = {}): DiffClient {
    const connect = options.connect ?? connectWorker;
    const cache = new Map<string, Promise<DiffFileModel>>();
    const pending = new Map<number, { resolve: (model: DiffFileModel) => void; reject: (error: Error) => void }>();

    let connection: DiffWorkerConnection | null = null;
    let closed = false;
    let nextId = 1;

    const handlers: DiffWorkerHandlers = {
        onMessage: (reply) => {
            const waiter = pending.get(reply.id);
            if (waiter === undefined) {
                return;
            }
            pending.delete(reply.id);
            if (reply.ok) {
                waiter.resolve(reply.model);
            } else {
                waiter.reject(new Error(reply.error));
            }
        },
        onError: (error) => {
            // This worker will send no more replies. Reject pending requests and drop
            // the connection. The next parseFile will restart the worker.
            for (const waiter of pending.values()) {
                waiter.reject(error);
            }
            pending.clear();
            connection?.close();
            connection = null;
        },
    };

    return {
        parseFile: (diffId, file) => {
            if (closed) {
                return Promise.reject(new Error(activeT()('diff.worker.closed')));
            }

            // The separator is a null character, not a space: host ids are opaque, and a space would give
            // pairs ('a b', 'c') and ('a', 'b c') the same key.
            const key = `${diffId}\u0000${file.fileId}`;
            const cached = cache.get(key);
            if (cached !== undefined) {
                return cached;
            }

            connection ??= connect(handlers);
            const id = nextId;
            nextId += 1;

            const request = new Promise<DiffFileModel>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                connection?.post({ id, file });
            }).catch((error: unknown) => {
                // Do not cache failures. The next request for this file must reach the worker.
                cache.delete(key);
                throw error instanceof Error ? error : new Error(String(error));
            });

            cache.set(key, request);
            return request;
        },
        close: () => {
            closed = true;
            for (const waiter of pending.values()) {
                waiter.reject(new Error(activeT()('diff.worker.closed')));
            }
            pending.clear();
            cache.clear();
            connection?.close();
            connection = null;
        },
    };
}

/** Real worker: the bundler resolves the path, so the URL must be a literal. */
function connectWorker(handlers: DiffWorkerHandlers): DiffWorkerConnection {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<DiffParseReply>) => {
        handlers.onMessage(event.data);
    });
    // The worker may fail to load or crash between post and reply. This is an event, not an exception.
    worker.addEventListener('error', (event: ErrorEvent) => {
        handlers.onError(new Error(event.message.length > 0 ? event.message : activeT()('diff.worker.crashed')));
    });
    worker.addEventListener('messageerror', () => {
        handlers.onError(new Error(activeT()('diff.worker.cloneFailed')));
    });

    return {
        post: (message) => {
            worker.postMessage(message);
        },
        close: () => {
            worker.terminate();
        },
    };
}
