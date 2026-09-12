import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ROUTE_LONG_PATH_STATES } from './route-long-paths-states.tsx';

/** File chips with long paths (docs/design/SPEC-elements.md §1.2, §2.11). */

function markup(id: string): string {
    const state = ROUTE_LONG_PATH_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

/**
 * Path tooltips specifically from file chips: file cards on the right have the same paths in tooltips,
 * so searching for a `title="…"` substring alone would check the wrong element.
 */
function chipPathTitles(html: string): string[] {
    return [...html.matchAll(/<span\b[^>]*\bclass="route-chip__path"[^>]*>/g)]
        .map((tag) => /\btitle="([^"]*)"/.exec(tag[0])?.[1])
        .filter((title): title is string => title !== undefined);
}

describe('file chip gallery with long paths', () => {
    it('registers exactly the IDs specified in the task', () => {
        expect(ROUTE_LONG_PATH_STATES.map((state) => state.id)).toEqual([
            'route-chips-deep-path',
            'route-chips-long-name',
            'route-chips-mixed',
        ]);
    });

    it('keeps the full directory in the tooltip and the chip filename unchanged for a deep path', () => {
        const html = markup('route-chips-deep-path');

        expect(chipPathTitles(html)).toContain(
            'services/orders/src/infra/platform/time/providers/generated/v3/internal/adapters/legacy/system/clock.ts',
        );
        expect(html).toContain('<span class="route-chip__name">clock.ts</span>');
        expect(html).toContain(
            '<bdi>services/orders/src/infra/platform/time/providers/generated/v3/internal/adapters/legacy/system</bdi>',
        );
    });

    it('keeps the full filename in the chip when the name is long and the directory is short', () => {
        const html = markup('route-chips-long-name');

        expect(html).toContain(
            '<span class="route-chip__name">edit-window-expiration-policy-compatibility-adapter.factory.ts</span>',
        );
        expect(chipPathTitles(html)).toContain(
            'services/orders/src/domain/edit-window-expiration-policy-compatibility-adapter.factory.ts',
        );
    });

    it('shows long and regular paths together in a mixed stop without a "more N" expander', () => {
        const html = markup('route-chips-mixed');

        expect(chipPathTitles(html)).toContain(
            'services/orders/src/api/internal/generated/v3/handlers/compatibility/legacy/adapters/rest/handlers.ts',
        );
        expect(html).toContain('<span class="route-chip__name">handlers.ts</span>');
        // The regular path in the same stop stays as in the fixture.
        expect(chipPathTitles(html)).toContain('services/orders/src/api/schemas.ts');
        expect(html).not.toContain('route-chips__more');
    });
});
