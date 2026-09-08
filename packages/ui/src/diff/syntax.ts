import type { LanguageId, SyntaxToken } from './model.js';

/**
 * Line-by-line highlighting lexer. docs/design/README.md §1: highlighting is "intentionally minimal", four categories
 * without claiming to parse the language. One rule for ambiguous cases: when unsure, use plain.
 *
 * The lexer deliberately keeps no state between lines. A hunk mixes lines from the old and new versions,
 * so shared state (an open block comment) would give incorrect results.
 * Multiline constructs are approximated within each line (JSDoc continuation,
 * an unclosed `/*`, Python triple quotes).
 */

interface LanguageProfile {
    keywords: ReadonlySet<string>;
    lineComment: readonly string[];
    blockComment: { open: string; close: string } | null;
    quotes: readonly string[];
    /** Python triple quotes: highlight the docstring as a string to the end of the line. */
    tripleQuotes: boolean;
    /** `@decorator` in Python/TS, `@media` in CSS. */
    decorators: boolean;
    numbers: boolean;
}

const TS_KEYWORDS = keywords(`
    export import from as default declare namespace module
    const let var function class interface type enum extends implements
    return if else for while do switch case break continue new delete void
    async await yield typeof instanceof in of this super
    try catch finally throw
    readonly public private protected static get set abstract
    satisfies keyof infer null undefined true false
`);

const PY_KEYWORDS = keywords(`
    def class lambda return yield pass raise import from as global nonlocal
    if elif else for while break continue try except finally with assert del
    in is not and or None True False async await self
`);

const GO_KEYWORDS = keywords(`
    package import func type struct interface map chan const var
    return if else for range switch case default break continue fallthrough
    go defer select goto nil true false
`);

const JSON_KEYWORDS = keywords('true false null');
const YAML_KEYWORDS = keywords('true false null yes no');

const PROFILES: Record<Exclude<LanguageId, 'md'>, LanguageProfile> = {
    ts: {
        keywords: TS_KEYWORDS,
        lineComment: ['//'],
        blockComment: { open: '/*', close: '*/' },
        quotes: ['"', "'", '`'],
        tripleQuotes: false,
        decorators: true,
        numbers: true,
    },
    py: {
        keywords: PY_KEYWORDS,
        lineComment: ['#'],
        blockComment: null,
        quotes: ['"', "'"],
        tripleQuotes: true,
        decorators: true,
        numbers: true,
    },
    go: {
        keywords: GO_KEYWORDS,
        lineComment: ['//'],
        blockComment: { open: '/*', close: '*/' },
        quotes: ['"', '`'],
        tripleQuotes: false,
        decorators: false,
        numbers: true,
    },
    json: {
        keywords: JSON_KEYWORDS,
        lineComment: [],
        blockComment: null,
        quotes: ['"'],
        tripleQuotes: false,
        decorators: false,
        numbers: true,
    },
    yaml: {
        keywords: YAML_KEYWORDS,
        lineComment: ['#'],
        blockComment: null,
        quotes: ['"', "'"],
        tripleQuotes: false,
        decorators: false,
        numbers: true,
    },
    css: {
        keywords: keywords(''),
        lineComment: [],
        blockComment: { open: '/*', close: '*/' },
        quotes: ['"', "'"],
        tripleQuotes: false,
        decorators: true,
        numbers: true,
    },
};

const EXTENSIONS: Readonly<Record<string, LanguageId>> = {
    ts: 'ts',
    tsx: 'ts',
    mts: 'ts',
    cts: 'ts',
    js: 'ts',
    jsx: 'ts',
    mjs: 'ts',
    cjs: 'ts',
    py: 'py',
    pyi: 'py',
    go: 'go',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    css: 'css',
    md: 'md',
};

/** null means the extension has no profile. Render the file without highlighting. */
export function languageOf(path: string): LanguageId | null {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return null;
    }
    return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function tokenizeLine(text: string, language: LanguageId): SyntaxToken[] {
    if (language === 'md') {
        return tokenizeMarkdown(text);
    }

    const profile = PROFILES[language];
    const continuation = commentContinuation(text, profile);
    if (continuation !== null) {
        return [continuation];
    }

    const tokens: SyntaxToken[] = [];
    let i = 0;
    while (i < text.length) {
        const char = text[i] ?? '';

        const lineComment = profile.lineComment.find((prefix) => text.startsWith(prefix, i));
        if (lineComment !== undefined) {
            tokens.push({ from: i, to: text.length, kind: 'comment' });
            break;
        }

        const block = profile.blockComment;
        if (block !== null && text.startsWith(block.open, i)) {
            const close = text.indexOf(block.close, i + block.open.length);
            const to = close === -1 ? text.length : close + block.close.length;
            tokens.push({ from: i, to, kind: 'comment' });
            i = to;
            continue;
        }

        if (profile.tripleQuotes && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
            const quote = text.slice(i, i + 3);
            const close = text.indexOf(quote, i + 3);
            const to = close === -1 ? text.length : close + 3;
            tokens.push({ from: i, to, kind: 'string' });
            i = to;
            continue;
        }

        if (profile.quotes.includes(char)) {
            const to = scanString(text, i, char);
            tokens.push({ from: i, to, kind: 'string' });
            i = to;
            continue;
        }

        if (profile.decorators && char === '@' && isIdentifierStart(text[i + 1] ?? '')) {
            const to = scanIdentifier(text, i + 1);
            tokens.push({ from: i, to, kind: 'decorator' });
            i = to;
            continue;
        }

        if (isIdentifierStart(char)) {
            const to = scanIdentifier(text, i);
            if (profile.keywords.has(text.slice(i, to))) {
                tokens.push({ from: i, to, kind: 'keyword' });
            }
            i = to;
            continue;
        }

        if (profile.numbers && isDigit(char)) {
            const to = scanNumber(text, i);
            if (to > i) {
                // `docs/design/README.md` §1 colours numbers like strings, without a separate category.
                tokens.push({ from: i, to, kind: 'string' });
                i = to;
                continue;
            }
        }

        i += 1;
    }
    return tokens;
}

/**
 * A block comment continuation is a line starting with an asterisk (JSDoc body or closing
 * line). This is the lexer's only multiline guess. An expression wrapped onto a line starting
 * with an asterisk (`* 2;`) also gets highlighted as a comment, a trade-off of "intentionally minimal",
 * and a small one: JSDoc bodies are orders of magnitude more common in diffs.
 */
const COMMENT_CONTINUATION_RE = /^\s*\*(\s|\/|$)/;

function commentContinuation(text: string, profile: LanguageProfile): SyntaxToken | null {
    if (profile.blockComment === null || !COMMENT_CONTINUATION_RE.test(text)) {
        return null;
    }
    const from = text.indexOf('*');
    return { from, to: text.length, kind: 'comment' };
}

const MD_HEADING_RE = /^ {0,3}#{1,6}\s/;

/** Markdown: whole heading and inline code. The rest is plain text with nothing to highlight. */
function tokenizeMarkdown(text: string): SyntaxToken[] {
    if (MD_HEADING_RE.test(text)) {
        return [{ from: 0, to: text.length, kind: 'keyword' }];
    }

    const tokens: SyntaxToken[] = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '`') {
            i += 1;
            continue;
        }
        const close = text.indexOf('`', i + 1);
        if (close === -1) {
            break;
        }
        tokens.push({ from: i, to: close + 1, kind: 'string' });
        i = close + 1;
    }
    return tokens;
}

/** End of a string literal: closing quote (with escapes handled) or end of line. */
function scanString(text: string, start: number, quote: string): number {
    let i = start + 1;
    while (i < text.length) {
        const char = text[i];
        if (char === '\\') {
            i += 2;
            continue;
        }
        if (char === quote) {
            return i + 1;
        }
        i += 1;
    }
    return text.length;
}

function scanIdentifier(text: string, start: number): number {
    let i = start;
    while (i < text.length && isIdentifierPart(text[i] ?? '')) {
        i += 1;
    }
    return i;
}

const NUMBER_RE = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/;

/**
 * End of a numeric literal, or `start` if there is no number here. Digits followed immediately by a letter
 * (`01hq` in `key-01hq`) are not a number, they are part of something else.
 */
function scanNumber(text: string, start: number): number {
    const match = NUMBER_RE.exec(text.slice(start));
    if (match === null) {
        return start;
    }
    const to = start + match[0].length;
    return isIdentifierPart(text[to] ?? '') ? start : to;
}

function isIdentifierStart(char: string): boolean {
    return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
    return /[\w$]/.test(char);
}

function isDigit(char: string): boolean {
    return char >= '0' && char <= '9';
}

function keywords(list: string): ReadonlySet<string> {
    return new Set(list.split(/\s+/).filter((word) => word.length > 0));
}
