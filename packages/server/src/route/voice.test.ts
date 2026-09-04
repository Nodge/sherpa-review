import { describe, expect, it } from 'vitest';

import { bannedPhrases, voiceErrors } from './voice.js';

describe('voice stop list', () => {
    it('accepts clean text', () => {
        expect(voiceErrors('at', 'The handler was rewritten: the edit window is now 30 minutes.', 'ru')).toEqual([]);
        expect(voiceErrors('at', null, 'ru')).toEqual([]);
        expect(voiceErrors('at', undefined, 'ru')).toEqual([]);
    });

    it('matches filler phrases case-insensitively and includes the path in the error', () => {
        const errors = voiceErrors('section.stops[2].paragraph', `${String(bannedPhrases('ru')[0]).toUpperCase()}: the code got simpler.`, 'ru');
        expect(errors).toEqual([
            `section.stops[2].paragraph: drop the filler phrase "${String(bannedPhrases('ru')[0])}" and state the fact directly (see Voice in the methodology).`,
        ]);
    });

    it('lists every violation when there are several', () => {
        const errors = voiceErrors('at', `${bannedPhrases('ru').slice(0, 2).join(', ')} 🎉`, 'ru');
        expect(errors).toHaveLength(3);
    });

    it('detects emoji', () => {
        expect(voiceErrors('at', 'Done ✨', 'ru')).toEqual([
            'at: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ]);
    });

    it('does not treat ordinary punctuation and typography as emoji', () => {
        expect(voiceErrors('at', 'Range 1–40, arrow →, «quotes», `code`.', 'ru')).toEqual([]);
    });
});

describe('voice stop list for English generation', () => {
    it('matches its own filler phrases and shares the emoji rule', () => {
        expect(voiceErrors('answer', 'It is worth noting that the handler was rewritten.', 'en')).toEqual([
            'answer: drop the filler phrase "it is worth noting" and state the fact directly (see Voice in the methodology).',
        ]);
        expect(voiceErrors('answer', 'As we can see, the window is 30 minutes now.', 'en')).toHaveLength(1);
        expect(voiceErrors('answer', 'Done ✨', 'en')).toEqual([
            'answer: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ]);
    });

    it('accepts clean English text', () => {
        expect(voiceErrors('at', 'The handler now rejects edits later than 30 minutes.', 'en')).toEqual([]);
    });

    it('allows foreign-language phrases because the stop list belongs to the generation locale', () => {
        expect(voiceErrors('at', 'Important to note: the diff is small.', 'en')).toEqual([]);
        expect(voiceErrors('at', 'It is worth noting — a quote from the discussion.', 'ru')).toEqual([]);
    });

    it('has at least six phrases for each locale', () => {
        expect(bannedPhrases('ru').length).toBeGreaterThanOrEqual(6);
        expect(bannedPhrases('en').length).toBeGreaterThanOrEqual(6);
    });
});
