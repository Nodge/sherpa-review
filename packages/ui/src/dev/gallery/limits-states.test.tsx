import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LIMIT_STATES } from './limits-states.tsx';

// The tree virtualizer measures layout, which static rendering lacks. Without a mock there are no rows.
vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 26,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 26,
                size: 26,
                end: (index + 1) * 26,
                lane: 0,
            })),
        scrollToIndex: () => undefined,
    }),
}));

function markup(id: string): string {
    const state = LIMIT_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('limits and reduced functionality gallery', () => {
    it('registers exactly the ids declared in the file', () => {
        expect(LIMIT_STATES.map((state) => state.id)).toEqual([
            'conflict-file-card',
            'conflict-file-tree',
            'conflict-stop-notice',
            'conflict-other-card',
            'generation-cap-toolbar',
            'generation-cap-banner',
            'empty-pr-full-diff',
            'empty-pr-overview',
        ]);
    });

    it('a conflicted file card has a badge, a regular one does not', () => {
        const html = markup('conflict-file-card');

        expect(html).toContain('file-card__badge--conflict');
        expect(html).toContain('>conflict</span>');
        expect(html).toContain('services/orders/src/domain/order.ts');
    });

    it('the tree marks the conflict with its own tag exactly once', () => {
        const html = markup('conflict-file-tree');
        const tags = html.split('file-tree__tag--conflict').length - 1;

        expect(tags).toBe(1);
    });

    it('a stop on a conflicted file links to the host rather than regeneration', () => {
        const html = markup('conflict-stop-notice');

        expect(html).toContain('route-conflicts');
        expect(html).toContain('merge conflicts: resolve it outside Sherpa');
        expect(html).not.toContain('no longer in the diff');
    });

    it('Other with only conflicts shows no zero counts or buttons', () => {
        const html = markup('conflict-other-card');

        expect(html).toContain('Not a single changed line was left without a stop');
        expect(html).toContain('2 files have conflicts');
        expect(html).not.toContain('route-other__actions');
        expect(html).not.toContain('Open 0');
    });

    it('the route toolbar states the plan limit', () => {
        const html = markup('generation-cap-toolbar');

        expect(html).toContain('route-toolbar__cap');
        expect(html).toContain('the plan covers 120 of 505 files; 380 generated files are grouped in one stop');
    });

    it('the limit banner explains the partial diff and offers no buttons', () => {
        const html = markup('generation-cap-banner');

        expect(html).toContain('The route was built from a partial diff');
        expect(html).not.toContain('<button');
    });

    it('an empty PR says the same thing in both views', () => {
        expect(markup('empty-pr-full-diff')).toContain('Nothing to review');
        expect(markup('empty-pr-overview')).toContain('Nothing to review');
        expect(markup('empty-pr-overview')).not.toContain('ownership-card');
    });
});
