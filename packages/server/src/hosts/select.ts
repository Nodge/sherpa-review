import type { FixtureName } from '@sherpa/fixtures';
import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';
import type { ReviewHost } from '@sherpa/protocol';



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
        return { name: 'fixture', host: makeFixtureHost(raw) };
    }

    return null;
}

function isFixtureName(value: string): value is FixtureName {
    return (FIXTURE_NAMES as readonly string[]).includes(value);
}
