import { describe, expect, it } from 'vitest';

import type { BannerSource } from './banner-slot.tsx';
import { BANNER_PRIORITY, selectBanners } from './banner-slot.tsx';

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

    it('full SPEC §2.21 priority order: failure → action failure → disconnected → under-explained → filling → audit', () => {
        const selection = selectBanners([
            source('audit-scope', BANNER_PRIORITY.auditScope),
            source('route-filling', BANNER_PRIORITY.routeFilling),
            source('route-under-explained', BANNER_PRIORITY.routeUnderExplained),
            source('agent-disconnected', BANNER_PRIORITY.agentDisconnected),
            source('route-action-error', BANNER_PRIORITY.routeActionError),
            source('generation-failed', BANNER_PRIORITY.generationFailed),
        ]);

        expect([selection.primary?.id, ...selection.hidden.map((item) => item.id)]).toEqual([
            'generation-failed',
            'route-action-error',
            'agent-disconnected',
            'route-under-explained',
            'route-filling',
            'audit-scope',
        ]);
    });

    it('shows the action reason at the top of the slot when an endpoint fails with a live agent', () => {
        const selection = selectBanners([
            source('audit-scope', BANNER_PRIORITY.auditScope),
            source('route-action-error', BANNER_PRIORITY.routeActionError),
            source('generation-failed', BANNER_PRIORITY.generationFailed, false),
        ]);

        expect(selection.primary?.id).toBe('route-action-error');
    });

    it('agent dies during generation: disconnection goes on top, filling moves to collapsed banners', () => {
        const selection = selectBanners([
            source('route-filling', BANNER_PRIORITY.routeFilling),
            source('agent-disconnected', BANNER_PRIORITY.agentDisconnected),
            source('generation-failed', BANNER_PRIORITY.generationFailed, false),
        ]);

        expect(selection.primary?.id).toBe('agent-disconnected');
        expect(selection.hidden.map((item) => item.id)).toEqual(['route-filling']);
    });
});
