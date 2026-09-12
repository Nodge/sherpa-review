import type { UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { uiSettingsSchema } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createUiSettingsStore, DEFAULT_UI_SETTINGS, loadUiSettings } from './settings-store.js';

/** Client-side global settings, applied optimistically and written to the server. */

function recording(): {
    readonly patches: UiSettingsPatch[];
    readonly send: (patch: UiSettingsPatch) => Promise<UiSettings>;
} {
    const patches: UiSettingsPatch[] = [];
    return {
        patches,
        send: (patch) => {
            patches.push(patch);
            return Promise.resolve(merged(patch));
        },
    };
}

/** Endpoint response. The server always returns the full set after merging. */
function merged(patch: UiSettingsPatch): UiSettings {
    return uiSettingsSchema.parse({ ...DEFAULT_UI_SETTINGS, ...patch });
}

/** Writes reach the server through a promise chain, so microtasks need to be flushed. */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('global UI settings', () => {
    it('returns the contract defaults before loading', () => {
        expect(createUiSettingsStore().getSnapshot()).toEqual({
            diffMode: 'unified',
            shipMode: 'ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('applies the change immediately and sends only the specified field', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ send });
        const seen: string[] = [];
        store.subscribe(() => seen.push(store.getSnapshot().diffMode));

        store.update({ diffMode: 'split' });

        // Application is synchronous. The reviewer sees the new mode before any network activity.
        expect(store.getSnapshot()).toMatchObject({ diffMode: 'split', shipMode: 'ship' });
        expect(seen).toEqual(['split']);

        await flush();
        expect(patches).toEqual([{ diffMode: 'split' }]);
    });

    it('keeps the chosen theme after a late load and writes changes in switching order', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ send });
        store.update({ theme: 'light' });
        store.applyLoaded(merged({ theme: 'dark', diffMode: 'split' }));
        expect(store.getSnapshot()).toMatchObject({ theme: 'light', diffMode: 'split' });
        store.update({ theme: 'dark' });
        await flush();
        expect(patches).toEqual([{ theme: 'light' }, { theme: 'dark' }]);
    });

    it('does not send a repeated value', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ send });

        store.update({ diffMode: 'unified' });
        store.update({ shipMode: 'sticky_ship' });
        store.update({ shipMode: 'sticky_ship' });

        await flush();
        expect(patches).toEqual([{ shipMode: 'sticky_ship' }]);
    });

    it('keeps the choice when writing fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiSettingsStore({ send: () => Promise.reject(new Error('server is silent')) });

        store.update({ diffMode: 'split' });
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });

        expect(store.getSnapshot().diffMode).toBe('split');
        warn.mockRestore();
    });

    it('keeps writes in order', async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        const first = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const store = createUiSettingsStore({
            send: async (patch) => {
                const mode = patch.diffMode ?? 'unified';
                if (mode === 'split') {
                    await first;
                }
                order.push(mode);
                return merged(patch);
            },
        });

        store.update({ diffMode: 'split' });
        store.update({ diffMode: 'unified' });
        releaseFirst();
        await vi.waitFor(() => {
            expect(order).toHaveLength(2);
        });

        expect(order).toEqual(['split', 'unified']);
    });

    it('preserves settings the reviewer already changed when applying server settings', () => {
        const store = createUiSettingsStore();
        store.update({ diffMode: 'split' });

        store.applyLoaded({
            diffMode: 'unified',
            shipMode: 'sticky_ship',
            composerLayout: 'markdown',
            locale: 'auto',
            theme: 'auto',
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });

        expect(store.getSnapshot()).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'markdown',
            locale: 'auto',
            theme: 'auto',
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('does not treat loaded settings as local changes or send them anywhere', async () => {
        const { patches, send } = recording();
        const store = createUiSettingsStore({ send });

        await loadUiSettings(store, () =>
            Promise.resolve({
                diffMode: 'split',
                shipMode: 'ship',
                composerLayout: 'visual',
                locale: 'auto',
                theme: 'auto',
                textSize: 'm',
                onboarding: { completedAt: null, step: 0 },
                updates: { dismissedVersion: null },
            }),
        );

        await flush();
        expect(store.getSnapshot().diffMode).toBe('split');
        expect(patches).toEqual([]);
    });

    it('keeps defaults without crashing the UI when the endpoint is unavailable', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiSettingsStore();

        await loadUiSettings(store, () => Promise.reject(new Error('server is not responding')));

        expect(store.getSnapshot()).toEqual(DEFAULT_UI_SETTINGS);
        // No response arrived. Defaults remain defaults and cannot be used to make decisions.
        expect(store.isLoaded()).toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('sets the loaded flag and notifies subscribers on a server response even when it matches the defaults', async () => {
        const store = createUiSettingsStore();
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        expect(store.isLoaded()).toBe(false);
        await loadUiSettings(store, () => Promise.resolve({ ...DEFAULT_UI_SETTINGS }));

        expect(store.isLoaded()).toBe(true);
        expect(notified).toBe(1);
    });
});
