import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * File chips with long paths (docs/design/SPEC-elements.md §1.2, §2.11): directories truncate from the left,
 * and the filename stays whole as long as it fits. Paths are rewritten here in the gallery: the
 * `medium` fixture has no such paths, and changing it for one screen is not an option.
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

/** A deep directory with a short filename: stop 01. */
const DEEP_DIRS: Readonly<Record<string, string>> = {
    'services/orders/src/domain/edit-window.ts':
        'services/orders/src/domain/scheduling/windows/expiration/adapters/legacy/internal/compat/rules/edit-window.ts',
    'services/orders/src/infra/clock.ts':
        'services/orders/src/infra/platform/time/providers/generated/v3/internal/adapters/legacy/system/clock.ts',
};

/** The filename itself is longer than the chip: stop 01. */
const LONG_NAMES: Readonly<Record<string, string>> = {
    'services/orders/src/domain/edit-window.ts':
        'services/orders/src/domain/edit-window-expiration-policy-compatibility-adapter.factory.ts',
    'services/orders/src/infra/clock.ts':
        'services/orders/src/infra/monotonic-clock-with-timezone-drift-compensation.provider.ts',
};

/** Long and regular paths mixed together: stop 03 (seven files, no "more N" expander). */
const MIXED: Readonly<Record<string, string>> = {
    'services/orders/src/api/handlers.ts':
        'services/orders/src/api/internal/generated/v3/handlers/compatibility/legacy/adapters/rest/handlers.ts',
    'services/orders/src/payments/pci-audit.ts':
        'services/orders/src/payments/audit/pci/scopes/generated/v2/internal/handlers/compliance/v1/pci-audit.ts',
    'services/orders/src/payments/generated/psp-schema.ts':
        'services/orders/src/payments/generated/psp-schema-payment-service-provider-compatibility.contract.ts',
};

/**
 * Rewrites diff paths and the paths of the same files in stop anchors. `fileId` stays the same:
 * the stop uses it to group files (`route-model.ts`), and takes the path from the diff file.
 */
function rewrite(paths: Readonly<Record<string, string>>): {
    diff: typeof DATA.diff;
    snapshot: RouteSnapshot;
} {
    const diff = {
        ...DATA.diff,
        files: DATA.diff.files.map((file) => {
            const path = paths[file.path];
            return path === undefined ? file : { ...file, path };
        }),
    };
    const source = readySnapshot();
    const snapshot: RouteSnapshot = {
        ...source,
        stops: source.stops.map((stop) => ({
            ...stop,
            anchors: stop.anchors.map((anchor) => {
                const path = paths[anchor.path];
                return path === undefined ? anchor : { ...anchor, path };
            }),
        })),
    };
    return { diff, snapshot };
}

function LongPathState({ paths }: { paths: Readonly<Record<string, string>> }) {
    const { diff, snapshot } = useMemo(() => rewrite(paths), [paths]);
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter: 'all', stops: EMPTY_STOPS } }),
        [],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: diff.files });
        for (const file of diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [diff]);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(diff.files.map((file) => file.fileId))),
        [diff],
    );

    return (
        <div className="gallery__viewport">
            <RouteWorkspace
                pr={DATA.pr}
                diff={diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                initialKeptStopId={null}
                initialStopViewed={[]}
                onUnderExplained={() => {
                    // Hide the regeneration banner in these states: they show chip geometry.
                }}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
                onSetStopFileViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

export const ROUTE_LONG_PATH_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-chips-deep-path',
        title: 'file chips: deep path, full filename',
        render: () => <LongPathState paths={DEEP_DIRS} />,
    },
    {
        id: 'route-chips-long-name',
        title: 'file chips: name longer than the chip, directory disappears and name truncates',
        render: () => <LongPathState paths={LONG_NAMES} />,
    },
    {
        id: 'route-chips-mixed',
        title: 'file chips: stop 03 with long and regular paths mixed together',
        render: () => <LongPathState paths={MIXED} />,
    },
];
