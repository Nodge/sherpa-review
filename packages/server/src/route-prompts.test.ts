import type { Locale } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { promptLocale, sectionGuide, sectionInstructions, skeletonGuide, skeletonInstructions } from './route-prompts.js';

import { bannedPhrases } from './route/voice.js';
 * Regression for worker behaviour rules (M2F-T31): the short task instruction must say
/**
 * never submits the finished result (dogfooding incident from 2026-08-28).
 * forbid self-validation that installs packages. Otherwise the worker silently fails to submit a finished result.
 * Also generation language (M5-T4): the instructions must require exactly one response language and list
 * exactly the filler phrases the server rejects.
 */
const instructions = [skeletonInstructions('ru'), sectionInstructions('ru', [2, 3])];

const LOCALES: readonly Locale[] = ['ru', 'en'];

function guides(locale: Locale): string[] {
    return [skeletonGuide(locale), sectionGuide(locale)];
}

describe('route task instructions', () => {
    it('say the server checks the schema and forbid self-validation that installs packages', () => {
        for (const text of instructions) {
            expect(text).toContain('checked by the server');
            expect(text).toContain('do not validate the result yourself');
            expect(text).toContain('do not\ninstall anything');
            expect(text).toContain('always submit what you produced');
        }
    });
});

describe('regeneration instructions', () => {
    const files = { interdiff: true, previousRoute: true, threadsSince: true };

    it('list the second-pass context that is actually present', () => {
        for (const text of [skeletonInstructions('ru', files), sectionInstructions('ru', [2], files)]) {
            expect(text).toContain('interdiff.md');
            expect(text).toContain('previous-route.md');
            expect(text).toContain('threads-since.md');
        }
    });

    it('the first generation has no second-pass context or slice references', () => {
        for (const text of instructions) {
            expect(text).not.toContain('previous-route.md');
            expect(text).not.toContain('rebuild');
            expect(text).not.toContain('interdiff');
            expect(text).not.toContain('pushed since');
        }
    });

    it('regeneration on the same iteration mentions no slice or push', () => {
        const text = sectionInstructions('ru', [2], { ...files, interdiff: false });

        expect(text).not.toContain('interdiff');
        expect(text).not.toContain('pushed since');
        expect(text).toContain('previous-route.md');
        expect(text).toContain('the code has not\nmoved since');
    });
});

describe('route guides', () => {
    it('validator rejection is part of the loop and silent non-submission is forbidden', () => {
        for (const locale of LOCALES) {
            for (const guide of guides(locale)) {
                expect(guide).toContain('The server is the only validator.');
                expect(guide).toContain('Never end the task silently');
                expect(guide).toContain('sherpa task fail <id> --reason <text>');
                expect(guide).toContain('do\nnot install validators or packages');
            }
        }
    });

    it('shared context files under `shared/` are read once per session', () => {
        for (const text of [...instructions, ...guides('ru'), ...guides('en')]) {
            expect(text).toContain('shared/');
            expect(text).toContain('once');
        }
    });

    it('both roles get second-pass instructions that preserve the plan and allow reasons only for affected stops', () => {
        for (const locale of LOCALES) {
            const [skeleton, section] = guides(locale);
            expect(skeleton).toContain('## Rebuilding an existing route');
            expect(skeleton).toContain('Keep the plan, its order and its titles wherever the code did not change');
            // Both cases are covered, with and without a push, since the instructions are shared by all tasks.
            expect(skeleton).toContain('**With `interdiff.md`**');
            expect(skeleton).toContain('**Without `interdiff.md`** — the code has not moved');
            expect(section).toContain('## Why this stop changed');
            expect(section).toContain('changeReason');
            expect(section).toContain('[thread:<id>]');
            expect(section).toContain('you never declare the kind, only the reason');
        }
    });

    it('voice rules name banned filler phrases and state that the server rejects them', () => {
        for (const guide of guides('ru')) {
            expect(guide).toContain(`«${String(bannedPhrases('ru')[0])}»`);
            expect(guide).toContain('The server rejects texts containing these.');
            expect(guide).toContain('No emoji (the server rejects them)');
        }
        for (const guide of guides('en')) {
            expect(guide).toContain('"it is worth noting"');
            expect(guide).toContain('The server rejects texts containing these.');
            expect(guide).toContain('No emoji (the server rejects them)');
        }
    });
});

describe('generation language in prompts', () => {
    it('the Russian guide requires Russian in every result field', () => {
        const [skeleton, section] = guides('ru');
        expect(skeleton).toContain('**Write in Russian.**');
        expect(skeleton).toContain('a short paragraph in Russian');
        expect(skeleton).toContain('conceptual, in Russian');
        expect(skeleton).toContain('one or two sentences in Russian');
        expect(section).toContain('2 to 4 sentences in Russian');
        expect(section).toContain('one sentence in Russian');
        expect(section).toContain('1 to 3 sentences in Russian');
        expect(section).toContain('behaviour, in Russian');
    });

    it('the English guide requires English and does not mention Russian', () => {
        const [skeleton, section] = guides('en');
        expect(skeleton).toContain('**Write in English.**');
        expect(skeleton).toContain('a short paragraph in English');
        expect(section).toContain('2 to 4 sentences in English');
        expect(section).toContain('behaviour, in English');
        for (const guide of [skeleton, section]) {
            expect(guide).not.toContain('in Russian');
        }
    });

    it('only the Russian guide has a rule against transliteration', () => {
        for (const guide of guides('ru')) {
            expect(guide).toContain('jargon transliterated into Russian');
            expect(guide).toContain(promptLocale('ru').plainWords.join('\n'));
        }
        for (const guide of guides('en')) {
            expect(guide).not.toContain('transliterated');
        }
    });

    it('guide filler phrases match the generation locale and exclude the other locale', () => {
        for (const guide of guides('ru')) {
            expect(guide).not.toContain('it is worth noting');
        }
        for (const guide of guides('en')) {
            expect(guide).not.toContain(String(bannedPhrases('ru')[0]));
        }
    });

    it('short instructions name the response language', () => {
        expect(skeletonInstructions('en')).toContain('in English');
        expect(sectionInstructions('en', [1])).toContain('in English');
        expect(skeletonInstructions('ru')).toContain('in Russian');
        expect(sectionInstructions('ru', [1])).toContain('in Russian');
    });
});
