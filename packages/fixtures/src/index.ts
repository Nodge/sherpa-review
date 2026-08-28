/**
 * Fixture host adapter: deterministic PRs for the UI, state gallery and tests.
 * The server selects it for prKey values like `fixture-<name>` (see `hosts/select.ts`), for development and e2e.
 */
export { FixtureHost, makeFixtureHost } from './fixture-host.js';
export type { FixtureHostOptions } from './fixture-host.js';
export {
    FIXTURE_NAMES,
    fixtureData,
    LARGE_FILE_COUNT,
    LONG_LINE_FILE_PATH,
    LONG_LINE_MARKER,
    MEDIUM_TOTALS,
} from './data/index.js';
/** Route (M2): generation states for the gallery and prepared model outputs for e2e. */
export { routeFixtures } from './data/index.js';
export type { RouteBrokenResults, RouteFixtures, RouteRawResults } from './data/index.js';
/** File text on both sides: the state gallery needs it without a server or host. */
export { fileContentOf } from './file-content.js';
export type { FixtureData, FixtureName } from './data/index.js';
