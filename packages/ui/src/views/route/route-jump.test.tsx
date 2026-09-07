// @vitest-environment jsdom
import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Lens, RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { expandAllGaps } from '../../diff-view/expand.js';
import { findLineRow } from '../../diff-view/line-target.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { buildRouteModel } from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import type * as RouteScroll from './scroll.js';
import { nextCardInStop, RouteWorkspace } from './route-view.tsx';
import { stopFileShownModel } from './stop-file-card.tsx';

/**
 * Live route clicks in jsdom: expanding test code, flashing the target line and moving
 * to the next stop after marking viewed. jsdom has no rectangles, so scrolling itself
 * is observed through the target flash class set by the same requestJump mechanism.
 *
 * The container does not move in jsdom because all rectangles are zero. Observe the jump target:
 * whether the right stop or line flashes. Check the lens and folds through stores and markup.
 */

/**
 * Observe jump scrolling through `animateScrollTo` calls. jsdom has no rectangles, so
 * `scrollTop` does not move, but the number of times the jump aimed is exact.
 */
const scrollAims = vi.hoisted(() => [] as number[]);
vi.mock('./scroll.js', async (importOriginal) => {
    const actual = await importOriginal<typeof RouteScroll>();
    return {
        ...actual,
        animateScrollTo: (container: HTMLElement, to: number, duration?: number) => {
            scrollAims.push(to);
            return actual.animateScrollTo(container, to, duration);
        },
    };
});

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const MODELS = new Map(DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]));

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

function hiddenExpandedRouteLine(): { readonly stopId: string; readonly fileId: string; readonly line: number } {
    const route = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: MODELS });
    for (const entry of route.entries) {
        if (entry.kind !== 'stop') {
            continue;
        }
        for (const group of entry.view.files) {
            const raw = MODELS.get(group.fileId);
            const content = fileContentOf(group.file);
            if (raw === undefined || content === null) {
                continue;
            }
            const base = stopFileShownModel(group, raw, content, new Map(), true);
            const expanded = stopFileShownModel(group, raw, content, expandAllGaps(raw, new Map()), true);
            if (expanded?.content.kind !== 'text') {
                continue;
            }
            for (const block of expanded.content.blocks) {
                if (block.kind !== 'hunk') {
                    continue;
                }
                for (const candidate of block.lines) {
                    const line = candidate.newLine;
                    if (
                        line !== null &&
                        !hasModelLine(base, 'new', line) &&
                        !routeOwnsLine(route.entries, group.fileId, 'new', line)
                    ) {
                        return { stopId: entry.view.stop.id, fileId: group.fileId, line };
                    }
                }
            }
        }
    }
    throw new Error('the fixture needs a line visible only after route context expansion');
}

function hasModelLine(model: ReturnType<typeof stopFileShownModel>, side: 'old' | 'new', line: number): boolean {
    return (
        model?.content.kind === 'text' &&
        model.content.blocks.some(
            (block) =>
                block.kind === 'hunk' &&
                block.lines.some((candidate) => (side === 'old' ? candidate.oldLine : candidate.newLine) === line),
        )
    );
}

function routeOwnsLine(
    entries: ReturnType<typeof buildRouteModel>['entries'],
    fileId: string,
    side: 'old' | 'new',
    line: number,
): boolean {
    return entries.some((entry) => {
        const group = entry.view.files.find((file) => file.fileId === fileId);
        if (group === undefined) {
            return false;
        }
        const visible =
            group.anchors.some((anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end) ||
            (side === 'old' ? group.contextLines.old.has(line) : group.contextLines.new.has(line));
        const collapsed =
            entry.kind === 'stop' &&
            (entry.view.files.find((file) => file.fileId === fileId)?.collapsedAnchors.some(
                (anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end,
            ) ?? false);
        return visible || collapsed;
    });
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
        selectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number };
        fileContent?: boolean;
    } = {},
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files, progress: options.progress ?? [] });
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
                loadContent={(fileId) => {
                    const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(options.fileContent && file !== undefined ? fileContentOf(file) : null);
                }}
                onSetViewed={() => Promise.resolve(0)}
                initialSelectionTarget={options.selectionTarget ?? null}
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

/** Advance a jump by `count` frames. Targeting uses requestAnimationFrame. */
async function jumpFrames(count: number): Promise<void> {
    await act(async () => {
        for (let step = 0; step < count; step += 1) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        }
    });
}

/**
 * Wait for the `count`th targeting attempt, counting frames, not milliseconds. On a busy machine a frame
 * takes longer, so a fixed wait would measure machine speed instead of jump behaviour. If it does not arrive
 * within `limit` frames, return what is available and let the test assertion fail.
 */
async function aimsAtLeast(count: number, limit = 60): Promise<number> {
    for (let step = 0; step < limit && scrollAims.length < count; step += 1) {
        await jumpFrames(1);
    }
    return scrollAims.length;
}

describe('collapsing route file cards', () => {
    it('clicking the header collapses the card and the summary row expands it again', () => {
        const view = mount();
        const card = stopSection(view.host, 's01').querySelector<HTMLElement>('.file-card');
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        if (card === null || name === null || name === undefined) {
            throw new Error('the first stop needs a file card');
        }

        click(name);
        expect(card.querySelector('.file-card__collapsed--file')?.textContent).toContain('collapsed by hand');

        const summary = card.querySelector<HTMLElement>('.file-card__collapsed--file');
        if (summary === null) {
            throw new Error('a summary row is required after the click');
        }
        click(summary);
        expect(card.querySelector('.file-card__collapsed--file')).toBeNull();
    });

    it('anchored threads in a collapsed card remain below the header', () => {
        const view = mount();
        const card = [...stopSection(view.host, 's01').querySelectorAll<HTMLElement>('.file-card')].find(
            (candidate) => candidate.querySelector('.file-card__name')?.textContent === 'edit-window.ts',
        );
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        if (card === undefined || name === null || name === undefined) {
            throw new Error('stop s01 needs an edit-window.ts card');
        }
        const before = [...card.querySelectorAll<HTMLElement>('.thread')].map((thread) => thread.dataset.threadId);
        expect(before.length).toBeGreaterThan(0);

        click(name);

        expect(card.querySelector('.file-card__collapsed--file')).not.toBeNull();
        expect([...card.querySelectorAll<HTMLElement>('.thread')].map((thread) => thread.dataset.threadId)).toEqual(
            before,
        );
        const threads = card.querySelector<HTMLElement>('.thread-list');
        expect(threads?.parentElement).toBe(card);
        expect(threads?.previousElementSibling?.classList.contains('file-card__header')).toBe(true);
    });

    it('marking viewed collapses the card and clearing the mark expands it', () => {
        const view = mount();
        const card = stopSection(view.host, 's01').querySelector<HTMLElement>('.file-card');
        const viewed = card?.querySelector<HTMLElement>('.file-card__viewed');
        if (card === null || viewed === null || viewed === undefined) {
            throw new Error('the first stop needs a card with a viewed toggle');
        }

        click(viewed);
        expect(card.querySelector('.file-card__collapsed--file')?.textContent).toContain('viewed');

        click(viewed);
        expect(card.querySelector('.file-card__collapsed--file')).toBeNull();
    });

    it('jumping from a chip expands the collapsed card first', async () => {
        const view = mount();
        const stop = stopSection(view.host, 's01');
        const card = stop.querySelector<HTMLElement>('.file-card');
        const name = card?.querySelector<HTMLElement>('.file-card__name');
        const fileId = card?.dataset.file;
        if (card === null || name === null || name === undefined || fileId === undefined) {
            throw new Error('the first stop needs a file card');
        }
        const chip = [...stop.querySelectorAll<HTMLElement>('.route-chip')].find((candidate) => {
            const candidateName = candidate.querySelector('.route-chip__name')?.textContent;
            return candidateName === name.textContent;
        });
        if (chip === undefined) {
            throw new Error(`file ${fileId} needs a jump chip`);
        }

        click(name);
        expect(card.querySelector('.file-card__collapsed--file')).not.toBeNull();
        click(chip);
        await view.settle();

        expect(card.querySelector('.file-card__collapsed--file')).toBeNull();
    });
});

describe('jumping to a hidden route line', () => {
    it('expands context and reaches the target with a bounded search across frames', async () => {
        const target = hiddenExpandedRouteLine();
        const view = mount({
            selectionTarget: { fileId: target.fileId, side: 'new', start: target.line },
            fileContent: true,
        });

        await view.settle();

        expect(view.store.getSnapshot().expansion.get(target.fileId)?.size).toBeGreaterThan(0);
        expect(findLineRow(stopSection(view.host, target.stopId), 'new', target.line)).not.toBeNull();
    });
});

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

    it('adjusts the jump twice more, on the next frame and after settling', async () => {
        const view = mount({ filter: PARTIAL_LENS.id, extraLenses: [PARTIAL_LENS] });
        await view.settle();
        scrollAims.length = 0;

        click(viewedToggle(view.host, 's04'));
        // The first frame targets the found section, the next targets the layout after it shrinks.
        await aimsAtLeast(1);
        await jumpFrames(2);
        const afterJump = scrollAims.length;
        expect(afterJump).toBeGreaterThanOrEqual(2);

        // The third attempt comes after ANCHOR_SETTLE, once collapsing has settled.
        expect(await aimsAtLeast(afterJump + 1)).toBeGreaterThan(afterJump);
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

    it('navigation within a stop targets the nearest expanded card', () => {
        const view = mount();
        const section = [...view.host.querySelectorAll<HTMLElement>('[data-stop]')].find(
            (candidate) => candidate.querySelectorAll('.file-card[data-file]').length >= 3,
        );
        if (section === undefined) {
            throw new Error('the fixture needs a stop with at least three cards');
        }
        const cards = [...section.querySelectorAll<HTMLElement>('.file-card[data-file]')];
        const [first, second, third] = cards;
        const stopId = section.dataset.stop;
        const fileId = first?.dataset.file;
        if (stopId === undefined || fileId === undefined || second === undefined || third === undefined) {
            throw new Error('the stop cards need file ids');
        }
        const collapse = (card: HTMLElement): void => {
            const name = card.querySelector<HTMLElement>('.file-card__name');
            if (name === null) {
                throw new Error('the card header needs a filename');
            }
            // Clicking the header toggles the card. It would expand an already collapsed generated file.
            if (card.querySelector('.file-card__collapsed--file') === null) {
                click(name);
            }
        };

        expect(nextCardInStop(view.host, stopId, fileId)).toBe(second.dataset.file);

        // A collapsed card is an already read single row, so navigation skips it.
        collapse(second);
        expect(nextCardInStop(view.host, stopId, fileId)).toBe(third.dataset.file);

        // Everything below is collapsed, so use the next card, as in the full diff.
        for (const card of cards.slice(2)) {
            collapse(card);
        }
        expect(nextCardInStop(view.host, stopId, fileId)).toBe(second.dataset.file);
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
