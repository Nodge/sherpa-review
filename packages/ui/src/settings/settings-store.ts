import type { UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { uiSettingsSchema } from '@sherpa/protocol';

/**
 * Global UI settings (M3-T16): diff mode, ship mode, composer layout, language. Stored on the
 * server in `~/.sherpa/settings.json` instead of `localStorage` because each PR server listens on
 * a random port, giving each PR its own browser storage.
 *
 * Changes apply optimistically and are then sent to the server. A failed write does not roll back the choice.
 * The reviewer already sees the new mode, and switching it back is worse than losing persistence.
 */

export const DEFAULT_UI_SETTINGS: UiSettings = uiSettingsSchema.parse({});

/**
 * Individual settings fields. The patch schema cannot be used here because `.partial()` on a schema with defaults
 * supplies a default for a missing key, turning "leave the field alone" into "reset it".
 */
const SETTINGS_FIELDS = [
    'diffMode',
    'shipMode',
    'composerLayout',
    'locale',
    // Nested objects use reference equality for "same value", so the patch is always sent.
    // Each has one writer: the onboarding tour and "do not remind me about this version".
    'onboarding',
    'updates',
] as const satisfies readonly (keyof UiSettings)[];

export interface UiSettingsStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => UiSettings;
    /**
     * The server response has been applied. The first render uses a timeout and may still see defaults.
     * Decisions that must not use a value the reviewer did not choose (whether to show the onboarding tour)
     * wait for this flag.
     */
    readonly isLoaded: () => boolean;
    /** Applies the named fields immediately and sends PATCH. Fields with unchanged values are not sent. */
    readonly update: (patch: UiSettingsPatch) => void;
    /**
     * Settings received from the server at startup. The response does not override fields the reviewer
     * has already changed manually because it predates that choice.
     */
    readonly applyLoaded: (settings: UiSettings) => void;
}

export interface UiSettingsStoreOptions {
    readonly initial?: Partial<UiSettings>;
    /** Treat settings as already loaded. The gallery and component tests have nothing to wait for. */
    readonly loaded?: boolean;
    /** Write transport. Without it, settings live only in memory (tests, gallery). */
    readonly send?: (patch: UiSettingsPatch) => Promise<UiSettings>;
}

export function createUiSettingsStore(options: UiSettingsStoreOptions = {}): UiSettingsStore {
    const listeners = new Set<() => void>();
    const changedHere = new Set<keyof UiSettings>();
    let snapshot: UiSettings = { ...DEFAULT_UI_SETTINGS, ...options.initial };
    let loaded = options.loaded ?? false;
    // Writes form a chain: two consecutive PATCH requests must not apply in reverse order.
    let queue: Promise<unknown> = Promise.resolve();

    const notify = (): void => {
        for (const listener of [...listeners]) {
            listener();
        }
    };

    /** Applies only named fields that differ and returns those fields to send. */
    const applyLocally = (patch: UiSettingsPatch): UiSettingsPatch => {
        const changes: UiSettingsPatch = {};
        for (const field of SETTINGS_FIELDS) {
            const value = patch[field];
            if (value !== undefined && value !== snapshot[field]) {
                Object.assign(changes, { [field]: value });
            }
        }
        if (Object.keys(changes).length === 0) {
            return changes;
        }
        // The snapshot always passes the schema, so invalid values cannot enter it.
        snapshot = uiSettingsSchema.parse({ ...snapshot, ...changes });
        notify();
        return changes;
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        isLoaded: () => loaded,

        update: (patch) => {
            const changes = applyLocally(patch);
            for (const field of SETTINGS_FIELDS) {
                if (changes[field] !== undefined) {
                    changedHere.add(field);
                }
            }
            const send = options.send;
            if (send === undefined || Object.keys(changes).length === 0) {
                return;
            }
            queue = queue.then(
                () =>
                    send(changes).catch((error: unknown) => {
                        console.warn('Sherpa: failed to persist a UI setting:', error);
                    }),
                () => undefined,
            );
        },

        applyLoaded: (settings) => {
            const fresh: UiSettingsPatch = {};
            for (const field of SETTINGS_FIELDS) {
                if (!changedHere.has(field)) {
                    Object.assign(fresh, { [field]: settings[field] });
                }
            }
            const wasLoaded = loaded;
            loaded = true;
            // The flag itself also warrants a render because the response may match every default field.
            if (Object.keys(applyLocally(fresh)).length === 0 && !wasLoaded) {
                notify();
            }
        },
    };
}

/**
 * Settings boot-GET: applies the result to the store, leaves defaults on failure. The UI does not wait for it.
 * It works without settings, using defaults.
 */
export function loadUiSettings(store: UiSettingsStore, load: () => Promise<UiSettings>): Promise<void> {
    return load().then(
        (settings) => {
            store.applyLoaded(settings);
        },
        (error: unknown) => {
            console.warn('Sherpa: UI settings failed to load, falling back to defaults:', error);
        },
    );
}
