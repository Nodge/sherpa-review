// @vitest-environment jsdom
import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { Lens, RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { SessionStore } from '../../session/session-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-view.tsx';

/**
 * Live route clicks in jsdom cover what static markup cannot show: expanding
 * test code through a chip or assertion anchor, flashing the target row, and no progress changes
 * when toggling Show/Hide (M2-T9).
 *
 * Scrolling cannot be tested: jsdom has no layout, all rectangles are zero, and the container
 * does not move. What we can observe is that the jump reached its target: the highlight class appears
 * on exactly the row being sought.
 */

const DATA = fixtureData('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

// React 19 requires the environment to be declared explicitly, or every `act` logs a warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A lens that keeps the digest stop visible but hides one of its test files. The fixture has
 * no such lens (all three s04 files are in My files), and this case breaks lens reset by anchor.
 */
const PARTIAL_LENS: Lens = {
    id: 'partial',
    label: 'Half the stop',
    paths: DATA.diff.files
        .map((file) => file.path)
        .filter((path) => !path.endsWith('__tests__/edit-window.test.ts')),
    available: true,
    note: null,
};

interface Mounted {
    readonly host: HTMLElement;
    readonly session: SessionStore;
    /** Stops for which the view requested a viewed mark. */
    readonly stopWrites: string[];
    /** Advance time so cards render and the jump completes across frames. */
    readonly settle: () => Promise<void>;
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(options: { filter?: string; extraLenses?: readonly Lens[] } = {}): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files, storage: null });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({
        initial: { view: 'route', filter: options.filter ?? 'all' },
    });
    const stopWrites: string[] = [];
    const root = createRoot(host);

    act(() => {
        root.render(
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: [...(options.extraLenses ?? DATA.extraLenses)] }}
                snapshot={SNAPSHOT}
                session={session}
                store={store}
                threadStore={createThreadStore(DATA.threads, FILE_IDS)}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={() => Promise.resolve(null)}
                onOpenInEditor={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={(stopId) => {
                    stopWrites.push(stopId);
                    return Promise.resolve(0);
                }}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const settle = async (): Promise<void> => {
        // The jump searches for its target frame by frame. Two frames cover expansion and line lookup.
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
        }
    };

    return { host, session, stopWrites, settle };
}

function stopSection(host: HTMLElement, stopId: string): HTMLElement {
    const section = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (section === null) {
        throw new Error(`stop ${stopId} is missing from the markup`);
    }
    return section;
}

/** Find a button by exact text so test clicks follow the same path as the reviewer. */
function button(scope: HTMLElement, text: string): HTMLElement {
    const found = [...scope.querySelectorAll<HTMLElement>('button')].find(
        (element) => element.textContent.trim() === text,
    );
    if (found === undefined) {
        throw new Error(`button "${text}" is missing from the markup`);
    }
    return found;
}

function click(element: HTMLElement): void {
    act(() => {
        element.click();
    });
}

function flashed(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('.diff-row--palette-target');
}

describe('test digest live clicks', () => {
    it('the toggle shows and hides test code without writing progress', () => {
        const view = mount();

        expect(stopSection(view.host, 's04').querySelector('.file-card')).toBeNull();

        click(button(stopSection(view.host, 's04'), 'Show the test code'));
        expect(stopSection(view.host, 's04').querySelectorAll('.file-card')).toHaveLength(3);
        expect(view.session.getSnapshot().stops.testCode.has('s04')).toBe(true);

        click(button(stopSection(view.host, 's04'), 'Hide the test code'));
        expect(stopSection(view.host, 's04').querySelector('.file-card')).toBeNull();
        expect(view.stopWrites).toEqual([]);
    });

    it('a hidden test file chip expands the test code and reaches its card', async () => {
        const view = mount();
        const chip = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button')].find((element) =>
            element.textContent.includes('edit-window.test.ts'),
        );
        if (chip === undefined) {
            throw new Error('the stop header must have a test file chip');
        }

        click(chip);
        await view.settle();

        // Clicking the chip no longer leads nowhere. The file card is now in the markup.
        expect(stopSection(view.host, 's04').querySelectorAll('.file-card').length).toBeGreaterThan(0);
        expect(view.session.getSnapshot().stops.testCode.has('s04')).toBe(true);
    });

    it('an assertion anchor expands test code and flashes its line', async () => {
        const view = mount();
        const anchor = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button.digest__anchor')].find(
            (element) => element.textContent === 'edit-window.test.ts:17',
        );
        if (anchor === undefined) {
            throw new Error('the first digest assertions must have live anchors');
        }

        click(anchor);
        await view.settle();

        const row = flashed(view.host);
        expect(row).not.toBeNull();
        // Line 17 on the new side flashes, not the adjacent old-side line with the same number.
        expect(row?.dataset.key).toBe('a17');
        expect(stopSection(view.host, 's04').contains(row)).toBe(true);
    });

    it('an uncovered anchor leads to another stop without crashing the view', async () => {
        const view = mount();
        const anchor = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button.digest__anchor')].find(
            (element) => element.textContent === 'edit-window.ts:92',
        );
        if (anchor === undefined) {
            throw new Error('the uncovered code anchor must have a live link');
        }

        click(anchor);
        await view.settle();

        const row = flashed(view.host);
        expect(row).not.toBeNull();
        // Stop 01 explains line 92, so the jump goes there instead of staying in the digest.
        expect(stopSection(view.host, 's01').contains(row)).toBe(true);
    });

    it('resets a lens hiding the anchor file so the jump has a target', async () => {
        const view = mount({ filter: PARTIAL_LENS.id, extraLenses: [PARTIAL_LENS] });
        expect(view.session.getSnapshot().filter).toBe(PARTIAL_LENS.id);

        const anchor = [...stopSection(view.host, 's04').querySelectorAll<HTMLElement>('button.digest__anchor')].find(
            (element) => element.textContent === 'edit-window.test.ts:17',
        );
        if (anchor === undefined) {
            throw new Error('the digest prints assertions regardless of the lens');
        }

        click(anchor);
        await view.settle();

        expect(view.session.getSnapshot().filter).toBe('all');
        expect(flashed(view.host)).not.toBeNull();
    });
});
