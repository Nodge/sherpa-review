/**
 * Clamp a stop paragraph (docs/design/SPEC-elements.md §2.9): show four sentences and "more" if there are more than four.
 * Pure function: sentence boundaries are periods, exclamation marks, question marks
 * and ellipses followed by whitespace. Abbreviations like "i. e." are split rarely and harmlessly.
 */

export const PARAGRAPH_SENTENCES = 4;

export interface ClampedParagraph {
    readonly head: string;
    /** Empty when there was nothing to clamp. */
    readonly rest: string;
}

export function clampParagraph(text: string, limit = PARAGRAPH_SENTENCES): ClampedParagraph {
    const sentences = splitSentences(text);
    if (sentences.length <= limit) {
        return { head: text.trim(), rest: '' };
    }
    return {
        head: sentences.slice(0, limit).join('').trim(),
        rest: sentences.slice(limit).join('').trim(),
    };
}

/**
 * A boundary is a period (or `!?…`) followed by whitespace. Without this condition,
 * `Date.now()` and `psp.v4` would split the paragraph mid-sentence and misreport the clamped length.
 */
function splitSentences(text: string): string[] {
    return text.split(/(?<=[.!?…])(?=\s)/);
}
