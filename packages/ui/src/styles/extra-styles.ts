import type { LocalizedText } from '@sherpa/protocol';

/**
 * Extra visual style over the base style: its own pair of palettes, fonts and density.
 * Each style is an `extra/<id>/` directory: `index.ts` exports the `style` descriptor and loads
 * its CSS, `e2e.ts` exports theme spec expectations (`extra-style-e2e.ts`). The core does not know styles by name:
 * a build without directories uses the base style with no switch.
 */
export interface UiStyle {
    /** Latin characters in `uiSettings.style` format. `data-theme` prefix: `<id>-dark`, `<id>-light`. */
    readonly id: string;
    /** Switch label in the settings menu. */
    readonly label: LocalizedText;
}

/** Style palettes override the base `[data-theme]` through selector specificity, not CSS loading order. */
const modules = import.meta.glob<{ readonly style: UiStyle }>('./extra/*/index.ts', { eager: true });

/** Styles in this build, by id. */
export const EXTRA_STYLES: readonly UiStyle[] = Object.values(modules)
    .map((module) => module.style)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
