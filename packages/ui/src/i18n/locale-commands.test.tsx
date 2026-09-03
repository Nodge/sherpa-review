// @vitest-environment jsdom
import type { Locale, UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore, DEFAULT_UI_SETTINGS } from '../settings/settings-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import type { Shortcut } from '../shortcuts/registry.js';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import { LocaleProvider, ru, useT } from './index.js';
import { useLocaleCommands } from './locale-commands.js';

/**
 * A palette command switches the language without a reload: the choice is saved in settings,
 * and the locale provider renders the tree again with the new dictionary.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function Probe() {
    useLocaleCommands();
    const t = useT();
    return <span data-testid="probe">{t('topbar.search')}</span>;
}

function mount(send: (patch: UiSettingsPatch) => Promise<UiSettings>, agentLang?: Locale) {
    const registry = createShortcutRegistry();
    const settings = createUiSettingsStore({ send });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    // The agent hint arrives over SSE. The test changes a prop on the mounted tree.
    const render = (lang: Locale | undefined): void => {
        act(() => {
            root.render(
                <ShortcutsProvider registry={registry}>
                    <SettingsProvider store={settings}>
                        <LocaleProvider agentLang={lang}>
                            <Probe />
                        </LocaleProvider>
                    </SettingsProvider>
                </ShortcutsProvider>,
            );
        });
    };
    render(agentLang);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const command = (id: string): Shortcut => {
        const found = registry.list().find((shortcut) => shortcut.id === id);
        if (found === undefined) {
            throw new Error(`command ${id} is not registered`);
        }
        return found;
    };
    return { host, registry, settings, command, render };
}

describe('language selection commands', () => {
    it('switch the language immediately and save the choice in settings', async () => {
        const send = vi.fn((_patch: UiSettingsPatch) => Promise.resolve(DEFAULT_UI_SETTINGS));
        const { host, settings, command } = mount(send);

        // `auto` is the default, and the jsdom browser uses English.
        expect(host.textContent).toBe('Search');
        expect(document.documentElement.lang).toBe('en');

        act(() => {
            command('locale.ru').action();
        });

        expect(host.textContent).toBe(ru['topbar.search']);
        expect(settings.getSnapshot().locale).toBe('ru');
        // Settings writes use a promise chain. The write goes out on the next tick.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(send).toHaveBeenCalledWith({ locale: 'ru' });
        expect(document.documentElement.lang).toBe('ru');

        act(() => {
            command('locale.en').action();
        });

        expect(host.textContent).toBe('Search');
    });

    it('hide the active choice and name the current language in the consequence', () => {
        const send = vi.fn((_patch: UiSettingsPatch) => Promise.resolve(DEFAULT_UI_SETTINGS));
        const { command } = mount(send);

        // `auto` is the default, the agent gives no hint, and the jsdom browser uses English.
        expect(command('locale.auto').when?.()).toBe(false);
        expect(command('locale.ru').when?.()).toBe(true);
        expect(command('locale.ru').consequence).toBe('shortcut.locale.now.browserEn');
        expect(command('locale.ru').group).toBe('palette.group.sherpa');

        act(() => {
            command('locale.ru').action();
        });

        expect(command('locale.ru').when?.()).toBe(false);
        expect(command('locale.auto').consequence).toBe('shortcut.locale.now.ru');
    });

    it('use the agent language in auto mode and name the source in the consequence', () => {
        const send = vi.fn((_patch: UiSettingsPatch) => Promise.resolve(DEFAULT_UI_SETTINGS));
        const { host, command, render } = mount(send, 'ru');

        // The jsdom browser uses English. The agent hint overrides it.
        expect(host.textContent).toBe(ru['topbar.search']);
        expect(command('locale.en').consequence).toBe('shortcut.locale.now.agentRu');

        // The agent changed the conversation language. The UI switches without a reload.
        render('en');
        expect(host.textContent).toBe('Search');
        expect(command('locale.ru').consequence).toBe('shortcut.locale.now.agentEn');

        // An explicit choice takes precedence over the hint.
        act(() => {
            command('locale.ru').action();
        });
        expect(host.textContent).toBe(ru['topbar.search']);
        expect(command('locale.auto').consequence).toBe('shortcut.locale.now.ru');
    });
});
