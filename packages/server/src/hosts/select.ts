import type { FixtureName } from '@sherpa/fixtures';
import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';
import type { Iteration, ReviewHost } from '@sherpa/protocol';



/**
 * Select a host adapter by PR key (`<host>-<pr>`, rpc-design §8):
 * `fixture-<medium|small|large|edge>` selects deterministic
 * fixtures (UI development and e2e F5). Anything else has no host, so review endpoints return `no_review_host`.
 *
 * The fixture host is intentionally connected to the server. Otherwise development mode and e2e would need a live
 * review host, while the M1 UI branch is developed using fixtures.
 */

export interface SelectedHost {
    /** Adapter name for `uiState.reviewHost`. */
    readonly name: string;
    readonly host: ReviewHost;
    /** Optional host-specific whoami for automatic feedback context. */
    readonly currentUser?: () => string | null | Promise<string | null>;
    /**
     * Fixture host only: development "push" (`UI_DEV_ENDPOINTS.fixtureAdvanceIteration`).
     * This access does not extend beyond the development route registration point. Shared server code
     * knows nothing about fixtures.
     */
    readonly advanceIteration?: () => Iteration;
}

export type ReviewHostFactory = (prKey: string) => SelectedHost | null;


const FIXTURE_PREFIX = 'fixture-';

export function selectReviewHost(prKey: string): SelectedHost | null {
    
        
        
        if (!/^[1-9]\d*$/.test(raw)) {
            return null;
        }
        
        
    }

    if (prKey.startsWith(FIXTURE_PREFIX)) {
        const raw = prKey.slice(FIXTURE_PREFIX.length);
        if (!isFixtureName(raw)) {
            return null;
        }
        const host = makeFixtureHost(raw);
        return { name: 'fixture', host, advanceIteration: () => host.advanceIteration() };
    }

    return null;
}

function isFixtureName(value: string): value is FixtureName {
    return (FIXTURE_NAMES as readonly string[]).includes(value);
}
