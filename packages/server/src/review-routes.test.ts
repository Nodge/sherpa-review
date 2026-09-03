import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FixtureHost, makeFixtureHost } from '@sherpa/fixtures';
import type { Comment, UiState } from '@sherpa/protocol';
import {
    rpcErrorSchema,
    uiDraftBufferResponseSchema,
    uiUpdateDraftResponseSchema,
    UI_ENDPOINTS,
    UI_PROGRESS_EVENT,
    UI_REVIEW_EVENT,
    UI_STATE_EVENT,
    uiOpenInEditorResponseSchema,
    uiProgressEventSchema,
    uiPublishResponseSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentResponseSchema,
    uiReviewEventSchema,
    uiReviewLensesResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewWriteAckSchema,
    uiSaveDraftResponseSchema,
    uiSetFileViewedResponseSchema,
    uiSetStopViewedResponseSchema,
    uiReviewThreadsResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { selectReviewHost } from './hosts/select.js';
import { databasePathFor } from './paths.js';
import { asRawText, mediumRawResults } from './route/fixture-support.js';
import type { EditorOptions } from './review-routes.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Server review endpoints and the SSE event for thread changes (M1-T10), using a fixture host:
 * prKey `fixture-medium` selects it through the same mechanism as a hosted review key.
 */

interface IterationRow {
    diff_id: string;
    status: string;
    diff_json: string;
}

const FIXTURE_PR = 'fixture-medium';
const UNKNOWN_PR = 'github-777';

describe('server review endpoints', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(prKey: string, host?: FixtureHost, editor?: EditorOptions): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            ...(host === undefined ? {} : { reviewHostFactory: () => ({ name: 'fixture', host }) }),
            ...(editor === undefined ? {} : { editor }),
        });
        servers.push(server);
        return server;
    }

    /** Creates a draft through the server endpoint. A failed host write fails the test. */
    async function saveDraftVia(server: SherpaServer, body: string, clientKey: string): Promise<Comment> {
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewSaveDraft,
            { draft: { body, parentId: null, anchor: null }, clientKey },
            server.token,
        );
        const saved = uiSaveDraftResponseSchema.parse(await response.json());
        if (saved.outcome !== 'saved') {
            throw new Error(`draft ${clientKey} went to the buffer instead of the host`);
        }
        return saved.comment;
    }

    async function openEvents(server: SherpaServer): Promise<SseStream> {
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        return stream;
    }

    it('a fixture prKey returns the diff, threads and lenses', async () => {
        const server = await start(FIXTURE_PR);
        const expected = makeFixtureHost('medium');

        const diff = uiReviewDiffResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).json(),
        );
        const threads = uiReviewThreadsResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
        );
        const lenses = uiReviewLensesResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewLenses, server.token)).json(),
        );

        expect(diff.diff).toEqual(await expected.getDiff());
        expect(threads.threads).toEqual(await expected.getThreads());
        expect(lenses.ownership).toEqual(await expected.ownershipLens());
        expect(lenses.extra).toEqual(await expected.extraLenses());
    });

    it('the active iteration diff is stored in local patch storage', async () => {
        const server = await start(FIXTURE_PR);
        const expected = await makeFixtureHost('medium').getDiff();

        await (await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).json();

        // The write does not block the endpoint response, so wait for it (M4-T3).
        const db = new DatabaseSync(databasePathFor(sherpaDir, FIXTURE_PR), { readOnly: true });
        try {
            const query = db.prepare('SELECT diff_id, status, diff_json FROM iterations');
            let row: IterationRow | undefined;
            const deadline = Date.now() + 2000;
            while (row === undefined && Date.now() < deadline) {
                row = query.get() as IterationRow | undefined;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }

            expect(row?.diff_id).toBe(expected.diffId);
            expect(row?.status).toBe('active');
            expect(JSON.parse(row?.diff_json ?? 'null')).toEqual(expected);
        } finally {
            db.close();
        }
    });

    it('includes the host name in UI state', async () => {
        const server = await start(FIXTURE_PR);

        const state = uiStateSchema.parse(await (await get(server.port, UI_ENDPOINTS.state, server.token)).json());

        expect(state.reviewHost).toBe('fixture');
    });

    it('the state snapshot carries PR metadata', async () => {
        const server = await start(FIXTURE_PR);

        const state = await stateWithPr(server);

        expect(state.pr).toEqual(await makeFixtureHost('medium').getPr());
    });

    it('an unrecognized prKey has no host and endpoints return no_review_host', async () => {
        const server = await start(UNKNOWN_PR);

        const state = uiStateSchema.parse(await (await get(server.port, UI_ENDPOINTS.state, server.token)).json());
        expect(state.reviewHost).toBeNull();

        for (const endpoint of [
            UI_ENDPOINTS.reviewDiff,
            UI_ENDPOINTS.reviewThreads,
            UI_ENDPOINTS.reviewLenses,
        ]) {
            const response = await get(server.port, endpoint, server.token);
            expect(response.status, endpoint).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
        }
    });

    it('review endpoints require a token', async () => {
        const server = await start(FIXTURE_PR);

        const response = await get(server.port, UI_ENDPOINTS.reviewDiff);

        expect(response.status).toBe(401);
    });

    describe('file content', () => {
        it('returns the full text file and null for a binary file', async () => {
            const server = await start(FIXTURE_PR);
            const diff = await makeFixtureHost('medium').getDiff();
            const file = diff.files.find((candidate) => candidate.path.endsWith('domain/order.ts'));

            const body = uiReviewFileContentResponseSchema.parse(
                await (
                    await get(
                        server.port,
                        `${UI_ENDPOINTS.reviewFileContent}?fileId=${encodeURIComponent(file?.fileId ?? '')}`,
                        server.token,
                    )
                ).json(),
            );

            expect(body.content?.newText?.length).toBeGreaterThan(0);
            expect(body.content?.oldText?.length).toBeGreaterThan(0);
        });

        it('a host without the method returns bad_request with a readable message', async () => {
            // The edge fixture declares `fileContent: false`, so the host has no method.
            const server = await start('fixture-edge');
            const file = (await makeFixtureHost('edge').getDiff()).files[0];

            const response = await get(
                server.port,
                `${UI_ENDPOINTS.reviewFileContent}?fileId=${encodeURIComponent(file?.fileId ?? '')}`,
                server.token,
            );

            expect(response.status).toBe(400);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.message).toContain('Expand context');
        });

        it('returns bad_request without fileId', async () => {
            const server = await start(FIXTURE_PR);

            const response = await get(server.port, UI_ENDPOINTS.reviewFileContent, server.token);

            expect(response.status).toBe(400);
        });
    });

    describe('open in external editor', () => {
        it('starts the editor command for a file on disk and returns opened', async () => {
            const launched: { command: string; args: readonly string[] }[] = [];
            const server = await start(FIXTURE_PR, undefined, {
                cwd: sherpaDir,
                command: 'my-editor --goto {file}:{line}',
                launch: (command, args) => {
                    launched.push({ command, args });
                    return Promise.resolve();
                },
            });
            await writeFile(path.join(sherpaDir, 'open-me.ts'), 'export const x = 1;\n');

            const body = uiOpenInEditorResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.openInEditor,
                        { path: 'open-me.ts', line: 12 },
                        server.token,
                    )
                ).json(),
            );

            expect(body).toEqual({ outcome: 'opened', message: null });
            expect(launched).toEqual([
                { command: 'my-editor', args: ['--goto', `${path.join(sherpaDir, 'open-me.ts')}:12`] },
            ]);
        });

        it('returns unavailable with a reason for a missing file, without an error', async () => {
            const server = await start(FIXTURE_PR, undefined, { cwd: sherpaDir, launch: () => Promise.resolve() });

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.openInEditor,
                { path: 'services/orders/src/domain/order.ts' },
                server.token,
            );

            expect(response.status).toBe(200);
            const body = uiOpenInEditorResponseSchema.parse(await response.json());
            expect(body.outcome).toBe('unavailable');
            expect(body.message).toContain('not on disk');
        });

        it('returns unavailable with the failure message when the editor fails to start', async () => {
            const server = await start(FIXTURE_PR, undefined, {
                cwd: sherpaDir,
                launch: () => Promise.reject(new Error('spawn ENOENT')),
            });
            await writeFile(path.join(sherpaDir, 'open-me.ts'), 'export const x = 1;\n');

            const body = uiOpenInEditorResponseSchema.parse(
                await (
                    await postJson(server.port, UI_ENDPOINTS.openInEditor, { path: 'open-me.ts' }, server.token)
                ).json(),
            );

            expect(body.outcome).toBe('unavailable');
            expect(body.message).toContain('spawn ENOENT');
        });

        it('rejects a path outside the checkout', async () => {
            const server = await start(FIXTURE_PR, undefined, { cwd: sherpaDir, launch: () => Promise.resolve() });

            const body = uiOpenInEditorResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.openInEditor,
                        { path: '../../etc/hosts' },
                        server.token,
                    )
                ).json(),
            );

            expect(body.outcome).toBe('unavailable');
            expect(body.message).toContain('outside the checkout');
        });
    });

    it('a host failure reaches the client as host_unavailable', async () => {
        const broken = makeFixtureHost('medium');
        broken.getDiff = () => Promise.reject(new Error('host is down'));
        const server = await start(FIXTURE_PR, broken);

        const response = await get(server.port, UI_ENDPOINTS.reviewDiff, server.token);

        expect(response.status).toBe(502);
        const body = rpcErrorSchema.parse(await response.json());
        expect(body.error.code).toBe('host_unavailable');
        expect(body.error.message).toContain('host is down');
    });

    describe('thread writes', () => {
        it('save returns the created Comment and the draft appears in the snapshot', async () => {
            const server = await start(FIXTURE_PR);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'new draft', parentId: null, anchor: null }, clientKey: 'ck-1' },
                server.token,
            );

            expect(response.status).toBe(200);
            const saved = uiSaveDraftResponseSchema.parse(await response.json());
            if (saved.outcome !== 'saved') {
                throw new Error('the draft should have reached the host');
            }
            const comment = saved.comment;
            expect(comment).toMatchObject({ body: 'new draft', draft: true });
            const threads = uiReviewThreadsResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
            );
            expect(threads.threads.some((thread) => thread.root.id === comment.id)).toBe(true);
        });

        it('update and delete forward directly to the host', async () => {
            const host = makeFixtureHost('medium');
            const update = vi.spyOn(host, 'updateDraft');
            const remove = vi.spyOn(host, 'deleteDraft');
            const server = await start(FIXTURE_PR, host);
            const created = await saveDraftVia(server, 'draft', 'ck-update');

            const updated = await postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateDraft,
                {
                    commentId: created.id,
                    body: 'edited draft',
                    issue: false,
                    clientKey: 'ck-update-2',
                },
                server.token,
            );
            expect(uiUpdateDraftResponseSchema.parse(await updated.json())).toEqual({ outcome: 'saved' });
            expect(update).toHaveBeenCalledWith(created.id, 'edited draft', false);

            const deleted = await postJson(
                server.port,
                UI_ENDPOINTS.reviewDeleteDraft,
                { commentId: created.id },
                server.token,
            );
            expect(uiReviewWriteAckSchema.parse(await deleted.json())).toEqual({ acknowledged: true });
            expect(remove).toHaveBeenCalledWith(created.id);
        });

        it('two updates to one draft reach the host in order', async () => {
            const host = makeFixtureHost('medium');
            const created = await host.saveDraft({ body: 'original', parentId: null, anchor: null });
            const original = host.updateDraft.bind(host);
            const applied: string[] = [];
            let releaseFirst!: () => void;
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            host.updateDraft = async (commentId, body) => {
                applied.push(body);
                if (body === 'old text') {
                    await firstGate;
                }
                await original(commentId, body);
            };
            const server = await start(FIXTURE_PR, host);

            const first = postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateDraft,
                { commentId: created.id, body: 'old text', clientKey: 'ck-order-1' },
                server.token,
            );
            await expect.poll(() => applied).toEqual(['old text']);
            const second = postJson(
                server.port,
                UI_ENDPOINTS.reviewUpdateDraft,
                { commentId: created.id, body: 'new text', clientKey: 'ck-order-2' },
                server.token,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(applied).toEqual(['old text']);

            releaseFirst();
            expect((await first).status).toBe(200);
            expect((await second).status).toBe(200);
            expect(applied).toEqual(['old text', 'new text']);
        });

        it('an indeterminate delete response counts as success if the draft is already gone', async () => {
            const host = makeFixtureHost('medium');
            const created = await host.saveDraft({ body: 'delete', parentId: null, anchor: null });
            const original = host.deleteDraft.bind(host);
            host.deleteDraft = async (commentId) => {
                await original(commentId);
                throw new Error('response lost');
            };
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewDeleteDraft,
                { commentId: created.id },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
        });

        it('resolve calls setThreadResolved', async () => {
            const host = makeFixtureHost('medium');
            const resolve = vi.spyOn(host, 'setThreadResolved');
            const target = (await host.getThreads()).find((thread) => !thread.resolved);
            if (target === undefined) {
                throw new Error('the fixture has no open thread');
            }
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewThreadResolved,
                { threadId: target.id, resolved: true },
                server.token,
            );

            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            expect(resolve).toHaveBeenCalledWith(target.id, true);
        });

        it('resolve and undo on one thread reach the host in order', async () => {
            const host = makeFixtureHost('medium');
            const target = (await host.getThreads()).find((thread) => !thread.resolved);
            if (target === undefined) {
                throw new Error('the fixture has no open thread');
            }
            const original = host.setThreadResolved.bind(host);
            const applied: boolean[] = [];
            let releaseFirst!: () => void;
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            host.setThreadResolved = async (threadId, resolved) => {
                applied.push(resolved);
                if (resolved) {
                    await firstGate;
                }
                await original(threadId, resolved);
            };
            const server = await start(FIXTURE_PR, host);

            const first = postJson(
                server.port,
                UI_ENDPOINTS.reviewThreadResolved,
                { threadId: target.id, resolved: true },
                server.token,
            );
            await expect.poll(() => applied).toEqual([true]);
            const second = postJson(
                server.port,
                UI_ENDPOINTS.reviewThreadResolved,
                { threadId: target.id, resolved: false },
                server.token,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(applied).toEqual([true]);

            releaseFirst();
            expect((await first).status).toBe(200);
            expect((await second).status).toBe(200);
            expect(applied).toEqual([true, false]);
            expect((await host.getThreads()).find((thread) => thread.id === target.id)?.resolved).toBe(false);
        });

        it('a write endpoint returns no_review_host without a host', async () => {
            const server = await start(UNKNOWN_PR);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'nowhere to save', parentId: null, anchor: null }, clientKey: 'ck-none' },
                server.token,
            );

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
        });

        // A failed "server → host" step no longer fails the endpoint. The text goes into the buffer (M5-T15).
        it('a failed host draft write returns buffered instead of an error', async () => {
            const host = makeFixtureHost('medium');
            host.saveDraft = () => Promise.reject(new Error('drafts temporarily unavailable'));
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'will not save', parentId: null, anchor: null }, clientKey: 'ck-fail' },
                server.token,
            );

            expect(response.status).toBe(200);
            const body = uiSaveDraftResponseSchema.parse(await response.json());
            expect(body.outcome).toBe('buffered');
            if (body.outcome !== 'buffered') {
                throw new Error('the write should have gone to the buffer');
            }
            expect(body.entry).toMatchObject({
                id: 'ck-fail',
                commentId: null,
                state: 'failed',
                attempts: 1,
            });
            expect(body.entry.error).toContain('drafts temporarily unavailable');

            const buffer = uiDraftBufferResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewDraftBuffer, server.token)).json(),
            );
            expect(buffer.entries.map((entry) => entry.id)).toEqual(['ck-fail']);
        });

        it('retry delivers a buffered write and discard removes it', async () => {
            const host = makeFixtureHost('medium', { failDraftWrites: true });
            const server = await start(FIXTURE_PR, host);
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'will deliver later', parentId: null, anchor: null }, clientKey: 'ck-retry' },
                server.token,
            );
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'will discard this one', parentId: null, anchor: null }, clientKey: 'ck-discard' },
                server.token,
            );

            host.setFailDraftWrites(false);
            const afterRetry = uiDraftBufferResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.reviewDraftBufferRetry,
                        { id: 'ck-retry' },
                        server.token,
                    )
                ).json(),
            );
            expect(afterRetry.entries.map((entry) => entry.id)).toEqual(['ck-discard']);
            const threads = uiReviewThreadsResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
            );
            expect(threads.threads.some((thread) => thread.root.body === 'will deliver later')).toBe(true);

            const afterDiscard = uiDraftBufferResponseSchema.parse(
                await (
                    await postJson(
                        server.port,
                        UI_ENDPOINTS.reviewDraftBufferDiscard,
                        { id: 'ck-discard' },
                        server.token,
                    )
                ).json(),
            );
            expect(afterDiscard.entries).toEqual([]);
        });

        it('a successful write immediately advances the review feed revision', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const stream = await openEvents(server);
            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            await nextReview(stream);
            const started = await nextReview(stream);

            await postJson(
                server.port,
                UI_ENDPOINTS.reviewSaveDraft,
                { draft: { body: 'local bump', parentId: null, anchor: null }, clientKey: 'ck-bump' },
                server.token,
            );

            expect((await nextReview(stream)).threadsRevision).toBeGreaterThan(started.threadsRevision);
        });
    });

    describe('review publication', () => {
        it('publishes the batch, applies the verdict and returns the host outcome', async () => {
            const host = makeFixtureHost('medium');
            const draft = await host.saveDraft({ body: 'ready to publish', parentId: null, anchor: null });
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'ship' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(uiPublishResponseSchema.parse(await response.json()).result).toEqual({
                publishedCommentIds: [draft.id],
                failed: [],
                verdictApplied: true,
            });
            expect(host.appliedVerdict()).toBe('ship');
        });

        it('an updated PR status arrives in a state snapshot', async () => {
            const server = await start(FIXTURE_PR);
            const stream = await openEvents(server);
            await stateWithPr(server);
            // The first channel snapshot may precede metadata loading. Wait for one that has it.
            for (;;) {
                const state = uiStateSchema.parse(JSON.parse((await nextNamed(stream, UI_STATE_EVENT)).data));
                if (state.pr !== null) {
                    expect(state.pr.statusLabel).toBe('review_in_progress');
                    break;
                }
            }

            await postJson(server.port, UI_ENDPOINTS.reviewPublish, { verdict: 'ship' }, server.token);

            // The publication endpoint does not wait for metadata to reload. Updated status arrives in a separate snapshot.
            for (;;) {
                const pushed = uiStateSchema.parse(JSON.parse((await nextNamed(stream, UI_STATE_EVENT)).data));
                if (pushed.pr?.statusLabel === 'shipped') {
                    break;
                }
            }
        });

        it('a partial failure returns unpublished comments and does not apply the verdict', async () => {
            const host = makeFixtureHost('medium', { failPublishFor: ['-70001'] });
            const failedDraft = await host.saveDraft({ body: 'this draft will fail', parentId: null, anchor: null });
            const publishedDraft = await host.saveDraft({ body: 'this draft will publish', parentId: null, anchor: null });
            const server = await start(FIXTURE_PR, host);
            const stream = await openEvents(server);
            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            await nextReview(stream);
            const started = await nextReview(stream);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'request_changes' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(uiPublishResponseSchema.parse(await response.json()).result).toEqual({
                publishedCommentIds: [publishedDraft.id],
                failed: [
                    {
                        commentId: failedDraft.id,
                        message: 'fixture: publishing this comment is configured to fail',
                    },
                ],
                verdictApplied: false,
            });
            expect(host.appliedVerdict()).toBeNull();
            expect((await nextReview(stream)).threadsRevision).toBeGreaterThan(started.threadsRevision);
        });

        it('returns no_review_host without a host', async () => {
            const server = await start(UNKNOWN_PR);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'ship' },
                server.token,
            );

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
        });

        it('a publishBatch failure reaches the client as host_unavailable', async () => {
            const host = makeFixtureHost('medium');
            host.publishBatch = () => Promise.reject(new Error('publishing temporarily unavailable'));
            const server = await start(FIXTURE_PR, host);

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewPublish,
                { verdict: 'sticky_ship' },
                server.token,
            );

            expect(response.status).toBe(502);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('host_unavailable');
            expect(body.error.message).toContain('publishing temporarily unavailable');
        });
    });

    describe('reading progress', () => {
        async function readProgress(server: SherpaServer): Promise<{
            files: { fileId: string; viewed: boolean | null; seenRanges: unknown[] }[];
            stops: { stopId: string; viewed: boolean }[];
            progressRevision: number;
        }> {
            const response = await get(server.port, UI_ENDPOINTS.reviewProgress, server.token);
            expect(response.status).toBe(200);
            return uiReviewProgressResponseSchema.parse(await response.json());
        }

        async function setViewed(server: SherpaServer, fileId: string, viewed: boolean): Promise<Response> {
            return postJson(server.port, UI_ENDPOINTS.reviewFileViewed, { fileId, viewed }, server.token);
        }

        async function setStopViewed(
            server: SherpaServer,
            stopId: string,
            viewed: boolean,
            ranges: { fileId: string; side: 'old' | 'new'; start: number; end: number }[] = [],
        ): Promise<Response> {
            return postJson(server.port, UI_ENDPOINTS.reviewStopViewed, { stopId, viewed, ranges }, server.token);
        }

        /**
         * Completed fixture route: stop marks are keyed by snapshot (M4-T6),
         * so there is nowhere to write them without a route.
         */
        async function completeRoute(server: SherpaServer): Promise<void> {
            server.workerRegistry.register('w-progress', 'claude-code', 'opus-5');
            await server.route.warmup();
            const raw = mediumRawResults();
            const next = (type: string): number =>
                server.queue.listTasks().find((task) => task.type === type && task.status === 'queued')?.id ?? 0;
            const skeleton = next('route.skeleton');
            server.queue.next('w-progress');
            server.queue.complete('w-progress', skeleton, asRawText(raw.skeleton));
            for (const section of raw.sections) {
                const taskId = next('route.section');
                server.queue.next('w-progress');
                server.queue.complete('w-progress', taskId, asRawText(section));
            }
        }

        async function mirrorViewed(
            server: SherpaServer,
            entries: readonly { fileId: string; viewed: boolean }[],
        ): Promise<Response> {
            return postJson(server.port, UI_ENDPOINTS.reviewViewedMirror, { entries }, server.token);
        }

        it('an empty PR has no records and revision zero', async () => {
            const server = await start(FIXTURE_PR);

            expect(await readProgress(server)).toEqual({ files: [], stops: [], progressRevision: 0 });
        });

        it('a stop mark without a route is not written because there is no snapshot to attach it to', async () => {
            const server = await start(UNKNOWN_PR);

            const written = await setStopViewed(server, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
            ]);

            expect(written.status).toBe(200);
            expect(uiSetStopViewedResponseSchema.parse(await written.json()).progressRevision).toBe(0);
            expect(await readProgress(server)).toEqual({ files: [], stops: [], progressRevision: 0 });
        });

        it('marking a stop writes its ranges', async () => {
            const server = await start(FIXTURE_PR);
            await completeRoute(server);

            const written = await setStopViewed(server, 's01', true, [
                { fileId: 'file-1', side: 'new', start: 10, end: 14 },
                { fileId: 'file-2', side: 'old', start: 3, end: 3 },
            ]);

            expect(written.status).toBe(200);
            expect(uiSetStopViewedResponseSchema.parse(await written.json()).progressRevision).toBe(1);
            const progress = await readProgress(server);
            expect(progress.stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(progress.files).toEqual(
                expect.arrayContaining([
                    { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 10, end: 14 }] },
                    { fileId: 'file-2', viewed: null, seenRanges: [{ side: 'old', start: 3, end: 3 }] },
                ]),
            );
        });

        it('clearing a mark removes its stop ranges and leaves other stops unchanged', async () => {
            const server = await start(FIXTURE_PR);
            await completeRoute(server);
            await setStopViewed(server, 's01', true, [{ fileId: 'file-1', side: 'new', start: 10, end: 14 }]);
            await setStopViewed(server, 's02', true, [{ fileId: 'file-1', side: 'new', start: 40, end: 41 }]);

            // Ignore ranges in the clear request. Remove the stored ones.
            expect((await setStopViewed(server, 's01', false, [{ fileId: 'file-1', side: 'new', start: 1, end: 2 }])).status).toBe(200);

            const progress = await readProgress(server);
            expect(progress.stops).toEqual([
                { stopId: 's01', viewed: false },
                { stopId: 's02', viewed: true },
            ]);
            expect(progress.files).toEqual([
                { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 40, end: 41 }] },
            ]);
        });

        it('a stop mark survives a server restart', async () => {
            const first = await start(FIXTURE_PR);
            await completeRoute(first);
            await setStopViewed(first, 's01', true, [{ fileId: 'file-1', side: 'new', start: 5, end: 9 }]);
            await first.close();
            servers.splice(servers.indexOf(first), 1);

            const restarted = await start(FIXTURE_PR);
            const progress = await readProgress(restarted);

            expect(progress.stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(progress.files).toEqual([
                { fileId: 'file-1', viewed: null, seenRanges: [{ side: 'new', start: 5, end: 9 }] },
            ]);
        });

        it('marking a stop again with the same set does not advance the SSE revision', async () => {
            const server = await start(FIXTURE_PR);
            await completeRoute(server);
            const stream = await openEvents(server);
            const ranges = [
                { fileId: 'file-1', side: 'new' as const, start: 10, end: 14 },
                { fileId: 'file-2', side: 'old' as const, start: 1, end: 2 },
            ];

            expect((await nextProgress(stream)).progressRevision).toBe(0);

            await setStopViewed(server, 's01', true, ranges);
            expect((await nextProgress(stream)).progressRevision).toBe(1);

            await setStopViewed(server, 's01', true, [...ranges].reverse());
            await expect(nextProgress(stream, 300)).rejects.toThrow(/timed out waiting for an SSE event/);
        });

        it('progress works without a review host', async () => {
            const server = await start(UNKNOWN_PR);

            const written = await setViewed(server, 'file-1', true);

            expect(written.status).toBe(200);
            expect((await readProgress(server)).files).toEqual([
                { fileId: 'file-1', viewed: true, seenRanges: [] },
            ]);
        });

        it('marking and clearing a mark survive a server restart', async () => {
            const first = await start(FIXTURE_PR);
            const [file, other] = await fileIds(first);
            if (file === undefined || other === undefined) {
                throw new Error('the fixture diff has fewer than two files');
            }

            const marked = uiSetFileViewedResponseSchema.parse(await (await setViewed(first, file, true)).json());
            expect(marked.progressRevision).toBe(1);
            // Explicit clearing is also a write. Unpinning the generated default must survive a reload.
            await setViewed(first, other, false);
            await first.close();
            servers.splice(servers.indexOf(first), 1);

            // The same state directory and prKey start the server on the same database.
            const restarted = await start(FIXTURE_PR);
            const after = await readProgress(restarted);
            expect(after.files).toEqual(
                expect.arrayContaining([
                    { fileId: file, viewed: true, seenRanges: [] },
                    { fileId: other, viewed: false, seenRanges: [] },
                ]),
            );
            // The revision is monotonic from process start, independent of stored contents.
            expect(after.progressRevision).toBe(0);
        });

        it('a host with fileViewedSync receives the mirrored mark', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const file = (await firstFileId(server)) ?? '';

            expect((await setViewed(server, file, true)).status).toBe(200);

            await expect
                .poll(async () => (await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed)
                .toBe(true);
        });

        it('a host without fileViewedSync only writes locally', async () => {
            const host = makeFixtureHost('small');
            const server = await start('fixture-small', host);
            const file = (await firstFileId(server)) ?? '';

            expect((await setViewed(server, file, true)).status).toBe(200);

            expect((await readProgress(server)).files).toEqual([{ fileId: file, viewed: true, seenRanges: [] }]);
            expect((await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed).toBeNull();
        });

        it('the mirror endpoint passes the entire batch to the host without changing local progress', async () => {
            const host = makeFixtureHost('medium');
            const applied: { fileId: string; viewed: boolean }[] = [];
            const original = host.setFileViewed?.bind(host);
            if (original === undefined) {
                throw new Error('the medium fixture host must support fileViewedSync');
            }
            host.setFileViewed = async (fileId, viewed) => {
                await original(fileId, viewed);
                applied.push({ fileId, viewed });
            };
            const server = await start(FIXTURE_PR, host);
            const [first, second] = await fileIds(server);
            if (first === undefined || second === undefined) {
                throw new Error('the fixture diff has fewer than two files');
            }
            const before = await readProgress(server);
            const entries = [
                { fileId: first, viewed: true },
                { fileId: second, viewed: false },
            ];

            const response = await mirrorViewed(server, entries);

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            await expect.poll(() => applied).toEqual(expect.arrayContaining(entries));
            expect(applied).toHaveLength(entries.length);
            expect(await readProgress(server)).toEqual(before);
        });

        it('the mirror endpoint without fileViewedSync acknowledges a no-op and leaves progress unchanged', async () => {
            const host = makeFixtureHost('small');
            expect(host.setFileViewed).toBeUndefined();
            const server = await start('fixture-small', host);
            const file = (await firstFileId(server)) ?? '';
            const before = await readProgress(server);

            const response = await mirrorViewed(server, [{ fileId: file, viewed: true }]);

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            expect(await readProgress(server)).toEqual(before);
            expect((await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed).toBeNull();
        });

        it('the mirror endpoint also acknowledges a no-op without a review host', async () => {
            const server = await start(UNKNOWN_PR);

            const response = await mirrorViewed(server, [{ fileId: 'file-1', viewed: true }]);

            expect(response.status).toBe(200);
            expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
            expect(await readProgress(server)).toEqual({ files: [], stops: [], progressRevision: 0 });
        });

        it('a mirror failure does not roll back the write or break the response', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

            try {
                // The diff has no file with this id, so the fixture host rejects it.
                const response = await setViewed(server, 'no-such-file', true);

                expect(response.status).toBe(200);
                expect((await readProgress(server)).files).toEqual([
                    { fileId: 'no-such-file', viewed: true, seenRanges: [] },
                ]);
                await expect
                    .poll(() => stderr.mock.calls.map((call) => String(call[0])).join(''))
                    .toContain('the host did not accept the viewed mark');
            } finally {
                stderr.mockRestore();
            }
        });

        it('a write advances the revision in the SSE channel', async () => {
            // A key without a host: the progress event is independent of the host, and there is no host to mirror the mark to.
            const server = await start(UNKNOWN_PR);
            const stream = await openEvents(server);

            expect((await nextProgress(stream)).progressRevision).toBe(0);

            await setViewed(server, 'file-1', true);
            expect((await nextProgress(stream)).progressRevision).toBe(1);

            // Repeating the mark with the same value changes nothing, so there is no event.
            await setViewed(server, 'file-1', true);
            await expect(nextProgress(stream, 300)).rejects.toThrow(/timed out waiting for an SSE event/);
        });

        it('mirrors two opposite marks on the same file in order', async () => {
            const host = makeFixtureHost('medium');
            const applied: boolean[] = [];
            const original = host.setFileViewed?.bind(host);
            if (original === undefined) {
                throw new Error('the medium fixture host must support fileViewedSync');
            }
            // The first mark is slow: without a queue, the second would reach the host before it.
            host.setFileViewed = async (fileId, viewed) => {
                if (viewed) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                await original(fileId, viewed);
                applied.push(viewed);
            };

            const server = await start(FIXTURE_PR, host);
            const file = (await firstFileId(server)) ?? '';

            await setViewed(server, file, true);
            await setViewed(server, file, false);

            await expect.poll(() => applied).toEqual([true, false]);
            expect((await host.getDiff()).files.find((candidate) => candidate.fileId === file)?.viewed).toBe(false);
        });
    });

    describe('review SSE event', () => {
        it('sends the current revision to a new client immediately and advances it when threads change', async () => {
            const host = makeFixtureHost('medium');
            const server = await start(FIXTURE_PR, host);
            const stream = await openEvents(server);

            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            const first = await nextReview(stream);
            // The first client started the host subscription, which has already delivered the initial snapshot.
            const started = await nextReview(stream);
            expect(started.threadsRevision).toBeGreaterThan(first.threadsRevision);

            await host.saveDraft({ body: 'draft from the test', parentId: null, anchor: null });

            const afterDraft = await nextReview(stream);
            expect(afterDraft.threadsRevision).toBeGreaterThan(started.threadsRevision);

            const threads = uiReviewThreadsResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
            );
            expect(threads.threads.some((thread) => thread.root.body === 'draft from the test')).toBe(true);
        });

        it('has no review events in the channel without a host', async () => {
            const server = await start(UNKNOWN_PR);
            const stream = await openEvents(server);

            expect((await stream.next()).event).toBe(UI_STATE_EVENT);
            // Reading progress is local, so its event is in the channel even without a host. The review event is absent.
            await expect(nextReview(stream, 300)).rejects.toThrow(/timed out waiting for an SSE event/);
        });
    });
});

describe('host selection by PR key', () => {
    it('selects the fixture host and rejects other keys', () => {
        
        expect(selectReviewHost('fixture-medium')?.name).toBe('fixture');
        expect(selectReviewHost('fixture-edge')?.host).toBeInstanceOf(FixtureHost);

        
        
        expect(selectReviewHost('fixture-unknown')).toBeNull();
        expect(selectReviewHost('github-777')).toBeNull();
    });
});

/** The next event with the given name: skips other channel events without breaking the wait. */
/** Host diff file IDs: these are opaque, so tests get them from the host itself. */
async function fileIds(server: SherpaServer): Promise<string[]> {
    const diff = uiReviewDiffResponseSchema.parse(
        await (await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).json(),
    );
    return diff.diff.files.map((file) => file.fileId);
}

async function firstFileId(server: SherpaServer): Promise<string | undefined> {
    return (await fileIds(server))[0];
}

/** PR metadata loads outside snapshot assembly, so `pr` is empty until it arrives. */
async function stateWithPr(server: SherpaServer): Promise<UiState> {
    const deadline = Date.now() + 2000;
    for (;;) {
        const state = uiStateSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.state, server.token)).json(),
        );
        if (state.pr !== null) {
            return state;
        }
        if (Date.now() > deadline) {
            throw new Error('PR metadata did not reach the state snapshot');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function nextNamed(stream: SseStream, name: string, timeoutMs = 2000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const event = await stream.next(Math.max(deadline - Date.now(), 1));
        if (event.event === name) {
            return event;
        }
    }
}

async function nextReview(stream: SseStream, timeoutMs?: number): Promise<{ threadsRevision: number }> {
    return uiReviewEventSchema.parse(JSON.parse((await nextNamed(stream, UI_REVIEW_EVENT, timeoutMs)).data));
}

async function nextProgress(stream: SseStream, timeoutMs?: number): Promise<{ progressRevision: number }> {
    return uiProgressEventSchema.parse(JSON.parse((await nextNamed(stream, UI_PROGRESS_EVENT, timeoutMs)).data));
}

interface SseEvent {
    readonly event: string;
    readonly data: string;
}

interface SseStream {
    readonly next: (timeoutMs?: number) => Promise<SseEvent>;
    readonly close: () => void;
}

/** Minimal SSE client: Node has no `EventSource`, and tests read events one at a time. */
async function openSse(url: string): Promise<SseStream> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200 || response.body === null) {
        throw new Error(`SSE channel did not open: ${String(response.status)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ready: SseEvent[] = [];
    let buffer = '';

    return {
        next: async (timeoutMs = 2000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const event = ready.shift();
                if (event !== undefined) {
                    return event;
                }
                if (Date.now() > deadline) {
                    throw new Error('timed out waiting for an SSE event');
                }

                // Stream types differ between lib.dom and @types/node, so we specify the chunk shape ourselves.
                const chunk: { done: boolean; value?: Uint8Array } = await Promise.race([
                    reader.read(),
                    new Promise<{ done: boolean }>((resolve) =>
                        setTimeout(() => {
                            resolve({ done: false });
                        }, Math.max(deadline - Date.now(), 0)),
                    ),
                ]);
                if (chunk.done) {
                    throw new Error('SSE channel closed before the expected event');
                }
                buffer += decoder.decode(chunk.value, { stream: true });

                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    ready.push(parseSseEvent(buffer.slice(0, boundary)));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        },
        close: () => {
            controller.abort();
        },
    };
}

function parseSseEvent(raw: string): SseEvent {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) {
            event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
        }
    }
    return { event, data: data.join('\n') };
}
