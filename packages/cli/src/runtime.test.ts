import { describe, expect, it } from 'vitest';

import { checkNodeVersion, MIN_NODE_MAJOR } from './runtime.js';

describe('runtime version check', () => {
    it('accepts supported versions', () => {
        expect(checkNodeVersion(`${String(MIN_NODE_MAJOR)}.0.0`)).toBeNull();
        expect(checkNodeVersion('24.11.1')).toBeNull();
    });

    it('tells the user what to do when the version is too old', () => {
        const message = checkNodeVersion('18.20.4');

        expect(message).toContain(String(MIN_NODE_MAJOR));
        expect(message).toContain('18.20.4');
    });

    it('does not block startup for an unrecognized version', () => {
        expect(checkNodeVersion(undefined)).toBeNull();
        expect(checkNodeVersion('')).toBeNull();
    });
});
