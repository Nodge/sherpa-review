import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { useT } from '../i18n/index.js';
import './banner-slot.css';

/**
 * Slot priority order (SPEC §2.21): generation failure → failed route action →
 * rebuild → stale route → read-only mode for a previous iteration → second pass →
 * under-explained route → route filling → notes without anchors → audit scope. Numbers live
 * here instead of being scattered across source declarations. Their order is a product decision.
 *
 * Failure of the button just clicked sits immediately below generation failure. The reviewer is waiting
 * for the result of their action, but a failed generation is more significant.
 *
 * "Route is stale" sits below rebuild. While a new route is being built, the old route's age is
 * no longer news. The second-pass banner sits lower because it describes a filter, not a condition.
 *
 * Agent disconnection is absent here. Its status lives in the pill, with an explanation in its popover (decision #32).
 */
export const BANNER_PRIORITY = {
    generationFailed: 400,
    routeActionError: 350,
    routeRegenerating: 300,
    routeStale: 250,
    readOnlyIteration: 240,
    routeSecondPass: 220,
    routeUnderExplained: 200,
    routeFilling: 150,
    notesLost: 120,
    auditScope: 100,
} as const;

export interface BannerSource {
    readonly id: string;
    readonly priority: number;
    readonly active: () => boolean;
    readonly render: () => ReactNode;
}

export interface BannerSelection {
    readonly primary: BannerSource | null;
    readonly hidden: readonly BannerSource[];
}

/** Active sources in product priority order, independent of conditional order in App. */
export function selectBanners(sources: readonly BannerSource[]): BannerSelection {
    const active = sources.filter((source) => source.active()).toSorted((left, right) => right.priority - left.priority);
    return { primary: active[0] ?? null, hidden: active.slice(1) };
}

export function BannerSlot({ sources }: { sources: readonly BannerSource[] }) {
    const t = useT();
    const selection = useMemo(() => selectBanners(sources), [sources]);
    const active = selection.primary === null ? [] : [selection.primary, ...selection.hidden];
    const activeKey = active.map((source) => source.id).join('\u0000');
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const expanded = expandedKey === activeKey;

    const primary = active[0];
    if (primary === undefined) {
        return null;
    }
    const hidden = active.slice(1);

    return (
        <section className="banner-slot" aria-label={t('banner.slot')}>
            <div className="banner-slot__item">{primary.render()}</div>
            {hidden.length === 0 ? null : (
                <>
                    <button
                        type="button"
                        className="banner-slot__more"
                        aria-expanded={expanded}
                        onClick={() => {
                            setExpandedKey(expanded ? null : activeKey);
                        }}
                    >
                        {t('banner.slot.more', hidden.length)}
                    </button>
                    {expanded
                        ? hidden.map((source) => (
                              <div key={source.id} className="banner-slot__item banner-slot__item--secondary">
                                  {source.render()}
                              </div>
                          ))
                        : null}
                </>
            )}
        </section>
    );
}
