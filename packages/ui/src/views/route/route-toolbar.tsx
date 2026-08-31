import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { ToolbarRightCluster } from '../../components/toolbar-controls.tsx';
import type { DiffViewStore } from '../../diff-view/store.js';
import type { FileFilter } from '../../filters/lens-filters.js';
import type { RoutePreset, ThreadsShow } from '../../session/session-store.js';
import type { ThreadSourceCounts } from '../../threads/model.js';

/**
 * Sticky route toolbar (README §1): preset switcher with a hint and the right cluster shared with the full
 * diff. Mode, filter and comment sources must match between views.
 *
 * The second row is the coverage bar with its own legend and viewed stop counter.
 * The view assembles it and passes it here ready to render.
 */

export const TRIAGE_HINT = 'The most important first — stop when you have seen enough.';
export const TOUR_HINT = 'Reading order: entry point → definitions → consequences → verification.';

/** SPEC §2.5: the toggle is disabled until a route exists and explains why (`title`). */
export const PRESET_DISABLED_TITLE = 'available once the route is built';

const PRESETS: readonly { readonly id: RoutePreset; readonly label: string; readonly hint: string }[] = [
    { id: 'triage', label: 'Triage', hint: TRIAGE_HINT },
    { id: 'tour', label: 'Full tour', hint: TOUR_HINT },
];

export interface RouteToolbarProps {
    readonly store: DiffViewStore;
    readonly preset: RoutePreset;
    readonly onPreset: (preset: RoutePreset) => void;
    /** No route means nothing to toggle (SPEC §2.5). */
    readonly presetDisabled?: boolean;
    readonly filters: readonly FileFilter[];
    readonly filter: FileFilter;
    readonly onFilter: (id: string) => void;
    readonly threadsShow: ThreadsShow;
    readonly threadCounts: ThreadSourceCounts;
    readonly onThreadsShow: (show: ThreadsShow) => void;
    /** Second toolbar row: coverage strip (SPEC §2.4). */
    readonly strip: ReactNode;
    /**
     * Measured toolbar height. The view uses it for the sticky offset of the stops column.
     * The toolbar measures itself so layout changes cannot silently diverge from the offset.
     */
    readonly onHeight?: ((height: number) => void) | undefined;
}

export function RouteToolbar({
    store,
    preset,
    onPreset,
    presetDisabled = false,
    filters,
    filter,
    onFilter,
    threadsShow,
    threadCounts,
    onThreadsShow,
    strip,
    onHeight,
}: RouteToolbarProps) {
    const ref = useRef<HTMLDivElement | null>(null);

    // Measure before painting: otherwise the first frame uses the fallback height from route.css.
    // Take the initial measurement manually because ResizeObserver stays silent in background tabs.
    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null || onHeight === undefined) {
            return;
        }
        const report = (): void => {
            onHeight(element.getBoundingClientRect().height);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [onHeight]);

    return (
        <div className="route-toolbar" ref={ref}>
            <div className="route-toolbar__row">
                <div className="route-preset" role="group" aria-label="Route preset">
                    {PRESETS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`route-preset__option${option.id === preset ? ' is-active' : ''}`}
                            aria-pressed={option.id === preset}
                            disabled={presetDisabled}
                            {...(presetDisabled ? { title: PRESET_DISABLED_TITLE } : {})}
                            onClick={() => {
                                onPreset(option.id);
                            }}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                <span className="route-toolbar__hint">
                    {PRESETS.find((option) => option.id === preset)?.hint ?? TRIAGE_HINT}
                </span>
                <span className="route-toolbar__spacer" />
                <ToolbarRightCluster
                    store={store}
                    filters={filters}
                    filter={filter}
                    onFilter={onFilter}
                    threadsShow={threadsShow}
                    threadCounts={threadCounts}
                    onThreadsShow={onThreadsShow}
                />
            </div>
            <div className="route-toolbar__strip">{strip}</div>
        </div>
    );
}
