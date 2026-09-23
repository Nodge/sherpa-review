# Dark and light themes

The only source of colour values is `packages/ui/src/styles/tokens.css`. Dark values are declared
in `:root`, and light values override them in `:root[data-theme='light']`. Geometry, radii,
spacing and motion are shared between themes and documented in `README.md`, under "Design tokens". The font
scale is below, under "Typography". Both tables in this document are checked against CSS by
`packages/ui/src/styles/tokens.test.ts`. The lists must match in both keys and values.

The `data-theme` attribute is on `<html>`. Switching it also switches `color-scheme`, which controls
native scrollbars, inputs and dropdowns. The reviewer chooses the theme: `dark`,
`light` or `auto` (follows the system, the default). The toggle and choice persistence
are described in settings. The `html`/`body` background equals `--surface-app` to prevent
a flash of the wrong colour on load. The light palette selector also matches any other element with this
attribute. The state gallery uses this to show a light-theme card without recolouring the stand
around it. The product has no nested themes.

Token names are semantic. Each variable names a role rather than a shade. Values come
from `SPEC-theming-2026-09-12.md`. The "source" column names a row in its §2 table (`--c-<hex>`
for opaque colours, `--a-<digits>` for alpha values) or a pair in §1 that supplied both values. The dark
palette was rebuilt there. Neutrals were stretched +80 % from the page background, which flattened
the grey hierarchy, making muted labels almost white. This was a deliberate design choice in response to complaints
about contrast, not a migration error.

One level was restored in a single place, as §3 of the same spec allows ("restore 2–3 levels
without lowering the overall level"). `--text-link-muted` is the tone for subdued action links ("Edit ·
Delete"). Without it, the action row below a comment had exactly the same colour as the body.
The value comes from the 09-12 pass, not the mockup (`8a8f98`, which is 5.3:1). It gives ≈9:1 on
the card surface against ≈17:1 for the body, preserving the prototype's ratio between levels.

Tokens whose production colour isn't in the §2 table (screens from `SPEC-additions-2026-08-26.md`, control
states) are marked "derived". The dark value uses the §3 formula,
`new = bg + (old − bg) × 1.8`, applied component by component from `#0d0e10` with clamping. Accent shades are
unchanged. The light value comes from the nearest neighbour with the same role. Hatches, shadows and translucent
fills combine migrated components.

## Light-theme rules that cannot be inferred from the table

- An active segment (view tabs, route presets, mode switches) is a raised white
  "pill" with a `--shadow-segment-active` shadow on a grey track. Grey on grey in the light theme
  reads as disabled.
- An enabled chip (People / Bots / Resolved, file filter) has indigo fill, border
  and text (`--surface-chip-active`, `--border-chip-active`, `--text-chip-active`) in both themes.
- The amber primary button in banners uses `--attention-button` with white text. Orange
  with black text on a cream background looked muddy. The fill is darker than the general `--attention`,
  so the button has its own pair.
- A viewed stop and a read file chip aren't dimmed with opacity. The former uses
  muted heading and paragraph tokens, and the latter uses only a green checkmark.

## Control states

The source is `SPEC-changes-2026-09-20.md` §5. Hover changes only the surface, pressing moves
it to the second level, and text and borders stay unchanged. The grey surface scale is `--surface-hover`
→ `--surface-pressed` → `--surface-pressed-deep`. Filled buttons have 3 tones of their own colour
(`--surface-button-*`, `--surface-danger-button-*`, `--accent-hover` / `--accent-pressed`,
`--attention-button-hover` / `--attention-button-pressed`, `--surface-chip-active-*`).
The exceptions are links (their colour follows the accent scale) and the trash button (the icon turns red
along with the background). The variants live in `packages/ui/src/styles/controls.css`. Component
styles handle only layout. The "Controls" gallery card shows the state matrix in both themes.

## Typography

Text sizes use rem relative to the `html` base, per `SPEC-theming-2026-09-12.md` §5. The base is `100%`,
so it uses the browser size (usually 16px). The system or browser font size setting
scales the entire interface. Text size L uses `data-textsize='l'` on `<html>`, with a
`112.5%` (18px) base. There are no other sizes, as the spec rejected S (§9).

The scale's minimum is 11px (`0.6875rem`). Everything that was 9–10.5px in production was raised to it, so
4 small tokens now have the same size. Decorative glyphs without their own text fall outside
the scale: the close icon (18px) and avatar initials. The values below the minimum are
initials (anything above 9px won't fit in an 18×18 circle) and one text token,
`--font-size-stop-mark`. This is the only deliberate exception to the text minimum
(`SPEC-theming-2026-09-12.md` §5 and §6a). The stop number lives in a 17×13 mark at the left edge
of a tree row, a secondary marker next to the filename, and 11px won't fit in that mark.
`--line-height-code` deliberately stays in px, so code line density doesn't depend on text size.

The "px at M" and "px at L" columns are derived (`rem × 16` and `rem × 18`, rounded to tenths).
The test recalculates them to keep the table in sync with CSS.

| Token | rem | px at M | px at L | Where |
|---|---|---|---|---|
| `--font-size-pr-title-overview` | `1.5rem` | 24 | 27 | PR title in Overview |
| `--font-size-pr-title` | `1.375rem` | 22 | 24.8 | PR title in Route and Full diff |
| `--font-size-screen-title` | `1.1875rem` | 19 | 21.4 | screen headings |
| `--font-size-close-glyph` | `1.125rem` | 18 | 20.3 | panel close icon (glyph) |
| `--font-size-stop-title-high` | `1.0625rem` | 17 | 19.1 | high-tier stop title |
| `--font-size-stop-title` | `0.9688rem` | 15.5 | 17.4 | stop title |
| `--font-size-section-title` | `0.9688rem` | 15.5 | 17.4 | section headings |
| `--font-size-input` | `0.875rem` | 14 | 15.8 | input fields, tour card title |
| `--font-size-body` | `0.8438rem` | 13.5 | 15.2 | stop paragraphs, brand in the header |
| `--font-size-ui` | `0.8125rem` | 13 | 14.6 | `body` base, main UI text, tour card body |
| `--font-size-secondary` | `0.7813rem` | 12.5 | 14.1 | secondary UI text |
| `--font-size-control` | `0.75rem` | 12 | 13.5 | controls, filenames, monospace button labels |
| `--font-size-code` | `0.75rem` | 12 | 13.5 | code in the diff and snippets |
| `--font-size-meta` | `0.7188rem` | 11.5 | 12.9 | monospace metadata and counters |
| `--font-size-gutter` | `0.6875rem` | 11 | 12.4 | gutters, paths, monospace labels |
| `--font-size-badge` | `0.6875rem` | 11 | 12.4 | badges, counters, ⌘K |
| `--font-size-scope` | `0.6875rem` | 11 | 12.4 | kickers and scope labels |
| `--font-size-tag` | `0.6875rem` | 11 | 12.4 | scope tag in the tree and card header |
| `--font-size-stop-mark` | `0.625rem` | 10 | 11.3 | stop mark in a tree row (exception to the minimum) |
| `--font-size-avatar-glyph` | `0.5625rem` | 9 | 10.1 | avatar initials (glyph) |

## Colour tokens

| Token | Dark | Light | Source |
|---|---|---|---|
| `--surface-app` | `#0d0e10` | `#f6f7f9` | `--c-0d0e10` |
| `--surface-panel` | `#121315` | `#ffffff` | `--c-101113` |
| `--surface-panel-deep` | `#16171b` | `#fdfdfd` | `--c-121316` |
| `--surface-diff-card` | `#111214` | `#ffffff` | `--c-0f1012` |
| `--surface-card-header` | `#1a1b1e` | `#f2f3f6` | `--c-141518` |
| `--surface-input` | `#1b1e24` | `#f3f4f8` | `--c-15171b` |
| `--surface-chip` | `#18191d` | `#fafbfc` | `--c-131417` |
| `--surface-control` | `#1d2020` | `#e8eaef` | `--c-161819` |
| `--surface-raised` | `#212429` | `#ffffff` | `--c-181a1e` |
| `--surface-popover` | `#262b34` | `#e2e5ea` | `--c-1b1e24` |
| `--surface-selected` | `#2d323b` | `#e2e5ea` | `--c-1f2228` |
| `--surface-offline-banner` | `#1b1c20` | `#f3f4f8` | `--c-151619` |
| `--surface-command` | `#0f1012` | `#f0f1f5` | `--c-0e0f11` |
| `--ownership-mine-surface` | `#182e20` | `#e4f6ea` | `--c-132019` |
| `--surface-digest-footer` | `#1b171b` | `#feefec` | `--c-151316` |
| `--overlay-dialog` | `rgba(7, 8, 9, 0.66)` | `rgba(236, 238, 242, 0.7)` | `--a-78966` |
| `--surface-toolbar` | `rgba(13, 14, 16, 0.92)` | `rgba(246, 247, 249, 0.92)` | `--a-13141692` |
| `--pr-comments-overlay` | `rgba(8, 9, 10, 0.55)` | `rgba(236, 238, 242, 0.6)` | derived: scrim, neighbour `--a-78966` |
| `--pr-comments-draft-surface` | `#181510` | `#fffaec` | derived: §3 + neighbour `--c-191712` |
| `--comment-edit-surface` | `#161926` | `#f0f1ff` | derived: §3 + neighbour `--c-141520` |
| `--pr-comments-published-chip-surface` | `#23252f` | `#e8eaef` | derived: §3 + neighbour `--c-161819` |
| `--comment-edit-chip-surface` | `#262e4a` | `#dfe2fa` | derived: §3 + neighbour `--c-262a45` |
| `--pr-comments-delete-surface` | `#1f100e` | `#feecea` | derived: §3 + neighbour `--c-171315` |
| `--surface-hover` | `#262b34` | `#e2e5ea` | §5 level 1, `--c-1b1e24` |
| `--surface-pressed` | `#333741` | `#dadee4` | §5 level 2, `--c-22252b` |
| `--surface-pressed-deep` | `#434954` | `#c8cdd5` | §5 level 3, `--c-2b2f36` |
| `--surface-button` | `#333741` | `#ffffff` | §4b `--btn-bg` |
| `--surface-button-hover` | `#434954` | `#eef0f4` | §4b `--btn-bg-hover` |
| `--surface-button-pressed` | `#4a515c` | `#e2e5ea` | §5 `--btn-bg-active` |
| `--surface-danger-button` | `#3a1f1e` | `#f8d9d7` | §5 `--c-3a1f1e` |
| `--surface-danger-button-hover` | `#4a2725` | `#f2c9c6` | §5 `--c-4a2725` |
| `--surface-danger-button-pressed` | `#5c3230` | `#e0a39f` | §5 `--c-5c3230` |
| `--surface-code-inset` | `#090a0c` | `#f3f4f6` | derived: §3 + neighbour `--c-0c0d0f` |
| `--surface-code-inline` | `#23272d` | `#e8eaee` | `--c-191c20` |
| `--border-hairline` | `#24292f` | `#e4e6eb` | `--c-1a1d21` |
| `--border-hairline-strong` | `#2c3038` | `#e0e2e7` | `--c-1e2126` |
| `--border-hairline-soft` | `#23272d` | `#e8eaee` | `--c-191c20` |
| `--border-standard` | `#333741` | `#dadee4` | `--c-22252b` |
| `--border-control` | `#363b44` | `#d2d5dd` | `--c-24272d` |
| `--border-chip` | `#3a404a` | `#c9ced6` | `--c-262a30` |
| `--border-divider` | `#3a3f48` | `#cdd3da` | `--c-26292f` |
| `--border-strong` | `#434954` | `#c8cdd5` | `--c-2b2f36` |
| `--border-strong-lifted` | `#4a515c` | `#bbc2cb` | `--c-2f333a` |
| `--ownership-mine-border` | `#24422f` | `#cde9d8` | `--c-24422f` |
| `--border-raised-bar` | `#4c5466` | `#b7bec8` | `--c-303540` |
| `--border-raised-dialog` | `#4e5666` | `#bfc6cf` | `--c-313640` |
| `--border-raised-popover` | `#515a6a` | `#b0b7c1` | `--c-333842` |
| `--pr-comments-draft-border` | `#33301f` | `#ecdfc4` | derived: accent unchanged, neighbour `--c-3d3524` |
| `--comment-edit-border` | `#3c4560` | `#c3c7e6` | derived: accent unchanged, neighbour `--c-3a3f60` |
| `--pr-comments-delete-border` | `#4a2f2d` | `#f0d2d0` | derived: accent unchanged, neighbour `--c-3d2a2c` |
| `--border-danger-button` | `#5c3230` | `#e0a39f` | §5 `--c-5c3230` |
| `--border-button` | `#4a515c` | `#8b94a3` | §4b `--btn-bd` |
| `--border-switch-track` | `#343941` | `#c8cdd5` | §5 `--c-343941` |
| `--pr-comments-editor-border` | `#535b68` | `#b1b8c2` | derived: §3 + neighbour `--c-33373e` |
| `--text-primary` | `#ffffff` | `#000000` | `--c-f0f1f4` |
| `--text-primary-soft` | `#ffffff` | `#000000` | `--c-e9eaee` |
| `--text-secondary` | `#ffffff` | `#000000` | `--c-c7cad1` |
| `--text-secondary-dim` | `#ffffff` | `#00000a` | `--c-b9bec7` |
| `--text-body` | `#ffffff` | `#00000a` | `--c-a9aeb7` |
| `--text-muted` | `#ffffff` | `#000813` | `--c-9ba1ab` |
| `--text-muted-dim` | `#ffffff` | `#0c1420` | `--c-8a8f98` |
| `--text-link-muted` | `#b6bcc6` | `#3c424c` | `SPEC-changes-2026-09-20.md §5` (`8a8f98`), level restored per §3 |
| `--text-dim` | `#e7f1ff` | `#19212d` | `--c-6b7078` |
| `--text-dim-strong` | `#dae4f3` | `#28303b` | `--c-5e636b` |
| `--text-gutter` | `#6e7580` | `#9198a2` | `--c-43474e` |
| `--pr-comments-published-chip-text` | `#eef8ff` | `#0c1420` | derived: §3 + neighbour `--c-8a8f98` |
| `--comment-edit-chip-text` | `#9ea8ff` | `#4c5ae0` | derived: accent unchanged, neighbour `--c-9aa6ff` |
| `--pr-comments-body-text` | `#ffffff` | `#000000` | derived: §3 + neighbour `--c-c2c7d0` |
| `--chat-body-text` | `#ffffff` | `#000000` | `--c-c2c7d0` |
| `--text-danger-button` | `#f2c4c0` | `#7a2622` | §5 `--c-f2c4c0` |
| `--text-button` | `#ffffff` | `#0c1420` | §4b `--btn-fg` |
| `--pr-comments-note-icon` | `#9c8760` | `#7f6c3e` | `--c-8a7550` |
| `--accent` | `#7f8cff` | `#5a68e8` | `--c-7f8cff` |
| `--accent-hover` | `#8f9bff` | `#4c5ae0` | `--c-8f9bff` |
| `--accent-hover-strong` | `#b3bcff` | `#3a47bd` | `--c-b3bcff` |
| `--accent-pressed` | `#6b78e6` | `#4353cf` | §5 `--c-6b78e6` |
| `--accent-ink` | `#101223` | `#ffffff` | `--c-101223` |
| `--accent-text` | `#aeb6ff` | `#4350cc` | `--c-aeb6ff` |
| `--accent-text-soft` | `#c9cdf0` | `#3a4390` | `--c-c9cdf0` |
| `--accent-text-bright` | `#dfe2ff` | `#262f8a` | `--c-dfe2ff` |
| `--accent-text-queued` | `#7d83ad` | `#6b719f` | `--c-5c6288` |
| `--accent-surface` | `#131424` | `#f0f1fc` | `--c-131424` |
| `--accent-surface-alt` | `#1a1b2d` | `#f0f1ff` | `--c-141520` |
| `--accent-border` | `#262a45` | `#dfe2fa` | `--c-262a45` |
| `--accent-selection` | `rgba(127, 140, 255, 0.13)` | `rgba(90, 104, 232, 0.12)` | `--a-12714025513` |
| `--accent-text-selection` | `rgba(127, 140, 255, 0.28)` | `rgba(90, 104, 232, 0.22)` | `--a-12714025528` |
| `--attention` | `#e2954c` | `#d8791c` | `--c-e2954c` |
| `--attention-text` | `#e2b878` | `#9d6410` | `--c-e2b878` |
| `--attention-text-dim` | `#c9a464` | `#7f5612` | `--c-c9a464` |
| `--attention-text-soft` | `#e6d7bd` | `#3f3014` | `--c-e6d7bd` |
| `--attention-surface` | `#241f14` | `#fbf3df` | `--c-241f14` |
| `--attention-surface-alt` | `#231e14` | `#fffaec` | `--c-191712` |
| `--attention-border` | `#4a4230` | `#d9c9a4` | `--c-4a4230` |
| `--attention-border-alt` | `#3d3524` | `#ecdfc4` | `--c-3d3524` |
| `--attention-border-strong` | `#6b5b39` | `#bba777` | `--c-6b5b39` |
| `--attention-button` | `#e2954c` | `#b8641c` | §1 `--amber-btn` |
| `--attention-button-ink` | `#1b1508` | `#ffffff` | §1 `--amber-btn-fg` |
| `--attention-button-hover` | `#eaa15c` | `#c56d1f` | §5 `--amber-btn-hover` |
| `--attention-button-pressed` | `#d1873f` | `#a85a14` | §5 `--amber-btn-active` |
| `--attention-label` | `#9c8760` | `#7f6c3e` | `--c-8a7550` |
| `--attention-body` | `#d8c9ad` | `#5a4a24` | `--c-d8c9ad` |
| `--draft-field-surface` | `#1a1510` | `#fffaec` | derived: §3 + neighbour `--c-191712` |
| `--draft-saved` | `#5e8a6d` | `#268f52` | derived: accent unchanged, neighbour `--c-6cc38f` |
| `--tag-pci-border` | `#3d3a2c` | `#e9dfc3` | `--c-3d3a2c` |
| `--surface-tour-card` | `#1f242b` | `#ffffff` | `--c-171a1f` |
| `--tour-skip-underline` | `#5e6673` | `#a1a7b3` | `--c-3a3f47` |
| `--diff-add-bg` | `rgba(66, 160, 110, 0.11)` | `rgba(38, 143, 82, 0.10)` | `--a-6616011011` |
| `--diff-add-text` | `#6cc38f` | `#268f52` | `--c-6cc38f` |
| `--diff-add-text-strong` | `#86d9a8` | `#1e7f47` | `--c-86d9a8` |
| `--diff-add-gutter` | `#5f9478` | `#3a835d` | `--c-4f7f66` |
| `--diff-del-bg` | `rgba(224, 108, 102, 0.10)` | `rgba(207, 70, 64, 0.09)` | `--a-22410810210` |
| `--diff-del-text` | `#dd8a84` | `#c94842` | `--c-dd8a84` |
| `--diff-del-text-strong` | `#e8a29c` | `#c33f39` | `--c-e8a29c` |
| `--diff-del-gutter` | `#a0736e` | `#a45a54` | `--c-7f5a56` |
| `--read-fill` | `#3a8f66` | `#2f8557` | `--c-2b7a55` |
| `--viewed-surface` | `#1d3022` | `#e8f7ec` | `--c-16211a` |
| `--viewed-border` | `#25422f` | `#cde9d8` | `--c-25422f` |
| `--viewed-hover-surface` | `#25422f` | `#cde9d8` | `--c-25422f` |
| `--viewed-hover-border` | `#3a8f66` | `#2f8557` | `--c-2b7a55` |
| `--success-surface` | `#1f3d2c` | `#bfe4cd` | `--c-1f3d2c` |
| `--read-fill-hover` | `rgba(58, 143, 102, 0.25)` | `rgba(47, 133, 87, 0.25)` | derived from `--c-2b7a55` |
| `--read-border` | `#3f7a5a` | `#46a672` | `--c-3f7a5a` |
| `--error` | `#e0736c` | `#cf4640` | `--c-e0736c` |
| `--error-text` | `#d99a95` | `#b5423c` | `--c-d99a95` |
| `--error-surface` | `#1f1719` | `#feecea` | `--c-171315` |
| `--error-border` | `#3d2a2c` | `#f0d2d0` | `--c-3d2a2c` |
| `--code-text` | `#ffffff` | `#000000` | `--c-cfd3da` |
| `--code-text-del` | `#d5c0be` | `#87332e` | `--c-d5c0be` |
| `--surface-diff-empty` | `#0b0c0e` | `#f3f4f6` | `--c-0c0d0f` |
| `--surface-diff-gap` | `#1a1b1e` | `#f2f3f6` | `--c-111214`. Both values deviate from the spec. The §2 values (`#141517` / `#ffffff`) make the row blend into the card, so the values come from neighbour `--c-141518`, the card header (`docs/decisions.md`, 2026-09-12) |
| `--diff-add-word` | `rgba(66, 160, 110, 0.22)` | `rgba(38, 143, 82, 0.22)` | derived from `--a-6616011011` |
| `--diff-del-word` | `rgba(224, 108, 102, 0.22)` | `rgba(207, 70, 64, 0.22)` | derived from `--a-22410810210` |
| `--diff-trailing-space` | `rgba(224, 108, 102, 0.25)` | `rgba(207, 70, 64, 0.25)` | derived from `--a-22410810210` |
| `--row-hover` | `rgba(255, 255, 255, 0.04)` | `rgba(20, 24, 32, 0.04)` | derived: neutral alpha, neighbour `--a-0005` |
| `--checkbox-border` | `#5e6673` | `#a1a7b3` | `--c-3a3f47` |
| `--read-box-border` | `#515a65` | `#afb5c0` | `--c-33383f` |
| `--stop-mark-text` | `#7b8390` | `#828894` | `--c-4a4f57` (§6a) |
| `--stop-mark-border` | `#2c3038` | `#e0e2e7` | `--c-1e2126` (§6a) |
| `--border-button-outline` | `#7b8390` | `#828894` | `--c-4a4f57` |
| `--border-button-outline-hover` | `#dae4f3` | `#28303b` | `--c-5e636b` |
| `--syntax-keyword` | `#9aa6ff` | `#5462e3` | `--c-9aa6ff` |
| `--syntax-string` | `#d3b183` | `#8a5f1c` | `--c-d3b183` |
| `--syntax-comment` | `#8a919c` | `#646b76` | `--c-5f646d`. Both values deviate from the spec. With the §2 values (`#dae4f3` / `#28303b`), comments were barely distinguishable from code (`docs/decisions.md`, 2026-09-12) |
| `--syntax-decorator` | `#d99a5c` | `#b46a1f` | `--c-d99a5c` |
| `--tier-medium` | `#7b87a0` | `#7b8390` | `--c-4a5160` |
| `--tier-low` | `#434954` | `#c8cdd5` | `--c-2b2f36` |
| `--tier-unfilled` | `#2a2e4a` | `#dde0f8` | `--c-2a2e4a` |
| `--hatch` | `repeating-linear-gradient(115deg, #515863 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #b1b8c2 0 3px, #e9ecef 3px 6px)` | `--c-33373e`, `--c-1b1e22` |
| `--hatch-sidebar` | `repeating-linear-gradient(115deg, #414851 0 3px, #262b30 3px 6px)` | `repeating-linear-gradient(115deg, #c5cad2 0 3px, #e9ecef 3px 6px)` | `--c-2a2e34`, `--c-1b1e22` |
| `--hatch-footer` | `repeating-linear-gradient(115deg, #23272d 0 3px, #1a1b1e 3px 6px)` | `repeating-linear-gradient(115deg, #e8eaee 0 3px, #f2f3f6 3px 6px)` | `--c-191c20`, `--c-141518` |
| `--hover-selected` | `#3e444f` | `#dadee4` | derived: §3 + neighbour `--c-22252b` |
| `--surface-segment-active` | `#434954` | `#ffffff` | §1 `--seg-bg` |
| `--text-on-segment-active` | `#ffffff` | `#000000` | §1 `--seg-fg` |
| `--shadow-segment-active` | `none` | `0 1px 2px rgba(20, 24, 32, 0.18), 0 0 0 1px rgba(20, 24, 32, 0.08)` | §1 `--seg-shadow` |
| `--shadow-button` | `none` | `0 1px 2px rgba(20, 24, 32, 0.12)` | §4b `--btn-shadow` |
| `--surface-chip-active` | `#1e2240` | `#e8eaff` | §1 `--chip-bg` |
| `--border-chip-active` | `#3f4880` | `#b9c0f4` | §1 `--chip-bd` |
| `--text-chip-active` | `#c3caff` | `#2b3690` | §1 `--chip-fg` |
| `--surface-chip-active-hover` | `#262c52` | `#dfe2fb` | §5 `--chip-bg-hover` |
| `--surface-chip-active-pressed` | `#2e3566` | `#d3d8f8` | §5 `--chip-bg-active` |
| `--focus-ring-color` | `#7f8cff` | `#5a68e8` | §5 `--focus` |
| `--text-on-selected` | `#ffffff` | `#000000` | `--c-e0e2e7` |
| `--text-separator` | `#7b8390` | `#828894` | `--c-4a4f57` |
| `--shadow-line-comment` | `0 1px 4px rgba(0, 0, 0, 0.45)` | `0 1px 4px rgba(20, 24, 32, 0.1)` | derived: neighbour `--a-0005` |
| `--shadow-popover` | `0 8px 24px rgba(0, 0, 0, 0.5)` | `0 8px 24px rgba(20, 24, 32, 0.12)` | `--a-0005` |
| `--shadow-menu` | `0 16px 40px rgba(0, 0, 0, 0.6)` | `0 16px 40px rgba(20, 24, 32, 0.16)` | `--a-0006` |
| `--shadow-floating` | `0 16px 44px rgba(0, 0, 0, 0.6)` | `0 16px 44px rgba(20, 24, 32, 0.16)` | `--a-0006` |
| `--shadow-dialog` | `0 24px 64px rgba(0, 0, 0, 0.65)` | `0 24px 64px rgba(20, 24, 32, 0.18)` | `--a-00065` |
| `--shadow-pr-comments` | `0 18px 50px rgba(0, 0, 0, 0.55)` | `0 18px 50px rgba(20, 24, 32, 0.14)` | `--a-00055` |
| `--shadow-tour-card` | `0 20px 52px rgba(0, 0, 0, 0.62)` | `0 20px 52px rgba(20, 24, 32, 0.18)` | `--a-00062` |
| `--shadow-tour-ring` | `0 0 0 3px rgba(127, 140, 255, 0.13), 0 0 26px rgba(127, 140, 255, 0.16)` | `0 0 0 3px rgba(90, 104, 232, 0.12), 0 0 26px rgba(90, 104, 232, 0.16)` | `--a-12714025513`, `--a-12714025516` |
| `--pr-comments-list-fade` | `linear-gradient(180deg, rgba(17, 18, 20, 0) 0%, #111214 92%)` | `linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #ffffff 92%)` | derived from `--c-0f1012` |
