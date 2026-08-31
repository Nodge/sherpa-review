/**
 * Voice stop list for route texts the reviewer reads (M2F-T31).
 *
 * Only unambiguous cases are rejected: emoji and filler phrases from a fixed list.
 * These don't produce false positives, so a hard rejection is justified. Matters of taste
 * ("less filler", superlatives) stay in the guide: without morphology, Russian words for "further" and "nearest"
 * can't be distinguished from superlatives, and a false positive wastes
 * a model attempt on a matter of style.
 */

const BANNED_PHRASES = [
    'важно отметить',
    'стоит отметить',
    'важно понимать',
    'стоит понимать',
    'как мы видим',
    'нельзя не отметить',
] as const;

const EMOJI = /\p{Extended_Pictographic}/u;

/** Voice errors for one text field. `at` is the field path in the model's JSON. */
export function voiceErrors(at: string, text: string | null | undefined): string[] {
    if (text === null || text === undefined) {
        return [];
    }
    const errors: string[] = [];
    const lower = text.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
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
