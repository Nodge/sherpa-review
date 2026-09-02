import type { PrMeta } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { breadcrumbFor, breadcrumbFromPrKey, documentTitleFor } from './pr-key.js';

const PR: PrMeta = {
    id: '4821',
    url: 'https://github.com/quillmart/quillmart/pull/4821',
    title: 'Order editing window',
    author: { login: 'alice', displayName: null, bot: false },
    fromBranch: 'alice/edit-window',
    toBranch: 'main',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-24T06:00:00.000Z',
    capabilities: { stickyShip: true, fileViewedSync: true, fileContent: true, commentIssues: true, iterations: false },
};

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

describe('breadcrumbFor', () => {
    it('uses a text fallback from the key without metadata', () => {
        expect(breadcrumbFor('github-quillmart--quillmart--4821', null)).toEqual([
            { text: 'github', href: null },
            { text: 'PR 4821', href: null },
        ]);
    });

    it('links the last segment to the PR on the host when metadata is available', () => {
        expect(breadcrumbFor('github-quillmart--quillmart--4821', PR)).toEqual([
            { text: 'github', href: null },
            { text: 'PR 4821', href: 'https://github.com/quillmart/quillmart/pull/4821' },
        ]);
    });

    it('keeps the segment of a key without a separator and adds a link beside it', () => {
        expect(breadcrumbFor('local', PR)).toEqual([
            { text: 'local', href: null },
            { text: 'PR 4821', href: 'https://github.com/quillmart/quillmart/pull/4821' },
        ]);
    });
});

describe('documentTitleFor', () => {
    it('uses the PR title when metadata is available', () => {
        expect(documentTitleFor('github-quillmart--quillmart--4821', PR)).toBe('Order edit window · Sherpa');
    });

    it('uses the PR number from the key without metadata', () => {
        expect(documentTitleFor('github-quillmart--quillmart--4821', null)).toBe('PR 4821 · Sherpa');
    });

    it('never returns an empty title, even with empty metadata and a key without a separator', () => {
        expect(documentTitleFor('local', null)).toBe('local · Sherpa');
        expect(documentTitleFor('github-quillmart--quillmart--4821', { ...PR, title: '   ' })).toBe('PR 4821 · Sherpa');
        expect(documentTitleFor('', null)).toBe('Sherpa');
    });
});
