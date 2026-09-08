import { fixtureIteration } from '@sherpa/fixtures';
import type { UiGenerationCap } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import type { RoutePreset } from '../../session/session-store.js';
import { DEFAULT_THREADS_SHOW } from '../../session/session-store.js';
import { PRESET_DISABLED_TITLE, RouteToolbar, TOUR_HINT, TRIAGE_HINT } from './route-toolbar.tsx';
import { createT } from '../../i18n/index.js';

const t = createT('en');

/** Toolbar preset switch: active option, tooltip and disabled state (docs/design/SPEC-elements.md §2.5). */

const DATA = fixtureIteration('medium');

function render(options: { preset?: RoutePreset; disabled?: boolean; cap?: UiGenerationCap | null } = {}): string {
    const filters = buildFileFilters({
        files: DATA.diff.files,
        ownership: DATA.ownership,
        extra: DATA.extraLenses, t,});
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
            generationCap={options.cap ?? null}
        />,
    );
}

describe('route toolbar', () => {
    it('marks the active option with a class and aria-pressed and updates the tooltip with the preset', () => {
        const triage = render();
        const tour = render({ preset: 'tour' });

        expect(triage).toContain('class="route-preset__option is-active" aria-pressed="true"');
        expect(triage).toContain(t(TRIAGE_HINT));
        expect(tour).toContain(t(TOUR_HINT));
        expect(tour).toContain('aria-pressed="true">Full tour</button>');
        expect(tour).toContain('aria-pressed="false">Triage</button>');
    });

    it('shows the limit row only when the plan does not cover the full diff (docs/design/SPEC-elements.md §4.1)', () => {
        const capped = render({ cap: { filesCovered: 120, filesTotal: 500, machineFiles: 380, truncated: false } });

        expect(capped).toContain('route-toolbar__cap');
        expect(capped).toContain('the plan covers 120 of 500 files; 380 generated files are grouped in one stop');
        expect(render()).not.toContain('route-toolbar__cap');
        // The limit exists, but nothing was cut, so there is nothing to say.
        expect(
            render({ cap: { filesCovered: 18, filesTotal: 18, machineFiles: 0, truncated: false } }),
        ).not.toContain('route-toolbar__cap');
    });

    it('omits generated files from the row when there are none instead of printing zero', () => {
        // Large manual refactoring without generated files. The budget excluded ordinary files.
        const html = render({ cap: { filesCovered: 199, filesTotal: 200, machineFiles: 0, truncated: true } });

        expect(html).toContain('the plan covers 199 of 200 files');
        expect(html).not.toContain('generated');
    });

    it('disables both options and explains why when there is no route', () => {
        const html = render({ disabled: true });

        expect(html).toContain(`disabled="" title="${t(PRESET_DISABLED_TITLE)}"`);
        expect(count(html, t(PRESET_DISABLED_TITLE))).toBe(2);
        // The active option stays visible. The switch is disabled, the state remains.
        expect(html).toContain('class="route-preset__option is-active" aria-pressed="true" disabled=""');
        expect(render()).not.toContain(t(PRESET_DISABLED_TITLE));
    });
});

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
