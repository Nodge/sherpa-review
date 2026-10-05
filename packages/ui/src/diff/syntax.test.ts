import { describe, expect, it } from 'vitest';

import type { LanguageId, SyntaxKind } from './model.js';
import { highlightable, highlightText, languageByName, languageOf, tokenizeLine } from './syntax.js';

/** Tokens as "category → text" pairs show exactly what received colour. */
function paint(text: string, language: LanguageId): [SyntaxKind, string][] {
    return tokenizeLine(text, language).map((token) => [token.kind, text.slice(token.from, token.to)]);
}

/** The same for multiline text: an array of lines, each with its own pairs. */
function paintText(text: string, language: LanguageId): [SyntaxKind, string][][] {
    const lines = text.split('\n');
    return highlightText(text, language).map((tokens, index) =>
        tokens.map((token) => [token.kind, (lines[index] ?? '').slice(token.from, token.to)]),
    );
}

describe('language from the file path', () => {
    it('the entire JS family uses the typescript grammar', () => {
        expect(languageOf('src/a.ts')).toBe('typescript');
        expect(languageOf('src/a.tsx')).toBe('typescript');
        expect(languageOf('src/a.jsx')).toBe('typescript');
        expect(languageOf('src/a.mjs')).toBe('typescript');
        expect(languageOf('src/a.cts')).toBe('typescript');
    });

    it('extensions for other languages', () => {
        expect(languageOf('service/order_service.py')).toBe('python');
        expect(languageOf('cmd/main.go')).toBe('go');
        expect(languageOf('services/orders/.github/CODEOWNERS')).toBe('yaml');
        expect(languageOf('README.md')).toBe('markdown');
        expect(languageOf('api/order.proto')).toBe('protobuf');
        expect(languageOf('src/main/java/Order.kt')).toBe('kotlin');
        expect(languageOf('src/lib.rs')).toBe('rust');
        expect(languageOf('include/order.hpp')).toBe('cpp');
    });

    it('languages missing from the old lexer no longer return null', () => {
        expect(languageOf('scripts/rollout.sh')).toBe('bash');
        expect(languageOf('Makefile')).toBe('makefile');
        expect(languageOf('build/Dockerfile')).toBe('dockerfile');
        expect(languageOf('CMakeLists.txt')).toBe('cmake');
    });

    it('files with no language', () => {
        expect(languageOf('.gitignore')).toBeNull();
        expect(languageOf('pnpm-lock.lock')).toBeNull();
        expect(languageOf('assets/logo.png')).toBeNull();
        expect(languageOf('LICENSE')).toBeNull();
    });

    it('language names use hljs aliases and a table of missing names, unknown names return null', () => {
        expect(languageByName('ts')).toBe('ts');
        expect(languageByName('golang')).toBe('golang');
        expect(languageByName('C++')).toBe('c++');
        expect(languageByName('docker')).toBe('dockerfile');
        expect(languageByName('ts title="a.ts"')).toBe('ts');
        expect(languageByName('brainfuck')).toBeNull();
        expect(languageByName('   ')).toBeNull();
    });

    it('Object.prototype property names are ordinary unknown names and do not crash', () => {
        expect(languageByName('constructor')).toBeNull();
        expect(languageByName('__proto__')).toBeNull();
        expect(languageOf('src/constructor')).toBeNull();
        expect(languageOf('src/a.constructor')).toBeNull();
        expect(languageOf('src/__proto__.toString')).toBeNull();
    });
});

describe('highlight categories', () => {
    it('parsing returns one category per token regardless of styling', () => {
        expect(tokenizeLine('int main() { return 0; }', 'cpp')).toEqual([
            { from: 0, to: 3, kind: 'type' },
            { from: 4, to: 8, kind: 'function' },
            { from: 13, to: 19, kind: 'keyword' },
            { from: 20, to: 21, kind: 'number' },
        ]);
    });

    it('class names and properties receive type and property categories', () => {
        expect(paint('class Order extends Base {}; value.field;', 'typescript')).toEqual([
            ['keyword', 'class'],
            ['type', 'Order'],
            ['keyword', 'extends'],
            ['type', 'Base'],
            ['property', 'field'],
        ]);
    });

    it('TypeScript keywords and numbers have different categories', () => {
        expect(paint('export const EDIT_WINDOW_MS = 30 * 60 * 1000;', 'typescript')).toEqual([
            ['keyword', 'export'],
            ['keyword', 'const'],
            ['variable', 'EDIT_WINDOW_MS'],
            ['number', '30'],
            ['number', '60'],
            ['number', '1000'],
        ]);
    });

    it('an import path is a string', () => {
        expect(paint('import { Clock } from "../infra/clock";', 'typescript')).toEqual([
            ['keyword', 'import'],
            ['type', 'Clock'],
            ['keyword', 'from'],
            ['string', '"../infra/clock"'],
        ]);
    });

    it('an ordinary identifier has no category and falls back to plain', () => {
        expect(paint('const value = order;', 'typescript')).toEqual([['keyword', 'const']]);
    });

    it('a decorator has its own category', () => {
        expect(paint('@Injectable()', 'typescript')).toEqual([['decorator', '@Injectable']]);
    });

    it('a shebang receives decorator colour: hljs calls it meta', () => {
        expect(paint('#!/bin/sh', 'bash')).toEqual([['decorator', '#!/bin/sh']]);
    });

    it('meta gets decorator colour throughout, with only strings overriding it inside', () => {
        expect(paint('@dataclass(frozen=True)', 'python')).toEqual([['decorator', '@dataclass(frozen=True)']]);
        expect(paint('#include <vector>', 'cpp')).toEqual([
            ['decorator', '#include '],
            ['string', '<vector>'],
        ]);
    });

    it('JSON and YAML keys differ from string values and numbers', () => {
        expect(paint('  "editWindowMs": 1800000,', 'json')).toEqual([
            ['property', '"editWindowMs"'],
            ['number', '1800000'],
        ]);
        expect(paint('replicas: 3', 'yaml')).toEqual([
            ['property', 'replicas:'],
            ['number', '3'],
        ]);
    });

    it('a config string value keeps a separate category', () => {
        expect(paint('title: "Build service"', 'yaml')).toEqual([
            ['property', 'title:'],
            ['string', '"Build service"'],
        ]);
        expect(paint('"title": "Build service"', 'json')).toEqual([
            ['property', '"title"'],
            ['string', '"Build service"'],
        ]);
    });

    it('a YAML anchor and its reference are highlighted as variables', () => {
        for (const language of ['yaml', 'yml']) {
            expect(paintText('config: &service\ncopy: *service', language)).toEqual([
                [
                    ['property', 'config:'],
                    ['variable', '&service'],
                ],
                [
                    ['property', 'copy:'],
                    ['variable', '*service'],
                ],
            ]);
            expect(paint('---', language)).toEqual([['decorator', '---']]);
        }
    });

    it('function and class names differ from keywords', () => {
        expect(paint('function apply() { return 1; }', 'typescript')).toEqual([
            ['keyword', 'function'],
            ['function', 'apply'],
            ['keyword', 'return'],
            ['number', '1'],
        ]);
        expect(paint('class Order extends Base {}', 'typescript')).toEqual([
            ['keyword', 'class'],
            ['type', 'Order'],
            ['keyword', 'extends'],
            ['type', 'Base'],
        ]);
        expect(paint('apply(order);', 'typescript')).toEqual([['function', 'apply']]);
        expect(paint('int main() { return 0; }', 'cpp')).toEqual([
            ['type', 'int'],
            ['function', 'main'],
            ['keyword', 'return'],
            ['number', '0'],
        ]);
    });

    it('a variable inside a shell string keeps its category', () => {
        expect(paint('echo "$HOME"', 'bash')).toEqual([
            ['keyword', 'echo'],
            ['string', '"'],
            ['variable', '$HOME'],
            ['string', '"'],
        ]);
    });

    it('python: declaration, literals and comment', () => {
        expect(paint('def apply_edit(self, order: Order) -> None:', 'python')).toEqual([
            ['keyword', 'def'],
            ['function', 'apply_edit'],
            ['keyword', 'None'],
        ]);
        expect(paint('    total = 0  # running sum', 'python')).toEqual([
            ['number', '0'],
            ['comment', '# running sum'],
        ]);
    });

    it('go: keyword and string', () => {
        expect(paint('func main() {', 'go')).toEqual([
            ['keyword', 'func'],
            ['function', 'main'],
        ]);
        expect(paint('\tfmt.Println("hi")', 'go')).toEqual([['string', '"hi"']]);
    });

    it('markdown: headings are keyword, inline code is string', () => {
        expect(paint('## Domain', 'markdown')).toEqual([['keyword', '## Domain']]);
        expect(paint('- `order.ts` — the aggregate root.', 'markdown')).toEqual([['string', '`order.ts`']]);
    });

    it('markdown: a fenced code block does not get string colour throughout', () => {
        expect(paintText('# Title\n\n```ts\nconst a = 1;\n```\n\ntext `inline` here', 'markdown')).toEqual([
            [['keyword', '# Title']],
            [],
            [],
            [],
            [],
            [],
            [['string', '`inline`']],
        ]);
    });

    it('a template string substitution is code, not a string', () => {
        expect(paint('const t = `id-${String(x)} ok`;', 'typescript')).toEqual([
            ['keyword', 'const'],
            ['string', '`id-'],
            // `String` is built_in inside subst: the string category resets and keyword takes over.
            ['keyword', 'String'],
            ['string', ' ok`'],
        ]);
    });

    it('a doctag inside a comment stays a comment instead of becoming a decorator', () => {
        expect(paintText('/**\n * @param order the aggregate root\n */', 'typescript')).toEqual([
            [['comment', '/**']],
            [['comment', ' * @param order the aggregate root']],
            [['comment', ' */']],
        ]);
    });

    it('adjacent tokens of the same category merge: an escape inside a string stays one piece', () => {
        expect(paint('const s = "a\\"b";', 'typescript')).toEqual([
            ['keyword', 'const'],
            ['string', '"a\\"b"'],
        ]);
    });

    it('offsets use the raw string with tabs', () => {
        expect(tokenizeLine('\tconst\tx = "tab";', 'typescript')).toEqual([
            { from: 1, to: 6, kind: 'keyword' },
            { from: 11, to: 16, kind: 'string' },
        ]);
    });
});

describe('multiline constructs', () => {
    it('a block comment receives colour on all its lines, unlike with the line-by-line lexer', () => {
        expect(paintText('/*\n * body\n */\nconst x = 1;', 'typescript')).toEqual([
            [['comment', '/*']],
            [['comment', ' * body']],
            [['comment', ' */']],
            [
                ['keyword', 'const'],
                ['number', '1'],
            ],
        ]);
    });

    it('a Python docstring continues until the closing quotes', () => {
        expect(paintText('"""doc\nmore"""\nx = 1', 'python')).toEqual([
            [['string', '"""doc']],
            [['string', 'more"""']],
            [['number', '1']],
        ]);
    });

    it('a token splits at newlines with offsets from the start of each line', () => {
        const tokens = highlightText('  /* a\n b */', 'typescript');
        expect(tokens).toEqual([
            [{ from: 2, to: 6, kind: 'comment' }],
            [{ from: 0, to: 5, kind: 'comment' }],
        ]);
    });

    it('the output line count matches the input line count', () => {
        expect(highlightText('a\n\nb\n', 'typescript')).toHaveLength(4);
        expect(highlightText('', 'typescript')).toEqual([[]]);
    });
});

describe('length limit', () => {
    it('an ordinary fragment gets highlighted', () => {
        expect(highlightable(['const a = 1;', 'const b = 2;'])).toBe(true);
    });

    it('a minified bundle does not: one line exceeds the markup threshold', () => {
        expect(highlightable(['x'.repeat(4001)])).toBe(false);
    });

    it('generated data does not: the whole fragment exceeds the threshold', () => {
        expect(highlightable(new Array<string>(2000).fill('y'.repeat(200)))).toBe(false);
    });
});
