import type { FixtureName } from '@sherpa/fixtures';
import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';

import type { HostPlugin } from '../plugin.js';

const KEY_PREFIX = 'fixture-';

/**
 * `fixture-<name from FIXTURE_NAMES>`: deterministic fixtures for UI development and e2e, which
 * would otherwise require a live host. The plugin lives in the server, not in `@sherpa/fixtures`:
 * the server depends on fixtures, so a reverse dependency would create a cycle.
 */
export const fixtureHostPlugin: HostPlugin = {
    name: 'fixture',
    keyPrefix: KEY_PREFIX,
    // Fixtures have a dummy web destination: no action label, so the UI uses the generic one.
    ui: {
        label: { en: 'FixtureHost', ru: 'FixtureHost' },
        webAction: null,
        drafts: 'pr',
        iterations: 'pr',
    },
    make: (prKey) => {
        const raw = prKey.slice(KEY_PREFIX.length);
        if (!isFixtureName(raw)) {
            return null;
        }
        const host = makeFixtureHost(raw);
        return {
            host,
            disablesUpdateCheck: true,
            advanceIteration: () => host.advanceIteration(),
            setFailDraftWrites: (fail) => {
                host.setFailDraftWrites(fail);
            },
        };
    },
};

function isFixtureName(value: string): value is FixtureName {
    return (FIXTURE_NAMES as readonly string[]).includes(value);
}
