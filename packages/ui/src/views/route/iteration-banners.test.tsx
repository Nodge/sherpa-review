import type { RouteCarried, RouteSnapshot, RouteStop, UiRouteStale } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
    NotesLostBanner,
    notesLostBannerVisible,
    notesLostKey,
    RouteSecondPassBanner,
    RouteStaleBanner,
    secondPassBannerVisible,
    staleBannerVisible,
} from './iteration-banners.tsx';

const ROUTE_COMMIT = '9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316';
const PR_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';

function stop(id: string, planIndex: number): RouteStop {
    return {
        id,
        planIndex,
        tier: 'medium',
        title: id,
        status: 'ready',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

const STOPS: readonly RouteStop[] = [stop('s02', 2), stop('s03', 3), stop('s07', 7)];

function stale(patch: Partial<UiRouteStale> = {}): UiRouteStale {
    return {
        routeCommit: ROUTE_COMMIT,
        prCommit: PR_COMMIT,
        prDiffId: '182801',
        newIterations: 2,
        affectedStopIds: ['s02', 's03', 's07'],
        ...patch,
    };
}

function snapshot(patch: Partial<RouteSnapshot> = {}): RouteSnapshot {
    return {
        snapshotId: 'route-medium-a71d4e2',
        commit: PR_COMMIT,
        baseCommit: ROUTE_COMMIT,
        diffId: '182801',
        createdAt: '2026-09-01T10:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'opus-5', locale: null },
        previousSnapshotId: 'route-medium-9f3c1ab',
        carried: { kept: 4, total: 7, zeroReason: null },
        summary: '',
        stops: [...STOPS],
        tourOrder: STOPS.map((item) => item.id),
        contentHash: 'hash',
        ...patch,
    };
}

describe('stale route banner', () => {
    it('names both commits, pluralizes iterations and lists affected stops', () => {
        const html = renderToStaticMarkup(
            <RouteStaleBanner stale={stale()} stops={STOPS} onRegenerate={() => undefined} />,
        );

        expect(html).toContain('The route was built for');
        expect(html).toContain(`title="${ROUTE_COMMIT}"`);
        expect(html).toContain('>9f3c1ab<');
        expect(html).toContain('>a71d4e2<');
        expect(html).toContain('2 new iterations');
        expect(html).toContain('stops 02, 03 and 07 are affected');
    });

    it('pluralizes the number of new iterations', () => {
        const text = (newIterations: number) =>
            renderToStaticMarkup(
                <RouteStaleBanner
                    stale={stale({ newIterations, affectedStopIds: [] })}
                    stops={STOPS}
                    onRegenerate={() => undefined}
                />,
            );

        expect(text(1)).toContain('1 new iteration');
        expect(text(5)).toContain('5 new iterations');
    });

    it('omits the affected-stops phrase when none are affected', () => {
        const html = renderToStaticMarkup(
            <RouteStaleBanner
                stale={stale({ affectedStopIds: [] })}
                stops={STOPS}
                onRegenerate={() => undefined}
            />,
        );

        expect(html).not.toContain('are affected');
        expect(html).toContain('Rebuild the route');
    });

    it('omits the secondary button without an iteration-switch callback', () => {
        const without = renderToStaticMarkup(
            <RouteStaleBanner stale={stale()} stops={STOPS} onRegenerate={() => undefined} />,
        );
        const withCallback = renderToStaticMarkup(
            <RouteStaleBanner
                stale={stale()}
                stops={STOPS}
                onRegenerate={() => undefined}
                onOpenDiffWithoutRoute={() => undefined}
            />,
        );

        expect(without).not.toContain('without a route');
        expect(withCallback).toContain('Open the a71d4e2 diff without a route');
    });
});

describe('second pass banner', () => {
    function secondPass(carried: RouteCarried | null, changedStops = 3): string {
        return renderToStaticMarkup(
            <RouteSecondPassBanner
                commit={PR_COMMIT}
                carried={carried}
                changedStops={changedStops}
                onShowNew={() => undefined}
                onDismiss={() => undefined}
            />,
        );
    }

    it('prints mark carryover counts and offers a filter', () => {
        const html = secondPass({ kept: 3, total: 6, zeroReason: null });

        expect(html).toContain('The route was rebuilt for');
        expect(html).toContain('3 of 6 stops stayed viewed.');
        expect(html).toContain('3 stops have changed; comments on changed ranges are pinned');
        expect(html).toContain('What is new since the last pass');
    });

    it('pluralizes both carried-over and changed stops', () => {
        expect(secondPass({ kept: 1, total: 6, zeroReason: null }, 1)).toContain(
            '1 of 6 stops stayed viewed.',
        );
        expect(secondPass({ kept: 1, total: 6, zeroReason: null }, 1)).toContain('1 stop has changed;');
        expect(secondPass({ kept: 5, total: 6, zeroReason: null }, 6)).toContain(
            '5 of 6 stops stayed viewed.',
        );
        expect(secondPass({ kept: 5, total: 6, zeroReason: null }, 6)).toContain('6 stops have changed;');
    });

    it('explains zero carryover without presenting it as an absence of changes', () => {
        expect(secondPass({ kept: 0, total: 6, zeroReason: 'no_marks' })).toContain(
            'There were no viewed marks from the previous pass — nothing to carry over.',
        );
        expect(secondPass({ kept: 0, total: 6, zeroReason: 'no_overlap' })).toContain(
            'There were viewed marks from the previous pass, but no stop stayed fully viewed.',
        );
        expect(secondPass({ kept: 0, total: 6, zeroReason: 'no_interdiff' })).toContain(
            'The viewed marks could not be carried over: the difference between the iterations could not be computed.',
        );
        // A snapshot without a reason reports only the count.
        expect(secondPass({ kept: 0, total: 6, zeroReason: null })).toContain(
            'None of the 6 stops stayed viewed.',
        );
    });

    it('omits the carryover sentence when there was nothing to carry over from', () => {
        const html = secondPass(null);

        expect(html).not.toContain('stayed viewed');
        expect(html).not.toContain('stayed');
        expect(html).toContain('3 stops have changed; comments on changed ranges are pinned');
    });

    it('omits the primary button when no stops changed and there is nothing to filter', () => {
        const html = secondPass({ kept: 6, total: 6, zeroReason: null }, 0);

        expect(html).toContain('No changes in the stops');
        expect(html).not.toContain('What is new since the last pass');
    });

    it('the close button calls dismiss and hides the banner for the dismissed snapshot', () => {
        const onDismiss = vi.fn();
        renderToStaticMarkup(
            <RouteSecondPassBanner
                commit={PR_COMMIT}
                carried={null}
                changedStops={3}
                onShowNew={() => undefined}
                onDismiss={onDismiss}
            />,
        );
        const current = snapshot();

        expect(secondPassBannerVisible('route', current, null, null)).toBe(true);
        expect(secondPassBannerVisible('route', current, null, current.snapshotId)).toBe(false);
        // Dismissing the previous snapshot does not hide the new one. A rebuilt route is news again.
        expect(secondPassBannerVisible('route', current, null, 'route-medium-9f3c1ab')).toBe(true);
    });

    it('shows no banner for the first snapshot or a stale route', () => {
        expect(secondPassBannerVisible('route', snapshot({ previousSnapshotId: null }), null, null)).toBe(false);
        expect(secondPassBannerVisible('route', snapshot(), stale(), null)).toBe(false);
        expect(secondPassBannerVisible('route', null, null, null)).toBe(false);
    });

    it('stays off other tabs because its action filters the route', () => {
        expect(secondPassBannerVisible('overview', snapshot(), null, null)).toBe(false);
        expect(secondPassBannerVisible('diff', snapshot(), null, null)).toBe(false);
    });
});

describe('stale banner visibility', () => {
    it('stays on every tab until the route is being rebuilt', () => {
        expect(staleBannerVisible('ready', stale(), snapshot())).toBe(true);
        expect(staleBannerVisible('failed', stale(), snapshot())).toBe(true);
        expect(staleBannerVisible('ready', null, snapshot())).toBe(false);
        expect(staleBannerVisible('ready', stale(), null)).toBe(false);
    });

    it('gives way to the rebuild and filling banners during rebuild phases', () => {
        expect(staleBannerVisible('reading', stale(), snapshot())).toBe(false);
        expect(staleBannerVisible('filling', stale(), snapshot())).toBe(false);
    });
});

describe('lost notes banner', () => {
    it('pluralizes the count and offers to show the first note', () => {
        const onShow = vi.fn();
        const html = renderToStaticMarkup(
            <NotesLostBanner count={2} onShow={onShow} onDismiss={() => undefined} />,
        );

        expect(html).toContain('2 notes lost their anchor after the new push');
        expect(html).toContain('View');
        expect(renderToStaticMarkup(<NotesLostBanner count={1} onShow={onShow} onDismiss={() => undefined} />))
            .toContain('1 note lost its anchor after the new push');
        expect(renderToStaticMarkup(<NotesLostBanner count={5} onShow={onShow} onDismiss={() => undefined} />))
            .toContain('5 notes lost their anchor after the new push');
    });

    it('stays until this exact set of notes is dismissed', () => {
        expect(notesLostBannerVisible('ready', [7, 3], null)).toBe(true);
        // The key ignores order: the same set keeps the banner dismissed.
        expect(notesLostBannerVisible('ready', [7, 3], notesLostKey([3, 7]))).toBe(false);
        // Another note lost its anchor. That is new, so the dismissed banner returns.
        expect(notesLostBannerVisible('ready', [7, 3, 9], notesLostKey([3, 7]))).toBe(true);
    });

    it('stays hidden without lost notes, in read-only mode and during rebuild phases', () => {
        expect(notesLostBannerVisible('ready', [], null)).toBe(false);
        expect(notesLostBannerVisible('ready', [7], null, true)).toBe(false);
        expect(notesLostBannerVisible('reading', [7], null)).toBe(false);
        expect(notesLostBannerVisible('filling', [7], null)).toBe(false);
    });

    it('allows phases without a route because notes exist without one', () => {
        expect(notesLostBannerVisible('none', [7], null)).toBe(true);
        expect(notesLostBannerVisible(null, [7], null)).toBe(true);
    });
});
