import { describe, expect, it } from 'vitest';

import { resolveGenerationLocale } from './generation-locale.js';

describe('generation language', () => {
    it('gives the UI request priority over everything else', () => {
        expect(resolveGenerationLocale({ requested: 'en', setting: 'ru', agentLang: 'ru' })).toBe('en');
        expect(resolveGenerationLocale({ requested: 'ru', setting: 'en', agentLang: 'en' })).toBe('ru');
    });

    it('uses the explicit settings choice when there is no request', () => {
        expect(resolveGenerationLocale({ setting: 'en', agentLang: 'ru' })).toBe('en');
        expect(resolveGenerationLocale({ setting: 'ru', agentLang: 'en' })).toBe('ru');
    });

    it('lets the agent hint decide when settings use `auto`', () => {
        expect(resolveGenerationLocale({ setting: 'auto', agentLang: 'ru' })).toBe('ru');
        expect(resolveGenerationLocale({ agentLang: 'ru' })).toBe('ru');
    });

    it('defaults to English when no language is specified', () => {
        expect(resolveGenerationLocale({})).toBe('en');
        expect(resolveGenerationLocale({ setting: 'auto' })).toBe('en');
        expect(resolveGenerationLocale({ setting: 'auto', agentLang: undefined })).toBe('en');
    });
});
