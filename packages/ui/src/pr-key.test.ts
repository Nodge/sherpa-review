import type { PrMeta } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { breadcrumbFor, breadcrumbFromPrKey, documentTitleFor } from './pr-key.js';

const PR: PrMeta = {
    id: '4821',
    url: 'https://review.example.com/acme/shop/4821',
    title: 'Order editing window',
    author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
    fromBranch: 'alice/edit-window',
    toBranch: 'main',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-24T06:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
};

describe('breadcrumbFromPrKey', () => {
    it('parses the key into the host and PR number', () => {
        expect(breadcrumbFromPrKey('fixture-4821')).toEqual(['fixture', 'PR 4821']);
    });

    it('splits on the first hyphen because the number can contain one', () => {
        expect(breadcrumbFromPrKey('unknown-owner-repo-42')).toEqual(['unknown', 'PR owner-repo-42']);
    });

    it('shows a key without a separator as is', () => {
        expect(breadcrumbFromPrKey('local')).toEqual(['local']);
        expect(breadcrumbFromPrKey('trailing-')).toEqual(['trailing-']);
    });
});

describe('breadcrumbFor', () => {
    it('falls back to a text breadcrumb from the key without metadata', () => {
        expect(breadcrumbFor('fixture-4821', null)).toEqual([
            { text: 'fixture', href: null },
            { text: 'PR 4821', href: null },
        ]);
    });

    it('links the last segment to the PR on the host when metadata is available', () => {
        expect(breadcrumbFor('fixture-4821', PR)).toEqual([
            { text: 'fixture', href: null },
            { text: 'PR 4821', href: 'https://review.example.com/acme/shop/4821' },
        ]);
    });

    it('keeps the segment of a key without a separator and adds a link beside it', () => {
        expect(breadcrumbFor('local', PR)).toEqual([
            { text: 'local', href: null },
            { text: 'PR 4821', href: 'https://review.example.com/acme/shop/4821' },
        ]);
    });
});

describe('documentTitleFor', () => {
    it('uses the PR title when metadata is available', () => {
        expect(documentTitleFor('fixture-4821', PR)).toBe('Order editing window · Sherpa');
    });

    it('uses the PR number from the key without metadata', () => {
        expect(documentTitleFor('fixture-4821', null)).toBe('PR 4821 · Sherpa');
    });

    it('never returns an empty title, even with empty metadata and a key without a separator', () => {
        expect(documentTitleFor('local', null)).toBe('local · Sherpa');
        expect(documentTitleFor('fixture-4821', { ...PR, title: '   ' })).toBe('PR 4821 · Sherpa');
        expect(documentTitleFor('', null)).toBe('Sherpa');
    });
});
