// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PrStateProvider } from '../pr-state/context.tsx';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import { CommandPalette } from './command-palette.tsx';

/**
 * A command that replies inside the palette (M5-T9): "Check for updates" asks the palette
 * to stay open (`keepOpen`) and puts its reply in the hint area and live region.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom cannot scroll, and the palette scrolls the list itself to the cursor.
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    return undefined;
};

const STATUS = '0.5.0 available';

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function Harness() {
    const [status, setStatus] = useState<string | null>(null);
    const [open, setOpen] = useState(true);
    const [registry] = useState(() => {
        const created = createShortcutRegistry();
        created.register({
            id: 'update.check',
            keys: [],
            group: 'palette.group.sherpa',
            label: 'shortcut.update.check',
            keepOpen: true,
            action: () => {
                setStatus(STATUS);
            },
        });
        return created;
    });
    const [prState] = useState(() => createUiPrStateStore());

    return (
        <ShortcutsProvider registry={registry}>
            <PrStateProvider store={prState}>
                <CommandPalette
                    open={open}
                    source={null}
                    initialQuery="Check"
                    status={status}
                    onStatusHandled={() => {
                        setStatus(null);
                    }}
                    onOpen={() => {
                        setOpen(true);
                    }}
                    onClose={() => {
                        setOpen(false);
                    }}
                />
            </PrStateProvider>
        </ShortcutsProvider>
    );
}

function mount(): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<Harness />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function command(host: HTMLElement): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>('.command-palette__item');
    if (button === null) {
        throw new Error('no command in the palette results');
    }
    return button;
}

describe('command status line in the palette', () => {
    it('keeps the palette open and prints the reply for a command with keepOpen', () => {
        const host = mount();
        expect(command(host).textContent).toContain('Check for updates');

        act(() => {
            command(host).click();
        });

        expect(host.querySelector('.command-palette')).not.toBeNull();
        expect(host.querySelector('.command-palette__notice')?.textContent).toBe(STATUS);
        expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe(STATUS);
    });

    it('clears the reply when the query changes', () => {
        const host = mount();
        act(() => {
            command(host).click();
        });

        const input = host.querySelector<HTMLInputElement>('.command-palette__query');
        if (input === null) {
            throw new Error('no query input in the palette');
        }
        act(() => {
            // React tracks the value through its own descriptor, so write past it,
            // otherwise onChange considers the value unchanged.
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Chec');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        expect(host.querySelector('.command-palette__notice')).toBeNull();
    });
});
