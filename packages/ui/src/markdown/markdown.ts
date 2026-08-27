/**
 * Parses markdown into nodes from which React builds elements (decision dated 2026-08-27, M2F-T5).
 * No HTML string is produced here. Raw HTML in the source stays text,
 * and React escapes it by construction, so no separate sanitizing layer is needed.
 *
 * There are two profiles. `comment` is the full set for comment bodies. `route` supports only inline code
 * in backticks. All other syntax is literal in the narrow route columns.
 *
 * An unmatched delimiter (backtick, asterisk, link bracket) stays literal text. Other people's text
 * must not break, and "almost markdown" is more common than the real thing.
 */

export type MarkdownProfile = 'comment' | 'route';

export type InlineNode =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'strong'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'em'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'link'; readonly href: string; readonly children: readonly InlineNode[] };

export interface MarkdownList {
    readonly ordered: boolean;
    readonly items: readonly MarkdownListItem[];
}

export interface MarkdownListItem {
    readonly children: readonly InlineNode[];
    readonly list: MarkdownList | null;
}

export type MarkdownBlock =
    /** Paragraph lines: single newlines are preserved because people write plain text. */
    | { readonly kind: 'paragraph'; readonly lines: readonly (readonly InlineNode[])[] }
    | { readonly kind: 'heading'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'list'; readonly list: MarkdownList };

/** Links render only with these schemes. Everything else (`javascript:`, `data:`) stays text. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s]+$/i;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const FENCE_OPEN = /^ {0,3}(`{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const BARE_URL = /https?:\/\/[^\s<>"'`\\]+/iy;

/** Lists nest no deeper than this. Deeper items become siblings of their parent. */
const MAX_LIST_DEPTH = 4;

/** Inline parsing: in the `route` profile, only code in backticks is recognized as syntax. */
export function parseInline(source: string, profile: MarkdownProfile): readonly InlineNode[] {
    const nodes: InlineNode[] = [];
    let plain = '';
    let index = 0;

    const flush = (): void => {
        if (plain !== '') {
            nodes.push({ kind: 'text', text: plain });
            plain = '';
        }
    };

    while (index < source.length) {
        const char = source[index] ?? '';

        if (char === '`') {
            const run = runLength(source, index, '`');
            const close = findCodeClose(source, index + run, run);
            if (close === -1) {
                plain += source.slice(index, index + run);
                index += run;
                continue;
            }
            flush();
            nodes.push({ kind: 'code', text: source.slice(index + run, close) });
            index = close + run;
            continue;
        }

        if (profile === 'comment') {
            if (source.startsWith('**', index) && opensEmphasis(source, index + 2)) {
                const close = findClosing(source, index + 2, '**');
                if (close > index + 2) {
                    flush();
                    nodes.push({ kind: 'strong', children: parseInline(source.slice(index + 2, close), profile) });
                    index = close + 2;
                    continue;
                }
            } else if (char === '*' && opensEmphasis(source, index + 1)) {
                const close = findClosing(source, index + 1, '*');
                if (close > index + 1) {
                    flush();
                    nodes.push({ kind: 'em', children: parseInline(source.slice(index + 1, close), profile) });
                    index = close + 1;
                    continue;
                }
            } else if (char === '[') {
                const link = matchLink(source, index);
                if (link !== null) {
                    if (SAFE_HREF.test(link.href)) {
                        flush();
                        nodes.push({
                            kind: 'link',
                            href: link.href,
                            children: parseInline(link.text, profile),
                        });
                    } else {
                        plain += source.slice(index, link.end);
                    }
                    index = link.end;
                    continue;
                }
            } else if ((char === 'h' || char === 'H') && startsWord(plain)) {
                const url = matchBareUrl(source, index);
                if (url !== '') {
                    flush();
                    nodes.push({ kind: 'link', href: url, children: [{ kind: 'text', text: url }] });
                    index += url.length;
                    continue;
                }
            }
        }

        plain += char;
        index += 1;
    }

    flush();
    return nodes;
}

/** Block parsing for the `comment` profile: headings, lists, code blocks and paragraphs. */
export function parseBlocks(source: string): readonly MarkdownBlock[] {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const blocks: MarkdownBlock[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index] ?? '';

        if (line.trim() === '') {
            index += 1;
            continue;
        }

        const fence = FENCE_OPEN.exec(line);
        if (fence !== null) {
            const size = (fence[1] ?? '').length;
            const body: string[] = [];
            index += 1;
            while (index < lines.length && !closesFence(lines[index] ?? '', size)) {
                body.push(lines[index] ?? '');
                index += 1;
            }
            // End of text closes an unclosed fence, otherwise the rest of the comment would disappear.
            index += 1;
            blocks.push({ kind: 'code', text: body.join('\n') });
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading !== null) {
            const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '');
            blocks.push({ kind: 'heading', children: parseInline(text, 'comment') });
            index += 1;
            continue;
        }

        if (LIST_ITEM.test(line)) {
            const raw: RawItem[] = [];
            while (index < lines.length) {
                const item = LIST_ITEM.exec(lines[index] ?? '');
                if (item === null) {
                    break;
                }
                raw.push({
                    indent: (item[1] ?? '').replace(/\t/g, '    ').length,
                    ordered: /^[ \t]*\d/.test(lines[index] ?? ''),
                    text: item[2] ?? '',
                });
                index += 1;
            }
            for (const list of buildLists(raw)) {
                blocks.push({ kind: 'list', list });
            }
            continue;
        }

        const paragraph: (readonly InlineNode[])[] = [];
        while (index < lines.length) {
            const next = lines[index] ?? '';
            if (next.trim() === '' || FENCE_OPEN.test(next) || HEADING.test(next) || LIST_ITEM.test(next)) {
                break;
            }
            paragraph.push(parseInline(next, 'comment'));
            index += 1;
        }
        blocks.push({ kind: 'paragraph', lines: paragraph });
    }

    return blocks;
}

/**
 * Text without inline code markup: removes paired backticks, keeps their contents.
 * For string attributes (`title`, `aria-label`, command palette labels), where markdown
 * cannot be used and screen readers read the model's backticks literally.
 */
export function stripInlineCode(text: string): string {
    return parseInline(text, 'route').map(nodeText).join('');
}

function nodeText(node: InlineNode): string {
    switch (node.kind) {
        case 'text':
        case 'code':
            return node.text;
        case 'strong':
        case 'em':
        case 'link':
            return node.children.map(nodeText).join('');
    }
}

interface RawItem {
    readonly indent: number;
    readonly ordered: boolean;
    readonly text: string;
}

/**
 * Groups items from one run of lines into lists. Indentation determines nesting:
 * indentation widths are normalized to consecutive levels, so "two spaces" and "four"
 * produce the same result.
 */
function buildLists(raw: readonly RawItem[]): readonly MarkdownList[] {
    const levels = [...new Set(raw.map((item) => item.indent))].sort((left, right) => left - right);
    const leveled = raw.map((item) => ({
        ...item,
        level: Math.min(levels.indexOf(item.indent), MAX_LIST_DEPTH),
    }));

    const lists: MarkdownList[] = [];
    let index = 0;
    while (index < leveled.length) {
        const start = leveled[index];
        if (start === undefined) {
            break;
        }
        const built = buildList(leveled, index, start.level);
        lists.push(built.list);
        index = built.next;
    }
    return lists;
}

type LeveledItem = RawItem & { readonly level: number };

function buildList(
    raw: readonly LeveledItem[],
    from: number,
    level: number,
): { readonly list: MarkdownList; readonly next: number } {
    const items: MarkdownListItem[] = [];
    let index = from;
    let ordered = false;

    while (index < raw.length) {
        const item = raw[index];
        // Less indentation than the current level means the item belongs to a list higher in the stack.
        if (item === undefined || item.level < level) {
            break;
        }
        if (items.length === 0) {
            ordered = item.ordered;
        }
        index += 1;

        const deeper = raw[index];
        let nested: MarkdownList | null = null;
        if (deeper !== undefined && deeper.level > level) {
            const built = buildList(raw, index, deeper.level);
            nested = built.list;
            index = built.next;
        }
        items.push({ children: parseInline(item.text, 'comment'), list: nested });
    }

    return { list: { ordered, items }, next: index };
}

/**
 * A fence closes with a run at least as long as the opening one. Four backticks can enclose an example
 * that contains a triple fence.
 */
function closesFence(line: string, size: number): boolean {
    const match = FENCE_CLOSE.exec(line);
    return match !== null && (match[1] ?? '').length >= size;
}

function runLength(source: string, from: number, char: string): number {
    let length = 0;
    while (source[from + length] === char) {
        length += 1;
    }
    return length;
}

/** Index of a run of exactly `size` backticks, which closes an opening run of the same size. */
function findCodeClose(source: string, from: number, size: number): number {
    let index = from;
    while (index < source.length) {
        if (source[index] === '`') {
            const run = runLength(source, index, '`');
            if (run === size) {
                return index;
            }
            index += run;
            continue;
        }
        index += 1;
    }
    return -1;
}

/**
 * An opening asterisk must touch a word, otherwise `area = a * b * c`
 * and `2 ** 3 and 4 ** 5` would lose asterisks and merge into emphasis.
 */
function opensEmphasis(source: string, at: number): boolean {
    const char = source[at];
    return char !== undefined && !isSpace(char);
}

function isSpace(char: string | undefined): boolean {
    return char === ' ' || char === '\t';
}

/** Closing emphasis delimiter. Skips code in backticks as a whole to avoid splitting it. */
function findClosing(source: string, from: number, delimiter: string): number {
    let index = from;
    while (index < source.length) {
        if (source[index] === '`') {
            const run = runLength(source, index, '`');
            const close = findCodeClose(source, index + run, run);
            index = close === -1 ? index + run : close + run;
            continue;
        }
        if (delimiter === '*' && source.startsWith('**', index)) {
            index += 2;
            continue;
        }
        if (source.startsWith(delimiter, index)) {
            // The closing asterisk must touch a word too, so `char *buf, int *len`
            // stays text instead of becoming italic from pointer to pointer.
            if (!isSpace(source[index - 1])) {
                return index;
            }
            index += delimiter.length;
            continue;
        }
        index += 1;
    }
    return -1;
}

function matchLink(source: string, start: number): { readonly text: string; readonly href: string; readonly end: number } | null {
    const textEnd = source.indexOf(']', start + 1);
    if (textEnd === -1 || source[textEnd + 1] !== '(') {
        return null;
    }
    const hrefEnd = findDestinationEnd(source, textEnd + 2);
    if (hrefEnd === -1) {
        return null;
    }
    // Link titles (`[a](url "t")`) are dropped. The card has no separate place for them.
    const href = source.slice(textEnd + 2, hrefEnd).trim().split(/\s+/)[0] ?? '';
    return { text: source.slice(start + 1, textEnd), href, end: hrefEnd + 1 };
}

/**
 * Finds the bracket closing a link URL, accounting for nested pairs. In
 * `[wiki](https://ru.wikipedia.org/wiki/Foo_(bar))`, the URL ends at the second bracket.
 */
function findDestinationEnd(source: string, from: number): number {
    let depth = 0;
    for (let index = from; index < source.length; index += 1) {
        const char = source[index];
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            if (depth === 0) {
                return index;
            }
            depth -= 1;
        }
    }
    return -1;
}

/** A bare URL is matched only at a word boundary, otherwise `path/https://x` would become a link. */
function startsWord(plain: string): boolean {
    const last = plain.at(-1);
    return last === undefined || !/[\p{L}\p{N}/]/u.test(last);
}

function matchBareUrl(source: string, from: number): string {
    BARE_URL.lastIndex = from;
    const match = BARE_URL.exec(source);
    return match === null ? '' : trimUrlTail(match[0]);
}

/** A trailing period or closing bracket almost always belongs to the sentence, not the URL. */
function trimUrlTail(url: string): string {
    let end = url.length;
    while (end > 0) {
        const last = url[end - 1] ?? '';
        if ('.,;:!?'.includes(last)) {
            end -= 1;
            continue;
        }
        if (last === ')' && !balanced(url.slice(0, end))) {
            end -= 1;
            continue;
        }
        break;
    }
    return url.slice(0, end);
}

function balanced(url: string): boolean {
    let depth = 0;
    for (const char of url) {
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth -= 1;
        }
    }
    return depth >= 0;
}
