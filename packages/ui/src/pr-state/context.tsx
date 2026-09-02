import type { UiPrState } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { UiPrStateStore } from './pr-state-store.js';
import { createUiPrStateStore } from './pr-state-store.js';

/**
 * Fallback for a tree without a provider (gallery, component tests): rendering collapse state must not
 * require the network. One store per module, never one per hook call:
 * a component using both the store and snapshot would write to one instance and read from another.
 * Tests that need their own isolation can wrap the tree in `PrStateProvider`.
 */
const fallbackStore = createUiPrStateStore();

/** One PR state store per page. The provider sits at the root (`main.tsx`). */
const PrStateContext = createContext<UiPrStateStore>(fallbackStore);

export function PrStateProvider({ store, children }: { store: UiPrStateStore; children: ReactNode }) {
    return <PrStateContext.Provider value={store}>{children}</PrStateContext.Provider>;
}

export function usePrStateStore(): UiPrStateStore {
    return useContext(PrStateContext);
}

export function usePrState(): UiPrState {
    const store = usePrStateStore();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
