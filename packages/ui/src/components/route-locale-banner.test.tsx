import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiRouteState } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider, ru } from '../i18n/index.js';
import { RouteLocaleBanner, routeLocaleBannerVisible } from './route-locale-banner.tsx';

/** Route language: conditions for showing the banner and its button. */

function snapshot(): RouteSnapshot {
    const ready = routeFixtures('medium')?.states.ready?.snapshot;
    if (ready === undefined || ready === null) {
        throw new Error('the medium fixture needs a ready snapshot');
    }
    return ready;
}

function routeWith(overrides: Partial<UiRouteState> = {}, locale: 'ru' | 'en' | null = null): UiRouteState {
    const ready = snapshot();
    return {
        phase: 'ready',
        smallPr: false,
        stale: null,
        failure: null,
        snapshot: { ...ready, provenance: { ...ready.provenance, locale } },
        ...overrides,
    };
}

function markup(node: Parameters<typeof renderToStaticMarkup>[0], locale: 'ru' | 'en'): string {
    return renderToStaticMarkup(<LocaleProvider locale={locale}>{node}</LocaleProvider>);
}

describe('route language banner visibility', () => {
    it('appears when the snapshot language differs from the tab language', () => {
        expect(
            routeLocaleBannerVisible({
                route: routeWith({}, 'en'),
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(true);
    });

    it('treats a snapshot without a language (`locale: null`) as English', () => {
        const route = routeWith({}, null);
        const args = { generating: false, keptSnapshotId: null, readOnly: false };
        expect(routeLocaleBannerVisible({ route, uiLocale: 'en', ...args })).toBe(false);
        expect(routeLocaleBannerVisible({ route, uiLocale: 'ru', ...args })).toBe(true);
    });

    it('stays hidden for matching languages, during generation and without a snapshot', () => {
        expect(
            routeLocaleBannerVisible({
                route: routeWith({}, 'en'),
                uiLocale: 'en',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route: routeWith({}, 'en'),
                uiLocale: 'ru',
                generating: true,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null },
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route: null,
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
    });

    it('also appears during filling because the route can already be read', () => {
        expect(
            routeLocaleBannerVisible({
                route: routeWith({ phase: 'filling' }, 'en'),
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(true);
        expect(
            routeLocaleBannerVisible({
                route: routeWith({ phase: 'reading' }, 'en'),
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: false,
            }),
        ).toBe(false);
    });

    it('stays hidden for previous iterations because Rebuild does not rebuild them', () => {
        const route = routeWith({}, 'en');
        expect(
            routeLocaleBannerVisible({
                route,
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: null,
                readOnly: true,
            }),
        ).toBe(false);
    });

    it('ties Keep to the snapshot id and asks again for a new snapshot', () => {
        const route = routeWith({}, 'en');
        const id = route.snapshot?.snapshotId ?? '';
        expect(
            routeLocaleBannerVisible({ route, uiLocale: 'ru', generating: false, keptSnapshotId: id, readOnly: false }),
        ).toBe(false);
        expect(
            routeLocaleBannerVisible({
                route,
                uiLocale: 'ru',
                generating: false,
                keptSnapshotId: 'another-snapshot',
                readOnly: false,
            }),
        ).toBe(true);
    });
});

describe('route language banner', () => {
    it('names both languages and offers to rebuild in the tab language', () => {
        const html = markup(
            <RouteLocaleBanner routeLocale="en" onRebuild={() => undefined} onKeep={() => undefined} />,
            'ru',
        );

        expect(html).toContain(ru['route.locale.banner.title'](ru['route.locale.on.en'], ru['route.locale.on.ru']));
        expect(html).toContain(ru['route.locale.rebuild'](ru['route.locale.on.ru']));
        expect(html).toContain(ru['route.locale.keep']);
        expect(html).not.toContain('disabled');
    });

    it('speaks English in an English tab', () => {
        const html = markup(
            <RouteLocaleBanner routeLocale="ru" onRebuild={() => undefined} onKeep={() => undefined} />,
            'en',
        );

        expect(html).toContain('The route was built in Russian — rebuild it in English?');
        expect(html).toContain('Rebuild in English');
        expect(html).toContain('Keep it');
    });

    it('disables unavailable rebuilding and explains the reason in the title', () => {
        const html = markup(
            <RouteLocaleBanner
                routeLocale="en"
                rebuildDisabledReason="The route cannot be rebuilt while it is being filled."
                onRebuild={() => undefined}
                onKeep={() => undefined}
            />,
            'ru',
        );

        expect(html).toContain('disabled=""');
        expect(html).toContain('title="The route cannot be rebuilt while it is being filled."');
    });
});
