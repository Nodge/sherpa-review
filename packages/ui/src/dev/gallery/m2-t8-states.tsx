import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo, useState } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import type { RoutePreset } from '../../session/session-store.js';
import { createSessionStore, DEFAULT_THREADS_SHOW } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { countThreadSources } from '../../threads/model.js';
import { CoverageStrip } from '../../views/route/coverage-strip.tsx';
import { RouteToolbar } from '../../views/route/route-toolbar.tsx';
import { RouteWorkspace } from '../../views/route/route-view.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Full tour preset (M2-T8): the snapshot's `tourOrder` sets card order, stop numbers
 * stay fixed by the plan. Also shows a disabled toggle as it looks before a route
 * exists (SPEC §2.5).
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

/** Route in the selected preset: the toggle works, and state lives in the gallery session. */
function PresetRouteState({ preset }: { preset: RoutePreset }) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter: 'all', preset } }),
        [preset],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files, storage: null });
        for (const file of DATA.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, []);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <div className="gallery__viewport">
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                snapshot={readySnapshot()}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

/** Toolbar without a route: the toggle is disabled and explains why through `title` (SPEC §2.5). */
function DisabledPresetState() {
    const [preset, setPreset] = useState<RoutePreset>('triage');
    const store = useMemo(() => createDiffViewStore({ files: DATA.diff.files, storage: null }), []);
    const filters = useMemo(
        () => buildFileFilters({ files: DATA.diff.files, ownership: DATA.ownership, extra: DATA.extraLenses }),
        [],
    );

    return (
        <div className="gallery__viewport">
            <RouteToolbar
                store={store}
                preset={preset}
                onPreset={setPreset}
                presetDisabled
                filters={filters}
                filter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                threadsShow={DEFAULT_THREADS_SHOW}
                threadCounts={countThreadSources(DATA.threads)}
                onThreadsShow={() => undefined}
                strip={<CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 7 }} />}
            />
        </div>
    );
}

export const M2_T8_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-tour',
        title: 'full tour: tourOrder order, stop numbers fixed by the plan',
        render: () => <PresetRouteState preset="tour" />,
    },
    {
        id: 'route-preset-disabled',
        title: 'preset toggle disabled: no route yet',
        render: () => <DisabledPresetState />,
    },
];
