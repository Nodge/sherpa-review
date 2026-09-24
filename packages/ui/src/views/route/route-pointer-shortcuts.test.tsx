// @vitest-environment jsdom
import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import type { PointerTarget } from '../../shortcuts/pointer-target.js';
import type { ShortcutRegistry } from '../../shortcuts/registry.js';
import { createShortcutRegistry } from '../../shortcuts/registry.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * Route shortcuts use the target under the pointer (docs/design/SPEC-elements.md §5). Nothing has focus, and the pointer is over
 * a stop, line or thread. The pointer monitor is mocked because jsdom has no `elementFromPoint`.
 */

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The toolbar measures its height with an observer absent in jsdom. There is no layout here anyway.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // jsdom has no layout, so there is nothing to observe.
    }
    unobserve(): void {
        // jsdom has no layout, so there is nothing to observe.
    }
    disconnect(): void {
        // jsdom has no layout, so there is nothing to observe.
    }
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount() {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const stopWrites: { stopId: string; viewed: boolean }[] = [];
    const registry = createShortcutRegistry();
    registry.setActiveScope('route');
    let hovered: Element | null = null;
    const pointer: PointerTarget = {
        hovered: () => hovered,
        target: (selector) => hovered?.closest(selector) ?? document.activeElement?.closest(selector) ?? null,
        dispose: () => undefined,
    };
    const root = createRoot(host);
    act(() => {
        root.render(
            <ShortcutsProvider registry={registry} pointer={pointer}>
                <RouteWorkspace
                    pr={DATA.pr}
                    diff={DATA.diff}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                    snapshot={SNAPSHOT}
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    progressLoaded
                    threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={(fileId) => {
                        const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                        return Promise.resolve(file === undefined ? null : fileContentOf(file));
                    }}
                    onSetViewed={() => Promise.resolve(0)}
                    onSetStopViewed={(stopId, viewed) => {
                        stopWrites.push({ stopId, viewed });
                        return Promise.resolve(stopWrites.length);
                    }}
                />
            </ShortcutsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return {
        host,
        store,
        threadStore,
        stopWrites,
        hover: (element: Element | null) => {
            hovered = element;
        },
        press: (key: string) => {
            press(registry, key);
        },
        settle: async () => {
            for (let step = 0; step < 6; step += 1) {
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                });
            }
        },
    };
}

/** Send the keypress through the registry, exactly as the page's only listener does. */
function press(registry: ShortcutRegistry, key: string): void {
    act(() => {
        registry.handle({
            key,
            code: `Key${key.toUpperCase()}`,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
            target: document.body,
            preventDefault: () => undefined,
        });
    });
}

function stopSection(host: HTMLElement, stopId: string): HTMLElement {
    const section = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (section === null) {
        throw new Error(`stop ${stopId} is missing from the markup`);
    }
    return section;
}

/** First added line in a stop file card. Read its address from the markup. */
function addedRow(section: HTMLElement): { readonly element: HTMLElement; readonly fileId: string; readonly line: number } {
    const row = section.querySelector<HTMLElement>('.file-card[data-file] .diff-row[data-key^="a"]');
    const fileId = row?.closest<HTMLElement>('[data-file]')?.dataset.file;
    const key = row?.dataset.key;
    if (row === null || fileId === undefined || key === undefined) {
        throw new Error('the stop has no rendered added line');
    }
    return { element: row, fileId, line: Number(key.slice(1)) };
}

describe('route shortcuts for the target under the pointer', () => {
    it('v marks the stop under the pointer viewed', async () => {
        const view = mount();
        await view.settle();
        view.hover(stopSection(view.host, 's02'));

        view.press('v');
        await view.settle();

        expect(document.activeElement).toBe(document.body);
        expect(view.stopWrites).toEqual([{ stopId: 's02', viewed: true }]);
    });

    it('x collapses the stop under the pointer', async () => {
        const view = mount();
        await view.settle();
        const section = stopSection(view.host, 's01');
        expect(section.querySelectorAll('.route-collapsed')).toHaveLength(0);
        view.hover(section);

        view.press('x');
        await view.settle();

        expect(stopSection(view.host, 's01').querySelectorAll('.route-collapsed')).toHaveLength(1);
    });

    it('c opens the composer on the line under the pointer', async () => {
        const view = mount();
        await view.settle();
        const row = addedRow(stopSection(view.host, 's01'));
        view.hover(row.element);

        view.press('c');

        expect(view.threadStore.getComposer(`new:${row.fileId}:new:${String(row.line)}`)?.anchor?.position).toEqual({
            side: 'new',
            line: row.line,
            size: 1,
        });
    });

    it('r opens a thread reply under the pointer', async () => {
        const view = mount();
        await view.settle();
        const thread = view.host.querySelector<HTMLElement>('[data-stop] .thread[data-thread-id]');
        const threadId = thread?.dataset.threadId;
        if (thread === null || threadId === undefined) {
            throw new Error('the route has no rendered thread');
        }
        view.hover(thread.querySelector('.thread__row') ?? thread);

        view.press('r');

        expect(view.threadStore.getComposer(`reply:${threadId}`)?.threadId).toBe(threadId);
    });

    it('e expands context for the hunk under the pointer', async () => {
        const view = mount();
        await view.settle();
        const { element, fileId } = gapRow(view.host);
        view.hover(element);

        view.press('e');
        await view.settle();

        expect(view.store.getSnapshot().expansion.get(fileId)?.size).toBeGreaterThan(0);
    });

    it('takes the line and stop from one node, so hovering another stop does not change the target', async () => {
        const view = mount();
        await view.settle();
        const { element, fileId } = gapRow(view.host);
        act(() => {
            element.focus();
        });
        // The stop under the pointer has no such file. Combine it with the focused line,
        // and no card will be found, so context will not expand at all.
        const foreign = [...view.host.querySelectorAll<HTMLElement>('[data-stop]')].find(
            (section) =>
                section !== element.closest('[data-stop]') &&
                section.querySelector(`.file-card[data-file="${CSS.escape(fileId)}"]`) === null,
        );
        if (foreign === undefined) {
            throw new Error('the fixture needs a stop without this file');
        }
        view.hover(foreign);

        view.press('e');
        await view.settle();

        expect(view.store.getSnapshot().expansion.get(fileId)?.size).toBeGreaterThan(0);
    });
});

/** The line directly below a context gap has context to expand, so `e` is available. */
function gapRow(host: HTMLElement): { readonly element: HTMLElement; readonly fileId: string } {
    const gap = host.querySelector<HTMLElement>('[data-stop] .file-card[data-file] .diff-gap');
    const fileId = gap?.closest<HTMLElement>('[data-file]')?.dataset.file;
    let row: HTMLElement | null = null;
    for (let node = gap?.nextElementSibling ?? null; node !== null; node = node.nextElementSibling) {
        const candidate = node.matches('[data-key]') ? node : node.querySelector('[data-key]');
        if (candidate instanceof HTMLElement) {
            row = candidate;
            break;
        }
    }
    if (row === null || fileId === undefined) {
        throw new Error('the route has no context gap with a line below it');
    }
    return { element: row, fileId };
}
