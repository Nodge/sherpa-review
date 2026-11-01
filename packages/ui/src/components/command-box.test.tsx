// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandBox } from './command-box.tsx';

/**
 * Copy feedback is visible, not just announced by a screen reader. Success changes the button label
 * for a couple of seconds, and the fallback without Clipboard API adds a line below the command.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMAND = '/sherpa-review fixture-4821';

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
    setClipboard(undefined);
});

/** `undefined` means the browser has no Clipboard API. */
function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

function mount(): { readonly host: HTMLElement; readonly button: HTMLButtonElement } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
        root.render(<CommandBox command={COMMAND} hint="Run in any harness." />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const button = host.querySelector<HTMLButtonElement>('.command-box__action');
    if (button === null) {
        throw new Error('command box has no copy button');
    }
    return { host, button };
}

/** Visible button label. The second, hidden label preserves width and does not count. */
function visibleLabel(button: HTMLButtonElement): string {
    return [...button.querySelectorAll('.command-box__action-label')]
        .filter((label) => !label.classList.contains('command-box__action-label--ghost'))
        .map((label) => label.textContent)
        .join('');
}

function liveRegion(host: HTMLElement): HTMLElement {
    const region = host.querySelector<HTMLElement>('[aria-live="polite"]');
    if (region === null) {
        throw new Error('command box has no feedback region');
    }
    return region;
}

describe('command box', () => {
    it('temporarily shows "Copied" after a successful copy', async () => {
        vi.useFakeTimers();
        const written: string[] = [];
        setClipboard({
            writeText: (text: string) => {
                written.push(text);
                return Promise.resolve();
            },
        });
        const { host, button } = mount();

        expect(visibleLabel(button)).toBe('Copy');

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        expect(written).toEqual([COMMAND]);
        expect(visibleLabel(button)).toBe('Copied');
        expect(liveRegion(host).textContent).toBe('Command copied');
        // Both labels are always in the markup. The hidden one preserves the button width.
        expect(button.querySelectorAll('.command-box__action-label')).toHaveLength(2);
    });

    it('resets feedback on a timer', async () => {
        vi.useFakeTimers();
        setClipboard({ writeText: () => Promise.resolve() });
        const { host, button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        expect(visibleLabel(button)).toBe('Copy');
        expect(liveRegion(host).textContent).toBe('');
    });

    it('selects the command and shows the fallback message without Clipboard API', async () => {
        setClipboard(undefined);
        const { host, button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        const input = host.querySelector<HTMLInputElement>('.command-box__command');
        expect(input?.selectionEnd).toBe(COMMAND.length);

        const region = liveRegion(host);
        expect(region.textContent).toBe('The command is selected — copy it manually');
        expect(region.className).toBe('command-box__fallback');
    });

    it('uses the same fallback when Clipboard API fails', async () => {
        setClipboard({ writeText: () => Promise.reject(new Error('access denied')) });
        const { host, button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        expect(liveRegion(host).textContent).toBe('The command is selected — copy it manually');
    });

    it('clears the timer on unmount', async () => {
        vi.useFakeTimers();
        setClipboard({ writeText: () => Promise.resolve() });
        const { button } = mount();

        await act(async () => {
            button.click();
            await Promise.resolve();
        });

        const clear = vi.spyOn(window, 'clearTimeout');
        for (const unmount of mounted.splice(0)) {
            unmount();
        }

        expect(clear).toHaveBeenCalled();
        clear.mockRestore();
    });
});
