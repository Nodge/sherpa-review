import { afterAll } from 'vitest';

import { describeReviewHostContract } from '../review-host-contract.js';
import { gitContractHosts } from './git-contract-host.js';
import { GIT_USER_NAME, gitAvailable } from './git-fixture.js';

/**
 * `ReviewHost` contract suite on the local host with the `git` backend in `--verdicts` mode:
 * same contract, but publishes through Request changes and Ship instead of Comment. A separate file
 * lets the two slow runs using real `git` execute in parallel.
 */

const hosts = gitContractHosts();

afterAll(() => {
    hosts.cleanup();
});

describeReviewHostContract('LocalHost/git --verdicts', () => hosts.makeHost('on ship, commit and open a PR'), {
    viewer: GIT_USER_NAME,
    slow: true,
    skip: !gitAvailable,
    advance: hosts.advance,
});
