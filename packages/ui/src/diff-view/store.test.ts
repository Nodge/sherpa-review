import type { FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { createDiffViewStore, SPLIT_MIN_WIDTH } from './store.js';

/** Diff view state: mode, width, marks, context expansion, and selection. */

function file(fileId: string, viewed: boolean | null = false): FileDiff {
    return {
        fileId,
        path: `src/${fileId}.ts`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 3,
        deletions: 1,
        patch: null,
        viewed,
        blameUrl: null,
    };
}

function memoryStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem'> & { value: string | null } {
    return {
        value: initial ?? null,
        getItem(): string | null {
            return this.value;
        },
        setItem(_key: string, next: string): void {
            this.value = next;
        },
    };
}

describe('diff view store', () => {
    it('takes initial marks from the host diff', () => {
        const store = createDiffViewStore({ files: [file('a', true), file('b', false), file('c', null)], storage: null });

        const { viewed } = store.getSnapshot();
        expect([viewed.get('a'), viewed.get('b'), viewed.get('c')]).toEqual([true, false, false]);
    });

    it('persists the diff mode and restores it from storage', () => {
        const storage = memoryStorage();
        const store = createDiffViewStore({ files: [], storage });
        expect(store.getSnapshot().diffMode).toBe('unified');

        store.setDiffMode('split');
        expect(storage.value).toBe('split');
        expect(createDiffViewStore({ files: [], storage }).getSnapshot().diffMode).toBe('split');
    });

    it('split is unavailable at narrow widths, while the user\'s choice is preserved', () => {
        const store = createDiffViewStore({ files: [], storage: null });
        store.setDiffMode('split');

        store.setAvailableWidth(SPLIT_MIN_WIDTH - 1);
        expect(store.getSnapshot()).toMatchObject({
            diffMode: 'split',
            splitAvailable: false,
            effectiveMode: 'unified',
        });

        store.setAvailableWidth(SPLIT_MIN_WIDTH);
        expect(store.getSnapshot().effectiveMode).toBe('split');
    });

    it('each context click adds a step, and all overrides it', () => {
        const store = createDiffViewStore({ files: [file('a')], storage: null });

        store.expand('a');
        store.expand('a');
        expect(store.getSnapshot().expansion.get('a')).toBe(40);

        store.expand('a', 'all');
        store.expand('a');
        expect(store.getSnapshot().expansion.get('a')).toBe('all');
    });

    it('extends selection in both directions and clears it', () => {
        const store = createDiffViewStore({ files: [file('a')], storage: null });

        store.startSelection('a', 'c40:42');
        store.extendSelection('a', 'a37');
        expect(store.getSnapshot().selection).toEqual({ fileId: 'a', anchor: 'c40:42', focus: 'a37' });

        // Selection in another file starts fresh, without spanning files.
        store.extendSelection('b', 'd12');
        expect(store.getSnapshot().selection).toMatchObject({ fileId: 'b', anchor: 'd12' });

        store.clearSelection();
        expect(store.getSnapshot().selection).toBeNull();
    });

    it('notifies subscribers on every change and only on a change', () => {
        const store = createDiffViewStore({ files: [file('a')], storage: null });
        let calls = 0;
        const stop = store.subscribe(() => {
            calls += 1;
        });

        store.setViewed('a', true);
        store.clearSelection();
        expect(calls).toBe(1);

        stop();
        store.setViewed('a', false);
        expect(calls).toBe(1);
    });
});
