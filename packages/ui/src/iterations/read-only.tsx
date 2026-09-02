import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

/**
 * Read-only mode for a previous iteration (M4-T9, M4 boundaries): commenting, marking viewed
 * and shipping are allowed only in the active iteration. Context distributes the flag instead of props:
 * leaf components in 3 views read it (composer, viewed marks, selection popover, ship bar),
 * and passing the flag through every render layer costs more than reading it where needed.
 *
 * Outside the provider (gallery, component tests), this mode is off. States must render
 * without App.
 */

/** Reason a control is disabled: one text for all locations (`title` and labels). */
export const READ_ONLY_REASON = 'only in the active iteration';

/** Slice between iterations (M4-T12): a different `fileId` namespace with nothing to write to. */
export const SLICE_READ_ONLY_REASON = 'in a slice between iterations';

interface ReadOnlyIteration {
    readonly readOnly: boolean;
    readonly reason: string;
}

const ReadOnlyIterationContext = createContext<ReadOnlyIteration>({ readOnly: false, reason: READ_ONLY_REASON });

export function ReadOnlyIterationProvider({
    readOnly,
    reason = READ_ONLY_REASON,
    children,
}: {
    readOnly: boolean;
    /** Why controls are disabled: snapshots and slices have different reasons. */
    reason?: string;
    children: ReactNode;
}) {
    // Memoize the value: the provider is at the App root and renders on every state change,
    // and a new object would wake the context in every diff line, bypassing their `memo`.
    const value = useMemo(() => ({ readOnly, reason }), [readOnly, reason]);
    return <ReadOnlyIterationContext value={value}>{children}</ReadOnlyIterationContext>;
}

export function useReadOnlyIteration(): boolean {
    return useContext(ReadOnlyIterationContext).readOnly;
}

/** The `title` text for a disabled control depends on the selected view. */
export function useReadOnlyReason(): string {
    return useContext(ReadOnlyIterationContext).reason;
}
