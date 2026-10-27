/**
 * E2E expectations for an extra style: `extra/<id>/e2e.ts` exports `e2e` of this type.
 * The theme spec (`packages/e2e/src/theme.spec.ts`) discovers style directories and runs the same
 * scenarios for each. No imports: Playwright also reads this file, and cannot use `import.meta.glob`.
 */
export interface ExtraStyleE2e {
    /** Same id as the `style` descriptor in `index.ts`. */
    readonly id: string;
    /** Switch label, as in `index.ts`. */
    readonly label: { readonly en: string; readonly ru: string };
    readonly dark: ExtraStylePalette;
    readonly light: ExtraStylePalette;
    /** `body` font. */
    readonly fontFamily: RegExp;
    readonly geometry: ExtraStyleGeometry;
}

export interface ExtraStylePalette {
    /** Computed `background-color` of `body`: `rgb(…)`. */
    readonly background: string;
}

export interface ExtraStyleGeometry {
    /** Code line `line-height`, px. */
    readonly codeLineHeight: number;
    /** File tree row height, px. */
    readonly treeRowHeight: number;
    /** Filename font in the card header. */
    readonly fileNameFont: RegExp;
}
