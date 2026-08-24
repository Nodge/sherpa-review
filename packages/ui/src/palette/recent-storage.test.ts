import { describe, expect, it } from 'vitest';

import type { RecentStorage } from './recent-storage.js';
import { addRecent, readRecent, recentStorageKey, RECENT_LIMIT, writeRecent } from './recent-storage.js';

function memory(initial: Record<string, string> = {}): RecentStorage & { readonly data: Record<string, string> } {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => data[key] ?? null,
        setItem: (key, value) => {
            data[key] = value;
        },
    };
}

describe('recent palette commands', () => {
    it('stores commands separately for each PR and keeps at most five ids', () => {
        const storage = memory();
        const ids = Array.from({ length: RECENT_LIMIT + 2 }, (_, index) => `command-${String(index)}`);

        writeRecent(storage, 'pr-one', ids);

        expect(readRecent(storage, 'pr-one')).toEqual(ids.slice(0, RECENT_LIMIT));
        expect(readRecent(storage, 'pr-two')).toEqual([]);
    });

    it('moves the latest command to the front without a duplicate', () => {
        const storage = memory();
        writeRecent(storage, 'pr', ['a', 'b', 'c']);

        expect(addRecent(storage, 'pr', 'b')).toEqual(['b', 'a', 'c']);
        expect(readRecent(storage, 'pr')).toEqual(['b', 'a', 'c']);
    });

    it('corrupt data and storage errors do not crash the UI', () => {
        const broken = memory({ [recentStorageKey('pr')]: '{nope' });
        const throwing: RecentStorage = {
            getItem: () => {
                throw new Error('forbidden');
            },
            setItem: () => {
                throw new Error('quota');
            },
        };

        expect(readRecent(broken, 'pr')).toEqual([]);
        expect(readRecent(throwing, 'pr')).toEqual([]);
        expect(() => {
            writeRecent(throwing, 'pr', ['a']);
        }).not.toThrow();
    });
});
