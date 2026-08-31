import type { Comment, Thread } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closePublishedComposers, composerControllerFor, createComposerController } from './composer.js';
import { openNewComposer, openReply } from './thread-list.tsx';
import { createThreadStore } from './store.js';

const CREATED: Comment = {
    id: 'draft-1',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
    body: 'first',
    draft: true,
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
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
    const save = vi.fn(() => Promise.resolve(CREATED));
    const update = vi.fn(() => Promise.resolve());
    const remove = vi.fn(() => Promise.resolve());
    const controller = createComposerController({ store, key: 'new:f1:new:10', transport: { save, update, delete: remove } });
    return { store, controller, save, update, remove };
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
        openReply(store, THREAD, null);
    }
    const save = vi.fn(() => Promise.resolve(CREATED));
    const update = vi.fn(() => Promise.resolve());
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

        expect(save).toHaveBeenCalledWith({
            body: 'first',
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            issue: true,
        });
    });

    it('passes issue disabled before the first save to save', async () => {
        const { controller, save } = setupIssueComposer('new');

        controller.setIssue(false);
        controller.input('no reply needed');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith(expect.objectContaining({ issue: false }));
    });

    it('changing issue after the first save reaches update through the same autosave', async () => {
        vi.useFakeTimers();
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();

        controller.setIssue(false);
        await vi.advanceTimersByTimeAsync(1000);

        expect(update).toHaveBeenCalledWith('draft-1', 'first', false);
    });

    it('autosaving text after create does not send issue again', async () => {
        vi.useFakeTimers();
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();

        controller.input('second');
        await vi.advanceTimersByTimeAsync(1000);

        expect(update.mock.calls).toEqual([['draft-1', 'second']]);
    });

    it('autosaving text after changing issue does not send it again', async () => {
        vi.useFakeTimers();
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();
        controller.setIssue(false);
        await vi.advanceTimersByTimeAsync(1000);

        controller.input('second');
        await vi.advanceTimersByTimeAsync(1000);

        expect(update.mock.calls).toEqual([
            ['draft-1', 'first', false],
            ['draft-1', 'second'],
        ]);
    });

    it('does not resend issue when it returns to the stored value', async () => {
        vi.useFakeTimers();
        const { controller, update } = setupIssueComposer('new');
        controller.input('first');
        await controller.saveNow();

        controller.setIssue(false);
        controller.setIssue(true);
        controller.input('second');
        await vi.advanceTimersByTimeAsync(1000);

        expect(update.mock.calls).toEqual([['draft-1', 'second']]);
    });

    it('a reply does not pass issue', async () => {
        const { controller, save } = setupIssueComposer('reply');

        controller.input('reply');
        await controller.saveNow();

        expect(save).toHaveBeenCalledWith({ body: 'reply', parentId: 'root-1', anchor: null });
    });

    it('debounces for 1s, calls save first and update afterward', async () => {
        vi.useFakeTimers();
        const { controller, save, update } = setup();

        controller.input('first');
        await vi.advanceTimersByTimeAsync(999);
        expect(save).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(save).toHaveBeenCalledTimes(1);

        controller.input('second');
        await vi.advanceTimersByTimeAsync(1000);
        expect(update).toHaveBeenCalledWith('draft-1', 'second');
    });

    it('Esc asks for inline confirmation and deletes the existing draft', async () => {
        const { store, controller, remove } = setup();
        controller.input('text');
        await controller.saveNow();

        controller.escape();
        expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        await controller.confirmDiscard();

        expect(remove).toHaveBeenCalledWith('draft-1');
        expect(store.getComposer('new:f1:new:10') !== null).toBe(false);
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

    it('does not close or automatically retry an ambiguous first save', async () => {
        vi.useFakeTimers();
        const { store, controller, save, remove } = setup();
        save.mockRejectedValueOnce(new Error('response lost'));
        controller.input('may have been saved');
        await controller.saveNow();
        expect(await controller.saveNow(true)).toBe(false);
        expect(save).toHaveBeenCalledTimes(1);
        controller.input('changed text');
        await vi.advanceTimersByTimeAsync(1000);
        expect(save).toHaveBeenCalledTimes(1);
        controller.input('');

        controller.escape();
        await Promise.resolve();

        expect(remove).not.toHaveBeenCalled();
        expect(store.getComposer('new:f1:new:10')?.status).toBe('error');
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
            saveUncertain: false,
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

    it('Esc with cleared text deletes the saved draft', async () => {
        const { store, controller, remove } = setup();
        controller.input('oops, wrong text');
        await controller.saveNow();
        controller.input('');

        controller.escape();
        await vi.waitFor(() => {
            expect(remove).toHaveBeenCalledWith('draft-1');
        });
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('completing an old save does not cancel the debounce for new text', async () => {
        vi.useFakeTimers();
        const { controller, save, update } = setup();
        const pendingSave = deferred<Comment>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('second');
        pendingSave.resolve(CREATED);
        await saving;
        await vi.advanceTimersByTimeAsync(1000);

        expect(update).toHaveBeenCalledWith('draft-1', 'second');
    });

    it('does not mark new text as saved when an earlier save responds', async () => {
        vi.useFakeTimers();
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<Comment>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('second');
        pendingSave.resolve(CREATED);
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'second', status: 'idle' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(update).toHaveBeenCalledWith('draft-1', 'second');
        expect(store.getComposer('new:f1:new:10')?.status).toBe('saved');
    });

    it('does not mark a cleared field as saved when an earlier save responds', async () => {
        vi.useFakeTimers();
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<Comment>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('');
        pendingSave.resolve(CREATED);
        await saving;
        await vi.advanceTimersByTimeAsync(1000);

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
            saveUncertain: false,
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
            saveUncertain: false,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const transport = {
            save: vi.fn(() => Promise.resolve(CREATED)),
            update: vi.fn(() => Promise.resolve()),
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
            saveUncertain: false,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const reopened = composerControllerFor({ store, key, transport });
        reopened.input('new text');

        expect(reopened).not.toBe(first);
        expect(store.getComposer(key)?.text).toBe('new text');
    });

    it('blocks publication after confirmed deletion until DELETE responds', async () => {
        const { store, controller, remove } = setup();
        const pendingDelete = deferred<undefined>();
        controller.input('delete');
        await controller.saveNow();
        remove.mockImplementationOnce(() => pendingDelete.promise);

        controller.escape();
        const discarding = controller.confirmDiscard();

        expect(store.getComposer('new:f1:new:10')?.status).toBe('discarding');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        pendingDelete.resolve(undefined);
        await expect(discarding).resolves.toBe(true);
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    it('a failed deletion leaves a deletion retry instead of a save retry', async () => {
        const { store, controller, remove } = setup();
        controller.input('delete');
        await controller.saveNow();
        controller.input('');
        remove.mockRejectedValueOnce(new Error('network'));

        controller.escape();
        await vi.waitFor(() => {
            expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        });
        await expect(controller.confirmDiscard()).resolves.toBe(true);

        expect(remove).toHaveBeenCalledTimes(2);
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('deletes the returned id without adding a draft when closed during the first save', async () => {
        const { store, controller, save, remove } = setup();
        const pendingSave = deferred<Comment>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('do not save');
        const saving = controller.saveNow();
        const discarding = controller.confirmDiscard();

        pendingSave.resolve(CREATED);
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
        const firstUpdate = deferred<undefined>();
        const lastUpdate = deferred<undefined>();
        update.mockImplementationOnce(() => firstUpdate.promise).mockImplementationOnce(() => lastUpdate.promise);

        controller.input('intermediate');
        void controller.saveNow();
        controller.input('latest');
        let completed = false;
        const savingLast = controller.saveNow(true).then((saved) => {
            completed = true;
            return saved;
        });

        firstUpdate.resolve(undefined);
        await vi.waitFor(() => {
            expect(update).toHaveBeenLastCalledWith('draft-1', 'last');
        });
        expect(completed).toBe(false);
        expect(store.getComposer('new:f1:new:10')).not.toBeNull();

        lastUpdate.resolve(undefined);
        await expect(savingLast).resolves.toBe(true);
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });

    it('restore waits for the active autosave and restores the original text in the final update', async () => {
        const { store, controller, update } = setup();
        controller.input('original');
        await controller.saveNow();
        const pendingUpdate = deferred<undefined>();
        update.mockImplementationOnce(() => pendingUpdate.promise);

        controller.input('broken');
        void controller.saveNow();
        const restoring = controller.restore('original');

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'original', status: 'saving' });
        pendingUpdate.resolve(undefined);
        await expect(restoring).resolves.toBe(true);

        expect(update.mock.calls).toEqual([
            ['draft-1', 'broken'],
            ['draft-1', 'original'],
        ]);
        expect(store.getSnapshot().threads[0]?.root.body).toBe('original');
        expect(store.getComposer('new:f1:new:10')).toBeNull();
    });
});
