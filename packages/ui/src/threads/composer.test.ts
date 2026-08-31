import type { Comment } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closePublishedComposers, composerControllerFor, createComposerController } from './composer.js';
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

afterEach(() => {
    vi.useRealTimers();
});

describe('composer state machine', () => {
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
        expect(update).toHaveBeenCalledWith('draft-1', 'second');
    });

    it('Cancel after saving closes the composer without deleting Comment', async () => {
        const { store, controller, update, remove } = setup();
        controller.input('text');
        await controller.saveNow();
        controller.input('change');

        controller.escape();
        expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        await controller.confirmDiscard();

        expect(update).toHaveBeenCalledWith('draft-1', 'text');
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

    it('does not close or automatically retry an ambiguous first save', async () => {
        vi.useFakeTimers();
        const { store, controller, save, remove } = setup();
        save.mockRejectedValueOnce(new Error('response lost'));
        controller.input('may have been saved');
        await controller.saveNow();
        expect(await controller.saveNow(true)).toBe(false);
        expect(save).toHaveBeenCalledTimes(1);
        controller.input('changed text');
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

    it('asks for confirmation on Esc with erased text and restores the saved text', async () => {
        const { store, controller, update, remove } = setup();
        controller.input('oops, wrong text');
        await controller.saveNow();
        controller.input('');

        controller.escape();
        expect(store.getComposer('new:f1:new:10')?.confirmDiscard).toBe(true);
        await controller.confirmDiscard();

        expect(store.getComposer('new:f1:new:10')).toBeNull();
        expect(update).toHaveBeenCalledWith('draft-1', 'oops, wrong text');
        expect(remove).not.toHaveBeenCalled();
    });

    it('leaves input entered during save unsaved until the next explicit action', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<Comment>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('second');
        pendingSave.resolve(CREATED);
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'second', status: 'idle' });
        expect(update).not.toHaveBeenCalled();
        await controller.saveNow();
        expect(update).toHaveBeenCalledWith('draft-1', 'second');
    });

    it('does not mark new text as saved when an earlier save responds', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<Comment>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('second');
        pendingSave.resolve(CREATED);
        await saving;

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'second', status: 'idle' });
        expect(update).not.toHaveBeenCalled();
    });

    it('does not mark a cleared field as saved when an earlier save responds', async () => {
        const { store, controller, save, update } = setup();
        const pendingSave = deferred<Comment>();
        save.mockImplementationOnce(() => pendingSave.promise);
        controller.input('first');
        const saving = controller.saveNow();

        controller.input('');
        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: '', status: 'saving' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        pendingSave.resolve(CREATED);
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

    it('waits for the active save in restore and restores the original text with the final update', async () => {
        const { store, controller, update } = setup();
        controller.input('original');
        await controller.saveNow();
        const pendingUpdate = deferred<undefined>();
        update.mockImplementationOnce(() => pendingUpdate.promise);

        controller.input('broken');
        void controller.saveNow();
        const restoring = controller.restore('original');

        expect(store.getComposer('new:f1:new:10')).toMatchObject({ text: 'broken', status: 'saving' });
        pendingUpdate.resolve(undefined);
        await expect(restoring).resolves.toBe(true);

        expect(update.mock.calls).toEqual([
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
