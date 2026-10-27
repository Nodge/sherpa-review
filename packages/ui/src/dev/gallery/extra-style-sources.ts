/**
 * Source CSS for additional build styles (`styles/extra/<id>/*.css`) for the token display.
 * Separate module: tests replace it with their own style. Vitest does not return CSS text even with `?raw`.
 */
export const EXTRA_STYLE_CSS: readonly string[] = Object.values(
    import.meta.glob<string>('../../styles/extra/*/*.css', { query: '?raw', import: 'default', eager: true }),
);
