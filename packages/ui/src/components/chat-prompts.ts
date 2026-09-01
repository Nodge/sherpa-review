/**
 * Chat entry point text (README §2, §10, SPEC §2.15, §2.18). The question is always just
 * placed in the composer for the reviewer to send, so it must read as their
 * own words, not a command they didn't write.
 *
 * Pure module: no React or DOM, unit tests check the text.
 */

/** Range for question text. Line numbers refer to their own side of the diff. */
export interface QuestionRange {
    readonly path: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

/**
 * "Other" can contain hundreds of ranges. Listing them all would make the question unreadable.
 * The ending states how many ranges remain instead of leaving them unmentioned.
 */
export const MAX_LISTED_RANGES = 20;

/**
 * "Other" → a question without an anchor. A question has one anchor but there are many ranges, so
 * they are listed as text. PR context (patches and route plan) accompanies an unanchored question automatically.
 */
export function placeRangesQuestion(ranges: readonly QuestionRange[]): string {
    const tail = 'For each one — which stop it belongs to and why, or that it is a separate topic.';
    if (ranges.length === 0) {
        return `Place the ranges the model left unplaced into the route stops. ${tail}`;
    }
    const listed = ranges.slice(0, MAX_LISTED_RANGES).map(rangeLabel).join(', ');
    const rest = ranges.length - MAX_LISTED_RANGES;
    const list = rest > 0 ? `${listed} and ${String(rest)} more` : listed;
    return `Place the ranges the model left unplaced into the route stops: ${list}. ${tail}`;
}

/** Hatched Full diff strip → question anchored to exactly this range (README §10). */
export function placeRangeQuestion(range: QuestionRange): string {
    const single = range.start === range.end;
    const removed = range.side === 'old';
    const noun = single ? (removed ? 'removed line' : 'line') : removed ? 'removed lines' : 'lines';
    return [
        `Which route stop ${single ? 'does' : 'do'} ${noun} ${rangeNumbers(range)}`,
        ` in ${range.path} belong to? The model did not place ${single ? 'it' : 'them'}.`,
    ].join('');
}

/** Example questions in the empty panel (SPEC §2.18): a click places them in the composer. */
export const CHAT_EXAMPLE_QUESTIONS: readonly string[] = [
    'What are the riskiest changes here?',
    'What should I check by hand before shipping?',
    'Are there edge cases missed in this diff?',
];

/**
 * "Agent disconnected" labels at all AI entry points (SPEC §2.15). One module for all:
 * the reader keeps working everywhere, and the wording must stay consistent.
 */
export const ASK_SELECTION_DISABLED_TITLE = 'Reconnect the agent to ask about a selection';
export const ASK_RANGES_DISABLED_TITLE = 'Reconnect the agent to ask about these lines';

/** The "place" button leaves the route unchanged. Regeneration is separate (SPEC §4.3). */
export const ASK_ANSWER_IN_CHAT_NOTE = 'the answer lands in the chat, the route does not change';

function rangeLabel(range: QuestionRange): string {
    const numbers = `${range.path}:${rangeNumbers(range)}`;
    return range.side === 'old' ? `${numbers} (removed)` : numbers;
}

function rangeNumbers(range: QuestionRange): string {
    return range.start === range.end
        ? String(range.start)
        : `${String(range.start)}–${String(range.end)}`;
}
