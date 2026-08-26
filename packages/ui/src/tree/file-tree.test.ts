import type { FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { FileReadState, ReadState } from '../progress/read-state.js';
import {
    buildFileTree,
    filterByQuery,
    isCollapsed,
    matchesQuery,
    readBox,
    readSummary,
    rowKey,
    splitLabel,
    toggleDirectory,
} from './file-tree.js';
import type { FileTreeInput, TreeDirRow, TreeFileRow } from './file-tree.js';

/** Ready-made progress state for tree rows. Tooltip counts are not checked here. */
function read(state: ReadState): FileReadState {
    return { state, seen: state === 'read' ? 12 : state === 'partial' ? 5 : 0, total: 12, pinned: false, generatedDefault: false, tooltip: 'tooltip' };
}

function file(path: string, patch: Partial<FileDiff> = {}): FileDiff {
    return {
        fileId: `f-${path}`,
        path,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 10,
        deletions: 2,
        patch: null,
        viewed: null,
        blameUrl: null,
        ...patch,
    };
}

function input(files: readonly FileDiff[], patch: Partial<FileTreeInput> = {}): FileTreeInput {
    return {
        files,
        pciFileIds: new Set(),
        mineFileIds: null,
        readState: new Map(),
        routeFiles: null,
        collapsed: new Map(),
        ...patch,
    };
}

const FILES = [
    file('services/orders/api/v3/handlers.ts'),
    file('services/orders/api/v3/schemas.ts'),
    file('services/orders/domain/order.ts'),
    file('gen/go/market/order.pb.go', { generated: true }),
    file('pnpm-lock.yaml'),
];

describe('buildFileTree', () => {
    it('collapses chains of directories with a single child', () => {
        const tree = buildFileTree(input(FILES));

        // The combined chain takes its root directory's alphabetical position
        // (`gen` before `market`), instead of moving to the end with top-level files.
        expect(tree.rows.map((row) => [row.kind, row.label, row.depth])).toEqual([
            ['file', 'gen/go/market/order.pb.go', 0],
            ['dir', 'services/orders', 0],
            ['dir', 'api/v3', 1],
            ['file', 'handlers.ts', 2],
            ['file', 'schemas.ts', 2],
            ['file', 'domain/order.ts', 1],
            ['file', 'pnpm-lock.yaml', 0],
        ]);
    });

    it('gives a directory its full path instead of the combined label', () => {
        const tree = buildFileTree(input(FILES));
        const dirs = tree.rows.filter((row): row is TreeDirRow => row.kind === 'dir');

        expect(dirs.map((row) => row.path)).toEqual(['services/orders', 'services/orders/api/v3']);
    });

    it('sums directory aggregates over the whole subtree', () => {
        const tree = buildFileTree(
            input([
                file('a/b/one.ts', { additions: 3, deletions: 1 }),
                file('a/c/two.ts', { additions: 4, deletions: 2 }),
            ]),
        );
        const root = tree.rows.find((row): row is TreeDirRow => row.kind === 'dir');

        expect(root).toMatchObject({ label: 'a', additions: 7, deletions: 3, files: 2 });
    });

    it('summarizes read state: all read → full, some → partial, none → none', () => {
        const files = [file('a/one.ts'), file('a/two.ts')];
        const dirOf = (readState: ReadonlyMap<string, FileReadState>): TreeDirRow => {
            const row = buildFileTree(input(files, { readState })).rows.find(
                (candidate): candidate is TreeDirRow => candidate.kind === 'dir',
            );
            if (row === undefined) {
                throw new Error('the tree has no directory');
            }
            return row;
        };

        expect(readSummary(dirOf(new Map()))).toBe('none');
        expect(readSummary(dirOf(new Map([['f-a/one.ts', read('read')]])))).toBe('partial');
        expect(
            readSummary(dirOf(new Map([['f-a/one.ts', read('read')], ['f-a/two.ts', read('read')]]))),
        ).toBe('full');
        // A partially read file does not count in the directory summary. Read means fully read.
        expect(readSummary(dirOf(new Map([['f-a/one.ts', read('partial')]])))).toBe('none');
    });

    it('gives file rows three read-state values', () => {
        const files = [file('a/one.ts'), file('a/two.ts'), file('a/three.ts')];
        const tree = buildFileTree(
            input(files, {
                readState: new Map([
                    ['f-a/one.ts', read('read')],
                    ['f-a/two.ts', read('partial')],
                ]),
            }),
        );

        expect(
            tree.rows.filter((row): row is TreeFileRow => row.kind === 'file').map((row) => [row.path, row.read.state]),
        ).toEqual([
            ['a/one.ts', 'read'],
            ['a/three.ts', 'unread'],
            ['a/two.ts', 'partial'],
        ]);
        expect([readBox('read'), readBox('partial'), readBox('unread')]).toEqual(['full', 'partial', 'none']);
    });

    it('treats a directory as generated when its whole subtree is generated', () => {
        const tree = buildFileTree(
            input([
                file('gen/a/one.ts', { generated: true }),
                file('gen/b/two.ts', { generated: true }),
                file('src/a/one.ts', { generated: true }),
                file('src/b/two.ts'),
            ]),
        );
        const dirs = tree.rows.filter((row): row is TreeDirRow => row.kind === 'dir');

        expect(dirs.map((row) => [row.label, row.generated])).toEqual([
            ['gen', true],
            ['src', false],
        ]);
    });

    it('marks roots outside the ownership zone only at the top level and with a known My files lens', () => {
        const files = [file('mine/a/one.ts'), file('mine/b/two.ts'), file('foreign/a/one.ts'), file('foreign/b/two.ts')];

        const withLens = buildFileTree(
            input(files, { mineFileIds: new Set(['f-mine/a/one.ts', 'f-mine/b/two.ts']) }),
        );
        expect(
            withLens.rows.filter((row): row is TreeDirRow => row.kind === 'dir').map((row) => [row.label, row.foreign]),
        ).toEqual([
            ['foreign', true],
            ['mine', false],
        ]);

        const withoutLens = buildFileTree(input(files));
        expect(
            withoutLens.rows.every((row) => row.kind !== 'dir' || !row.foreign),
        ).toBe(true);
    });

    it('collapses a directory with more than 20 children by default', () => {
        const many = Array.from({ length: 21 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const tree = buildFileTree(input([...many, file('small/one.ts'), file('small/two.ts')]));

        expect([...tree.bulkDirectories]).toEqual(['big']);
        expect(tree.rows.filter((row) => row.kind === 'file').map((row) => row.label)).toEqual([
            'one.ts',
            'two.ts',
        ]);
    });

    it('does not reach the threshold with exactly 20 children', () => {
        const many = Array.from({ length: 20 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const tree = buildFileTree(input(many));

        expect([...tree.bulkDirectories]).toEqual([]);
        expect(tree.rows.filter((row) => row.kind === 'file')).toHaveLength(20);
    });

    it('gives the explicit reviewer choice priority over the size-based default', () => {
        const many = Array.from({ length: 21 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const tree = buildFileTree(input(many, { collapsed: new Map([['big', false]]) }));

        expect(tree.rows.filter((row) => row.kind === 'file')).toHaveLength(21);
    });

    it('includes directories hidden by a collapsed ancestor in directories', () => {
        const tree = buildFileTree(
            input(
                [
                    file('a/b/one.ts'),
                    file('a/b/two.ts'),
                    file('a/c/three.ts'),
                    file('a/c/four.ts'),
                    file('a/five.ts'),
                ],
                { collapsed: new Map([['a', true]]) },
            ),
        );

        expect(tree.rows.map((row) => row.label)).toEqual(['a']);
        expect([...tree.directories].sort()).toEqual(['a', 'a/b', 'a/c']);
    });

    it('sets the pci tag by lens membership', () => {
        const tree = buildFileTree(input(FILES, { pciFileIds: new Set(['f-services/orders/domain/order.ts']) }));
        const tagged = tree.rows.filter((row) => row.kind === 'file' && row.pci).map((row) => row.path);

        expect(tagged).toEqual(['services/orders/domain/order.ts']);
    });
});

describe('toggleDirectory', () => {
    const tree = buildFileTree(input([file('a/b/one.ts'), file('a/b/two.ts'), file('a/c/three.ts'), file('a/c/four.ts')]));

    it('changes only the directory itself on a regular click', () => {
        const next = toggleDirectory(tree, new Map(), 'a', false);

        expect(next.get('a')).toBe(true);
        expect(next.has('a/b')).toBe(false);
    });

    it('applies the state to the subtree on ⌥-click', () => {
        const next = toggleDirectory(tree, new Map(), 'a', true);

        expect([...next.entries()].sort()).toEqual([
            ['a', true],
            ['a/b', true],
            ['a/c', true],
        ]);
    });

    it('expands descendants too on ⌥-click of a collapsed directory', () => {
        const collapsed = new Map([['a', true], ['a/b', true], ['a/c', true]]);
        const next = toggleDirectory(tree, collapsed, 'a', true);

        expect([...next.values()]).toEqual([false, false, false]);
    });

    it('accounts for the size-based default in isCollapsed', () => {
        const many = Array.from({ length: 21 }, (_, index) => file(`big/file-${String(index)}.ts`));
        const big = buildFileTree(input(many));

        expect(isCollapsed(big, new Map(), 'big')).toBe(true);
        expect(isCollapsed(big, new Map([['big', false]]), 'big')).toBe(false);
    });
});

describe('matchesQuery', () => {
    it('matches everything with an empty query', () => {
        expect(matchesQuery('src/a.ts', '')).toBe(true);
        expect(matchesQuery('src/a.ts', '   ')).toBe(true);
    });

    it('matches a substring anywhere in the path, ignoring case', () => {
        expect(matchesQuery('services/orders/api/handlers.ts', 'orders/api')).toBe(true);
        expect(matchesQuery('services/orders/api/handlers.ts', 'ORDERS')).toBe(true);
        expect(matchesQuery('services/orders/api/handlers.ts', 'billing')).toBe(false);
    });

    it('uses fuzzy matching only on the filename', () => {
        expect(matchesQuery('services/orders/api/handlers.ts', 'hdl')).toBe(true);
        expect(matchesQuery('services/orders/api/handlers.ts', 'hlred')).toBe(false);
        // Letters appear across directories but not in the name. The path must not be a fuzzy match.
        expect(matchesQuery('services/orders/api/order.ts', 'svoa')).toBe(false);
    });
});

describe('filterByQuery', () => {
    it('returns the original list object for an empty query', () => {
        const files = [file('a.ts')];
        expect(filterByQuery(files, ' ')).toBe(files);
    });

    it('returns an empty list when nothing matches', () => {
        expect(filterByQuery([file('a.ts')], 'zzz')).toEqual([]);
    });
});

describe('rowKey', () => {
    it('distinguishes a directory and a file with the same path', () => {
        // A file without an extension beside its directory: `src/a` and `src/a/b.ts` in one diff.
        const tree = buildFileTree(input([file('src/a'), file('src/a/b.ts'), file('src/a/c.ts')]));
        const keys = tree.rows.map(rowKey);

        expect(tree.rows.filter((row) => row.path === 'src/a')).toHaveLength(2);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('splitLabel', () => {
    it('separates the directory chain from the final segment and puts the separator with the name', () => {
        expect(splitLabel('services/orders/order.ts')).toEqual({ dir: 'services/orders', name: '/order.ts' });
    });

    it('returns a label without directories entirely as the name', () => {
        expect(splitLabel('pnpm-lock.yaml')).toEqual({ dir: '', name: 'pnpm-lock.yaml' });
    });
});
