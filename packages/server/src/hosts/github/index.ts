import { githubPrKey } from '@sherpa/protocol';

import { githubDraftsPathFor } from '../../paths.js';

import { GithubHost } from './github-host.js';
import { fileIdempotencyStore } from './idempotency-store.js';
import { githubTokenSource } from './token.js';

export { GithubHost } from './github-host.js';
export type { GithubHostOptions } from './github-host.js';

export interface GithubHostSetup {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    /** State root containing this PR's draft retry map. */
    readonly sherpaDir: string;
}

/** The github.com host for a `github-*` key, with a real token and a draft retry map on disk. */
export function makeGithubHost(setup: GithubHostSetup): GithubHost {
    const prKey = githubPrKey(setup);
    return new GithubHost({
        owner: setup.owner,
        repo: setup.repo,
        number: setup.number,
        token: githubTokenSource(),
        idempotency: fileIdempotencyStore(githubDraftsPathFor(setup.sherpaDir, prKey)),
    });
}
