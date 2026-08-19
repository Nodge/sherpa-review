import { describe, expect, it } from 'vitest';

import {
    generateJsonSchemas,
    PROTOCOL_VERSION,
    protocolVersionsCompatible,
    RESULT_MAX_BYTES,
    serverManifestSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskSchema,
    workerNextResponseSchema,
} from './index.js';

describe('version and handshake', () => {
    it('exports the protocol version', () => {
        expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('treats minor versions as breaking in 0.x, and only major versions from 1.0', () => {
        expect(protocolVersionsCompatible('0.1.0', '0.1.7')).toBe(true);
        expect(protocolVersionsCompatible('0.1.0', '0.2.0')).toBe(false);
        expect(protocolVersionsCompatible('1.2.0', '1.9.3')).toBe(true);
        expect(protocolVersionsCompatible('1.0.0', '2.0.0')).toBe(false);
    });

    it('treats unrecognized strings as incompatible', () => {
        expect(protocolVersionsCompatible('garbage', '0.1.0')).toBe(false);
        expect(protocolVersionsCompatible('0.1', '0.1.0')).toBe(false);
    });
});

describe('task and lease', () => {
    const validTask = {
        id: 42,
        type: 'echo',
        priority: 'interactive',
        attempt: 1,
        instructions: 'Return the file contents as is.',
        contextFiles: ['/tmp/sherpa/task-42-context.md'],
    };

    it('accepts a valid echo task', () => {
        expect(taskSchema.parse(validTask)).toEqual(validTask);
    });

    it('fails closed: rejects unknown types, zero attempts and empty instructions', () => {
        expect(taskSchema.safeParse({ ...validTask, type: 'route.skeleton' }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, attempt: 0 }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, instructions: '' }).success).toBe(false);
    });

    it('distinguishes task/idle/done in the next response by kind', () => {
        const parsed = workerNextResponseSchema.parse({
            kind: 'task',
            task: validTask,
            lease: { taskId: 42, ttlSeconds: 600, expiresAt: '2026-08-19T12:00:00.000Z' },
        });
        expect(parsed.kind).toBe('task');
        expect(workerNextResponseSchema.safeParse({ kind: 'idle', message: 'no tasks' }).success).toBe(true);
        expect(workerNextResponseSchema.safeParse({ kind: 'something' }).success).toBe(false);
    });
});

describe('complete', () => {
    const base = {
        protocolVersion: '0.1.0',
        cliVersion: '0.1.0',
        workerId: 'w-1',
        taskId: 42,
    };

    it('counts the result limit in bytes, not characters', () => {
        // 'é' uses 2 bytes in UTF-8: string length is below the limit, but byte count is above it.
        const oversized = 'é'.repeat(RESULT_MAX_BYTES / 2 + 1);
        expect(taskCompleteRequestSchema.safeParse({ ...base, result: oversized }).success).toBe(false);
        expect(taskCompleteRequestSchema.safeParse({ ...base, result: 'ok' }).success).toBe(true);
    });

    it('handles response variants: accepted / rejected with an error list / noop', () => {
        expect(taskCompleteResponseSchema.safeParse({ kind: 'accepted', message: 'accepted' }).success).toBe(true);
        expect(taskCompleteResponseSchema.safeParse({ kind: 'rejected', errors: [] }).success).toBe(false);
        expect(
            taskCompleteResponseSchema.safeParse({ kind: 'rejected', errors: ['field x is missing'] }).success,
        ).toBe(true);
        expect(taskCompleteResponseSchema.safeParse({ kind: 'noop', message: 'already closed' }).success).toBe(true);
    });
});

describe('discovery manifest', () => {
    it('accepts a valid manifest and rejects an invalid port', () => {
        const manifest = {
            prKey: 'github-quillmart--quillmart--12345',
            port: 49152,
            pid: 999,
            token: 'secret',
            protocolVersion: '0.1.0',
            serverVersion: '0.1.0',
            createdAt: '2026-08-19T12:00:00.000Z',
        };
        expect(serverManifestSchema.parse(manifest)).toEqual(manifest);
        expect(serverManifestSchema.safeParse({ ...manifest, port: 0 }).success).toBe(false);
        expect(serverManifestSchema.safeParse({ ...manifest, port: 70000 }).success).toBe(false);
    });
});

describe('JSON schemas', () => {
    it('generates schemas from zod for every contract entity', () => {
        const schemas = generateJsonSchemas();
        for (const name of ['task', 'lease', 'workerNextResponse', 'taskCompleteRequest', 'serverManifest']) {
            const schema = schemas[name] as Record<string, unknown> | undefined;
            expect(schema, name).toBeDefined();
            expect(schema?.$schema, name).toContain('json-schema.org');
        }
    });
});
