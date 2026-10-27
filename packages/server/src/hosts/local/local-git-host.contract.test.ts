import { afterAll } from 'vitest';

import { describeReviewHostContract } from '../review-host-contract.js';
import { gitContractHosts } from './git-contract-host.js';
import { GIT_USER_NAME, gitAvailable } from './git-fixture.js';

/**
 * `ReviewHost` contract suite on the local host with the `git` backend: real `git` in a temporary
 * repository (`git-contract-host.ts`). For `--verdicts` mode, see `local-git-host-verdicts.contract.test.ts`.
 */

const hosts = gitContractHosts();

afterAll(() => {
    hosts.cleanup();
});

describeReviewHostContract('LocalHost/git', () => hosts.makeHost(), {
    viewer: GIT_USER_NAME,
    slow: true,
    skip: !gitAvailable,
    advance: hosts.advance,
});
