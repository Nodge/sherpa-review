import { useLayoutEffect, useSyncExternalStore } from 'react';

import { useUiSettings, useUiSettingsLoaded } from './context.tsx';

/** Actual theme, resolved from the `auto` settings mode. */
export type ResolvedTheme = 'dark' | 'light';

/** The server's inline script reads the same query (`packages/server/src/ui-document.ts`). */
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * Settings-dependent `<html>` attributes. The theme covers the page background, native controls and
 * dialog portals. Text size sets the root `font-size`, which determines the entire rem scale.
 * `data-theme` always contains the resolved theme because CSS does not know about `auto`. The server inserts
 * the same attributes in the served `index.html` to prevent repainting the first frame.
 *
 * Leave the attributes alone until `GET /api/ui/settings` responds. The store still holds defaults, while the document
 * already has the saved state from the server. The first render runs after a timeout (`main.tsx`), so a slow
 * endpoint leaves it with defaults. Writing them would repaint the page over the correct
 * theme, and a failed request would leave that theme in place until reload.
 */
export function DocumentSettingsSync() {
    const theme = useResolvedTheme();
    const { textSize } = useUiSettings();
    const loaded = useUiSettingsLoaded();
    useLayoutEffect(() => (loaded ? setDocumentAttribute('data-theme', theme) : undefined), [loaded, theme]);
    useLayoutEffect(
        () => (loaded ? setDocumentAttribute('data-textsize', textSize) : undefined),
        [loaded, textSize],
    );
    return null;
}

/** The theme the reviewer sees on screen: an explicit choice or the system theme in `auto` mode. */
export function useResolvedTheme(): ResolvedTheme {
    const { theme } = useUiSettings();
    const system = useSyncExternalStore(subscribeToSystemTheme, systemTheme, serverSystemTheme);
    return theme === 'auto' ? system : theme;
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
function systemTheme(): ResolvedTheme {
    const media = darkSchemeMedia();
    return media === null || media.matches ? 'dark' : 'light';
}

/**
 * Rendering without a window (`renderToStaticMarkup` in gallery tests) cannot query the system theme,
 * so it stays dark, as in `index.html`, where `auto` has no attribute and uses the token
 * default.
 */
function serverSystemTheme(): ResolvedTheme {
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
