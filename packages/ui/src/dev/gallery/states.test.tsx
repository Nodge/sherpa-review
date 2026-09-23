// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '../../i18n/index.js';
import { GALLERY_STATES } from './states.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The file list virtualizer requires ResizeObserver. jsdom has no layout, so there is nothing to observe.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // No layout.
    }
    unobserve(): void {
        // No layout.
    }
    disconnect(): void {
        // No layout.
    }
};

// jsdom has no scrolling. States that scroll a card into view call it on mount.
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // No scrolling.
};

describe('gallery registry', () => {
    it('has no duplicate ids', () => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();

        for (const state of GALLERY_STATES) {
            if (seen.has(state.id)) {
                duplicates.add(state.id);
            }
            seen.add(state.id);
        }

        expect([...duplicates], 'duplicate gallery state ids').toEqual([]);
    });

    // Untranslated text renders in Russian and must not crash: the smoke test catches missing keys
    // and other failures in another language, rather than incomplete translations.
    // The registry is tested in groups: rendering all states in jsdom takes tens of
    // seconds, and on a busy machine (`pnpm -r test` runs all packages at once) the total budget
    // hit the timeout. Each group has enough time, and a failing group is immediately visible.
    for (const group of groups()) {
        it(`renders states in group "${group}" in both locales`, { timeout: 60_000 }, () => {
            for (const locale of ['ru', 'en'] as const) {
                for (const state of GALLERY_STATES.filter((candidate) => candidate.group === group)) {
                    expect(() => {
                        render(<LocaleProvider locale={locale}>{state.render()}</LocaleProvider>);
                    }, `${state.id} · ${locale}`).not.toThrow();
                }
            }
        });
    }
});

/** Registry groups in order of appearance: this list defines one test per group. */
function groups(): readonly string[] {
    return [...new Set(GALLERY_STATES.map((state) => state.group))];
}

/** Mounts a state in its own container and immediately unmounts it: rendering is enough for the gallery. */
function render(node: React.ReactNode): void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        act(() => {
            root.render(node);
        });
    } finally {
        act(() => {
            root.unmount();
        });
        host.remove();
    }
}
