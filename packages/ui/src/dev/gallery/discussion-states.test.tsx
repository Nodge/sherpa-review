import { GALLERY_AVATAR_PHOTOS } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DISCUSSION_STATES } from './discussion-states.tsx';

/** Three Discussion card states from the checklist in docs/design/SPEC-additions-2026-08-26.md §1e. */

function markup(id: string): string {
    const state = DISCUSSION_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('Discussion card gallery', () => {
    it('registers exactly the IDs specified in the task', () => {
        expect(DISCUSSION_STATES.map((state) => state.id)).toEqual([
            'discussion-empty',
            'discussion-people',
            'discussion-scale',
            'discussion-outside-open',
            'discussion-avatars',
        ]);
    });

    it('empty: invitation replaces the list, chips and fold', () => {
        const html = markup('discussion-empty');

        expect(html).toContain('No threads yet — discussion starts at the code.');
        expect(html).not.toContain('thread-chip');
        expect(html).not.toContain('discussion-card__outside-toggle');
        expect(html).toContain('Write to the PR');
    });

    it('people only: participant rows with counters, no thread bodies in the card', () => {
        const html = markup('discussion-people');

        expect(html).toContain('discussion-participant__name');
        expect(html).not.toContain('discussion-thread__body');
        expect(html).toContain('aria-expanded="false"');
    });

    it('86/83 scale: accurate header, 6 rows, the rest behind "N more"', () => {
        const html = markup('discussion-scale');
        const rows = html.split('discussion-participant__name-line').length - 1;

        expect(html).toContain('86 threads');
        expect(rows).toBe(6);
        expect(html).toContain('3 more participants');
        // Bots have rows with counters but are not participants: the card never shows their bodies.
        expect(html).toContain('>bot</span>');
        expect(html).not.toContain('discussion-thread__body');
    });

    it('"outside the diff" expanded: long link, code block and reply composer in a 360px column', () => {
        const html = markup('discussion-outside-open');

        expect(html).toContain('aria-expanded="true"');
        // Two human threads outside the diff: a removed file with a code block and link, and a PR thread with replies.
        expect(html.split('class="discussion-thread"').length - 1).toBe(2);
        expect(html).toContain('<pre class="md-pre"');
        expect(html).toContain('edit-window.ts#L118-L146');
        // The PR thread composer is open, with existing replies visible alongside it.
        expect(html).toContain('2 replies');
        expect(html).toContain('I updated the description');
        // Bot threads never appear outside the diff: bot bodies stay hidden even when the fold is expanded.
        expect(html).not.toContain('Possible context leak');
        expect(html).toContain('thread-composer');
    });

    it('photos: people and bot in rows and threads outside the diff', () => {
        const html = markup('discussion-avatars');

        // Three people and a bot in the list, 2 human threads outside the diff. A broken photo falls back in the browser.
        expect(html.split('class="avatar__photo"').length - 1).toBe(6);
        expect(html).toContain(GALLERY_AVATAR_PHOTOS[0]);
        expect(html).toContain(GALLERY_AVATAR_PHOTOS[2]);
    });
});
