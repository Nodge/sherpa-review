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
});
