// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { DEFAULT_THREADS_SHOW } from '../session/session-store.js';
import { ToolbarRightCluster } from './toolbar-controls.tsx';
import { createT } from '../i18n/index.js';

const t = createT('en');

const DATA = fixtureIteration('medium');

describe('right-hand toolbar controls', () => {
    it('fixes the shared contents and order for the route and full diff', () => {
        const filters = buildFileFilters({
            files: DATA.diff.files,
            ownership: DATA.ownership,
            extra: DATA.extraLenses, t,});
        const html = renderToStaticMarkup(
            <ToolbarRightCluster
                store={createDiffViewStore({ files: DATA.diff.files })}
                filters={filters}
                filter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                threadsShow={DEFAULT_THREADS_SHOW}
                threadCounts={{ people: 3, bots: 2, resolved: 1 }}
                onThreadsShow={() => undefined}
            />,
        );
        const host = document.createElement('div');
        host.innerHTML = html;
        const cluster = host.querySelector('.toolbar-right-cluster');
        if (cluster === null) {
            throw new Error('shared right-hand controls did not render');
        }

        expect([...cluster.children].map((element) => element.className)).toEqual([
            'diff-mode-toggle',
            'filter-select',
            'toolbar-right-cluster__divider',
            'toolbar-right-cluster__label',
            'thread-chips',
        ]);
        expect(cluster.querySelector('.toolbar-right-cluster__divider')?.getAttribute('aria-hidden')).toBe('true');
        expect(cluster.querySelector('.toolbar-right-cluster__label')?.textContent).toBe('Comments:');
    });
});
