import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { fetchUiSettings, patchUiSettings } from './api.js';
import { App, MessageScreen } from './app.tsx';
import { ALL_FILTER_ID, filterFragmentValue } from './filters/lens-filters.js';
import { readFragmentParam, readToken, updateFragment } from './fragment.js';
import { IconSprite } from './icons/icon.tsx';
import type { Viewing } from './iterations/viewing.js';
import { parseViewing, viewingFragmentPatch } from './iterations/viewing.js';
import type { SessionState } from './session/session-store.js';
import {
    createSessionStore,
    DEFAULT_PRESET,
    DEFAULT_ROUTE_FILTER,
    DEFAULT_THREADS_SHOW,
    parsePreset,
    parseRouteFilter,
} from './session/session-store.js';
import { DEFAULT_VIEW, parseViewId, VIEWS } from './session/views.js';
import { SettingsProvider } from './settings/context.tsx';
import { createUiSettingsStore, loadUiSettings } from './settings/settings-store.js';
import { ShortcutsProvider } from './shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from './shortcuts/registry.js';
import { createStore } from './store.js';
import './styles/base.css';

/** Maximum wait for settings before the first render. */
const SETTINGS_BOOT_TIMEOUT_MS = 1500;

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
    // Global settings live on the server, and the first render waits for them. Diff mode and composer layout
    // must be known before creating the stores, or the toggle visibly flips
    // and the editor gets recreated while the reviewer is already typing.
    const settings = createUiSettingsStore({ send: (patch) => patchUiSettings(token, patch) });
    const settingsReady = loadUiSettings(settings, () => fetchUiSettings(token));

    const viewFromUrl = parseViewId(readFragmentParam(window.location.hash, 'view'));
    // What the tab is viewing: `snapshot=` takes priority over `diff=`, "current" is omitted from the URL (M4-T9).
    let persistedViewing: Viewing = parseViewing(
        readFragmentParam(window.location.hash, 'snapshot'),
        readFragmentParam(window.location.hash, 'diff'),
    );
    const session = createSessionStore({
        // A view from the URL is the reviewer's choice: a small PR will not override it (SPEC §4.1).
        viewPinned: viewFromUrl !== null,
        initial: {
            view: viewFromUrl ?? DEFAULT_VIEW,
            // The filter model validates the id, since only it knows which lenses the host provides.
            filter: readFragmentParam(window.location.hash, 'filter') ?? ALL_FILTER_ID,
            preset: parsePreset(readFragmentParam(window.location.hash, 'preset')) ?? DEFAULT_PRESET,
            routeFilter:
                parseRouteFilter(readFragmentParam(window.location.hash, 'routeFilter')) ?? DEFAULT_ROUTE_FILTER,
            viewing: persistedViewing,
            threadsShow: DEFAULT_THREADS_SHOW,
            paletteOpen: false,
        },
        persist: (state: SessionState) => {
            const viewingPatch = viewingFragmentPatch(state.viewing, persistedViewing);
            persistedViewing = state.viewing;
            // Use replaceState instead of assigning hash, so switching tabs does not fill browser history.
            history.replaceState(
                null,
                '',
                updateFragment(window.location.hash, {
                    view: state.view,
                    filter: filterFragmentValue(state.filter),
                    // The default is omitted from the address: the preset appears in the URL only after a change.
                    preset: state.preset === DEFAULT_PRESET ? null : state.preset,
                    routeFilter: state.routeFilter === DEFAULT_ROUTE_FILTER ? null : state.routeFilter,
                    ...viewingPatch,
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

    // Wait for settings until the timeout: a stalled endpoint must not leave the reviewer
    // facing an empty page. Render with defaults, and let the response reach the store later.
    void Promise.race([settingsReady, delay(SETTINGS_BOOT_TIMEOUT_MS)]).then(() => {
        root.render(
            <StrictMode>
                <IconSprite />
                <ShortcutsProvider registry={shortcuts}>
                    <SettingsProvider store={settings}>
                        <App store={store} session={session} token={token} />
                    </SettingsProvider>
                </ShortcutsProvider>
            </StrictMode>,
        );
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
