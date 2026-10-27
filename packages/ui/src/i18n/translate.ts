import type { Locale, LocaleSetting, LocalizedText } from '@sherpa/protocol';

import { en } from './en.js';
import { formatRelativeSpan, relativeSpan } from './format.js';
import type { Dictionary, MessageKey } from './ru.js';
import { ru } from './ru.js';

/** Key parameters: string entries have none, functions use their own arguments. */
type MessageArgs<K extends MessageKey> = Dictionary[K] extends (...args: infer A) => string ? A : [];

/**
 * Translate a dictionary key. Extra, missing or invalid arguments cause a compile error.
 * `locale` is the dictionary language. It selects the string from the server's `LocalizedText`.
 */
export type Translate = (<K extends MessageKey>(key: K, ...args: MessageArgs<K>) => string) & {
    readonly locale: Locale;
};

/** Server label in the dictionary language. */
export function localized(text: LocalizedText, t: Translate): string {
    return text[t.locale];
}

/**
 * Language priority: explicit choice in settings → agent hint
 * (`uiState.worker.lang`) → first browser language, where anything starting with `ru` means Russian,
 * and everything else means English. `auto` means "agent, then browser".
 */
export function resolveLocale(
    setting: LocaleSetting,
    agentLang: Locale | undefined,
    languages: readonly string[],
): Locale {
    if (setting !== 'auto') {
        return setting;
    }
    if (agentLang !== undefined) {
        return agentLang;
    }
    return (languages[0] ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * Language for code outside the React tree: `api.ts`, the state store and the reading progress model. It is held by
 * `LocaleProvider`. Before the first render and in tests without a provider, it stays English.
 */
let activeLocale: Locale = 'en';

export function setActiveLocale(locale: Locale): void {
    activeLocale = locale;
}

/** Translation where hooks are unavailable. Components use `useT`. */
export function activeT(): Translate {
    return createT(activeLocale);
}

const translators = new Map<Locale, Translate>();

/** Translation function for a locale. One instance per locale makes it safe for hook dependencies. */
export function createT(locale: Locale): Translate {
    const cached = translators.get(locale);
    if (cached !== undefined) {
        return cached;
    }
    const dictionary: Dictionary = locale === 'ru' ? ru : en;
    const translate = Object.assign(
        (key: MessageKey, ...args: unknown[]): string => {
            const message = dictionary[key];
            return typeof message === 'function' ? (message as (...rest: unknown[]) => string)(...args) : message;
        },
        { locale },
    ) as Translate;
    translators.set(locale, translate);
    return translate;
}

/**
 * Translate a key known only at runtime: command labels and consequences from the
 * shortcuts registry. The argument is checked where the command is declared. Types are no longer available here.
 */
export function translateKey(t: Translate, key: MessageKey, arg?: string | number): string {
    const translate = t as unknown as (key: MessageKey, ...args: (string | number)[]) => string;
    return arg === undefined ? translate(key) : translate(key, arg);
}

/** Short relative time: "6 hr. ago", "6 hr. ago", "yesterday". Under a minute becomes "just now". */
export function relativeTime(createdAt: string, now: number, locale: Locale): string {
    const span = relativeSpan(createdAt, now);
    return span === null ? createT(locale)('time.justNow') : formatRelativeSpan(span, locale);
}
