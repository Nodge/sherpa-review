import { describeReviewHostContract } from '../review-host-contract.js';

import { GithubHost } from './github-host.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import type { MockGithubControl, MockGithubOptions } from './mock-transport.js';
import { makeMockGithubFetch, MOCK_NUMBER, MOCK_OWNER, MOCK_REPO, MOCK_VIEWER } from './mock-transport.js';

/**
 * `ReviewHost` contract suite against the recorded GitHub API, covering reads and writes.
 * A "push" here is a mock endpoint that advances the branch head to a new commit.
 */

/** Latin characters are deliberate. The value goes in a header, which must be ISO-8859-1. */
const TOKEN = 'test-token-must-never-leak-42';

const pushes = new WeakMap<GithubHost, MockGithubControl>();

function makeHost(options: MockGithubOptions = {}): GithubHost {
    const control: MockGithubControl = {};
    const host = new GithubHost({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        number: MOCK_NUMBER,
        fetch: makeMockGithubFetch({ ...options, control }),
        token: () => Promise.resolve(TOKEN),
        pollIntervalMs: 20,
        idempotency: memoryIdempotencyStore(),
        transport: { retryAttempts: 1 },
    });
    pushes.set(host, control);
    return host;
}

function push(host: GithubHost): void {
    const control = pushes.get(host)?.push;
    if (control === undefined) {
        throw new Error('GitHub mock did not return the "push" endpoint');
    }
    control();
}

describeReviewHostContract('GitHubHost (recorded API)', () => makeHost(), { advance: push });

// Own PR: GitHub forbids the author from giving any verdict, leaving only comments as a publish mode.
describeReviewHostContract(
    'GitHubHost (own PR)',
    () => makeHost({ prOverrides: { author: { login: MOCK_VIEWER, __typename: 'User' } } }),
    { advance: push },
);
