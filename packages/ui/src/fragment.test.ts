import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUTE_FILTER, parseRouteFilter } from './session/session-store.js';
import { parseFragment, readFragmentParam, readToken, updateFragment } from './fragment.js';

describe('readToken', () => {
    it('reads the short t parameter first', () => {
        expect(readToken('#t=abc123')).toBe('abc123');
        expect(readToken('#token=old&t=new')).toBe('new');
    });

    it('reads the old token for compatibility with a running server', () => {
        expect(readToken('#pr=github-quillmart--quillmart--1&token=abc123')).toBe('abc123');
        expect(readToken('token=abc123')).toBe('abc123');
    });

    it('a missing or empty token returns null', () => {
        expect(readToken('')).toBeNull();
        expect(readToken('#')).toBeNull();
        expect(readToken('#t=&token=')).toBeNull();
        expect(readToken('#other=1')).toBeNull();
    });
});

describe('readFragmentParam', () => {
    it('reads an arbitrary parameter', () => {
        expect(readFragmentParam('#token=abc&view=route', 'view')).toBe('route');
        expect(readFragmentParam('#token=abc', 'view')).toBeNull();
    });

    it('decodes values', () => {
        expect(readFragmentParam('#path=src%2Fapp.ts', 'path')).toBe('src/app.ts');
    });
});

describe('updateFragment', () => {
    it('adds a parameter without changing the others', () => {
        expect(updateFragment('#token=abc', { view: 'route' })).toBe('#token=abc&view=route');
    });

    it('replaces a value in place', () => {
        expect(updateFragment('#t=abc&view=overview', { view: 'diff' })).toBe('#t=abc&view=diff');
    });

    it('does not leave both t and the old token', () => {
        expect(updateFragment('#token=old&view=route', { t: 'new' })).toBe('#t=new&view=route');
        expect(updateFragment('#t=new&token=old&view=route', { view: 'diff' })).toBe('#t=new&view=diff');
        expect(updateFragment('#t=new', { token: 'old' })).toBe('#token=old');
    });

    it('a thread link preserves token and view but removes the conflicting file target', () => {
        expect(updateFragment('#token=abc&view=diff&file=f1', { thread: 'thread-7', file: null })).toBe(
            '#token=abc&view=diff&thread=thread-7',
        );
    });

    it('null removes a parameter', () => {
        expect(updateFragment('#token=abc&view=diff', { view: null })).toBe('#token=abc');
    });

    it('an empty fragment stays empty instead of becoming "#"', () => {
        expect(updateFragment('', { view: null })).toBe('');
    });

    it('works with an empty fragment', () => {
        expect(updateFragment('', { view: 'route' })).toBe('#view=route');
    });
});

/**
 * The "what is new" filter uses the fragment just like a preset: main.tsx reads it at startup
 * and writes it back in `persist`. The test covers this exact composition. main.tsx itself renders the root
 * and cannot run in vitest.
 */
describe('route filter in the fragment', () => {
    const read = (hash: string) => parseRouteFilter(readFragmentParam(hash, 'routeFilter')) ?? DEFAULT_ROUTE_FILTER;
    const write = (hash: string, routeFilter: 'all' | 'new') =>
        updateFragment(hash, { routeFilter: routeFilter === DEFAULT_ROUTE_FILTER ? null : routeFilter });

    it('reads from the URL, with garbage and absence falling back to the default', () => {
        expect(read('#t=abc&routeFilter=new')).toBe('new');
        expect(read('#t=abc&routeFilter=garbage')).toBe('all');
        expect(read('#t=abc')).toBe('all');
    });

    it('writes back without putting the default in the URL', () => {
        expect(write('#t=abc&view=route', 'new')).toBe('#t=abc&view=route&routeFilter=new');
        expect(write('#t=abc&view=route&routeFilter=new', 'all')).toBe('#t=abc&view=route');
    });
});

describe('parseFragment', () => {
    it('parses the fragment as URLSearchParams', () => {
        expect([...parseFragment('#a=1&b=2')]).toEqual([
            ['a', '1'],
            ['b', '2'],
        ]);
    });
});
