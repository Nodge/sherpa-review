/**
 * Fixture host adapter: deterministic PRs for the UI, state gallery and tests.
 * The server selects it for prKey values like `fixture-<name>` (see `hosts/select.ts`), for development and e2e.
 */
export { FixtureHost, makeFixtureHost } from './fixture-host.js';
export type { FixtureHostOptions } from './fixture-host.js';
export {
    FIXTURE_NAMES,
    fixtureData,
    fixtureInterdiff,
    fixtureIteration,
    HUGE_CHANGED_LINE_COUNT,
    HUGE_COLLAPSED_FILE_LINES,
    HUGE_COLLAPSED_FILE_PATH,
    HUGE_DIFF_ID,
    HUGE_FILE_COUNT,
    HUGE_PARSED_FILE_COUNT,
    HUGE_PARSED_LINE_COUNT,
    LARGE_FILE_COUNT,
    LONG_LINE_FILE_PATH,
    LONG_LINE_MARKER,
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_DIFF_ID_V3,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    MEDIUM_HEAD_COMMIT_V3,
    MEDIUM_TOTALS,
} from './data/index.js';
/** Chat and local agent notes (M3): history for the gallery without a server. */
export { chatFixtures } from './data/index.js';
export type { ChatFixtures } from './data/index.js';
/** Route (M2): generation states for the gallery and prepared model outputs for e2e. */
export { routeFixtures } from './data/index.js';
/**
 * Domain object builders: the gallery and tests use them to build thread sets missing from the
 * ready-made fixtures (scale §1e: 86 threads from 85 bots).
 */
export { anchor, bot, comment, human, lens, singleIteration, thread } from './builders.js';
export type { CommentSpec, LensSpec, ThreadSpec } from './builders.js';
export type { RouteBrokenResults, RouteFixtures, RouteRawResults, RouteRawResultsEn } from './data/index.js';
/** File text on both sides: the state gallery needs it without a server or host. */
export { fileContentOf } from './file-content.js';
export type { FixtureData, FixtureInterdiff, FixtureIteration, FixtureIterationView, FixtureName } from './data/index.js';
