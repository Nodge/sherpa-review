import { describe, expect, it } from 'vitest';

import type { ImageDiffConnection, ImageDiffHandlers, ImageDiffMessage } from './image-diff-client.js';
import { createImageDiffClient } from './image-diff-client.js';
import type { PixelSurface } from './image-diff.js';
import { diffPixels } from './image-diff.js';

/**
 * Diff worker client: request round trip, calculation failure, whole-worker crash.
 * The transport is injected, so neither `Worker` nor canvas is needed here.
 */

const ACCENT: readonly [number, number, number] = [255, 0, 128];

function surface(width: number, height: number, value: number): PixelSurface {
    return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(value) };
}

interface FakeWorker {
    connect: (handlers: ImageDiffHandlers) => ImageDiffConnection;
    posted: ImageDiffMessage[];
    /** Transferred buffers show that rasters were sent without copying. */
    transferred: ArrayBuffer[][];
    connects: number;
    closed: number;
    failNext: boolean;
    crash: (message: string) => void;
}

/** Transport without Worker: calculates the diff here and replies on the next tick. */
function fakeWorker(): FakeWorker {
    let live: ImageDiffHandlers | null = null;
    const fake: FakeWorker = {
        posted: [],
        transferred: [],
        connects: 0,
        closed: 0,
        failNext: false,
        crash: (message) => {
            live?.onError(new Error(message));
        },
        connect: (handlers) => {
            live = handlers;
            fake.connects += 1;
            return {
                post: (message, transfer) => {
                    fake.posted.push(message);
                    fake.transferred.push([...transfer]);
                    const fail = fake.failNext;
                    fake.failNext = false;
                    queueMicrotask(() => {
                        handlers.onMessage(
                            fail
                                ? { id: message.id, ok: false, error: 'worker failed' }
                                : {
                                      id: message.id,
                                      ok: true,
                                      result: diffPixels(message.before, message.after, message.options),
                                  },
                        );
                    });
                },
                close: () => {
                    fake.closed += 1;
                },
            };
        },
    };
    return fake;
}

describe('image diff worker client', () => {
    it('transfers rasters to the worker and receives the result', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        const before = surface(2, 2, 0);
        const after = surface(2, 2, 255);

        const result = await client.compute(before, after, { accent: ACCENT });

        expect(result.changed).toBe(4);
        expect(worker.posted).toHaveLength(1);
        expect(worker.transferred[0]).toHaveLength(2);
    });

    it('starts the worker on the first calculation and reuses it for all requests', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });

        expect(worker.connects).toBe(0);

        await client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });
        await client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });

        expect(worker.connects).toBe(1);
    });

    it('returns a calculation failure as a request error', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        worker.failNext = true;

        await expect(client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT })).rejects.toThrow(
            'worker failed',
        );
    });

    it('rejects pending requests on worker crash and restarts it for the next calculation', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        const pending = client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });

        worker.crash('worker crashed');

        await expect(pending).rejects.toThrow('worker crashed');
        expect(worker.closed).toBe(1);

        await client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });
        expect(worker.connects).toBe(2);
    });

    it('rejects pending requests when closed and stops calculating', async () => {
        const worker = fakeWorker();
        const client = createImageDiffClient({ connect: worker.connect });
        const pending = client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT });

        client.close();

        await expect(pending).rejects.toThrow();
        await expect(client.compute(surface(1, 1, 0), surface(1, 1, 0), { accent: ACCENT })).rejects.toThrow();
        expect(worker.closed).toBe(1);
    });
});
