import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App, MessageScreen } from './app.tsx';
import { ALL_FILTER_ID, filterFragmentValue } from './filters/lens-filters.js';
import { readFragmentParam, readToken, updateFragment } from './fragment.js';
import { IconSprite } from './icons/icon.tsx';
import type { SessionState } from './session/session-store.js';
import { createSessionStore, DEFAULT_PRESET, DEFAULT_THREADS_SHOW, parsePreset } from './session/session-store.js';
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
            <IconSprite />
            <MessageScreen title="Sherpa">
                <p>Open the UI using the link printed by the Sherpa skill or server. It contains the access token.</p>
                <p className="message-screen__hint">http://127.0.0.1:&lt;port&gt;/#t=&lt;token&gt;</p>
            </MessageScreen>
        </StrictMode>,
    );
} else {
    const store = createStore({ token });

    const viewFromUrl = parseViewId(readFragmentParam(window.location.hash, 'view'));
    const session = createSessionStore({
        // A view from the URL is the reviewer's choice: a small PR will not override it (SPEC §4.1).
        viewPinned: viewFromUrl !== null,
        initial: {
            view: viewFromUrl ?? DEFAULT_VIEW,
            // The filter model validates the id, since only it knows which lenses the host provides.
            filter: readFragmentParam(window.location.hash, 'filter') ?? ALL_FILTER_ID,
            preset: parsePreset(readFragmentParam(window.location.hash, 'preset')) ?? DEFAULT_PRESET,
            threadsShow: DEFAULT_THREADS_SHOW,
            paletteOpen: false,
        },
        persist: (state: SessionState) => {
            // Use replaceState instead of assigning hash, so switching tabs does not fill browser history.
            history.replaceState(
                null,
                '',
                updateFragment(window.location.hash, {
                    view: state.view,
                    filter: filterFragmentValue(state.filter),
                    // The default is omitted from the address: the preset appears in the URL only after a change.
                    preset: state.preset === DEFAULT_PRESET ? null : state.preset,
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
    shortcuts.register({
        id: 'palette.open',
        keys: ['mod+k'],
        label: 'Open command palette',
        worksInInputs: true,
        action: () => {
            session.setPaletteOpen(true);
        },
    });
    attachShortcuts(window, shortcuts);

    root.render(
        <StrictMode>
            <IconSprite />
            <ShortcutsProvider registry={shortcuts}>
                <App store={store} session={session} token={token} />
            </ShortcutsProvider>
        </StrictMode>,
    );
}
