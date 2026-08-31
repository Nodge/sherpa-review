import { describe, expect, it, vi } from 'vitest';

import { attachComposerBeforeUnload } from './before-unload.js';
import { createThreadStore } from './store.js';

function openComposer(store: ReturnType<typeof createThreadStore>): void {
    store.openComposer({
        key: 'new:pr',
        threadId: null,
        parentId: null,
        anchor: null,
        text: '',
        commentId: null,
        status: 'idle',
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

describe('warning before leaving', () => {
    it('attaches a listener only while there are unsaved changes', () => {
        const store = createThreadStore([], new Set());
        const addEventListener = vi.fn();
        const removeEventListener = vi.fn();
        const detach = attachComposerBeforeUnload(store, { addEventListener, removeEventListener });
        openComposer(store);

        store.updateComposer('new:pr', { text: 'draft' });
        expect(addEventListener).toHaveBeenCalledOnce();

        store.updateComposer('new:pr', { commentId: 'draft-1', status: 'saved' });
        expect(removeEventListener).toHaveBeenCalledOnce();

        store.updateComposer('new:pr', { text: 'edited draft', status: 'idle' });
        expect(addEventListener).toHaveBeenCalledTimes(2);

        store.closeComposer('new:pr');
        expect(removeEventListener).toHaveBeenCalledTimes(2);
        detach();
    });

    it('cancels beforeunload with the standard browser dialog', () => {
        const store = createThreadStore([], new Set());
        const listeners: ((event: BeforeUnloadEvent) => void)[] = [];
        attachComposerBeforeUnload(store, {
            addEventListener: (_type, next) => {
                listeners.push(next);
            },
            removeEventListener: () => undefined,
        });
        openComposer(store);
        store.updateComposer('new:pr', { text: 'keep this' });
        const preventDefault = vi.fn();
        const event = { preventDefault, returnValue: undefined as string | undefined };

        listeners[0]?.(event as unknown as BeforeUnloadEvent);

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(event.returnValue).toBe('');
    });
});
