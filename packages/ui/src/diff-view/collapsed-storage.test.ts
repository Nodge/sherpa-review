import { describe, expect, it } from 'vitest';

import type { CollapsedStorage } from './collapsed-storage.js';
import { collapsedStorageKey, readCollapsed, writeCollapsed } from './collapsed-storage.js';

function memoryStorage(initial: Record<string, string> = {}): CollapsedStorage & { readonly data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
    };
}

const PR = 'github-quillmart--quillmart--4821';

describe('full diff card collapse state', () => {
    it('includes the PR key in the storage key so another PR cannot interfere', () => {
        expect(collapsedStorageKey(PR)).toBe('sherpa.diff.collapsed.github-quillmart--quillmart--4821');
        expect(collapsedStorageKey(PR)).not.toBe(collapsedStorageKey('github-quillmart--quillmart--4822'));
    });

    it('reads back the stored state', () => {
        const storage = memoryStorage();
        writeCollapsed(storage, PR, new Map([['f1', true], ['f2', false]]));

        expect([...readCollapsed(storage, PR).entries()]).toEqual([
            ['f1', true],
            ['f2', false],
        ]);
    });

    it('does not mix in another PR state', () => {
        const storage = memoryStorage();
        writeCollapsed(storage, PR, new Map([['f1', true]]));

        expect(readCollapsed(storage, 'github-quillmart--quillmart--4822').size).toBe(0);
    });

    it('returns an empty map for no record, no storage, malformed JSON or an unexpected shape', () => {
        expect(readCollapsed(memoryStorage(), PR).size).toBe(0);
        expect(readCollapsed(null, PR).size).toBe(0);
        expect(readCollapsed(memoryStorage({ [collapsedStorageKey(PR)]: '{oops' }), PR).size).toBe(0);
        expect(readCollapsed(memoryStorage({ [collapsedStorageKey(PR)]: '["f1"]' }), PR).size).toBe(0);
    });

    it('drops non-boolean values individually', () => {
        const storage = memoryStorage({ [collapsedStorageKey(PR)]: '{"f1":true,"f2":"yes"}' });

        expect([...readCollapsed(storage, PR).entries()]).toEqual([['f1', true]]);
    });

    it('does not crash the UI when policy blocks storage', () => {
        const forbidden: CollapsedStorage = {
            getItem: () => {
                throw new Error('SecurityError');
            },
            setItem: () => {
                throw new Error('SecurityError');
            },
        };

        expect(readCollapsed(forbidden, PR).size).toBe(0);
        expect(() => {
            writeCollapsed(forbidden, PR, new Map([['f1', true]]));
        }).not.toThrow();
    });
});
