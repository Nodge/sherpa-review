import { describe, expect, it } from 'vitest';

import type { PayloadFileSpec } from './payload-budget.js';
import { byteLength, fitPayloadFiles, fitText, truncateUtf8, unavailableBlock } from './payload-budget.js';

/**
 * Fits payloads within the budget (docs/protocol.md §4). The budget counts bytes, so every check
 * here uses bytes, not string length. Those differ for non-ASCII letters and emoji.
 */

/** Text that exceeds every test budget and loses no trailing content to trimEnd. */
const LONG = 'x'.repeat(5000);

describe('byte truncation', () => {
    it('truncates by bytes instead of characters without splitting two-byte letters', () => {
        // Each Greek letter is two bytes, so five bytes hold two letters.
        expect(truncateUtf8('αβγδεζ', 5)).toBe('αβ');
        expect(truncateUtf8('αβγδεζ', 3)).toBe('α');
        expect(byteLength(truncateUtf8('αβγδεζ', 5))).toBe(4);
    });

    it('returns all text at the exact boundary', () => {
        expect(truncateUtf8('abcdef', 6)).toBe('abcdef');
        expect(truncateUtf8('αβγδεζ', 12)).toBe('αβγδεζ');
        // One byte above the requested length still returns everything.
        expect(truncateUtf8('abcdef', 7)).toBe('abcdef');
    });

    it('keeps a surrogate pair intact: the emoji is either complete or absent', () => {
        // '😀' is four bytes and two code units. Half the pair "fits" within four bytes.
        expect(truncateUtf8('a😀b', 4)).toBe('a');
        expect(truncateUtf8('a😀b', 5)).toBe('a😀');
        expect(truncateUtf8('a😀b', 6)).toBe('a😀b');
    });

    it('returns an empty string for zero and negative limits', () => {
        expect(truncateUtf8('αβγδεζ', 0)).toBe('');
        expect(truncateUtf8('αβγδεζ', -10)).toBe('');
    });
});

describe('fitting text within a limit', () => {
    it('returns text that fits as is', () => {
        expect(fitText('abc', 10, 'FALLBACK')).toBe('abc');
        // The exact boundary also returns everything.
        expect(fitText('abc', 3, 'FALLBACK')).toBe('abc');
    });

    it('marks text that does not fit and keeps it within the limit', () => {
        const result = fitText(LONG, 300, 'FB');

        expect(result).toContain('[TRUNCATED: remaining content omitted by the payload budget.]');
        expect(result.startsWith('xxx')).toBe(true);
        expect(byteLength(result)).toBeLessThanOrEqual(300);
    });

    it('a limit smaller than the notice leaves a truncated fallback', () => {
        // The fallback itself exceeds the limit, so it gets truncated.
        expect(fitText(LONG, 10, 'FALLBACK-LONG')).toBe('FALLBACK-L');
        // The fallback is short, but the truncation notice does not fit the limit, so no text remains.
        expect(fitText(LONG, 20, 'FB')).toBe('FB');
    });

    it('a zero limit leaves nothing', () => {
        expect(fitText(LONG, 0, 'FB')).toBe('');
    });

    it('the notice replacing the content names the reason', () => {
        expect(unavailableBlock('PR diff', 'the diff is too large')).toBe(
            '# PR diff\n\n[TRUNCATED: the diff is too large]\n',
        );
    });
});

describe('fitting payload files into the budget', () => {
    /** A spec whose `render` always asks for more than it can get. */
    function greedy(name: string, order: number, minimum: string): PayloadFileSpec {
        return { name, order, minimum, render: () => LONG };
    }

    it('reserves budget for notices in files not yet built', () => {
        const first = 'A'.repeat(10);
        const second = 'B'.repeat(20);
        const third = 'C'.repeat(30);
        // Just above the sum of the notices (60): the first gets the surplus, the rest get exactly their minimum.
        const files = fitPayloadFiles(
            [greedy('first.md', 1, first), greedy('second.md', 2, second), greedy('third.md', 3, third)],
            260,
        );

        expect(byteLength(files[0]?.content ?? '')).toBe(210);
        expect(files[0]?.content).toContain('[TRUNCATED:');
        expect(files[1]?.content).toBe(second);
        expect(files[2]?.content).toBe(third);
        expect(files.reduce((total, file) => total + byteLength(file.content), 0)).toBe(260);
    });

    it('gives each file at least its notice when the budget covers their sum', () => {
        const minimums = ['A'.repeat(7), 'B'.repeat(64), 'C'.repeat(3), 'D'.repeat(120)];
        const specs = minimums.map((minimum, index) => greedy(`f${String(index)}.md`, index + 1, minimum));
        const total = minimums.reduce((sum, minimum) => sum + byteLength(minimum), 0);

        for (const budget of [total, total + 1, total + 500, total * 10]) {
            const files = fitPayloadFiles(specs, budget);
            for (const [index, file] of files.entries()) {
                expect(byteLength(file.content)).toBeGreaterThanOrEqual(byteLength(minimums[index] ?? ''));
            }
            expect(files.reduce((sum, file) => sum + byteLength(file.content), 0)).toBeLessThanOrEqual(budget);
        }
    });

    it('leaves earlier files empty when the budget is smaller than the sum of the notices', () => {
        const first = 'A'.repeat(10);
        const second = 'B'.repeat(10);

        const files = fitPayloadFiles([greedy('first.md', 1, first), greedy('second.md', 2, second)], 5);

        // Reserving the second file's notice eats the first file's entire budget. A degenerate but valid case.
        expect(files[0]?.content).toBe('');
        expect(files[1]?.content).toBe('BBBBB');
    });

    it('shrinks render output to the budget even if render ignored its limit', () => {
        const ignoring: PayloadFileSpec = { name: 'huge.md', order: 1, minimum: 'FB', render: () => LONG };

        const files = fitPayloadFiles([ignoring], 400);

        expect(byteLength(files[0]?.content ?? '')).toBeLessThanOrEqual(400);
        expect(files[0]?.content).toContain('[TRUNCATED:');
    });

    it('passes the remaining budget to render instead of the entire budget', () => {
        const seen: number[] = [];
        const specs: PayloadFileSpec[] = [
            {
                name: 'first.md',
                order: 1,
                minimum: 'A'.repeat(10),
                render: (maxBytes) => {
                    seen.push(maxBytes);
                    return 'a'.repeat(50);
                },
            },
            {
                name: 'second.md',
                order: 2,
                minimum: 'B'.repeat(10),
                render: (maxBytes) => {
                    seen.push(maxBytes);
                    return 'b';
                },
            },
        ];

        fitPayloadFiles(specs, 100);

        // The first gets the budget minus the second notice. The second gets what remains after the first.
        expect(seen).toEqual([90, 50]);
    });

    it('preserves names, field order and array order', () => {
        const files = fitPayloadFiles(
            [greedy('b.md', 7, 'FB'), greedy('a.md', 3, 'FB'), greedy('c.md', 1, 'FB')],
            1000,
        );

        expect(files.map((file) => file.name)).toEqual(['b.md', 'a.md', 'c.md']);
        expect(files.map((file) => file.order)).toEqual([7, 3, 1]);
    });

    it('treats a negative budget as zero', () => {
        const specs = [greedy('a.md', 1, 'FB')];

        expect(fitPayloadFiles(specs, -100)).toEqual(fitPayloadFiles(specs, 0));
        expect(fitPayloadFiles(specs, -100)[0]?.content).toBe('');
    });

    it('returns an empty result for an empty spec list', () => {
        expect(fitPayloadFiles([], 1000)).toEqual([]);
    });
});
