import { fixtureIteration, makeFixtureHost } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { BlobLoader } from '../../diff-view/blob-loader.tsx';
import { BlobLoaderProvider } from '../../diff-view/blob-loader.tsx';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import type { ImageBodyState } from '../../diff-view/image-card.tsx';
import { readStateOf } from '../../progress/read-state.js';
import '../../diff-view/diff-view.css';

/**
 * M5-T24: image cards using images from the `medium` fixture. Bytes come from `FixtureHost`.
 * The gallery needs no server or token. Loading and error states use transports that
 * stay pending for loading and fail for errors, so the frames are deterministic without timers.
 */

const MEDIUM = fixtureIteration('medium');
const HOST = makeFixtureHost('medium');
const GET_BLOB = HOST.getBlob ?? ((): Promise<Uint8Array | null> => Promise.resolve(null));

function imageFile(path: string): FileDiff {
    const file = MEDIUM.diff.files.find((candidate) => candidate.path.endsWith(path));
    if (file?.image == null) {
        throw new Error(`the medium fixture needs image ${path}`);
    }
    return file;
}

const PNG = imageFile('edit-window-banner.png');
const SVG = imageFile('countdown-icon.svg');
const DELETED = imageFile('legacy-window-badge.png');

/** A side over `IMAGE_BLOB_MAX_BYTES`. The fixture has no such bytes, so the size is set by hand. */
const TOO_LARGE: FileDiff = {
    ...PNG,
    image: PNG.image === null ? null : { ...PNG.image, after: { blobId: 'blob:too-large', size: 12_000_000 } },
};

function fixtureLoader(mime: string): BlobLoader {
    return async (blobId) => {
        const bytes = await GET_BLOB(blobId);
        if (bytes === null) {
            return null;
        }
        // Copy into a buffer we own: the host `Uint8Array` is typed with `ArrayBufferLike`.
        const owned = new Uint8Array(bytes.length);
        owned.set(bytes);
        return new Blob([owned], { type: mime });
    };
}

const PNG_LOADER = fixtureLoader('image/png');
const SVG_LOADER = fixtureLoader('image/svg+xml');
const FAILING_LOADER: BlobLoader = () => Promise.reject(new Error('the blob endpoint returned 500'));
const PENDING_LOADER: BlobLoader = () => new Promise(() => undefined);

const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: () => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

function ImageCardState({
    file,
    loadBlob,
    initial,
}: {
    file: FileDiff;
    loadBlob: BlobLoader;
    initial?: ImageBodyState;
}) {
    return (
        <div className="gallery__viewport">
            <BlobLoaderProvider loadBlob={loadBlob}>
                <FileCard
                    file={file}
                    model={parseFileDiff(toParseRequest(file))}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file, record: null })}
                    opened
                    showWhitespace={false}
                    selection={null}
                    actions={ACTIONS}
                    initialImage={initial}
                />
            </BlobLoaderProvider>
        </div>
    );
}

export const M5_T24_STATES: readonly {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}[] = [
    {
        id: 'image-two-up-modify',
        title: '2-up: png change, both sides',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} />,
    },
    {
        id: 'image-two-up-add',
        title: '2-up: added svg, Before is a placeholder',
        render: () => <ImageCardState file={SVG} loadBlob={SVG_LOADER} />,
    },
    {
        id: 'image-two-up-delete',
        title: '2-up: deleted png, After is a placeholder',
        render: () => <ImageCardState file={DELETED} loadBlob={PNG_LOADER} />,
    },
    {
        id: 'image-swipe',
        title: 'Swipe: divider at 35 %',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ mode: 'swipe', swipe: 35 }} />,
    },
    {
        id: 'image-onion',
        title: 'Onion Skin: 50 % opacity',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ mode: 'onion', onion: 50 }} />,
    },
    {
        id: 'image-text-svg',
        title: 'Text: svg patch lines',
        render: () => <ImageCardState file={SVG} loadBlob={SVG_LOADER} initial={{ mode: 'text' }} />,
    },
    {
        id: 'image-actual-size',
        title: '1:1: scale without fitting',
        render: () => <ImageCardState file={PNG} loadBlob={PNG_LOADER} initial={{ fit: 'actual' }} />,
    },
    {
        id: 'image-too-large',
        title: 'oversized side: no loading, host link',
        render: () => <ImageCardState file={TOO_LARGE} loadBlob={PNG_LOADER} />,
    },
    {
        id: 'image-failed',
        title: 'blob endpoint failed: Retry',
        render: () => <ImageCardState file={PNG} loadBlob={FAILING_LOADER} />,
    },
    {
        id: 'image-loading',
        title: 'bytes still in transit',
        render: () => <ImageCardState file={PNG} loadBlob={PENDING_LOADER} />,
    },
];
