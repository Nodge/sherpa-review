import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M5_T4_STATES } from './m5-t4-states.tsx';

function markup(id: string): string {
    const state = M5_T4_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('M5-T4 gallery', () => {
    it('registers exactly the ids defined by the milestone task breakdown', () => {
        expect(M5_T4_STATES.map((state) => state.id)).toEqual([
            'route-locale-en-route-ru-ui',
            'route-locale-rebuild-unavailable',
            'route-locale-legacy-snapshot-en-ui',
        ]);
    });

    it('an English route in a Russian tab shows the language in the pill and a question in the banner', () => {
        const html = markup('route-locale-en-route-ru-ui');

        expect(html).toContain('claude-code · claude-opus-5');
        expect(html).toContain('· English');
        expect(html).toContain('The route was built in English — rebuild it in Russian?');
        expect(html).toContain('Rebuild in Russian');
        expect(html).toContain('Keep it');
        expect(html).not.toContain('disabled');
    });

    it('disables rebuilding and explains why when unavailable', () => {
        const html = markup('route-locale-rebuild-unavailable');

        expect(html).toContain('disabled=""');
        expect(html).toContain('The route cannot be rebuilt while it is still being filled.');
    });

    it('a pre-M5 snapshot in an English tab is treated as Russian', () => {
        const html = markup('route-locale-legacy-snapshot-en-ui');

        expect(html).toContain('· Russian');
        expect(html).toContain('The route was built in Russian — rebuild it in English?');
        expect(html).toContain('Rebuild in English');
    });
});
