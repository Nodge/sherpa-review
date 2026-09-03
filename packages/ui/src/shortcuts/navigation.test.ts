import { describe, expect, it } from 'vitest';

import { neighbourId, unreadNeighbourId } from './navigation.js';

interface Item {
    readonly id: string;
    readonly viewed: boolean;
}

const idOf = (item: Item): string => item.id;
const unread = (item: Item): boolean => !item.viewed;

function items(...spec: readonly (readonly [string, boolean])[]): readonly Item[] {
    return spec.map(([id, viewed]) => ({ id, viewed }));
}

describe('neighbourId', () => {
    const list = items(['a', false], ['b', false], ['c', false]);

    it('moves forward and backward through the list', () => {
        expect(neighbourId(list, 'a', 1, idOf)).toBe('b');
        expect(neighbourId(list, 'b', -1, idOf)).toBe('a');
    });

    it('returns null at list boundaries without wrapping', () => {
        expect(neighbourId(list, 'c', 1, idOf)).toBeNull();
        expect(neighbourId(list, 'a', -1, idOf)).toBeNull();
    });

    it('targets the first entry when there is no current entry', () => {
        expect(neighbourId(list, null, 1, idOf)).toBe('a');
        expect(neighbourId(list, 'no such entry', -1, idOf)).toBe('a');
    });

    it('returns null for an empty list', () => {
        expect(neighbourId([], null, 1, idOf)).toBeNull();
    });
});

describe('unreadNeighbourId', () => {
    it('skips viewed entries', () => {
        const list = items(['a', false], ['b', true], ['c', false]);

        expect(unreadNeighbourId(list, 'a', 1, idOf, unread)).toBe('c');
        expect(unreadNeighbourId(list, 'c', -1, idOf, unread)).toBe('a');
    });

    it('wraps from the end of the list to the start', () => {
        const list = items(['a', false], ['b', true], ['c', true]);

        expect(unreadNeighbourId(list, 'c', 1, idOf, unread)).toBe('a');
        expect(unreadNeighbourId(list, 'a', -1, idOf, unread)).toBe('a');
    });

    it('returns null when there are no unviewed entries', () => {
        const list = items(['a', true], ['b', true]);

        expect(unreadNeighbourId(list, 'a', 1, idOf, unread)).toBeNull();
    });

    it('searches from an edge without a current entry: forward from the start, backward from the end', () => {
        const list = items(['a', false], ['b', true], ['c', false]);

        expect(unreadNeighbourId(list, null, 1, idOf, unread)).toBe('a');
        expect(unreadNeighbourId(list, null, -1, idOf, unread)).toBe('c');
    });
});
