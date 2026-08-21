import { describe, expect, it } from 'vitest';

import type { LanguageId, SyntaxKind } from './model.js';
import { languageOf, tokenizeLine } from './syntax.js';

/** Tokens as "category → text" pairs show exactly what received colour. */
function paint(text: string, language: LanguageId): [SyntaxKind, string][] {
    return tokenizeLine(text, language).map((token) => [token.kind, text.slice(token.from, token.to)]);
}

describe('language by extension', () => {
    it('maps the whole JS family to one profile', () => {
        expect(languageOf('src/a.ts')).toBe('ts');
        expect(languageOf('src/a.tsx')).toBe('ts');
        expect(languageOf('src/a.jsx')).toBe('ts');
        expect(languageOf('src/a.mjs')).toBe('ts');
    });

    it('other profiles and files without a profile', () => {
        expect(languageOf('service/order_service.py')).toBe('py');
        expect(languageOf('cmd/main.go')).toBe('go');
        expect(languageOf('services/orders/.github/CODEOWNERS')).toBe('yaml');
        expect(languageOf('README.md')).toBe('md');
        expect(languageOf('scripts/rollout.sh')).toBeNull();
        expect(languageOf('Makefile')).toBeNull();
        expect(languageOf('.gitignore')).toBeNull();
    });
});

describe('TypeScript lexer', () => {
    it('keywords, strings and numbers in a fixture line', () => {
        expect(paint('export const EDIT_WINDOW_MS = 30 * 60 * 1000;', 'ts')).toEqual([
            ['keyword', 'export'],
            ['keyword', 'const'],
            ['string', '30'],
            ['string', '60'],
            ['string', '1000'],
        ]);
    });

    it('an import path is a string', () => {
        expect(paint('import { Clock } from "../infra/clock";', 'ts')).toEqual([
            ['keyword', 'import'],
            ['keyword', 'from'],
            ['string', '"../infra/clock"'],
        ]);
    });

    it('single-line JSDoc and multiline continuation', () => {
        expect(paint('/** How long the window stays open. */', 'ts')).toEqual([
            ['comment', '/** How long the window stays open. */'],
        ]);
        expect(paint('     * courier has been dispatched — dispatch wins.', 'ts')).toEqual([
            ['comment', '* courier has been dispatched — dispatch wins.'],
        ]);
    });

    it('an expression wrapped onto a line starting with an asterisk is highlighted as a comment, a known heuristic trade-off', () => {
        expect(paint('        * 2;', 'ts')).toEqual([['comment', '* 2;']]);
    });

    it('decorator', () => {
        expect(paint('@Injectable()', 'ts')).toEqual([['decorator', '@Injectable']]);
    });

    it('an ordinary identifier has no category and falls back to plain', () => {
        expect(paint('recomputeEditWindow(order);', 'ts')).toEqual([]);
    });

    it('highlights an unclosed string to the end of the line and handles escapes', () => {
        expect(paint('const s = "unterminated', 'ts')).toEqual([
            ['keyword', 'const'],
            ['string', '"unterminated'],
        ]);
        expect(paint('const s = "a\\"b";', 'ts')).toEqual([
            ['keyword', 'const'],
            ['string', '"a\\"b"'],
        ]);
    });
});

describe('Python lexer', () => {
    it('function declaration', () => {
        expect(paint('def apply_edit(self, order: Order) -> None:', 'py')).toEqual([
            ['keyword', 'def'],
            ['keyword', 'self'],
            ['keyword', 'None'],
        ]);
    });

    it('hash starts a comment through the end of the line', () => {
        expect(paint('    total = 0  # running sum', 'py')).toEqual([
            ['string', '0'],
            ['comment', '# running sum'],
        ]);
    });

    it('decorator and docstring', () => {
        expect(paint('@dataclass(frozen=True)', 'py')).toEqual([
            ['decorator', '@dataclass'],
            ['keyword', 'True'],
        ]);
        expect(paint('    """Apply the edit if the window is open."""', 'py')).toEqual([
            ['string', '"""Apply the edit if the window is open."""'],
        ]);
        expect(paint('    """Open docstring, closes on another line', 'py')).toEqual([
            ['string', '"""Open docstring, closes on another line'],
        ]);
    });
});

describe('data and markup lexers', () => {
    it('yaml: comment, literals, numbers', () => {
        expect(paint('  enabled: true  # off in main', 'yaml')).toEqual([
            ['keyword', 'true'],
            ['comment', '# off in main'],
        ]);
    });

    it('yaml: digits within a word are not numbers', () => {
        expect(paint('  secret: key-01hq', 'yaml')).toEqual([]);
    });

    it('json: literals and strings', () => {
        expect(paint('  "strict": true,', 'json')).toEqual([
            ['string', '"strict"'],
            ['keyword', 'true'],
        ]);
    });

    it('css: at-rule and block comment, number with a unit stays unhighlighted', () => {
        expect(paint('@media (max-width: 640px) { /* narrow */', 'css')).toEqual([
            ['decorator', '@media'],
            ['comment', '/* narrow */'],
        ]);
        expect(paint('  opacity: 0.72;', 'css')).toEqual([['string', '0.72']]);
    });

    it('md: whole heading and inline code', () => {
        expect(paint('## Domain', 'md')).toEqual([['keyword', '## Domain']]);
        expect(paint('- `order.ts` — the aggregate root.', 'md')).toEqual([['string', '`order.ts`']]);
    });
});
