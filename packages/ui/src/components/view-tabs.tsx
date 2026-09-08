import { useRef } from 'react';

import { translateKey, useT } from '../i18n/index.js';
import type { ViewId } from '../session/views.js';
import { VIEWS } from '../session/views.js';

/**
 * View segmented control (docs/design/README.md §0, docs/design/SPEC-elements.md §2.1, §4.4).
 * Tabs are never disabled. Even without a route, the "Route" tab opens and shows
 * its state.
 *
 * Keyboard: ←/→ move between tabs when focus is inside the control. 1/2/3 are global commands
 * from the shortcuts registry and are not handled here.
 */
export interface ViewTabsProps {
    readonly view: ViewId;
    readonly onSelect: (view: ViewId) => void;
}

export function ViewTabs({ view, onSelect }: ViewTabsProps) {
    const t = useT();
    const buttons = useRef(new Map<ViewId, HTMLButtonElement>());

    const step = (delta: number): void => {
        const index = VIEWS.findIndex((item) => item.id === view);
        const next = VIEWS[(index + delta + VIEWS.length) % VIEWS.length];
        if (next === undefined) {
            return;
        }
        onSelect(next.id);
        buttons.current.get(next.id)?.focus();
    };

    return (
        <div className="view-tabs" role="tablist" aria-label={t('view.tabs')}>
            {VIEWS.map((item) => (
                <button
                    key={item.id}
                    ref={(element) => {
                        if (element === null) {
                            buttons.current.delete(item.id);
                        } else {
                            buttons.current.set(item.id, element);
                        }
                    }}
                    type="button"
                    role="tab"
                    className="view-tabs__tab"
                    aria-selected={item.id === view}
                    // Target of step 07 of the onboarding tour.
                    {...(item.id === 'diff' ? { 'data-tour': 'fulldiff' } : {})}
                    // Roving tabindex: Tab enters the control once, then arrow keys move within it.
                    tabIndex={item.id === view ? 0 : -1}
                    onClick={() => {
                        onSelect(item.id);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft') {
                            event.preventDefault();
                            step(-1);
                        } else if (event.key === 'ArrowRight') {
                            event.preventDefault();
                            step(1);
                        }
                    }}
                >
                    {translateKey(t, item.label)}
                </button>
            ))}
        </div>
    );
}
