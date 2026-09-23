import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';
import type { StopViolation } from '@sherpa/protocol/markdown';
import { parseStop } from '@sherpa/protocol/markdown';

/**
 * Stop description markup vocabulary (`docs/design/SPEC-changes-2026-09-20.md §2`), a third,
 * reduced markdown subset: paragraphs (separated by a blank line), `- `, `* ` or `1. ` lists
 * up to four items without nesting, inline code, bold text and links.
 *
 * Parsing matches UI rendering (`@sherpa/protocol/markdown`, `stop` profile). Validation uses an
 * allowlist: anything outside the vocabulary is a violation. The budget counts visible text.
 *
 * A violation is a hard error. The entire section is regenerated, as with any other
 * invalid result. The UI does not truncate the description or add an ellipsis.
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
    const errors: string[] = [];
    const stop = `paragraph of stop ${String(planIndex)}`;
    const markup = parseStop(text);

    if (markup.visibleChars === 0) {
        errors.push(`${at}: ${stop} has no visible text: the reviewer would see an empty description.`);
    }
    if (markup.visibleChars > STOP_PARAGRAPH_MAX_CHARS) {
        errors.push(
            `${at}: ${stop} is ${String(markup.visibleChars)} chars, limit is ${String(STOP_PARAGRAPH_MAX_CHARS)}. Cut it down, do not split it across stops.`,
        );
    }
    for (const violation of Object.keys(VIOLATION_TEXT) as StopViolation[]) {
        if (markup.violations.has(violation)) {
            errors.push(`${at}: ${stop} ${VIOLATION_TEXT[violation]}; ${ALLOWED}.`);
        }
    }
    if (markup.longestList > MAX_LIST_ITEMS) {
        errors.push(
            `${at}: ${stop} has a list of ${String(markup.longestList)} items, at most ${String(MAX_LIST_ITEMS)} are allowed. A list is for enumerating like things; move the rest into the prose.`,
        );
    }
    return errors;
}
