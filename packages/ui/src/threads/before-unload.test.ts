import type { DraftBufferEntry } from '@sherpa/protocol';
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
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

/** Buffer entry with this text: exactly what is already on the server. */
function bufferEntry(body: string): DraftBufferEntry {
    return {
        id: 'ck-1',
        draft: { body, parentId: null, anchor: null },
        commentId: null,
        state: 'failed',
        error: 'host is down',
        attempts: 1,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
    };
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

    // Buffered text is already on the server (M5-T15), so leaving is safe and needs no dialog.
    it('does not prevent leaving because of a draft in the server buffer', () => {
        const store = createThreadStore([], new Set());
        const addEventListener = vi.fn();
        const removeEventListener = vi.fn();
        const detach = attachComposerBeforeUnload(store, { addEventListener, removeEventListener });
        openComposer(store);

        store.updateComposer('new:pr', { text: 'will save later' });
        expect(addEventListener).toHaveBeenCalledOnce();

        store.updateComposer('new:pr', { status: 'buffered', bufferEntry: bufferEntry('will save later') });
        expect(removeEventListener).toHaveBeenCalledOnce();

        // Text added after the failure is not on the server yet. Leaving would lose work, so a dialog is needed.
        store.updateComposer('new:pr', { text: 'will save later and another paragraph' });
        expect(addEventListener).toHaveBeenCalledTimes(2);
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
