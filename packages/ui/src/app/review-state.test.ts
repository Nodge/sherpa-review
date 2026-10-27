import type { UiReviewHost } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';

import { fileWebActionLabel, hostDisplayName } from './review-state.js';

/**
 * Everything the UI says about a host comes from its description (`uiState.reviewHost`). A host
 * unknown to the UI gets its own labels, unaffected by the adapter name.
 */

const GITEA: UiReviewHost = {
    id: 'gitea',
    label: { en: 'Gitea', ru: 'Gitea (ru)' },
    webAction: { en: 'Open in Gitea', ru: 'Open in Gitea (ru)' },
    drafts: 'pr',
    iterations: 'pr',
};

const en = createT('en');
const ru = createT('ru');

describe('host description in UI text', () => {
    it('uses label for the host name in the UI language', () => {
        expect(hostDisplayName(GITEA, en)).toBe('Gitea');
        expect(hostDisplayName(GITEA, ru)).toBe('Gitea (ru)');
    });

    it('uses webAction for the open-at-host label, falling back to the generic UI label without it or the host', () => {
        expect(fileWebActionLabel(GITEA, en)).toBe('Open in Gitea');
        expect(fileWebActionLabel(GITEA, ru)).toBe('Open in Gitea (ru)');
        expect(fileWebActionLabel({ ...GITEA, webAction: null }, ru)).toBe(ru('file.menu.openWeb'));
        expect(fileWebActionLabel(null, en)).toBe(en('file.menu.openWeb'));
    });

    it('ignores id in labels so a familiar adapter name cannot override host data', () => {
        const renamed: UiReviewHost = { ...GITEA, id: 'github', drafts: 'agent', iterations: 'tree' };

        expect(hostDisplayName(renamed, ru)).toBe('Gitea (ru)');
        expect(fileWebActionLabel(renamed, ru)).toBe('Open in Gitea (ru)');
    });
});
