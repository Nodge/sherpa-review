import MarkdownIt from 'markdown-it';
import type { Env, MarkdownIt as MarkdownItInstance, StateInline, Token } from 'markdown-it';

/**
 * Markdown parsing for everything the reviewer reads. `markdown-it` parses it all (commonmark,
 * tables, strikethrough), then an allowlist decides which constructs the profile supports. A construct
 * outside the list stays literal source text. Raw HTML is not parsed (`html: false`) and
 * stays text. The module returns no HTML strings. The UI builds elements from nodes.
 *
 * Three profiles. `comment` supports the full syntax for comment bodies and diff markdown files. `stop` uses
 * the stop description syntax (`docs/design/SPEC-changes-2026-09-20.md §2`): paragraphs, flat
 * lists, code, bold, links. PR summary uses it too, as do the section and
 * skeleton validators. `route` supports only inline code for plain route text (transitions, validator notes,
 * stop titles).
 */

export type MarkdownProfile = 'comment' | 'route' | 'stop';

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
    readonly sourceLine?: number;
    readonly children: readonly InlineNode[];
    readonly list: MarkdownList | null;
    /** null means a regular item, a boolean means a checklist item `- [ ]` / `- [x]`. */
    readonly check: boolean | null;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** null means the separator line has no colons specifying column alignment. */
export type TableAlign = 'left' | 'center' | 'right' | null;

export interface MarkdownSource { readonly start: number; readonly end: number }

export type MarkdownBlock = { readonly source?: MarkdownSource } & (
    /** Paragraph lines: single newlines are preserved because people write plain text. */
    | { readonly kind: 'paragraph'; readonly lines: readonly (readonly InlineNode[])[] }
    | { readonly kind: 'heading'; readonly level: HeadingLevel; readonly children: readonly InlineNode[] }
    /**
     * `lang` is the first word of the fence info string, lowercased. null means a fence without a language or
     * indented code. For indented code (`fenced: false`), text lines start at the first `source` line.
     */
    | { readonly kind: 'code'; readonly lang: string | null; readonly fenced: boolean; readonly text: string }
    | { readonly kind: 'list'; readonly list: MarkdownList }
    | { readonly kind: 'quote'; readonly depth: 1 | 2; readonly children: readonly MarkdownBlock[] }
    | {
          readonly kind: 'table';
          readonly align: readonly TableAlign[];
          readonly head: readonly (readonly InlineNode[])[];
          readonly rows: readonly (readonly (readonly InlineNode[])[])[];
      });

/** Stop description syntax violation. Model-facing text lives in the section validator. */
export type StopViolation =
    | 'heading'
    | 'code'
    | 'table'
    | 'image'
    | 'quote'
    | 'nested-list'
    | 'list-marker'
    | 'list-paragraphs'
    | 'italic'
    | 'strike'
    | 'rule'
    | 'link'
    | 'link-definition'
    /** A block outside both the allowed syntax and the known violations. */
    | 'markup';

export interface StopMarkup {
    readonly blocks: readonly MarkdownBlock[];
    readonly violations: ReadonlySet<StopViolation>;
    /** Number of items in the longest list. */
    readonly longestList: number;
    /** Visible text: text, inline code and link text. Link addresses and markup markers do not count. */
    readonly visibleChars: number;
}

/** Links render only with these schemes. Everything else (`javascript:`, `data:`, relative links) stays text. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s]+$/i;
/** External stop description link: web only, the model has no need for `mailto:`. */
const WEB_HREF = /^https?:\/\/[^\s]+$/i;

/** Internal stop description link: navigation to a planned stop or a diff file. */
const STOP_HREF = /^#(?:stop-\d+|file-\S+)$/;

/** Checklist marker at the start of item text. */
const TASK_MARKER = /^\[([ xX])\][ \t]+/;

/** Lists nest no deeper than this. Deeper items become siblings of their parent. */
const MAX_LIST_DEPTH = 4;

/** Quotes nest no deeper than this. The third and subsequent `>` stay literal text. */
const MAX_QUOTE_DEPTH = 2;

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

function createParser(linkify: boolean): MarkdownItInstance {
    const md = new MarkdownIt('default', { html: false, linkify });
    // Bare addresses need a scheme: `markdown.ts` and `www.x` do not become links.
    md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
    // The profile decides which addresses become links. The address stays as written.
    md.validateLink = () => true;
    md.normalizeLink = (url) => url;
    md.normalizeLinkText = (text) => text;
    // Escapes and entities stay separate tokens. They are literal in the `route` profile.
    md.core.ruler.disable('text_join');
    // No lazy quote continuation: a quote ends at the first line without `>`.
    md.block.ruler.before(
        'paragraph',
        'quote_end',
        (state, _start, _end, silent) => silent && state.parentType === 'blockquote',
        { alt: ['blockquote'] },
    );
    keepLineBreaks(md);
    return md;
}

type InlineRule = (state: StateInline, silent: boolean) => boolean;

/**
 * `markdown-it` removes newlines inside inline code and link addresses, but paragraph lines
 * must match source lines because anchors in the markdown file viewer depend on them.
 * Code keeps newlines in `content`. Links and images store the removed newline count in `meta`.
 */
function keepLineBreaks(md: MarkdownItInstance): void {
    wrapInlineRule(md, 'backticks', (state, start, count) => {
        const token = state.tokens[count];
        const raw = state.src.slice(start, state.pos);
        if (token?.type !== 'code_inline' || !raw.includes('\n')) {
            return;
        }
        const lines = raw.slice(token.markup.length, raw.length - token.markup.length).split('\n');
        // Spaces on both sides are trimmed as in `markdown-it`. A newline at the edge stays a newline.
        if (lines.join(' ') !== token.content) {
            lines[0] = (lines[0] ?? '').replace(/^ /, '');
            lines[lines.length - 1] = (lines.at(-1) ?? '').replace(/ $/, '');
        }
        token.content = lines.join('\n');
    });
    for (const name of ['link', 'image']) {
        wrapInlineRule(md, name, (state, start, count) => {
            const lost = newlines(state.src.slice(start, state.pos)) - breaksIn(state.tokens.slice(count));
            const token = state.tokens[count];
            if (lost > 0 && token !== undefined) {
                token.meta = { lostBreaks: lost };
            }
        });
    }
}

/** Replaces a built-in inline parsing rule. `after` sees the position before the rule and its first token index. */
function wrapInlineRule(md: MarkdownItInstance, name: string, after: (state: StateInline, start: number, count: number) => void): void {
    // `Ruler` has no public access to rule functions, only replacement by name.
    const rules = (md.inline.ruler as unknown as { readonly __rules__: readonly { readonly name: string; readonly fn: InlineRule }[] }).__rules__;
    const original = rules.find((rule) => rule.name === name)?.fn;
    if (original === undefined) {
        throw new Error(`markdown-it: missing inline rule ${name}`);
    }
    md.inline.ruler.at(name, (state, silent) => {
        const start = state.pos;
        // The rule emits accumulated text as a separate token before its own tokens.
        const count = state.tokens.length + (state.pending === '' ? 0 : 1);
        if (!original(state, silent)) {
            return false;
        }
        if (!silent) {
            after(state, start, count);
        }
        return true;
    });
}

function newlines(text: string): number {
    return text.split('\n').length - 1;
}

/** Number of newlines the parser preserved in tokens. */
function breaksIn(tokens: readonly Token[]): number {
    return tokens.reduce((sum, token) => {
        const own = token.type === 'softbreak' || token.type === 'hardbreak' ? 1 : token.type === 'code_inline' ? newlines(token.content) : 0;
        return sum + own + breaksIn(token.children ?? []);
    }, 0);
}

/** A bare URL becomes a link only in comments. */
const commentParser = createParser(true);
const plainParser = createParser(false);

interface Node {
    readonly token: Token;
    readonly children: readonly Node[];
}

interface Context {
    readonly profile: MarkdownProfile;
    readonly lines: readonly string[];
    readonly firstLine: number | undefined;
    readonly violations: Set<StopViolation>;
}

/** Inline parsing of a line. The profile decides which syntax is parsed and which stays text. */
export function parseInline(source: string, profile: MarkdownProfile): readonly InlineNode[] {
    const parser = profile === 'comment' ? commentParser : plainParser;
    const tokens = parser.parseInline(source, {})[0]?.children ?? [];
    return inline(tree(tokens), context(profile, source, undefined));
}

/** Block parsing for the `comment` profile. `firstLine` is the first line number if source ranges are needed. */
export function parseBlocks(source: string, firstLine?: number): readonly MarkdownBlock[] {
    const ctx = context('comment', source, firstLine);
    return blocks(tree(commentParser.parse(source, {})), ctx, 0);
}

/** Block parsing of a stop description: blocks for rendering and everything the validator needs. */
export function parseStop(source: string): StopMarkup {
    const ctx = context('stop', source, undefined);
    let longestList = 0;
    const out: MarkdownBlock[] = [];

    const env: Env = {};
    for (const node of tree(plainParser.parse(source, env))) {
        markViolations(node, ctx, false);
        if (node.token.type === 'paragraph_open') {
            out.push({ kind: 'paragraph', lines: splitLines(inlineOf(node, ctx)) });
        } else if (isList(node)) {
            longestList = Math.max(longestList, node.children.length);
            out.push(stopList(node, ctx) ?? literalBlock(node, ctx));
        } else {
            out.push(literalBlock(node, ctx));
        }
    }

    // A `[label]: address` definition leaves no tokens. It is invisible, and reference links are outside the allowed syntax.
    if (Object.keys(env.references ?? {}).length > 0) {
        ctx.violations.add('link-definition');
    }
    return { blocks: out, violations: ctx.violations, longestList, visibleChars: visibleLength(out) };
}

export function parseStopBlocks(source: string): readonly MarkdownBlock[] {
    return parseStop(source).blocks;
}

/**
 * Text without inline code markup: removes paired backticks, keeps their contents.
 * For string attributes (`title`, `aria-label`, command palette labels), where markdown
 * cannot be used and screen readers read the model's backticks literally.
 */
export function stripInlineCode(text: string): string {
    return parseInline(text, 'route').map(nodeText).join('');
}

function context(profile: MarkdownProfile, source: string, firstLine: number | undefined): Context {
    return { profile, lines: source.replace(/\r\n?/g, '\n').split('\n'), firstLine, violations: new Set() };
}

/** Converts a flat token stream into a tree using `nesting`. */
function tree(tokens: readonly Token[]): Node[] {
    const root: Node[] = [];
    const stack: { token: Token; children: Node[] }[] = [];
    for (const token of tokens) {
        const siblings = stack.at(-1)?.children ?? root;
        if (token.nesting === 1) {
            const node = { token, children: [] };
            siblings.push(node);
            stack.push(node);
        } else if (token.nesting === -1) {
            stack.pop();
        } else {
            siblings.push({ token, children: [] });
        }
    }
    return root;
}

function blocks(nodes: readonly Node[], ctx: Context, quoteDepth: number): MarkdownBlock[] {
    return nodes.flatMap((node) => block(node, ctx, quoteDepth));
}

function block(node: Node, ctx: Context, quoteDepth: number): MarkdownBlock[] {
    const { token } = node;
    const at = position(token.map?.[0], token.map?.[1], ctx);
    switch (token.type) {
        case 'paragraph_open':
            return [{ ...at, kind: 'paragraph', lines: splitLines(inlineOf(node, ctx)) }];
        case 'heading_open':
            return [{ ...at, kind: 'heading', level: HEADING_LEVELS[Number(token.tag.slice(1)) - 1] ?? 1, children: inlineOf(node, ctx) }];
        case 'fence':
            return [{ ...at, kind: 'code', lang: fenceLang(token.info), fenced: true, text: token.content.replace(/\n$/, '') }];
        case 'code_block':
            return [{ ...at, kind: 'code', lang: null, fenced: false, text: token.content.replace(/\n$/, '') }];
        case 'blockquote_open': {
            if (quoteDepth < MAX_QUOTE_DEPTH) {
                return [{ ...at, kind: 'quote', depth: quoteDepth === 0 ? 1 : 2, children: blocks(node.children, ctx, quoteDepth + 1) }];
            }
            return blocks(node.children, ctx, quoteDepth + 1).map(quotedLiterally);
        }
        case 'bullet_list_open':
        case 'ordered_list_open':
            return listBlocks(node, ctx, quoteDepth);
        case 'table_open':
            return [{ ...at, ...table(node, ctx) }];
        case 'hr':
            return [{ ...at, kind: 'paragraph', lines: [[{ kind: 'text', text: token.markup }]] }];
        default:
            return [literalBlock(node, ctx)];
    }
}

/** A quote past the nesting limit: its `>` stays as text at the start of each line. */
function quotedLiterally(block: MarkdownBlock): MarkdownBlock {
    if (block.kind !== 'paragraph') {
        return block;
    }
    return { ...block, lines: block.lines.map((line) => merge([{ kind: 'text', text: '> ' }, ...line])) };
}

/** Source line range `[start, end)`, excluding trailing blank lines. */
function position(start: number | undefined, end: number | undefined, ctx: Context): { source?: MarkdownSource } {
    if (ctx.firstLine === undefined || start === undefined || end === undefined) {
        return {};
    }
    let last = end - 1;
    while (last > start && /^[\s>]*$/.test(ctx.lines[last] ?? '')) {
        last -= 1;
    }
    return { source: { start: ctx.firstLine + start, end: ctx.firstLine + last } };
}

/** A block outside the allowlist: source lines as is. */
function literalBlock(node: Node, ctx: Context): MarkdownBlock {
    const [start, end] = node.token.map ?? [0, 0];
    const lines = ctx.lines
        .slice(start, end)
        .filter((line) => line.trim() !== '')
        .map((line): readonly InlineNode[] => [{ kind: 'text', text: line }]);
    return { ...position(start, end, ctx), kind: 'paragraph', lines };
}

function isList(node: Node): boolean {
    return node.token.type === 'bullet_list_open' || node.token.type === 'ordered_list_open';
}

/**
 * Comment list. Each item holds only the first paragraph and a nested list. Other blocks
 * in the item (code, quote, second paragraph) go after the list, which splits at this item.
 */
function listBlocks(list: Node, ctx: Context, quoteDepth: number): MarkdownBlock[] {
    const ordered = list.token.type === 'ordered_list_open';
    const out: MarkdownBlock[] = [];
    let items: MarkdownListItem[] = [];
    let start: number | undefined;

    for (const item of list.children) {
        const rest: Node[] = [];
        start ??= item.token.map?.[0];
        items.push(...listItem(item, ctx, 0, rest));
        if (rest.length > 0) {
            const restStart = Math.min(...rest.map((node) => node.token.map?.[0] ?? Infinity));
            out.push({ ...position(start, restStart, ctx), kind: 'list', list: { ordered, items } });
            out.push(...blocks(rest, ctx, quoteDepth));
            items = [];
            start = undefined;
        } else if (item === list.children.at(-1)) {
            out.push({ ...position(start, item.token.map?.[1], ctx), kind: 'list', list: { ordered, items } });
        }
    }
    return out;
}

/** An item and, past the nesting limit, its nested items as siblings. Extra blocks go in `rest`. */
function listItem(item: Node, ctx: Context, depth: number, rest: Node[]): MarkdownListItem[] {
    const children = [...item.children];
    const paragraph = children[0]?.token.type === 'paragraph_open' ? children.shift() : undefined;
    const task = taskOf(paragraph === undefined ? [] : inlineOf(paragraph, ctx));
    const flattened: MarkdownListItem[] = [];
    let list: MarkdownList | null = null;

    const next = children[0];
    if (next !== undefined && isList(next)) {
        children.shift();
        const items = next.children.flatMap((child) => listItem(child, ctx, depth + 1, rest));
        if (depth + 1 > MAX_LIST_DEPTH) {
            flattened.push(...items);
        } else {
            list = { ordered: next.token.type === 'ordered_list_open', items };
        }
    }
    rest.push(...children);

    const line = item.token.map?.[0];
    const sourceLine = ctx.firstLine === undefined || line === undefined ? {} : { sourceLine: ctx.firstLine + line };
    return [{ ...sourceLine, children: task.children, list, check: task.check }, ...flattened];
}

/** Removes a checklist marker only with text after it: `- [ ]` on its own is literal. */
function taskOf(nodes: readonly InlineNode[]): { readonly check: boolean | null; readonly children: readonly InlineNode[] } {
    const first = nodes[0];
    const match = first?.kind === 'text' ? TASK_MARKER.exec(first.text) : null;
    if (first?.kind !== 'text' || match === null) {
        return { check: null, children: nodes };
    }
    const children = merge([{ kind: 'text', text: first.text.slice(match[0].length) }, ...nodes.slice(1)]);
    if (children.length === 0) {
        return { check: null, children: nodes };
    }
    return { check: (match[1] ?? '') !== ' ', children };
}

function table(node: Node, ctx: Context): Extract<MarkdownBlock, { kind: 'table' }> {
    const section = (type: string) => node.children.find((child) => child.token.type === type)?.children ?? [];
    const headRow = section('thead_open')[0]?.children ?? [];
    return {
        kind: 'table',
        align: headRow.map((cell) => alignOf(cell.token.attrGet('style'))),
        head: headRow.map((cell) => inlineOf(cell, ctx)),
        rows: section('tbody_open').map((row) => row.children.map((cell) => inlineOf(cell, ctx))),
    };
}

function alignOf(style: string | number | null): TableAlign {
    const align = /text-align:(left|center|right)/.exec(typeof style === 'string' ? style : '')?.[1];
    return align === 'left' || align === 'center' || align === 'right' ? align : null;
}

/** Fence language: first word of the info string, without backticks, lowercased. */
function fenceLang(info: string): string | null {
    const word = (info.trim().split(/\s+/)[0] ?? '').replace(/`/g, '').toLowerCase();
    return word === '' ? null : word;
}

/**
 * Stop description lists must be flat, use `- `, `* ` or `1. ` at the start of the line, and have one
 * paragraph per item. Otherwise `null`: the list stays literal and `markViolations` records the violation.
 */
function stopList(list: Node, ctx: Context): MarkdownBlock | null {
    const items: MarkdownListItem[] = [];
    for (const item of list.children) {
        const children = item.children;
        const first = children[0];
        if (!stopListItem(list, item, ctx) || children.length > 1 || (first !== undefined && first.token.type !== 'paragraph_open')) {
            return null;
        }
        items.push({ children: first === undefined ? [] : inlineOf(first, ctx), list: null, check: null });
    }
    return { kind: 'list', list: { ordered: list.token.type === 'ordered_list_open', items } };
}

/** The item marker is allowed and stands at the start of the line. */
function stopListItem(list: Node, item: Node, ctx: Context): boolean {
    const line = ctx.lines[item.token.map?.[0] ?? -1] ?? '';
    return stopMarker(list.token) && !/^\s/.test(line);
}

/** Stop description list markers: `- ` and `* ` for bullets, `1. ` for numbering. `+ ` and `1) ` are not allowed. */
function stopMarker(list: Token): boolean {
    return list.type === 'bullet_list_open' ? list.markup === '-' || list.markup === '*' : list.markup === '.';
}

/**
 * Stop description block allowlist, across the entire tree, including blocks that will stay literal:
 * each known construct outside the allowed syntax has its own violation, unknown ones get `markup`.
 */
function markViolations(node: Node, ctx: Context, inList: boolean): void {
    const { token } = node;
    const found = ctx.violations;
    switch (token.type) {
        case 'paragraph_open':
        case 'inline':
            break;
        case 'list_item_open':
            if (node.children.filter((child) => child.token.type === 'paragraph_open').length > 1) {
                found.add('list-paragraphs');
            }
            break;
        case 'heading_open':
            found.add('heading');
            break;
        case 'fence':
        case 'code_block':
            found.add('code');
            break;
        case 'table_open':
            // Table rows and cells are table internals, not description blocks.
            found.add('table');
            return;
        case 'blockquote_open':
            found.add('quote');
            break;
        case 'hr':
            found.add('rule');
            break;
        case 'bullet_list_open':
        case 'ordered_list_open':
            if (inList || node.children.some((item) => /^\s/.test(ctx.lines[item.token.map?.[0] ?? -1] ?? ''))) {
                found.add('nested-list');
            }
            if (!stopMarker(token)) {
                found.add('list-marker');
            }
            break;
        default:
            found.add('markup');
    }
    for (const child of node.children) {
        markViolations(child, ctx, inList || isList(node));
    }
}

/** Inline nodes of a container block (paragraph, heading, cell) are carried by its child `inline` token. */
function inlineOf(node: Node, ctx: Context): InlineNode[] {
    const tokens = node.children.find((child) => child.token.type === 'inline')?.token.children ?? [];
    return inline(tree(tokens), ctx);
}

function inline(nodes: readonly Node[], ctx: Context): InlineNode[] {
    return merge(
        nodes.flatMap((node) => {
            const lost = (node.token.meta as { lostBreaks?: number } | null)?.lostBreaks ?? 0;
            const out = inlineNode(node, ctx);
            return lost === 0 ? out : [...out, { kind: 'text', text: '\n'.repeat(lost) }];
        }),
    );
}

function inlineNode(node: Node, ctx: Context): InlineNode[] {
    const { token } = node;
    const { profile } = ctx;
    switch (token.type) {
        case 'text':
            return [{ kind: 'text', text: token.content }];
        case 'text_special':
            return [{ kind: 'text', text: profile === 'route' ? token.markup : token.content }];
        case 'softbreak':
        case 'hardbreak':
            return [{ kind: 'text', text: '\n' }];
        case 'code_inline':
            // Code across a newline: one piece per paragraph line.
            return token.content
                .split('\n')
                .flatMap((text, index): InlineNode[] => [
                    ...(index === 0 ? [] : [{ kind: 'text', text: '\n' } as const]),
                    ...(text === '' ? [] : [{ kind: 'code', text } as const]),
                ]);
        case 'strong_open':
            if (profile !== 'route') {
                return [{ kind: 'strong', children: inline(node.children, ctx) }];
            }
            break;
        case 'em_open':
            if (profile === 'comment') {
                return [{ kind: 'em', children: inline(node.children, ctx) }];
            }
            violate(ctx, 'italic');
            break;
        case 's_open':
            if (profile === 'comment') {
                return [{ kind: 'strike', children: inline(node.children, ctx) }];
            }
            violate(ctx, 'strike');
            break;
        case 'link_open': {
            const href = token.attrGet('href');
            if (typeof href === 'string' && (profile === 'comment' ? SAFE_HREF.test(href) : profile === 'stop' && (WEB_HREF.test(href) || STOP_HREF.test(href)))) {
                return [{ kind: 'link', href, children: inline(node.children, ctx) }];
            }
            violate(ctx, 'link');
            break;
        }
        case 'image':
            violate(ctx, 'image');
            break;
    }
    return literalInline(node, ctx);
}

function violate(ctx: Context, violation: StopViolation): void {
    if (ctx.profile === 'stop') {
        ctx.violations.add(violation);
    }
}

/** Inline constructs outside the allowlist return to source syntax. Their contents are parsed further. */
function literalInline(node: Node, ctx: Context): InlineNode[] {
    const { token } = node;
    const text = (value: string): InlineNode => ({ kind: 'text', text: value });
    switch (token.type) {
        case 'link_open':
            if (token.markup === 'linkify') {
                return inline(node.children, ctx);
            }
            if (token.markup === 'autolink') {
                return [text('<'), ...inline(node.children, ctx), text('>')];
            }
            return [text('['), ...inline(node.children, ctx), text(`](${destination(token, 'href')})`)];
        case 'image':
            return [text('!['), ...inline(tree(token.children ?? []), ctx), text(`](${destination(token, 'src')})`)];
        default:
            return [text(token.markup), ...inline(node.children, ctx), text(token.markup)];
    }
}

function destination(token: Token, attr: 'href' | 'src'): string {
    const title = token.attrGet('title');
    return `${String(token.attrGet(attr) ?? '')}${title === null ? '' : ` "${String(title)}"`}`;
}

/** Merges adjacent text nodes, removes empty ones. */
function merge(nodes: readonly InlineNode[]): InlineNode[] {
    const out: InlineNode[] = [];
    for (const node of nodes) {
        const last = out.at(-1);
        if (node.kind === 'text' && last?.kind === 'text') {
            out[out.length - 1] = { kind: 'text', text: last.text + node.text };
        } else if (node.kind !== 'text' || node.text !== '') {
            out.push(node);
        }
    }
    return out;
}

/** Paragraph lines: a newline inside emphasis or a link splits the node across two lines. */
function splitLines(nodes: readonly InlineNode[]): InlineNode[][] {
    const lines: InlineNode[][] = [];
    let line: InlineNode[] = [];
    const push = (parts: readonly (readonly InlineNode[])[]) => {
        parts.forEach((part, index) => {
            if (index > 0) {
                lines.push(merge(line));
                line = [];
            }
            line.push(...part);
        });
    };

    for (const node of nodes) {
        switch (node.kind) {
            case 'text':
                push(node.text.split('\n').map((text) => [{ kind: 'text', text }]));
                break;
            case 'code':
                line.push(node);
                break;
            default:
                push(splitLines(node.children).map((children) => (children.length === 0 ? [] : [{ ...node, children }])));
        }
    }
    lines.push(merge(line));
    return lines;
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

function visibleLength(blocks: readonly MarkdownBlock[]): number {
    const inlineLength = (nodes: readonly InlineNode[]) => nodes.reduce((sum, node) => sum + nodeText(node).replace(/\n/g, '').length, 0);
    const listLength = (list: MarkdownList): number =>
        list.items.reduce((sum, item) => sum + inlineLength(item.children) + (item.list === null ? 0 : listLength(item.list)), 0);
    return blocks.reduce((sum, block) => {
        switch (block.kind) {
            case 'paragraph':
                return sum + block.lines.reduce((lines, line) => lines + inlineLength(line), 0);
            case 'heading':
                return sum + inlineLength(block.children);
            case 'code':
                return sum + block.text.length;
            case 'list':
                return sum + listLength(block.list);
            case 'quote':
                return sum + visibleLength(block.children);
            case 'table':
                return sum + [block.head, ...block.rows].flat().reduce((cells, cell) => cells + inlineLength(cell), 0);
        }
    }, 0);
}
