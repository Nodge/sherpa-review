import { FixtureHost, makeFixtureHost } from '@sherpa/fixtures';
import {
    rpcErrorSchema,
    UI_ENDPOINTS,
    UI_REVIEW_EVENT,
    UI_STATE_EVENT,
    uiReviewDiffResponseSchema,
    uiReviewEventSchema,
    uiReviewLensesResponseSchema,
    uiReviewPrResponseSchema,
    uiReviewThreadsResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectReviewHost } from './hosts/select.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

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

    async function start(prKey: string, host?: FixtureHost): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            ...(host === undefined ? {} : { reviewHostFactory: () => ({ name: 'fixture', host }) }),
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
