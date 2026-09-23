import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';
import type { StopViolation } from '@sherpa/protocol/markdown';
import { parseStop } from '@sherpa/protocol/markdown';

/**
 * Stop description markup vocabulary (`docs/design/SPEC-changes-2026-09-20.md §2`), a third,
 * reduced markdown subset: paragraphs (separated by a blank line), `- `, `* ` or `1. ` lists
 * of up to four items without nesting, inline code, bold and links. PR summaries use the same vocabulary,
 * without the length budget.
 *
 * Parsing matches UI rendering (`@sherpa/protocol/markdown`, `stop` profile). Validation uses an
 * allowlist: anything outside the vocabulary is a violation. The budget counts visible text.
 *
 * A violation rejects the entire section (or skeleton for a summary) for regeneration,
 * as with any other invalid result. The UI does not truncate text or add ellipses.
 */

/** Maximum number of items in a description list. */
const MAX_LIST_ITEMS = 4;

/** Key order determines error output order. */
const VIOLATION_TEXT: Readonly<Record<StopViolation, string>> = {
    heading: 'uses a heading',
    code: 'uses a code block',
    table: 'uses a table',
    image: 'uses an image',
    quote: 'uses a block quote',
    'nested-list': 'uses a nested list item',
    'list-marker': 'uses a list marker other than `- `, `* ` and `1. `',
    'list-paragraphs': 'puts more than one paragraph into a list item',
    italic: 'uses italics',
    strike: 'uses strikethrough',
    rule: 'uses a horizontal rule',
    link: 'links to an address other than http(s), `#stop-<planIndex>` or `#file-<path>`',
    'link-definition': 'uses a link reference definition `[label]: url`; write links inline as [text](url)',
    markup: 'uses markup outside the allowed set',
};

const ALLOWED = 'allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url)';

/**
 * Markup errors for one stop description. `at` is the field path in the model JSON,
 * and `planIndex` is the stop number used by the reviewer and the model.
 */
export function paragraphMarkupErrors(at: string, planIndex: number, text: string): string[] {
    return markupErrors(at, `paragraph of stop ${String(planIndex)}`, text, STOP_PARAGRAPH_MAX_CHARS);
}

/**
 * Markup errors for text using the description vocabulary. `subject` names the text in the model message,
 * and `maxChars` is the visible text budget. Length is not checked without it.
 */
export function markupErrors(at: string, subject: string, text: string, maxChars?: number): string[] {
    const errors: string[] = [];
    const markup = parseStop(text);

    if (markup.visibleChars === 0) {
        errors.push(`${at}: ${subject} has no visible text: the reviewer would see an empty description.`);
    }
    if (maxChars !== undefined && markup.visibleChars > maxChars) {
        errors.push(
            `${at}: ${subject} is ${String(markup.visibleChars)} chars, limit is ${String(maxChars)}. Cut it down, do not split it across stops.`,
        );
    }
    for (const violation of Object.keys(VIOLATION_TEXT) as StopViolation[]) {
        if (markup.violations.has(violation)) {
            errors.push(`${at}: ${subject} ${VIOLATION_TEXT[violation]}; ${ALLOWED}.`);
        }
    }
    if (markup.longestList > MAX_LIST_ITEMS) {
        errors.push(
            `${at}: ${subject} has a list of ${String(markup.longestList)} items, at most ${String(MAX_LIST_ITEMS)} are allowed. A list is for enumerating like things; move the rest into the prose.`,
        );
    }
    return errors;
}
