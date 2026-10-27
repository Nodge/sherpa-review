import type { UiReviewHost } from '@sherpa/protocol';

/**
 * Host descriptions (`uiState.reviewHost`) for the gallery and UI tests: the same values returned by
 * server plugins. A server test checks that they match.
 */
export const GALLERY_HOSTS = {
    github: {
        id: 'github',
        label: { en: 'GitHub', ru: 'GitHub' },
        webAction: { en: 'Open on GitHub', ru: 'Открыть на GitHub' },
        drafts: 'pr',
        iterations: 'pr',
    },
    local: {
        id: 'local-git',
        label: { en: 'local checkout', ru: 'локальный чекаут' },
        webAction: null,
        drafts: 'agent',
        iterations: 'tree',
    },
    fixture: {
        id: 'fixture',
        label: { en: 'FixtureHost', ru: 'FixtureHost' },
        webAction: null,
        drafts: 'pr',
        iterations: 'pr',
    },
} as const satisfies Record<string, UiReviewHost>;
