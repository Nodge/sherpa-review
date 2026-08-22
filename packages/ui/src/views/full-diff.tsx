import type { PrDiff, PrMeta } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { fetchFileContent, fetchReviewDiff, fetchReviewPr, openInEditor } from '../api.js';
import type { DiffClient } from '../diff/client.js';
import { createDiffClient } from '../diff/client.js';
import { toParseRequest } from '../diff/model.js';
import type { Feedback } from '../diff-view/file-card.tsx';
import { DiffFileList } from '../diff-view/file-list.tsx';
import type { DiffViewStore } from '../diff-view/store.js';
import { createDiffViewStore } from '../diff-view/store.js';
import '../diff-view/diff-view.css';
import { readFragmentParam } from '../fragment.js';

/**
 * "Full diff" view (README §10): file cards backed by live review endpoints. The file tree,
 * filter lenses and header text from README §10 arrive with M1-T7. For now, this is just the right side
 * and a quiet diff mode toggle.
 */

interface Loaded {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
}

export function FullDiffView({ token }: { token: string }) {
    const [state, setState] = useState<{ loaded: Loaded | null; error: string | null }>({
        loaded: null,
        error: null,
    });

    useEffect(() => {
        let alive = true;
        void Promise.all([fetchReviewPr(token), fetchReviewDiff(token)]).then(
            ([pr, diff]) => {
                if (alive) {
                    setState({ loaded: { pr, diff }, error: null });
                }
            },
            (error: unknown) => {
                if (alive) {
                    setState({ loaded: null, error: error instanceof Error ? error.message : String(error) });
                }
            },
        );
        return () => {
            alive = false;
        };
    }, [token]);

    if (state.error !== null) {
        return (
            <main className="diff-view">
                <div className="diff-view__toolbar">
                    <h1 className="diff-view__title">Full diff</h1>
                </div>
                <p className="diff-view__status">{state.error}</p>
            </main>
        );
    }

    if (state.loaded === null) {
        return (
            <main className="diff-view">
                <div className="diff-view__toolbar">
                    <h1 className="diff-view__title">Full diff</h1>
                </div>
                <p className="diff-view__status">Loading the diff…</p>
            </main>
        );
    }

    return <DiffWorkspace token={token} loaded={state.loaded} />;
}

function DiffWorkspace({ token, loaded }: { token: string; loaded: Loaded }) {
    const { pr, diff } = loaded;
    const store = useMemo(() => createDiffViewStore({ files: diff.files }), [diff]);

    // One worker per view, started on the first parse and closed with the view. Use a ref instead of
    // `useMemo`: a closed client cannot restart, and StrictMode mounts the view twice.
    const clientRef = useRef<DiffClient | null>(null);
    useEffect(
        () => () => {
            clientRef.current?.close();
            clientRef.current = null;
        },
        [],
    );

    const parse = useCallback(
        (file: PrDiff['files'][number]) => {
            clientRef.current ??= createDiffClient();
            return clientRef.current.parseFile(diff.diffId, toParseRequest(file));
        },
        [diff.diffId],
    );
    const loadContent = useCallback((fileId: string) => fetchFileContent(token, fileId), [token]);
    const openFileInEditor = useCallback(
        async (path: string): Promise<Feedback> => {
            const result = await openInEditor(token, path);
            return result.outcome === 'opened' ? null : result.message;
        },
        [token],
    );

    return (
        <main className="diff-view">
            <Toolbar store={store} files={diff.files.length} />
            <DiffFileList
                files={diff.files}
                store={store}
                contentAvailable={pr.capabilities.fileContent}
                parse={parse}
                loadContent={loadContent}
                onOpenInEditor={openFileInEditor}
                initialFileId={readFragmentParam(window.location.hash, 'file')}
            />
        </main>
    );
}

/** The diff mode toggle is "deliberately quiet" (README §1), global across all views (SPEC §2.6). */
function Toolbar({ store, files }: { store: DiffViewStore; files: number }) {
    const { diffMode, splitAvailable, effectiveMode } = useSyncExternalStore(store.subscribe, store.getSnapshot);

    return (
        <div className="diff-view__toolbar">
            <h1 className="diff-view__title">Full diff</h1>
            {/* Below 1100px there is no choice (SPEC §2.6). The label always names the mode
                currently rendering the diff, rather than the user's deferred choice. */}
            <button
                type="button"
                className="diff-view__mode"
                disabled={!splitAvailable}
                title={splitAvailable ? undefined : 'not enough width for side by side'}
                onClick={() => {
                    store.setDiffMode(diffMode === 'unified' ? 'split' : 'unified');
                }}
            >
                ⇄ {effectiveMode === 'unified' ? 'unified' : 'side by side'}
            </button>
            <span className="diff-view__status">{files} files</span>
        </div>
    );
}
