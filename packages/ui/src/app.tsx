import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

import './app.css';
import { agentPillView } from './components/agent-pill-view.js';
import { TopBar } from './components/top-bar.tsx';
import { breadcrumbFromPrKey } from './pr-key.js';
import type { SessionStore } from './session/session-store.js';
import type { Store } from './store.js';
import { UI_VERSION } from './version.js';
import { ViewFrame } from './views/view-frames.tsx';

/**
 * Main page: top bar and active view. Both stores live outside the React tree
 * (requirements §1/C3): the server SSE store and the UI session state. The component only reads them
 * through `useSyncExternalStore`.
 */
export interface AppProps {
    readonly store: Store;
    readonly session: SessionStore;
}

export function App({ store, session }: AppProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const { view } = useSyncExternalStore(session.subscribe, session.getSnapshot);

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
            />

            {snapshot.connection === 'reconnecting' ? (
                <div className="connection-banner">
                    <div className="connection-banner__title">Server unavailable, reconnecting…</div>
                    <p>This is the last known state. It will update automatically when the connection returns.</p>
                </div>
            ) : null}

            <ViewFrame view={view} />
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
