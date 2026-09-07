// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Thread } from '@sherpa/protocol';
import type { ReactNode, RefObject } from 'react';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createT } from '../i18n/index.js';
import { createSessionStore } from '../session/session-store.js';
import type { ThreadStore } from '../threads/store.js';
import { createThreadStore } from '../threads/store.js';
import { COLLAPSE_THRESHOLD } from './file-card.tsx';
import type { DiffListHandle } from './file-list.tsx';
import { DiffFileList } from './file-list.tsx';
import type { DiffViewStore } from './store.js';
import { createDiffViewStore } from './store.js';

/**
 * DOM contract of the card list and its imperative API (`DiffListHandle`). Anything that needs
 * real geometry, including the collapse anchor, `scrollMargin` and sticky headers, is tested in
 * e2e (`scroll-stability.spec.ts`, `sticky-file-header.spec.ts`, `route-file-collapse.spec.ts`):
 * jsdom rectangles are zero, so a fake layout would test the stub instead of the list.
 * Pure scroll helpers live in `file-list-scroll.test.ts`.
 */

/**
 * The virtualizer has nothing to measure in jsdom, so a fake gives cards a fixed height.
 * The list gets all `count` items at once, and the test sets `scrollOffset` by hand.
 * There is one instance per mount because the list effects include it in their dependencies.
 */
const virtual = vi.hoisted(() => {
    const ITEM_HEIGHT = 100;

    interface FakeItem {
        readonly index: number;
        readonly key: number;
        readonly start: number;
        readonly size: number;
        readonly end: number;
        readonly lane: number;
    }

    interface FakeVirtualizer {
        count: number;
        scrollOffset: number;
        scrollAdjustments: number;
        measurementsCache: readonly FakeItem[];
        shouldAdjustScrollPositionOnItemSizeChange?: unknown;
        readonly scrollToIndex: ReturnType<typeof vi.fn>;
        readonly resizeItem: ReturnType<typeof vi.fn>;
        readonly measureElement: () => void;
        readonly getTotalSize: () => number;
        readonly getVirtualItems: () => readonly FakeItem[];
        readonly setCount: (count: number) => void;
    }

    let current: FakeVirtualizer | null = null;

    const create = (): FakeVirtualizer => {
        let items: readonly FakeItem[] = [];
        const fake: FakeVirtualizer = {
            count: 0,
            scrollOffset: 0,
            scrollAdjustments: 0,
            measurementsCache: [],
            scrollToIndex: vi.fn(),
            resizeItem: vi.fn(),
            measureElement: () => undefined,
            getTotalSize: () => fake.count * ITEM_HEIGHT,
            // Keep the item set stable. It is a dependency of the parsing effect,
            // so a new array on every frame would rerun the effect for no reason.
            getVirtualItems: () => items,
            setCount: (count) => {
                if (count === fake.count) {
                    return;
                }
                fake.count = count;
                items = Array.from({ length: count }, (_, index) => ({
                    index,
                    key: index,
                    start: index * ITEM_HEIGHT,
                    size: ITEM_HEIGHT,
                    end: (index + 1) * ITEM_HEIGHT,
                    lane: 0,
                }));
                fake.measurementsCache = items;
            },
        };
        return fake;
    };

    return {
        ITEM_HEIGHT,
        reset: (): void => {
            current = null;
        },
        use: (count: number): FakeVirtualizer => {
            current ??= create();
            current.setCount(count);
            return current;
        },
        instance: (): FakeVirtualizer => {
            if (current === null) {
                throw new Error('virtualizer not created yet: list is not mounted');
            }
            return current;
        },
    };
});

vi.mock('@tanstack/react-virtual', () => ({
    useVirtualizer: ({ count }: { count: number }) => virtual.use(count),
}));

const t = createT('en');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no ResizeObserver. The list creates two, for layout and its own width. */
class TestResizeObserver {
    static instances: TestResizeObserver[] = [];
    readonly disconnect = vi.fn();

    constructor() {
        TestResizeObserver.instances.push(this);
    }

    observe(): void {
        // jsdom has no dimensions to observe.
    }

    unobserve(): void {
        // See `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = TestResizeObserver;

const MEDIUM = fixtureIteration('medium');
const HUGE = fixtureIteration('huge');
const EMPTY = fixtureIteration('empty');

function pickFile(files: readonly FileDiff[], predicate: (file: FileDiff) => boolean, what: string): FileDiff {
    const file = files.find(predicate);
    if (file === undefined) {
        throw new Error(`fixture needs ${what}`);
    }
    return file;
}

/** Regular text file: not generated, binary or marked viewed by the host. */
const isPlain = (file: FileDiff): boolean =>
    !file.generated && !file.binary && file.patch !== null && file.viewed !== true;

function plainFiles(count: number): FileDiff[] {
    const files = MEDIUM.diff.files.filter(isPlain).slice(0, count);
    if (files.length < count) {
        throw new Error(`medium fixture needs ${String(count)} regular text files`);
    }
    return files;
}

const GENERATED = pickFile(MEDIUM.diff.files, (file) => file.generated, 'generated file');

interface MountOptions {
    readonly files?: readonly FileDiff[];
    readonly store?: DiffViewStore;
    readonly parse?: (file: FileDiff) => Promise<DiffFileModel>;
    readonly threadStore?: ThreadStore;
    readonly threadVisible?: (thread: Thread) => boolean;
    readonly onTopFileChange?: (fileId: string | null) => void;
    readonly outsideThreads?: ReactNode;
}

interface Mounted {
    readonly host: HTMLElement;
    /** Files the list requested for parsing, in call order, including repeats. */
    readonly parsed: string[];
    readonly handle: RefObject<DiffListHandle | null>;
    /** Event types with listeners currently attached to the scroll container. */
    readonly liveEvents: () => string[];
    readonly rerender: (files: readonly FileDiff[]) => void;
    readonly unmount: () => void;
}

const mounted: (() => void)[] = [];

beforeEach(() => {
    virtual.reset();
    TestResizeObserver.instances = [];
});

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(options: MountOptions = {}): Mounted {
    const files = options.files ?? plainFiles(2);
    const store = options.store ?? createDiffViewStore({ files });
    const host = document.createElement('div');
    const scrollElement = document.createElement('div');
    document.body.append(scrollElement, host);
    // Track listeners by both type and callback. Removing one with a different reference leaves
    // the real handler attached, which tracking just the event type would miss.
    const liveListeners: { type: string; listener: EventListenerOrEventListenerObject; capture: boolean }[] = [];
    const captureOf = (listenerOptions?: boolean | EventListenerOptions): boolean =>
        typeof listenerOptions === 'boolean' ? listenerOptions : (listenerOptions?.capture ?? false);
    const nativeAdd = scrollElement.addEventListener.bind(scrollElement);
    const nativeRemove = scrollElement.removeEventListener.bind(scrollElement);
    scrollElement.addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        listenerOptions?: boolean | AddEventListenerOptions,
    ): void => {
        liveListeners.push({ type, listener, capture: captureOf(listenerOptions) });
        nativeAdd(type, listener, listenerOptions);
    };
    scrollElement.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        listenerOptions?: boolean | EventListenerOptions,
    ): void => {
        const capture = captureOf(listenerOptions);
        const index = liveListeners.findIndex(
            (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
        );
        if (index >= 0) {
            liveListeners.splice(index, 1);
        }
        nativeRemove(type, listener, listenerOptions);
    };
    const parsed: string[] = [];
    const model = options.parse ?? ((file: FileDiff) => Promise.resolve(parseFileDiff(toParseRequest(file))));
    const parse = (file: FileDiff): Promise<DiffFileModel> => {
        parsed.push(file.fileId);
        return model(file);
    };
    const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
    const handle = createRef<DiffListHandle>();
    const root = createRoot(host);
    const reportTop = options.onTopFileChange;

    const render = (next: readonly FileDiff[]): void => {
        act(() => {
            root.render(
                <DiffFileList
                    ref={handle}
                    scrollElement={scrollElement}
                    scrollPaddingStart={0}
                    files={next}
                    store={store}
                    contentAvailable={false}
                    parse={parse}
                    loadContent={() => Promise.resolve(null)}
                    onViewed={() => Promise.resolve(null)}
                    session={session}
                    {...(options.threadStore === undefined ? {} : { threadStore: options.threadStore })}
                    {...(options.threadVisible === undefined ? {} : { threadVisible: options.threadVisible })}
                    {...(reportTop === undefined
                        ? {}
                        : {
                              // A new reference on every render: the list's own guard suppresses repeats,
                              // rather than stable effect dependencies.
                              onTopFileChange: (fileId: string | null) => {
                                  reportTop(fileId);
                              },
                          })}
                    {...(options.outsideThreads === undefined ? {} : { outsideThreads: options.outsideThreads })}
                />,
            );
        });
    };
    render(files);

    let live = true;
    const unmount = (): void => {
        if (!live) {
            return;
        }
        live = false;
        act(() => {
            root.unmount();
        });
        host.remove();
        scrollElement.remove();
    };
    mounted.push(unmount);

    return {
        host,
        parsed,
        handle,
        liveEvents: () => liveListeners.map((entry) => entry.type),
        rerender: render,
        unmount,
    };
}

/** Wait for parse promises to resolve and the resulting rerender. */
async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

/** Advance a few frames. Adjustment needs two in a row plus a frame to clear the flag. */
async function frames(count = 4): Promise<void> {
    await act(async () => {
        for (let index = 0; index < count; index += 1) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        }
    });
}

function listHandle(view: Mounted): DiffListHandle {
    const handle = view.handle.current;
    if (handle === null) {
        throw new Error('list handle did not mount');
    }
    return handle;
}

function listElement(view: Mounted): HTMLElement {
    const list = view.host.querySelector<HTMLElement>('.diff-list');
    if (list === null) {
        throw new Error('list did not render');
    }
    return list;
}

/** Store with a mock `revealFile`. Revealing the target is part of the `scrollToFile` contract. */
function storeWithRevealSpy(files: readonly FileDiff[]): {
    readonly store: DiffViewStore;
    readonly revealFile: ReturnType<typeof vi.fn>;
} {
    const real = createDiffViewStore({ files });
    const revealFile = vi.fn((fileId: string) => {
        real.revealFile(fileId);
    });
    return { store: { ...real, revealFile }, revealFile };
}

describe('diff card list', () => {
    it('requests parsing once per visible file and skips collapsed files', async () => {
        const [first, second] = plainFiles(2);
        if (first === undefined || second === undefined) {
            throw new Error('medium fixture needs two regular files');
        }
        const files = [first, second, GENERATED];
        const store = createDiffViewStore({ files });
        const view = mount({ files, store });
        await settle();

        expect(view.parsed).toEqual([first.fileId, second.fileId]);

        // Expanding the generated file is the only late parse, requested exactly once.
        await act(async () => {
            store.revealFile(GENERATED.fileId);
            await Promise.resolve();
        });

        expect(view.parsed).toEqual([first.fileId, second.fileId, GENERATED.fileId]);
    });

    it('shows parse failures in the card, Retry requests parsing again', async () => {
        const file = plainFiles(1)[0];
        if (file === undefined) {
            throw new Error('medium fixture needs a regular file');
        }
        let attempt = 0;
        const view = mount({
            files: [file],
            parse: (candidate) => {
                attempt += 1;
                return attempt === 1
                    ? Promise.reject(new Error('worker crashed'))
                    : Promise.resolve(parseFileDiff(toParseRequest(candidate)));
            },
        });
        await settle();

        const notice = view.host.querySelector<HTMLElement>('.file-card__notice');
        expect(notice?.textContent).toContain(t('diff.file.parseFailed', 'worker crashed'));
        expect(view.host.querySelectorAll('.diff-row')).toHaveLength(0);

        const retry = notice?.querySelector<HTMLButtonElement>('.file-card__action');
        expect(retry?.textContent).toBe(t('diff.file.retryParse'));
        await act(async () => {
            retry?.click();
            await Promise.resolve();
        });
        await settle();

        expect(view.parsed).toEqual([file.fileId, file.fileId]);
        expect(view.host.querySelector('.file-card__notice')).toBeNull();
        expect(view.host.querySelectorAll('.diff-row').length).toBeGreaterThan(0);
    });

    it('returns false from scrollToFile for an unknown file without scrolling', async () => {
        const files = plainFiles(2);
        const { store, revealFile } = storeWithRevealSpy(files);
        const view = mount({ files, store });
        await settle();
        virtual.instance().scrollToIndex.mockClear();

        await expect(listHandle(view).scrollToFile('no such file')).resolves.toBe(false);
        await frames();

        expect(revealFile).not.toHaveBeenCalled();
        expect(virtual.instance().scrollToIndex).not.toHaveBeenCalled();
    });

    it('finishes scrolling with reveal: false without expanding the card', async () => {
        const files = plainFiles(2);
        const target = files[1];
        if (target === undefined) {
            throw new Error('medium fixture needs two regular files');
        }
        const { store, revealFile } = storeWithRevealSpy(files);
        const view = mount({ files, store });
        await settle();
        virtual.instance().scrollToIndex.mockClear();

        const quiet = listHandle(view).scrollToFile(target.fileId, { reveal: false });
        await frames();
        await expect(quiet).resolves.toBe(true);

        expect(revealFile).not.toHaveBeenCalled();
        expect(virtual.instance().scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' });

        // The default is the opposite. Navigation from the tree must reveal the target.
        const loud = listHandle(view).scrollToFile(target.fileId);
        await frames();
        await expect(loud).resolves.toBe(true);

        expect(revealFile).toHaveBeenCalledWith(target.fileId);
    });

    it('reports the top file only when it changes', async () => {
        const files = plainFiles(3);
        const [first, second] = files;
        if (first === undefined || second === undefined) {
            throw new Error('medium fixture needs three regular files');
        }
        const onTopFileChange = vi.fn<(fileId: string | null) => void>();
        const view = mount({ files, onTopFileChange });
        await settle();

        expect(onTopFileChange.mock.calls).toEqual([[first.fileId]]);

        // The first card moved above the top edge, so the second is now the top file.
        virtual.instance().scrollOffset = virtual.ITEM_HEIGHT + 50;
        view.rerender(files);
        await settle();

        expect(onTopFileChange.mock.calls).toEqual([[first.fileId], [second.fileId]]);

        view.rerender(files);
        await settle();

        expect(onTopFileChange.mock.calls).toEqual([[first.fileId], [second.fileId]]);
    });

    it('counts collapsed files, with a separate counter for generated files', async () => {
        const [first, second] = plainFiles(2);
        if (first === undefined || second === undefined) {
            throw new Error('medium fixture needs two regular files');
        }
        const files = [first, second, GENERATED];
        const store = createDiffViewStore({ files });
        const view = mount({ files, store });
        await settle();
        const list = listElement(view);

        expect(list.dataset.collapsedFiles).toBe('1');
        expect(list.dataset.generatedCollapsedFiles).toBe('1');

        await act(async () => {
            store.toggleFileCollapse(first.fileId);
            await Promise.resolve();
        });

        expect(list.dataset.collapsedFiles).toBe('2');
        expect(list.dataset.generatedCollapsedFiles).toBe('1');

        await act(async () => {
            store.toggleFileCollapse(GENERATED.fileId);
            await Promise.resolve();
        });

        expect(list.dataset.collapsedFiles).toBe('1');
        expect(list.dataset.generatedCollapsedFiles).toBe('0');
    });

    it('keeps a thread hidden by a lens in the card while it is kept', async () => {
        const withThread = pickFile(
            MEDIUM.diff.files,
            (file) => MEDIUM.threads.some((candidate) => candidate.anchor?.fileId === file.fileId) && isPlain(file),
            'file with a thread',
        );
        const kept = MEDIUM.threads.find((candidate) => candidate.anchor?.fileId === withThread.fileId);
        if (kept === undefined) {
            throw new Error('selected file lost its thread');
        }
        const files = [withThread];
        const threadStore = createThreadStore(MEDIUM.threads, new Set(files.map((file) => file.fileId)));
        const view = mount({ files, threadStore, threadVisible: () => false });
        await settle();

        expect(view.host.querySelectorAll('[data-thread-id]')).toHaveLength(0);

        await act(async () => {
            threadStore.keepVisible(kept.id);
            await Promise.resolve();
        });

        expect(view.host.querySelector('[data-thread-id]')?.getAttribute('data-thread-id')).toBe(kept.id);
    });

    it('renders no lines for a file above the collapse threshold until it is opened', async () => {
        const big = pickFile(
            HUGE.diff.files,
            (file) => !file.generated && file.viewed !== true && file.additions + file.deletions > COLLAPSE_THRESHOLD,
            'file above the collapse threshold',
        );
        const files = [big];
        const store = createDiffViewStore({ files });
        const view = mount({ files, store });
        await settle();

        expect(view.host.querySelector('.file-card__collapsed')?.textContent).toBe(
            t('diff.file.sizeCollapsed', big.additions + big.deletions),
        );
        expect(view.host.querySelectorAll('.diff-row')).toHaveLength(0);

        await act(async () => {
            store.openFile(big.fileId);
            await Promise.resolve();
        });

        expect(view.host.querySelector('.file-card__collapsed')).toBeNull();
        expect(view.host.querySelectorAll('.diff-row').length).toBeGreaterThan(0);
    });

    it('renders an empty list for an empty diff and clears the top file when the last file leaves', async () => {
        const files = plainFiles(2);
        const store = createDiffViewStore({ files });
        const onTopFileChange = vi.fn<(fileId: string | null) => void>();
        const view = mount({ files: EMPTY.diff.files, store, onTopFileChange });
        await settle();

        expect(EMPTY.diff.files).toHaveLength(0);
        expect(view.host.querySelectorAll('.diff-list__item')).toHaveLength(0);
        // There was no top file and there still is none, so there is nothing to report.
        expect(onTopFileChange).not.toHaveBeenCalled();

        view.rerender(files);
        await settle();
        onTopFileChange.mockClear();

        view.rerender(EMPTY.diff.files);
        await settle();

        expect(view.host.querySelectorAll('.diff-list__item')).toHaveLength(0);
        expect(onTopFileChange.mock.calls).toEqual([[null]]);
    });

    it('mounts with stubs and renders no threads without a thread store', async () => {
        const withThread = pickFile(
            MEDIUM.diff.files,
            (file) => MEDIUM.threads.some((candidate) => candidate.anchor?.fileId === file.fileId) && isPlain(file),
            'file with a thread',
        );
        const view = mount({ files: [withThread] });
        await settle();

        expect(view.host.querySelectorAll('.file-card')).toHaveLength(1);
        expect(view.host.querySelectorAll('[data-thread-id]')).toHaveLength(0);
        expect(view.host.querySelectorAll('.thread-list')).toHaveLength(0);
    });

    it('places threads outside files after the virtual canvas', async () => {
        const view = mount({ outsideThreads: <p data-outside="1">outside files</p> });
        await settle();

        expect(view.host.querySelector('.diff-list__inner [data-outside]')).toBeNull();
        expect(view.host.querySelector('.diff-list > [data-outside]')?.textContent).toBe('outside files');
    });

    it('removes observers and scroll listeners on unmount', async () => {
        const view = mount();
        await settle();

        expect(TestResizeObserver.instances.length).toBeGreaterThanOrEqual(2);
        expect(TestResizeObserver.instances.every((observer) => observer.disconnect.mock.calls.length === 0)).toBe(
            true,
        );
        expect(view.liveEvents()).toEqual(expect.arrayContaining(['scroll', 'wheel', 'touchmove']));

        view.unmount();

        expect(TestResizeObserver.instances.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
        // Empty, not just a removed type. Removing with a different reference would leave the entry.
        expect(view.liveEvents()).toEqual([]);
    });
});
