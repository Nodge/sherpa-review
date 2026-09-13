import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../icons/icon.tsx';
import { useT } from '../i18n/index.js';
import { tourStepCount, useTourReplay } from '../onboarding/index.js';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import './settings-menu.css';

/**
 * Header settings menu (docs/design/SPEC-theming-2026-09-12.md §7): theme, language, text size
 * and 2 actions, replay onboarding and open the command palette. It replaced the theme button. The skill has
 * no account, and 3 separate settings buttons would not fit in the header.
 *
 * Closes like the Ship menu and filter select: the `popover` layer in Esc priority order plus mousedown
 * outside. Mutual closing works the same way: a trigger press reaches document, and other
 * menus see it as an outside click. There is no transparent backdrop from §7 of the spec, because it would cover
 * other triggers and swallow the first press on them (details in `settings-menu.css`).
 */

export interface SettingsMenuProps {
    /** Agent connected: without one, the tour omits the chat step and has seven steps instead of eight. */
    readonly agentConnected: boolean;
    /** Open the command palette. */
    readonly onOpenCommands: () => void;
    /** Restart the current tour pass, just like the `tour.replay` palette command. */
    readonly onReplayTour: () => void;
    /** Menu starts open for state gallery cards. */
    readonly defaultOpen?: boolean;
}

export function SettingsMenu({ agentConnected, onOpenCommands, onReplayTour, defaultOpen = false }: SettingsMenuProps) {
    const t = useT();
    const settings = useUiSettingsStore();
    const { theme, locale, textSize } = useUiSettings();
    const replayTour = useTourReplay(onReplayTour);
    const [open, setOpen] = useState(defaultOpen);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    const close = useCallback((returnFocus: boolean): void => {
        setOpen(false);
        if (returnFocus) {
            triggerRef.current?.focus();
        }
    }, []);

    // Clicking outside closes the menu and returns focus to the trigger, like the filter select.
    useEffect(() => {
        if (!open) {
            return;
        }
        const closeOutside = (event: MouseEvent): void => {
            if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) {
                close(true);
            }
        };
        document.addEventListener('mousedown', closeOutside);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
        };
    }, [close, open]);

    useEscapeLayer('popover', () => {
        close(true);
    }, open);

    return (
        <div className="settings-menu" ref={rootRef}>
            <button
                type="button"
                ref={triggerRef}
                className="settings-menu__trigger"
                title={t('settings.title')}
                aria-label={t('settings.title')}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => {
                    if (open) {
                        close(false);
                    } else {
                        setOpen(true);
                    }
                }}
            >
                <Icon name="sliders" size={15} />
            </button>

            {open ? (
                <div className="settings-menu__panel" role="dialog" aria-label={t('settings.title')}>
                    <div className="settings-menu__kicker">{t('settings.kicker')}</div>

                    <SettingsRow label={t('settings.theme')}>
                        <Segments
                            label={t('settings.theme')}
                            value={theme}
                            options={[
                                { value: 'auto', label: t('settings.auto') },
                                { value: 'dark', label: t('settings.theme.dark') },
                                { value: 'light', label: t('settings.theme.light') },
                            ]}
                            onSelect={(value) => {
                                settings.update({ theme: value });
                            }}
                        />
                    </SettingsRow>

                    <SettingsRow label={t('settings.language')}>
                        <Segments
                            label={t('settings.language')}
                            value={locale}
                            options={[
                                { value: 'auto', label: t('settings.auto') },
                                // Language codes and size letters are the same in both languages, so they need no dictionary entries.
                                { value: 'en', label: 'EN' },
                                { value: 'ru', label: 'RU' },
                            ]}
                            onSelect={(value) => {
                                settings.update({ locale: value });
                            }}
                        />
                    </SettingsRow>

                    <SettingsRow label={t('settings.textSize')}>
                        <Segments
                            label={t('settings.textSize')}
                            value={textSize}
                            options={[
                                { value: 'm', label: 'M' },
                                { value: 'l', label: 'L' },
                            ]}
                            onSelect={(value) => {
                                settings.update({ textSize: value });
                            }}
                        />
                    </SettingsRow>

                    <div className="settings-menu__divider" />

                    <button
                        type="button"
                        className="settings-menu__action"
                        onClick={() => {
                            close(false);
                            replayTour();
                        }}
                    >
                        <span className="settings-menu__action-label">{t('settings.replay')}</span>
                        <span className="settings-menu__meta">
                            {t('settings.steps', tourStepCount(agentConnected))}
                        </span>
                    </button>

                    <button
                        type="button"
                        className="settings-menu__action"
                        onClick={() => {
                            close(false);
                            onOpenCommands();
                        }}
                    >
                        <span className="settings-menu__action-label">{t('settings.commands')}</span>
                        <span className="settings-menu__key">⌘K</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="settings-menu__row">
            <span className="settings-menu__label">{label}</span>
            {children}
        </div>
    );
}

/** Small settings row segment: selection applies immediately and the menu stays open. */
function Segments<T extends string>({
    label,
    value,
    options,
    onSelect,
}: {
    label: string;
    value: T;
    options: readonly { value: T; label: string }[];
    onSelect: (value: T) => void;
}) {
    return (
        <div className="settings-menu__segments" role="group" aria-label={label}>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    className="settings-menu__segment"
                    aria-pressed={option.value === value}
                    onClick={() => {
                        onSelect(option.value);
                    }}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
