import { describe, expect, it } from 'vitest';

import type { BannerSource } from './banner-slot.tsx';
import { selectBanners } from './banner-slot.tsx';

function source(id: string, priority: number, active = true): BannerSource {
    return { id, priority, active: () => active, render: () => id };
}

describe('banner slot', () => {
    it('selects the active banner with the highest priority and leaves the others collapsed', () => {
        const selection = selectBanners([
            source('audit-scope', 100),
            source('route-stale', 200, false),
            source('agent-disconnected', 300),
        ]);

        expect(selection.primary?.id).toBe('agent-disconnected');
        expect(selection.hidden.map((item) => item.id)).toEqual(['audit-scope']);
    });

    it('excludes sources whose condition no longer holds', () => {
        const selection = selectBanners([
            source('agent-disconnected', 300, false),
            source('audit-scope', 100),
        ]);

        expect(selection.primary?.id).toBe('audit-scope');
        expect(selection.hidden).toEqual([]);
    });
});
