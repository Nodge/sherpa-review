import type { Locale } from '@sherpa/protocol';

/**
 * Number, date and plural formatting through `Intl`: the platform owns pluralization and grouping
 * rules, not our code. Dictionary strings are built from these functions (`ru.ts`, `en.ts`),
 * so this module has no text, only formatting.
 */

const numberFormats = new Map<Locale, Intl.NumberFormat>();
const pluralRules = new Map<Locale, Intl.PluralRules>();
const relativeFormats = new Map<Locale, Intl.RelativeTimeFormat>();
const dateTimeFormats = new Map<Locale, Intl.DateTimeFormat>();

/**
 * Locale-specific digit grouping: "2 412" uses a non-breaking space in Russian (SPEC §2.13),
 * "2,412" in English. ICU returns either U+00A0 or narrow U+202F as the `ru` separator,
 * normalize to one non-breaking space so the counter string does not depend on the Node version.
 */
export function formatCount(value: number, locale: Locale): string {
    const formatted = formatter(numberFormats, locale, () =>
        new Intl.NumberFormat(locale, { useGrouping: true }),
    ).format(value);
    return locale === 'ru' ? formatted.replaceAll(/\s/gu, '\u00a0') : formatted;
}

/**
 * Plural forms. `other` is required as the default form for any locale.
 * In Russian it matches `many` (5 files), in English it covers everything except `one`.
 */
export interface PluralForms {
    readonly one: string;
    readonly few?: string;
    readonly many?: string;
    readonly other: string;
}

export function plural(value: number, forms: PluralForms, locale: Locale): string {
    const category = formatter(pluralRules, locale, () => new Intl.PluralRules(locale)).select(value);
    if (category === 'one') {
        return forms.one;
    }
    if (category === 'few') {
        return forms.few ?? forms.other;
    }
    if (category === 'many') {
        return forms.many ?? forms.other;
    }
    return forms.other;
}

/** Relative time scale step. `null` means less than a minute or an unparseable date. */
export interface RelativeSpan {
    readonly value: number;
    readonly unit: Intl.RelativeTimeFormatUnit;
}

/**
 * Relative time scale for thread metadata: minutes → hours → days → weeks → months → years.
 * `now` is injected to keep the gallery deterministic.
 */
export function relativeSpan(createdAt: string, now: number): RelativeSpan | null {
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created)) {
        return null;
    }
    const seconds = Math.max(Math.floor((now - created) / 1000), 0);
    if (seconds < 60) {
        return null;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return { value: minutes, unit: 'minute' };
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return { value: hours, unit: 'hour' };
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return { value: days, unit: 'day' };
    }
    if (days < 30) {
        return { value: Math.floor(days / 7), unit: 'week' };
    }
    if (days < 365) {
        return { value: Math.floor(days / 30), unit: 'month' };
    }
    return { value: Math.floor(days / 365), unit: 'year' };
}

/** Complete phrase for a scale step: "6 hours ago", "6 hr. ago", "yesterday". */
export function formatRelativeSpan(span: RelativeSpan, locale: Locale): string {
    // `numeric: 'auto'` gives "yesterday" instead of "1 day ago". Russian `narrow` drops "ago".
    return formatter(relativeFormats, locale, () =>
        new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }),
    ).format(-span.value, span.unit);
}

/** Absolute date and time for places where relative time is too coarse. */
export function formatDateTime(iso: string, locale: Locale): string {
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) {
        return iso;
    }
    return formatter(dateTimeFormats, locale, () =>
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    ).format(parsed);
}

/** The label shows 7 hex characters of the commit (README §13). `title` holds the full hash. */
export function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

/** `Intl` formatters are expensive to create, so use one per locale for the whole page. */
function formatter<T>(cache: Map<Locale, T>, locale: Locale, create: () => T): T {
    const cached = cache.get(locale);
    if (cached !== undefined) {
        return cached;
    }
    const created = create();
    cache.set(locale, created);
    return created;
}
