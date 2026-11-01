// @vitest-environment jsdom
import type { UiState } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.tsx';
import { PrStateProvider } from './pr-state/context.tsx';
import { createUiPrStateStore } from './pr-state/pr-state-store.js';
import { createSessionStore } from './session/session-store.js';
import { ShortcutsProvider } from './shortcuts/context.tsx';
import { createShortcutRegistry } from './shortcuts/registry.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * The "Check for updates" command is in the App palette only when the snapshot has an update
 * channel (`uiState.updateChannel`): without a channel there is nothing to check with.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no scrollIntoView, and the palette scrolls the list to the selected item.
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    return undefined;
};

const COMMAND = 'Check for updates';

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function uiState(updateChannel: boolean): UiState {
    return {
        prKey: 'fixture-4821',
        worker: { kind: 'never' },
        tasks: [],
        reviewHost: null,
        pr: null,
        feedback: null,
        iterations: [],
        update: null,
        updateChannel,
        generationCap: null,
    };
}

function snapshot(state: UiState): StoreSnapshot {
    return {
        connection: 'online',
        state,
        error: null,
        progressRevision: null,
        threadsRevision: null,
        routeRevision: null,
        chatRevision: null,
    };
}

/** A store whose snapshot is swapped by hand, as over SSE. */
function fakeStore(initial: StoreSnapshot): Store & { readonly push: (next: StoreSnapshot) => void } {
    let current = initial;
    const listeners = new Set<() => void>();
    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => current,
        close: () => undefined,
        push: (next) => {
            current = next;
            for (const listener of listeners) {
                listener();
            }
        },
    };
}

/** App with the palette open and the command name typed into it. Providers as in main.tsx. */
function mountWithPalette(store: Store): void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const session = createSessionStore({ initial: { view: 'overview', filter: 'all', paletteOpen: true } });

    act(() => {
        root.render(
            <ShortcutsProvider registry={createShortcutRegistry()}>
                <PrStateProvider store={createUiPrStateStore()}>
                    <App store={store} session={session} token="t-1" />
                </PrStateProvider>
            </ShortcutsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const input = document.querySelector<HTMLInputElement>('.command-palette__query');
    if (input === null) {
        throw new Error('the palette did not open');
    }
    act(() => {
        // React tracks the value through its own descriptor: write past it, or onChange sees no change.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, COMMAND);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function hasCommand(): boolean {
    return [...document.querySelectorAll('.command-palette__item-label')].some(
        (label) => label.textContent === COMMAND,
    );
}

describe('the "Check for updates" command in App', () => {
    it('is absent from the palette without an update channel', () => {
        mountWithPalette(fakeStore(snapshot(uiState(false))));

        expect(hasCommand()).toBe(false);
    });

    it('is present with a channel', () => {
        mountWithPalette(fakeStore(snapshot(uiState(true))));

        expect(hasCommand()).toBe(true);
    });

    it('appears when a snapshot with a channel arrives after loading', () => {
        const store = fakeStore(snapshot(uiState(false)));
        mountWithPalette(store);
        expect(hasCommand()).toBe(false);

        act(() => {
            store.push(snapshot(uiState(true)));
        });

        expect(hasCommand()).toBe(true);
    });
});
