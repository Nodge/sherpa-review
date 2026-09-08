import type { DiffParseMessage, DiffParseReply } from './client.js';
import { parseFileDiff } from './parse.js';

/**
 * Diff worker entry point: moves patch parsing off the main thread (docs/architecture.md §1).
 * Only transport lives here. All logic is in `parse.ts` so it can be tested without a worker.
 */

/** `DedicatedWorkerGlobalScope` types live in the `webworker` lib, while the UI bundle uses `dom`. */
interface WorkerScope {
    addEventListener: (type: 'message', listener: (event: MessageEvent<DiffParseMessage>) => void) => void;
    postMessage: (message: DiffParseReply) => void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener('message', (event) => {
    const { id, file } = event.data;
    try {
        scope.postMessage({ id, ok: true, model: parseFileDiff(file) });
    } catch (error) {
        // The parser is designed not to throw. If it still crashes, the worker must respond,
        // otherwise the client request will hang forever.
        scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});
