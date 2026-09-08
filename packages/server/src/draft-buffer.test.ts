import { makeFixtureHost } from '@sherpa/fixtures';
import type { CommentDraft } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { DraftBufferStore, DraftBufferWriter, retryDelayMs } from './draft-buffer.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Draft buffer: a failed host write leaves the text on the server. The writer
 * retries it automatically on a timer, on a button press and at the next server start.
 */

const DRAFT: CommentDraft = { body: 'need a buffer test', parentId: null, anchor: null };

describe('draft buffer', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let bumps: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(`${sherpaDir}/draft-buffer.db`);
        bumps = 0;
    });

    afterEach(async () => {
        db.close();
        await removeTempSherpaDir(sherpaDir);
        vi.useRealTimers();
    });

    function makeWriter(host: ReturnType<typeof makeFixtureHost> | null, store = new DraftBufferStore({ db })) {
        const writer = new DraftBufferWriter({
            host,
            store,
            reviewFeed: {
                bumpLocalWrite: () => {
                    bumps += 1;
                    return bumps;
                },
            },
            log: () => undefined,
        });
        return { writer, store };
    }

    it('leaves no buffer record after a successful write', async () => {
        const { writer, store } = makeWriter(makeFixtureHost('medium'));

        const result = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        expect(result.outcome).toBe('saved');
        expect(store.list()).toEqual([]);
        expect(bumps).toBe(1);
    });

    it('leaves a failed record with the error text and wakes tabs when the host refuses a write', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);

        const result = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        expect(result).toMatchObject({ outcome: 'buffered' });
        expect(store.list()).toMatchObject([{ id: 'ck-1', state: 'failed', attempts: 1, commentId: null }]);
        expect(store.get('ck-1')?.error).toContain('refuses to accept drafts');
        expect(bumps).toBe(1);
    });

    it('delivers the record on a timer retry once the host recovers', async () => {
        vi.useFakeTimers();
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        host.setFailDraftWrites(false);
        await vi.advanceTimersByTimeAsync(retryDelayMs(1));

        expect(store.list()).toEqual([]);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(true);
        writer.close();
    });

    it('increases the retry delay: 10 s, 30 s, one minute, then every minute', () => {
        expect([retryDelayMs(1), retryDelayMs(2), retryDelayMs(3), retryDelayMs(9)]).toEqual([
            10_000, 30_000, 60_000, 60_000,
        ]);
    });

    it('uses one idempotency key for every attempt to write a record', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const key = store.idempotencyKeyOf('ck-1');

        await writer.retry('ck-1');
        expect(store.idempotencyKeyOf('ck-1')).toBe(key);

        const keys: (string | undefined)[] = [];
        host.setFailDraftWrites(false);
        const original = host.saveDraft.bind(host);
        host.saveDraft = (draft, options) => {
            keys.push(options?.idempotencyKey);
            return original(draft, options);
        };
        await writer.retry('ck-1');

        expect(keys).toEqual([key]);
        expect(store.list()).toEqual([]);
    });

    it('delivers the record immediately on a button retry', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        host.setFailDraftWrites(false);
        await writer.retry('ck-1');

        expect(store.list()).toEqual([]);
        writer.close();
    });

    it('removes the record on discard without touching the host', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        await writer.discard('ck-1');

        expect(store.list()).toEqual([]);
        host.setFailDraftWrites(false);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(false);
    });

    // Discard uses the same queue as write attempts. A draft created by an in-flight call
    // must not survive the reviewer discarding it and get published on ship.
    it('removes the created draft when discarded during an in-flight write', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const saveDraft = host.saveDraft.bind(host);
        let release = (): void => undefined;
        const inFlight = new Promise<void>((resolve) => {
            release = resolve;
        });
        host.saveDraft = async (draft, options) => {
            await inFlight;
            return saveDraft(draft, options);
        };

        const write = writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const discard = writer.discard('ck-1');
        release();
        await write;
        await discard;

        expect(store.list()).toEqual([]);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(false);
    });

    // The composer keeps `clientKey` until it learns of success. It may learn of a timer retry success
    // after the reviewer adds more text. This must not create a second host record.
    it('updates the created draft when writing with the same key after delivery instead of creating another', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);

        const first = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const second = await writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'added another paragraph' },
            commentId: null,
        });

        const created = first.outcome === 'saved' ? first.comment : null;
        expect(created).not.toBeNull();
        expect(second.outcome === 'saved' ? second.comment?.id : null).toBe(created?.id);
        expect(store.list()).toEqual([]);
        const mine = (await host.getThreads()).filter(
            (thread) => thread.root.body === DRAFT.body || thread.root.body === 'added another paragraph',
        );
        expect(mine.map((thread) => thread.root.body)).toEqual(['added another paragraph']);
    });

    // The same case, but the write catches up with an in-flight creation. Its target is resolved in the queue,
    // not when enqueued, otherwise it would reach the host as a second creation.
    it('updates the draft when a write catches up with an in-flight creation instead of creating another', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const saveDraft = host.saveDraft.bind(host);
        let release = (): void => undefined;
        const inFlight = new Promise<void>((resolve) => {
            release = resolve;
        });
        host.saveDraft = async (draft, options) => {
            await inFlight;
            return saveDraft(draft, options);
        };

        const creating = writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        const editing = writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'added another paragraph' },
            commentId: null,
        });
        release();
        const created = await creating;
        const edited = await editing;

        expect(created.outcome === 'saved' ? created.comment?.id : null).toBeDefined();
        expect(edited.outcome === 'saved' ? edited.comment?.id : null).toBe(
            created.outcome === 'saved' ? created.comment?.id : null,
        );
        expect(store.list()).toEqual([]);
        const mine = (await host.getThreads()).filter(
            (thread) => thread.root.body === DRAFT.body || thread.root.body === 'added another paragraph',
        );
        expect(mine.map((thread) => thread.root.body)).toEqual(['added another paragraph']);
    });

    // The host response to creation can be lost after the host accepts it. Retrying with the same
    // idempotency key returns the previous comment, with its old body if the reviewer has already
    // added more text. Reporting success with that body would silently lose text.
    it('updates the draft with the new text on retry after a lost response', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const saveDraft = host.saveDraft.bind(host);
        const byKey = new Map<string, Awaited<ReturnType<typeof saveDraft>>>();
        let dropResponse = true;
        // A host with an idempotency key creates no duplicate but does not apply the retry text either.
        host.saveDraft = async (draft, options) => {
            const known = byKey.get(options?.idempotencyKey ?? '');
            if (known !== undefined) {
                return known;
            }
            const created = await saveDraft(draft, options);
            byKey.set(options?.idempotencyKey ?? '', created);
            if (dropResponse) {
                dropResponse = false;
                throw new Error('host response was lost');
            }
            return created;
        };

        const lost = await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        expect(lost.outcome).toBe('buffered');

        const saved = await writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'added another paragraph' },
            commentId: null,
        });

        expect(saved).toMatchObject({ outcome: 'saved', comment: { body: 'added another paragraph' } });
        expect(store.list()).toEqual([]);
        const mine = (await host.getThreads()).filter(
            (thread) => thread.root.body === DRAFT.body || thread.root.body === 'added another paragraph',
        );
        expect(mine.map((thread) => thread.root.body)).toEqual(['added another paragraph']);
        writer.close();
    });

    // The draft is gone, so its update has nowhere to go. Otherwise the record would hang forever and
    // block shipping the PR, with no way to discard it (its composer will be gone).
    it('removes an undelivered draft update from the buffer when the draft is deleted', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const created = await host.saveDraft({ body: 'first version', parentId: null, anchor: null });

        host.setFailDraftWrites(true);
        await writer.write({
            id: 'ck-edit',
            draft: { body: 'second version', parentId: null, anchor: null },
            commentId: created.id,
        });
        expect(store.list()).toHaveLength(1);

        host.setFailDraftWrites(false);
        await host.deleteDraft(created.id);
        writer.forgetComment(created.id);

        expect(store.list()).toEqual([]);
    });

    // `issue: undefined` in an update means "leave unchanged", not "forget the toggle
    // that has not been delivered yet".
    it('preserves an undelivered toggle when an update omits issue', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({
            id: 'ck-edit',
            draft: { body: 'second version', parentId: null, anchor: null, issue: false },
            commentId: 'comment-42',
        });

        await writer.write({
            id: 'ck-edit',
            draft: { body: 'third version', parentId: null, anchor: null },
            commentId: 'comment-42',
        });

        expect(store.get('ck-edit')?.draft).toMatchObject({ body: 'third version', issue: false });
    });

    it('keeps an update to a draft not yet created as a creation in the same record', async () => {
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const { writer, store } = makeWriter(host);
        await writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });

        await writer.write({
            id: 'ck-1',
            draft: { ...DRAFT, body: 'added another paragraph' },
            commentId: 'comment-42',
        });

        expect(store.list()).toMatchObject([{ id: 'ck-1', commentId: null }]);
        expect(store.get('ck-1')?.draft.body).toBe('added another paragraph');
    });

    it('picks up records after restart with a new writer on the same database', async () => {
        vi.useFakeTimers();
        const host = makeFixtureHost('medium', { failDraftWrites: true });
        const first = makeWriter(host);
        await first.writer.write({ id: 'ck-1', draft: DRAFT, commentId: null });
        first.writer.close();

        host.setFailDraftWrites(false);
        const second = makeWriter(host, new DraftBufferStore({ db }));
        second.writer.start();
        await vi.advanceTimersByTimeAsync(retryDelayMs(1));

        expect(second.store.list()).toEqual([]);
        expect((await host.getThreads()).some((thread) => thread.root.body === DRAFT.body)).toBe(true);
        second.writer.close();
    });

    it('sends an existing draft update to the host as updateDraft', async () => {
        const host = makeFixtureHost('medium');
        const { writer, store } = makeWriter(host);
        const created = await host.saveDraft({ body: 'first version', parentId: null, anchor: null });

        const result = await writer.write({
            id: 'ck-edit',
            draft: { body: 'second version', parentId: null, anchor: null },
            commentId: created.id,
        });

        expect(result).toEqual({ outcome: 'saved', comment: null });
        expect(store.list()).toEqual([]);
        const threads = await host.getThreads();
        expect(threads.find((thread) => thread.root.id === created.id)?.root.body).toBe('second version');
    });
});
