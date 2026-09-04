import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Route in the full diff margins (M2-T11, README §10): badges in the tree and card headers,
 * a footer note with calculated fixture counts (38 lines in 4 files), and hatched strips
 * for uncovered ranges. The second state is the same reader without a route, with no margins at all.
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

/**
 * `paths` narrows the diff to the files we need. Otherwise, the partially covered file card would require
 * scrolling, and a gallery state must always show the same frame.
 */
function MarginState({ route = true, paths }: { route?: boolean; paths?: readonly string[] }) {
    const diff = useMemo(
        () =>
            paths === undefined
                ? DATA.diff
                : { ...DATA.diff, files: DATA.diff.files.filter((file) => paths.includes(file.path)) },
        [paths],
    );
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: diff.files });
        for (const file of diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [diff]);
    const threadStore = useMemo(
        () => createThreadStore([], new Set(diff.files.map((file) => file.fileId))),
        [diff],
    );

    return (
        <div className="gallery__viewport">
            <DiffWorkspace
                pr={DATA.pr}
                diff={diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                prKey="fixture-medium"
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
                {...(route ? { routeSnapshot: readySnapshot() } : {})}
                onJumpToStop={() => {
                    // The gallery has no route tab, so there is nowhere to complete the navigation.
                }}
            />
        </div>
    );
}

export const M2_T11_STATES: readonly RouteGalleryState[] = [
    {
        id: 'diff-route-badges',
        title: 'full diff with a route: tree badges, footer note, card margins',
        render: () => <MarginState />,
    },
    {
        id: 'diff-route-hatched',
        title: 'partially covered file: hatched strips for uncovered ranges',
        render: () => (
            <MarginState
                paths={[
                    'services/orders/src/payments/generated/psp-schema.ts',
                    '.github/CODEOWNERS',
                ]}
            />
        ),
    },
    {
        id: 'diff-route-none',
        title: 'full diff without a route: no margins at all',
        render: () => <MarginState route={false} />,
    },
];
