import { describe, expect, it } from 'vitest';

import { relativeTime } from './relative-time.js';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

describe('thread relative time', () => {
    it.each([
        ['2026-08-24T11:59:31.000Z', 'just now'],
        ['2026-08-24T11:55:00.000Z', '5 min ago'],
        ['2026-08-24T10:00:00.000Z', '2 h ago'],
        ['2026-08-21T12:00:00.000Z', '3 d ago'],
        ['2026-07-25T12:00:00.000Z', '1 mo ago'],
    ])('%s → %s', (createdAt, expected) => {
        expect(relativeTime(createdAt, NOW)).toBe(expected);
    });
});
