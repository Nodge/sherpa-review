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

function generated(fileId: string): FileDiff {
    return { ...file(fileId), generated: true };
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
    it('derives read-state from the file itself when no progress records exist', () => {
        const store = createDiffViewStore({
            files: [file('a', true), file('b', false), file('c', null), generated('d')],
            storage: null,
        });

        const { readState } = store.getSnapshot();
        expect([readState.get('a'), readState.get('b'), readState.get('c'), readState.get('d')].map(
            (state) => state?.state,
        )).toEqual(['read', 'unread', 'unread', 'read']);
    });

    it('server progress overrides defaults: a cleared generated-file mark survives loading', () => {
        const store = createDiffViewStore({ files: [generated('d'), file('a')], storage: null });

        store.setProgress([
            { fileId: 'd', viewed: false, seenRanges: [] },
            { fileId: 'a', viewed: true, seenRanges: [] },
        ]);

        const { readState } = store.getSnapshot();
        expect([readState.get('d')?.state, readState.get('a')?.state]).toEqual(['unread', 'read']);
    });

    it('receives initial progress in the constructor', () => {
        const store = createDiffViewStore({
            files: [generated('d')],
            progress: [{ fileId: 'd', viewed: false, seenRanges: [] }],
            storage: null,
        });

        expect(store.getSnapshot().readState.get('d')?.state).toBe('unread');
    });

    it('sets an optimistic mark and rolls back to the previous record', () => {
        const store = createDiffViewStore({ files: [file('a')], storage: null });

        store.markViewed('a', true);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('read');
        expect(store.getSnapshot().progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: [] });

        // No record existed before the mark. Rollback must remove it, without leaving `viewed: false`.
        store.restoreProgress('a', null);
        expect(store.getSnapshot().progress.has('a')).toBe(false);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('unread');

        store.markViewed('a', true);
        store.restoreProgress('a', { fileId: 'a', viewed: false, seenRanges: [] });
        expect(store.getSnapshot().progress.get('a')).toEqual({ fileId: 'a', viewed: false, seenRanges: [] });
    });

    it('marking changes only the flag and preserves the record\'s ranges', () => {
        const ranges = [{ side: 'new' as const, start: 1, end: 2 }];
        const store = createDiffViewStore({
            files: [file('a')],
            progress: [{ fileId: 'a', viewed: false, seenRanges: ranges }],
            storage: null,
        });

        store.markViewed('a', true);
        expect(store.getSnapshot().progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: ranges });

        // Clearing the mark restores the state derived from ranges, not "nothing read".
        store.markViewed('a', false);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('partial');
    });

    it('preserves read-state object identity for other files when marking', () => {
        const store = createDiffViewStore({ files: [file('a'), file('b')], storage: null });
        const before = store.getSnapshot().readState.get('b');

        store.markViewed('a', true);

        expect(store.getSnapshot().readState.get('b')).toBe(before);
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

    it('remembers whitespace-only line expansion outside FileCard', () => {
        const store = createDiffViewStore({ files: [file('a')], storage: null });

        store.showWhitespace('a');
        store.showWhitespace('a');

        expect(store.getSnapshot().whitespaceShown).toEqual(new Set(['a']));
    });

    it('notifies subscribers on every change and only on a change', () => {
        const store = createDiffViewStore({ files: [file('a')], storage: null });
        let calls = 0;
        const stop = store.subscribe(() => {
            calls += 1;
        });

        store.markViewed('a', true);
        store.clearSelection();
        expect(calls).toBe(1);

        stop();
        store.markViewed('a', false);
        expect(calls).toBe(1);
    });
});
