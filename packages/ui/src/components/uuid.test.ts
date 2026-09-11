import { afterEach, describe, expect, it, vi } from 'vitest';

import { newUuid } from './uuid.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Counter instead of entropy: values are predictable, but version and variant must still be set. */
function countingRandomValues(): (array: Uint8Array) => Uint8Array {
    let next = 0;
    return (array) => {
        for (let index = 0; index < array.length; index += 1) {
            array[index] = next;
            next = (next + 1) % 256;
        }
        return array;
    };
}

describe('newUuid', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns a UUID v4 from native crypto in a secure context', () => {
        expect(newUuid()).toMatch(UUID_V4);
        expect(newUuid()).not.toBe(newUuid());
    });

    it('builds a UUID v4 with getRandomValues when randomUUID is absent', () => {
        const getRandomValues = vi.fn(countingRandomValues());
        vi.stubGlobal('crypto', { getRandomValues });

        const first = newUuid();
        expect(first).toMatch(UUID_V4);
        expect(newUuid()).not.toBe(first);
        // Otherwise the test would also pass with native randomUUID, without testing the fallback.
        expect(getRandomValues).toHaveBeenCalledTimes(2);
    });
});
