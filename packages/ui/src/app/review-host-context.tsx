import type { UiReviewHost } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Review host description (`uiState.reviewHost`) for components that need to name the host in text.
 * `App` provides it in the app, the frame in the gallery and tests. `null` means no host.
 */
const ReviewHostContext = createContext<UiReviewHost | null>(null);

export function ReviewHostProvider({ value, children }: { value: UiReviewHost | null; children: ReactNode }) {
    return <ReviewHostContext value={value}>{children}</ReviewHostContext>;
}

export function useReviewHost(): UiReviewHost | null {
    return useContext(ReviewHostContext);
}
