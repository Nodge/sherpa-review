/* Base layer goes first: control state rules must come in the cascade
   before component styles, which add their layout on top. */
import './styles/base.css';

import type { Locale } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { fetchUiPrState, fetchUiSettings, patchUiPrState, patchUiSettings } from './api.js';
import { App, MessageScreen } from './app.tsx';
import { ALL_FILTER_ID } from './filters/lens-filters.js';
import { readFragmentParam, readToken, updateFragment } from './fragment.js';
import { IconSprite } from './icons/icon.tsx';
import { LocaleProvider, useT } from './i18n/index.js';
import { PrStateProvider } from './pr-state/context.tsx';
import { createUiPrStateStore } from './pr-state/pr-state-store.js';
import type { Viewing } from './iterations/viewing.js';
import { parseViewing } from './iterations/viewing.js';
import { sessionFragmentPatch } from './session/session-fragment.js';
import type { SessionState, SessionStore } from './session/session-store.js';
import {
    createSessionStore,
    DEFAULT_PRESET,
    DEFAULT_ROUTE_FILTER,
    parsePreset,
    parseRouteFilter,
} from './session/session-store.js';
import type { ViewId } from './session/views.js';
import { DEFAULT_VIEW, parseViewId, VIEWS } from './session/views.js';
import { SettingsProvider } from './settings/context.tsx';
import { DocumentSettingsSync, readDocumentAppearance } from './settings/document-settings.tsx';
import { createUiSettingsStore, loadUiSettings } from './settings/settings-store.js';
import { ShortcutsProvider } from './shortcuts/context.tsx';
import { createPointerTarget } from './shortcuts/pointer-target.js';
import { attachShortcuts, createShortcutRegistry } from './shortcuts/registry.js';
import type { Store } from './store.js';
import { createStore } from './store.js';

/** Second key of a view navigation chord: `g o` for Overview, `g r` for Route, `g d` for Full diff. */
const VIEW_CHORD: Readonly<Record<ViewId, string>> = { overview: 'o', route: 'r', diff: 'd' };

/** Wait limit for server state (settings and PR state) before the first render. */
const SETTINGS_BOOT_TIMEOUT_MS = 1500;

const container = document.getElementById('root');
if (!container) {
    throw new Error('Sherpa UI: root element #root is missing');
}

const token = readToken(window.location.hash);
const root = createRoot(container);

if (token === null) {
    // Make no requests without a token. The skill/server launch prints a URL containing it.
    // Settings are unavailable here, so use the browser language: the provider without a store reads the fallback.
    root.render(
        <StrictMode>
            <IconSprite />
            <LocaleProvider>
                <NoTokenScreen />
            </LocaleProvider>
        </StrictMode>,
    );
} else {
    const store = createStore({ token });
    // Global settings live on the server, and the first render waits for them. Diff mode and composer layout
    // must be known before creating the stores, or the toggle visibly flips
    // and the editor gets recreated while the reviewer is already typing.
    const settings = createUiSettingsStore({
        initial: readDocumentAppearance(document.documentElement),
        send: (patch) => patchUiSettings(token, patch),
    });
    const settingsReady = loadUiSettings(settings, () => fetchUiSettings(token));
    // Collapsed directories and cards for this PR load in the same race. A late response does not
    // recreate the diff view store: its map is loaded separately (see App).
    const prState = createUiPrStateStore({ send: (patch, options) => patchUiPrState(token, patch, options) });
    const prStateReady = prState.load(() => fetchUiPrState(token));
    // Flush the pending write when the tab leaves: the debounce delay must not lose the last click.
    const flushPrState = (): void => {
        prState.flush();
    };
    window.addEventListener('pagehide', flushPrState);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushPrState();
        }
    });

    const viewFromUrl = parseViewId(readFragmentParam(window.location.hash, 'view'));
    // What the tab is viewing: `snapshot=` takes precedence over the `base=&head=` slice, which takes precedence over `diff=`,
    // and "current" is not written to the URL.
    let persistedViewing: Viewing = parseViewing(
        readFragmentParam(window.location.hash, 'snapshot'),
        readFragmentParam(window.location.hash, 'diff'),
        readFragmentParam(window.location.hash, 'base'),
        readFragmentParam(window.location.hash, 'head'),
    );
    // The only keyboard listener on the page. Commands are declared only here (docs/architecture.md §7.3).
    const shortcuts = createShortcutRegistry();
    attachShortcuts(window, shortcuts);
    // Target of "under the cursor" commands (docs/design/SPEC-elements.md §5): one cursor listener per page, like the keyboard listener.
    const pointer = createPointerTarget(window, document);

    /**
     * Create the session store and its commands after server state loads: the initial view
     * depends on whether the onboarding tour is complete, a global settings field.
     */
    const startSession = (defaultView: ViewId): SessionStore => {
        const session = createSessionStore({
            // The URL view is the reviewer's choice. A small PR does not override it (docs/design/SPEC-elements.md §4.1).
            viewPinned: viewFromUrl !== null,
            initial: {
                view: viewFromUrl ?? defaultView,
                // The filter model validates the id: only it knows which lenses the host provides.
                filter: readFragmentParam(window.location.hash, 'filter') ?? ALL_FILTER_ID,
                preset: parsePreset(readFragmentParam(window.location.hash, 'preset')) ?? DEFAULT_PRESET,
                routeFilter:
                    parseRouteFilter(readFragmentParam(window.location.hash, 'routeFilter')) ??
                    DEFAULT_ROUTE_FILTER,
                viewing: persistedViewing,
                paletteOpen: false,
            },
            persist: (state: SessionState, fragment?: Readonly<Record<string, string | null>>) => {
                const patch = sessionFragmentPatch(state, persistedViewing, fragment);
                persistedViewing = state.viewing;
                // Use replaceState instead of assigning hash so switching tabs does not fill browser history.
                history.replaceState(null, '', updateFragment(window.location.hash, patch));
            },
        });

        VIEWS.forEach((view, index) => {
            shortcuts.register({
                id: `view.${view.id}`,
                // The `g o`/`g r`/`g d` chord is another binding for the same command (docs/design/SPEC-elements.md §5), not a new command.
                keys: [String(index + 1), `g ${VIEW_CHORD[view.id]}`],
                label: view.command,
                scope: 'global',
                section: 'navigation',
                action: () => {
                    session.setView(view.id);
                },
            });
        });
        shortcuts.register({
            id: 'palette.open',
            keys: ['mod+k'],
            label: 'shortcut.palette.open',
            scope: 'global',
            section: 'navigation',
            worksInInputs: true,
            action: () => {
                session.setPaletteOpen(true);
            },
        });
        return session;
    };

    // Wait for server state until the timeout. A stalled endpoint must not leave the reviewer
    // on an empty page. Render defaults, then load the response into the stores when it arrives.
    void Promise.race([Promise.all([settingsReady, prStateReady]), delay(SETTINGS_BOOT_TIMEOUT_MS)]).then(() => {
        /*
         * An incomplete tour opens the tab on Route: its first three steps describe the
         * route, so starting on Overview serves no purpose. This changes the default during loading.
         * A view from the URL takes precedence, and the tour never switches views as it runs (docs/design/SPEC-onboarding-2026-09-02.md §2).
         * Settings arriving after the timeout have no say here. They do not start the tour
         * either, since defaults would make it appear incomplete for everyone.
         */
        const tourPending =
            settings.isLoaded() && settings.getSnapshot().onboarding.completedAt === null;
        const session = startSession(tourPending ? 'route' : DEFAULT_VIEW);
        root.render(
            <StrictMode>
                <IconSprite />
                <ShortcutsProvider registry={shortcuts} pointer={pointer}>
                    <SettingsProvider store={settings}>
                        <DocumentSettingsSync />
                        <AgentLocaleProvider store={store}>
                            <PrStateProvider store={prState}>
                                <App store={store} session={session} token={token} />
                            </PrStateProvider>
                        </AgentLocaleProvider>
                    </SettingsProvider>
                </ShortcutsProvider>
            </StrictMode>,
        );
    });
}

/**
 * Locale provider with the agent hint from server state. The subscription lives here so
 * `LocaleProvider` need not know about the store, which is absent in the gallery and component tests.
 * A new `lang` arrives over SSE and rerenders the tree without a reload.
 */
function AgentLocaleProvider({ store, children }: { store: Store; children: ReactNode }) {
    const agentLang = useSyncExternalStore(store.subscribe, () => agentLangOf(store));
    return <LocaleProvider agentLang={agentLang}>{children}</LocaleProvider>;
}

function agentLangOf(store: Store): Locale | undefined {
    const worker = store.getSnapshot().state?.worker;
    return worker === undefined || worker.kind === 'never' ? undefined : worker.lang;
}

/** Screen without a token: the only place where the UI runs entirely without server state. */
function NoTokenScreen() {
    const t = useT();
    return (
        <MessageScreen title={t('app.name')}>
            <p>{t('app.noToken.text')}</p>
            <p className="message-screen__hint">{t('app.noToken.hint')}</p>
        </MessageScreen>
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
