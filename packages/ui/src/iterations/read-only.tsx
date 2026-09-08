import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

import type { MessageKey } from '../i18n/index.js';
import { useT } from '../i18n/index.js';

/**
 * Read-only mode for a previous iteration: commenting, marking viewed
 * and shipping are allowed only in the active iteration. Context distributes the flag instead of props:
 * leaf components in all 3 views read it, including the composer, toggles, selection popover and ship panel,
 * and passing the flag through every render layer costs more than reading it where needed.
 *
 * Outside the provider (gallery, component tests), this mode is off. States must render
 * without App.
 */

/** Reason a control is disabled: one text for all locations (`title` and labels). */
export const READ_ONLY_REASON: MessageKey = 'iteration.readOnly.reason';

/** A slice between iterations has a separate `fileId` namespace with nothing to write to. */
export const SLICE_READ_ONLY_REASON: MessageKey = 'iteration.readOnly.sliceReason';

interface ReadOnlyIteration {
    readonly readOnly: boolean;
    readonly reason: MessageKey;
}

const ReadOnlyIterationContext = createContext<ReadOnlyIteration>({ readOnly: false, reason: READ_ONLY_REASON });

export function ReadOnlyIterationProvider({
    readOnly,
    reason = READ_ONLY_REASON,
    children,
}: {
    readOnly: boolean;
    /** Why controls are disabled: snapshots and slices have different reasons. */
    reason?: MessageKey;
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
    return useT()(useContext(ReadOnlyIterationContext).reason);
}
