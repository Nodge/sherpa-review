import type { Locale, UiRouteState } from '@sherpa/protocol';

import { useLocale, useT } from '../i18n/index.js';
import { localeOnKey, snapshotLocale } from '../route/generation.js';
import './route-locale-banner.css';

/**
 * "The route was built in English. Rebuild in Russian?"
 *
 * There is no automatic rebuild: the route takes minutes of agent work, so a language switch
 * must not change it silently. The banner has low priority because this is background news and the old route remains readable.
 * Keep lives in tab memory and is tied to the snapshot id: a new route in a different language
 * asks again.
 */

/**
 * Visibility condition. A ready or filling snapshot whose language differs from the tab language,
 * while no generation is running and the reviewer has not chosen Keep for this same snapshot.
 *
 * The banner is hidden when viewing a previous iteration: Rebuild is a global endpoint that builds the route
 * for the current iteration, not the snapshot whose language the banner asks about.
 */
export function routeLocaleBannerVisible({
    route,
    uiLocale,
    generating,
    keptSnapshotId,
    readOnly,
}: {
    readonly route: UiRouteState | null;
    readonly uiLocale: Locale;
    readonly generating: boolean;
    /** Snapshot for which Keep was already clicked. null means it has not been clicked. */
    readonly keptSnapshotId: string | null;
    /** The tab is viewing a previous iteration. */
    readonly readOnly: boolean;
}): boolean {
    const snapshot = route?.snapshot ?? null;
    if (snapshot === null || generating || readOnly) {
        return false;
    }
    if (route?.phase !== 'ready' && route?.phase !== 'filling') {
        return false;
    }
    return snapshotLocale(snapshot.provenance) !== uiLocale && keptSnapshotId !== snapshot.snapshotId;
}

export interface RouteLocaleBannerProps {
    /** Language the route was built in. */
    readonly routeLocale: Locale;
    /** Rebuild unavailable (generation running, small PR, no host). The button is disabled with a reason. */
    readonly rebuildDisabledReason?: string;
    readonly onRebuild: () => void;
    readonly onKeep: () => void;
}

export function RouteLocaleBanner({
    routeLocale,
    rebuildDisabledReason,
    onRebuild,
    onKeep,
}: RouteLocaleBannerProps) {
    const t = useT();
    const uiLocale = useLocale();
    const disabled = rebuildDisabledReason !== undefined;
    return (
        <div className="route-locale-banner" role="status" aria-label={t('route.locale.banner.aria')}>
            <span className="route-locale-banner__text">
                {t('route.locale.banner.title', t(localeOnKey(routeLocale)), t(localeOnKey(uiLocale)))}
            </span>
            <button
                type="button"
                className="route-locale-banner__action"
                disabled={disabled}
                {...(disabled ? { title: rebuildDisabledReason } : {})}
                onClick={onRebuild}
            >
                {t('route.locale.rebuild', t(localeOnKey(uiLocale)))}
            </button>
            <button type="button" className="route-locale-banner__secondary" onClick={onKeep}>
                {t('route.locale.keep')}
            </button>
        </div>
    );
}
