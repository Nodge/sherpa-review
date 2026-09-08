// @vitest-environment jsdom
import type { UiUpdate } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { useUpdateToast } from './update-state.js';
import { UpdateToast } from './update-toast.tsx';

/**
 * Update toast behaviour: delay before appearing, "Later" until the tab reloads,
 * "Don't remind me" in global settings and Esc while focus is inside the toast.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE: UiUpdate = {
    current: '0.4.0',
    latest: '0.5.0',
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: 'Update toast and shortcuts sheet.',
    
};

const COPY: UiUpdate = {
    ...UPDATE,
    install: { kind: 'copy', dir: '/opt/sherpa/skill', command: null },
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
});

/** Miniature app: server snapshot at the top, toast and its state inside. */
function Harness({ update }: { update: UiUpdate | null }) {
    const toast = useUpdateToast(update);
    return (
        <>
            {toast.visible && update !== null ? (
                <UpdateToast update={update} onLater={toast.later} onDismissVersion={toast.dismissVersion} />
            ) : null}
            <button type="button" className="version" onClick={toast.reopen}>
                0.4.0
            </button>
        </>
    );
}

function mount(update: UiUpdate | null, settings?: UiSettingsStore): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const harness = <Harness update={update} />;
    act(() => {
        root.render(
            settings === undefined ? harness : <SettingsProvider store={settings}>{harness}</SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function toastOf(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('.update-toast');
}

function click(host: HTMLElement, selector: string): void {
    const element = host.querySelector<HTMLElement>(selector);
    if (element === null) {
        throw new Error(`toast has no ${selector}`);
    }
    act(() => {
        element.click();
    });
}

describe('update toast', () => {
    it('appears one and a half seconds after an update arrives', () => {
        vi.useFakeTimers();
        const host = mount(UPDATE);

        expect(toastOf(host)).toBeNull();
        act(() => {
            vi.advanceTimersByTime(1499);
        });
        expect(toastOf(host)).toBeNull();

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(toastOf(host)?.getAttribute('role')).toBe('status');
        expect(toastOf(host)?.textContent).toContain('Sherpa 0.5.0 is available');
        expect(toastOf(host)?.textContent).toContain('you have 0.4.0');
    });

    it('does not start a timer without an update', () => {
        vi.useFakeTimers();
        const host = mount(null);

        act(() => {
            vi.advanceTimersByTime(5000);
        });

        expect(toastOf(host)).toBeNull();
    });

    it('"Later" hides the toast and clicking the version brings it back', () => {
        vi.useFakeTimers();
        const host = mount(UPDATE);
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        click(host, '.update-toast__close');
        expect(toastOf(host)).toBeNull();

        click(host, '.version');
        expect(toastOf(host)).not.toBeNull();
    });

    it('Esc with focus inside the toast works as "Later"', () => {
        vi.useFakeTimers();
        const host = mount(UPDATE);
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        // Focus outside: Esc belongs to other layers, so the toast does not take it.
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(toastOf(host)).not.toBeNull();

        host.querySelector<HTMLButtonElement>('.update-toast__how')?.focus();
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(toastOf(host)).toBeNull();
    });

    it('"Don\'t remind me" puts the version in global settings', async () => {
        vi.useFakeTimers();
        const patches: unknown[] = [];
        const settings = createUiSettingsStore({
            send: (patch) => {
                patches.push(patch);
                return Promise.reject(new Error('writing is not tested here'));
            },
        });
        const host = mount(UPDATE, settings);
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        click(host, '.update-toast__dismiss');
        // Writes form a promise chain, so microtasks need to run.
        await act(async () => {
            await Promise.resolve();
        });

        expect(patches).toEqual([{ updates: { dismissedVersion: '0.5.0' } }]);
        expect(settings.getSnapshot().updates).toEqual({ dismissedVersion: '0.5.0' });
    });

    it('"How to update" shows a command for a checkout and a directory and README for a copy', () => {
        vi.useFakeTimers();
        const checkout = mount(UPDATE);
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        click(checkout, '.update-toast__how');

        expect(checkout.querySelector<HTMLInputElement>('.command-box__command')?.value).toBe(
            "cd '/Users/x/quillmart' && git pull",
        );

        const copy = mount(COPY);
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        click(copy, '.update-toast__how');

        expect(copy.querySelector('.command-box')).toBeNull();
        expect(copy.querySelector('.update-toast__copy-dir')?.textContent).toContain('/opt/sherpa/skill');
        expect(copy.querySelector<HTMLAnchorElement>('.update-toast__readme')?.href).toContain('/tools/sherpa/README.md');
    });

    it('does not render a body without "what is new"', () => {
        vi.useFakeTimers();
        const host = mount({ ...UPDATE, whatsNew: null });
        act(() => {
            vi.advanceTimersByTime(1500);
        });

        expect(host.querySelector('.update-toast__body')).toBeNull();
    });
});
