# Light and dark themes

The top-bar toggle names the current theme. Clicking it changes the theme without a reload,
and its tooltip and accessible name describe the action. The setting is shared across PRs and saved
in `settings.json`. Without a saved choice, the existing dark theme applies. There is no automatic
switching with the OS theme. Every screen, the diff, syntax highlighting, comments, chat,
dialogs and native fields use the chosen palette. Geometry, fonts and importance values
stay the same. Dark values remain in `tokens.css` and the main design document.

Gallery: the header toggle applies to every card, and `#theme=light` reproduces
the light variant through a link. The `theme-toggle` card shows the toggle itself.

## Light-theme color tokens

`:root[data-theme='light']` overrides all color tokens, including transparency,
shadows and hatches. Semantic roles stay the same: purple for actions and AI, orange for
attention, green and red for additions and deletions. A test checks the table against CSS.

| Token | Value |
|---|---|
| `--surface-app` | `#f5f6f8` |
| `--surface-panel` | `#ffffff` |
| `--surface-panel-deep` | `#f0f2f5` |
| `--surface-diff-card` | `#ffffff` |
| `--surface-card-header` | `#f2f4f7` |
| `--surface-input` | `#ffffff` |
| `--surface-chip` | `#f0f2f5` |
| `--surface-control` | `#f5f6f8` |
| `--surface-raised` | `#ffffff` |
| `--surface-popover` | `#ffffff` |
| `--surface-selected` | `#e7ebf2` |
| `--surface-offline-banner` | `#edf0f4` |
| `--surface-command` | `#f5f6f8` |
| `--ownership-mine-surface` | `#edf7ef` |
| `--surface-digest-footer` | `#faf2f2` |
| `--overlay-dialog` | `rgba(23, 30, 43, 0.28)` |
| `--surface-toolbar` | `rgba(245, 246, 248, 0.94)` |
| `--pr-comments-overlay` | `rgba(23, 30, 43, 0.24)` |
| `--pr-comments-draft-surface` | `#fffaf0` |
| `--comment-edit-surface` | `#f1f3ff` |
| `--pr-comments-published-chip-surface` | `#edf0f4` |
| `--comment-edit-chip-surface` | `#e7ebff` |
| `--pr-comments-delete-surface` | `#fff4f3` |
| `--pr-comments-delete-button-surface` | `#fce1de` |
| `--pr-comments-delete-button-hover` | `#f8d0cc` |
| `--surface-code-inset` | `#f5f6f8` |
| `--border-hairline` | `#e5e8ee` |
| `--border-hairline-strong` | `#dce1e8` |
| `--border-hairline-soft` | `#e9ecf1` |
| `--border-standard` | `#d5dbe4` |
| `--border-control` | `#bcc5d2` |
| `--border-chip` | `#d0d7e1` |
| `--border-divider` | `#ccd3de` |
| `--border-strong` | `#bac4d1` |
| `--border-strong-lifted` | `#aeb9c9` |
| `--ownership-mine-border` | `#b7d5bf` |
| `--border-raised-bar` | `#c5cdda` |
| `--border-raised-dialog` | `#bfc8d6` |
| `--border-raised-popover` | `#b9c3d1` |
| `--pr-comments-draft-border` | `#e4d4a7` |
| `--comment-edit-border` | `#bac5ef` |
| `--pr-comments-delete-border` | `#e7b7b1` |
| `--pr-comments-delete-button-border` | `#d99890` |
| `--pr-comments-editor-border` | `#bfc8d6` |
| `--text-primary` | `#202631` |
| `--text-primary-soft` | `#29313d` |
| `--text-secondary` | `#384354` |
| `--text-secondary-dim` | `#445064` |
| `--text-body` | `#4b586b` |
| `--text-muted` | `#566277` |
| `--text-muted-dim` | `#606c7e` |
| `--text-dim` | `#677387` |
| `--text-dim-strong` | `#606c80` |
| `--text-gutter` | `#697587` |
| `--pr-comments-published-chip-text` | `#58657a` |
| `--comment-edit-chip-text` | `#394da8` |
| `--pr-comments-body-text` | `#3d495a` |
| `--chat-body-text` | `#3d495a` |
| `--pr-comments-delete-button-text` | `#912c23` |
| `--pr-comments-note-icon` | `#826226` |
| `--accent` | `#4b5bd5` |
| `--accent-hover` | `#3c4dc2` |
| `--accent-hover-strong` | `#29399c` |
| `--accent-ink` | `#ffffff` |
| `--accent-text` | `#4051b5` |
| `--accent-text-soft` | `#495791` |
| `--accent-text-bright` | `#303f96` |
| `--accent-text-queued` | `#68739b` |
| `--accent-surface` | `#eef0ff` |
| `--accent-surface-alt` | `#f3f4ff` |
| `--accent-border` | `#c9cff1` |
| `--accent-selection` | `rgba(75, 91, 213, 0.10)` |
| `--accent-text-selection` | `rgba(75, 91, 213, 0.22)` |
| `--attention` | `#e2954c` |
| `--attention-text` | `#835015` |
| `--attention-text-dim` | `#8a5b20` |
| `--attention-text-soft` | `#745027` |
| `--attention-surface` | `#fff4df` |
| `--attention-surface-alt` | `#fff9ee` |
| `--attention-border` | `#dfc799` |
| `--attention-border-alt` | `#e8d8b9` |
| `--attention-border-strong` | `#b78e47` |
| `--attention-ink` | `#1b1508` |
| `--attention-label` | `#826226` |
| `--attention-body` | `#735734` |
| `--draft-field-surface` | `#fffaf2` |
| `--draft-saved` | `#3a754d` |
| `--tag-pci-border` | `#dfceaa` |
| `--surface-tour-card` | `#ffffff` |
| `--tour-skip-underline` | `#9da9ba` |
| `--diff-add-bg` | `rgba(36, 134, 74, 0.09)` |
| `--diff-add-text` | `#23723f` |
| `--diff-add-text-strong` | `#1c6837` |
| `--diff-add-gutter` | `#427754` |
| `--diff-del-bg` | `rgba(197, 58, 48, 0.08)` |
| `--diff-del-text` | `#a4382e` |
| `--diff-del-text-strong` | `#942d24` |
| `--diff-del-gutter` | `#995950` |
| `--read-fill` | `#2b7a55` |
| `--viewed-surface` | `#edf7ef` |
| `--viewed-border` | `#b7d5bf` |
| `--success-surface` | `#dcefe2` |
| `--read-fill-hover` | `rgba(43, 122, 85, 0.15)` |
| `--read-border` | `#3f7a5a` |
| `--error` | `#b63d33` |
| `--error-text` | `#a43a31` |
| `--error-surface` | `#fff1ef` |
| `--error-border` | `#e4beb8` |
| `--code-text` | `#303b4b` |
| `--code-text-del` | `#573c3a` |
| `--surface-diff-empty` | `#f0f2f5` |
| `--surface-diff-gap` | `#f5f6f8` |
| `--diff-add-word` | `rgba(36, 134, 74, 0.19)` |
| `--diff-del-word` | `rgba(197, 58, 48, 0.18)` |
| `--diff-trailing-space` | `rgba(197, 58, 48, 0.24)` |
| `--row-hover` | `rgba(23, 30, 43, 0.04)` |
| `--checkbox-border` | `#8b99ac` |
| `--read-box-border` | `#94a0b1` |
| `--syntax-keyword` | `#4251b5` |
| `--syntax-string` | `#805416` |
| `--syntax-comment` | `#647082` |
| `--syntax-decorator` | `#92511e` |
| `--tier-medium` | `#8b97aa` |
| `--tier-low` | `#c3cad5` |
| `--tier-unfilled` | `#d7dcf0` |
| `--hatch` | `repeating-linear-gradient(115deg, #c6cdd7 0 3px, #e8ecf1 3px 6px)` |
| `--hatch-sidebar` | `repeating-linear-gradient(115deg, #cdd4de 0 3px, #e8ecf1 3px 6px)` |
| `--hatch-footer` | `repeating-linear-gradient(115deg, #e0e5ed 0 3px, #f2f4f7 3px 6px)` |
| `--hover-selected` | `#dce2ec` |
| `--surface-segment-active` | `#dce2ec` |
| `--focus-ring-color` | `rgba(60, 77, 194, 0.70)` |
| `--text-on-selected` | `#293548` |
| `--text-separator` | `#758196` |
| `--shadow-line-comment` | `0 1px 4px rgba(23, 30, 43, 0.16)` |
| `--shadow-popover` | `0 8px 24px rgba(23, 30, 43, 0.12)` |
| `--shadow-menu` | `0 16px 40px rgba(23, 30, 43, 0.15)` |
| `--shadow-floating` | `0 16px 44px rgba(23, 30, 43, 0.15)` |
| `--shadow-dialog` | `0 24px 64px rgba(23, 30, 43, 0.18)` |
| `--shadow-pr-comments` | `0 18px 50px rgba(23, 30, 43, 0.15)` |
| `--shadow-tour-card` | `0 20px 52px rgba(23, 30, 43, 0.16)` |
| `--shadow-tour-ring` | `0 0 0 3px rgba(75, 91, 213, 0.13), 0 0 26px rgba(75, 91, 213, 0.12)` |
| `--pr-comments-list-fade` | `linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #ffffff 92%)` |
