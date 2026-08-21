import { fixtureData } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import type { DiffParseMessage, DiffWorkerConnection, DiffWorkerHandlers } from './client.js';
import { createDiffClient } from './client.js';
import type { DiffParseRequest } from './model.js';
import { toParseRequest } from './model.js';
import { parseFileDiff } from './parse.js';

const DIFF = fixtureData('medium').diff;

function request(index: number): DiffParseRequest {
    const file = DIFF.files[index];
    if (file === undefined) {
        throw new Error(`medium fixture has no file at index ${String(index)}`);
    }
    return toParseRequest(file);
}

interface FakeWorker {
    connect: (handlers: DiffWorkerHandlers) => DiffWorkerConnection;
    /** Everything sent to the worker: this list shows cache hits. */
    posted: DiffParseMessage[];
    closed: number;
    /** Reply with a failure instead of a model to check that failures are not cached. */
    failNext: boolean;
    /** Crash the whole worker, like a `Worker` `error` event. */
    crash: (message: string) => void;
}

/** Transport without Worker: calls the parser directly and replies on the next tick. */
function fakeWorker(): FakeWorker {
    let live: DiffWorkerHandlers | null = null;
    const fake: FakeWorker = {
        posted: [],
        closed: 0,
        failNext: false,
        crash: (message) => {
            live?.onError(new Error(message));
        },
        connect: (handlers) => {
            live = handlers;
            return {
                post: (message) => {
                    fake.posted.push(message);
                    const fail = fake.failNext;
                    fake.failNext = false;
                    queueMicrotask(() => {
                        handlers.onMessage(
                            fail
                                ? { id: message.id, ok: false, error: 'worker failed' }
                                : { id: message.id, ok: true, model: parseFileDiff(message.file) },
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

describe('diff worker client', () => {
    it('sends the request to the worker and receives a model', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const file = request(0);

        const model = await client.parseFile(DIFF.diffId, file);

        expect(model.path).toBe(file.path);
        expect(worker.posted).toHaveLength(1);
    });

    it('does not call the worker again for the same file', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const file = request(0);

        const first = await client.parseFile(DIFF.diffId, file);
        const second = await client.parseFile(DIFF.diffId, file);

        expect(second).toBe(first);
        expect(worker.posted).toHaveLength(1);
    });

    it('merges two requests made before the reply into one', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const file = request(0);

        const [first, second] = await Promise.all([
            client.parseFile(DIFF.diffId, file),
            client.parseFile(DIFF.diffId, file),
        ]);

        expect(second).toBe(first);
        expect(worker.posted).toHaveLength(1);
    });

    it('sends separate requests for a different file and iteration', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        await client.parseFile(DIFF.diffId, request(0));
        await client.parseFile(DIFF.diffId, request(1));
        await client.parseFile('another-iteration', request(0));

        expect(worker.posted).toHaveLength(3);
    });

    it('routes replies to their requests', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const models = await Promise.all([
            client.parseFile(DIFF.diffId, request(0)),
            client.parseFile(DIFF.diffId, request(1)),
        ]);

        expect(models.map((model) => model.path)).toEqual([request(0).path, request(1).path]);
    });

    it('does not cache a failure: the next request goes to the worker again', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        worker.failNext = true;

        await expect(client.parseFile(DIFF.diffId, request(0))).rejects.toThrow('worker failed');
        await client.parseFile(DIFF.diffId, request(0));

        expect(worker.posted).toHaveLength(2);
    });

    it('close rejects pending requests and terminates the worker', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const pending = client.parseFile(DIFF.diffId, request(0));
        client.close();

        await expect(pending).rejects.toThrow('Diff worker closed');
        await expect(client.parseFile(DIFF.diffId, request(0))).rejects.toThrow('Diff worker closed');
        expect(worker.closed).toBe(1);
    });

    it('rejects pending requests on worker crash', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const pending = client.parseFile(DIFF.diffId, request(0));
        worker.crash('worker failed to load');

        await expect(pending).rejects.toThrow('worker failed to load');
        expect(worker.closed).toBe(1);
    });

    it('starts a new worker for the next request after a crash', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const pending = client.parseFile(DIFF.diffId, request(0));
        worker.crash('worker failed to load');
        await expect(pending).rejects.toThrow('worker failed to load');

        const model = await client.parseFile(DIFF.diffId, request(0));

        expect(model.path).toBe(request(0).path);
        expect(worker.posted).toHaveLength(2);
    });

    it('cache key distinguishes different diffId and fileId pairs', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });
        const [first, second] = [request(0), request(1)];

        const left = await client.parseFile('iteration 1', { ...first, fileId: '2' });
        const right = await client.parseFile('iteration', { ...second, fileId: '1 2' });

        expect(left.path).toBe(first.path);
        expect(right.path).toBe(second.path);
        expect(worker.posted).toHaveLength(2);
    });

    it('starts the worker lazily: it does not exist without requests', () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        client.close();

        expect(worker.closed).toBe(0);
    });

    it('receives the model through structured clone without data loss', async () => {
        const worker = fakeWorker();
        const client = createDiffClient({ connect: worker.connect });

        const model = await client.parseFile(DIFF.diffId, request(0));

        expect(structuredClone(model)).toEqual(model);
    });
});
