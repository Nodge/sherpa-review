# Interface themes

The main style's values live in [tokens.css](../../packages/ui/src/styles/tokens.css). Shared control states live in [controls.css](../../packages/ui/src/styles/controls.css), and build-specific styles live under `packages/ui/src/styles/extra/<id>/`. This document records the design reasons behind them.

## Theme boundaries

Each theme supplies the full token set so a gallery card can show one theme inside another without inheriting colours, fonts or geometry from its surroundings. Components use tokens by role and remain independent of theme names. A new style must work with the same components and syntax categories.

The product applies one theme to the whole page. Nested themes exist for the state gallery, where they let the reviewer compare appearances side by side.

## Palette decisions

The main dark palette deliberately has little separation between neutral text levels. The [September theming spec](SPEC-theming-2026-09-12.md) increased contrast after complaints about readability. This flattened the grey hierarchy. Keep semantic roles separate even when their colours match, because the light palette and extra styles can distinguish them.

Comment actions use `--text-link-muted` to stay less prominent than the comment body. Without that distinction, "Edit" and "Delete" compete with the text the reviewer came to read.

The migration formulas and original colour tables remain in the dated spec. Current values belong in CSS. The contrast tests calculate against those values, including translucent backgrounds. Known exceptions remain explicit in the tests, so a palette edit cannot silently weaken them.

## Light theme

An active segment must look selected rather than disabled. The light theme uses a raised white surface on a grey track because grey on grey lost that distinction.

Attention buttons need their own fill and text pair. Reusing the general attention colour produced a muddy combination on the light background.

Read state must preserve legibility. Dim text through its semantic tokens rather than applying opacity to an entire stop or file chip.

## Control states

Hover and press primarily change the surface so labels remain stable while the pointer moves. Links and destructive controls can also change their foreground to communicate the action. Use the Controls gallery card to review these states together in both themes.

## Typography

Text scales with the browser's font setting. Small text has a minimum size to preserve legibility. Avatar initials are decorative glyphs, and the stop number in a file-tree row is the only text exception: it is a secondary marker beside the filename, constrained by its small badge. Adding another exception requires a design decision.

Code line height stays in pixels to keep diff rows at a predictable density. The font scale, font families and text-size settings are defined in CSS. Review changes at both text sizes in the gallery, especially labels in fixed-height controls.
