import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ru } from '../../i18n/index.js';

import { ROUTE_LOCALE_STATES } from './route-locale-states.tsx';

function markup(id: string): string {
    const state = ROUTE_LOCALE_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) throw new Error(`no state ${id}`);
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('route language gallery', () => {
    it('registers exactly the ids declared in the file', () => {
        expect(ROUTE_LOCALE_STATES.map((state) => state.id)).toEqual([
            'route-locale-en-route-ru-ui',
            'route-locale-rebuild-unavailable',
            'route-locale-legacy-snapshot-ru-ui',
        ]);
    });

    it('an English route in a Russian tab shows the language in the pill and a question in the banner', () => {
        const html = markup('route-locale-en-route-ru-ui');

        expect(html).toContain('claude-code · claude-opus-5');
        expect(html).toContain(`· ${ru['route.locale.name.en']}`);
        expect(html).toContain(ru['route.locale.banner.title'](ru['route.locale.on.en'], ru['route.locale.on.ru']));
        expect(html).toContain(ru['route.locale.rebuild'](ru['route.locale.on.ru']));
        expect(html).toContain(ru['route.locale.keep']);
        expect(html).not.toContain('disabled');
    });

    it('disables rebuilding and explains why when unavailable', () => {
        const html = markup('route-locale-rebuild-unavailable');

        expect(html).toContain('disabled=""');
        expect(html).toContain('The route cannot be rebuilt while it is still being filled.');
    });

    it('treats a snapshot without a language as English on a Russian tab', () => {
        const html = markup('route-locale-legacy-snapshot-ru-ui');

        expect(html).toBe(markup('route-locale-en-route-ru-ui'));
        expect(html).toContain('claude-code · claude-opus-5');
        expect(html).not.toContain('disabled');
    });
});
