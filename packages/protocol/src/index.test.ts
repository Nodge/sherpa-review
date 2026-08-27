import { describe, expect, it } from 'vitest';

import {
    commentDraftSchema,
    commentSchema,
    generateJsonSchemas,
    LONG_POLL_CEILING_SECONDS,
    PROTOCOL_VERSION,
    protocolVersionsCompatible,
    RESULT_MAX_BYTES,
    routeSectionResultSchema,
    routeSkeletonResultSchema,
    routeSnapshotSchema,
    serverManifestSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskSchema,
    threadSchema,
    workerNextRequestSchema,
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
        expect(taskSchema.safeParse({ ...validTask, type: 'chat' }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, attempt: 0 }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, instructions: '' }).success).toBe(false);
    });

    it('M2 generation types are valid', () => {
        expect(taskSchema.safeParse({ ...validTask, type: 'route.skeleton' }).success).toBe(true);
        expect(taskSchema.safeParse({ ...validTask, type: 'route.section' }).success).toBe(true);
    });

    it('waitSeconds in next: optional, integer, within sane bounds', () => {
        const base = { protocolVersion: '0.1.0', cliVersion: '0.1.0', workerId: 'w-1' };

        // Without the field, the server decides how long to wait (`LONG_POLL_DEFAULT_SECONDS`).
        expect(workerNextRequestSchema.safeParse(base).success).toBe(true);
        expect(workerNextRequestSchema.safeParse({ ...base, waitSeconds: 1 }).success).toBe(true);
        expect(
            workerNextRequestSchema.safeParse({ ...base, waitSeconds: LONG_POLL_CEILING_SECONDS }).success,
        ).toBe(true);

        expect(workerNextRequestSchema.safeParse({ ...base, waitSeconds: 0 }).success).toBe(false);
        expect(
            workerNextRequestSchema.safeParse({ ...base, waitSeconds: LONG_POLL_CEILING_SECONDS + 1 }).success,
        ).toBe(false);
        expect(workerNextRequestSchema.safeParse({ ...base, waitSeconds: 1.5 }).success).toBe(false);
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

describe('review domain', () => {
    const author = { login: 'alice', displayName: null, bot: false };
    const comment = (id: string, replies: unknown[] = []) => ({
        id,
        author,
        body: 'text',
        draft: false,
        createdAt: '2026-08-20T12:00:00.000Z',
        editedAt: null,
        replies,
    });

    it('accepts a thread as a tree with a deep branching reply chain', () => {
        const deep = comment('1', [comment('2', [comment('3', [comment('4')]), comment('5')])]);
        const thread = {
            id: '1',
            anchor: {
                fileId: 'eid:1:abc',
                path: 'src/index.ts',
                position: { side: 'new', line: 20, size: 11 },
            },
            resolved: false,
            resolvedBy: null,
            outdated: false,
            root: deep,
        };
        expect(threadSchema.parse(thread)).toEqual(thread);
    });

    it('fails closed: an invalid reply deep in the tree rejects the entire thread', () => {
        const broken = comment('1', [comment('2', [{ id: '3' }])]);
        expect(commentSchema.safeParse(broken).success).toBe(false);
    });

    it('accepts drafts with both fields null at PR level, or an inline anchor without a position for a file comment', () => {
        expect(commentDraftSchema.safeParse({ body: 'lgtm', parentId: null, anchor: null }).success).toBe(true);
        expect(
            commentDraftSchema.safeParse({
                body: 'question',
                parentId: null,
                anchor: { fileId: 'eid:1:abc', path: 'a.ts', position: null },
            }).success,
        ).toBe(true);
        expect(commentDraftSchema.safeParse({ body: '', parentId: null, anchor: null }).success).toBe(false);
    });
});

describe('route (M2)', () => {
    const skeleton = {
        summary: 'The PR switches the session cache to write-through.',
        stops: [
            { title: 'Heart of the change: write policy', tier: 'high', intent: 'cache.py, write lines' },
            { title: 'Configuration wiring', tier: 'low', intent: 'config.yaml' },
        ],
        tourOrder: [2, 1],
    };

    it('accepts a valid skeleton and rejects an invalid tier or empty plan', () => {
        expect(routeSkeletonResultSchema.parse(skeleton)).toEqual(skeleton);
        expect(
            routeSkeletonResultSchema.safeParse({
                ...skeleton,
                stops: [{ ...skeleton.stops[0], tier: 'other' }],
            }).success,
        ).toBe(false);
        expect(routeSkeletonResultSchema.safeParse({ ...skeleton, stops: [] }).success).toBe(false);
    });

    it('requires anchors in section results and accepts batches of multiple stops', () => {
        const fill = (planIndex: number) => ({
            planIndex,
            paragraph: 'What changed and its consequences.',
            anchors: [{ path: 'src/cache.py', side: 'new', start: 10, end: 24 }],
        });
        expect(routeSectionResultSchema.safeParse({ stops: [fill(1), fill(2)] }).success).toBe(true);
        expect(
            routeSectionResultSchema.safeParse({ stops: [{ ...fill(1), anchors: [] }] }).success,
        ).toBe(false);
    });

    it('accepts filled and unfilled snapshot stops and synthetic "Other"', () => {
        const snapshot = {
            snapshotId: 'snap-1',
            commit: '9f3c1ab',
            diffId: 'iter-3',
            createdAt: '2026-08-25T12:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'claude-opus-5' },
            summary: 'Summary.',
            stops: [
                {
                    id: 'stop-1',
                    planIndex: 1,
                    tier: 'high',
                    title: 'Heart of the change',
                    status: 'ready',
                    paragraph: 'Paragraph.',
                    bridge: 'Next comes the wiring.',
                    anchors: [
                        { fileId: 'f1', path: 'src/cache.py', side: 'new', start: 10, end: 24, collapsed: false },
                    ],
                    tests: [
                        {
                            kind: 'weakened',
                            text: 'Weakened timeout assertion',
                            anchor: { fileId: 'f2', path: 'tests/test_cache.py', line: 41 },
                        },
                    ],
                    droppedClaims: 1,
                    validationNotes: [],
                    provenance: null,
                },
                {
                    id: 'other',
                    planIndex: 2,
                    tier: 'other',
                    title: 'Other',
                    status: 'ready',
                    paragraph: null,
                    bridge: null,
                    anchors: [],
                    tests: [],
                    droppedClaims: 0,
                    validationNotes: [],
                    provenance: null,
                },
            ],
            tourOrder: ['stop-1', 'other'],
            contentHash: null,
        };
        expect(routeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    });
});

describe('JSON schemas', () => {
    it('generates schemas from zod for every contract entity', () => {
        const schemas = generateJsonSchemas();
        for (const name of [
            'task',
            'lease',
            'workerNextResponse',
            'taskCompleteRequest',
            'serverManifest',
            'routeSkeletonResult',
            'routeSectionResult',
            'routeSnapshot',
        ]) {
            const schema = schemas[name] as Record<string, unknown> | undefined;
            expect(schema, name).toBeDefined();
            expect(schema?.$schema, name).toContain('json-schema.org');
        }
    });
});
