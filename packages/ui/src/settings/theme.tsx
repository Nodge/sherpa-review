import { useLayoutEffect } from 'react';

import { useUiSettings } from './context.tsx';

/** The document theme covers the page background, native controls and dialog portals. */
export function ThemeSync() {
    const { theme } = useUiSettings();
    useLayoutEffect(() => {
        const root = document.documentElement;
        const previous = root.getAttribute('data-theme');
        root.setAttribute('data-theme', theme);
        return () => {
            if (previous === null) {
                root.removeAttribute('data-theme');
            } else {
                root.setAttribute('data-theme', previous);
            }
        };
    }, [theme]);
    return null;
}
