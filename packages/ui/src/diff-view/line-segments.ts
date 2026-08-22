import type { DiffLine, SyntaxKind } from '../diff/model.js';

/**
 * Splits a diff line into segments for rendering: syntax highlighting, word-level highlighting of a pair
 * (SPEC §2.14), tabs shown as four spaces, and trailing whitespace blocks on added lines.
 *
 * Tabs expand within a segment, without changing the source text. Otherwise offsets calculated
 * by the parser from the raw line would no longer match what is on screen.
 */

/** Beyond this length markup is not worth the cost: skips highlighting without truncating text. */
const MARKUP_LIMIT = 4000;

const TAB = '    ';

export interface LineSegment {
    readonly text: string;
    /** null means the segment has no category: plain code. */
    readonly kind: SyntaxKind | null;
    /** The segment falls within word-level highlighting of a changed pair. */
    readonly word: boolean;
    /** Trailing whitespace on an added line, displayed as a block (SPEC §2.14). */
    readonly trailing: boolean;
}

function expandTabs(text: string): string {
    return text.includes('\t') ? text.replaceAll('\t', TAB) : text;
}

/** The line contains a tab: the card adds `title`, because it looks like spaces on screen. */
export function hasTabs(line: DiffLine): boolean {
    return line.text.includes('\t');
}

/** Length of trailing spaces to display as a block. Zero means there is nothing to display. */
function trailingLength(line: DiffLine): number {
    if (line.kind !== 'add' || line.text.trim() === '') {
        return 0;
    }
    return line.text.length - line.text.trimEnd().length;
}

export function lineSegments(line: DiffLine): LineSegment[] {
    const text = line.text;
    if (text.length === 0) {
        return [];
    }

    const trailing = trailingLength(line);
    const body = text.length - trailing;

    if (text.length > MARKUP_LIMIT) {
        return segmentsOf([
            { text: text.slice(0, body), kind: null, word: false, trailing: false },
            ...(trailing > 0 ? [{ text: text.slice(body), kind: null, word: false, trailing: true }] : []),
        ]);
    }

    const kinds = new Array<SyntaxKind | null>(body).fill(null);
    for (const token of line.tokens ?? []) {
        for (let i = Math.max(token.from, 0); i < Math.min(token.to, body); i += 1) {
            kinds[i] = token.kind;
        }
    }

    const words = new Array<boolean>(body).fill(false);
    for (const range of line.words ?? []) {
        for (let i = Math.max(range.from, 0); i < Math.min(range.to, body); i += 1) {
            words[i] = true;
        }
    }

    const segments: LineSegment[] = [];
    let start = 0;
    for (let i = 1; i <= body; i += 1) {
        if (i < body && kinds[i] === kinds[start] && words[i] === words[start]) {
            continue;
        }
        segments.push({
            text: text.slice(start, i),
            kind: kinds[start] ?? null,
            word: words[start] ?? false,
            trailing: false,
        });
        start = i;
    }
    if (trailing > 0) {
        segments.push({ text: text.slice(body), kind: null, word: false, trailing: true });
    }
    return segmentsOf(segments);
}

function segmentsOf(segments: readonly LineSegment[]): LineSegment[] {
    return segments
        .filter((segment) => segment.text.length > 0)
        .map((segment) => ({ ...segment, text: expandTabs(segment.text) }));
}
