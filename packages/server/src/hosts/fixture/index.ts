/**
 * Fixture host adapter: deterministic PRs for the UI, state gallery and tests.
 * Not connected to server HTTP endpoints yet. That is M1-T10.
 */
export { FixtureHost, makeFixtureHost } from './fixture-host.js';
export type { FixtureHostOptions } from './fixture-host.js';
export { FIXTURE_NAMES, fixtureData, LARGE_FILE_COUNT, MEDIUM_TOTALS } from './data/index.js';
export type { FixtureData, FixtureName } from './data/index.js';
