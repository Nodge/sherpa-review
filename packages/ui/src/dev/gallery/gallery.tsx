import type { Locale, UiSettings } from '@sherpa/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { updateFragment } from '../../fragment.js';
import { LocaleProvider } from '../../i18n/index.js';
import './gallery.css';
import { SettingsProvider } from '../../settings/context.tsx';
import { DocumentSettingsSync } from '../../settings/document-settings.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { EXTRA_STYLES } from '../../styles/extra-styles.js';
import type { GalleryState } from './states.tsx';
import { GALLERY_STATES } from './states.tsx';

/**
 * State gallery: named states on the left, deterministic rendering of the selected one on the right.
 * No server or token, only fixtures and static props.
 *
 * The locale is selected in the header and stored in the URL (`#locale=ru`): states need inspection in both
 * languages, so the provider gets the language as an explicit prop. Theme and text size live in the local settings
 * store and in the URL (`#theme=light`, `#style=<id>`, `#textsize=l`). The switches belong to the stage:
 * in the product they live in the settings menu, which itself is one of the gallery states.
 * The theme defaults to dark here rather than the product's `auto`: cards must render identically
 * under any system theme unless `#theme=auto` is explicitly requested.
 */
export function Gallery({
    initialId,
    initialLocale = 'en',
    initialTheme = 'dark',
    initialStyle = null,
    initialTextSize = 'm',
}: {
    initialId: string | null;
    initialLocale?: Locale;
    initialTheme?: UiSettings['theme'];
    initialStyle?: UiSettings['style'];
    initialTextSize?: UiSettings['textSize'];
}) {
    const [settings] = useState(() =>
        createUiSettingsStore({
            loaded: true,
            initial: { theme: initialTheme, style: initialStyle, textSize: initialTextSize },
        }),
    );
    useEffect(() => {
        const syncFragment = (): void => {
            const snapshot = settings.getSnapshot();
            const fragment = updateFragment(window.location.hash, {
                theme: snapshot.theme,
                style: snapshot.style,
                textsize: snapshot.textSize,
            });
            history.replaceState(null, '', fragment);
        };
        syncFragment();
        return settings.subscribe(syncFragment);
    }, [settings]);
    const [selectedId, setSelectedId] = useState(initialId ?? GALLERY_STATES[0]?.id ?? '');
    const [locale, setLocale] = useState<Locale>(initialLocale);
    // `DocumentSettingsSync` sets the attribute on `<html>` from the store, as in the product.
    const textSize = useSyncExternalStore(settings.subscribe, () => settings.getSnapshot().textSize);
    const theme = useSyncExternalStore(settings.subscribe, () => settings.getSnapshot().theme);
    const style = useSyncExternalStore(settings.subscribe, () => settings.getSnapshot().style);
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

    const selectTextSize = (next: UiSettings['textSize']): void => {
        // The store subscription above will update the URL.
        settings.update({ textSize: next });
    };

    const selectTheme = (next: UiSettings['theme']): void => {
        settings.update({ theme: next });
    };

    return (
        <SettingsProvider store={settings}>
            <DocumentSettingsSync />
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
                                <div className="gallery__themes" role="group" aria-label="Theme">
                                    {THEMES.map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            aria-pressed={option === theme}
                                            onClick={() => {
                                                selectTheme(option);
                                            }}
                                        >
                                            {option}
                                        </button>
                                    ))}
                                </div>
                                {EXTRA_STYLES.length === 0 ? null : (
                                    <div className="gallery__themes">
                                        {EXTRA_STYLES.map((extra) => (
                                            <button
                                                key={extra.id}
                                                type="button"
                                                role="switch"
                                                aria-label={extra.label.en}
                                                aria-checked={style === extra.id}
                                                onClick={() => {
                                                    settings.update({ style: style === extra.id ? null : extra.id });
                                                }}
                                            >
                                                {extra.label.en}
                                            </button>
                                        ))}
                                    </div>
                                )}
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
                                <div className="gallery__textsize" role="group" aria-label="Text size">
                                    {TEXT_SIZES.map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            aria-pressed={option === textSize}
                                            onClick={() => {
                                                selectTextSize(option);
                                            }}
                                        >
                                            {option}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {/* key: changing state, language or text size remounts the render, so initial props
                                (defaultMenuOpen etc.) apply again, and measurements such as the tour frame
                                are recalculated for the new font size. */}
                            <div className="gallery__canvas" key={`${selected.id}:${locale}:${textSize}`}>
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

/** Stage themes: the same set as in the product settings menu. */
const THEMES: readonly UiSettings['theme'][] = ['auto', 'dark', 'light'];

/** Stage text sizes: `m` has a 16px base, `l` has 18px (docs/design/theme.md, "Typography"). */
const TEXT_SIZES: readonly UiSettings['textSize'][] = ['m', 'l'];

/** `#locale=ru` from the URL. Everything else (including empty) means English. */
export function parseGalleryLocale(value: string | null): Locale {
    return value === 'ru' ? 'ru' : 'en';
}

/** Three theme modes. An unknown or empty value keeps the gallery dark theme. */
export function parseGalleryTheme(value: string | null): UiSettings['theme'] {
    return value === 'light' || value === 'auto' ? value : 'dark';
}

/** `#style=<id>` selects a style in this build. An unknown or empty value selects the main style. */
export function parseGalleryStyle(value: string | null): UiSettings['style'] {
    return EXTRA_STYLES.find((extra) => extra.id === value)?.id ?? null;
}

/** `#textsize=l`. Any other value uses the normal size. */
export function parseGalleryTextSize(value: string | null): UiSettings['textSize'] {
    return value === 'l' ? 'l' : 'm';
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
