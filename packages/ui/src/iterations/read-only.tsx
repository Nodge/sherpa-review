import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Read-only mode for a previous iteration (M4-T9, M4 boundaries): commenting, marking viewed
 * and shipping are allowed only in the active iteration. Context distributes the flag instead of props:
 * leaf components in 3 views read it (composer, viewed marks, selection popover, ship bar),
 * and passing the flag through every render layer costs more than reading it where needed.
 *
 * Outside the provider (gallery, component tests), this mode is off. States must render
 * without App.
 */

const ReadOnlyIterationContext = createContext(false);

/** Reason a control is disabled: one text for all locations (`title` and labels). */
export const READ_ONLY_REASON = 'only in the active iteration';

export function ReadOnlyIterationProvider({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
    return <ReadOnlyIterationContext value={readOnly}>{children}</ReadOnlyIterationContext>;
}

export function useReadOnlyIteration(): boolean {
    return useContext(ReadOnlyIterationContext);
}
