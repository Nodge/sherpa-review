import type { Locale } from '@sherpa/protocol';

/**
 * Voice stop list for route text read by the reviewer.
 *
 * Only unambiguous cases are rejected: emoji and filler phrases from a fixed list.
 * These don't produce false positives, so a hard rejection is justified. Matters of taste
 * ("less filler", superlatives) stay in the guide: without morphology, Russian words for "further" and "nearest"
 * can't be distinguished from superlatives, and a false positive wastes
 * a model attempt on a matter of style.
 *
 * Phrase lists belong to the generation locale. Foreign-language phrases aren't violations,
 * or an English quote in a Russian paragraph would trigger the stop list. The code has no rule against transliteration
 * (Russian spellings of English terms), even for `ru`: without morphology, it can't distinguish those from ordinary words,
 * so the guide handles this.
 */

const BANNED_PHRASES: Record<Locale, readonly string[]> = {
    ru: [
        'важно отметить',
        'стоит отметить',
        'важно понимать',
        'стоит понимать',
        'как мы видим',
        'нельзя не отметить',
    ],
    en: [
        'it is worth noting',
        "it's worth noting",
        'it is important to note',
        "it's important to note",
        'it should be noted',
        'as we can see',
        'it is important to understand',
        'needless to say',
    ],
};

const EMOJI = /\p{Extended_Pictographic}/u;

/** Voice errors for one text field. `at` is the field path in the model's JSON. */
export function voiceErrors(at: string, text: string | null | undefined, locale: Locale): string[] {
    if (text === null || text === undefined) {
        return [];
    }
    const errors: string[] = [];
    const lower = text.toLowerCase();
    for (const phrase of BANNED_PHRASES[locale]) {
        if (lower.includes(phrase)) {
            errors.push(
                `${at}: drop the filler phrase "${phrase}" and state the fact directly (see Voice in the methodology).`,
            );
        }
    }
    if (EMOJI.test(text)) {
        errors.push(`${at}: contains emoji — route texts are plain prose (see Voice in the methodology).`);
    }
    return errors;
}

/** Locale stop phrases for the guide. The prompt must name exactly what the server rejects. */
export function bannedPhrases(locale: Locale): readonly string[] {
    return BANNED_PHRASES[locale];
}

/** Quote marks for the text's language. Russian guillemets look out of place in an English guide. */
export function quoted(locale: Locale): (phrase: string) => string {
    return locale === 'ru' ? (phrase) => `«${phrase}»` : (phrase) => `"${phrase}"`;
}
