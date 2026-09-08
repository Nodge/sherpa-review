import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Image byte transport. The card knows nothing about the token or `fetch`.
 * `App` supplies it over `fetchBlob` in the application. The gallery and tests use a fixture.
 *
 * `null` means the host has no blobs (`capabilities.blobs` is off). The image card does not render,
 * and the binary file keeps its regular notice.
 */
export type BlobLoader = (blobId: string) => Promise<Blob | null>;

const BlobLoaderContext = createContext<BlobLoader | null>(null);

export function BlobLoaderProvider({ loadBlob, children }: { loadBlob: BlobLoader | null; children: ReactNode }) {
    return <BlobLoaderContext value={loadBlob}>{children}</BlobLoaderContext>;
}

export function useBlobLoader(): BlobLoader | null {
    return useContext(BlobLoaderContext);
}
