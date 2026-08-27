import type { UiFileProgress, UiStopSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { createProgressWriter } from './progress-writer.js';

/** Viewed mark coordination: per-file queue, rollback and tab convergence (T8). */

interface Deferred {
    readonly resolve: (revision: number) => void;
    readonly reject: () => void;
}

function harness(initialRevision = 0) {
    const progress = new Map<string, UiFileProgress>();
    const stops = new Map<string, boolean>();
    const sent: { fileId: string; viewed: boolean }[] = [];
    const stopsSent: { stopId: string; viewed: boolean; ranges: readonly UiStopSeenRange[] }[] = [];
    const pending: Deferred[] = [];

    const writer = createProgressWriter({
        initialRevision,
        read: (fileId) => progress.get(fileId) ?? null,
        apply: (fileId, viewed) => {
            progress.set(fileId, { fileId, seenRanges: progress.get(fileId)?.seenRanges ?? [], viewed });
        },
        restore: (fileId, record) => {
            if (record === null) {
                progress.delete(fileId);
            } else {
                progress.set(fileId, record);
            }
        },
        send: (fileId, viewed) => {
            sent.push({ fileId, viewed });
            return deferred();
        },
        stops: {
            read: (stopId) => stops.get(stopId) ?? null,
            apply: (stopId, viewed) => {
                stops.set(stopId, viewed);
            },
            restore: (stopId, viewed) => {
                if (viewed === null) {
                    stops.delete(stopId);
                } else {
                    stops.set(stopId, viewed);
                }
            },
            send: (stopId, viewed, ranges) => {
                stopsSent.push({ stopId, viewed, ranges });
                return deferred();
            },
        },
        onSettled: () => undefined,
    });

    function deferred(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            pending.push({ resolve, reject: () => { reject(new Error('endpoint did not respond')); } });
        });
    }

    return { writer, progress, stops, sent, stopsSent, pending };
}

/** Run microtasks: the write queue sends requests through `then`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('writing reading progress', () => {
    it('puts the mark in the store immediately and confirms it with the endpoint response', async () => {
        const { writer, progress, sent, pending } = harness();

        const write = writer.write('a', true);
        expect(progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: [] });

        await settle();
        expect(sent).toEqual([{ fileId: 'a', viewed: true }]);
        pending[0]?.resolve(1);

        expect(await write).toBe(true);
        expect(progress.get('a')?.viewed).toBe(true);
    });

    it('rolls back the control to its previous state when a write fails', async () => {
        const { writer, progress, pending } = harness();

        const write = writer.write('a', true);
        await settle();
        pending[0]?.reject();

        expect(await write).toBe(false);
        // No record existed before the mark. Rollback must remove it, without leaving `viewed: false`.
        expect(progress.has('a')).toBe(false);
    });

    it('sends two marks for the same file to the server in order', async () => {
        const { writer, sent, pending } = harness();

        const first = writer.write('a', true);
        const second = writer.write('a', false);
        await settle();

        // The second waits for the first response, or the server could apply them in reverse order.
        expect(sent).toEqual([{ fileId: 'a', viewed: true }]);
        pending[0]?.resolve(1);
        await settle();
        expect(sent).toEqual([{ fileId: 'a', viewed: true }, { fileId: 'a', viewed: false }]);

        pending[1]?.resolve(2);
        expect(await Promise.all([first, second])).toEqual([true, true]);
    });

    it('does not roll back a later successful write when an earlier one fails', async () => {
        const { writer, progress, pending } = harness();

        const first = writer.write('a', true);
        const second = writer.write('a', false);
        await settle();
        pending[0]?.reject();
        expect(await first).toBe(false);
        // Rolling back the first would erase a mark still being sent to the server.
        expect(progress.get('a')?.viewed).toBe(false);

        await settle();
        pending[1]?.resolve(1);
        expect(await second).toBe(true);
        expect(progress.get('a')?.viewed).toBe(false);
    });

    it('restores what the server confirmed when the latest write fails', async () => {
        const { writer, progress, pending } = harness();

        const first = writer.write('a', true);
        await settle();
        pending[0]?.resolve(1);
        expect(await first).toBe(true);

        const second = writer.write('a', false);
        await settle();
        pending[1]?.reject();

        expect(await second).toBe(false);
        expect(progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: [] });
    });

    it('requests a refetch for its own write only when there is a revision gap', async () => {
        const own = harness();
        const ownWrite = own.writer.write('a', true);
        await settle();
        own.pending[0]?.resolve(1);
        await ownWrite;

        expect(own.writer.shouldReload(1)).toBe(false);

        // Another tab wrote first: our write returned revision 2, but this tab never saw revision 1,
        // so the snapshot needs to be fetched again.
        const shared = harness();
        const sharedWrite = shared.writer.write('a', true);
        await settle();
        shared.pending[0]?.resolve(2);
        await sharedWrite;

        expect(shared.writer.shouldReload(2)).toBe(true);
    });

    it('refetches the snapshot after unmarking a file even without a channel event', async () => {
        const { writer, pending } = harness();

        const write = writer.write('a', false);
        await settle();
        pending[0]?.resolve(1);
        await write;

        // The server may have unmarked related stops and removed their ranges. This cannot be calculated locally.
        expect(writer.shouldReload(null)).toBe(true);
        writer.finishReload(
            { files: [{ fileId: 'a', viewed: false, seenRanges: [] }], stops: [], progressRevision: 1 },
            writer.beginReload(),
        );
        expect(writer.shouldReload(null)).toBe(false);
    });

    it('still requests a refetch for lower-revision events after a server restart', () => {
        const { writer } = harness();

        writer.finishReload({ files: [], stops: [], progressRevision: 12 }, writer.beginReload());
        expect(writer.shouldReload(12)).toBe(false);

        // The server restarted and reset its counter: revision 1 is another tab's mark on the new server,
        // rather than an outdated event. Checking "greater than applied" would stay silent until revision 13.
        expect(writer.shouldReload(1)).toBe(true);
    });

    it('defers refetching while a write is in flight', async () => {
        const { writer, pending } = harness();

        const write = writer.write('a', true);
        expect(writer.shouldReload(5)).toBe(false);

        await settle();
        pending[0]?.resolve(5);
        await write;
        expect(writer.shouldReload(5)).toBe(true);
    });

    it('does not roll back writes absent from the refetched snapshot', async () => {
        const { writer, pending } = harness();

        const mark = writer.beginReload();
        // The reviewer marked the file while the endpoint was responding.
        const write = writer.write('a', true);
        const merged = writer.finishReload(
            { files: [{ fileId: 'b', viewed: true, seenRanges: [] }], stops: [], progressRevision: 3 },
            mark,
        );

        expect(merged.files).toEqual([
            { fileId: 'b', viewed: true, seenRanges: [] },
            { fileId: 'a', viewed: true, seenRanges: [] },
        ]);

        await settle();
        pending[0]?.resolve(4);
        await write;
    });

    it('preserves snapshot ranges when overlaying a write and accepts a response with a lower revision', async () => {
        const { writer, pending } = harness(2);
        const ranges = [{ side: 'new' as const, start: 1, end: 4 }];

        const mark = writer.beginReload();
        const write = writer.write('a', true);
        const merged = writer.finishReload(
            { files: [{ fileId: 'a', viewed: false, seenRanges: ranges }], stops: [], progressRevision: 3 },
            mark,
        );

        expect(merged.files).toEqual([{ fileId: 'a', viewed: true, seenRanges: ranges }]);
        // A revision lower than the one seen means the server restarted. The response is not outdated:
        // its snapshot applies, and the write it missed still goes on top.
        expect(writer.finishReload({ files: [], stops: [], progressRevision: 1 }, mark).files).toEqual([
            { fileId: 'a', viewed: true, seenRanges: [] },
        ]);

        await settle();
        pending[0]?.resolve(4);
        await write;
    });

    it('sends a stop mark with its ranges and rolls it back on failure', async () => {
        const { writer, stops, stopsSent, pending } = harness();
        const ranges = [{ fileId: 'a', side: 'new' as const, start: 3, end: 9 }];

        const write = writer.writeStop('s01', true, ranges);
        // Optimistic update: the mark is in the store before the endpoint responds.
        expect(stops.get('s01')).toBe(true);
        await settle();
        expect(stopsSent).toEqual([{ stopId: 's01', viewed: true, ranges }]);

        pending[0]?.reject();
        expect(await write).toBe(false);
        // There was no record before the mark, so rollback must remove it entirely.
        expect(stops.has('s01')).toBe(false);
    });

    it('refetches the snapshot after marking a stop because the server calculates the ranges', async () => {
        const { writer, pending } = harness();

        const write = writer.writeStop('s01', true, []);
        await settle();
        pending[0]?.resolve(1);
        await write;

        // Our own revision has no gap, but the file seen ranges exist only in the snapshot.
        expect(writer.shouldReload(1)).toBe(true);
        const merged = writer.finishReload(
            { files: [], stops: [{ stopId: 's01', viewed: true }], progressRevision: 1 },
            writer.beginReload(),
        );
        expect(merged.stops).toEqual([{ stopId: 's01', viewed: true }]);
        expect(writer.shouldReload(1)).toBe(false);
    });

    it('does not wait for a channel revision before refetching after marking a stop', async () => {
        const { writer, pending } = harness();
        // No progress event has reached the tab yet, so there is no channel revision at all.
        expect(writer.shouldReload(null)).toBe(false);

        const write = writer.writeStop('s01', true, []);
        await settle();
        pending[0]?.resolve(1);
        await write;

        expect(writer.shouldReload(null)).toBe(true);
        writer.finishReload({ files: [], stops: [], progressRevision: 1 }, writer.beginReload());
        expect(writer.shouldReload(null)).toBe(false);
    });

    it('does not roll back a stop mark absent from the refetched snapshot', async () => {
        const { writer, pending } = harness();

        const mark = writer.beginReload();
        const write = writer.writeStop('s01', true, []);
        const merged = writer.finishReload({ files: [], stops: [], progressRevision: 3 }, mark);

        expect(merged.stops).toEqual([{ stopId: 's01', viewed: true }]);

        await settle();
        pending[0]?.resolve(4);
        await write;
    });

    it('rolls a failed write back to the snapshot that arrived while it was in flight', async () => {
        const { writer, progress, pending } = harness();

        const mark = writer.beginReload();
        const write = writer.write('a', true);
        // Another tab unmarked it. That is the server state without our write.
        const merged = writer.finishReload(
            { files: [{ fileId: 'a', viewed: false, seenRanges: [] }], stops: [], progressRevision: 7 },
            mark,
        );
        expect(merged.files).toEqual([{ fileId: 'a', viewed: true, seenRanges: [] }]);

        await settle();
        pending[0]?.reject();
        expect(await write).toBe(false);
        expect(progress.get('a')).toEqual({ fileId: 'a', viewed: false, seenRanges: [] });
    });
});
