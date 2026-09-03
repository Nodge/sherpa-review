/**
 * Parses markdown into nodes from which React builds elements (decision dated 2026-08-27, M2F-T5).
 * No HTML string is produced here. Raw HTML in the source stays text,
 * and React escapes it by construction, so no separate sanitizing layer is needed.
 *
 * There are two profiles. `comment` is the full set for comment bodies. `route` supports only inline code
 * in backticks. All other syntax is literal in the narrow route columns.
 *
 * An unmatched delimiter (backtick, asterisk, tilde, link bracket) is literal text. Other people's text
 * must not break, and "almost markdown" is more common than the real thing.
 */

export type MarkdownProfile = 'comment' | 'route';

export type InlineNode =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'strong'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'em'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'strike'; readonly children: readonly InlineNode[] }
    | { readonly kind: 'link'; readonly href: string; readonly children: readonly InlineNode[] };

export interface MarkdownList {
    readonly ordered: boolean;
    readonly items: readonly MarkdownListItem[];
}

export interface MarkdownListItem {
    readonly children: readonly InlineNode[];
    readonly list: MarkdownList | null;
    /** null means a regular item, a boolean means a checklist item `- [ ]` / `- [x]`. */
    readonly check: boolean | null;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** null means the separator line has no colons specifying column alignment. */
export type TableAlign = 'left' | 'center' | 'right' | null;

export type MarkdownBlock =
    /** Paragraph lines: single newlines are preserved because people write plain text. */
    | { readonly kind: 'paragraph'; readonly lines: readonly (readonly InlineNode[])[] }
    | { readonly kind: 'heading'; readonly level: HeadingLevel; readonly children: readonly InlineNode[] }
    /** `lang` is the first word of the fence info string, lowercased. null means a fence without a language. */
    | { readonly kind: 'code'; readonly lang: string | null; readonly text: string }
    | { readonly kind: 'list'; readonly list: MarkdownList }
    | { readonly kind: 'quote'; readonly depth: 1 | 2; readonly children: readonly MarkdownBlock[] }
    | {
          readonly kind: 'table';
          readonly align: readonly TableAlign[];
          readonly head: readonly (readonly InlineNode[])[];
          readonly rows: readonly (readonly (readonly InlineNode[])[])[];
      };

/** Links render only with these schemes. Everything else (`javascript:`, `data:`) stays text. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s]+$/i;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const FENCE_OPEN = /^ {0,3}(`{3,})[ \t]*(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const BARE_URL = /https?:\/\/[^\s<>"'`\\]+/iy;
/** Blockquote line: consume `>` and one following space. The rest is nested markdown. */
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
/** Checklist marker at the start of item text. */
const TASK_MARKER = /^\[([ xX])\][ \t]+(.*)$/;
/** Table delimiter row cell. Colons set alignment. */
const DELIMITER_CELL = /^:?-+:?$/;

/** Lists nest no deeper than this. Deeper items become siblings of their parent. */
const MAX_LIST_DEPTH = 4;

/** Quotes nest no deeper than this. The third and subsequent `>` stay literal text. */
const MAX_QUOTE_DEPTH = 2;

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

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
            } else if (source.startsWith('~~', index) && opensEmphasis(source, index + 2)) {
                const close = findClosing(source, index + 2, '~~');
                if (close > index + 2) {
                    flush();
                    nodes.push({ kind: 'strike', children: parseInline(source.slice(index + 2, close), profile) });
                    index = close + 2;
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

/** Block parsing for the `comment` profile: headings, blockquotes, tables, lists, code blocks, and paragraphs. */
export function parseBlocks(source: string): readonly MarkdownBlock[] {
    return parseLines(source.replace(/\r\n?/g, '\n').split('\n'), 0);
}

function parseLines(lines: readonly string[], quoteDepth: number): readonly MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    const quotesAllowed = quoteDepth < MAX_QUOTE_DEPTH;
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
            blocks.push({ kind: 'code', lang: fenceLang(fence[2] ?? ''), text: body.join('\n') });
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading !== null) {
            const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '');
            blocks.push({
                kind: 'heading',
                level: headingLevel((heading[1] ?? '').length),
                children: parseInline(text, 'comment'),
            });
            index += 1;
            continue;
        }

        if (quotesAllowed && QUOTE.test(line)) {
            const body: string[] = [];
            // No lazy continuation: the first line without `>` ends the blockquote.
            while (index < lines.length) {
                const quoted = QUOTE.exec(lines[index] ?? '');
                if (quoted === null) {
                    break;
                }
                body.push(quoted[1] ?? '');
                index += 1;
            }
            blocks.push({
                kind: 'quote',
                depth: quoteDepth === 0 ? 1 : 2,
                children: parseLines(body, quoteDepth + 1),
            });
            continue;
        }

        if (isTableStart(lines, index)) {
            const table = parseTable(lines, index, quotesAllowed);
            blocks.push(table.block);
            index = table.next;
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
            if (next.trim() === '' || startsBlock(lines, index, quotesAllowed)) {
                break;
            }
            paragraph.push(parseInline(next, 'comment'));
            index += 1;
        }
        blocks.push({ kind: 'paragraph', lines: paragraph });
    }

    return blocks;
}

/** The line starts its own block, ending both a paragraph and a table body. */
function startsBlock(lines: readonly string[], index: number, quotesAllowed: boolean): boolean {
    const line = lines[index] ?? '';
    return (
        FENCE_OPEN.test(line) ||
        HEADING.test(line) ||
        LIST_ITEM.test(line) ||
        (quotesAllowed && QUOTE.test(line)) ||
        isTableStart(lines, index)
    );
}

function headingLevel(hashes: number): HeadingLevel {
    return HEADING_LEVELS[hashes - 1] ?? 1;
}

/** Fence language: first word of the info string, without backticks, lowercased. */
function fenceLang(info: string): string | null {
    const word = (info.trim().split(/\s+/)[0] ?? '').replace(/`/g, '').toLowerCase();
    return word === '' ? null : word;
}

/** A table requires a pipe-separated row followed by a delimiter row. */
function isTableStart(lines: readonly string[], index: number): boolean {
    const head = lines[index] ?? '';
    if (!head.includes('|')) {
        return false;
    }
    const delimiter = lines[index + 1];
    if (delimiter?.includes('-') !== true) {
        return false;
    }
    const cells = splitRow(delimiter);
    return cells.length === splitRow(head).length && cells.every((cell) => DELIMITER_CELL.test(cell));
}

function parseTable(
    lines: readonly string[],
    from: number,
    quotesAllowed: boolean,
): { readonly block: MarkdownBlock; readonly next: number } {
    const head = splitRow(lines[from] ?? '');
    const align = splitRow(lines[from + 1] ?? '').map(alignOf);
    const rows: (readonly InlineNode[])[][] = [];
    let index = from + 2;

    while (index < lines.length) {
        const line = lines[index] ?? '';
        if (line.trim() === '' || !line.includes('|') || startsBlock(lines, index, quotesAllowed)) {
            break;
        }
        rows.push(fitRow(splitRow(line), head.length).map((cell) => parseInline(cell, 'comment')));
        index += 1;
    }

    return {
        block: {
            kind: 'table',
            align,
            head: head.map((cell) => parseInline(cell, 'comment')),
            rows,
        },
        next: index,
    };
}

/** Body rows match the header: discard extra cells and fill missing cells with empty ones. */
function fitRow(cells: readonly string[], columns: number): readonly string[] {
    const fitted = cells.slice(0, columns);
    while (fitted.length < columns) {
        fitted.push('');
    }
    return fitted;
}

function alignOf(cell: string): TableAlign {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) {
        return 'center';
    }
    if (left) {
        return 'left';
    }
    return right ? 'right' : null;
}

/** Table row cells: outer pipes are optional, `\|` is a pipe inside a cell. */
function splitRow(line: string): string[] {
    const source = line.trim().replace(/^\|/, '');
    const cells: string[] = [];
    let cell = '';
    let index = 0;

    while (index < source.length) {
        if (source[index] === '\\' && source[index + 1] === '|') {
            cell += '|';
            index += 2;
            continue;
        }
        if (source[index] === '|') {
            cells.push(cell.trim());
            cell = '';
            index += 1;
            continue;
        }
        cell += source[index] ?? '';
        index += 1;
    }

    // The trailing pipe leaves an empty tail, with no column after it.
    if (cell.trim() !== '' || cells.length === 0) {
        cells.push(cell.trim());
    }
    return cells;
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
        case 'strike':
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
        const task = taskOf(item.text);
        items.push({ children: parseInline(task.text, 'comment'), list: nested, check: task.check });
    }

    return { list: { ordered, items }, next: index };
}

/** Removes a checklist marker only with text after it: `- [ ]` on its own is literal. */
function taskOf(text: string): { readonly check: boolean | null; readonly text: string } {
    const match = TASK_MARKER.exec(text);
    const rest = match === null ? '' : match[2] ?? '';
    if (match === null || rest.trim() === '') {
        return { check: null, text };
    }
    return { check: (match[1] ?? '') !== ' ', text: rest };
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
