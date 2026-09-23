// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { ViewFrame } from './view-frames.tsx';

/**
 * The Summary card renders summary text with the stop description vocabulary: paragraphs, lists, code and links.
 * Internal links lead to a route stop or a file in Full diff.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const DOCS_PATH = 'services/orders/docs/edit-window.md';

// React 19 requires the environment to be declared explicitly, or every `act` logs a warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function readyState(): UiRouteState {
    const fixture = routeFixtures('medium')?.states.ready ?? null;
    if (fixture === null) {
        throw new Error('medium fixture needs a ready route state');
    }
    return fixture;
}

const mounted: { unmount: () => void; host: HTMLElement }[] = [];

afterEach(() => {
    for (const view of mounted.splice(0)) {
        act(() => {
            view.unmount();
        });
        view.host.remove();
    }
});

function mount(handlers: { onJumpToStop: (stopId: string) => void; onOpenFile: (fileId: string) => void }) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                threads={DATA.threads}
                threadStore={createThreadStore(DATA.threads, FILE_IDS)}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                reviewHostAvailable
                generation={{ route: readyState() }}
                {...handlers}
            />,
        );
    });
    mounted.push({
        unmount: () => {
            root.unmount();
        },
        host,
    });
    const summary = host.querySelector<HTMLElement>('.overview-card__text.md-blocks');
    if (summary === null) {
        throw new Error('Summary card did not render the summary');
    }
    return summary;
}

function link(summary: HTMLElement, href: string): HTMLElement {
    const element = summary.querySelector<HTMLElement>(`a[href="${href}"]`);
    if (element === null) {
        throw new Error(`summary has no link to ${href}`);
    }
    return element;
}

describe('Summary card', () => {
    it('renders paragraphs, lists, inline code and bold with the stop description vocabulary', () => {
        const summary = mount({ onJumpToStop: vi.fn(), onOpenFile: vi.fn() });

        expect(summary.querySelectorAll('p.md-p').length).toBeGreaterThanOrEqual(3);
        expect(summary.querySelectorAll('ul.md-list > li')).toHaveLength(3);
        expect(summary.querySelector('code.md-code')?.textContent).toBe('EditWindow');
        expect(summary.querySelector('strong.md-strong')).not.toBeNull();
        expect(summary.textContent).not.toContain('`');
    });

    it('navigates from a `#stop-N` link to the stop with that plan number', () => {
        const onJumpToStop = vi.fn();
        const summary = mount({ onJumpToStop, onOpenFile: vi.fn() });

        act(() => {
            link(summary, '#stop-3').click();
        });

        expect(onJumpToStop).toHaveBeenCalledExactlyOnceWith('s03');
    });

    it('opens the diff file by id from a `#file-<path>` link', () => {
        const onOpenFile = vi.fn();
        const summary = mount({ onJumpToStop: vi.fn(), onOpenFile });
        const fileId = DATA.diff.files.find((file) => file.path === DOCS_PATH)?.fileId;

        act(() => {
            link(summary, `#file-${DOCS_PATH}`).click();
        });

        expect(fileId).toBeDefined();
        expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(fileId);
    });
});
