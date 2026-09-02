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

    it('voice rules name banned filler phrases and state that the server rejects them', () => {
        for (const guide of [SKELETON_GUIDE, SECTION_GUIDE]) {
            expect(guide).toContain('important to note');
            expect(guide).toContain('The server rejects texts containing these.');
            expect(guide).toContain('No emoji (the server rejects them)');
        }
    });
});
