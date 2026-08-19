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
import { leaseSchema, taskSchema } from './task.js';

/**
 * Contract JSON schemas generated from zod (spec §5): zod schemas are canonical,
 * JSON Schema is derived for non-TS consumers (C5 task payloads, documentation).
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
    };

    // io: 'input' describes what the sender must supply.
    return Object.fromEntries(
        Object.entries(sources).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]),
    );
}
