import { makeFixtureHost } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { fixtureHostPlugin } from './fixture/plugin.js';
import type { HostPlugin } from './plugin.js';
import { selectReviewHost, unconfiguredHostReason } from './select.js';

/** Selects a plugin by key prefix. The core knows only the list, without naming hosts. */

const host = makeFixtureHost('small');
const ui = fixtureHostPlugin.ui;

function plugin(name: string, keyPrefix: string, made: boolean, reason: string | null = null): HostPlugin {
    return {
        name,
        keyPrefix,
        ui,
        make: () => (made ? { host } : null),
        unconfigured: () => reason,
    };
}

describe('host adapter selection from the plugin list', () => {
    it('the first matching prefix wins, with the UI name and description supplied by the plugin', () => {
        const hosts = [plugin('one', 'one-', true), plugin('first', 'pr-', true), plugin('second', 'pr-', true)];

        const selected = selectReviewHost('pr-42', {}, hosts);

        expect(selected?.name).toBe('first');
        expect(selected?.ui).toBe(ui);
        expect(selected?.host).toBe(host);
    });

    it('a matching plugin that returns no host stops selection without trying the next plugins', () => {
        const hosts = [plugin('first', 'pr-', false), plugin('second', 'pr-', true)];

        expect(selectReviewHost('pr-42', {}, hosts)).toBeNull();
    });

    it('an empty list returns no host', () => {
        expect(selectReviewHost('pr-42', {}, [])).toBeNull();
    });

    it('a key without a matching prefix returns no host', () => {
        expect(selectReviewHost('other-42', {}, [plugin('first', 'pr-', true)])).toBeNull();
    });

    it('the plugin receives the key and launch options unchanged', () => {
        const seen: unknown[] = [];
        const spy: HostPlugin = {
            name: 'spy',
            keyPrefix: 'spy-',
            ui,
            make: (prKey, options) => {
                seen.push(prKey, options);
                return null;
            },
        };

        selectReviewHost('spy-1', { repo: '/repo', sherpaDir: '/state' }, [spy]);

        expect(seen).toEqual(['spy-1', { repo: '/repo', sherpaDir: '/state' }]);
    });
});

describe('explanation for why there will be no host', () => {
    it('uses the plugin with the matching prefix', () => {
        const hosts = [plugin('first', 'pr-', false, 'directory required'), plugin('other', 'other-', false, 'unrelated')];

        expect(unconfiguredHostReason('pr-1', {}, hosts)).toBe('directory required');
    });

    it('a plugin without an explanation or a key without a plugin returns null', () => {
        const silent: HostPlugin = { name: 'silent', keyPrefix: 'pr-', ui, make: () => null };

        expect(unconfiguredHostReason('pr-1', {}, [silent])).toBeNull();
        expect(unconfiguredHostReason('other-1', {}, [silent])).toBeNull();
    });
});
