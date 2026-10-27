import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UPDATE_TOAST_STATES } from './update-toast-states.tsx';

function markup(id: string): string {
    const state = UPDATE_TOAST_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('update toast gallery', () => {
    it('registers exactly the ids declared in the file', () => {
        expect(UPDATE_TOAST_STATES.map((state) => state.id)).toEqual([
            'update-toast-command',
            'update-toast-copy',
            'update-toast-how',
            'update-toast-copy-no-link',
            'update-toast-link-only',
            'update-toast-no-motion',
            'update-top-bar-dot',
        ]);
    });

    it('toast shows both versions, what is new and both footer actions', () => {
        const html = markup('update-toast-command');

        expect(html).toContain('Update');
        expect(html).toContain('Sherpa 0.5.0 is available');
        expect(html).toContain('you have 0.4.0');
        expect(html).toContain('Update toast, shortcuts sheet');
        expect(html).toContain('How to update');
        expect(html).toContain('Don’t remind me about 0.5.0');
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-live="polite"');
    });

    it('expanded "How to update" shows the update command for a checkout', () => {
        const html = markup('update-toast-how');

        expect(html).toContain('sherpa-update');
        expect(html).toContain('Copy');
        expect(html).not.toContain('Copy the directory again');
    });

    it('directory copy has no command, only the directory and README link', () => {
        const copy = markup('update-toast-copy');
        expect(copy).not.toContain('sherpa-update');

        // The copy has the same "How to update" section, but a click opens it. It is absent from static markup.
        expect(copy).toContain('How to update');
    });

    it('copy without a channel link shows the directory without an instructions link', () => {
        const html = markup('update-toast-copy-no-link');

        expect(html).toContain('Copy the directory again');
        expect(html).not.toContain('update-toast__readme');
    });

    it('channel without a directory shows only the instructions link', () => {
        const html = markup('update-toast-link-only');

        expect(html).not.toContain('Copy the directory again');
        expect(html).toContain('update-toast__readme');
    });

    it('no-motion modifier appears only in its own state', () => {
        expect(markup('update-toast-no-motion')).toContain('update-toast--no-motion');
        expect(markup('update-toast-command')).not.toContain('update-toast--no-motion');
    });

    it('top bar version becomes a button with a dot and screen reader label', () => {
        const html = markup('update-top-bar-dot');

        expect(html).toContain('top-bar__version--update');
        expect(html).toContain('top-bar__version-dot');
        expect(html).toContain('aria-label="Version 0.5.0 is available"');
    });
});
