import { describe, expect, it } from 'vitest';

import {
    agentNoteSchema,
    chatAnchorSchema,
    chatExchangeSchema,
    commentDraftSchema,
    commentSchema,
    DISTRIBUTION_WHATS_NEW_MAX_CHARS,
    distributionVersionSchema,
    generateJsonSchemas,
    iterationSchema,
    lensZoneSchema,
    LONG_POLL_CEILING_SECONDS,
    PROTOCOL_VERSION,
    protocolVersionsCompatible,
    RESULT_MAX_BYTES,
    routeProvenanceSchema,
    routeSectionResultSchema,
    routeSkeletonResultSchema,
    routeSnapshotSchema,
    serverManifestSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskSchema,
    threadSchema,
    uiChatAskRequestSchema,
    uiDevUpdateAvailableRequestSchema,
    uiReviewDiffRequestSchema,
    uiRouteStaleSchema,
    uiSettingsPatchSchema,
    uiSettingsSchema,
    uiSnapshotSummarySchema,
    uiUpdateSchema,
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
        expect(taskSchema.safeParse({ ...validTask, type: 'regenerate.skeleton' }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, attempt: 0 }).success).toBe(false);
        expect(taskSchema.safeParse({ ...validTask, instructions: '' }).success).toBe(false);
    });

    it('M2 generative types and chat (M3) are valid', () => {
        expect(taskSchema.safeParse({ ...validTask, type: 'route.skeleton' }).success).toBe(true);
        expect(taskSchema.safeParse({ ...validTask, type: 'route.section' }).success).toBe(true);
        expect(taskSchema.safeParse({ ...validTask, type: 'chat' }).success).toBe(true);
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
        issue: null,
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
            pinnedTo: { diffId: 'iter-2', commit: '9f3c1ab' },
            root: deep,
        };
        expect(threadSchema.parse(thread)).toEqual(thread);
        expect(threadSchema.safeParse({ ...thread, pinnedTo: null }).success).toBe(true);
        expect(threadSchema.safeParse({ ...thread, pinnedTo: { diffId: 'iter-2' } }).success).toBe(false);
    });

    it('accepts exactly three iteration statuses, including server-set gone', () => {
        const iteration = {
            diffId: 'iter-2',
            baseCommit: 'a71d4e2',
            headCommit: '9f3c1ab',
            createdAt: '2026-09-02T10:00:00.000Z',
            status: 'active',
        };
        expect(iterationSchema.parse(iteration)).toEqual(iteration);
        expect(iterationSchema.safeParse({ ...iteration, status: 'gone' }).success).toBe(true);
        expect(iterationSchema.safeParse({ ...iteration, status: 'stale' }).success).toBe(false);
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

    it('requires a boundary and at least one path for an ownership zone', () => {
        const zone = {
            path: 'services/orders/src/domain',
            mine: true,
            owner: 'checkout-domain',
            paths: ['services/orders/src/domain/order.ts'],
        };
        expect(lensZoneSchema.parse(zone)).toEqual(zone);
        expect(lensZoneSchema.safeParse({ ...zone, path: '' }).success).toBe(false);
        expect(lensZoneSchema.safeParse({ ...zone, paths: [] }).success).toBe(false);
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
            baseCommit: 'a71d4e2',
            diffId: 'iter-3',
            createdAt: '2026-08-25T12:00:00.000Z',
            provenance: { harness: 'claude-code', model: 'claude-opus-5', locale: 'ru' },
            previousSnapshotId: 'snap-0',
            carried: { kept: 3, total: 4 },
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
                    change: { kind: 'changed', reason: 'The author replied in the thread and rewrote retry.', threadIds: ['1'] },
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
                    change: null,
                },
            ],
            tourOrder: ['stop-1', 'other'],
            contentHash: null,
        };
        expect(routeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
        expect(
            routeSnapshotSchema.safeParse({ ...snapshot, previousSnapshotId: null, carried: null }).success,
        ).toBe(true);
    });

    it('allows optional change explanations and causal threads in section results after a push', () => {
        const stop = {
            planIndex: 1,
            paragraph: 'What changed.',
            anchors: [{ path: 'src/cache.py', side: 'new', start: 10, end: 24 }],
            changeReason: 'The author rewrote retry after the thread.',
            changeThreadIds: ['1', '2'],
        };
        expect(routeSectionResultSchema.safeParse({ stops: [stop] }).success).toBe(true);
        expect(routeSectionResultSchema.safeParse({ stops: [{ ...stop, changeReason: '' }] }).success).toBe(false);
    });
});

describe('chat and notes (M3)', () => {
    const anchor = { diffId: 'iter-3', fileId: 'f1', path: 'src/order_service.py', side: 'new', start: 148, end: 151 };
    const exchange = {
        id: 1,
        question: 'why is the cache invalidated before the write here?',
        anchor,
        status: 'done',
        taskId: 42,
        answer: 'The order is preserved from the old implementation: …',
        progressText: null,
        error: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-01T12:01:00.000Z',
    };

    it('exchange: with and without an anchor (Ask AI about the PR), all lifecycle statuses', () => {
        // Response language (M5-T4) is absent in pre-M5 exchanges, so the schema supplies `null`.
        expect(chatExchangeSchema.parse(exchange)).toEqual({ ...exchange, locale: null });
        expect(chatExchangeSchema.parse({ ...exchange, locale: 'en' }).locale).toBe('en');
        expect(chatExchangeSchema.safeParse({ ...exchange, locale: 'de' }).success).toBe(false);
        expect(chatExchangeSchema.safeParse({ ...exchange, anchor: null }).success).toBe(true);
        expect(chatExchangeSchema.safeParse({ ...exchange, taskId: null }).success).toBe(true);
        for (const status of ['queued', 'running', 'done', 'failed', 'cancelled']) {
            expect(chatExchangeSchema.safeParse({ ...exchange, status }).success).toBe(true);
        }
        expect(chatExchangeSchema.safeParse({ ...exchange, status: 'streaming' }).success).toBe(false);
        expect(chatExchangeSchema.safeParse({ ...exchange, question: '' }).success).toBe(false);
    });

    it('note: anchor is required, original anchor is stored separately, commit allows null', () => {
        const note = {
            id: 7,
            exchangeId: 1,
            anchor,
            text: 'The order is preserved from the old implementation: …',
            lostAnchor: false,
            origin: { commit: null, anchor },
            createdAt: '2026-09-01T12:01:00.000Z',
        };
        expect(agentNoteSchema.parse(note)).toEqual(note);
        expect(agentNoteSchema.safeParse({ ...note, anchor: null }).success).toBe(false);
        expect(agentNoteSchema.safeParse({ ...note, text: '' }).success).toBe(false);
        expect(agentNoteSchema.safeParse({ ...note, origin: { commit: '9f3c1ab' } }).success).toBe(false);
    });

    it('ask: rejects empty and overlong questions, anchor and its diffId are optional', () => {
        const { diffId: _diffId, ...anchorWithoutDiff } = anchor;
        expect(uiChatAskRequestSchema.safeParse({ text: 'question' }).success).toBe(true);
        expect(uiChatAskRequestSchema.safeParse({ text: 'question', anchor }).success).toBe(true);
        expect(uiChatAskRequestSchema.safeParse({ text: 'question', anchor: anchorWithoutDiff }).success).toBe(true);
        expect(chatAnchorSchema.safeParse(anchorWithoutDiff).success).toBe(false);
        expect(uiChatAskRequestSchema.safeParse({ text: '' }).success).toBe(false);
        expect(uiChatAskRequestSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    });
});

describe('iterations and snapshots in the UI contract (M4)', () => {
    it('diff selection: no parameters, by iteration or slice, rejects half a slice and mixed modes', () => {
        expect(uiReviewDiffRequestSchema.safeParse({}).success).toBe(true);
        expect(uiReviewDiffRequestSchema.safeParse({ diffId: 'iter-2' }).success).toBe(true);
        expect(uiReviewDiffRequestSchema.safeParse({ base: 'iter-1', head: 'iter-2' }).success).toBe(true);
        expect(uiReviewDiffRequestSchema.safeParse({ base: 'iter-1' }).success).toBe(false);
        expect(uiReviewDiffRequestSchema.safeParse({ diffId: 'iter-2', base: 'iter-1', head: 'iter-2' }).success).toBe(
            false,
        );
    });

    it('stale route: at least one new iteration', () => {
        const stale = {
            routeCommit: '9f3c1ab',
            prCommit: 'c0ffee1',
            prDiffId: 'iter-4',
            newIterations: 1,
            affectedStopIds: ['stop-2', 'stop-3'],
        };
        expect(uiRouteStaleSchema.parse(stale)).toEqual(stale);
        expect(uiRouteStaleSchema.safeParse({ ...stale, newIterations: 0 }).success).toBe(false);
    });

    it('snapshot summary: accepts three statuses, rejects the rest', () => {
        const summary = {
            snapshotId: 'snap-1',
            diffId: 'iter-3',
            commit: '9f3c1ab',
            baseCommit: 'a71d4e2',
            createdAt: '2026-08-25T12:00:00.000Z',
            provenance: { harness: 'claude-code', model: null },
            previousSnapshotId: null,
            status: 'current',
        };
        for (const status of ['current', 'stale', 'gone']) {
            expect(uiSnapshotSummarySchema.safeParse({ ...summary, status }).success).toBe(true);
        }
        expect(uiSnapshotSummarySchema.safeParse({ ...summary, status: 'previous' }).success).toBe(false);
    });
});

describe('M5 contracts (locale, onboarding, update)', () => {
    it('settings: new fields get defaults, patches have no defaults and replace fields as a whole', () => {
        expect(uiSettingsSchema.parse({})).toMatchObject({
            locale: 'auto',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
        expect(uiSettingsSchema.safeParse({ locale: 'de' }).success).toBe(false);
        expect(uiSettingsSchema.safeParse({ onboarding: { completedAt: null, step: -1 } }).success).toBe(false);
        expect(uiSettingsSchema.safeParse({ updates: { dismissedVersion: 'latest' } }).success).toBe(false);

        // A single-field patch supplies no defaults for other fields, or "leave unchanged" would become "reset".
        expect(uiSettingsPatchSchema.parse({ locale: 'en' })).toEqual({ locale: 'en' });
        expect(uiSettingsPatchSchema.safeParse({ onboarding: { step: 3 } }).success).toBe(false);
    });

    it('provenance: locale is optional on input (old snapshots) and null on output', () => {
        expect(routeProvenanceSchema.parse({ harness: 'claude-code', model: null })).toEqual({
            harness: 'claude-code',
            model: null,
            locale: null,
        });
        expect(routeProvenanceSchema.safeParse({ harness: null, model: null, locale: 'fr' }).success).toBe(false);
    });

    it('version.json: release fields are nullable, whatsNew is bounded', () => {
        const built = { version: '0.5.0', builtFrom: 'b1e4515-dirty', releasedAt: null, whatsNew: null };
        expect(distributionVersionSchema.parse(built)).toEqual(built);
        expect(
            distributionVersionSchema.safeParse({ ...built, whatsNew: 'x'.repeat(DISTRIBUTION_WHATS_NEW_MAX_CHARS + 1) })
                .success,
        ).toBe(false);
        expect(distributionVersionSchema.safeParse({ ...built, version: '0.5' }).success).toBe(false);
    });

    it('snapshot update: checkout installation has a command, a copy has none', () => {
        const update = {
            current: '0.4.0',
            latest: '0.5.0',
            releasedAt: '2026-09-10T10:00:00.000Z',
            whatsNew: 'Onboarding and English UI',
            
        };
        expect(uiUpdateSchema.parse(update)).toEqual(update);
        expect(
            uiUpdateSchema.safeParse({ ...update, install: { kind: 'copy', dir: '/opt/sherpa', command: null } }).success,
        ).toBe(true);
        expect(uiUpdateSchema.safeParse({ ...update, install: { kind: 'zip', dir: '/opt', command: null } }).success).toBe(
            false,
        );
        expect(
            uiDevUpdateAvailableRequestSchema.safeParse({ version: '0.5.0', releasedAt: null, whatsNew: null }).success,
        ).toBe(true);
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
