import { z } from 'zod';

import { serverManifestSchema } from './manifest.js';
import {
    rpcErrorSchema,
    taskAckResponseSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskFailRequestSchema,
    taskProgressRequestSchema,
    workerNextRequestSchema,
    workerNextResponseSchema,
    workerRegisterRequestSchema,
    workerRegisterResponseSchema,
    workerStatusSchema,
} from './messages.js';
import { routeSectionResultSchema, routeSkeletonResultSchema, routeSnapshotSchema } from './route.js';
import { leaseSchema, taskSchema } from './task.js';
import {
    uiCancelRequestSchema,
    uiCancelResponseSchema,
    uiEnqueueRequestSchema,
    uiEnqueueResponseSchema,
    uiStateSchema,
    uiTaskSchema,
} from './ui.js';

/**
 * Contract JSON schemas generated from zod (`docs/architecture.md §5`). Zod schemas are canonical,
 * JSON Schema is derived for consumers outside TS (generation task payloads, documentation).
 */
export function generateJsonSchemas(): Record<string, unknown> {
    const sources = {
        task: taskSchema,
        lease: leaseSchema,
        workerRegisterRequest: workerRegisterRequestSchema,
        workerRegisterResponse: workerRegisterResponseSchema,
        workerStatus: workerStatusSchema,
        workerNextRequest: workerNextRequestSchema,
        workerNextResponse: workerNextResponseSchema,
        taskCompleteRequest: taskCompleteRequestSchema,
        taskCompleteResponse: taskCompleteResponseSchema,
        taskProgressRequest: taskProgressRequestSchema,
        taskFailRequest: taskFailRequestSchema,
        taskAckResponse: taskAckResponseSchema,
        rpcError: rpcErrorSchema,
        serverManifest: serverManifestSchema,
        uiTask: uiTaskSchema,
        uiState: uiStateSchema,
        uiEnqueueRequest: uiEnqueueRequestSchema,
        uiEnqueueResponse: uiEnqueueResponseSchema,
        uiCancelRequest: uiCancelRequestSchema,
        uiCancelResponse: uiCancelResponseSchema,
        routeSnapshot: routeSnapshotSchema,
        // Generation task result schemas are passed as files in the payload (`docs/protocol.md §4`).
        routeSkeletonResult: routeSkeletonResultSchema,
        routeSectionResult: routeSectionResultSchema,
    };

    // io: 'input' describes what the sender must supply.
    return Object.fromEntries(
        Object.entries(sources).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]),
    );
}
