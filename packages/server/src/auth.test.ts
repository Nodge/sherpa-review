import { describe, expect, it } from 'vitest';

import { createToken, extractBearerToken, tokenMatches } from './auth.js';

describe('bearer authentication', () => {
    it('token is 32 random bytes in hex', () => {
        const token = createToken();

        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(createToken()).not.toBe(token);
    });

    it('parses the scheme case-insensitively, returns null for garbage', () => {
        expect(extractBearerToken('Bearer abc')).toBe('abc');
        expect(extractBearerToken('bearer\tabc')).toBe('abc');
        expect(extractBearerToken('  Bearer   abc  ')).toBe('abc');
        expect(extractBearerToken('Basic abc')).toBeNull();
        expect(extractBearerToken('abc')).toBeNull();
        expect(extractBearerToken('Bearer ')).toBeNull();
        expect(extractBearerToken(undefined)).toBeNull();
    });

    it('comparison handles different token lengths and a missing token', () => {
        const token = createToken();

        expect(tokenMatches(token, token)).toBe(true);
        expect(tokenMatches(token, `${token}x`)).toBe(false);
        expect(tokenMatches(token, 'short')).toBe(false);
        expect(tokenMatches(token, null)).toBe(false);
    });
});
