// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiffViewStore } from '../../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import { DEFAULT_THREADS_SHOW } from '../../session/session-store.js';
import { RouteToolbar } from './route-toolbar.tsx';

/**
 * The toolbar measures its own height (#38). The view uses it for the sticky offset of the stops column.
 * Check why the measurement exists: when toolbar text wraps,
 * the offset follows it instead of diverging from a hardcoded constant.
 */

const DATA = fixtureIteration('medium');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Observers created during the test. The test triggers them because jsdom has no layout. */
let observers: (() => void)[] = [];
let height = 0;

class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void {
        observers.push(this.callback);
    }
    unobserve(): void {
        // Observation ends only when the observer disconnects.
    }
    disconnect(): void {
        observers = observers.filter((callback) => callback !== this.callback);
    }
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    observers = [];
    vi.restoreAllMocks();
});

function mount(onHeight: (value: number) => void): void {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        height,
        width: 0,
        top: 0,
        bottom: height,
        left: 0,
        right: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    }));

    const filters = buildFileFilters({
        files: DATA.diff.files,
        ownership: DATA.ownership,
        extra: DATA.extraLenses,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <RouteToolbar
                store={createDiffViewStore({ files: DATA.diff.files, storage: null })}
                preset="triage"
                onPreset={() => undefined}
                filters={filters}
                filter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                threadsShow={DEFAULT_THREADS_SHOW}
                threadCounts={{ people: 0, bots: 0, resolved: 0 }}
                onThreadsShow={() => undefined}
                strip={null}
                onHeight={onHeight}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
}

describe('route toolbar height', () => {
    it('measures on mount without waiting for the first observer event', () => {
        const heights: number[] = [];
        height = 99;
        mount((value) => heights.push(value));

        expect(heights).toEqual([99]);
    });

    it('passes toolbar line wrapping through to the view', () => {
        const heights: number[] = [];
        height = 99;
        mount((value) => heights.push(value));

        height = 141;
        act(() => {
            for (const report of observers) {
                report();
            }
        });

        expect(heights.at(-1)).toBe(141);
    });
});
