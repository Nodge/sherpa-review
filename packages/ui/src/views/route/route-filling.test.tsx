import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteReadingView } from './route-generating.tsx';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * Route during generation (docs/design/README.md §8): all plan slots remain, unfilled slots show
 * their number, title and a shimmer skeleton instead of a diff. The coverage bar waits for the plan.
 */

const DATA = fixtureIteration('medium');
const FILLING: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.filling?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a partially filled snapshot');
    }
    return snapshot;
})();
const READY: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready snapshot');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

function render(options: { snapshot?: RouteSnapshot; agentStopped?: boolean } = {}): string {
    const store = createDiffViewStore({ files: DATA.diff.files });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    return renderToStaticMarkup(
        <RouteWorkspace
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
            snapshot={options.snapshot ?? FILLING}
            agentStopped={options.agentStopped ?? false}
            session={createSessionStore({ initial: { view: 'route', filter: 'all' } })}
            store={store}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
            loadContent={() => Promise.resolve(null)}
            onSetViewed={() => Promise.resolve(0)}
            onSetStopViewed={() => Promise.resolve(0)}
            onSetStopFileViewed={() => Promise.resolve(0)}
        />,
    );
}

function order(html: string): string[] {
    return [...html.matchAll(/data-stop="([^"]+)"/g)].map((match) => match[1] ?? '');
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}

describe('route during filling', () => {
    it('keeps all plan slots in plan order: Other is not promoted until ready', () => {
        const html = render();

        expect(order(html)).toEqual(['s01', 's02', 's03', 's04', 's05', 's06', 'other']);
        expect(html).toContain('01 / 7');
        expect(html).toContain('03 / 7');
    });

    it('an unfilled slot shows a badge, an explanation and a skeleton instead of a diff', () => {
        const html = render();

        // s03 and s04 are queued, s06 is being filled. Three skeletons, three muted slots.
        expect(count(html, 'route-skeleton-card"')).toBe(3);
        expect(count(html, 'route-stop--unfilled')).toBe(3);
        expect(html).toContain('queued');
        expect(html).toContain('filling');
        expect(html).toContain('The agent has not filled this stop yet — it will land in this slot.');
        expect(html).not.toContain('No hunks');
    });

    it('cannot mark an unfilled stop viewed because it has no ranges', () => {
        const html = render();

        expect(html).toContain('title="This stop is not filled yet"');
        expect(count(html, 'disabled=""')).toBeGreaterThan(0);
    });

    it('the coverage bar waits for the plan and counts ready slots, not diff files', () => {
        const html = render();

        expect(html).toContain('coverage known after the plan');
        expect(html).not.toContain('counting coverage over the diff');
        expect(html).not.toContain('% explained');
    });

    it('does not present "Other" on an unfinished route as the model\'s decision', () => {
        const html = render();

        expect(html).toContain('The route is still filling. For now, everything the agent has not reached goes here.');
        expect(html).toContain('Waiting for the route to fill');
        expect(html).not.toContain('The model did not place these ranges');
    });

    it('marks filled slots when the agent dies during generation, leaving unfilled slots unmarked (docs/design/SPEC-elements.md §4.4)', () => {
        const stopped = render({ agentStopped: true });

        // Only ready slots get the mark: s01, s02, s05.
        expect(count(stopped, 'filled before the agent stopped')).toBe(3);
        expect(render()).not.toContain('filled before the agent stopped');
    });

    it('a ready route shows neither skeletons nor plan loading', () => {
        const html = render({ snapshot: READY });

        expect(html).not.toContain('route-skeleton-card');
        expect(html).not.toContain('coverage known after the plan');
        expect(html).toContain('% explained');
    });
});

describe('route during reading', () => {
    it('shows three unnumbered placeholders and a bar without numbers', () => {
        const html = renderToStaticMarkup(<RouteReadingView onOpenDiff={() => undefined} />);

        expect(count(html, '— / ?')).toBe(3);
        expect(count(html, 'route-skeleton-card"')).toBe(3);
        expect(html).toContain('coverage known after the plan');
        expect(html).not.toContain('viewed');
        expect(html).toContain('Read the full diff');
    });
});
