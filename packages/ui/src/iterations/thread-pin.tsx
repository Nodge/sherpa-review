import type { Thread, ThreadPin } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Thread pinned to the commit it was written on (SPEC §2.17, §4.5): a "pinned to 9f3c1ab" chip
 * and "Show on old commit" action. Context distributes the flag instead of props: the chip
 * renders in a leaf (`ThreadBlock`) in 3 views and the "outside diff" group, while knowledge of the active
 * iteration and navigation live in App.
 *
 * Outside the provider (gallery, component tests), the active iteration is unknown, so there is no chip
 * or action. A pin tells the reviewer nothing without a comparison with the active iteration.
 */

export interface ThreadPinContextValue {
    /** Active PR iteration. null means unknown. */
    readonly activeDiffId: string | null;
    /** Iteration of the rendered diff. null means active. */
    readonly viewingDiffId: string | null;
    /** Open the thread on its pinned iteration. null means navigation is unavailable (gallery, tests). */
    readonly openAtPin: ((diffId: string, threadId: string) => void) | null;
}

const EMPTY: ThreadPinContextValue = { activeDiffId: null, viewingDiffId: null, openAtPin: null };

const ThreadPinContext = createContext<ThreadPinContextValue>(EMPTY);

export function ThreadPinProvider({ value, children }: { value: ThreadPinContextValue; children: ReactNode }) {
    return <ThreadPinContext value={value}>{children}</ThreadPinContext>;
}

export function useThreadPinContext(): ThreadPinContextValue {
    return useContext(ThreadPinContext);
}

export interface ThreadPinState {
    readonly pin: ThreadPin;
    /** Navigate to the pinned iteration. null means already viewing it or navigation is unavailable. */
    readonly open: (() => void) | null;
}

/**
 * A pin worth showing the reviewer: the thread was written on a different iteration from the current PR.
 * If it matches the active iteration, the comment is beside its code and needs no explanation.
 */
export function useThreadPin(thread: Thread): ThreadPinState | null {
    const context = useThreadPinContext();
    const pin = thread.pinnedTo;
    if (pin === null || context.activeDiffId === null || pin.diffId === context.activeDiffId) {
        return null;
    }
    const openAtPin = context.openAtPin;
    if (openAtPin === null || pin.diffId === (context.viewingDiffId ?? context.activeDiffId)) {
        return { pin, open: null };
    }
    return {
        pin,
        open: () => {
            openAtPin(pin.diffId, thread.id);
        },
    };
}
