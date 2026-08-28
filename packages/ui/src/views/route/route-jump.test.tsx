// @vitest-environment jsdom
import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { Lens, RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { SessionStore } from '../../session/session-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-view.tsx';

/**
 * Live route clicks in jsdom: expanding test code, flashing the target line and moving
 * to the next stop after marking viewed. jsdom has no rectangles, so scrolling itself
 * is observed through the target flash class set by the same requestJump mechanism.
 *
 * The container does not move in jsdom because all rectangles are zero. Observe the jump target:
 * whether the right stop or line flashes. Check the lens and folds through stores and markup.
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
    zones: null,
};
const GENERATED_FILE = DATA.diff.files.find((file) => file.path === 'pnpm-lock.yaml');
if (GENERATED_FILE === undefined) {
    throw new Error('the medium fixture needs the generated file pnpm-lock.yaml');
}
const WITHOUT_GENERATED_LENS: Lens = {
    id: 'without-generated',
    label: 'Without the generated file',
    paths: DATA.diff.files.filter((file) => file.fileId !== GENERATED_FILE.fileId).map((file) => file.path),
    available: true,
    note: null,
    zones: null,
};
const DIGEST_NON_TEST_ANCHOR = (() => {
    const anchor = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (anchor === undefined) {
        throw new Error('stop s01 needs an anchor in a non-test file');
    }
    return anchor;
})();
const DIGEST_NON_TEST_LENS: Lens = {
    id: 'digest-non-test',
    label: 'Only the non-test digest file',
    paths: [DIGEST_NON_TEST_ANCHOR.path],
    available: true,
    note: null,
    zones: null,
};

/** Add a non-test file to s04 so a lens can keep the stop while hiding all its test code. */
function digestHiddenByLensSnapshot(): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop) =>
            stop.id === 's04' ? { ...stop, anchors: [...stop.anchors, DIGEST_NON_TEST_ANCHOR] } : stop,
        ),
    };
}

/** Digest assertion anchors lead to s01 without changing the files in s04 itself. */
function digestOutsideStopSnapshot(): RouteSnapshot {
    const target = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (target === undefined) {
        throw new Error('stop s01 needs an anchor for the derived snapshot');
    }
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop) =>
            stop.id !== 's04'
                ? stop
                : {
                      ...stop,
                      tests: stop.tests.map((claim) =>
                          claim.kind === 'uncovered'
                              ? claim
                              : {
                                    ...claim,
                                    anchor: { fileId: target.fileId, path: target.path, line: target.start },
                                },
                      ),
                  },
        ),
    };
}

interface Mounted {
    readonly host: HTMLElement;
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    /** Stops for which the view requested a viewed mark. */
    readonly stopWrites: string[];
    /** Apply the first server snapshot after the route has already mounted. */
    readonly applyProgress: (progress: readonly UiFileProgress[]) => void;
    /** Advance time so cards render and the jump completes across frames. */
    readonly settle: () => Promise<void>;
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    options: {
        snapshot?: RouteSnapshot;
        filter?: string;
        extraLenses?: readonly Lens[];
        progress?: readonly UiFileProgress[];
        progressLoaded?: boolean;
    } = {},
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files, progress: options.progress ?? [], storage: null });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({
        initial: { view: 'route', filter: options.filter ?? 'all' },
    });
    const stopWrites: string[] = [];
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const root = createRoot(host);
    let progressLoaded = options.progressLoaded ?? true;
    const render = (): void => {
        root.render(
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: [...(options.extraLenses ?? DATA.extraLenses)] }}
                snapshot={options.snapshot ?? SNAPSHOT}
                session={session}
                store={store}
                threadStore={threadStore}
                progressLoaded={progressLoaded}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={(stopId) => {
                    stopWrites.push(stopId);
                    return Promise.resolve(0);
                }}
            />,
        );
    };

    act(render);
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

    return {
        host,
        session,
        store,
        stopWrites,
        applyProgress: (progress) => {
            act(() => {
                store.setProgress(progress);
                progressLoaded = true;
                render();
            });
        },
        settle,
    };
}

function stopSection(host: HTMLElement, stopId: string): HTMLElement {
    const section = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (section === null) {
        throw new Error(`stop ${stopId} is missing from the markup`);
    }
    return section;
}

function viewedToggle(host: HTMLElement, stopId: string): HTMLButtonElement {
    const toggle = stopSection(host, stopId).querySelector<HTMLButtonElement>('.route-stop__viewed');
    if (toggle === null) {
        throw new Error(`stop ${stopId} has no viewed toggle`);
    }
    return toggle;
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

describe('marking a stop viewed jumps to the next visible stop', () => {
    it('the first snapshot with full coverage sets a baseline without automatic marking or jumping', async () => {
        const progress = DATA.diff.files.map(
            (file): UiFileProgress => ({ fileId: file.fileId, viewed: true, seenRanges: [] }),
        );
        const view = mount({ progress });

        await view.settle();

        expect(view.stopWrites).toEqual([]);
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(view.host.querySelector('[role="status"]')?.textContent).toBe('');
    });

    it('the first server snapshot arriving after mount remains a baseline', async () => {
        const view = mount({ progressLoaded: false });
        await view.settle();
        const progress = DATA.diff.files.map(
            (file): UiFileProgress => ({ fileId: file.fileId, viewed: true, seenRanges: [] }),
        );

        view.applyProgress(progress);
        await view.settle();

        expect(view.stopWrites).toEqual([]);
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(view.host.querySelector('[role="status"]')?.textContent).toBe('');
    });

    it('the generated-file default does not auto-mark s06 or start a jump on mount', async () => {
        const view = mount();

        await view.settle();

        expect(view.stopWrites).not.toContain('s06');
        expect(viewedToggle(view.host, 's06').getAttribute('aria-pressed')).toBe('false');
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
    });

    it('an automatic mark hidden by the lens writes progress without jumping or an aria announcement', async () => {
        const view = mount({ filter: WITHOUT_GENERATED_LENS.id, extraLenses: [WITHOUT_GENERATED_LENS] });
        await view.settle();
        expect(view.host.querySelector('[data-stop="s06"]')).toBeNull();

        act(() => {
            view.store.markViewed(GENERATED_FILE.fileId, true);
        });
        await view.settle();

        expect(view.stopWrites).toContain('s06');
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(view.host.querySelector('[role="status"]')?.textContent).toBe('');
    });

    it('a manual mark jumps to the next stop without resetting the lens or expanding low stops', async () => {
        const view = mount({ filter: PARTIAL_LENS.id, extraLenses: [PARTIAL_LENS] });

        click(viewedToggle(view.host, 's04'));
        await view.settle();

        expect(view.session.getSnapshot().filter).toBe(PARTIAL_LENS.id);
        expect(stopSection(view.host, 's05').querySelector('.route-stop__flash')).not.toBeNull();
        expect(stopSection(view.host, 's05').querySelector('.route-collapsed')).not.toBeNull();
    });

    it('an automatic mark through the last file jumps to the next stop', async () => {
        const view = mount();
        const toggles = [...stopSection(view.host, 's01').querySelectorAll<HTMLButtonElement>('.file-card__viewed')];
        expect(toggles.length).toBeGreaterThan(0);

        act(() => {
            for (const toggle of toggles) {
                toggle.click();
            }
        });
        await view.settle();

        expect(stopSection(view.host, 's01').querySelector('.route-collapsed--viewed')).not.toBeNull();
        expect(stopSection(view.host, 's02').querySelector('.route-stop__flash')).not.toBeNull();
    });

    it('marking the final Other stop viewed does not start a jump', async () => {
        const view = mount();
        await view.settle();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 950));
        });
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
        expect(viewedToggle(view.host, 'other').getAttribute('aria-pressed')).toBe('false');

        click(viewedToggle(view.host, 'other'));
        await view.settle();

        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
    });

    it('clearing the mark does not start another jump', async () => {
        const view = mount();
        click(viewedToggle(view.host, 's04'));
        await view.settle();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 950));
        });
        expect(view.host.querySelector('.route-stop__flash')).toBeNull();

        click(viewedToggle(view.host, 's04'));
        await view.settle();

        expect(view.host.querySelector('.route-stop__flash')).toBeNull();
    });
});

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

    it('the location row for an empty intersection leads to another stop', async () => {
        const view = mount({ snapshot: digestOutsideStopSnapshot() });
        const location = button(stopSection(view.host, 's04'), 'test code — in stop 01');

        click(location);
        await view.settle();

        const row = flashed(view.host);
        expect(row).not.toBeNull();
        expect(stopSection(view.host, 's01').contains(row)).toBe(true);
    });

    it('the hidden-by-lens row resets the lens and expands test code in its stop', async () => {
        const view = mount({
            snapshot: digestHiddenByLensSnapshot(),
            filter: DIGEST_NON_TEST_LENS.id,
            extraLenses: [DIGEST_NON_TEST_LENS],
        });
        const stop = stopSection(view.host, 's04');
        expect(view.session.getSnapshot().filter).toBe(DIGEST_NON_TEST_LENS.id);
        expect(stop.querySelectorAll('.file-card')).toHaveLength(1);

        click(button(stop, 'test code hidden by the lens'));
        await view.settle();

        expect(view.session.getSnapshot().filter).toBe('all');
        expect(view.session.getSnapshot().stops.testCode.has('s04')).toBe(true);
        expect(stopSection(view.host, 's04').querySelectorAll('.file-card')).toHaveLength(4);
        const row = flashed(view.host);
        expect(row).not.toBeNull();
        expect(stopSection(view.host, 's04').contains(row)).toBe(true);
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
