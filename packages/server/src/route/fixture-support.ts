import type { RouteRawResults } from '@sherpa/fixtures';
import { fixtureData, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { PrDiff, RouteSnapshot, Thread } from '@sherpa/protocol';

/**
 * Access to route fixtures for the golden corpus: `routeFixtures` returns `null` when
 * there is no route, and tests should not have to handle that over and over.
 */

export function mediumDiff(): PrDiff {
    return fixtureIteration('medium').diff;
}

export function mediumRawResults(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResults;
    if (raw === null || raw === undefined) {
        throw new Error('the medium fixture has no raw model outputs');
    }
    return raw;
}

/** The fixture diff for the second iteration: the same PR after a push. */
export function mediumDiffV2(): PrDiff {
    return fixtureIteration('medium', 1).diff;
}

/** PR threads in the second iteration: anchors rebound, with a new author reply in one thread. */
export function mediumThreadsV2(): Thread[] {
    return fixtureIteration('medium', 1).threads;
}

/** The slice from the first iteration to the second, declared as fixture data rather than computed. */
export function mediumInterdiffV1V2(): PrDiff {
    const data = fixtureData('medium');
    const from = data.iterations[0]?.iteration.diffId;
    const to = data.iterations[1]?.iteration.diffId;
    const slice = data.interdiffs.find((candidate) => candidate.base === from && candidate.head === to);
    if (slice === undefined) {
        throw new Error('the medium fixture has no slice from the first iteration to the second');
    }
    return slice.diff;
}

/** Raw model outputs for the second pass: the same stops plus "why this stop changed". */
export function mediumRawResultsV2(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResultsV2;
    if (raw === null || raw === undefined) {
        throw new Error('the medium fixture has no raw model outputs for the second pass');
    }
    return raw;
}

export function mediumReadySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot;
    if (snapshot === null || snapshot === undefined) {
        throw new Error('medium fixture has no ready route snapshot');
    }
    return snapshot;
}

/** Raw result text: the model submits a file, not an object. */
export function asRawText(result: unknown): string {
    return JSON.stringify(result, null, 2);
}
