import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './index.js';

describe('protocol', () => {
    it('exports the protocol version', () => {
        expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
