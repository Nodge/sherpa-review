import type { CharRange } from './model.js';

/**
 * Word-level highlighting of changed pairs (docs/design/SPEC-elements.md §2.14). Pairing happens outside (in the hunk parser),
 * this only diffs two lines by token: words, whitespace runs and individual punctuation characters.
 *
 * A local LCS instead of a library: the algorithm for two lines takes thirty lines of code,
 * and avoids adding a UI dependency.
 */

/** Do not highlight longer lines: O(n·m) on a minified line would consume the worker. */
const MAX_LINE_LENGTH = 1000;

/** Protect against quadratic cost on a punctuation-only line (one character = one token). */
const MAX_MATRIX_CELLS = 250_000;

/** Below this similarity, the pair is "entirely changed": highlighting every other word is noise. */
const MIN_SIMILARITY = 0.3;

export interface WordDiff {
    old: CharRange[];
    new: CharRange[];
}

interface Token extends CharRange {
    text: string;
}

/** A word, a run of spaces or a single punctuation character. */
const TOKEN_RE = /[\p{L}\p{N}_$]+|\s+|[^\s]/gu;

/**
 * Ranges of changed fragments in a line pair. `null` means there is nothing worth highlighting:
 * the lines match, are too long or differ too much.
 */
export function diffWords(oldText: string, newText: string): WordDiff | null {
    if (oldText === newText) {
        return null;
    }
    if (oldText.length > MAX_LINE_LENGTH || newText.length > MAX_LINE_LENGTH) {
        return null;
    }

    const oldTokens = tokenize(oldText);
    const newTokens = tokenize(newText);
    if (oldTokens.length * newTokens.length > MAX_MATRIX_CELLS) {
        return null;
    }

    const matched = longestCommonSubsequence(oldTokens, newTokens);
    if (similarity(oldTokens, newTokens, matched) < MIN_SIMILARITY) {
        return null;
    }

    const oldRanges = unmatchedRanges(oldTokens, matched.old);
    const newRanges = unmatchedRanges(newTokens, matched.new);
    if (oldRanges.length === 0 && newRanges.length === 0) {
        return null;
    }
    return { old: oldRanges, new: newRanges };
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    for (const match of text.matchAll(TOKEN_RE)) {
        const from = match.index;
        tokens.push({ from, to: from + match[0].length, text: match[0] });
    }
    return tokens;
}

interface Matched {
    /** Indexes of matching tokens in each line. */
    old: Set<number>;
    new: Set<number>;
}

/**
 * The shared fraction of a line pair. Exclude whitespace: indentation almost always matches,
 * otherwise two lines with no shared words would look 40% similar.
 */
function similarity(oldTokens: readonly Token[], newTokens: readonly Token[], matched: Matched): number {
    const meaningful = (tokens: readonly Token[]): number => tokens.filter((token) => !isBlank(token)).length;
    const common = [...matched.old].filter((index) => {
        const token = oldTokens[index];
        return token !== undefined && !isBlank(token);
    }).length;

    const total = meaningful(oldTokens) + meaningful(newTokens);
    return total === 0 ? 0 : (2 * common) / total;
}

function isBlank(token: Token): boolean {
    return token.text.trim().length === 0;
}

/** Classic LCS with a length table and backtracking: we need the actual indexes of matching tokens. */
function longestCommonSubsequence(a: readonly Token[], b: readonly Token[]): Matched {
    const width = b.length + 1;
    const table = new Int32Array((a.length + 1) * width);

    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            const cell = i * width + j;
            table[cell] =
                a[i]?.text === b[j]?.text
                    ? (table[cell + width + 1] ?? 0) + 1
                    : Math.max(table[cell + width] ?? 0, table[cell + 1] ?? 0);
        }
    }

    const oldMatched = new Set<number>();
    const newMatched = new Set<number>();
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i]?.text === b[j]?.text) {
            oldMatched.add(i);
            newMatched.add(j);
            i += 1;
            j += 1;
        } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
            i += 1;
        } else {
            j += 1;
        }
    }

    return { old: oldMatched, new: newMatched };
}

/** Non-matching tokens merged into contiguous ranges. */
function unmatchedRanges(tokens: readonly Token[], matched: ReadonlySet<number>): CharRange[] {
    const ranges: CharRange[] = [];
    let open: CharRange | null = null;

    for (const [index, token] of tokens.entries()) {
        if (matched.has(index)) {
            open = null;
            continue;
        }
        if (open !== null && open.to === token.from) {
            open.to = token.to;
            continue;
        }
        open = { from: token.from, to: token.to };
        ranges.push(open);
    }
    return ranges;
}
