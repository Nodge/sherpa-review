import { fixtureIteration } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { inTreeOrder, withTreeOrder } from './file-order.js';
import { buildFileTree } from './file-tree.js';

/** UI file order matches the tree: directories before files at each level, both groups alphabetical. */

function order(paths: readonly string[]): string[] {
    return inTreeOrder(paths.map((path) => ({ path }))).map((file) => file.path);
}

describe('file order', () => {
    it('puts directories before files at each level', () => {
        expect(order(['src/z.ts', 'src/lib/b.ts', 'a.ts', 'src/a.ts', 'docs/readme.md'])).toEqual([
            'docs/readme.md',
            'src/lib/b.ts',
            'src/a.ts',
            'src/z.ts',
            'a.ts',
        ]);
    });

    it('puts a root file after all root directories', () => {
        expect(order(['pnpm-lock.yaml', 'b/x.ts', 'a/y.ts'])).toEqual(['a/y.ts', 'b/x.ts', 'pnpm-lock.yaml']);
    });

    it('puts the directory first when a file and directory share a name', () => {
        expect(order(['src/a', 'src/a/b.ts'])).toEqual(['src/a/b.ts', 'src/a']);
        expect(order(['src/a/b.ts', 'src/a'])).toEqual(['src/a/b.ts', 'src/a']);
    });

    it('sorts each group alphabetically using the tree comparison', () => {
        expect(order(['src/b.ts', 'src/B2.ts', 'src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts', 'src/B2.ts']);
    });

    it('matches tree file order even when the host supplies a different order', () => {
        const diff = fixtureIteration('medium').diff;
        const every = new Map<string, boolean>();
        for (const file of diff.files) {
            const segments = file.path.split('/');
            for (let index = 1; index < segments.length; index += 1) {
                every.set(segments.slice(0, index).join('/'), false);
            }
        }
        const tree = buildFileTree({
            files: diff.files,
            pciFileIds: new Set(),
            mineFileIds: null,
            readState: new Map(),
            routeFiles: null,
            collapsed: every,
        });
        const treePaths = tree.rows.flatMap((row) => (row.kind === 'file' ? [row.path] : []));

        expect(diff.files.map((file) => file.path)).not.toEqual(treePaths);
        expect(withTreeOrder(diff).files.map((file) => file.path)).toEqual(treePaths);
    });
});
