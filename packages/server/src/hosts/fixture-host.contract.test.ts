import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';

import { describeReviewHostContract } from './review-host-contract.js';

// The contract suite lives in the server (it depends on vitest), fixtures in a separate package.
// they meet here. The adapter runs the same suite alongside its implementation.
for (const name of FIXTURE_NAMES) {
    describeReviewHostContract(`FixtureHost(${name})`, () => makeFixtureHost(name));
}
