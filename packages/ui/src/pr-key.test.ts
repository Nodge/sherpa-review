import { describe, expect, it } from 'vitest';

import { breadcrumbFromPrKey } from './pr-key.js';

describe('breadcrumbFromPrKey', () => {
    it('parses the key into the host and PR number', () => {
        expect(breadcrumbFromPrKey('github-quillmart--quillmart--4821')).toEqual(['github', 'PR 4821']);
    });

    it('splits on the first hyphen because the number can contain one', () => {
        expect(breadcrumbFromPrKey('github-owner-repo-42')).toEqual(['github', 'PR owner-repo-42']);
    });

    it('shows a key without a separator as is', () => {
        expect(breadcrumbFromPrKey('local')).toEqual(['local']);
        expect(breadcrumbFromPrKey('trailing-')).toEqual(['trailing-']);
    });
});
