import type { UiGenerationCap } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { ToolbarRightCluster } from '../../components/toolbar-controls.tsx';
import { useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
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

/** "What is new" filter chip (README §9), dismissible with a close button. */
export const CHANGE_CHIP_LABEL = 'Showing changes since the previous pass';

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
    /** The "what is new since the last pass" filter is on (README §9): a chip appears below the preset. */
    readonly changeFilterOn?: boolean;
    readonly onClearChangeFilter?: () => void;
    /** Second toolbar row: coverage strip (SPEC §2.4). */
    readonly strip: ReactNode;
    /**
     * Generation cap (SPEC §4.1): the payload budget kept part of the diff out of the agent's context.
     * null means no truncation or a route built before M5-T14.
     */
    readonly generationCap?: UiGenerationCap | null;
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
    changeFilterOn = false,
    onClearChangeFilter,
    strip,
    generationCap = null,
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
            {/* Give the filter chip its own row. It does not fit beside the preset at the minimum width of 1280. */}
            {changeFilterOn && onClearChangeFilter !== undefined ? (
                <div className="route-toolbar__filters">
                    <button
                        type="button"
                        className="route-change-chip"
                        title="Show the entire route"
                        onClick={onClearChangeFilter}
                    >
                        {CHANGE_CHIP_LABEL}
                        <Icon name="cross" size={9} />
                    </button>
                </div>
            ) : null}
            <div className="route-toolbar__strip">{strip}</div>
            <GenerationCapNote cap={generationCap} />
        </div>
    );
}

/**
 * Cap row below the coverage bar (SPEC §4.1): what limits the plan. Stays silent while
 * the entire diff fits in context. The coverage bar already has a way to say that everything is covered.
 *
 * Mention the generated group only when it exists. Without one, saying "0 generated files in one stop"
 * would be false. Always print the denominator, or the row counts will not add up to the diff,
 * and the remainder mentioned by the banner would seem to come from nowhere.
 */
function GenerationCapNote({ cap }: { cap: UiGenerationCap | null }) {
    const t = useT();
    if (cap === null || cap.filesCovered >= cap.filesTotal) {
        return null;
    }
    return (
        <div className="route-toolbar__cap">
            {cap.machineFiles > 0
                ? t('route.cap.note.machine', cap.filesCovered, cap.filesTotal, cap.machineFiles)
                : t('route.cap.note', cap.filesCovered, cap.filesTotal)}
        </div>
    );
}
