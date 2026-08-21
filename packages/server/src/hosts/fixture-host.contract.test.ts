import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';

import { describeReviewHostContract } from './review-host-contract.js';

// The contract suite lives in the server (it depends on vitest), fixtures in a separate package.
// They meet here. Read mocks for the review host will join them in M1-T10/T12.
for (const name of FIXTURE_NAMES) {
    describeReviewHostContract(`FixtureHost(${name})`, () => makeFixtureHost(name));
}
