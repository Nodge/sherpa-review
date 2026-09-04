import { activeT } from '../i18n/index.js';
import type { DiffPixelsOptions, ImageDiffResult, PixelSurface } from './image-diff.js';

/**
 * Client wrapper for the pixel-difference worker (M5-T25). Follows `diff/client.ts`:
 * the transport is injected (`postMessage` in the browser, a direct `diffPixels` call in tests),
 * raster buffers are transferred without copying.
 *
 * One lazy worker per tab: it does not exist until the reviewer selects Diff mode.
 */

export interface ImageDiffMessage {
    /** Request number: replies arrive in any order, and many cards can be on screen. */
    id: number;
    before: PixelSurface;
    after: PixelSurface;
    options: DiffPixelsOptions;
}

export type ImageDiffReply =
    | { id: number; ok: true; result: ImageDiffResult }
    | { id: number; ok: false; error: string };

export interface ImageDiffHandlers {
    readonly onMessage: (reply: ImageDiffReply) => void;
    /** The whole worker failed: could not load, crashed, or could not clone the reply. */
    readonly onError: (error: Error) => void;
}

export interface ImageDiffConnection {
    readonly post: (message: ImageDiffMessage, transfer: readonly ArrayBuffer[]) => void;
    readonly close: () => void;
}

export interface ImageDiffClientOptions {
    readonly connect?: (handlers: ImageDiffHandlers) => ImageDiffConnection;
}

export interface ImageDiffClient {
    /** Transfers rasters to the worker: the caller's buffers are empty after the call. */
    readonly compute: (
        before: PixelSurface,
        after: PixelSurface,
        options: DiffPixelsOptions,
    ) => Promise<ImageDiffResult>;
    readonly close: () => void;
}

export function createImageDiffClient(options: ImageDiffClientOptions = {}): ImageDiffClient {
    const connect = options.connect ?? connectWorker;
    const pending = new Map<number, { resolve: (result: ImageDiffResult) => void; reject: (error: Error) => void }>();

    let connection: ImageDiffConnection | null = null;
    let closed = false;
    let nextId = 1;

    const handlers: ImageDiffHandlers = {
        onMessage: (reply) => {
            const waiter = pending.get(reply.id);
            if (waiter === undefined) {
                return;
            }
            pending.delete(reply.id);
            if (reply.ok) {
                waiter.resolve(reply.result);
            } else {
                waiter.reject(new Error(reply.error));
            }
        },
        onError: (error) => {
            // This worker will send no more replies. Reject pending requests and drop
            // the connection. The next calculation will restart the worker.
            for (const waiter of pending.values()) {
                waiter.reject(error);
            }
            pending.clear();
            connection?.close();
            connection = null;
        },
    };

    return {
        compute: (before, after, diffOptions) => {
            if (closed) {
                return Promise.reject(new Error(activeT()('diff.worker.closed')));
            }

            connection ??= connect(handlers);
            const id = nextId;
            nextId += 1;

            return new Promise<ImageDiffResult>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                connection?.post({ id, before, after, options: diffOptions }, [
                    before.data.buffer as ArrayBuffer,
                    after.data.buffer as ArrayBuffer,
                ]);
            });
        },
        close: () => {
            closed = true;
            for (const waiter of pending.values()) {
                waiter.reject(new Error(activeT()('diff.worker.closed')));
            }
            pending.clear();
            connection?.close();
            connection = null;
        },
    };
}

let shared: ImageDiffClient | null = null;

/** Per-tab client: starts the worker on the first request, when Diff is first selected. */
export function sharedImageDiffClient(): ImageDiffClient {
    shared ??= createImageDiffClient();
    return shared;
}

/** Real worker: the bundler resolves the path, so the URL must be a literal. */
function connectWorker(handlers: ImageDiffHandlers): ImageDiffConnection {
    const worker = new Worker(new URL('./image-diff.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<ImageDiffReply>) => {
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
        post: (message, transfer) => {
            worker.postMessage(message, [...transfer]);
        },
        close: () => {
            worker.terminate();
        },
    };
}
