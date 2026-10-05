import type { Element, RootContent } from 'hast';

import { lowlight } from './languages.js';
import type { LanguageId, SyntaxKind, SyntaxToken } from './model.js';

/**
 * Syntax highlighting with highlight.js (`lowlight` wrapper, grammar registry in `languages.ts`).
 *
 * One tree traversal assigns categories shared by all themes. Anything absent from the table
 * inherits its parent category, while the root uses plain.
 * Switching themes changes CSS without reparsing the text.
 */

/**
 * Original hljs scope → highlighting category. The key is the first scope segment.
 *
 * A `null` value resets the category: `subst` (template string substitution) is inside `string`,
 * but it is code, not a string. A missing key inherits the parent category, so
 * `doctag` inside a comment stays a comment.
 */
const SCOPE_KINDS = new Map<string, SyntaxKind | null>([
    ['keyword', 'keyword'],
    ['built_in', 'keyword'],
    ['type', 'type'],
    ['literal', 'keyword'],
    // Markdown heading: the old lexer used keyword colour, so keep that colour.
    ['section', 'keyword'],
    ['string', 'string'],
    ['attr', 'property'],
    ['property', 'property'],
    ['number', 'number'],
    ['variable', 'variable'],
    ['template-variable', 'variable'],
    ['regexp', 'string'],
    ['char', 'string'],
    ['symbol', 'string'],
    // Markdown code: colour only inline code in backticks, see `kindOf`.
    ['code', 'string'],
    ['comment', 'comment'],
    ['doctag', 'comment'],
    // `@decorator`, `#include`, shebang, C# attributes: everything hljs calls meta.
    ['meta', 'decorator'],
    ['subst', null],
]);

/**
 * Above this size, highlighting is not worth the cost: it is a minified bundle or generated
 * data that nobody will read line by line anyway, and hljs takes tens of
 * milliseconds on such text. The per-line threshold matches `MARKUP_LIMIT` in `diff-view/line-segments.ts`:
 * long lines there already render without markup.
 */
export const MAX_HIGHLIGHT_CHARS = 200_000;
const MAX_HIGHLIGHT_LINE = 4000;

/** The fragment is worth highlighting: not a minified bundle and no excessively long lines. */
export function highlightable(lines: readonly string[]): boolean {
    let total = 0;
    for (const line of lines) {
        if (line.length > MAX_HIGHLIGHT_LINE) {
            return false;
        }
        total += line.length + 1;
        if (total > MAX_HIGHLIGHT_CHARS) {
            return false;
        }
    }
    return true;
}

/** File extensions → hljs language. The whole JS family uses `typescript`: its grammar is a superset. */
const EXTENSIONS = new Map<string, LanguageId>([
    ['ts', 'typescript'],
    ['tsx', 'typescript'],
    ['mts', 'typescript'],
    ['cts', 'typescript'],
    ['js', 'typescript'],
    ['jsx', 'typescript'],
    ['mjs', 'typescript'],
    ['cjs', 'typescript'],
    ['py', 'python'],
    ['pyi', 'python'],
    ['pyw', 'python'],
    ['go', 'go'],
    ['java', 'java'],
    ['kt', 'kotlin'],
    ['kts', 'kotlin'],
    ['c', 'c'],
    ['cc', 'cpp'],
    ['cpp', 'cpp'],
    ['cxx', 'cpp'],
    ['h', 'cpp'],
    ['hh', 'cpp'],
    ['hpp', 'cpp'],
    ['rs', 'rust'],
    ['rb', 'ruby'],
    ['php', 'php'],
    ['cs', 'csharp'],
    ['swift', 'swift'],
    ['scala', 'scala'],
    ['sc', 'scala'],
    ['sql', 'sql'],
    ['sh', 'bash'],
    ['bash', 'bash'],
    ['zsh', 'bash'],
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
    ['json', 'json'],
    ['css', 'css'],
    ['scss', 'scss'],
    ['less', 'less'],
    ['xml', 'xml'],
    ['html', 'xml'],
    ['htm', 'xml'],
    ['svg', 'xml'],
    ['md', 'markdown'],
    ['markdown', 'markdown'],
    ['mk', 'makefile'],
    ['proto', 'protobuf'],
    ['ini', 'ini'],
    ['toml', 'ini'],
    ['cfg', 'ini'],
    ['properties', 'properties'],
    ['graphql', 'graphql'],
    ['gql', 'graphql'],
    ['lua', 'lua'],
    ['pl', 'perl'],
    ['pm', 'perl'],
    ['r', 'r'],
    ['cmake', 'cmake'],
    ['groovy', 'groovy'],
    ['gradle', 'groovy'],
    ['dart', 'dart'],
    ['hs', 'haskell'],
    ['erl', 'erlang'],
    ['ex', 'elixir'],
    ['exs', 'elixir'],
    ['clj', 'clojure'],
    ['cljs', 'clojure'],
    ['diff', 'diff'],
    ['patch', 'diff'],
]);

/** Files recognized by their full name instead of their extension. */
const FILENAMES = new Map<string, LanguageId>([
    ['makefile', 'makefile'],
    ['gnumakefile', 'makefile'],
    ['dockerfile', 'dockerfile'],
    ['cmakelists.txt', 'cmake'],
    ['gemfile', 'ruby'],
    ['rakefile', 'ruby'],
]);

/**
 * Fence info strings that the hljs registry does not know by that name. It has enough aliases
 * of its own (`ts`, `py`, `c++`, `yml`), so the table only fills the gaps.
 */
const NAME_ALIASES = new Map<string, LanguageId>([
    ['cfg', 'ini'],
    ['conf', 'ini'],
    ['docker', 'dockerfile'],
    ['jsonc', 'json'],
    ['plain', 'plaintext'],
    ['text', 'plaintext'],
]);

/** null means the registry has no language for this file: it renders without highlighting. */
export function languageOf(path: string): LanguageId | null {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();

    const byName = FILENAMES.get(name);
    if (byName !== undefined) {
        return registered(byName);
    }

    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return null;
    }
    const byExtension = EXTENSIONS.get(name.slice(dot + 1));
    return byExtension === undefined ? null : registered(byExtension);
}

/**
 * Language name (Markdown fence info string) → registry language. null means it is absent from the registry.
 * The hljs registry resolves aliases (`ts`, `golang`, `c++`) itself.
 */
export function languageByName(name: string): LanguageId | null {
    const key = name.trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (key.length === 0) {
        return null;
    }
    return registered(NAME_ALIASES.get(key) ?? key);
}

function registered(name: string): LanguageId | null {
    return lowlight.registered(name) ? name : null;
}

/**
 * Multiline text tokens split into lines: the result index is the line number
 * in `text.split('\n')`, and token offsets are relative to the start of each line. A token crossing a newline
 * (block comment, template string) is split across lines.
 */
export function highlightText(text: string, language: LanguageId): SyntaxToken[][] {
    const lines: SyntaxToken[][] = text.split('\n').map(() => []);
    if (!lowlight.registered(language)) {
        return lines;
    }

    walk(lowlight.highlight(language, text).children, null, lines, { line: 0, column: 0 }, language);
    return lines.map(merge);
}

/** Tokens for a single line, a thin wrapper around `highlightText`. */
export function tokenizeLine(text: string, language: LanguageId): SyntaxToken[] {
    return highlightText(text, language)[0] ?? [];
}

/** Traversal position in the source text: hast returns nodes in order, so this is enough. */
interface Cursor {
    line: number;
    column: number;
}

function walk(
    nodes: readonly RootContent[],
    kind: SyntaxKind | null,
    lines: SyntaxToken[][],
    cursor: Cursor,
    language: LanguageId,
    container?: Element,
): void {
    for (const node of nodes) {
        if (node.type === 'text') {
            emit(node.value, kind, lines, cursor);
            continue;
        }
        if (node.type === 'element') {
            walk(
                node.children,
                kindOf(node, kind, language, container),
                lines,
                cursor,
                language,
                node,
            );
        }
    }
}

/** Node category: its own if the table has its scope (including a reset), otherwise its parent category. */
function kindOf(
    node: Element,
    parent: SyntaxKind | null,
    language: LanguageId,
    container?: Element,
): SyntaxKind | null {
    const classes = node.properties.className;
    const first = Array.isArray(classes) ? classes[0] : undefined;
    if (typeof first !== 'string' || !first.startsWith('hljs-')) {
        return parent;
    }
    const scope = first.slice('hljs-'.length);
    // Older Go/C++ grammars nest `title` inside `function`, newer ones return `title.function`.
    // Colour only the name, not the entire declaration container with parameters and spaces.
    if (scope === 'title' && Array.isArray(classes) && parent !== 'decorator') {
        const containerClasses = container?.properties.className;
        if (classes.includes('class_') || containerClasses?.includes('hljs-class')) {
            return 'type';
        }
        if (classes.includes('function_') || containerClasses?.includes('hljs-function')) {
            return 'function';
        }
    }
    // YAML calls both document boundaries and anchors meta. Only an anchor/reference is a variable.
    if (scope === 'meta' && (language === 'yaml' || language === 'yml')) {
        const firstChild = node.children[0];
        if (firstChild?.type === 'text' && /^[&*]/.test(firstChild.value)) {
            return 'variable';
        }
    }
    if (!SCOPE_KINDS.has(scope)) {
        return parent;
    }
    // hljs marks both inline code in backticks and an entire fenced block, including its fences,
    // with the `code` scope. Colour inline code as a string (as the old lexer did), and leave the fence
    // plain: giving every code block body in an .md diff string colour fills the screen with noise.
    if (scope === 'code' && spansLines(node)) {
        return parent;
    }
    const own = SCOPE_KINDS.get(scope) ?? null;
    // Inside meta (`#include <x>`, `@dataclass(frozen=True)`), hljs marks both keywords
    // and literals. The reviewer sees a single construct, so decorator colour holds to the end,
    // with only strings overriding it.
    if (parent === 'decorator' && own !== 'string') {
        return parent;
    }
    return own;
}

/** The node text spans more than one line. */
function spansLines(node: Element): boolean {
    return node.children.some(
        (child) =>
            (child.type === 'text' && child.value.includes('\n')) ||
            (child.type === 'element' && spansLines(child)),
    );
}

/** Convert node text into tokens, one piece per line. Empty pieces and plain are not emitted. */
function emit(
    value: string,
    kind: SyntaxKind | null,
    lines: SyntaxToken[][],
    cursor: Cursor,
): void {
    for (const [index, piece] of value.split('\n').entries()) {
        if (index > 0) {
            cursor.line += 1;
            cursor.column = 0;
        }
        if (piece.length === 0) {
            continue;
        }
        if (kind !== null) {
            lines[cursor.line]?.push({
                from: cursor.column,
                to: cursor.column + piece.length,
                kind,
            });
        }
        cursor.column += piece.length;
    }
}

/** Merge adjacent tokens of the same category. */
function merge(tokens: readonly SyntaxToken[]): SyntaxToken[] {
    const merged: SyntaxToken[] = [];
    for (const token of tokens) {
        const last = merged.at(-1);
        if (last?.kind === token.kind && last.to === token.from) {
            merged[merged.length - 1] = { ...last, to: token.to };
            continue;
        }
        merged.push(token);
    }
    return merged;
}
