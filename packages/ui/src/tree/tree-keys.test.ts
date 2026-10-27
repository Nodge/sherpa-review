import { describe, expect, it } from 'vitest';

import { readStateOf } from '../progress/read-state.js';
import type { TreeRow } from './file-tree.js';
import { treeKeyCommand } from './tree-keys.js';

function dir(path: string, depth: number, collapsed = false): TreeRow {
    return {
        kind: 'dir',
        path,
        label: path,
        depth,
        additions: 0,
        deletions: 0,
        files: 1,
        readFiles: 0,
        generated: false,
        foreign: false,
        collapsed,
    };
}

function file(path: string, depth: number): TreeRow {
    return {
        kind: 'file',
        path,
        label: path,
        depth,
        fileId: `f-${path}`,
        additions: 1,
        deletions: 0,
        generated: false,
        hostFileUrl: null,
        blameUrl: null,
        conflict: false,
        auditTag: null,
        read: readStateOf({ file: { generated: false, viewed: null, additions: 1, deletions: 0 }, record: null }),
        route: null,
    };
}

//  0 a            (dir, expanded)
//  1   a/one.ts
//  2   a/b        (dir, collapsed)
//  3 c/two.ts
const ROWS: readonly TreeRow[] = [dir('a', 0), file('a/one.ts', 1), dir('a/b', 1, true), file('c/two.ts', 0)];

describe('treeKeyCommand', () => {
    it('moves ↓ and ↑ through visible rows and stops at the edges', () => {
        expect(treeKeyCommand('ArrowDown', ROWS, 0)).toEqual({ kind: 'focus', index: 1 });
        expect(treeKeyCommand('ArrowDown', ROWS, 3)).toEqual({ kind: 'focus', index: 3 });
        expect(treeKeyCommand('ArrowUp', ROWS, 2)).toEqual({ kind: 'focus', index: 1 });
        expect(treeKeyCommand('ArrowUp', ROWS, 0)).toEqual({ kind: 'focus', index: 0 });
    });

    it('moves to the first row on any arrow key when nothing is selected', () => {
        expect(treeKeyCommand('ArrowDown', ROWS, -1)).toEqual({ kind: 'focus', index: 0 });
        expect(treeKeyCommand('ArrowUp', ROWS, -1)).toEqual({ kind: 'focus', index: 0 });
        expect(treeKeyCommand('ArrowRight', ROWS, -1)).toEqual({ kind: 'focus', index: 0 });
        expect(treeKeyCommand('ArrowLeft', ROWS, -1)).toEqual({ kind: 'focus', index: 0 });
    });

    it('expands a collapsed directory with → and moves to the first child of an expanded one', () => {
        expect(treeKeyCommand('ArrowRight', ROWS, 2)).toEqual({
            kind: 'setCollapsed',
            path: 'a/b',
            collapsed: false,
        });
        expect(treeKeyCommand('ArrowRight', ROWS, 0)).toEqual({ kind: 'focus', index: 1 });
    });

    it('does nothing on → on a file', () => {
        expect(treeKeyCommand('ArrowRight', ROWS, 1)).toBeNull();
    });

    it('collapses an expanded directory with ←', () => {
        expect(treeKeyCommand('ArrowLeft', ROWS, 0)).toEqual({
            kind: 'setCollapsed',
            path: 'a',
            collapsed: true,
        });
    });

    it('moves from a file or collapsed directory to its parent with ←', () => {
        expect(treeKeyCommand('ArrowLeft', ROWS, 1)).toEqual({ kind: 'focus', index: 0 });
        expect(treeKeyCommand('ArrowLeft', ROWS, 2)).toEqual({ kind: 'focus', index: 0 });
    });

    it('has nowhere to go on ← at the top level', () => {
        expect(treeKeyCommand('ArrowLeft', ROWS, 3)).toBeNull();
    });

    it('opens a file and toggles a directory with ⏎', () => {
        expect(treeKeyCommand('Enter', ROWS, 1)).toEqual({ kind: 'open', fileId: 'f-a/one.ts' });
        expect(treeKeyCommand('Enter', ROWS, 0)).toEqual({ kind: 'setCollapsed', path: 'a', collapsed: true });
        expect(treeKeyCommand('Enter', ROWS, 2)).toEqual({ kind: 'setCollapsed', path: 'a/b', collapsed: false });
    });

    it('ignores unrelated keys and an empty tree', () => {
        expect(treeKeyCommand('a', ROWS, 0)).toBeNull();
        expect(treeKeyCommand('ArrowDown', [], 0)).toBeNull();
    });
});
