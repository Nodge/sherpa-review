import { describe, expect, it } from 'vitest';

import { SECTION_GUIDE, SKELETON_GUIDE, sectionInstructions, skeletonInstructions } from './route-prompts.js';

import { bannedPhrases } from './route/voice.js';
 * Regression for worker behaviour rules (M2F-T31): the short task instruction must say
/**
 * never submits the finished result (dogfooding incident from 2026-08-28).
 */
const instructions = [skeletonInstructions(), sectionInstructions([2, 3])];

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
        for (const text of [skeletonInstructions(files), sectionInstructions([2], files)]) {
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
        const text = sectionInstructions([2], { ...files, interdiff: false });

        expect(text).not.toContain('interdiff');
        expect(text).not.toContain('pushed since');
        expect(text).toContain('previous-route.md');
        expect(text).toContain('the code has not\nmoved since');
    });
});

describe('route guides', () => {
    it('validator rejection is part of the loop and silent non-submission is forbidden', () => {
        for (const guide of [SKELETON_GUIDE, SECTION_GUIDE]) {
            expect(guide).toContain('The server is the only validator.');
            expect(guide).toContain('Never end the task silently');
            expect(guide).toContain('sherpa task fail <id> --reason <text>');
            expect(guide).toContain('do\nnot install validators or packages');
        }
    });

    it('shared context files under `shared/` are read once per session', () => {
        for (const text of [...instructions, SKELETON_GUIDE, SECTION_GUIDE]) {
            expect(text).toContain('shared/');
            expect(text).toContain('once');
        }
    });

    it('both roles get second-pass instructions that preserve the plan and allow reasons only for affected stops', () => {
        expect(SKELETON_GUIDE).toContain('## Rebuilding an existing route');
        expect(SKELETON_GUIDE).toContain('Keep the plan, its order and its titles wherever the code did not change');
        // Both cases are described: with and without a push. The instructions are shared across all tasks.
        expect(SKELETON_GUIDE).toContain('**With `interdiff.md`**');
        expect(SKELETON_GUIDE).toContain('**Without `interdiff.md`** — the code has not moved');
        expect(SECTION_GUIDE).toContain('## Why this stop changed');
        expect(SECTION_GUIDE).toContain('changeReason');
        expect(SECTION_GUIDE).toContain('[thread:<id>]');
        expect(SECTION_GUIDE).toContain('you never declare the kind, only the reason');
    });

    it('voice rules name banned filler phrases and state that the server rejects them', () => {
        for (const guide of [SKELETON_GUIDE, SECTION_GUIDE]) {
            expect(guide).toContain('important to note');
            expect(guide).toContain('The server rejects texts containing these.');
            expect(guide).toContain('No emoji (the server rejects them)');
        }
    });
});
