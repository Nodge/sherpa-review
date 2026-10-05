import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Check design tokens against the handoff.
 *
 * Geometry, fonts, disabled opacity and motion are checked against `EXPECTED`, a table
 * copied from the "Design tokens" section of `docs/design/README.md`.
 * Palette colours are checked against `docs/design/theme.md`. Component tokens live only in CSS:
 * each theme is checked for a complete set without duplicating values in the docs.
 */

/** Non-colour token → value from the design handoff. Each group comment names its section. */
const EXPECTED: Record<string, string> = {
    // docs/design/SPEC-elements.md §1.1: disabled opacity .45.
    '--disabled-opacity': '.45',

    // Type — IBM Plex Sans 400/450/500/600 for UI, IBM Plex Mono 400/500 for code, paths, numbers,
    // commits, keys and all machine data. The scale lives in docs/design/theme.md, in the
    // "Typography" section: sizes in rem, an 11px floor. A separate test checks the values below
    // against that table, so there is no reason to repeat it in prose here.
    '--font-sans': "'IBM Plex Sans',system-ui,sans-serif",
    '--font-mono': "'IBM Plex Mono',ui-monospace,monospace",
    '--font-size-pr-title-overview': '1.5rem',
    '--font-size-pr-title': '1.375rem',
    '--font-size-screen-title': '1.1875rem',
    '--font-size-stop-title-high': '1.0625rem',
    '--font-size-stop-title': '0.9688rem',
    '--font-size-section-title': '0.9688rem',
    '--font-size-input': '0.875rem',
    '--font-size-body': '0.8438rem',
    '--font-size-ui': '0.8125rem',
    '--font-size-secondary': '0.7813rem',
    '--font-size-control': '0.75rem',
    '--font-size-meta': '0.7188rem',
    '--font-size-gutter': '0.6875rem',
    '--font-size-badge': '0.6875rem',
    '--font-size-scope': '0.6875rem',
    '--font-size-tag': '0.6875rem',
    '--font-size-stop-mark': '0.625rem',
    '--font-size-avatar-glyph': '0.5625rem',
    '--font-size-close-glyph': '1.125rem',
    '--font-size-code': '0.75rem',
    '--line-height-body': '1.62',
    // Code line density in px does not depend on text size.
    '--line-height-code': '20px',

    // Radius — 2–3px (rules, tier marks) · 4–5px (badges, small chips) · 6px (buttons, rows) ·
    // 7px (inputs, chips, primary buttons) · 8–9px (cards, popovers) · 10–12px (panels, dialogs).
    // Ranges map to specific roles using sizes from docs/design/README.md §0–§5 and §14.
    '--radius-rule': '2px',
    '--radius-mark': '3px',
    '--radius-key': '4px',
    '--radius-badge': '5px',
    '--radius-button': '6px',
    '--radius-input': '7px',
    '--radius-popover': '8px',
    '--radius-card': '9px',
    // docs/design/README.md §5: the floating bar has its own 11px radius.
    '--radius-floating': '11px',
    '--radius-panel': '12px',

    // Spacing — page gutter `clamp(30px, 2.4vw, 60px)` · column gap `clamp(40px, 3vw, 72px)` ·
    // 22px card gap · 14px control gap · 8–10px inner gap.
    '--space-page': 'clamp(30px, 2.4vw, 60px)',
    '--space-column': 'clamp(40px, 3vw, 72px)',
    '--space-card': '22px',
    '--space-control': '14px',
    '--space-inner': '10px',
    '--space-inner-tight': '8px',
    // Prototype: Sherpa.dc.html:217 reserves 180px below Route. Shared by all reader views.
    '--space-bar-reserve': '180px',

    // Widths — docs/design/README.md §4 (agent panel `clamp(392px, 26vw, 560px)`), §10 (file tree
    // `clamp(320px, 22vw, 560px)`) and "Spacing" (`--diff-max` 1280px unified / 1920px side by side).
    '--width-agent-panel': 'clamp(392px, 26vw, 560px)',
    '--width-file-tree': 'clamp(320px, 22vw, 560px)',
    '--diff-max': '1280px',

    // Motion — spinner `spin .8s linear infinite` · skeleton/streaming `shimmer 1.6s ease-in-out
    // infinite` · caret `caret 1s step-end infinite` · jump scroll ~320ms ease-in-out cubic ·
    // jump flash ~900ms. Also docs/design/SPEC-elements.md §1.1: hover 90ms ease-out.
    // "ease-in-out cubic" uses the easeInOutCubic curve. CSS has no such keyword.
    '--motion-hover': '90ms',
    '--motion-hover-ease': 'ease-out',
    '--motion-spin': '.8s',
    '--motion-shimmer': '1.6s',
    '--motion-caret': '1s',
    '--motion-jump': '320ms',
    '--motion-jump-ease': 'cubic-bezier(.65,0,.35,1)',
    '--motion-flash': '900ms',
};



    ...EXPECTED,
    
    '--font-mono': "Menlo, Monaco, Consolas, 'Liberation Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Courier New', Courier, monospace",
    '--font-size-body': '0.875rem',
    '--font-size-ui': '0.875rem',
    '--font-size-secondary': '0.8125rem',
    '--font-size-control': '0.8125rem',
    '--font-size-meta': '0.8125rem',
    '--font-size-gutter': '0.75rem',
    '--line-height-body': '1.5',
    '--line-height-code': '17px',
    '--radius-badge': '3px',
    '--radius-button': '5px',
    '--radius-input': '5px',
    '--radius-card': '5px',
    '--radius-floating': '8px',
    '--radius-panel': '8px',
    '--space-page': '20px',
    '--space-column': '32px',
    '--space-card': '12px',
    '--space-control': '12px',
    '--width-file-tree': 'clamp(280px, 22vw, 420px)',
};

const THEMES = ['dark', 'light'] as const;

type Theme = typeof THEMES[number];

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
const THEME_MD = readFileSync(fileURLToPath(new URL('../../../../docs/design/theme.md', import.meta.url)), 'utf8');

/**
 * Notation differences that CSS treats as the same value: spaces after commas, leading zeros
 * in fractions and case. The handoff writes `rgba(127,140,255,.13)`, the formatter `rgba(127, 140, 255, 0.13)`.
 * Compare the colour, not the spaces.
 */
function normalize(value: string): string {
    return value
        .toLowerCase()
        .replace(/\s*,\s*/g, ',')
        .replace(/\s+/g, ' ')
        .replace(/(^|[\s,(])0\.(\d)/g, '$1.$2')
        .trim();
}

/** `--name: value;` declarations from the base block. */
function parseRootTokens(css: string): Map<string, string> {
    const root = /:root(?:,\s*\[data-theme\])?\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
    if (root === undefined) {
        throw new Error('no :root block found in tokens.css');
    }

    const withoutComments = root.replace(/\/\*[\s\S]*?\*\//g, '');
    const tokens = new Map<string, string>();
    for (const [, name, value] of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        if (name !== undefined && value !== undefined) {
            tokens.set(name, normalize(value));
        }
    }
    return tokens;
}

/** Colour palette table from docs/design/theme.md. */
function parseThemeDoc(markdown: string): Record<Theme, Map<string, string>> {
    const result: Record<Theme, Map<string, string>> = {
        dark: new Map(), light: new Map(),
    };
    for (const [, name, darkValue, lightValue] of markdown.matchAll(
        /^\| `(--[a-z0-9-]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| [^|]+\|$/gm,
    )) {
        if (name === undefined || darkValue === undefined || lightValue === undefined
            ) {
            continue;
        }
        result.dark.set(name, normalize(darkValue));
        result.light.set(name, normalize(lightValue));
        
        
    }
    if (result.dark.size === 0) {
        throw new Error('colour token table not found in theme.md');
    }
    return result;
}

/** Only the selected theme's own block, without adjacent selectors or inherited values. */
function themeCss(theme: 'light'): string {
    const marker = `:root[data-theme='${theme}']`;
    const start = TOKENS_CSS.indexOf(marker);
    if (start < 0) {
        throw new Error(`No ${theme} block found in tokens.css`);
    }
    const after = TOKENS_CSS.slice(start + marker.length);
    const body = after.slice(after.indexOf('{') + 1, after.indexOf('}'));
    return `:root {${body}\n}`;
}

/**
 * The "token | rem | px at M | px at L | where" table under "Typography" in docs/design/theme.md.
 * The px columns derive from rem. The test recalculates them.
 */
function parseTypographyDoc(markdown: string): Map<string, { rem: string; m: string; l: string }> {
    const scale = new Map<string, { rem: string; m: string; l: string }>();
    for (const [, name, rem, m, l] of markdown.matchAll(
        /^\| `(--font-size-[a-z0-9-]+)` \| `([\d.]+rem)` \| ([\d.]+) \| ([\d.]+) \| [^|]+\|$/gm,
    )) {
        if (name !== undefined && rem !== undefined && m !== undefined && l !== undefined) {
            scale.set(name, { rem, m, l });
        }
    }
    if (scale.size === 0) {
        throw new Error('font scale table not found in theme.md');
    }
    return scale;
}

/** rem → px at `base`, rounded to tenths without a trailing zero, as in the table. */
function remToPx(rem: string, base: number): string {
    return String(Math.round(Number.parseFloat(rem) * base * 10) / 10);
}

const darkPalette = parseRootTokens(TOKENS_CSS);
const lightCss = themeCss('light');
const lightPalette = parseRootTokens(lightCss);




const palettes: Record<Theme, Map<string, string>> = {
    dark: darkPalette, light: lightPalette,
};
const documented = parseThemeDoc(THEME_MD);
const documentedScale = parseTypographyDoc(THEME_MD);


describe('design tokens', () => {
    it(':root declares every handoff token from README.md and theme.md', () => {
        expect([...darkPalette.keys()]).toEqual(
            expect.arrayContaining([...Object.keys(EXPECTED), ...documented.dark.keys()]),
        );
    });

    it('the handoff non-colour table contains no colours', () => {
        expect(Object.entries(EXPECTED).filter(([, value]) => /#|rgba?\(/.test(value))).toEqual([]);
    });

    for (const [name, expected] of Object.entries(EXPECTED)) {
        it(`${name} = ${expected}`, () => {
            expect(darkPalette.get(name)).toBe(normalize(expected));
        });
    }

    it('each token is declared once in each palette', () => {
        for (const block of TOKENS_CSS.matchAll(/\{([^{}]*)\}/g)) {
            const declarations = [...(block[1] ?? '').matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]);
            expect(declarations).toHaveLength(new Set(declarations).size);
        }
    });
});

/**
 * Font scale: docs/design/SPEC-theming-2026-09-12.md §5. Everything uses rem relative to the `html` base, with an
 * 11px floor (0.6875rem). Only decorative glyphs with no text of their own sit below it.
 */
describe('font scale', () => {
    const GLYPHS = new Set(['--font-size-avatar-glyph']);
    /**
     * The only text below the floor is the stop label in a tree row (§5, §6a): 10px in a
     * 17×13 label at the left edge. This list is closed. A second exception must go through the spec.
     */
    const FLOOR_EXCEPTIONS = new Set(['--font-size-stop-mark']);
    const FLOOR_REM = 0.6875;

    it('the theme.md table lists exactly the font tokens from tokens.css', () => {
        const inCss = [...darkPalette.keys()].filter((name) => name.startsWith('--font-size-'));
        expect(inCss.sort()).toEqual([...documentedScale.keys()].sort());
    });

    for (const [name, row] of documentedScale) {
        it(`${name} = ${row.rem}`, () => {
            expect(darkPalette.get(name)).toBe(normalize(row.rem));
            expect(row.m).toBe(remToPx(row.rem, 16));
            expect(row.l).toBe(remToPx(row.rem, 18));
        });
    }

    it('only decorative glyphs and the stop label are below the 11px floor', () => {
        const below = [...documentedScale]
            .filter(
                ([name, row]) =>
                    !GLYPHS.has(name) && !FLOOR_EXCEPTIONS.has(name) && Number.parseFloat(row.rem) < FLOOR_REM,
            )
            .map(([name]) => name);
        expect(below).toEqual([]);
    });

    it('there is exactly one floor exception, the stop label', () => {
        expect([...FLOOR_EXCEPTIONS]).toEqual(['--font-size-stop-mark']);
        expect(documentedScale.get('--font-size-stop-mark')?.rem).toBe('0.625rem');
    });

    it('the scale base and L text size are set on html', () => {
        expect(TOKENS_CSS).toMatch(/html\s*\{\s*font-size:\s*100%;\s*\}/);
        expect(TOKENS_CSS).toMatch(/html\[data-textsize='l']\s*\{\s*font-size:\s*112\.5%;\s*\}/);
    });
});

describe('theme palettes', () => {
    
        
        const values = parseRootTokens(css);
        expect(css).toContain('color-scheme: light;');
        expect([...values.keys()].sort()).toEqual([...darkPalette.keys()].sort());
        expect(values.get('--surface-app')).toBe('#ffffff');
        expect(values.get('--surface-card-header')).toBe('#f2f2f2');
        expect(values.get('--surface-diff-gap')).toBe('#f1f8ff');
        expect(values.get('--diff-add-gutter-bg')).toBe('#cbf5cb');
        expect(values.get('--diff-del-gutter-bg')).toBe('#fdd7d7');
        
            expect(values.get(name), name).toBe(normalize(expected));
        }
    });

    it('the light palette switches color-scheme', () => {
        expect(lightCss).toContain('color-scheme: light;');
    });

    it('each theme subtree starts with the original tokens, including fonts and geometry', () => {
        expect(TOKENS_CSS).toMatch(/:root,\s*\[data-theme\]\s*\{/);
    });

    
        
    });

    for (const theme of THEMES) {
        it(`${theme}: the full token set resets at the theme boundary`, () => {
            expect([...palettes[theme].keys()].sort()).toEqual([...darkPalette.keys()].sort());
        });

        it(`${theme}: all colour values match theme.md`, () => {
            const colors = new Map([...palettes[theme]].filter(([name]) => documented[theme].has(name)));
            expect(Object.fromEntries(colors)).toEqual(Object.fromEntries(documented[theme]));
        });
    }

    
        
            it(`${theme}: ${name} = ${expected}`, () => {
                expect(palettes[theme].get(name)).toBe(normalize(expected));
            });
        }
    }

    
        
    });

    
        
            
                expect(palettes[theme].get(name)).toBe(normalize(row.rem));
                expect(row.m).toBe(remToPx(row.rem, 16));
                expect(row.l).toBe(remToPx(row.rem, 18));
            });
        }
    }
});

/**
 * "Text → background" pairs for contrast checks. `on` lists background layers from top to bottom.
 * For a translucent diff row fill, contrast is calculated after compositing.
 *
 * `low` lists themes where the design pair falls below 4.5:1. Values are not
 * adjusted to pass. They come from `docs/design/SPEC-theming-2026-09-12.md` §2. Increasing them
 * is a design decision. Measurements (:1): dark, line numbers on a card 4.03 and on a collapsed row 3.93,
 * deletion gutter 4.12. Light, line numbers 2.91 (2.62 on a collapsed row), diff row signs and gutters 3.63 / 4.14 /
 * 4.06 / 4.46, card header counters 3.69 / 4.22, checkmark on green hover 3.88, queued plan item
 * 4.17, amber text on an amber background 4.45, decorator 4.18, amber button
 * ink 4.31, comment edit chip 4.26, delete confirmation text 4.50, "new" badge
 * 4.46, queued plan item on an alternate background 4.17, "saved" mark 3.69 on a
 * thread card (4.37 in dark) and 3.82 in the modal composer, tree stop label 3.56.
 
 
 */
interface TextPair {
    readonly text: string;
    readonly on: readonly string[];
    readonly low?: readonly Theme[];
    readonly inherited?: string;
}

const TEXT_PAIRS: readonly TextPair[] = [
    // Main text shades on every surface where they appear.
    ...[
        '--surface-app',
        '--surface-panel',
        '--surface-panel-deep',
        '--surface-diff-card',
        '--surface-card-header',
        '--surface-input',
        '--surface-chip',
        '--surface-control',
        '--surface-raised',
        '--surface-popover',
        '--surface-command',
        '--surface-offline-banner',
        '--surface-tour-card',
    ].flatMap(
        (surface) =>
            [
                '--text-primary',
                '--text-primary-soft',
                '--text-secondary',
                '--text-secondary-dim',
                '--text-body',
                '--text-muted',
                '--text-muted-dim',
                '--text-dim',
                '--text-dim-strong',
            ].map((text) => ({ text, on: [surface] })),
    ),
    // Diff rendering: line numbers, signs and code on their respective rows. The empty half of split gets
    // no line numbers. `--surface-diff-empty` only holds code in composer blocks.
    { text: '--text-gutter', on: ['--surface-diff-card'], low: ['dark', 'light'] },
    { text: '--text-gutter', on: ['--surface-diff-gap'], low: ['dark', 'light'] },
    { text: '--code-text', on: ['--surface-diff-card'] },
    { text: '--code-text', on: ['--surface-diff-empty'] },
    { text: '--code-text', on: ['--surface-code-inset'] },
    { text: '--code-text', on: ['--surface-command'] },
    { text: '--code-text', on: ['--diff-add-bg', '--surface-diff-card'] },
    { text: '--code-text-del', on: ['--diff-del-bg', '--surface-diff-card'] },
    { text: '--diff-add-text', on: ['--diff-add-bg', '--surface-diff-card'], low: ['light'] },
    
    { text: '--diff-del-text', on: ['--diff-del-bg', '--surface-diff-card'], low: ['light'] },
    { text: '--diff-add-gutter', on: ['--diff-add-gutter-bg', '--diff-add-bg', '--surface-diff-card'], low: ['light'] },
    { text: '--diff-del-gutter', on: ['--diff-del-gutter-bg', '--diff-del-bg', '--surface-diff-card'], low: ['dark', 'light'] },
    { text: '--diff-add-text', on: ['--surface-card-header'], low: ['light'] },
    
    { text: '--diff-del-text', on: ['--surface-card-header'], low: ['light'] },
    { text: '--syntax-keyword', on: ['--surface-diff-card'] },
    { text: '--syntax-string', on: ['--surface-diff-card'] },
    { text: '--syntax-comment', on: ['--surface-diff-card'] },
    { text: '--syntax-decorator', on: ['--surface-diff-card'], low: ['light'] },
    ...['--syntax-property', '--syntax-number', '--syntax-type'].map(
        (text) => ({ text, on: ['--surface-diff-card'] }),
    ),
    ...['--syntax-variable', '--syntax-function'].flatMap((text) => [
        { text, on: ['--surface-diff-card'], inherited: '--code-text' },
        { text, on: ['--diff-del-bg', '--surface-diff-card'], inherited: '--code-text-del' },
    ]),
    // Accent and amber groups on their own surfaces.
    { text: '--accent-text', on: ['--accent-surface'] },
    { text: '--accent-text-soft', on: ['--accent-surface'] },
    { text: '--accent-text-bright', on: ['--accent-surface'] },
    { text: '--accent-text-queued', on: ['--accent-surface'], low: ['light'] },
    { text: '--accent-ink', on: ['--accent'] },
    { text: '--attention-text', on: ['--attention-surface'], low: ['light'] },
    { text: '--attention-text-dim', on: ['--attention-surface'] },
    { text: '--attention-text-soft', on: ['--attention-surface'] },
    { text: '--attention-body', on: ['--attention-surface'] },
    { text: '--attention-label', on: ['--attention-surface'] },
    { text: '--accent-text', on: ['--accent-surface-alt'] },
    { text: '--accent-text-soft', on: ['--accent-surface-alt'] },
    { text: '--accent-text-bright', on: ['--accent-surface-alt'] },
    { text: '--accent-text-queued', on: ['--accent-surface-alt'], low: ['light'] },
    { text: '--attention-text', on: ['--attention-surface-alt'] },
    { text: '--attention-text-dim', on: ['--attention-surface-alt'] },
    { text: '--attention-text-soft', on: ['--attention-surface-alt'] },
    { text: '--attention-body', on: ['--attention-surface-alt'] },
    { text: '--attention-label', on: ['--attention-surface-alt'] },
    // The same existing green badge pair: its recorded light contrast is 4.46.
    { text: '--success-text', on: ['--ownership-mine-surface', '--surface-panel-deep'], low: ['light'] },
    { text: '--success-text', on: ['--ownership-mine-surface', '--surface-app'], low: ['light'] },
    { text: '--error-text', on: ['--error-surface'] },
    { text: '--error-text', on: ['--surface-digest-footer'] },
    { text: '--text-dim-strong', on: ['--surface-digest-footer'] },
    // "Uncovered": the chip sits on the red footer, and the footer on the digest card.
    // The original light theme's previous pair gives 3.89:1.
    { text: '--error-text', on: ['--error-border', '--surface-digest-footer', '--surface-panel-deep'], low: ['light'] },
    { text: '--text-secondary', on: ['--surface-digest-footer', '--surface-panel-deep'] },
    // Stop label in a tree row (§6a): a secondary marker, using the pair from the spec.
    { text: '--stop-mark-text', on: ['--surface-panel'], low: ['light'] },
    { text: '--chat-body-text', on: ['--surface-panel'] },
    { text: '--pr-comments-body-text', on: ['--surface-raised'] },
    { text: '--text-on-selected', on: ['--surface-selected'] },
    // PR comments: status chips, delete confirmation and publication footnote.
    { text: '--pr-comments-published-chip-text', on: ['--pr-comments-published-chip-surface'] },
    { text: '--comment-edit-chip-text', on: ['--comment-edit-chip-surface'], low: ['light'] },
    { text: '--diff-del-text-strong', on: ['--pr-comments-delete-surface'], low: ['light'] },
    // Solid button shades in §5: text must be readable on all three shades of its colour.
    { text: '--text-danger-button', on: ['--surface-danger-button'] },
    { text: '--text-danger-button', on: ['--surface-danger-button-hover'] },
    { text: '--text-danger-button', on: ['--surface-danger-button-pressed'] },
    { text: '--text-button', on: ['--surface-button'] },
    { text: '--text-button', on: ['--surface-button-hover'] },
    { text: '--text-button', on: ['--surface-button-pressed'] },
    { text: '--accent-ink', on: ['--accent-hover'] },
    { text: '--accent-ink', on: ['--accent-pressed'] },
    { text: '--attention-button-ink', on: ['--attention-button-hover'], low: ['light'] },
    { text: '--attention-button-ink', on: ['--attention-button-pressed'] },
    { text: '--text-chip-active', on: ['--surface-chip-active-hover'] },
    { text: '--text-chip-active', on: ['--surface-chip-active-pressed'] },
    { text: '--pr-comments-note-icon', on: ['--surface-app'] },
    // Draft: field with unsaved text and the "saved" mark, which appears both on the thread
    // card and in the modal composer.
    { text: '--attention-text-soft', on: ['--draft-field-surface'] },
    { text: '--draft-saved', on: ['--surface-card-header'], low: ['dark', 'light'] },
    { text: '--draft-saved', on: ['--surface-app'], low: ['light'] },
    // "New" badge on a stop uses the green "mine" ownership group.
    { text: '--diff-add-text-strong', on: ['--ownership-mine-surface'], low: ['light'] },
    // "Viewed" mark: a checkmark on its own background and on green hover (§4).
    { text: '--diff-add-text-strong', on: ['--viewed-surface'] },
    { text: '--diff-add-text-strong', on: ['--viewed-hover-surface'], low: ['light'] },
    // Selected states in §1: segment, enabled chip, amber primary.
    { text: '--text-on-segment-active', on: ['--surface-segment-active'] },
    { text: '--text-chip-active', on: ['--surface-chip-active'] },
    { text: '--attention-button-ink', on: ['--attention-button'], low: ['light'] },
];

describe('text contrast on backgrounds', () => {
    for (const palette of THEMES) {
        const tokens = palettes[palette];
        for (const pair of TEXT_PAIRS) {
            const known = pair.low?.includes(palette) === true;
            it(`${palette}: ${pair.text} on ${pair.on.join(' → ')}${known ? ' — below standard' : ''}`, () => {
                const background = pair.on.reduceRight<number[]>(
                    (below, layer) => blend(parseColor(tokenValue(tokens, layer)), below),
                    parseColor(tokenValue(tokens, '--surface-app')).rgb,
                );
                const textColor = tokenValue(tokens, pair.text);
                const inherited = textColor === 'currentcolor' && pair.inherited !== undefined
                    ? tokenValue(tokens, pair.inherited)
                    : textColor;
                const ratio = contrast(parseColor(inherited).rgb, background);
                if (known) {
                    // Lower bound: the worst recorded pair (line numbers on a collapsed row in light, 2.62).
                    expect(ratio).toBeGreaterThanOrEqual(2.6);
                    // The pair meets the standard. Remove it from `low`.
                    expect(ratio).toBeLessThan(4.5);
                } else {
                    expect(ratio).toBeGreaterThanOrEqual(4.5);
                }
            });
        }
    }
});

function tokenValue(tokens: Map<string, string>, name: string): string {
    const seen = new Set<string>();
    let current = name;
    while (!seen.has(current)) {
        seen.add(current);
        const found = tokens.get(current);
        if (found === undefined) {
            throw new Error(`palette has no token ${current}`);
        }
        const reference = /^var\((--[a-z0-9-]+)\)$/.exec(found)?.[1];
        if (reference === undefined) {
            return found;
        }
        current = reference;
    }
    throw new Error(`circular colour token reference ${name}`);
}

/** `#rrggbb` or `rgba(r,g,b,a)` → channel values and alpha. */
function parseColor(raw: string): { rgb: number[]; alpha: number } {
    const rgba = /rgba?\(([^)]+)\)/.exec(raw);
    if (rgba !== null) {
        const parts = (rgba[1] ?? '').split(',').map(Number);
        return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 };
    }
    return { rgb: [1, 3, 5].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16)), alpha: 1 };
}

/** Composite a layer over what is beneath it. The bottom layer must be opaque. */
function blend(layer: { rgb: number[]; alpha: number }, below: number[] | null): number[] {
    if (below === null) {
        return layer.rgb;
    }
    return layer.rgb.map((channel, index) => channel * layer.alpha + (below[index] ?? 0) * (1 - layer.alpha));
}

/** Contrast between opaque colours using relative sRGB luminance. */
function contrast(first: number[], second: number[]): number {
    const luminance = (rgb: number[]): number => {
        const channels = rgb.map((raw) => {
            const value = raw / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
    };
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
