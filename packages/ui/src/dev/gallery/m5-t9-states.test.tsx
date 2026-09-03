import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M5_T9_STATES } from './m5-t9-states.tsx';

function markup(id: string): string {
    const state = M5_T9_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('M5-T9 gallery', () => {
    it('registers exactly the ids defined by the milestone task breakdown', () => {
        expect(M5_T9_STATES.map((state) => state.id)).toEqual([
            'update-toast-checkout',
            'update-toast-copy',
            'update-toast-how',
            'update-toast-no-motion',
            'update-top-bar-dot',
        ]);
    });

    it('toast shows both versions, what is new and both footer actions', () => {
        const html = markup('update-toast-checkout');

        expect(html).toContain('Update');
        expect(html).toContain('Sherpa 0.5.0 is available');
        expect(html).toContain('you have 0.4.0');
        expect(html).toContain('Update toast, shortcuts sheet');
        expect(html).toContain('How to update');
        expect(html).toContain('Don’t remind me about 0.5.0');
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-live="polite"');
    });

    it('expanded "How to update" for a checkout shows git pull', () => {
        const html = markup('update-toast-how');

        expect(html).toContain('git pull');
        expect(html).toContain('Copy');
        expect(html).not.toContain('Copy the directory again');
    });

    it('directory copy has no command, only the directory and README link', () => {
        const copy = markup('update-toast-copy');
        expect(copy).not.toContain('git pull');

        // The copy has the same "How to update" section, but a click opens it. It is absent from static markup.
        expect(copy).toContain('How to update');
    });

    it('no-motion modifier appears only in its own state', () => {
        expect(markup('update-toast-no-motion')).toContain('update-toast--no-motion');
        expect(markup('update-toast-checkout')).not.toContain('update-toast--no-motion');
    });

    it('top bar version becomes a button with a dot and screen reader label', () => {
        const html = markup('update-top-bar-dot');

        expect(html).toContain('top-bar__version--update');
        expect(html).toContain('top-bar__version-dot');
        expect(html).toContain('aria-label="Version 0.5.0 is available"');
    });
});
