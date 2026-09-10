import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Check design tokens against the handoff.
 *
 * `EXPECTED` is copied verbatim from `docs/design/README.md`, "Design tokens" section (plus
 * separately marked values from §0 and `docs/design/SPEC-elements.md` §1.1). Changing a token
 * without updating the handoff fails this test. An extra or missing token also fails it,
 * so the table and file must match exactly.
 */

/** Token → value from the handoff. Each group's comment is its section heading. */
const EXPECTED: Record<string, string> = {
    // Surfaces — app `#0d0e10`; panels `#101113`, `#121316`; diff card `#0f1012`; card header
    // `#141518`; inputs/chips `#15171b`, `#131417`, `#161819`; raised (menus, floating bar)
    // `#181a1e`, `#1b1e24`; selected row `#1f2228`.
    '--surface-app': '#0d0e10',
    '--surface-panel': '#101113',
    '--surface-panel-deep': '#121316',
    '--surface-diff-card': '#0f1012',
    '--surface-card-header': '#141518',
    '--surface-input': '#15171b',
    '--surface-chip': '#131417',
    '--surface-control': '#161819',
    '--surface-raised': '#181a1e',
    '--surface-popover': '#1b1e24',
    '--surface-selected': '#1f2228',
    // docs/design/README.md §11: banner `#151619`, command box `#0e0f11`; §6: mine chip bg `#132019`.
    '--surface-offline-banner': '#151619',
    '--surface-command': '#0e0f11',
    '--ownership-mine-surface': '#132019',
    // docs/design/README.md §2 (Behavioural test digest): «`uncovered` `#d99a95`/`#3d2a2c` in a footer row
    // on `#151316`". The footer surface is not listed in the token table.
    '--surface-digest-footer': '#151316',
    // docs/design/README.md §14: `rgba(7,8,9,.66)` overlay beneath the command palette.
    '--overlay-dialog': 'rgba(7,8,9,.66)',
    // docs/design/README.md §1 (Sticky toolbar): «background `rgba(13,14,16,.92)`, `backdrop-filter:blur(8px)`».
    '--surface-toolbar': 'rgba(13,14,16,.92)',
    // docs/design/SPEC-additions-2026-08-26.md §1c/§1d: comment states and draft editing.
    '--pr-comments-overlay': 'rgba(8,9,10,.55)',
    '--pr-comments-draft-surface': '#131210',
    '--comment-edit-surface': '#12141c',
    '--pr-comments-published-chip-surface': '#191b21',
    '--comment-edit-chip-surface': '#1b2030',
    '--pr-comments-delete-surface': '#170f0f',
    '--pr-comments-delete-button-surface': '#3a1f1e',
    '--pr-comments-delete-button-hover': '#4a2725',
    // docs/design/SPEC-additions-2026-08-26.md §1e: code block in an "outside the diff" thread card on Overview.
    '--surface-code-inset': '#0b0c0e',
    '--pr-comments-list-fade': 'linear-gradient(180deg,rgba(15,16,18,0) 0%,#0f1012 92%)',

    // Borders — hairline `#1a1d21`, `#1e2126`, `#191c20`; standard `#22252b`, `#24272d`,
    // `#262a30`; strong `#2b2f36`, `#2f333a`; raised `#303540`, `#313640`, `#333842`.
    '--border-hairline': '#1a1d21',
    '--border-hairline-strong': '#1e2126',
    '--border-hairline-soft': '#191c20',
    '--border-standard': '#22252b',
    '--border-control': '#24272d',
    '--border-chip': '#262a30',
    // docs/design/README.md §1: "Divider 1×18px #26292f" in the full diff toolbar.
    '--border-divider': '#26292f',
    '--border-strong': '#2b2f36',
    '--border-strong-lifted': '#2f333a',
    '--ownership-mine-border': '#24422f',
    '--border-raised-bar': '#303540',
    '--border-raised-dialog': '#313640',
    '--border-raised-popover': '#333842',
    '--pr-comments-draft-border': '#33301f',
    '--comment-edit-border': '#3c4560',
    '--pr-comments-delete-border': '#4a2f2d',
    '--pr-comments-delete-button-border': '#5c3230',
    '--pr-comments-editor-border': '#343941',

    // Text — primary `#f0f1f4` / `#e9eaee`; secondary `#c7cad1`, `#b9bec7`; body `#a9aeb7`;
    // muted `#9ba1ab`, `#8a8f98`; dim `#6b7078`, `#5e636b`; gutter `#43474e`.
    '--text-primary': '#f0f1f4',
    '--text-primary-soft': '#e9eaee',
    '--text-secondary': '#c7cad1',
    '--text-secondary-dim': '#b9bec7',
    '--text-body': '#a9aeb7',
    '--text-muted': '#9ba1ab',
    '--text-muted-dim': '#8a8f98',
    '--text-dim': '#6b7078',
    '--text-dim-strong': '#5e636b',
    '--text-gutter': '#43474e',
    '--pr-comments-published-chip-text': '#8a90a0',
    '--comment-edit-chip-text': '#9ea8ff',
    '--pr-comments-body-text': '#c3c8d1',
    // docs/design/README.md §4: chat answer body `#c2c7d0`.
    '--chat-body-text': '#c2c7d0',
    '--pr-comments-delete-button-text': '#f2c4c0',
    '--pr-comments-note-icon': '#8a7550',

    // Accent (interactive) — `#7f8cff`; link/hover `#8f9bff` → `#b3bcff`; on-accent ink `#101223`;
    // accent text on dark `#aeb6ff`, `#c9cdf0`, `#dfe2ff`; accent surfaces `#131424`, `#141520`,
    // border `#262a45`; selection `rgba(127,140,255,.13)`, text selection `rgba(127,140,255,.28)`.
    '--accent': '#7f8cff',
    '--accent-hover': '#8f9bff',
    '--accent-hover-strong': '#b3bcff',
    '--accent-ink': '#101223',
    '--accent-text': '#aeb6ff',
    '--accent-text-soft': '#c9cdf0',
    '--accent-text-bright': '#dfe2ff',
    '--accent-surface': '#131424',
    '--accent-surface-alt': '#141520',
    '--accent-border': '#262a45',
    // docs/design/README.md §7 (Overview, phase B): "queued `#5c6288` + "queued"" in the plan list is the text colour
    // of a queued item, absent from the token table. The unlit strip segment (`#2a2e4a`)
    // is different: it is a background, while this is text on `#131424`.
    '--accent-text-queued': '#5c6288',
    '--accent-selection': 'rgba(127,140,255,.13)',
    '--accent-text-selection': 'rgba(127,140,255,.28)',

    // Attention (high tier, stale, drafts, audit) — `#e2954c`; text `#e2b878`, `#c9a464`,
    // `#e6d7bd`; surface `#241f14`, `#191712`; border `#4a4230`, `#3d3524`, `#6b5b39`.
    '--attention': '#e2954c',
    '--attention-text': '#e2b878',
    '--attention-text-dim': '#c9a464',
    '--attention-text-soft': '#e6d7bd',
    '--attention-surface': '#241f14',
    '--attention-surface-alt': '#191712',
    '--attention-border': '#4a4230',
    '--attention-border-alt': '#3d3524',
    '--attention-border-strong': '#6b5b39',
    // docs/design/README.md §9: the second-pass banner action is "(`#e2954c`, ink `#1b1508`)". The fill is
    // `--attention` itself, the ink is not in the token table.
    '--attention-ink': '#1b1508',
    // docs/design/README.md §1 item 4 ("why this stop changed"): "label 11px mono `#8a7550`, body 12.5px `#d8c9ad`",
    // Neither value is in the token table.
    '--attention-label': '#8a7550',
    '--attention-body': '#d8c9ad',
    // docs/design/SPEC-additions-2026-08-26.md §1d: closed draft field `#141210`, saved status `#5e8a6d`.
    '--draft-field-surface': '#141210',
    '--draft-saved': '#5e8a6d',
    // docs/design/README.md §10 (full diff tree): "an optional `pci` tag (9px mono `#c9a464`,
    // border `#3d3a2c`)". The token table does not list the tag border.
    '--tag-pci-border': '#3d3a2c',

    // Diff / status — add bg `rgba(66,160,110,.11)`, text `#6cc38f`/`#86d9a8`, gutter `#4f7f66`;
    // del bg `rgba(224,108,102,.10)`, text `#dd8a84`/`#e8a29c`, gutter `#7f5a56`; read/viewed fill
    // `#2b7a55` with border `#3f7a5a`; error `#e0736c`, `#d99a95`, surface `#171315`,
    // border `#3d2a2c`.
    '--diff-add-bg': 'rgba(66,160,110,.11)',
    '--diff-add-text': '#6cc38f',
    '--diff-add-text-strong': '#86d9a8',
    '--diff-add-gutter': '#4f7f66',
    '--diff-del-bg': 'rgba(224,108,102,.10)',
    '--diff-del-text': '#dd8a84',
    '--diff-del-text-strong': '#e8a29c',
    '--diff-del-gutter': '#7f5a56',
    '--read-fill': '#2b7a55',
    // docs/design/README.md §1 (Mark viewed on a stop): "viewed: bg `#16211a`, border `#25422f`,
    // color `#86d9a8`". Text color already exists as `--diff-add-text-strong`.
    '--viewed-surface': '#16211a',
    '--viewed-border': '#25422f',
    // docs/design/README.md §13: circle with a checkmark on the Review complete screen.
    '--success-surface': '#1f3d2c',
    // docs/design/SPEC-elements.md §2.10 (Mark viewed): "box fills to 25% accent-green", the same `#2b7a55` = rgb(43,122,85).
    '--read-fill-hover': 'rgba(43,122,85,.25)',
    '--read-border': '#3f7a5a',
    '--error': '#e0736c',
    '--error-text': '#d99a95',
    '--error-surface': '#171315',
    '--error-border': '#3d2a2c',

    // docs/design/README.md §1 (diff rows): code `#cfd3da` (del `#d5c0be`), empty side of split `#0c0d0f`,
    // collapsed-context row `#111214`, Mark viewed unchecked box border `#3a3f47`.
    // docs/design/SPEC-elements.md §2.12: unread box border `#33383f`; §2.14: word-level highlight
    // `rgba(66,160,110,.22)` / `rgba(224,108,102,.22)`, trailing whitespace `rgba(224,108,102,.25)`,
    // "hover a row: bg lifts by 4%" is the only highlight step with no hex value in the handoff.
    '--code-text': '#cfd3da',
    '--code-text-del': '#d5c0be',
    '--surface-diff-empty': '#0c0d0f',
    '--surface-diff-gap': '#111214',
    '--diff-add-word': 'rgba(66,160,110,.22)',
    '--diff-del-word': 'rgba(224,108,102,.22)',
    '--diff-trailing-space': 'rgba(224,108,102,.25)',
    '--row-hover': 'rgba(255,255,255,.04)',
    '--checkbox-border': '#3a3f47',
    '--read-box-border': '#33383f',

    // docs/design/README.md §1 — «Syntax highlighting is intentionally minimal: keywords `#9aa6ff`,
    // strings/numbers `#d3b183`, comments `#5f646d` italic, decorators `#d99a5c`».
    '--syntax-keyword': '#9aa6ff',
    '--syntax-string': '#d3b183',
    '--syntax-comment': '#5f646d',
    '--syntax-decorator': '#d99a5c',

    // docs/design/README.md §16 (Onboarding tour): tour card bg `#171a1f`. "Skip tour" uses
    // `border-bottom:1px dashed #3a3f47` (same shade as an empty checkbox, but a separate role).
    '--surface-tour-card': '#171a1f',
    '--tour-skip-underline': '#3a3f47',

    // Neutral tier fills — medium `#4a5160`, low `#2b2f36`, unfilled `#2a2e4a`.
    '--tier-medium': '#4a5160',
    '--tier-low': '#2b2f36',
    '--tier-unfilled': '#2a2e4a',

    // "Not explained" hatch — `repeating-linear-gradient(115deg,#33373e 0 3px,#1b1e22 3px 6px)`
    // (sidebar variant `#2a2e34 / #1b1e22`, footer strip `#191c20 / #141518`).
    '--hatch': 'repeating-linear-gradient(115deg,#33373e 0 3px,#1b1e22 3px 6px)',
    '--hatch-sidebar': 'repeating-linear-gradient(115deg,#2a2e34 0 3px,#1b1e22 3px 6px)',
    '--hatch-footer': 'repeating-linear-gradient(115deg,#191c20 0 3px,#141518 3px 6px)',

    // docs/design/SPEC-elements.md §1.1: hover `#22252b` → `#282c33`, focus-visible ring `rgba(127,140,255,.55)`,
    // selected `#22252b` + `#e0e2e7`, disabled opacity .45. docs/design/README.md §0: breadcrumb divider.
    '--hover-selected': '#282c33',
    // docs/design/README.md §0: active segment-control tab `background:#2b2f36`.
    '--surface-segment-active': '#2b2f36',
    '--focus-ring-color': 'rgba(127,140,255,.55)',
    '--text-on-selected': '#e0e2e7',
    '--disabled-opacity': '.45',
    '--text-separator': '#4a4f57',

    // Type — IBM Plex Sans 400/450/500/600 for UI, IBM Plex Mono 400/500 for code, paths, numbers,
    // commits, keys and all machine data. Scale: 24px/600 PR title on Overview · 22px/600 PR title ·
    // 19px/600 screen title · 17px/600 high-tier stop title · 15.5px/600 stop title ·
    // 15px/600 section title · 13.5px input · 13px/1.62 body · 12.5px UI text · 12px secondary ·
    // 11.5px controls and mono file names · 11px mono meta · 10.5px mono gutters and paths ·
    // 10px badges · 9.5px prototype/scope labels. Code: 12px mono, line-height 20px.
    '--font-sans': "'IBM Plex Sans',system-ui,sans-serif",
    '--font-mono': "'IBM Plex Mono',ui-monospace,monospace",
    // This size is outside the handoff scales. It comes from the prototype's Overview screen.
    '--font-size-pr-title-overview': '24px',
    '--font-size-pr-title': '22px',
    '--font-size-screen-title': '19px',
    '--font-size-stop-title-high': '17px',
    '--font-size-stop-title': '15.5px',
    '--font-size-section-title': '15px',
    '--font-size-input': '13.5px',
    '--font-size-body': '13px',
    '--font-size-ui': '12.5px',
    '--font-size-secondary': '12px',
    '--font-size-control': '11.5px',
    '--font-size-meta': '11px',
    '--font-size-gutter': '10.5px',
    '--font-size-badge': '10px',
    '--font-size-scope': '9.5px',
    // docs/design/README.md §10: `pci` tag, 9px mono, outside the main scale.
    '--font-size-tag': '9px',
    // Prototype: initials in the 18×18 reply avatar.
    '--font-size-avatar-glyph': '9px',
    '--font-size-code': '12px',
    '--line-height-body': '1.62',
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

    // Spacing — 30px page gutter · 40px column gap · 22px card gap · 14px control gap ·
    // 8–10px inner gap.
    '--space-page': '30px',
    '--space-column': '40px',
    '--space-card': '22px',
    '--space-control': '14px',
    '--space-inner': '10px',
    '--space-inner-tight': '8px',
    // Prototype: Sherpa.dc.html:217 reserves 180px below Route. Shared by all reader views.
    '--space-bar-reserve': '180px',

    // Shadows — docs/design/SPEC-additions-2026-08-26.md §1d line comment `0 1px 4px rgba(0,0,0,.45)`; popover
    // `0 8px 24px rgba(0,0,0,.5)` · menu `0 16px 40px rgba(0,0,0,.6)` · floating bar
    // `0 16px 44px rgba(0,0,0,.6)` · dialog `0 24px 64px rgba(0,0,0,.65)`.
    '--shadow-line-comment': '0 1px 4px rgba(0,0,0,.45)',
    '--shadow-popover': '0 8px 24px rgba(0,0,0,.5)',
    '--shadow-menu': '0 16px 40px rgba(0,0,0,.6)',
    '--shadow-floating': '0 16px 44px rgba(0,0,0,.6)',
    '--shadow-dialog': '0 24px 64px rgba(0,0,0,.65)',
    '--shadow-pr-comments': '0 18px 50px rgba(0,0,0,.55)',
    // docs/design/README.md §16: tour card `0 20px 52px rgba(0,0,0,.62)`, ring
    // `box-shadow: 0 0 0 3px rgba(127,140,255,.13), 0 0 26px rgba(127,140,255,.16)`.
    '--shadow-tour-card': '0 20px 52px rgba(0,0,0,.62)',
    '--shadow-tour-ring': '0 0 0 3px rgba(127,140,255,.13), 0 0 26px rgba(127,140,255,.16)',

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

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

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

/** `--name: value;` declarations from the `:root` block. */
function parseRootTokens(css: string): Map<string, string> {
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
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

describe('design tokens', () => {
    const tokens = parseRootTokens(TOKENS_CSS);

    it(':root declares exactly the tokens listed in the handoff', () => {
        expect([...tokens.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    for (const [name, expected] of Object.entries(EXPECTED)) {
        it(`${name} = ${expected}`, () => {
            expect(tokens.get(name)).toBe(normalize(expected));
        });
    }

    it('each token is declared once in each palette', () => {
        for (const block of TOKENS_CSS.matchAll(/\{([^{}]*)\}/g)) {
            const declarations = [...(block[1] ?? '').matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]);
            expect(declarations).toHaveLength(new Set(declarations).size);
        }
    });
});

describe('light palette', () => {
    const lightCss = TOKENS_CSS.split(":root[data-theme='light']")[1] ?? '';
    const light = parseRootTokens(`:root ${lightCss}`);
    const dark = parseRootTokens(TOKENS_CSS);
    const design = readFileSync(
        fileURLToPath(new URL('../../../../docs/design/theme-light.md', import.meta.url)),
        'utf8',
    );

    it('overrides all color roles without changing geometry', () => {
        const colors = [...dark].filter(([, value]) => /#|rgba\(/.test(value)).map(([name]) => name);
        expect([...light.keys()].sort()).toEqual(colors.sort());
        expect(lightCss).toContain('color-scheme: light;');
    });

    it('matches the design table', () => {
        const documented = new Map([...design.matchAll(/\| `(--[a-z0-9-]+)` \| `([^`]+)` \|/g)]
            .map((match) => [match[1], normalize(match[2] ?? '')]));
        expect(light).toEqual(documented);
    });

    it('keeps body text, syntax and change labels readable on a light card', () => {
        const background = light.get('--surface-diff-card') ?? '';
        const textTokens = [
            '--text-primary', '--text-body', '--text-muted', '--code-text', '--code-text-del',
            '--syntax-keyword', '--syntax-string', '--syntax-comment', '--syntax-decorator',
            '--diff-add-text', '--diff-del-text', '--accent-text',
        ];
        for (const name of textTokens) {
            expect(contrast(light.get(name) ?? '', background), name).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(light.get('--accent-ink') ?? '', light.get('--accent') ?? '')).toBeGreaterThanOrEqual(4.5);
    });
});

/** Contrast between opaque colours using relative sRGB luminance. */
function contrast(first: string, second: string): number {
    const luminance = (hex: string): number => {
        const channels = [1, 3, 5].map((offset) => {
            const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
    };
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
