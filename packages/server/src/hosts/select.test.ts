import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectReviewHost } from './select.js';

/**
 * Selects the adapter by key prefix. Hosts are only constructed here. No network or disk
 * until the first method call.
 */

const SHERPA_DIR = path.join(os.tmpdir(), 'sherpa-select-test');

describe('host adapter selection', () => {
    it('creates a GitHub host with whoami and status subscription for a GitHub key', () => {
        const selected = selectReviewHost('github-acme--ui--kit--42', { sherpaDir: SHERPA_DIR });

        expect(selected?.name).toBe('github');
        expect(selected?.currentUser).toBeDefined();
        expect(selected?.watchStatus).toBeDefined();
        // GitHub has no iterations, so it has neither a dev "push" nor feedback rounds.
        expect(selected?.advanceIteration).toBeUndefined();
        expect(selected?.feedback).toBeUndefined();
    });

    it('does not create a host for an invalid GitHub key', () => {
        for (const key of ['github-acme--sherpa', 'github-acme--sherpa--0', 'github---sherpa--1']) {
            expect(selectReviewHost(key, { sherpaDir: SHERPA_DIR }), key).toBeNull();
        }
    });

    it('selects the matching host for known prefixes and none for unknown ones', () => {
        
        expect(selectReviewHost('fixture-medium')?.name).toBe('fixture');
        expect(selectReviewHost('whatever-1')).toBeNull();
    });
});
