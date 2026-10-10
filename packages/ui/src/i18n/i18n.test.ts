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

    it('the second-pass note agrees with the count in both languages', () => {
        // "N of M stops": the noun follows M, not the carried-over count.
        expect(createT('en')('iteration.secondPass.carried.kept', 1, 6)).toBe('1 of 6 stops stayed viewed. ');
        expect(createT('en')('iteration.secondPass.carried.kept', 1, 1)).toBe('1 of 1 stop stayed viewed. ');
        expect(createT('en')('iteration.secondPass.carried.none', 1)).toBe('None of the 1 stop stayed viewed. ');
        expect(changedWords(createT('ru')('iteration.secondPass.carried.kept', 1, 6), createT('ru')('iteration.secondPass.carried.kept', 3, 6))).toBe(
            4,
        );
        expect(changedWords(createT('ru')('iteration.secondPass.carried.kept', 3, 6), createT('ru')('iteration.secondPass.carried.kept', 4, 6))).toBe(
            1,
        );
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

/**
 * Plural forms: a predicate, pronoun or counting unit used to keep a fixed form that disagreed with the count.
 * Russian cases count the words that differ, position by position, between the singular and another count.
 */
const changedWords = (a: string, b: string): number => a.split(' ').filter((word, i) => word !== b.split(' ')[i]).length;
describe('agreement with the count', () => {
    const t = createT('ru');
    const e = createT('en');

    it('Russian templates agree in the singular', () => {
        expect(changedWords(t('route.gen.filling.counter', 1, 7), t('route.gen.filling.counter', 2, 7))).toBe(2);
        expect(changedWords(t('route.filling.banner', 1, 7), t('route.filling.banner', 2, 7))).toBe(2);
        expect(changedWords(t('route.gen.step.diffFiles', 1), t('route.gen.step.diffFiles', 2))).toBe(2);
        expect(changedWords(t('route.lazyMore', 1), t('route.lazyMore', 2))).toBe(3);
        expect(changedWords(t('route.stopFile.collapsed', 1), t('route.stopFile.collapsed', 2))).toBe(4);
        expect(changedWords(t('route.other.counted', 1, 1), t('route.other.counted', 2, 1))).toBe(7);
        expect(changedWords(t('route.other.counted', 1, 1), t('route.other.counted', 21, 1))).toBe(1);
        expect(changedWords(t('route.other.failedFiles', 1), t('route.other.failedFiles', 2))).toBe(4);
        expect(changedWords(t('margin.footer.failed', 1), t('margin.footer.failed', 2))).toBe(4);
        expect(changedWords(t('diff.expand.loaded', 1), t('diff.expand.loaded', 2))).toBe(2);
        expect(changedWords(t('diff.gap.hiddenCount', 1), t('diff.gap.hiddenCount', 2))).toBe(3);
        expect(changedWords(t('diff.gap.loadAll', 1, '…'), t('diff.gap.loadAll', 2, '…'))).toBe(2);
        expect(changedWords(t('audit.line', 1, 1, 2), t('audit.line', 2, 1, 2))).toBe(3);
        expect(changedWords(t('prComments.buffered.title', 1), t('prComments.buffered.title', 2))).toBe(4);
        expect(changedWords(t('ship.disabled.buffered', 1), t('ship.disabled.buffered', 2))).toBe(4);
        expect(changedWords(t('complete.outsideRoute.value', 1), t('complete.outsideRoute.value', 2))).toBe(3);
        expect(changedWords(t('route.stop.conflicts', 1), t('route.stop.conflicts', 2))).toBe(3);
        expect(changedWords(t('route.other.conflicts', 1), t('route.other.conflicts', 2))).toBe(6);
        expect(changedWords(t('banner.generationCap', 1), t('banner.generationCap', 2))).toBe(4);
        expect(changedWords(t('overview.ownership.stats', 'CODEOWNERS', 1, 1, 5, 21), t('overview.ownership.stats', 'CODEOWNERS', 1, 2, 5, 22))).toBe(
            4,
        );
        expect(changedWords(t('palette.truncated', 21), t('palette.truncated', 1))).toBe(1);
    });

    it('Russian impersonal predicates keep the invariant form for unexplained lines', () => {
        expect(changedWords(t('coverage.legend.unexplained', 5), t('coverage.legend.unexplained', 2))).toBe(3);
        expect(changedWords(t('complete.openThreads', 5), t('complete.openThreads', 2))).toBe(3);
        expect(changedWords(t('ship.guard.stops', 2), t('ship.guard.stops', 5))).toBe(3);
        expect(changedWords(t('ship.guard.files', 2), t('ship.guard.files', 5))).toBe(3);
    });

    it('English templates agree in the singular', () => {
        expect(e('route.gen.step.diffFiles', 1)).toBe('Reading the whole diff · 1 file');
        expect(e('route.lazyMore', 1)).toBe('1 more card — it appears as you scroll');
        expect(e('route.other.counted', 1, 1)).toContain('so it is not lost — it collects here');
        expect(e('route.other.failedFiles', 1)).toContain('— its uncovered lines');
        expect(e('margin.footer.failed', 1)).toContain('— its lines');
        expect(e('diff.expand.loaded', 1)).toBe('1 line loaded');
        expect(e('diff.gap.hiddenCount', 1)).toBe('1 line hidden');
        expect(e('audit.line', 1, 1, 2)).toMatch(/^Showing only 1 audit-scope file/u);
        expect(e('prComments.buffered.title', 1)).toContain('until it is saved');
        expect(e('ship.disabled.buffered', 1)).toContain('until it is');
        expect(e('route.stop.conflicts', 1)).toContain('resolve it outside Sherpa');
        expect(e('route.other.conflicts', 1)).toContain('resolve it outside Sherpa; it is out of coverage');
        expect(e('banner.generationCap', 1)).toContain('check it in the full diff');
        expect(e('palette.truncated', 1)).toBe('Showing the first 1 match');
    });
});
