import type { PrDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { indexDiff } from './diff-index.js';
import { mediumDiff } from './fixture-support.js';

/**
 * Hunk parsing: the validator must count line numbers exactly as the UI does
 * (`packages/ui/src/diff/parse.ts`). The model anchors to what the reviewer sees. Each
 * rule has its own patch here. A single offset error invalidates a valid anchor.
 */

const PATH = 'services/orders/src/infra/clock.ts';

/** Fixture diff with one file patch replaced, without rebuilding PrDiff from scratch. */
function diffWith(lines: readonly string[]): PrDiff {
    const diff = mediumDiff();
    return {
        ...diff,
        files: diff.files.map((file) => (file.path === PATH ? { ...file, patch: lines.join('\n') } : file)),
    };
}

function changed(lines: readonly string[]): { old: number[]; new: number[] } {
    const file = indexDiff(diffWith(lines)).get(PATH);
    return { old: [...(file?.old ?? [])], new: [...(file?.new ?? [])] };
}

const HEADERS = ['--- a/x.ts', '+++ b/x.ts'];

describe('changed line index: parses hunks the same way as the UI', () => {
    it('advances both sides for a context line with a leading space', () => {
        expect(changed([...HEADERS, '@@ -1,3 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;'])).toEqual({
            old: [2],
            new: [2],
        });
    });

    it('counts an empty line without a prefix as context because hosts trim trailing whitespace', () => {
        expect(
            changed([...HEADERS, '@@ -1,4 +1,4 @@', ' const a = 1;', '', '-const b = 2;', '+const b = 3;']),
        ).toEqual({ old: [3], new: [3] });
    });

    it('counts an unknown prefix as context without disrupting line numbers', () => {
        expect(
            changed([...HEADERS, '@@ -1,4 +1,4 @@', ' const a = 1;', '?garbage', '-const b = 2;', '+const b = 3;']),
        ).toEqual({ old: [3], new: [3] });
    });

    it('does not advance line numbers for the `\\ No newline at end of file` marker', () => {
        expect(
            changed([
                ...HEADERS,
                '@@ -1,2 +1,2 @@',
                ' const a = 1;',
                '-const b = 2;',
                '\\ No newline at end of file',
                '+const b = 3;',
            ]),
        ).toEqual({ old: [2], new: [2] });
    });

    it('limits the hunk body to header counts and excludes the tail from the index', () => {
        expect(changed([...HEADERS, '@@ -1,1 +1,1 @@', '-old', '+new', '+tail after the hunk'])).toEqual({
            old: [1],
            new: [1],
        });
    });

    it('counts one line per side for the short header `@@ -a +c @@`', () => {
        expect(changed([...HEADERS, '@@ -5 +5 @@', '-old', '+new'])).toEqual({ old: [5], new: [5] });
    });

    it('ends an incomplete hunk at the next header', () => {
        expect(
            changed([...HEADERS, '@@ -1,9 +1,9 @@', '-old', '@@ -20,1 +20,1 @@', '+new']),
        ).toEqual({ old: [1], new: [20] });
    });

    it('has no changed lines for a file without a text patch', () => {
        const file = indexDiff({
            ...mediumDiff(),
            files: mediumDiff().files.map((candidate) =>
                candidate.path === PATH ? { ...candidate, patch: null } : candidate,
            ),
        }).get(PATH);

        expect(file?.old.size).toBe(0);
        expect(file?.new.size).toBe(0);
    });
});
