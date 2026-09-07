import { useCallback, useRef } from 'react';

import { ALL_FILTER_ID } from '../filters/lens-filters.js';
import type { SessionStore } from '../session/session-store.js';

export interface AuditFilterResult {
    /** Full diff supplies its filter-change handler here while the file list is on screen. */
    readonly setDiffFilterHandler: (handler: ((id: string) => void) | null) => void;
    readonly showAllAuditFiles: () => void;
}

/** "Show all files" in the audit banner: the component that renders the list clears the filter. */
export function useAuditFilter(session: SessionStore): AuditFilterResult {
    const diffFilterHandler = useRef<((id: string) => void) | null>(null);
    const setDiffFilterHandler = useCallback((handler: ((id: string) => void) | null) => {
        diffFilterHandler.current = handler;
    }, []);
    const showAllAuditFiles = useCallback(() => {
        const handler = diffFilterHandler.current;
        if (handler === null) {
            // While Full diff is loading, there is nothing to preserve. Neither the list nor its top card is on screen.
            session.setFilter(ALL_FILTER_ID);
            return;
        }
        handler(ALL_FILTER_ID);
    }, [session]);

    return { setDiffFilterHandler, showAllAuditFiles };
}
