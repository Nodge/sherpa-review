import { describe, expect, it } from 'vitest';

import { readToken } from './token.js';

describe('readToken', () => {
    it('extracts the token from the URL fragment', () => {
        expect(readToken('#token=abc123')).toBe('abc123');
    });

    it('handles adjacent parameters and a leading hash', () => {
        expect(readToken('#pr=github-quillmart--quillmart--1&token=abc123')).toBe('abc123');
        expect(readToken('token=abc123')).toBe('abc123');
    });

    it('a missing or empty token returns null', () => {
        expect(readToken('')).toBeNull();
        expect(readToken('#')).toBeNull();
        expect(readToken('#token=')).toBeNull();
        expect(readToken('#other=1')).toBeNull();
    });
});
