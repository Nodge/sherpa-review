import { describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';

import { draftDestinationOf, hostDisplayName, isLocalHost } from './review-state.js';

/**
 * The host name in UI copy. For a local adapter, the reviewer sees
 * a checkout on their machine. The label does not include its VCS.
 */

describe('the local host in UI copy', () => {
    it('the local adapter is local, other adapters are not', () => {
        
        expect(isLocalHost('local-git')).toBe(true);
        expect(isLocalHost('github')).toBe(false);
        expect(isLocalHost('fixture')).toBe(false);
        expect(isLocalHost(null)).toBe(false);
    });

    it('uses the local checkout label for the local adapter', () => {
        const t = createT('ru');

        
        expect(hostDisplayName('local-git', t)).toBe(t('host.local'));
        
        expect(hostDisplayName('fixture', t)).toBe('FixtureHost');
    });

    it('local review drafts go to the agent, drafts for other hosts go to the PR', () => {
        
        expect(draftDestinationOf('local-git')).toBe('agent');
        
        expect(draftDestinationOf('github')).toBe('pr');
    });
});
