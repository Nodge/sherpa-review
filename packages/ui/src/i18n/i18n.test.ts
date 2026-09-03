import { describe, expect, it } from 'vitest';

import { en } from './en.js';
import { formatCount, formatDateTime, formatRelativeSpan, plural } from './format.js';
import { ru } from './ru.js';
import { createT, relativeTime, resolveLocale } from './translate.js';

describe('language selection', () => {
    it('in auto the agent hint takes precedence over the browser', () => {
        expect(resolveLocale('auto', 'ru', ['en-US'])).toBe('ru');
        expect(resolveLocale('auto', 'en', ['ru-RU'])).toBe('en');
    });

    it('without an agent hint auto uses only the first browser language', () => {
        expect(resolveLocale('auto', undefined, ['ru-RU', 'en-US'])).toBe('ru');
        expect(resolveLocale('auto', undefined, ['RU'])).toBe('ru');
        expect(resolveLocale('auto', undefined, ['en-US', 'ru-RU'])).toBe('en');
        expect(resolveLocale('auto', undefined, [])).toBe('en');
    });

    it('an explicit choice overrides both the agent and the browser', () => {
        expect(resolveLocale('en', 'ru', ['ru-RU'])).toBe('en');
        expect(resolveLocale('ru', 'en', ['en-US'])).toBe('ru');
        expect(resolveLocale('ru', undefined, ['en-US'])).toBe('ru');
    });
});

describe('dictionaries', () => {
    it('keys and parameter counts match', () => {
        const ruKeys = Object.keys(ru).toSorted();
        const enKeys = Object.keys(en).toSorted();
        expect(enKeys).toEqual(ruKeys);

        const mismatched = ruKeys.filter((key) => {
            const left = ru[key as keyof typeof ru] as unknown;
            const right = en[key as keyof typeof en] as unknown;
            if (typeof left === 'function' && typeof right === 'function') {
                return left.length !== right.length;
            }
            return typeof left !== typeof right;
        });
        expect(mismatched, 'keys with different signatures').toEqual([]);
    });

    it('no entry is empty', () => {
        const empty = Object.entries(en).filter(([, value]) => typeof value === 'string' && value.trim() === '');
        expect(empty).toEqual([]);
    });

    it('t substitutes parameters in the selected language', () => {
        expect(createT('ru')('ship.progress', 12, 2412)).toContain(`12 / ${formatCount(2412, 'ru')} `);
        expect(createT('en')('ship.progress', 12, 2412)).toBe('12 / 2,412 files');
    });
});

describe('formatting', () => {
    it('grouping uses a non-breaking space in Russian and a comma in English', () => {
        expect(formatCount(2412, 'ru')).toBe('2 412');
        expect(formatCount(2412, 'en')).toBe('2,412');
        expect(formatCount(999, 'ru')).toBe('999');
        expect(formatCount(1234567, 'ru')).toBe('1 234 567');
    });

    it('Russian plural forms follow Intl rules, English uses one and other', () => {
        const forms = { one: 'one', few: 'few', many: 'many', other: 'other' };
        expect([1, 2, 5, 11, 21].map((value) => plural(value, forms, 'ru'))).toEqual([
            'one',
            'few',
            'many',
            'many',
            'one',
        ]);

        const enForms = { one: 'file', other: 'files' };
        expect([1, 2, 5, 11, 21].map((value) => plural(value, enForms, 'en'))).toEqual([
            'file',
            'files',
            'files',
            'files',
            'files',
        ]);
    });

    it('relative time keeps the min/hr/day/week/month/year scale in both locales', () => {
        const now = Date.parse('2026-09-03T12:00:00.000Z');
        const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString();

        expect(relativeTime(ago(30), now, 'ru')).toBe(ru['time.justNow']);
        expect(relativeTime(ago(30), now, 'en')).toBe('just now');
        expect(relativeTime(ago(60), now, 'ru')).toBe(formatRelativeSpan({ value: 1, unit: 'minute' }, 'ru'));
        expect(relativeTime(ago(60 * 6), now, 'en')).toBe('6 min. ago');
        expect(relativeTime(ago(3600 * 6), now, 'ru')).toBe(formatRelativeSpan({ value: 6, unit: 'hour' }, 'ru'));
        expect(relativeTime(ago(3600 * 6), now, 'en')).toBe('6 hr. ago');
        expect(relativeTime(ago(86_400 * 3), now, 'ru')).toBe(formatRelativeSpan({ value: 3, unit: 'day' }, 'ru'));
        expect(relativeTime(ago(86_400 * 3), now, 'en')).toBe('3 days ago');
        expect(relativeTime(ago(86_400 * 14), now, 'ru')).toBe(formatRelativeSpan({ value: 2, unit: 'week' }, 'ru'));
        expect(relativeTime(ago(86_400 * 14), now, 'en')).toBe('2 wk. ago');
        expect(relativeTime(ago(86_400 * 120), now, 'ru')).toBe(formatRelativeSpan({ value: 4, unit: 'month' }, 'ru'));
        expect(relativeTime(ago(86_400 * 120), now, 'en')).toBe('4 mo. ago');
        expect(relativeTime(ago(86_400 * 800), now, 'ru')).toBe(formatRelativeSpan({ value: 2, unit: 'year' }, 'ru'));
        expect(relativeTime(ago(86_400 * 800), now, 'en')).toBe('2 yr. ago');
    });

    it('absolute dates follow locale rules and unparseable dates return unchanged', () => {
        const iso = '2026-09-03T10:00:00.000Z';
        expect(formatDateTime(iso, 'ru')).not.toBe(formatDateTime(iso, 'en'));
        expect(formatDateTime(iso, 'ru')).toContain('2026');
        expect(formatDateTime('not a date', 'ru')).toBe('not a date');
    });

    it('an invalid date and a future date do not break the label', () => {
        const now = Date.parse('2026-09-03T12:00:00.000Z');
        expect(relativeTime('not a date', now, 'ru')).toBe(ru['time.justNow']);
        expect(relativeTime(new Date(now + 60_000).toISOString(), now, 'en')).toBe('just now');
    });
});
