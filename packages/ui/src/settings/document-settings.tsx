import type { UiSettings } from '@sherpa/protocol';
import { useLayoutEffect, useSyncExternalStore } from 'react';

import { EXTRA_STYLES } from '../styles/extra-styles.js';
import { useUiSettings } from './context.tsx';

/** Actual theme, resolved from the `auto` settings mode. */
type ColorScheme = Exclude<UiSettings['theme'], 'auto'>;
/** Onscreen palette, either the base style theme or `<id>-<theme>` for an extra style. */
export type ResolvedTheme = ColorScheme | `${string}-${ColorScheme}`;

/** The server's inline script reads the same query (`packages/server/src/ui-document.ts`). */
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** The store's initial appearance matches the initial HTML even if the settings GET never responds. */
export function readDocumentAppearance(root: HTMLElement): Partial<UiSettings> {
    const initial: Partial<UiSettings> = {};
    const theme = root.getAttribute('data-theme');
    const textSize = root.getAttribute('data-textsize');
    const parsed = theme === null ? null : parseTheme(theme);
    if (parsed !== null) {
        initial.theme = parsed.scheme;
        initial.style = parsed.style;
    }
    if (textSize === 'm' || textSize === 'l') {
        initial.textSize = textSize;
    }
    return initial;
}

/**
 * `data-theme` → theme and style. For a style absent from this build, the theme still comes from
 * the suffix, while the style falls back to the base style.
 */
function parseTheme(value: string): { scheme: ColorScheme; style: string | null } | null {
    if (value === 'dark' || value === 'light') {
        return { scheme: value, style: null };
    }
    const match = /^(.+)-(dark|light)$/.exec(value);
    const id = match?.[1];
    const scheme = match?.[2];
    if (id === undefined || (scheme !== 'dark' && scheme !== 'light')) {
        return null;
    }
    return { scheme, style: EXTRA_STYLES.some((style) => style.id === id) ? id : null };
}

/**
 * Settings-dependent `<html>` attributes. The theme covers the page background, native controls and
 * dialog portals. Text size sets the root `font-size`, which determines the entire rem scale.
 * `data-theme` always contains the resolved theme because CSS does not know about `auto`. The server inserts
 * the same attributes in the served `index.html` to prevent repainting the first frame.
 *
 * The initial store already matches the initial HTML through readDocumentAppearance. Synchronization
 * runs even before GET so an explicit choice applies immediately when the endpoint is slow or unavailable.
 * The HTML theme `light` can still mean Auto. A late response clarifies the selection mode.
 */
export function DocumentSettingsSync() {
    const theme = useResolvedTheme();
    const { textSize } = useUiSettings();
    useLayoutEffect(() => setDocumentAttribute('data-theme', theme), [theme]);
    useLayoutEffect(
        () => setDocumentAttribute('data-textsize', textSize),
        [textSize],
    );
    return null;
}

/**
 * The theme the reviewer sees is an explicit choice or the system theme in `auto`, prefixed with
 * the selected style. A saved style absent from this build falls back to the base theme.
 */
export function useResolvedTheme(): ResolvedTheme {
    const { theme, style } = useUiSettings();
    const system = useSyncExternalStore(subscribeToSystemTheme, systemTheme, serverSystemTheme);
    const scheme = theme === 'auto' ? system : theme;
    const active = EXTRA_STYLES.find((extra) => extra.id === style);
    return active === undefined ? scheme : `${active.id}-${scheme}`;
}

/** Sets an attribute on `<html>` and returns a function to restore its previous value. */
function setDocumentAttribute(name: string, value: string): () => void {
    const root = document.documentElement;
    const previous = root.getAttribute(name);
    root.setAttribute(name, value);
    return () => {
        if (previous === null) {
            root.removeAttribute(name);
        } else {
            root.setAttribute(name, previous);
        }
    };
}

/** System theme. Without `matchMedia`, it stays dark, which is also the tokens' default. */
function systemTheme(): ColorScheme {
    const media = darkSchemeMedia();
    return media === null || media.matches ? 'dark' : 'light';
}

/**
 * Rendering without a window (`renderToStaticMarkup` in gallery tests) cannot query the system theme,
 * so it stays dark, as in `index.html`, where `auto` has no attribute and uses the token
 * default.
 */
function serverSystemTheme(): ColorScheme {
    return 'dark';
}

/** System theme changes apply without a reload, so the subscription stays active throughout. */
function subscribeToSystemTheme(listener: () => void): () => void {
    const media = darkSchemeMedia();
    if (media === null) {
        return () => undefined;
    }
    media.addEventListener('change', listener);
    return () => {
        media.removeEventListener('change', listener);
    };
}

/** `null` means `matchMedia` is unavailable in this environment (component tests outside jsdom). */
function darkSchemeMedia(): MediaQueryList | null {
    return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;
}
