/**
 * Fixture host adapter: deterministic PRs for the UI, state gallery and tests.
 * The server selects it for prKey values like `fixture-<name>` (see `hosts/select.ts`), for development and e2e.
 */
export { FixtureHost, makeFixtureHost } from './fixture-host.js';
export type { FixtureHostOptions } from './fixture-host.js';
export { FIXTURE_NAMES, fixtureData, LARGE_FILE_COUNT, MEDIUM_TOTALS } from './data/index.js';
export type { FixtureData, FixtureName } from './data/index.js';
