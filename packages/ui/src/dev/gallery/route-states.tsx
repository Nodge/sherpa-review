import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RegenerateBanner } from '../../views/route/other-card.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';

/**
 * Route view states form the second layer of visual acceptance. Everything is calculated from fixtures
 * synchronously: diff models are parsed locally, there are no endpoints, and the clock is frozen. Opening a state
 * always gives the same frame.
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

interface RouteStateProps {
    readonly snapshot?: RouteSnapshot;
    readonly filter?: string;
    readonly stops?: StopsState;
    /** Stop marks: the server supplies them in the app, a prop supplies them in the gallery. */
    readonly stopViewed?: readonly string[];
    readonly keptStopId?: string | null;
}

function RouteState({
    snapshot = readySnapshot(),
    filter = 'all',
    stops = EMPTY_STOPS,
    stopViewed = [],
    keptStopId = null,
}: RouteStateProps) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter, stops } }),
        [filter, stops],
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
    const [underExplained, setUnderExplained] = useState(false);
    const banners = useMemo<BannerSource[]>(
        () => [
            {
                id: 'route-under-explained',
                priority: 200,
                active: () => underExplained,
                render: () => <RegenerateBanner onGenerate={() => undefined} />,
            },
        ],
        [underExplained],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                initialKeptStopId={keptStopId}
                initialStopViewed={stopViewed}
                onUnderExplained={setUnderExplained}
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

/**
 * A snapshot with reduced anchors: over 40% is uncovered, and "Other" becomes a separate
 * stop (docs/design/SPEC-elements.md §4.3).
 */
function underExplainedSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
        ),
    };
}

/** The first stop anchors moved to a file absent from the diff: drift (docs/design/SPEC-elements.md §2.9). */
function driftedSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's01'
                ? { ...stop, anchors: stop.anchors.map((anchor) => ({ ...anchor, fileId: 'removed-file' })) }
                : stop,
        ),
    };
}

/** Some stop anchors moved: a notice appears above the remaining cards (docs/design/SPEC-elements.md §2.9). */
function partialDriftSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's03'
                ? {
                      ...stop,
                      anchors: stop.anchors.map((anchor, index) =>
                          index === 0 ? { ...anchor, fileId: 'removed-file' } : anchor,
                      ),
                  }
                : stop,
        ),
    };
}

/**
 * A stop taller than the viewport: a long description and all route files in one stop. The pinned
 * column must scroll independently without scrolling the page.
 */
function tallStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    const anchors = snapshot.stops.flatMap((stop) => stop.anchors);
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) =>
            stop.id === 's01' ? { ...stop, paragraph: TALL_PARAGRAPH, anchors } : stop,
        ),
    };
}

/** A description near the validator budget limit: the reviewer sees this much text in full. */
const TALL_PARAGRAPH = [
    'The `EditWindow` class and injectable `Clock` time source were added: the window opens when an order is placed, closes after `EDIT_WINDOW_MS`, and closes early when the courier dispatches it.',
    '',
    'Categories shorten the window:',
    '- fresh food: 10 minutes',
    '- pharmacy: 5 minutes',
    '- alcohol: no window at all',
    '- everything else: the standard 30 minutes',
    '',
    'The **shortest** window wins in the cart, and whether an order can still be edited is calculated in exactly one place: tests replace the clock with [`FrozenClock`](#file-services/orders/src/infra/clock.ts), while production uses the system clock.',
    '',
    'As a consequence, [stop 02](#stop-2) explains the rejection codes, [#2281](https://github.com/quillmart/quillmart/issues/2281) describes the rollout order, and nothing reads the old `checkout.edit_window_hours` config anymore.',
].join('\n');

/** A stop without any anchors: the right column must show a dashed card instead of empty space. */
function emptyStopSnapshot(): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        stops: snapshot.stops.map((stop) => (stop.id === 's02' ? { ...stop, anchors: [] } : stop)),
    };
}

function stopsState(patch: Partial<StopsState>): StopsState {
    return { ...EMPTY_STOPS, ...patch };
}

export interface RouteGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const ROUTE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-triage',
        title: 'full triage: 7 fixture stops',
        render: () => <RouteState />,
    },
    {
        id: 'route-viewed',
        title: 'stop viewed: title and paragraph dimmed, hunks collapsed',
        render: () => <RouteState stopViewed={['s01']} />,
    },
    {
        id: 'route-low-expanded',
        title: 'low stop expanded by hand (the adjacent stop stays collapsed)',
        render: () => <RouteState stops={stopsState({ expanded: new Set(['s05']) })} />,
    },
    {
        id: 'route-other-promoted',
        title: '"Other" moved above low + regeneration banner',
        render: () => <RouteState snapshot={underExplainedSnapshot()} />,
    },
    {
        id: 'route-drift',
        title: 'anchor drift: stop points to lines outside the diff',
        render: () => <RouteState snapshot={driftedSnapshot()} />,
    },
    {
        id: 'route-drift-partial',
        title: 'partial drift: notice above the remaining stop cards',
        render: () => <RouteState snapshot={partialDriftSnapshot()} />,
    },
    {
        id: 'route-empty-stop',
        title: 'stop without hunks: dashed card instead of empty space',
        render: () => <RouteState snapshot={emptyStopSnapshot()} />,
    },
    {
        id: 'route-stop-markup',
        title: 'stop description with markup: paragraphs, list, code, links (03 viewed)',
        render: () => <RouteState stopViewed={['s03']} />,
    },
    {
        id: 'route-stop-tall-side',
        title: 'stop with a long description and 12+ files: column scrolls independently',
        render: () => <RouteState snapshot={tallStopSnapshot()} />,
    },
    {
        id: 'route-filter-kept',
        title: 'PCI DSS filter: stop kept on screen with a label',
        render: () => <RouteState filter="pci" keptStopId="s01" />,
    },
];
