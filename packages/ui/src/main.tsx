import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App, MessageScreen } from './app.tsx';
import { ALL_FILTER_ID, filterFragmentValue } from './filters/lens-filters.js';
import { readFragmentParam, readToken, updateFragment } from './fragment.js';
import type { SessionState } from './session/session-store.js';
import { createSessionStore, DEFAULT_THREADS_SHOW } from './session/session-store.js';
import { DEFAULT_VIEW, parseViewId, VIEWS } from './session/views.js';
import { ShortcutsProvider } from './shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from './shortcuts/registry.js';
import { createStore } from './store.js';
import './styles/base.css';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element #root not found');
}

const token = readToken(window.location.hash);
const root = createRoot(container);

if (token === null) {
    // Make no requests without a token. The skill/server launch prints a URL containing it.
    root.render(
        <StrictMode>
            <MessageScreen title="Sherpa">
                <p>Open the UI using the link printed by the Sherpa skill or server. It contains the access token.</p>
                <p className="message-screen__hint">http://127.0.0.1:&lt;port&gt;/#token=&lt;token&gt;</p>
            </MessageScreen>
        </StrictMode>,
    );
} else {
    const store = createStore({ token });

    const session = createSessionStore({
        initial: {
            view: parseViewId(readFragmentParam(window.location.hash, 'view')) ?? DEFAULT_VIEW,
            // The filter model validates the id, since only it knows which lenses the host provides.
            filter: readFragmentParam(window.location.hash, 'filter') ?? ALL_FILTER_ID,
            threadsShow: DEFAULT_THREADS_SHOW,
        },
        persist: (state: SessionState) => {
            // Use replaceState instead of assigning hash, so switching tabs does not fill browser history.
            history.replaceState(
                null,
                '',
                updateFragment(window.location.hash, {
                    view: state.view,
                    filter: filterFragmentValue(state.filter),
                }),
            );
        },
    });

    // The only keyboard listener on the page. Commands are declared only here (requirements §3.3).
    const shortcuts = createShortcutRegistry();
    VIEWS.forEach((view, index) => {
        shortcuts.register({
            id: `view.${view.id}`,
            keys: [String(index + 1)],
            label: `View "${view.label}"`,
            action: () => {
                session.setView(view.id);
            },
        });
    });
    attachShortcuts(window, shortcuts);

    root.render(
        <StrictMode>
            <ShortcutsProvider registry={shortcuts}>
                <App store={store} session={session} token={token} />
            </ShortcutsProvider>
        </StrictMode>,
    );
}
