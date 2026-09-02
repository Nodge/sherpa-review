import { fixtureData } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import type { RoutePreset } from '../../session/session-store.js';
import { DEFAULT_THREADS_SHOW } from '../../session/session-store.js';
import { PRESET_DISABLED_TITLE, RouteToolbar, TOUR_HINT, TRIAGE_HINT } from './route-toolbar.tsx';

/** Toolbar preset toggle: active option, hint and disabled state (SPEC §2.5). */

const DATA = fixtureData('medium');

function render(options: { preset?: RoutePreset; disabled?: boolean } = {}): string {
    const filters = buildFileFilters({
        files: DATA.diff.files,
        ownership: DATA.ownership,
        extra: DATA.extraLenses,
    });
    return renderToStaticMarkup(
        <RouteToolbar
            store={createDiffViewStore({ files: DATA.diff.files })}
            preset={options.preset ?? 'triage'}
            onPreset={() => undefined}
            presetDisabled={options.disabled ?? false}
            filters={filters}
            filter={selectFilter(filters, 'all')}
            onFilter={() => undefined}
            threadsShow={DEFAULT_THREADS_SHOW}
            threadCounts={{ people: 0, bots: 0, resolved: 0 }}
            onThreadsShow={() => undefined}
            strip={null}
        />,
    );
}

describe('route toolbar', () => {
    it('marks the active option with a class and aria-pressed and updates the tooltip with the preset', () => {
        const triage = render();
        const tour = render({ preset: 'tour' });

        expect(triage).toContain('class="route-preset__option is-active" aria-pressed="true"');
        expect(triage).toContain(TRIAGE_HINT);
        expect(tour).toContain(TOUR_HINT);
        expect(tour).toContain('aria-pressed="true">Full tour</button>');
        expect(tour).toContain('aria-pressed="false">Triage</button>');
    });

    it('disables both options and explains why when there is no route', () => {
        const html = render({ disabled: true });

        expect(html).toContain(`disabled="" title="${PRESET_DISABLED_TITLE}"`);
        expect(count(html, PRESET_DISABLED_TITLE)).toBe(2);
        // The active option stays visible. The switch is disabled, the state remains.
        expect(html).toContain('class="route-preset__option is-active" aria-pressed="true" disabled=""');
        expect(render()).not.toContain(PRESET_DISABLED_TITLE);
    });
});

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
