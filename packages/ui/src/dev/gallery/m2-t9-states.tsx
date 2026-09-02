import { fileContentOf, fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from '../../views/route/route-view.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Behavioural test digest (M2-T9) on fixture stop s04: 12 accepted assertions,
 * two discarded by the validator, and two `uncovered` in the footer. Test code is hidden by default.
 * The session supplies the toggle state, so the frame is deterministic.
 *
 * The entire route is rendered: coverage bar and "Other" counts must match
 * the fixture, and a reduced snapshot would show 20% explained.
 */

const DATA = fixtureData('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');
/** The fixture digest stop. Full tour and Triage do not affect it. */
const DIGEST_STOP = 's04';

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

/** Derived state: s04 assertions lead to s01, while the digest stop files stay the same. */
function digestOutsideStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    const target = snapshot.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (target === undefined) {
        throw new Error('stop s01 needs an anchor for the derived snapshot');
    }
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id !== DIGEST_STOP
                ? stop
                : {
                      ...stop,
                      tests: stop.tests.map((claim) =>
                          claim.kind === 'uncovered'
                              ? claim
                              : {
                                    ...claim,
                                    anchor: { fileId: target.fileId, path: target.path, line: target.start },
                                },
                      ),
                  },
        ),
    };
}

function DigestState({
    snapshot = readySnapshot(),
    stops = EMPTY_STOPS,
    viewed = false,
}: {
    snapshot?: RouteSnapshot;
    stops?: StopsState;
    viewed?: boolean;
}) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter: 'all', stops } }),
        [stops],
    );
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
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                initialStopViewed={viewed ? [DIGEST_STOP] : []}
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

export const M2_T9_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-digest-hidden',
        title: 'test digest: 12 assertions, test code hidden, 2 discarded',
        render: () => <DigestState />,
    },
    {
        id: 'route-digest-shown',
        title: 'digest: test code expanded as real file cards',
        render: () => <DigestState stops={{ ...EMPTY_STOPS, testCode: new Set([DIGEST_STOP]) }} />,
    },
    {
        id: 'route-digest-viewed',
        title: 'digest viewed: collapsed into a summary row with assertions',
        render: () => <DigestState viewed />,
    },
    {
        id: 'route-digest-outside-stop',
        title: 'digest: nothing to hide, link row instead of a button',
        render: () => <DigestState snapshot={digestOutsideStopSnapshot()} />,
    },
];
