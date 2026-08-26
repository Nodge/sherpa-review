import { describe, expect, it } from 'vitest';

import { readToken } from '../fragment.js';
import { stopFragment } from './copy-link.js';

/**
 * A stop link shares the fragment with the access token. A `#stop-…` anchor would overwrite
 * it entirely, and a page opened from that link could not make a single request.
 */
describe('stop link', () => {
    it('puts the stop in a parameter and preserves the token, view and filter', () => {
        const hash = stopFragment('#token=secret&view=route&filter=pci', 's03');

        expect(readToken(hash)).toBe('secret');
        expect(new URLSearchParams(hash.slice(1)).get('view')).toBe('route');
        expect(new URLSearchParams(hash.slice(1)).get('filter')).toBe('pci');
        expect(new URLSearchParams(hash.slice(1)).get('stop')).toBe('s03');
    });

    it('clears file and thread links so the address points to the stop', () => {
        const hash = stopFragment('#token=secret&file=f1&thread=t1&stop=s01', 's02');

        expect(new URLSearchParams(hash.slice(1)).get('file')).toBeNull();
        expect(new URLSearchParams(hash.slice(1)).get('thread')).toBeNull();
        expect(new URLSearchParams(hash.slice(1)).get('stop')).toBe('s02');
    });
});
