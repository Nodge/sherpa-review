import type { UiUpdate } from '@sherpa/protocol';
import { useEffect, useState } from 'react';

import { updateCheck } from '../api.js';
import { useT } from '../i18n/index.js';
import { useUiSettingsStore } from '../settings/context.tsx';
import { useShortcut } from '../shortcuts/context.tsx';

/**
 * Update toast state (M5-T9): when it appears, what hides it, and the
 * palette command. All toast behaviour lives here. The component only renders it.
 */

/** Delay after `uiState.update` arrives: the toast must not pop up while the screen is loading. */
const TOAST_DELAY_MS = 1500;

export interface UpdateToastState {
    readonly visible: boolean;
    /** "Later": until the tab reloads or the version in the top bar is clicked. */
    readonly later: () => void;
    /** Clicking the version in the top bar clears "Later". */
    readonly reopen: () => void;
    /** "Don't remind me about X": the server then returns `update: null` itself. */
    readonly dismissVersion: () => void;
}

/**
 * `tourActive` indicates whether the onboarding tour is running (M5-T8). The tour takes priority, so the toast
 * never appears on top of it, and the delay timer does not start beneath it.
 */
export function useUpdateToast(update: UiUpdate | null, tourActive = false): UpdateToastState {
    const settings = useUiSettingsStore();
    const latest = update?.latest ?? null;
    /** Version whose delay has elapsed. null means the timer is still running or there is no update. */
    const [readyFor, setReadyFor] = useState<string | null>(null);
    /** Version deferred with "Later" in this tab. */
    const [laterFor, setLaterFor] = useState<string | null>(null);

    // `update` disappeared (version dismissed, server checked again). The timer is cleared with
    // the effect, and `latest === null` hides the toast.
    useEffect(() => {
        if (latest === null || tourActive) {
            return;
        }
        const timer = window.setTimeout(() => {
            setReadyFor(latest);
        }, TOAST_DELAY_MS);
        return () => {
            window.clearTimeout(timer);
        };
    }, [latest, tourActive]);

    return {
        visible: latest !== null && readyFor === latest && laterFor !== latest && !tourActive,
        later: () => {
            setLaterFor(latest);
        },
        reopen: () => {
            setLaterFor(null);
            setReadyFor(latest);
        },
        dismissVersion: () => {
            if (latest !== null) {
                settings.update({ updates: { dismissedVersion: latest } });
            }
        },
    };
}

/**
 * "Check for updates" palette command in the "Sherpa" group: forces a check bypassing TTL and
 * returns a status line in the palette itself, so the palette stays open.
 */
export function useUpdateCheckCommand(options: {
    readonly token: string;
    /** Embedded version of this distribution, shown when there is no update. */
    readonly current: string;
    readonly onStatus: (status: string) => void;
}): void {
    const t = useT();
    const { token, current, onStatus } = options;

    useShortcut({
        id: 'update.check',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.update.check',
        scope: 'global',
        section: 'navigation',
        consequence: 'shortcut.update.check.consequence',
        keepOpen: true,
        action: () => {
            void updateCheck(token).then(
                (update) => {
                    onStatus(
                        update === null
                            ? t('update.status.none', current)
                            : t('update.status.available', update.latest),
                    );
                },
                () => {
                    onStatus(t('update.status.failed'));
                },
            );
        },
    });
}
