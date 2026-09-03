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
                    // The layout is static in this test.
                }
                disconnect(): void {
                    // Nothing to observe.
                }
            },
        );

        const host = document.createElement('main');
        const card = document.createElement('article');
        card.className = 'file-card';
        card.dataset.file = FILE.fileId;
        for (const [key, top] of [
            ['a11', 100],
            ['a12', 120],
        ] as const) {
            const row = document.createElement('div');
            row.className = 'diff-row';
            row.getBoundingClientRect = () => rect(top, top + 20, 100, 500);
            const cell = document.createElement('span');
            cell.dataset.key = key;
            row.append(cell);
            card.append(row);
        }
        host.append(card);
        document.body.append(host);
        Object.defineProperty(host, 'clientWidth', { configurable: true, value: 800 });
        host.getBoundingClientRect = () => rect(0, 700, 0, 800);

        const lineQueries = vi.spyOn(card, 'querySelector');

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
                    onClear={() => undefined}
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(lineQueries).toHaveBeenCalledTimes(2);
        for (let index = 0; index < 8; index += 1) {
            window.dispatchEvent(new Event('scroll'));
        }
        expect(frames).toHaveLength(1);

        act(() => {
            frames.shift()?.(0);
        });
        expect(lineQueries).toHaveBeenCalledTimes(2);
    });
});

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
