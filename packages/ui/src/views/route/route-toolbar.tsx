import type { UiGenerationCap } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { ToolbarRightCluster } from '../../components/toolbar-controls.tsx';
import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import type { DiffViewStore } from '../../diff-view/store.js';
import type { FileFilter } from '../../filters/lens-filters.js';
import type { RoutePreset, ThreadsShow } from '../../session/session-store.js';
import type { ThreadSourceCounts } from '../../threads/model.js';

/**
 * Sticky route toolbar (docs/design/README.md §1): preset switch with a tooltip and a right-hand cluster shared with the full
 * diff. Mode, filter and comment sources must match between views.
 *
 * The second row is the coverage bar with its own legend and viewed stop counter.
 * The view assembles it and passes it here ready to render.
 */

export const TRIAGE_HINT: MessageKey = 'route.preset.triage.hint';
export const TOUR_HINT: MessageKey = 'route.preset.tour.hint';

/** docs/design/SPEC-elements.md §2.5: the switch is disabled until a route exists and explains why (`title`). */
export const PRESET_DISABLED_TITLE: MessageKey = 'route.preset.disabled';

/** The what-is-new filter chip (docs/design/README.md §9) can be cleared with its close button. */
export const CHANGE_CHIP_LABEL: MessageKey = 'route.changeChip';

const PRESETS: readonly { readonly id: RoutePreset; readonly label: MessageKey; readonly hint: MessageKey }[] = [
    { id: 'triage', label: 'route.preset.triage', hint: TRIAGE_HINT },
    { id: 'tour', label: 'route.preset.tour', hint: TOUR_HINT },
];

export interface RouteToolbarProps {
    readonly store: DiffViewStore;
    readonly preset: RoutePreset;
    readonly onPreset: (preset: RoutePreset) => void;
    /** There is no route, so there is nothing to switch (docs/design/SPEC-elements.md §2.5). */
    readonly presetDisabled?: boolean;
    readonly filters: readonly FileFilter[];
    readonly filter: FileFilter;
    readonly onFilter: (id: string) => void;
    readonly threadsShow: ThreadsShow;
    readonly threadCounts: ThreadSourceCounts;
    readonly onThreadsShow: (show: ThreadsShow) => void;
    /** The changes-since-last-pass filter is on (docs/design/README.md §9). Show a chip below the preset. */
    readonly changeFilterOn?: boolean;
    readonly onClearChangeFilter?: () => void;
    /** Second toolbar row: the coverage bar (docs/design/SPEC-elements.md §2.4). */
    readonly strip: ReactNode;
    /**
     * Generation limit (docs/design/SPEC-elements.md §4.1): the payload budget kept part of the diff out of the agent context.
     * null means nothing was cut or the route was built by an older version.
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
    const t = useT();
    const ref = useRef<HTMLDivElement | null>(null);

    // Measure before painting, or the first frame will use the fallback height from route.css.
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
                {/* `data-tour="presets"` is the target of onboarding tour step 05. */}
                <div className="route-preset ctl-tabs" role="group" aria-label={t('route.preset.aria')} data-tour="presets">
                    {PRESETS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`ctl ctl--tab route-preset__option${option.id === preset ? ' is-active' : ''}`}
                            aria-pressed={option.id === preset}
                            disabled={presetDisabled}
                            {...(presetDisabled ? { title: t(PRESET_DISABLED_TITLE) } : {})}
                            onClick={() => {
                                onPreset(option.id);
                            }}
                        >
                            {t(option.label)}
                        </button>
                    ))}
                </div>
                <span className="route-toolbar__hint">
                    {t(PRESETS.find((option) => option.id === preset)?.hint ?? TRIAGE_HINT)}
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
                        className="ctl ctl--chip route-change-chip"
                        title={t('route.showWhole')}
                        onClick={onClearChangeFilter}
                    >
                        {t(CHANGE_CHIP_LABEL)}
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
 * The limit row below the coverage bar (docs/design/SPEC-elements.md §4.1) states what limits the plan. It stays hidden while
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
