import { describe, expect, it } from 'vitest';

import { voiceErrors } from './voice.js';

describe('voice stop list', () => {
    it('accepts clean text', () => {
        expect(voiceErrors('at', 'The handler was rewritten: the editing window is now 30 minutes.')).toEqual([]);
        expect(voiceErrors('at', null)).toEqual([]);
        expect(voiceErrors('at', undefined)).toEqual([]);
    });

    it('matches filler phrases case-insensitively and includes the path in the error', () => {
        const errors = voiceErrors('section.stops[2].paragraph', 'Важно отметить: код стал проще.');
        expect(errors).toEqual([
            `section.stops[2].paragraph: drop the filler phrase "${String(bannedPhrases('ru')[0])}" and state the fact directly (see Voice in the methodology).`,
        ]);
    });

    it('lists every violation when there are several', () => {
        const errors = voiceErrors('at', 'Стоит понимать, что это важно отметить 🎉');
        expect(errors).toHaveLength(3);
    });

    it('detects emoji', () => {
        expect(voiceErrors('at', 'Done ✨')).toEqual([
            'at: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ]);
    });

    it('does not treat ordinary punctuation and typography as emoji', () => {
        expect(voiceErrors('at', 'Range 1–40, arrow →, «quotes», `code`.')).toEqual([]);
    });
});
