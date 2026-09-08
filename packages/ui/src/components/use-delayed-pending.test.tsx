// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PENDING_DELAY_MS, useDelayedPending } from './use-delayed-pending.js';

/** docs/design/SPEC-elements.md §3 policy: pending indicator does not flash on a fast response and hides without delay. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
});

function mount(pending: boolean, delayMs?: number) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (next: boolean, nextDelay = delayMs): void => {
        act(() => {
            root.render(<Probe pending={next} delayMs={nextDelay} />);
        });
    };
    render(pending);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { shown: (): boolean => host.textContent === 'yes', render };
}

function Probe({ pending, delayMs }: { pending: boolean; delayMs?: number | undefined }) {
    return <>{useDelayedPending(pending, delayMs) ? 'yes' : 'no'}</>;
}

describe('useDelayedPending', () => {
    it('stays hidden before the threshold and appears after it', () => {
        const probe = mount(true);

        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(PENDING_DELAY_MS - 1);
        });
        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(probe.shown()).toBe(true);
    });

    it('never flashes during a short wait', () => {
        const probe = mount(true);

        act(() => {
            vi.advanceTimersByTime(120);
        });
        probe.render(false);

        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(probe.shown()).toBe(false);
    });

    it('hides immediately and starts the threshold countdown anew for a new wait', () => {
        const probe = mount(true);
        act(() => {
            vi.advanceTimersByTime(PENDING_DELAY_MS);
        });
        expect(probe.shown()).toBe(true);

        probe.render(false);
        expect(probe.shown()).toBe(false);

        probe.render(true);
        expect(probe.shown()).toBe(false);
        act(() => {
            vi.advanceTimersByTime(PENDING_DELAY_MS);
        });
        expect(probe.shown()).toBe(true);
    });

    it('shows the indicator on the first frame with zero delay', () => {
        expect(mount(true, 0).shown()).toBe(true);
        expect(mount(false, 0).shown()).toBe(false);
    });
});
