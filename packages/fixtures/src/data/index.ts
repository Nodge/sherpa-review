import type { PrDiff } from '@sherpa/protocol';
import {
    iterationSchema,
    lensSchema,
    prDiffSchema,
    prMetaSchema,
    reviewUserSchema,
    threadSchema,
} from '@sherpa/protocol';

import { makeEdgeFixture } from './edge.js';
import { makeLargeFixture } from './large.js';
import { makeMediumFixture } from './medium.js';
import { makeSmallFixture } from './small.js';
import type { FixtureData, FixtureInterdiff, FixtureIteration, FixtureIterationView } from './types.js';

export type { FixtureData, FixtureInterdiff, FixtureIteration, FixtureIterationView } from './types.js';
export {
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_DIFF_ID_V3,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    MEDIUM_HEAD_COMMIT_V3,
    MEDIUM_TOTALS,
} from './medium.js';
export { LARGE_FILE_COUNT, LONG_LINE_FILE_PATH, LONG_LINE_MARKER } from './large.js';
export { buildChatFixtures, chatFixtures } from './chat.js';
export type { ChatFixtures } from './chat.js';
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

/** Iteration schema without status: the host computes status, so it is absent from the data. */
const iterationMetaSchema = iterationSchema.omit({ status: true });

function validateIteration(iteration: FixtureIteration): FixtureIteration {
    return {
        iteration: iterationMetaSchema.parse(iteration.iteration),
        diff: prDiffSchema.parse(iteration.diff),
        threads: iteration.threads.map((thread) => threadSchema.parse(thread)),
        replaces: iteration.replaces,
    };
}

function validateInterdiff(interdiff: FixtureInterdiff): FixtureInterdiff {
    return {
        base: interdiff.base,
        head: interdiff.head,
        diff: prDiffSchema.parse(interdiff.diff),
    };
}

/**
 * The fixture passes through the same schemas as a real host response. Data errors must be caught
 * while building the fixture, before a UI test three tasks later. Slices between iterations are also `PrDiff`,
 * so the same schema validates them.
 */
function validate(data: FixtureData): FixtureData {
    if (data.iterations.length === 0) {
        throw new Error('fixture has no iterations: the host has nothing to return');
    }
    return {
        pr: prMetaSchema.parse(data.pr),
        iterations: data.iterations.map(validateIteration),
        interdiffs: data.interdiffs.map(validateInterdiff),
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

/**
 * Slice between two fixture iterations (interdiff), the same `PrDiff` the host returns for
 * `getDiff({base, head})`. Indexes are iteration positions in the fixture list.
 */
export function fixtureInterdiff(name: FixtureName, baseIndex: number, headIndex: number): PrDiff {
    const data = fixtureData(name);
    const base = data.iterations[baseIndex];
    const head = data.iterations[headIndex];
    if (base === undefined || head === undefined) {
        throw new Error(`fixture ${name} has no iterations at indexes ${String(baseIndex)} and ${String(headIndex)}`);
    }
    const found = data.interdiffs.find(
        (interdiff) => interdiff.base === base.iteration.diffId && interdiff.head === head.iteration.diffId,
    );
    if (found === undefined) {
        throw new Error(`fixture ${name} has no slice ${base.iteration.diffId}→${head.iteration.diffId}`);
    }
    return found.diff;
}

/**
 * Flat fixture for one iteration: PR, its diff and threads alongside lenses. Used by consumers
 * that do not need iterations: UI tests, the gallery, e2e. Defaults to the first iteration,
 * the PR state before any push.
 */
export function fixtureIteration(name: FixtureName, index = 0): FixtureIterationView {
    const data = fixtureData(name);
    const iteration = data.iterations[index];
    if (iteration === undefined) {
        throw new Error(`fixture ${name} has no iteration at index ${String(index)}`);
    }
    return {
        pr: data.pr,
        iteration: iteration.iteration,
        diff: iteration.diff,
        threads: iteration.threads,
        ownership: data.ownership,
        extraLenses: data.extraLenses,
        currentUser: data.currentUser,
        mutationEpoch: data.mutationEpoch,
    };
}
