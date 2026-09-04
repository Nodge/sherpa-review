import type { UiSettings } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { UiSettingsStore } from './settings-store.js';
import { createUiSettingsStore } from './settings-store.js';

/**
 * Fallback for a tree without a provider (gallery, component tests). Settings must not require
 * require the network. One store per module, never one per hook call:
 * a component using both the store and snapshot would write to one instance and read from another.
 * A test needing isolation can wrap the tree in `SettingsProvider`.
 */
const fallbackStore = createUiSettingsStore({ loaded: true });

/** One global settings store per page, with the provider near the root (`main.tsx`). */
const SettingsContext = createContext<UiSettingsStore>(fallbackStore);

export function SettingsProvider({ store, children }: { store: UiSettingsStore; children: ReactNode }) {
    return <SettingsContext.Provider value={store}>{children}</SettingsContext.Provider>;
}

export function useUiSettingsStore(): UiSettingsStore {
    return useContext(SettingsContext);
}

export function useUiSettings(): UiSettings {
    const store = useUiSettingsStore();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Whether the server has responded. Until then, the snapshot holds defaults, not the reviewer's choice. */
export function useUiSettingsLoaded(): boolean {
    const store = useUiSettingsStore();
    return useSyncExternalStore(store.subscribe, store.isLoaded, store.isLoaded);
}
