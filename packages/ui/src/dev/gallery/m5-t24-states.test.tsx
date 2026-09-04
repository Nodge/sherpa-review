import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M5_T24_STATES } from './m5-t24-states.tsx';

/**
 * Image card gallery: registered states and their static markup. Bytes
 * arrive through an effect, which server rendering does not run, so these tests check the mode
 * row, side placeholders and initial statuses, rather than the images themselves.
 */
function markup(id: string): string {
    const state = M5_T24_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('M5-T24 gallery', () => {
    it('registers exactly the ids defined by the task slice', () => {
        expect(M5_T24_STATES.map((state) => state.id)).toEqual([
            'image-two-up-modify',
            'image-two-up-add',
            'image-two-up-delete',
            'image-swipe',
            'image-onion',
            'image-diff',
            'image-diff-busy',
            'image-diff-size-mismatch',
            'image-text-svg',
            'image-actual-size',
            'image-too-large',
            'image-failed',
            'image-loading',
        ]);
    });

    it('raster change: shows the mode row instead of a binary file notice', () => {
        const html = markup('image-two-up-modify');

        expect(html).not.toContain('binary file not shown');
        expect(html).toContain('>2-up</button>');
        expect(html).toContain('>Swipe</button>');
        expect(html).toContain('>Onion Skin</button>');
        expect(html).toContain('>Diff</button>');
        // Raster images have no text patch, so they have no Text mode either.
        expect(html).not.toContain('>Text</button>');
        expect(html).toContain('>Before</p>');
        expect(html).toContain('>After</p>');
    });

    it('added svg: Before is a placeholder, overlay modes are disabled, Text is available', () => {
        const html = markup('image-two-up-add');

        expect(html).toContain('file-card__image-empty');
        expect(html).toContain('both sides are needed');
        expect(html).toContain('>Text</button>');
    });

    it('deleted png: the placeholder is on the After side', () => {
        const html = markup('image-two-up-delete');
        const empty = html.indexOf('file-card__image-empty');

        expect(empty).toBeGreaterThan(html.indexOf('>After</p>'));
    });

    it('Text mode renders svg patch lines', () => {
        const html = markup('image-text-svg');

        expect(html).toContain('file-card__body');
        expect(html).toContain('viewBox');
    });

    it('oversized side: shows the size in megabytes and a host link instead of loading', () => {
        const html = markup('image-too-large');

        expect(html).toContain('too large: 11,4 MB');
        expect(html).toContain('Открыть у хоста');
    });

    it('Diff shows the same side statuses as 2-up before bytes arrive', () => {
        // Server rendering runs no effects, so there is no rasterization or worker here.
        // The frame therefore shows side statuses, rather than the difference itself.
        expect(markup('image-diff')).toContain('loading…');
    });

    it('both sides show a loading status while bytes are in transit', () => {
        expect(markup('image-loading').match(/loading…/gu)).toHaveLength(2);
    });
});
