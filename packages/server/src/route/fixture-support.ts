import type { RouteRawResults } from '@sherpa/fixtures';
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { PrDiff, RouteSnapshot } from '@sherpa/protocol';

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
