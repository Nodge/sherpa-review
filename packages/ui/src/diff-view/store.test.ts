import type { FileDiff } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import { describe, expect, it } from 'vitest';

import { FILE_EXPANSION_KEY } from './expand.js';
import type { DiffMode } from './store.js';
import { createDiffViewStore, fileCollapseReason, SPLIT_MIN_WIDTH } from './store.js';

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
        hostFileUrl: null,
        image: null,
    };
}

function generated(fileId: string): FileDiff {
    return { ...file(fileId), generated: true };
}

function modelWithGap(fileId: string): DiffFileModel {
    return {
        fileId,
        path: `src/${fileId}.ts`,
        oldPath: null,
        changeType: 'modify',
        language: 'ts',
        modeChange: null,
        additions: 1,
        deletions: 1,
        onlyAdditions: false,
        onlyDeletions: false,
        whitespaceOnly: false,
        malformed: false,
        content: {
            kind: 'text',
            blocks: [{ kind: 'gap', edge: 'leading', hiddenLines: 40, oldStart: 1, newStart: 1 }],
        },
    };
}


describe('diff view store', () => {
    it('derives read-state from the file itself when no progress records exist', () => {
        const store = createDiffViewStore({
            files: [file('a', true), file('b', false), file('c', null), generated('d')],
        });

        const { readState } = store.getSnapshot();
        expect([readState.get('a'), readState.get('b'), readState.get('c'), readState.get('d')].map(
            (state) => state?.state,
        )).toEqual(['read', 'unread', 'unread', 'read']);
    });

    it('keeps manual collapse and expansion in a separate persisted layer', () => {
        const target = file('a');
        const store = createDiffViewStore({ files: [target] });

        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        store.toggleFileCollapse('a');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map([['a', true]]));

        store.toggleFileCollapse('a');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map([['a', false]]));
    });

    it('replaces collapse choices in full when PR state arrives after store creation', () => {
        const target = file('a');
        const other = file('b');
        const store = createDiffViewStore({ files: [target, other] });
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        store.setCollapsePreferences(new Map([['a', true]]));
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
        expect(store.getSnapshot().collapseCollapsed).toEqual(new Set(['a']));
        expect(notified).toBe(1);

        // The same choices change nothing. Otherwise loading the map would rerender cards.
        store.setCollapsePreferences(new Map([['a', true]]));
        expect(notified).toBe(1);

        store.setCollapsePreferences(new Map([['b', false]]));
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapseCollapsed).toEqual(new Set());
        expect(store.getSnapshot().collapseExpanded).toEqual(new Set(['b']));
    });

    it('viewed collapse is temporary: clearing the mark restores the previous manual expansion', () => {
        const target = file('a');
        const store = createDiffViewStore({
            files: [target],
            collapsed: new Map([['a', false]]),
        });

        store.markViewed('a', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.toggleFileCollapse('a');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapseExpandedViewed).toEqual(new Set(['a']));

        store.markViewed('a', false);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapseExpanded).toEqual(new Set(['a']));
        expect(store.getSnapshot().collapseExpandedViewed).toEqual(new Set());
    });

    it('read from full coverage also collapses, partial does not', () => {
        const target = file('a');
        const store = createDiffViewStore({
            files: [target],
            progress: [{ fileId: 'a', viewed: false, seenRanges: [{ side: 'new', start: 1, end: 4 }] }],
        });

        expect(store.getSnapshot().readState.get('a')?.state).toBe('read');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');

        store.setProgress([{ fileId: 'a', viewed: false, seenRanges: [{ side: 'new', start: 1, end: 2 }] }]);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('partial');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
    });

    it('handles the generated-file default separately: manual expansion survives un-pin and returns to default', () => {
        const target = generated('d');
        const store = createDiffViewStore({ files: [target] });

        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('generated');
        store.toggleFileCollapse('d');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map([['d', false]]));

        store.markViewed('d', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.markViewed('d', false);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().readState.get('d')?.state).toBe('unread');

        store.toggleFileCollapse('d');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('generated');
        expect(store.getSnapshot().collapseExpanded).toEqual(new Set());
        expect(store.getSnapshot().collapsePreferences).toEqual(new Map());
    });

    it('manual collapse overrides the generated default, viewed overrides manual collapse', () => {
        const target = generated('d');
        const store = createDiffViewStore({
            files: [target],
            collapsed: new Map([['d', true]]),
        });

        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
        store.markViewed('d', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.markViewed('d', false);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('manual');
    });

    it('keeps collapse for >2000 lines as a separate layer over the file formula', () => {
        const target = { ...file('big'), additions: 2001 };
        const store = createDiffViewStore({ files: [target] });

        store.markViewed('big', true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBe('viewed');
        store.toggleFileCollapse('big');
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
        expect(store.getSnapshot().opened.has('big')).toBe(false);

        store.openFile('big');
        expect(store.getSnapshot().opened.has('big')).toBe(true);
        expect(fileCollapseReason(store.getSnapshot(), target)).toBeNull();
    });

    it('server progress overrides defaults: a cleared generated-file mark survives loading', () => {
        const store = createDiffViewStore({ files: [generated('d'), file('a')] });

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
        });

        expect(store.getSnapshot().readState.get('d')?.state).toBe('unread');
    });

    it('sets an optimistic mark and rolls back to the previous record', () => {
        const store = createDiffViewStore({ files: [file('a')] });

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
        });

        store.markViewed('a', true);
        expect(store.getSnapshot().progress.get('a')).toEqual({ fileId: 'a', viewed: true, seenRanges: ranges });

        // Clearing the mark restores the state derived from ranges, not "nothing read".
        store.markViewed('a', false);
        expect(store.getSnapshot().readState.get('a')?.state).toBe('partial');
    });

    it('preserves read-state object identity for other files when marking', () => {
        const store = createDiffViewStore({ files: [file('a'), file('b')] });
        const before = store.getSnapshot().readState.get('b');

        store.markViewed('a', true);

        expect(store.getSnapshot().readState.get('b')).toBe(before);
    });

    it('starts with the mode from settings and reports mode changes externally', () => {
        const changes: DiffMode[] = [];
        const store = createDiffViewStore({
            files: [],
            diffMode: 'split',
            onDiffModeChange: (mode) => changes.push(mode),
        });
        expect(store.getSnapshot().diffMode).toBe('split');

        store.setDiffMode('unified');
        expect(store.getSnapshot().diffMode).toBe('unified');
        // Repeating the same mode sends nothing: no PATCH is needed without a change.
        store.setDiffMode('unified');

        expect(changes).toEqual(['unified']);
    });

    it('starts in unified mode without an explicit mode', () => {
        expect(createDiffViewStore({ files: [] }).getSnapshot().diffMode).toBe('unified');
    });

    it('split is unavailable at narrow widths, while the user\'s choice is preserved', () => {
        const store = createDiffViewStore({ files: [] });
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

    it('stores expansion by gap control and direction, full expansion sets all', () => {
        const store = createDiffViewStore({ files: [file('a')] });
        const key = 'leading:1:1:40';

        store.expandGap('a', key, 'up');
        store.expandGap('a', key, 'up');
        expect(store.getSnapshot().expansion.get('a')?.get(key)).toEqual({ up: 40, down: 0, all: false });

        store.setModel('a', modelWithGap('a'));
        store.expandFile('a', ['clip:visible']);
        expect(store.getSnapshot().expansion.get('a')?.get(key)).toEqual({ up: 40, down: 0, all: true });
        expect(store.getSnapshot().expansion.get('a')?.get('clip:visible')?.all).toBe(true);
        expect(store.getSnapshot().expansion.get('a')?.get(FILE_EXPANSION_KEY)?.all).toBe(true);
    });

    it('extends selection in both directions and clears it', () => {
        const store = createDiffViewStore({ files: [file('a')] });

        store.beginSelection();
        store.startSelection('a', 'c40:42');
        store.extendSelection('a', 'a37');
        expect(store.getSnapshot()).toMatchObject({
            selection: { fileId: 'a', anchor: 'c40:42', focus: 'a37' },
            selectionDragging: true,
        });
        store.finishSelection();
        expect(store.getSnapshot().selectionDragging).toBe(false);

        // Selection in another file starts fresh, without spanning files.
        store.extendSelection('b', 'd12');
        expect(store.getSnapshot().selection).toMatchObject({ fileId: 'b', anchor: 'd12' });

        store.clearSelection();
        expect(store.getSnapshot().selection).toBeNull();
    });

    it('remembers whitespace-only line expansion outside FileCard', () => {
        const store = createDiffViewStore({ files: [file('a')] });

        store.showWhitespace('a');
        store.showWhitespace('a');

        expect(store.getSnapshot().whitespaceShown).toEqual(new Set(['a']));
    });

    it('notifies subscribers on every change and only on a change', () => {
        const store = createDiffViewStore({ files: [file('a')] });
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
