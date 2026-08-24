import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { plural } from '../text.js';
import './banner-slot.css';

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
        <section className="banner-slot" aria-label="Review status notices">
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
                        +{hidden.length} {plural(hidden.length, 'notice', 'notices', 'notices')}
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
