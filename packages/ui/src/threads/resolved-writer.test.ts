import { describe, expect, it, vi } from 'vitest';

import { createResolvedWriter } from './resolved-writer.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

describe('thread resolve queue', () => {
    it('sends resolve and undo strictly in order', async () => {
        const firstRequest = deferred<undefined>();
        const sent: boolean[] = [];
        const send = vi.fn((_: string, resolved: boolean) => {
            sent.push(resolved);
            return resolved ? firstRequest.promise : Promise.resolve();
        });
        const writer = createResolvedWriter({ read: () => false, apply: vi.fn(), send });

        const first = writer.write('thread-1', true);
        const second = writer.write('thread-1', false);
        await Promise.resolve();
        expect(sent).toEqual([true]);

        firstRequest.resolve(undefined);
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
        expect(sent).toEqual([true, false]);
    });

    it('does not roll back a newer action when an older write fails', async () => {
        const firstRequest = deferred<undefined>();
        const applied: boolean[] = [];
        const writer = createResolvedWriter({
            read: () => false,
            apply: (_threadId, resolved) => {
                applied.push(resolved);
            },
            send: (_threadId, resolved) => (resolved ? firstRequest.promise : Promise.resolve()),
        });

        const first = writer.write('thread-1', true);
        const second = writer.write('thread-1', false);
        await Promise.resolve();
        firstRequest.reject(new Error('network'));

        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(true);
        expect(applied).toEqual([true, false]);
    });

    it('uses the previous write value confirmed by SSE for the next rollback', async () => {
        const firstRequest = deferred<undefined>();
        const applied: boolean[] = [];
        let serverResolved = false;
        const writer = createResolvedWriter({
            read: () => false,
            readConfirmed: () => serverResolved,
            apply: (_threadId, resolved) => {
                applied.push(resolved);
            },
            send: (_threadId, resolved) =>
                resolved ? firstRequest.promise : Promise.reject(new Error('undo did not reach the host')),
        });

        const first = writer.write('thread-1', true);
        const second = writer.write('thread-1', false);
        await Promise.resolve();
        serverResolved = true;
        firstRequest.reject(new Error('resolve response lost'));

        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(false);
        expect(applied).toEqual([true, false, true]);
    });

    it('does not roll back a value already confirmed by the SSE snapshot', async () => {
        const request = deferred<undefined>();
        const applied: boolean[] = [];
        let optimistic = true;
        const writer = createResolvedWriter({
            read: () => false,
            apply: (_threadId, resolved) => {
                applied.push(resolved);
            },
            shouldRollback: () => optimistic,
            send: () => request.promise,
        });

        const saving = writer.write('thread-1', true);
        await Promise.resolve();
        optimistic = false;
        request.reject(new Error('response lost'));

        await expect(saving).resolves.toBe(true);
        expect(applied).toEqual([true]);
    });

    it('restores the last confirmed value when the latest action fails', async () => {
        const applied: boolean[] = [];
        let current = false;
        const send = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('network'));
        const writer = createResolvedWriter({
            read: () => current,
            apply: (_threadId, resolved) => {
                current = resolved;
                applied.push(resolved);
            },
            send,
        });

        await writer.write('thread-1', true);
        await expect(writer.write('thread-1', false)).resolves.toBe(false);

        expect(applied).toEqual([true, false, true]);
    });
});
