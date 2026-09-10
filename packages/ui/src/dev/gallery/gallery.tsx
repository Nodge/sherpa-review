import type { Locale, UiSettings } from '@sherpa/protocol';
import { useEffect, useState } from 'react';

import { updateFragment } from '../../fragment.js';
import { LocaleProvider } from '../../i18n/index.js';
import './gallery.css';
import { ThemeToggle } from '../../components/theme-toggle.tsx';
import { SettingsProvider } from '../../settings/context.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { ThemeSync } from '../../settings/theme.tsx';
import type { GalleryState } from './states.tsx';
import { GALLERY_STATES } from './states.tsx';

/**
 * State gallery: named states on the left, deterministic rendering of the selected one on the right.
 * No server or token, only fixtures and static props.
 *
 * The locale is selected in the header and stored in the URL (`#locale=ru`): states need inspection in both
 * languages. The provider receives the language as an explicit prop. The theme lives in a local settings store
 * and in the URL (`#theme=light`). The same toggle works without a server.
 */
export function Gallery({
    initialId,
    initialLocale = 'en',
    initialTheme = 'dark',
}: {
    initialId: string | null;
    initialLocale?: Locale;
    initialTheme?: UiSettings['theme'];
}) {
    const [settings] = useState(() =>
        createUiSettingsStore({ loaded: true, initial: { theme: initialTheme } }),
    );
    useEffect(() => settings.subscribe(() => {
        const fragment = updateFragment(window.location.hash, { theme: settings.getSnapshot().theme });
        history.replaceState(null, '', fragment);
    }), [settings]);
    const [selectedId, setSelectedId] = useState(initialId ?? GALLERY_STATES[0]?.id ?? '');
    const [locale, setLocale] = useState<Locale>(initialLocale);
    const selected = GALLERY_STATES.find((state) => state.id === selectedId) ?? GALLERY_STATES[0];

    const select = (id: string): void => {
        setSelectedId(id);
        // State in the URL: a link to a specific state can be shared and reopened.
        history.replaceState(null, '', updateFragment(window.location.hash, { state: id }));
    };

    const selectLocale = (next: Locale): void => {
        setLocale(next);
        history.replaceState(null, '', updateFragment(window.location.hash, { locale: next }));
    };

    return (
        <SettingsProvider store={settings}>
            <ThemeSync />
            <div className="gallery">
                <nav className="gallery__sidebar" aria-label="States">
                    <div className="gallery__brand">State gallery</div>
                    {groupBy(GALLERY_STATES).map(([group, states]) => (
                        <section key={group} className="gallery__group">
                            <h2 className="gallery__group-title">{group}</h2>
                            {states.map((state) => (
                                <button
                                    key={state.id}
                                    type="button"
                                    className="gallery__item"
                                    aria-current={state.id === selected?.id}
                                    onClick={() => {
                                        select(state.id);
                                    }}
                                >
                                    {state.title}
                                </button>
                            ))}
                        </section>
                    ))}
                </nav>

                <div className="gallery__stage">
                    {selected === undefined ? null : (
                        <>
                            <div className="gallery__stage-title">
                                {selected.group} · {selected.title}
                                <code className="gallery__stage-id">{selected.id}</code>
                                <div className="gallery__stage-spacer" />
                                <LocaleProvider locale={locale}>
                                    <ThemeToggle />
                                </LocaleProvider>
                                <div className="gallery__locales" role="group" aria-label="Interface language">
                                    {LOCALES.map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            aria-pressed={option === locale}
                                            onClick={() => {
                                                selectLocale(option);
                                            }}
                                        >
                                            {option}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {/* key: changing state or language remounts the renderer, so initial props (defaultMenuOpen, etc.) apply again. */}
                            <div className="gallery__canvas" key={`${selected.id}:${locale}`}>
                                <LocaleProvider locale={locale}>{selected.render()}</LocaleProvider>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </SettingsProvider>
    );
}

const LOCALES: readonly Locale[] = ['ru', 'en'];

/** `#locale=ru` from the URL. Everything else (including empty) means English. */
export function parseGalleryLocale(value: string | null): Locale {
    return value === 'ru' ? 'ru' : 'en';
}

function groupBy(states: readonly GalleryState[]): [string, GalleryState[]][] {
    const groups = new Map<string, GalleryState[]>();
    for (const state of states) {
        const bucket = groups.get(state.group);
        if (bucket === undefined) {
            groups.set(state.group, [state]);
        } else {
            bucket.push(state);
        }
    }
    return [...groups];
}
