import type { RouteStop } from '@sherpa/protocol';
import { useMemo } from 'react';

import { createDiffViewStore } from '../diff-view/store.js';
import { buildFileFilters } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import type { RouteStopView } from '../route/route-model.js';
import { CoverageStrip } from '../views/route/coverage-strip.tsx';
import { RouteToolbar } from '../views/route/route-toolbar.tsx';
import { CollapsedStop, StopCard, StopSkeleton } from '../views/route/stop-card.tsx';
import './tour.css';

/**
 * Tour placeholder on the "Route" tab while no route exists:
 * the tour starts as soon as the UI first opens, and the placeholder supplies the missing step targets,
 * otherwise the first visit would tour an empty screen.
 *
 * The placeholder is inert by construction: it never enters `buildRouteModel` or `entries`, has
 * no `data-stop`, is invisible to `j/k/n/p` and the palette, and all handlers are empty. It blocks
 * clicks itself. No `aria-hidden`, because the tour ring references the placeholder through `aria-describedby`.
 *
 * Disappears when the tour ends or the real route arrives.
 */
/** Placeholder layer: step targets are searched here first. See `anchorOf` in `tour-layer.tsx`. */
export const TOUR_SCAFFOLD_SELECTOR = '.tour-scaffold';

export function TourScaffold() {
    const t = useT();
    const store = useMemo(() => createDiffViewStore({ files: [], progress: [] }), []);
    const filters = useMemo(() => buildFileFilters({ files: [], ownership: null, extra: [], t }), [t]);
    const filter = filters[0];
    const view = useMemo<RouteStopView>(() => stubStopView(t('tour.stub.title'), t('tour.stub.body')), [t]);

    if (filter === undefined) {
        return null;
    }

    return (
        <div className="route tour-scaffold">
            <RouteToolbar
                store={store}
                preset="triage"
                onPreset={NOOP}
                presetDisabled
                filters={filters}
                filter={filter}
                onFilter={NOOP}
                strip={<CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 0 }} />}
            />

            <div className="route__stops">
                <StopCard
                    view={view}
                    tourAnchors
                    stopCount={1}
                    comments={0}
                    viewed={false}
                    onViewed={NOOP}
                    chips={null}
                    diff={<StopSkeleton />}
                />
                <CollapsedStop label={t('tour.stub.fold')} dataTour="fold-stub" onExpand={NOOP} />
            </div>
        </div>
    );
}

const NOOP = (): void => undefined;

/**
 * Placeholder stop: `queued`, because there is nothing to say about it except that
 * the first route stop will appear here. It has no anchors, files or coverage numbers.
 */
function stubStopView(title: string, paragraph: string): RouteStopView {
    const stop: RouteStop = {
        id: 'tour-stub',
        planIndex: 1,
        tier: 'medium',
        title,
        status: 'queued',
        paragraph,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
    return {
        stop,
        planLabel: '01',
        files: [],
        changedLines: 0,
        unresolvedPaths: [],
        conflictPaths: [],
        drift: false,
        empty: true,
        pending: false,
        parseFailed: false,
    };
}
