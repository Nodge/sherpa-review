import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * The review adapter name (`uiState.reviewHost`) for components that need to name the host in copy:
 * `App` provides it in the app, the frame in the gallery and tests. `null` means no host.
 */
const ReviewHostContext = createContext<string | null>(null);

export function ReviewHostProvider({ value, children }: { value: string | null; children: ReactNode }) {
    return <ReviewHostContext value={value}>{children}</ReviewHostContext>;
}

export function useReviewHost(): string | null {
    return useContext(ReviewHostContext);
}
