import type { Locale } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { chatGuide, chatInstructions } from './chat-prompts.js';
import { bannedPhrases, quoted } from './route/voice.js';

/**
 * Chat instructions (M5-T4): response language and stop list. The filler phrase rule is exhaustive,
 * so the list must match what the server rejects. Otherwise the model wastes
 * an attempt on a phrase it was not warned about.
 */

const LOCALES: readonly Locale[] = ['ru', 'en'];

describe('chat guide', () => {
    it('names every banned phrase for its locale and none from other locales', () => {
        for (const locale of LOCALES) {
            const guide = chatGuide(locale);
            for (const phrase of bannedPhrases(locale)) {
                expect(guide).toContain(quoted(locale)(phrase));
            }
            const foreign = locale === 'ru' ? 'en' : 'ru';
            for (const phrase of bannedPhrases(foreign)) {
                expect(guide).not.toContain(phrase);
            }
        }
    });

    it('requires exactly one answer language', () => {
        expect(chatGuide('ru')).toContain('Write in Russian.');
        expect(chatGuide('ru')).not.toContain('Write in English.');
        expect(chatGuide('en')).toContain('Write in English.');
        expect(chatGuide('en')).not.toContain('in Russian');
        expect(chatInstructions('ru')).toContain('in Russian');
        expect(chatInstructions('en')).toContain('in English');
    });
});
