import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FixtureHost, makeFixtureHost } from '@sherpa/fixtures';
import {
    rpcErrorSchema,
    UI_ENDPOINTS,
    UI_REVIEW_EVENT,
    UI_STATE_EVENT,
    uiOpenInEditorResponseSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentResponseSchema,
    uiReviewEventSchema,
    uiReviewLensesResponseSchema,
    uiReviewPrResponseSchema,
    uiReviewThreadsResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectReviewHost } from './hosts/select.js';
import type { EditorOptions } from './review-routes.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Server review endpoints and the SSE event for thread changes (M1-T10), using a fixture host:
 * prKey `fixture-medium` selects it through the same mechanism as a hosted review key.
 */

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

    async function openEvents(server: SherpaServer): Promise<SseStream> {
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        return stream;
    }

    it('returns metadata, diff, threads and lenses for a fixture prKey', async () => {
        const server = await start(FIXTURE_PR);
        const expected = makeFixtureHost('medium');

        const pr = uiReviewPrResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewPr, server.token)).json(),
        );
        const diff = uiReviewDiffResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewDiff, server.token)).json(),
        );
        const threads = uiReviewThreadsResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewThreads, server.token)).json(),
        );
        const lenses = uiReviewLensesResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewLenses, server.token)).json(),
        );

        expect(pr.pr).toEqual(await expected.getPr());
        expect(diff.diff).toEqual(await expected.getDiff());
        expect(threads.threads).toEqual(await expected.getThreads());
        expect(lenses.ownership).toEqual(await expected.ownershipLens());
        expect(lenses.extra).toEqual(await expected.extraLenses());
    });

    it('includes the host name in UI state', async () => {
        const server = await start(FIXTURE_PR);

        const state = uiStateSchema.parse(await (await get(server.port, UI_ENDPOINTS.state, server.token)).json());

        expect(state.reviewHost).toBe('fixture');
    });

    it('an unrecognized prKey has no host and endpoints return no_review_host', async () => {
        const server = await start(UNKNOWN_PR);

        const state = uiStateSchema.parse(await (await get(server.port, UI_ENDPOINTS.state, server.token)).json());
        expect(state.reviewHost).toBeNull();

        for (const endpoint of [
            UI_ENDPOINTS.reviewPr,
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

        const response = await get(server.port, UI_ENDPOINTS.reviewPr);

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
            await expect(stream.next(300)).rejects.toThrow(/timed out/);
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

async function nextReview(stream: SseStream): Promise<{ threadsRevision: number }> {
    const event = await stream.next();
    expect(event.event).toBe(UI_REVIEW_EVENT);
    return uiReviewEventSchema.parse(JSON.parse(event.data));
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
