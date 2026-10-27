import { fixtureData, FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';

import { describeReviewHostContract } from './review-host-contract.js';

// The contract suite lives in the server (it depends on vitest), while fixtures live
// in a separate package. They meet here. Runs of the same suite for other hosts live beside their adapters.
for (const name of FIXTURE_NAMES) {
    // Only `medium` declares iterations: other fixtures have nothing to advance.
    describeReviewHostContract(`FixtureHost(${name})`, () => makeFixtureHost(name), {
        viewer: fixtureData(name).currentUser.login,
        ...(name === 'medium'
            ? {
                  advance: (host): void => {
                      host.advanceIteration();
                  },
              }
            : {}),
    });
}
