import { lensSchema, prDiffSchema, prMetaSchema, reviewUserSchema, threadSchema } from '@sherpa/protocol';

import { makeEdgeFixture } from './edge.js';
import { makeLargeFixture } from './large.js';
import { makeMediumFixture } from './medium.js';
import { makeSmallFixture } from './small.js';
import type { FixtureData } from './types.js';

export type { FixtureData } from './types.js';
export { MEDIUM_DIFF_ID, MEDIUM_HEAD_COMMIT, MEDIUM_TOTALS } from './medium.js';
export { LARGE_FILE_COUNT, LONG_LINE_FILE_PATH, LONG_LINE_MARKER } from './large.js';
export { buildRouteFixtures, routeFixtures } from './route.js';
export type { RouteBrokenResults, RouteFixtures, RouteRawResults } from './route.js';

export type FixtureName = 'medium' | 'small' | 'large' | 'edge';

export const FIXTURE_NAMES: readonly FixtureName[] = ['medium', 'small', 'large', 'edge'];

const BUILDERS: Record<FixtureName, () => FixtureData> = {
    medium: makeMediumFixture,
    small: makeSmallFixture,
    large: makeLargeFixture,
    edge: makeEdgeFixture,
};

/**
 * The fixture passes through the same schemas as a real host response. Data errors must be caught
 * when building the fixture, rather than in a UI test three tasks later.
 */
function validate(data: FixtureData): FixtureData {
    return {
        pr: prMetaSchema.parse(data.pr),
        diff: prDiffSchema.parse(data.diff),
        threads: data.threads.map((thread) => threadSchema.parse(thread)),
        ownership: data.ownership === null ? null : lensSchema.parse(data.ownership),
        extraLenses: data.extraLenses.map((lens) => lensSchema.parse(lens)),
        currentUser: reviewUserSchema.parse(data.currentUser),
        mutationEpoch: data.mutationEpoch,
    };
}

/** Built fixtures are immutable, so they are built once per process. */
const built = new Map<FixtureName, FixtureData>();

/**
 * Builds a fixture from scratch, bypassing the cache. The determinism test needs this: determinism across processes
 * (stable gallery screenshots, e2e) depends on pure builders, which comparing two cache reads
 * cannot check by construction.
 */
export function buildFixture(name: FixtureName): FixtureData {
    return validate(BUILDERS[name]());
}

/**
 * Fresh copy of fixture data. A copy is needed because the host mutates it in memory, and the next
 * host with the same name must receive the same initial data byte for byte.
 */
export function fixtureData(name: FixtureName): FixtureData {
    let data = built.get(name);
    if (data === undefined) {
        data = buildFixture(name);
        built.set(name, data);
    }
    return structuredClone(data);
}
