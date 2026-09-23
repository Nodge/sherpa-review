import type { Comment, DraftBufferEntry, Thread, UiSaveDraftResponse } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerTransport } from './composer.js';
import { closePublishedComposers, composerControllerFor, createComposerController } from './composer.js';
import { openNewComposer, openReply } from './thread-list.tsx';
import { createThreadStore } from './store.js';

/** Draft endpoint responses: the host accepted the write. */
const SAVED = { outcome: 'saved' } as const;
function saved(comment: Comment): UiSaveDraftResponse {
    return { outcome: 'saved', comment };
}

/** Response when the host has not accepted the text, which is in the server buffer. */
function bufferedEntry(id: string, body: string, error = 'host is down'): DraftBufferEntry {
    return {
        id,
        draft: {
            body,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
        },
        commentId: null,
        state: 'failed',
        error,
        attempts: 1,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
    };
}

const CREATED: Comment = {
    id: 'draft-1',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
    body: 'first',
    draft: true,
    issue: null,
    resolved: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    editedAt: null,
    replies: [],
};

const THREAD: Thread = {
    id: 'thread-1',
    anchor: null,
    resolved: false,
    resolvedBy: null,
    outdated: false,
    pinnedTo: null,
    root: { ...CREATED, id: 'root-1', draft: false },
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function setup() {
    const store = createThreadStore([], new Set(['f1']));
    store.openComposer({
        key: 'new:f1:new:10',
        threadId: null,
        parentId: null,
        anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
        text: '',
        commentId: null,
        status: 'idle',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
    const save = vi.fn<ComposerTransport['save']>(() => Promise.resolve(saved(CREATED)));
    const update = vi.fn<ComposerTransport['update']>(() => Promise.resolve(SAVED));
    const remove = vi.fn(() => Promise.resolve());
    const discardBuffered = vi.fn(() => Promise.resolve());
    const controller = createComposerController({
        store,
        key: 'new:f1:new:10',
        transport: { save, update, delete: remove, discardBuffered },
    });
    return { store, controller, save, update, remove, discardBuffered };
}

const EDIT_KEY = 'edit:draft-1';

/** Buffer entry for editing your own draft. */
function editEntry(id: string, body: string): DraftBufferEntry {
    return { ...bufferedEntry(id, body), commentId: 'draft-1', draft: { body, parentId: null, anchor: null } };
}

/** Composer for editing your own draft, as opened by `openDraftEditor`. */
function setupEditComposer(issue?: boolean) {
    const store = createThreadStore([], new Set(['f1']));
    store.openComposer({
        key: EDIT_KEY,
        threadId: 'thread-1',
        parentId: null,
        anchor: null,
        ...(issue === undefined ? {} : { issue }),
        text: 'this is on the host',
        originalText: 'this is on the host',
        commentId: 'draft-1',
        status: 'saved',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
    const save = vi.fn<ComposerTransport['save']>(() => Promise.resolve(saved(CREATED)));
    const update = vi.fn<ComposerTransport['update']>(() => Promise.resolve(SAVED));
    const remove = vi.fn(() => Promise.resolve());
    const discardBuffered = vi.fn(() => Promise.resolve());
    const controller = createComposerController({
        store,
        key: EDIT_KEY,
        transport: { save, update, delete: remove, discardBuffered },
    });
    return { store, controller, save, update, remove, discardBuffered };
}

function setupIssueComposer(kind: 'new' | 'reply') {
    const store = createThreadStore(kind === 'reply' ? [THREAD] : [], new Set(['f1']));
    const key = kind === 'new' ? 'new:f1:new:10' : `reply:${THREAD.id}`;
    if (kind === 'new') {
        openNewComposer(
            store,
            key,
            { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            true,
        );
    } else {
        openReply(store, THREAD, true, null);
    }
    const save = vi.fn(() => Promise.resolve(saved(CREATED)));
    const update = vi.fn(() => Promise.resolve(SAVED));
    const remove = vi.fn(() => Promise.resolve());
    const controller = createComposerController({ store, key, transport: { save, update, delete: remove } });
    return { store, controller, save, update };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('composer state machine', () => {
    it('saves a new thread with issue: true by default', async () => {
        const { controller, save } = setupIssueComposer('new');

        controller.input('first');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(
            {
                body: 'first',
                parentId: null,
                anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
                issue: true,
            },
            expect.any(String),
        );
    });

    it('passes issue disabled before the first save to save', async () => {
        const { controller, save } = setupIssueComposer('new');

        controller.setIssue(false);
        controller.input('no reply needed');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(expect.objectContaining({ issue: false }), expect.any(String));
    });

    it('passes an issue change after the first save to update on the next save', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();

        controller.setIssue(false);
        await controller.saveNow();

        expect(update).toHaveBeenCalledWith('draft-1', 'first', false, expect.any(String));
    });

    it('does not resend issue when saving text after create', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();

        controller.input('second');
        await controller.saveNow();

        expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([['draft-1', 'second']]);
    });

    it('does not resend issue when saving text after changing it', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();
        controller.setIssue(false);
        await controller.saveNow();

        controller.input('second');
        await controller.saveNow();

        expect(update.mock.calls.map((call) => call.slice(0, 3))).toEqual([
            ['draft-1', 'first', false],
            ['draft-1', 'second', undefined],
        ]);
    });

    it('does not resend issue when it returns to the stored value', async () => {
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();

        controller.setIssue(false);
        controller.setIssue(true);
        controller.input('second');
        await controller.saveNow();

        expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([['draft-1', 'second']]);
    });

    it('saves a reply with issue: true by default', async () => {
        const { controller, save } = setupIssueComposer('reply');

        controller.input('reply');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(
            { body: 'reply', parentId: 'root-1', anchor: null, issue: true },
            expect.any(String),
        );
    });

    it('passes a disabled reply issue to save', async () => {
        const { controller, save } = setupIssueComposer('reply');

        controller.setIssue(false);
        controller.input('reply');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(expect.objectContaining({ issue: false }), expect.any(String));
    });

    it('saves only on an explicit action: save first, then update', async () => {
        vi.useFakeTimers();
        const { controller, save, update } = setup();

        controller.input('first');
        await vi.advanceTimersByTimeAsync(5000);
        expect(save).not.toHaveBeenCalled();
        await controller.saveNow();
        expect(save).toHaveBeenCalledTimes(1);

        controller.input('second');
        await vi.advanceTimersByTimeAsync(5000);
        expect(update).not.toHaveBeenCalled();
        await controller.saveNow();
        expect(update).toHaveBeenCalledWith('draft-1', 'second', undefined, expect.any(String));
    });

    it('Cancel after saving closes the composer without deleting Comment', async () => {
        const { store, controller, update, remove } = setup();
        controller.input('text');
        await controller.saveNow();
        controller.input('change');

        controller.escape();
        expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        await controller.confirmDiscard();

        expect(update).toHaveBeenCalledWith('draft-1', 'text', undefined, expect.any(String));
        expect(remove).not.toHaveBeenCalled();
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('keeps the text on failure and allows a retry', async () => {
        const { store, controller, save } = setup();
        save.mockRejectedValueOnce(new Error('no network'));
        controller.input('keep this');

        expect(await controller.saveNow()).toBe(false);
        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: 'keep this',
            status: 'error',
        });
        expect(await controller.retry()).toBe(true);
    });

    // The server did not respond. The text stays in the field, and a retry uses the same `clientKey`, so
    // it cannot create a duplicate even if the first request did reach the server.
    it('keeps the text in the field on request failure and retries with the same clientKey', async () => {
        const { store, controller, save } = setup();
        save.mockRejectedValueOnce(new Error('server did not respond'));
        controller.input('may have been saved');
        await controller.saveNow();

        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: 'may have been saved',
            status: 'error',
        });
        const firstKey = save.mock.calls[0]?.[1];
        expect(firstKey).toEqual(expect.any(String));

        expect(await controller.retry()).toBe(true);
        expect(save.mock.calls[1]?.[1]).toBe(firstKey);
    });

    it('accepts input again through a new controller instance after closing', async () => {
        const { store, controller, save, update, remove } = setup();
        controller.input('first');
        await controller.saveNow(true);
        expect(store.getComposer('new:f1:new:10')).toBeNull();

        store.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const reopened = createComposerController({
            store,
            key: 'new:f1:new:10',
            transport: { save, update, delete: remove },
        });
        reopened.input('second');

        expect(store.getComposer('new:f1:new:10')?.text).toBe('second');
    });

    it('asks for confirmation on Esc with erased text and restores the saved text', async () => {
        const { store, controller, update, remove } = setup();
        controller.input('oops, wrong text');
        await controller.saveNow();
        controller.input('');

        controller.escape();
        expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        await controller.confirmDiscard();

        expect(store.getComposer('new:f1:new:10')).toBeNull();
        expect(update).toHaveBeenCalledWith('draft-1', 'oops, wrong text', undefined, expect.any(String));
        expect(remove).not.toHaveBeenCalled();
    });

    it('leaves input entered during save unsaved until the next explicit action', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('second');
        pendingSave.resolve(saved(CREATED));
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'second', status: 'idle' });
        expect(update).not.toHaveBeenCalled();
        await controller.saveNow();
        expect(update).toHaveBeenCalledWith('draft-1', 'second', undefined, expect.any(String));
    });

    it('does not mark new text as saved when an earlier save responds', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('second');
        pendingSave.resolve(saved(CREATED));
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'second', status: 'idle' });
        expect(update).not.toHaveBeenCalled();
    });

    it('does not mark a cleared field as saved when an earlier save responds', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('');
        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: '', status: 'saving' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        pendingSave.resolve(saved(CREATED));
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: '',
            commentId: 'draft-1',
            status: 'idle',
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(update).not.toHaveBeenCalled();
    });

    it('keeps one controller across remounts while the composer is open', () => {
        const { store, save, update, remove } = setup();
        const transport = { save, update, delete: remove };

        const first = composerControllerFor({ store, key: 'new:f1:new:10', transport });
        const remounted = composerControllerFor({ store, key: 'new:f1:new:10', transport });

        expect(remounted).toBe(first);
    });

    it('returns a new controller from the cache when reopened after closing', async () => {
        const { store, save, update, remove } = setup();
        const transport = { save, update, delete: remove };
        const first = composerControllerFor({ store, key: 'new:f1:new:10', transport });
        first.input('close');
        await first.saveNow(true);
        store.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });

        const reopened = composerControllerFor({ store, key: 'new:f1:new:10', transport });

        expect(reopened).not.toBe(first);
    });

    it('closes the saved composer and forgets its controller on publication', async () => {
        const store = createThreadStore([], new Set(['f1']));
        const key = 'new:f1:new:10';
        store.openComposer({
            key,
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const transport = {
            save: vi.fn(() => Promise.resolve(saved(CREATED))),
            update: vi.fn(() => Promise.resolve(SAVED)),
            delete: vi.fn(() => Promise.resolve()),
        };
        const first = composerControllerFor({ store, key, transport });
        first.input('publish');
        await first.saveNow();

        closePublishedComposers(store, ['draft-1']);
        expect(store.getComposer(key)).toBeNull();

        store.openComposer({
            key,
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const reopened = composerControllerFor({ store, key, transport });
        reopened.input('new text');

        expect(reopened).not.toBe(first);
        expect(store.getComposer(key)?.text).toBe('new text');
    });

    it('deletes the returned id without adding a draft when closed during the first save', async () => {
        const { store, controller, save, remove } = setup();
        const pendingSave = deferred<UiSaveDraftResponse>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('do not save');
        const saving = controller.saveNow();
        const discarding = controller.confirmDiscard();

        pendingSave.resolve(saved(CREATED));
        await expect(saving).resolves.toBe(true);
        await expect(discarding).resolves.toBe(true);

        expect(remove).toHaveBeenCalledWith('draft-1');
        expect(store.getSnapshot().threads).toEqual([]);
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('waits for the latest queued text in saveNow', async () => {
        const { store, controller, update } = setup();
        controller.input('original');
        await controller.saveNow();
        const firstUpdate = deferred<typeof SAVED>();
        const lastUpdate = deferred<typeof SAVED>();
        update.mockImplementationOnce(() => firstUpdate.promise).mockImplementationOnce(() => lastUpdate.promise);

        controller.input('intermediate');
        void controller.saveNow();
        controller.input('latest');
        let completed = false;
        const savingLast = controller.saveNow(true).then((saved) => {
            completed = true;
            return saved;
        });

        firstUpdate.resolve(SAVED);
        await vi.waitFor(() => {
            expect(update).toHaveBeenLastCalledWith('draft-1', 'latest', undefined, expect.any(String));
        });
        expect(completed).toBe(false);
        expect(store.getComposer('new:f1:new:10')).not.toBeNull();

        lastUpdate.resolve(SAVED);
        await expect(savingLast).resolves.toBe(true);
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('waits for the active save in restore and restores the original text with the final update', async () => {
        const { store, controller, update } = setup();
        controller.input('original');
        await controller.saveNow();
        const pendingUpdate = deferred<typeof SAVED>();
        update.mockImplementationOnce(() => pendingUpdate.promise);

        controller.input('broken');
        void controller.saveNow();
        const restoring = controller.restore('original');

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'broken', status: 'saving' });
        pendingUpdate.resolve(SAVED);
        await expect(restoring).resolves.toBe(true);

        expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([
            ['draft-1', 'broken'],
            ['draft-1', 'original'],
        ]);
        expect(store.getSnapshot().threads[0]?.root.body).toBe('original');
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('does not replace entered text with the original when restore fails', async () => {
        const { store, controller, update } = setup();
        controller.input('original');
        await controller.saveNow();
        controller.input('keep this');
        update.mockRejectedValueOnce(new Error('no network'));

        await expect(controller.restore('original')).resolves.toBe(false);

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'keep this', status: 'error' });
        expect(store.getSnapshot().threads[0]?.root.body).toBe(CREATED.body);
    });
});

// Draft buffer: the host rejected the write, but the server accepted the text and will deliver it.
describe('composer and draft buffer', () => {
    it('keeps the composer open without adding a draft to threads on a buffered response', async () => {
        const { store, controller, save } = setup();
        const entry = bufferedEntry('ck-1', 'waiting for a connection');
        save.mockResolvedValueOnce({ outcome: 'buffered', entry });

        controller.input('waiting for a connection');
        expect(await controller.saveNow(true)).toBe(false);

        expect(store.getComposer('new:f1:new:10')).toMatchObject({
            text: 'waiting for a connection',
            status: 'buffered',
            commentId: null,
            bufferEntry: entry,
        });
        expect(store.getSnapshot().threads).toEqual([]);
    });

    it('does not keep the navigation guard active for a buffered composer', async () => {
        const { store, controller, save } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'waiting for a connection') });

        controller.input('waiting for a connection');
        await controller.saveNow();

        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    it('retries a buffered write with the same clientKey and closes the composer on success', async () => {
        const { store, controller, save } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'waiting for a connection') });
        controller.input('waiting for a connection');
        await controller.saveNow();
        const clientKey = save.mock.calls[0]?.[1];

        expect(await controller.retry()).toBe(true);

        expect(save.mock.calls[1]?.[1]).toBe(clientKey);
        expect(store.getComposer('new:f1:new:10')).toMatchObject({ status: 'saved', commentId: 'draft-1' });
    });

    it('keeps buffered status when editing text and writes to the same entry', async () => {
        const { store, controller, save } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'first version') });
        controller.input('first version');
        await controller.saveNow();
        const clientKey = save.mock.calls[0]?.[1];

        controller.input('second version');
        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'second version', status: 'buffered' });

        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'second version') });
        await controller.saveNow();
        expect(save.mock.calls[1]).toEqual([expect.objectContaining({ body: 'second version' }), clientKey]);
    });

    it('removes the server entry and closes the field when discarding a buffered composer', async () => {
        const { store, controller, save, remove, discardBuffered } = setup();
        save.mockResolvedValueOnce({ outcome: 'buffered', entry: bufferedEntry('ck-1', 'no longer needed') });
        controller.input('no longer needed');
        await controller.saveNow();

        await expect(controller.confirmDiscard()).resolves.toBe(true);

        expect(discardBuffered).toHaveBeenCalledWith('ck-1');
        expect(remove).not.toHaveBeenCalled();
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    // The edit did not reach the host, which still has the original text. "Discard" must remove the entry,
    // and leave the draft itself intact: the reviewer did not ask to delete it.
    it('removes the entry and keeps the host draft when discarding a buffered edit', async () => {
        const { store, controller, update, remove, discardBuffered } = setupEditComposer();
        update.mockResolvedValueOnce({ outcome: 'buffered', entry: editEntry('ck-edit', 'edit') });

        controller.input('edit');
        await controller.saveNow();
        expect(store.getComposer(EDIT_KEY)).toMatchObject({ status: 'buffered' });

        await expect(controller.confirmDiscard()).resolves.toBe(true);

        expect(discardBuffered).toHaveBeenCalledWith('ck-edit');
        expect(remove).not.toHaveBeenCalled();
        expect(store.getComposer(EDIT_KEY)).toBeNull();
    });

    // Returning to the original text with an existing entry also removes the entry: the unavailable host
    // already has that text, so there is no reason to write it again.
    it('removes the entry without writing to the host when reverting a buffered edit to the original text', async () => {
        const { controller, update, discardBuffered } = setupEditComposer();
        update.mockResolvedValueOnce({ outcome: 'buffered', entry: editEntry('ck-edit', 'edit') });
        controller.input('edit');
        await controller.saveNow();
        update.mockClear();

        await expect(controller.restore('this is on the host')).resolves.toBe(true);

        expect(update).not.toHaveBeenCalled();
        expect(discardBuffered).toHaveBeenCalledWith('ck-edit');
    });

    // Issue is tracked after a successful write. Failure leaves the change unwritten, so a retry
    // must send it again, or the host will keep the old status.
    it('sends issue again on the next attempt if it did not reach the host', async () => {
        const { controller, update } = setupEditComposer(true);
        update.mockResolvedValueOnce({ outcome: 'buffered', entry: editEntry('ck-edit', 'edit') });

        controller.setIssue(false);
        controller.input('edit');
        await controller.saveNow();
        expect(update.mock.calls[0]?.[2]).toBe(false);

        await controller.retry();

        expect(update.mock.calls[1]?.[2]).toBe(false);
    });
});
