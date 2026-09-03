import type { Locale } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';

import { useUiSettings } from '../settings/context.tsx';
import type { PluralForms } from './format.js';
import { formatCount, plural } from './format.js';
import type { Translate } from './translate.js';
import { createT, relativeTime, resolveLocale } from './translate.js';

/**
 * The UI language derives from the `locale` setting (`auto | ru | en`) and the agent hint,
 * so the provider sits inside `SettingsProvider`. Outside the provider (gallery, component
 * tests), English is used: the tree must render without settings or a network connection.
 */

const LocaleContext = createContext<Locale>('en');

/**
 * The agent hint is stored alongside the language: palette commands need both "currently Russian"
 * and its source, the agent or the browser.
 */
const AgentLangContext = createContext<Locale | undefined>(undefined);

export function LocaleProvider({
    locale,
    agentLang,
    children,
}: {
    locale?: Locale;
    /** `uiState.worker.lang`: the store subscription lives in `main.tsx` to keep it out of the gallery. */
    agentLang?: Locale | undefined;
    children: ReactNode;
}) {
    const setting = useUiSettings().locale;
    // Explicit locale for the gallery: it has no settings and needs to show both.
    const resolved = locale ?? resolveLocale(setting, agentLang, browserLanguages());

    useEffect(() => {
        document.documentElement.lang = resolved;
    }, [resolved]);

    return (
        <AgentLangContext value={agentLang}>
            <LocaleContext value={resolved}>{children}</LocaleContext>
        </AgentLangContext>
    );
}

export function useLocale(): Locale {
    return useContext(LocaleContext);
}

/** Agent language hint. `undefined` means the agent did not provide it or the server does not know it yet. */
export function useAgentLang(): Locale | undefined {
    return useContext(AgentLangContext);
}

export function useT(): Translate {
    return createT(useLocale());
}

/** Formatting with the context locale so components do not have to pass it by hand. */
export interface Formatters {
    readonly count: (value: number) => string;
    readonly plural: (value: number, forms: PluralForms) => string;
    readonly relativeTime: (createdAt: string, now: number) => string;
}

export function useFormat(): Formatters {
    const locale = useLocale();
    return useMemo(
        () => ({
            count: (value: number) => formatCount(value, locale),
            plural: (value: number, forms: PluralForms) => plural(value, forms, locale),
            relativeTime: (createdAt: string, now: number) => relativeTime(createdAt, now, locale),
        }),
        [locale],
    );
}

/** Browser languages for `auto`. An environment without `navigator` (test server rendering) has none. */
function browserLanguages(): readonly string[] {
    if (typeof navigator === 'undefined') {
        return [];
    }
    return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}
