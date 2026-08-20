import { describe, expect, it } from 'vitest';

import { checkNodeVersion, MIN_NODE_MAJOR, MIN_NODE_MINOR } from './runtime.js';

const MIN_VERSION = `${String(MIN_NODE_MAJOR)}.${String(MIN_NODE_MINOR)}`;

describe('runtime version check', () => {
    it('accepts supported versions', () => {
        expect(checkNodeVersion(`${MIN_VERSION}.0`)).toBeNull();
        expect(checkNodeVersion('23.4.0')).toBeNull();
        expect(checkNodeVersion('v24.11.1')).toBeNull();
    });

    it('tells the user what to do when the version is too old', () => {
        expect(checkNodeVersion('18.20.4')).toContain('18.20.4');

        // The threshold includes a minor version: node:sqlite became available without a flag in 22.13.
        const tooOldMinor = checkNodeVersion('22.12.0');
        expect(tooOldMinor).toContain(MIN_VERSION);
        expect(tooOldMinor).toContain('22.12.0');
    });

    it('rejects 23.0–23.3: newer than the threshold, but node:sqlite still requires a flag', () => {
        expect(checkNodeVersion('23.0.0')).toContain('23.0.0');
        expect(checkNodeVersion('v23.3.0')).toContain('23.3.0');
    });

    it('does not block startup for an unrecognized version', () => {
        expect(checkNodeVersion(undefined)).toBeNull();
        expect(checkNodeVersion('')).toBeNull();
    });
});
