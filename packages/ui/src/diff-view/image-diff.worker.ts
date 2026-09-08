import type { ImageDiffMessage, ImageDiffReply } from './image-diff-client.js';
import { diffPixels } from './image-diff.js';

/**
 * Pixel diff worker entry point: processing several million pixels
 * must not block the main thread. Only transport lives here. All logic is in `image-diff.ts`.
 */

/** `DedicatedWorkerGlobalScope` types live in the `webworker` lib, while the UI bundle uses `dom`. */
interface WorkerScope {
    addEventListener: (type: 'message', listener: (event: MessageEvent<ImageDiffMessage>) => void) => void;
    postMessage: (message: ImageDiffReply, transfer?: readonly ArrayBuffer[]) => void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
    const { id, before, after, options } = event.data;
    try {
        const result = diffPixels(before, after, options);
        scope.postMessage({ id, ok: true, result }, [result.data.buffer as ArrayBuffer]);
    } catch (error) {
        // The calculation cannot throw by design. If it does fail, the worker must reply,
        // otherwise the client request will hang forever.
        scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});
