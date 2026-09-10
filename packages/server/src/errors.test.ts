import { describe, expect, it } from 'vitest';

import { describeFetchError } from './errors.js';

describe('describeFetchError', () => {
    it('reveals the cause of "fetch failed": code and message from cause', () => {
        const cause = Object.assign(new Error('self-signed certificate in certificate chain'), {
            code: 'SELF_SIGNED_CERT_IN_CHAIN',
        });
        expect(describeFetchError(new TypeError('fetch failed', { cause }))).toBe(
            'fetch failed: SELF_SIGNED_CERT_IN_CHAIN self-signed certificate in certificate chain',
        );
    });

    it('uses the message without cause and a dedicated message for timeouts', () => {
        expect(describeFetchError(new Error('boom'))).toBe('boom');
        expect(describeFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
        expect(describeFetchError('string')).toBe('string');
    });
});
