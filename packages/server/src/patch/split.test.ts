import { describe, expect, it } from 'vitest';

import { countPatchStats, splitPatchByFile } from './split.js';

describe('splitting a patch by file', () => {
    it('parses unquoted paths', () => {
        const chunks = splitPatchByFile(['diff --git a/src/app.ts b/src/app.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'));

        expect([...chunks.keys()]).toEqual(['src/app.ts']);
    });

    // Real `git diff` does not escape spaces in paths, so the header is parsed using known paths.
    it('recognises an unquoted path with a space using the requested path list', () => {
        const patch = [
            'diff --git a/docs/Sherpa Additions.dc.html b/docs/Sherpa Additions.dc.html',
            '--- a/docs/Sherpa Additions.dc.html',
            '+++ b/docs/Sherpa Additions.dc.html',
            '@@ -1 +1 @@',
            '-before',
            '+after',
            '',
            'diff --git a/docs/Sherpa.dc.html b/docs/Sherpa.dc.html',
            'deleted file mode 100644',
            '--- a/docs/Sherpa.dc.html',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-before',
        ].join('\n');
        // List order does not matter: the short path is a prefix of the long one.
        const known = ['docs/Sherpa.dc.html', 'docs/Sherpa Additions.dc.html'];

        expect([...splitPatchByFile(patch, known).keys()]).toEqual([
            'docs/Sherpa Additions.dc.html',
            'docs/Sherpa.dc.html',
        ]);
    });

    it('splits a path at a header space without a path list, which is why the list is needed', () => {
        const patch = ['diff --git a/docs/with space.md b/docs/with space.md', '@@ -1 +1 @@', '-a', '+b'].join('\n');

        expect([...splitPatchByFile(patch).keys()]).not.toContain('docs/with space.md');
    });

    it('handles quoted escapes: spaces, quotes and octal UTF-8 bytes', () => {
        const nonAscii = [...new TextEncoder().encode('café.md')]
            .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
            .join('');
        const patch = [
            `diff --git "a/docs/with space.md" "b/docs/with space.md"`,
            '@@ -1 +1 @@',
            '-a',
            '+b',
            `diff --git "a/docs/${nonAscii}" "b/docs/${nonAscii}"`,
            '@@ -1 +1 @@',
            '-c',
            '+d',
            String.raw`diff --git "a/docs/\"quoted\".md" "b/docs/\"quoted\".md"`,
            '@@ -1 +1 @@',
            '-a',
            '+b',
        ].join('\n');

        expect([...splitPatchByFile(patch).keys()]).toEqual([
            'docs/with space.md',
            'docs/café.md',
            'docs/"quoted".md',
        ]);
    });

    it('keeps the source file patch separate from a copy', () => {
        // One diff set: the file was copied to copy.ts and also modified. Both pieces claim
        // the app.ts key, which must belong to the piece with app.ts on the right, in either order.
        const copyChunk = ['diff --git a/src/app.ts b/src/copy.ts', '@@ -0,0 +1 @@', '+copy'];
        const modifyChunk = ['diff --git a/src/app.ts b/src/app.ts', '@@ -1 +1 @@', '-before', '+after'];

        for (const order of [
            [...copyChunk, ...modifyChunk],
            [...modifyChunk, ...copyChunk],
        ]) {
            const chunks = splitPatchByFile(order.join('\n'), ['src/app.ts', 'src/copy.ts']);

            expect(chunks.get('src/app.ts')).toContain('+after');
            expect(chunks.get('src/copy.ts')).toContain('+copy');
        }
    });

    it('returns an empty map for an empty patch', () => {
        expect(splitPatchByFile('').size).toBe(0);
    });

    // Splitting runs synchronously on the server's only thread, so its cost must grow
    // linearly with the file count. Each header side is found by scanning the header itself instead of
    // trying every known path. Measured on this machine: 2000 files took 4 ms with linear
    // splitting versus 562 ms with exhaustive matching. The threshold leaves room for a slower machine.
    it('splits a 2000-file patch in linear time', () => {
        const paths = Array.from(
            { length: 2000 },
            (_, index) => `src/file-${String(index)}.ts`,
        );
        const patch = paths
            .map((path) =>
                [
                    `diff --git a/${path} b/${path}`,
                    `--- a/${path}`,
                    `+++ b/${path}`,
                    '@@ -1 +1 @@',
                    '-before',
                    '+after',
                ].join('\n'),
            )
            .join('\n');

        const started = performance.now();
        const chunks = splitPatchByFile(patch, paths);

        expect(chunks.size).toBe(paths.length);
        expect(performance.now() - started).toBeLessThan(300);
    });
});

describe('patch line counts', () => {
    it('counts `+++ text` inside a hunk as an addition, not a header', () => {
        const patch = [
            'diff --git a/a.md b/a.md',
            '--- a/a.md',
            '+++ b/a.md',
            '@@ -1,1 +1,2 @@',
            ' text',
            '+++ underline',
            '--- before',
        ].join('\n');

        expect(countPatchStats(patch)).toEqual({ additions: 1, deletions: 1 });
    });
});
