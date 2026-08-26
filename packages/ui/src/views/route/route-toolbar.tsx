import type { ReactNode } from 'react';

import { CommentSources, DiffModeToggle } from '../../components/toolbar-controls.tsx';
import { FilterSelect } from '../../components/filter-select.tsx';
import type { DiffViewStore } from '../../diff-view/store.js';
import type { FileFilter } from '../../filters/lens-filters.js';
import type { ThreadsShow } from '../../session/session-store.js';
import type { ThreadSourceCounts } from '../../threads/model.js';

/**
 * Sticky route toolbar (README §1): preset selector with hint, diff mode
 * toggle, comment source chips and file filter selector. Controls are shared with the full
 * diff, so mode and filter must match across views.
 *
 * The second row is the coverage bar with its own legend and viewed stop counter.
 * The view assembles it and passes it here ready to render.
 */

export const TRIAGE_HINT = 'The most important first — stop when you have seen enough.';
export const TOUR_HINT = 'Reading order: entry point → definitions → consequences → verification.';

export interface RouteToolbarProps {
    readonly store: DiffViewStore;
    readonly filters: readonly FileFilter[];
    readonly filter: FileFilter;
    readonly onFilter: (id: string) => void;
    readonly threadsShow: ThreadsShow;
    readonly threadCounts: ThreadSourceCounts;
    readonly onThreadsShow: (show: ThreadsShow) => void;
    /** Second toolbar row: coverage strip (SPEC §2.4). */
    readonly strip: ReactNode;
}

export function RouteToolbar({
    store,
    filters,
    filter,
    onFilter,
    threadsShow,
    threadCounts,
    onThreadsShow,
    strip,
}: RouteToolbarProps) {
    return (
        <div className="route-toolbar">
            <div className="route-toolbar__row">
                {/* Preset switching arrives with the full tour (M2-T8). Here it is static. */}
                <div className="route-preset" role="group" aria-label="Route preset">
                    <button type="button" className="route-preset__option is-active" aria-pressed>
                        Triage
                    </button>
                    <button
                        type="button"
                        className="route-preset__option"
                        disabled
                        title="full tour is not available yet"
                        aria-pressed={false}
                    >
                        Full tour
                    </button>
                </div>
                <span className="route-toolbar__hint">{TRIAGE_HINT}</span>
                <span className="route-toolbar__spacer" />
                <DiffModeToggle store={store} />
                <span className="toolbar-label">Comments:</span>
                <CommentSources show={threadsShow} counts={threadCounts} onChange={onThreadsShow} />
                <FilterSelect filters={filters} active={filter} onSelect={onFilter} />
            </div>
            <div className="route-toolbar__strip">{strip}</div>
        </div>
    );
}
