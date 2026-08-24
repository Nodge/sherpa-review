import type { PrDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import './app.css';
import { fetchReviewDiff } from './api.js';
import { agentPillView } from './components/agent-pill-view.js';
import { TopBar } from './components/top-bar.tsx';
import { createDiffViewStore } from './diff-view/store.js';
import { CommandPalette } from './palette/command-palette.tsx';
import type { PaletteDiffSource, PaletteNavigation, PaletteNavigationTarget } from './palette/diff-source.tsx';
import { breadcrumbFromPrKey } from './pr-key.js';
import type { SessionStore } from './session/session-store.js';
import type { Store } from './store.js';
import { UI_VERSION } from './version.js';
import { FullDiffView } from './views/full-diff.tsx';
import { ViewFrame } from './views/view-frames.tsx';

/**
 * Main page: top bar and active view. Both stores live outside the React tree
 * (requirements §1/C3): the server SSE store and the UI session state. The component only reads them
 * through `useSyncExternalStore`.
 */
export interface AppProps {
    readonly store: Store;
    readonly session: SessionStore;
    /** Access token from the URL fragment. Views use it to call review endpoints. */
    readonly token: string;
}

export function App({ store, session, token }: AppProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const { view, paletteOpen } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const reviewReady = snapshot.state !== null;
    const [diffState, setDiffState] = useState<{ token: string; diff: PrDiff | null; error: string | null }>({
        token,
        diff: null,
        error: null,
    });
    const currentDiff = diffState.token === token ? diffState.diff : null;
    const currentDiffError = diffState.token === token ? diffState.error : null;
    const [activeFileId, setActiveFileId] = useState<string | null>(null);
    const [paletteNavigation, setPaletteNavigation] = useState<PaletteNavigation | null>(null);
    const navigationId = useRef(0);

    // The palette is available in every view, so App loads the file list and raw patches.
    useEffect(() => {
        if (!reviewReady) {
            return;
        }
        let alive = true;
        void fetchReviewDiff(token).then(
            (diff) => {
                if (alive) {
                    setActiveFileId(null);
                    setPaletteNavigation(null);
                    setDiffState({ token, diff, error: null });
                }
            },
            (error: unknown) => {
                if (alive) {
                    setDiffState({
                        token,
                        diff: null,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            },
        );
        return () => {
            alive = false;
        };
    }, [reviewReady, token]);

    const diffStore = useMemo(
        () => (currentDiff === null ? null : createDiffViewStore({ files: currentDiff.files })),
        [currentDiff],
    );
    const navigateFromPalette = useCallback(
        (target: PaletteNavigationTarget) => {
            navigationId.current += 1;
            setPaletteNavigation({ id: navigationId.current, target });
            session.setView('diff');
        },
        [session],
    );
    const paletteSource = useMemo<PaletteDiffSource | null>(() => {
        if (currentDiff === null || diffStore === null) {
            return null;
        }
        return {
            files: currentDiff.files,
            activeFileId,
            goToFile: (fileId) => {
                navigateFromPalette({ kind: 'file', fileId });
            },
            goToLine: (fileId, side, line) => {
                navigateFromPalette({ kind: 'line', fileId, side, line });
            },
            toggleDiffMode: () => {
                const current = diffStore.getSnapshot().diffMode;
                diffStore.setDiffMode(current === 'unified' ? 'split' : 'unified');
            },
        };
    }, [activeFileId, currentDiff, diffStore, navigateFromPalette]);

    if (snapshot.connection === 'fatal') {
        return (
            <MessageScreen title="Sherpa stopped">
                <p>{snapshot.error}</p>
            </MessageScreen>
        );
    }

    if (snapshot.state === null) {
        return (
            <MessageScreen title="Sherpa">
                <p>
                    {snapshot.connection === 'connecting'
                        ? 'Connecting to the server…'
                        : 'Server unavailable, reconnecting…'}
                </p>
            </MessageScreen>
        );
    }

    const { state } = snapshot;

    return (
        <>
            <TopBar
                version={UI_VERSION}
                breadcrumb={breadcrumbFromPrKey(state.prKey)}
                agent={agentPillView(state.worker, state.tasks)}
                view={view}
                onSelectView={session.setView}
                onOpenSearch={() => {
                    session.setPaletteOpen(true);
                }}
            />

            {snapshot.connection === 'reconnecting' ? (
                <div className="connection-banner">
                    <div className="connection-banner__title">Server unavailable, reconnecting…</div>
                    <p>This is the last known state. It will update automatically when the connection returns.</p>
                </div>
            ) : null}

            {view === 'diff' ? (
                <FullDiffView
                    token={token}
                    prKey={state.prKey}
                    session={session}
                    diff={currentDiff}
                    diffError={currentDiffError}
                    store={diffStore}
                    progressRevision={snapshot.progressRevision}
                    threadsRevision={snapshot.threadsRevision}
                    paletteNavigation={paletteNavigation}
                    onPaletteActiveFileChange={(fileId) => {
                        if (fileId !== null) {
                            setActiveFileId(fileId);
                        }
                    }}
                />
            ) : (
                <ViewFrame view={view} />
            )}

            <CommandPalette
                open={paletteOpen}
                prKey={state.prKey}
                source={paletteSource}
                sourceError={currentDiffError}
                onOpen={() => {
                    session.setPaletteOpen(true);
                }}
                onClose={() => {
                    session.setPaletteOpen(false);
                }}
            />
        </>
    );
}

export function MessageScreen({ title, children }: { title: string; children: ReactNode }) {
    return (
        <main className="message-screen">
            <h1 className="message-screen__title">{title}</h1>
            {children}
        </main>
    );
}
