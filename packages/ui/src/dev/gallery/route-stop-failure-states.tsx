import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * A failed slot in a ready route: the "Fill this stop" button renders only
 * with `status: 'failed'` and a supplied `onFillStop`, and until now appeared only in a component test.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

/**
 * A ready route with one failed slot: a real failed slot has neither a paragraph
 * nor anchors. The other slots stay `ready`, otherwise the snapshot would count as still filling
 * and `onFillStop` would never reach the card.
 */
function failedStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's01'
                ? {
                      ...stop,
                      status: 'failed' as const,
                      paragraph: null,
                      bridge: null,
                      anchors: [],
                      tests: [],
                      validationNotes: [],
                  }
                : stop,
        ),
    };
}

function FailedStopState() {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all' } }), []);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files });
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
                snapshot={failedStopSnapshot()}
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
                onSetStopFileViewed={() => Promise.resolve(0)}
                onFillStop={() => undefined}
            />
        </div>
    );
}

export const ROUTE_STOP_FAILURE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-stop-failed',
        title: 'failed slot in a ready route: note and "Fill this stop"',
        render: () => <FailedStopState />,
    },
];
