import type { FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { lineSideInDiff, searchDiff } from './diff-search.js';

function file(patch: string | null): FileDiff {
    return {
        fileId: 'f-one',
        path: 'src/one.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 2,
        deletions: 1,
        patch,
        viewed: null,
        blameUrl: null,
    };
}

const PATCH = [
    'diff --git a/src/one.ts b/src/one.ts',
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -10,3 +20,3 @@ export function run()',
    ' const orderId = request.id;',
    '-dropOldCache(orderId);',
    '+dropNewCache(orderId);',
    ' return orderId;',
].join('\n');

describe('searchDiff', () => {
    it('calculates sides and line numbers from the hunk header', () => {
        const result = searchDiff([file(PATCH)], 'cache');

        expect(result).toEqual({
            truncated: false,
            matches: [
                expect.objectContaining({ side: 'old', line: 11, text: 'dropOldCache(orderId);' }),
                expect.objectContaining({ side: 'new', line: 21, text: 'dropNewCache(orderId);' }),
            ],
        });
    });

    it('addresses a context line on the new side', () => {
        const [match] = searchDiff([file(PATCH)], 'request.id').matches;
        expect(match).toMatchObject({ side: 'new', line: 20, text: 'const orderId = request.id;' });
    });

    it('treats a bare empty line as context, like the canonical parser', () => {
        const malformed = ['@@ -10,4 +20,4 @@', ' first', '', '-oldTarget', '+newTarget'].join('\n');

        expect(searchDiff([file(malformed)], 'target').matches).toEqual([
            expect.objectContaining({ side: 'old', line: 12, text: 'oldTarget' }),
            expect.objectContaining({ side: 'new', line: 22, text: 'newTarget' }),
        ]);
    });

    it('treats an unknown prefix as context, like the canonical parser', () => {
        const malformed = ['@@ -10,4 +20,4 @@', ' first', '?broken', '-oldTarget', '+newTarget'].join('\n');

        expect(searchDiff([file(malformed)], 'target').matches).toEqual([
            expect.objectContaining({ side: 'old', line: 12, text: 'oldTarget' }),
            expect.objectContaining({ side: 'new', line: 22, text: 'newTarget' }),
        ]);
    });

    it('chooses the actual side of a line and prefers the new side for context', () => {
        const deleted = { ...file(['@@ -40,1 +40,0 @@', '-gone'].join('\n')), changeType: 'delete' as const };
        const context = file(['@@ -40,1 +50,1 @@', ' same'].join('\n'));

        expect(lineSideInDiff(deleted, 40)).toBe('old');
        expect(lineSideInDiff(deleted, 41)).toBeNull();
        expect(lineSideInDiff(context, 50)).toBe('new');
    });

    it('does not match @@ headers or patch metadata lines', () => {
        expect(searchDiff([file(PATCH)], 'export function').matches).toEqual([]);
        expect(searchDiff([file(PATCH)], 'diff --git').matches).toEqual([]);
    });

    it('reports when results hit the limit', () => {
        const many = ['@@ -1,4 +1,4 @@', ' hit', '+hit', '-hit', ' hit'].join('\n');
        const result = searchDiff([file(many)], 'hit', 2);

        expect(result.matches).toHaveLength(2);
        expect(result.truncated).toBe(true);
    });

    it('returns no results for a null patch or an empty query', () => {
        expect(searchDiff([file(null)], 'x')).toEqual({ matches: [], truncated: false });
        expect(searchDiff([file(PATCH)], ' ')).toEqual({ matches: [], truncated: false });
    });
});
