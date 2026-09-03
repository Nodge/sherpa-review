import type { MessageKey, Translate } from '../i18n/index.js';

/**
 * Chat entry point text (README §2, §10, SPEC §2.15, §2.18). The question is always just
 * placed in the composer for the reviewer to send, so it must read as their
 * own words, not a command they didn't write.
 *
 * Pure module with no React or DOM. `t` builds the question string that goes into the
 * input field. A translation key cannot go there.
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
export function placeRangesQuestion(ranges: readonly QuestionRange[], t: Translate): string {
    if (ranges.length === 0) {
        return t('chat.ask.placeRanges');
    }
    const listed = ranges.slice(0, MAX_LISTED_RANGES).map((range) => rangeLabel(range, t)).join(', ');
    const rest = ranges.length - MAX_LISTED_RANGES;
    return t('chat.ask.placeRanges.listed', rest > 0 ? t('chat.ask.rangesRest', listed, rest) : listed);
}

/** Hatched Full diff strip → question anchored to exactly this range (README §10). */
export function placeRangeQuestion(range: QuestionRange, t: Translate): string {
    const single = range.start === range.end;
    const removed = range.side === 'old';
    const key: MessageKey = single
        ? removed
            ? 'chat.ask.placeRange.lineRemoved'
            : 'chat.ask.placeRange.line'
        : removed
          ? 'chat.ask.placeRange.linesRemoved'
          : 'chat.ask.placeRange.lines';
    return t(key, rangeNumbers(range), range.path);
}

/** Example questions in the empty panel (SPEC §2.18): a click places them in the composer. */
export const CHAT_EXAMPLE_QUESTIONS: readonly MessageKey[] = [
    'chat.example.risky',
    'chat.example.manual',
    'chat.example.edgeCases',
];

/**
 * "Agent disconnected" labels at all AI entry points (SPEC §2.15). One module for all:
 * the reader keeps working everywhere, and the wording must stay consistent.
 */
export const ASK_SELECTION_DISABLED_TITLE: MessageKey = 'chat.ask.selectionDisabled';
export const ASK_RANGES_DISABLED_TITLE: MessageKey = 'chat.ask.rangesDisabled';

/** The "place" button leaves the route unchanged. Regeneration is separate (SPEC §4.3). */
export const ASK_ANSWER_IN_CHAT_NOTE: MessageKey = 'chat.ask.answerInChat';

function rangeLabel(range: QuestionRange, t: Translate): string {
    const numbers = `${range.path}:${rangeNumbers(range)}`;
    return range.side === 'old' ? t('chat.ask.rangeRemoved', numbers) : numbers;
}

function rangeNumbers(range: QuestionRange): string {
    return range.start === range.end
        ? String(range.start)
        : `${String(range.start)}–${String(range.end)}`;
}
