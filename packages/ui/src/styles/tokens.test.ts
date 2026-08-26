import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Mechanical token check against the handoff, visual acceptance layer 1 (CLAUDE.md).
 *
 * `EXPECTED` is copied verbatim from `design/design_handoff_sherpa/README.md`, the
 * "Design tokens" section (plus separately marked values from README §0 and SPEC §1.1). Changing a token
 * without updating the handoff fails this test. An extra or missing token also fails it,
 * so the table and file must match exactly.
 */

/** Token → value from the README. The comment above each group is the handoff section title. */
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
    // README §11: banner `#151619`, command box `#0e0f11`; README §6: mine chip bg `#132019`.
    '--surface-offline-banner': '#151619',
    '--surface-command': '#0e0f11',
    '--ownership-mine-surface': '#132019',
    // README §2 (Behavioural test digest): «`uncovered` `#d99a95`/`#3d2a2c` in a footer row
    // on `#151316`". The footer surface is not listed in the token table.
    '--surface-digest-footer': '#151316',
    // README §14: overlay `rgba(7,8,9,.66)` below the command palette.
    '--overlay-dialog': 'rgba(7,8,9,.66)',
    // README §1 (Sticky toolbar): «background `rgba(13,14,16,.92)`, `backdrop-filter:blur(8px)`».
    '--surface-toolbar': 'rgba(13,14,16,.92)',

    // Borders — hairline `#1a1d21`, `#1e2126`, `#191c20`; standard `#22252b`, `#24272d`,
    // `#262a30`; strong `#2b2f36`, `#2f333a`; raised `#303540`, `#313640`, `#333842`.
    '--border-hairline': '#1a1d21',
    '--border-hairline-strong': '#1e2126',
    '--border-hairline-soft': '#191c20',
    '--border-standard': '#22252b',
    '--border-control': '#24272d',
    '--border-chip': '#262a30',
    '--border-strong': '#2b2f36',
    '--border-strong-lifted': '#2f333a',
    '--border-raised-bar': '#303540',
    '--border-raised-dialog': '#313640',
    '--border-raised-popover': '#333842',

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
    // README §7 (Overview, phase B): the plan list's 'queued `#5c6288` + "queued"' is the text colour
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
    // README §10 (full diff tree): "an optional `pci` tag (9px mono `#c9a464`,
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
    // README §1 (Mark viewed on a stop): "viewed: bg `#16211a`, border `#25422f`,
    // color `#86d9a8`". Text color already exists as `--diff-add-text-strong`.
    '--viewed-surface': '#16211a',
    '--viewed-border': '#25422f',
    // README §13: circle with a checkmark on the Review complete screen.
    '--success-surface': '#1f3d2c',
    // SPEC §2.10 (Mark viewed): "box fills to 25% accent-green", the same `#2b7a55` = rgb(43,122,85).
    '--read-fill-hover': 'rgba(43,122,85,.25)',
    '--read-border': '#3f7a5a',
    '--error': '#e0736c',
    '--error-text': '#d99a95',
    '--error-surface': '#171315',
    '--error-border': '#3d2a2c',

    // README §1 (diff rows): code `#cfd3da` (del `#d5c0be`), empty side of split `#0c0d0f`,
    // collapsed-context row `#111214`, Mark viewed unchecked box border `#3a3f47`.
    // SPEC §2.12: unread box border `#33383f`. SPEC §2.14: word-level highlight
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

    // README §1 — «Syntax highlighting is intentionally minimal: keywords `#9aa6ff`,
    // strings/numbers `#d3b183`, comments `#5f646d` italic, decorators `#d99a5c`».
    '--syntax-keyword': '#9aa6ff',
    '--syntax-string': '#d3b183',
    '--syntax-comment': '#5f646d',
    '--syntax-decorator': '#d99a5c',

    // Neutral tier fills — medium `#4a5160`, low `#2b2f36`, unfilled `#2a2e4a`.
    '--tier-medium': '#4a5160',
    '--tier-low': '#2b2f36',
    '--tier-unfilled': '#2a2e4a',

    // "Not explained" hatch — `repeating-linear-gradient(115deg,#33373e 0 3px,#1b1e22 3px 6px)`
    // (sidebar variant `#2a2e34 / #1b1e22`, footer strip `#191c20 / #141518`).
    '--hatch': 'repeating-linear-gradient(115deg,#33373e 0 3px,#1b1e22 3px 6px)',
    '--hatch-sidebar': 'repeating-linear-gradient(115deg,#2a2e34 0 3px,#1b1e22 3px 6px)',
    '--hatch-footer': 'repeating-linear-gradient(115deg,#191c20 0 3px,#141518 3px 6px)',

    // SPEC §1.1: hover `#22252b` → `#282c33`, focus-visible ring `rgba(127,140,255,.55)`,
    // selected `#22252b` + `#e0e2e7`, disabled opacity .45. README §0: breadcrumb separator.
    '--hover-selected': '#282c33',
    // README §0: active tab segment `background:#2b2f36` and avatar circle `#2b2f36`.
    '--surface-segment-active': '#2b2f36',
    '--focus-ring-color': 'rgba(127,140,255,.55)',
    '--text-on-selected': '#e0e2e7',
    '--disabled-opacity': '.45',
    '--text-separator': '#4a4f57',

    // Type — IBM Plex Sans 400/450/500/600 for UI, IBM Plex Mono 400/500 for code, paths, numbers,
    // commits, keys and all machine data. Scale: 22px/600 PR title · 19px/600 screen title ·
    // 17px/600 high-tier stop title · 15.5px/600 stop title · 15px/600 section title · 13.5px input ·
    // 13px/1.62 body · 12.5px UI text · 12px secondary · 11.5px controls and mono file names ·
    // 11px mono meta · 10.5px mono gutters and paths · 10px badges · 9.5px prototype/scope labels.
    // Code: 12px mono, line-height 20px.
    '--font-sans': "'IBM Plex Sans',system-ui,sans-serif",
    '--font-mono': "'IBM Plex Mono',ui-monospace,monospace",
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
    // README §10: the `pci` tag is 9px mono. The README scale has no such size.
    '--font-size-tag': '9px',
    '--font-size-code': '12px',
    '--line-height-body': '1.62',
    '--line-height-code': '20px',

    // Radius — 2–3px (rules, tier marks) · 4–5px (badges, small chips) · 6px (buttons, rows) ·
    // 7px (inputs, chips, primary buttons) · 8–9px (cards, popovers) · 10–12px (panels, dialogs).
    // Ranges assigned to specific roles using sizes from README §0–§5 and §14.
    '--radius-rule': '2px',
    '--radius-mark': '3px',
    '--radius-key': '4px',
    '--radius-badge': '5px',
    '--radius-button': '6px',
    '--radius-input': '7px',
    '--radius-popover': '8px',
    '--radius-card': '9px',
    // README §5: the floating bar has its own 11px radius.
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

    // Shadows — popover `0 8px 24px rgba(0,0,0,.5)` · menu `0 16px 40px rgba(0,0,0,.6)` ·
    // floating bar `0 16px 44px rgba(0,0,0,.6)` · dialog `0 24px 64px rgba(0,0,0,.65)`.
    '--shadow-popover': '0 8px 24px rgba(0,0,0,.5)',
    '--shadow-menu': '0 16px 40px rgba(0,0,0,.6)',
    '--shadow-floating': '0 16px 44px rgba(0,0,0,.6)',
    '--shadow-dialog': '0 24px 64px rgba(0,0,0,.65)',

    // Motion — spinner `spin .8s linear infinite` · skeleton/streaming `shimmer 1.6s ease-in-out
    // infinite` · caret `caret 1s step-end infinite` · jump scroll ~320ms ease-in-out cubic ·
    // jump flash ~900ms. Also SPEC §1.1: hover 90ms ease-out.
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

    it('each token is declared once', () => {
        const declarations = [...TOKENS_CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]);
        expect(declarations).toHaveLength(new Set(declarations).size);
    });
});
