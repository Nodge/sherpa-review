import type { Locale } from '@sherpa/protocol';
import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { promptLocale, sectionGuide, sectionInstructions, skeletonGuide, skeletonInstructions } from './route-prompts.js';

import { bannedPhrases } from './route/voice.js';

/**
 * Regression coverage for worker behaviour rules. Short task instructions must say that the server validates and
 * forbid self-validation that installs packages. Otherwise the worker silently fails to submit a finished result.
 * Also covers generation language. The guide must require exactly one response language and name
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
    const files = { pushed: true, interdiff: true, previousRoute: true, threadsSince: true };

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
        const text = sectionInstructions('ru', [2], { ...files, pushed: false, interdiff: false });

        expect(text).not.toContain('interdiff');
        expect(text).not.toContain('pushed since');
        expect(text).toContain('previous-route.md');
        expect(text).toContain('the code has not\nmoved since');
        expect(text).not.toContain('changeReason');
    });

    it('a push without a slice is stated, does not promise the same commit and forbids a change reason', () => {
        const noInterdiff = { ...files, interdiff: false };
        const skeleton = skeletonInstructions('ru', noInterdiff);
        const section = sectionInstructions('ru', [2], noInterdiff);

        for (const text of [skeleton, section]) {
            expect(text).toContain('the author has pushed\nsince');
            expect(text).toContain('could not get the interdiff');
            expect(text).toContain('Compare the previous route with the current diff yourself');
            expect(text).not.toContain('interdiff.md');
            expect(text).not.toContain('same commit');
            expect(text).not.toContain('has not');
        }
        expect(section).toContain('Do not write `changeReason`');
        expect(skeleton).not.toContain('changeReason');
    });
});

describe('route guides', () => {
    it('validator rejection is part of the loop and silent non-submission is forbidden', () => {
        for (const locale of LOCALES) {
            for (const guide of guides(locale)) {
                expect(guide).toContain('The server is the only validator.');
                expect(guide).toContain('Never end the task silently');
                expect(guide).toContain('the printed `task fail` command');
                // Commands come from the task output, which has the full CLI path and `--pr`.
                expect(guide).toContain('the `task complete` command printed by the task, copied as is');
                expect(guide).not.toContain('sherpa-review task');
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

    it('the skeleton plans without moved patches and sections read only their stops\' files', () => {
        for (const locale of LOCALES) {
            const [skeleton, section] = guides(locale);
            expect(skeleton).toContain('Planning does not need it');
            expect(skeleton).not.toContain('Read the moved files');
            expect(section).toContain('Read the moved files of your target stops');
            expect(section).toContain('do not count toward the research budget');
        }
    });

    it('both roles get second-pass instructions that preserve the plan and allow reasons only for affected stops', () => {
        for (const locale of LOCALES) {
            const [skeleton, section] = guides(locale);
            expect(skeleton).toContain('## Rebuilding an existing route');
            expect(skeleton).toContain('Keep the plan, its order and its titles wherever the code did not change');
            // All three cases are covered because the guide serves every task: a push with a slice,
            // a push without a slice and the same iteration.
            expect(skeleton).toContain('**With `interdiff.md`**');
            expect(skeleton).toContain('**A push without `interdiff.md`**');
            expect(skeleton).toContain('compare the previous route with the current diff yourself');
            expect(skeleton).toContain('**The same commit**');
            // Without a slice, no change reason is written, even if there was a push.
            expect(section).toContain('Without `interdiff.md` do not write `changeReason` at all');
            expect(section).toContain('the author has pushed but the server could not get the interdiff');
            expect(section).toContain('## Why this stop changed');
            expect(section).toContain('changeReason');
            expect(section).toContain('[thread:<id>]');
            expect(section).toContain('you never declare the kind, only the reason');
        }
    });

    it('description markup rules name allowed forms, bans and the validator\'s numeric budget', () => {
        for (const locale of LOCALES) {
            const [, section] = guides(locale);
            expect(section).toContain('## The stop description: markup and budget');
            expect(section).toContain('`- ` for a bullet, `1. ` for a numbered one — **at most 4 items**');
            expect(section).toContain(
                'Never: headings, nested list items, several paragraphs in one list item, code blocks (fenced or\nindented), tables, images, block quotes, italics, strikethrough, horizontal rules, reference-style\nlinks (`[label]: url`).',
            );
            expect(section).toContain('After a list a closing paragraph is mandatory');
            expect(section).toContain(`**Budget: ${String(STOP_PARAGRAPH_MAX_CHARS)} characters of visible text`);
            expect(section).toContain('Link addresses and markup');
            expect(section).toContain('`#stop-<planIndex>`');
            expect(section).toContain('`#file-<path>`');
            expect(section).toContain('Only these addresses\n  are accepted');
        }
    });

    it('summary uses the same markup rules as stop descriptions, without a length budget', () => {
        for (const locale of LOCALES) {
            const [skeleton] = guides(locale);
            expect(skeleton).toContain('## The summary: markup');
            expect(skeleton).toContain('`- ` for a bullet, `1. ` for a numbered one — **at most 4 items**');
            expect(skeleton).toContain(
                'Never: headings, nested list items, several paragraphs in one list item, code blocks (fenced or\nindented), tables, images, block quotes, italics, strikethrough, horizontal rules, reference-style\nlinks (`[label]: url`).',
            );
            expect(skeleton).toContain('Only these addresses\n  are accepted');
            expect(skeleton).toContain('`#stop-<planIndex>` is a plan number of this very plan');
            expect(skeleton).not.toContain('**Budget:');
            expect(skeleton).not.toContain(String(STOP_PARAGRAPH_MAX_CHARS));
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
        expect(skeleton).toContain('a short overview of the whole pull request in Russian');
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
        expect(skeleton).toContain('a short overview of the whole pull request in English');
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
