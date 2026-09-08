import { routeFixtures } from '@sherpa/fixtures';
import type { Locale, RouteSnapshot } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { RouteLocaleBanner } from '../../components/route-locale-banner.tsx';
import { LocaleProvider, useLocale, useT } from '../../i18n/index.js';
import { provenanceLine, snapshotLocale } from '../../route/generation.js';

/**
 * Generation language: a provenance indicator with the route language and a rebuild banner.
 * Data comes from the `medium` fixture with a replaced `provenance.locale`. There is no server in the gallery.
 */

function snapshotWith(locale: Locale | null): RouteSnapshot {
    const ready = routeFixtures('medium')?.states.ready?.snapshot;
    if (ready === undefined || ready === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return { ...ready, provenance: { ...ready.provenance, locale } };
}

/** The provenance indicator next to the banner, exactly as the reviewer sees them on Overview. */
function LocaleState({
    snapshot,
    rebuildDisabledReason,
}: {
    readonly snapshot: RouteSnapshot;
    readonly rebuildDisabledReason?: string;
}) {
    const t = useT();
    const uiLocale = useLocale();
    return (
        <div className="route-locale-stack">
            <p className="summary-card__provenance">{provenanceLine(snapshot, t, uiLocale)}</p>
            <RouteLocaleBanner
                routeLocale={snapshotLocale(snapshot.provenance)}
                {...(rebuildDisabledReason === undefined ? {} : { rebuildDisabledReason })}
                onRebuild={() => undefined}
                onKeep={() => undefined}
            />
        </div>
    );
}

function Localized({ locale, children }: { readonly locale: Locale; readonly children: ReactNode }) {
    return <LocaleProvider locale={locale}>{children}</LocaleProvider>;
}

export const ROUTE_LOCALE_STATES: readonly { readonly id: string; readonly title: string; readonly render: () => ReactNode }[] =
    [
        {
            id: 'route-locale-en-route-ru-ui',
            title: 'English route on a Russian tab',
            render: () => (
                <Localized locale="ru">
                    <LocaleState snapshot={snapshotWith('en')} />
                </Localized>
            ),
        },
        {
            id: 'route-locale-rebuild-unavailable',
            title: 'rebuild unavailable',
            render: () => (
                <Localized locale="ru">
                    <LocaleState
                        snapshot={snapshotWith('en')}
                        rebuildDisabledReason="The route cannot be rebuilt while it is still being filled."
                    />
                </Localized>
            ),
        },
        {
            id: 'route-locale-legacy-snapshot-ru-ui',
            title: 'snapshot without a language on a Russian tab',
            render: () => (
                <Localized locale="ru">
                    <LocaleState snapshot={snapshotWith(null)} />
                </Localized>
            ),
        },
    ];
