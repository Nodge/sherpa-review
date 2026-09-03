import type { Locale, LocaleSetting } from '@sherpa/protocol';

import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import { useShortcut } from '../shortcuts/context.tsx';
import { useAgentLang, useLocale } from './context.tsx';
import type { MessageKey } from './ru.js';

/**
 * Palette commands in the "Sherpa" group switch the language. The design has no separate settings popover,
 * and language changes are rare. The choice is saved in global settings (`PATCH /api/ui/settings`),
 * and the UI renders again in the new language without a reload.
 */

/**
 * The "now: …" label for the current choice. With `auto`, it names both the language and the source
 * it comes from, either the agent or the browser.
 */
export function currentLocaleKey(setting: LocaleSetting, locale: Locale, agentLang: Locale | undefined): MessageKey {
    if (setting !== 'auto') {
        return setting === 'ru' ? 'shortcut.locale.now.ru' : 'shortcut.locale.now.en';
    }
    if (agentLang !== undefined) {
        return locale === 'ru' ? 'shortcut.locale.now.agentRu' : 'shortcut.locale.now.agentEn';
    }
    return locale === 'ru' ? 'shortcut.locale.now.browserRu' : 'shortcut.locale.now.browserEn';
}

/** Three language selection commands. The palette omits the active choice because it would change nothing. */
export function useLocaleCommands(): void {
    const settings = useUiSettingsStore();
    const setting = useUiSettings().locale;
    const locale = useLocale();
    const agentLang = useAgentLang();
    const consequence = currentLocaleKey(setting, locale, agentLang);

    useShortcut({
        id: 'locale.ru',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.locale.ru',
        scope: 'global',
        section: 'navigation',
        consequence,
        when: () => setting !== 'ru',
        action: () => {
            settings.update({ locale: 'ru' });
        },
    });
    useShortcut({
        id: 'locale.en',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.locale.en',
        scope: 'global',
        section: 'navigation',
        consequence,
        when: () => setting !== 'en',
        action: () => {
            settings.update({ locale: 'en' });
        },
    });
    useShortcut({
        id: 'locale.auto',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.locale.auto',
        scope: 'global',
        section: 'navigation',
        consequence,
        when: () => setting !== 'auto',
        action: () => {
            settings.update({ locale: 'auto' });
        },
    });
}
