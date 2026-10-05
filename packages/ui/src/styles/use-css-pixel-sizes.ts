import { useLayoutEffect, useState } from 'react';

import { useUiSettings } from '../settings/context.tsx';
import { useResolvedTheme } from '../settings/document-settings.tsx';

/**
 * Read JS layout dimensions from the same element that carries the theme CSS.
 * Settings only trigger remeasurement. The gallery subtree theme may differ from them.
 * Token values are in px. Until the element exists, a temporary nonzero estimate is enough.
 */
export function useCssPixelSizes<Key extends string>(
    element: HTMLElement | null,
    properties: Readonly<Record<Key, `--${string}`>>,
): Readonly<Record<Key, number>> {
    const theme = useResolvedTheme();
    const { textSize } = useUiSettings();
    const [sizes, setSizes] = useState(() => readSizes(element, properties));

    useLayoutEffect(() => {
        if (element === null) {
            return;
        }
        const report = (): void => {
            const next = readSizes(element, properties);
            setSizes((previous) =>
                (Object.keys(properties) as Key[]).every((key) => next[key] === previous[key]) ? previous : next,
            );
        };
        report();
        // Local data-theme can change independently of app settings, for example in the gallery.
        // Observe only ancestors. Row changes inside the list do not require rereading.
        const observer = new MutationObserver(report);
        for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
            observer.observe(node, {
                attributes: true,
                attributeFilter: ['data-theme', 'data-textsize', 'class', 'style'],
            });
        }
        return () => {
            observer.disconnect();
        };
    }, [element, properties, theme, textSize]);

    return sizes;
}

function readSizes<Key extends string>(
    element: HTMLElement | null,
    properties: Readonly<Record<Key, `--${string}`>>,
): Record<Key, number> {
    const style = element === null ? null : getComputedStyle(element);
    const result = {} as Record<Key, number>;
    for (const key of Object.keys(properties) as Key[]) {
        const value = Number.parseFloat(style?.getPropertyValue(properties[key]) ?? '');
        result[key] = Number.isFinite(value) && value > 0 ? value : 1;
    }
    return result;
}
