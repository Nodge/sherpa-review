// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { SelectionPopover } from './selection-popover.tsx';

const DIFF_ID = 'iter-1';
const FILE = {
    fileId: 'f1',
    path: 'src/cache.ts',
    oldPath: null,
    changeType: 'modify' as const,
    binary: false,
    additions: 2,
    deletions: 0,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    patch: ['@@ -10,2 +10,4 @@', ' keep', '+first', '+second', ' tail'].join('\n'),
};
const MODEL = parseFileDiff(FILE);
const SELECTION = { fileId: FILE.fileId, side: 'new' as const, anchor: 'a11', focus: 'a12' };
const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.unstubAllGlobals();
});

describe('SelectionPopover DOM measurements', () => {
    it('caches DOM rows and handles scroll bursts at most once per frame', () => {
        const view = mountPopover();
        const lineQueries = vi.spyOn(view.card, 'querySelector');

        for (let index = 0; index < 8; index += 1) {
            window.dispatchEvent(new Event('scroll'));
        }
        expect(view.frames).toHaveLength(1);

        view.flush();
        expect(lineQueries).not.toHaveBeenCalled();
    });

    describe('closing on scroll', () => {
        it('closes when scrolling moves the selection more than 200px away', () => {
            const view = mountPopover();
            view.moveRows(450);
            view.scroll();
            expect(view.onClear).toHaveBeenCalledTimes(1);
        });

        it('does not count host relayout as scrolling and uses the new position as the baseline', () => {
            const view = mountPopover();
            view.moveRows(450);
            view.resizeHost();
            view.scroll();
            expect(view.onClear).not.toHaveBeenCalled();

            view.moveRows(450 + 250);
            view.scroll();
            expect(view.onClear).toHaveBeenCalledTimes(1);
        });

        it('also resets the baseline during measurement after relayout, before scrolling', () => {
            const view = mountPopover();
            view.moveRows(450);
            view.resizeHost();
            window.dispatchEvent(new Event('resize'));
            view.flush();

            view.moveRows(450 + 250);
            view.scroll();
            expect(view.onClear).toHaveBeenCalledTimes(1);
        });
    });
});

/** Popover above 2 lines the test moves within the viewport, with manually advanced frames. */
function mountPopover(): {
    readonly card: HTMLElement;
    readonly frames: FrameRequestCallback[];
    readonly onClear: ReturnType<typeof vi.fn>;
    readonly moveRows: (top: number) => void;
    readonly resizeHost: () => void;
    readonly flush: () => void;
    readonly scroll: () => void;
} {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe(): void {
                // The test simulates relayout by changing the host clientWidth.
            }
            disconnect(): void {
                // Nothing to observe.
            }
        },
    );

    let top = 100;
    const host = document.createElement('main');
    const card = document.createElement('article');
    card.className = 'file-card';
    card.dataset.file = FILE.fileId;
    for (const [key, offset] of [
        ['a11', 0],
        ['a12', 20],
    ] as const) {
        const row = document.createElement('div');
        row.className = 'diff-row';
        row.getBoundingClientRect = () => rect(top + offset, top + offset + 20, 100, 500);
        const cell = document.createElement('span');
        cell.dataset.key = key;
        row.append(cell);
        card.append(row);
    }
    host.append(card);
    document.body.append(host);
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 800 });
    host.getBoundingClientRect = () => rect(0, 900, 0, 800);

    const onClear = vi.fn();
    const mountNode = document.createElement('div');
    host.append(mountNode);
    const root = createRoot(mountNode);
    act(() => {
        root.render(
            <SelectionPopover
                host={host}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={onClear}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const flush = (): void => {
        act(() => {
            for (const frame of frames.splice(0)) {
                frame(0);
            }
        });
    };
    return {
        card,
        frames,
        onClear,
        moveRows: (next) => {
            top = next;
        },
        resizeHost: () => {
            Object.defineProperty(host, 'clientWidth', { configurable: true, value: 600 });
        },
        flush,
        scroll: () => {
            window.dispatchEvent(new Event('scroll'));
            flush();
        },
    };
}

function rect(top: number, bottom: number, left: number, right: number): DOMRect {
    return {
        x: left,
        y: top,
        top,
        bottom,
        left,
        right,
        width: right - left,
        height: bottom - top,
        toJSON: () => ({}),
    };
}
