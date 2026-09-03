import type { PrDiff } from '@sherpa/protocol';

import { human, lens, singleIteration } from '../builders.js';
import type { FixtureData } from './types.js';

/**
 * A PR without a single change against the base (SPEC §4.1): the diff is empty because the whole commit is already in the base
 * (the branch was merged outside the PR, reverted, or rebuilt). Both views show "Nothing to review",
 * and ship remains available: approving an empty diff is a valid reviewer action.
 *
 * There is exactly one iteration, and it is required: a host without iterations has nothing to return (`validate` in index.ts).
 */

const PR_ID = '5120';
const DIFF_ID = '204118';

const UPDATED_AT = '2026-09-02T11:40:00.000Z';

export function makeEmptyFixture(): FixtureData {
    const author = human('dana', 'Dana Stone');
    const reviewer = human('alice', 'Alice Ingram');

    const diff: PrDiff = {
        diffId: DIFF_ID,
        baseCommit: '7c1f4a2b9e0d5386f2a4b8c1d7e930465b8a2f13',
        headCommit: '7c1f4a2b9e0d5386f2a4b8c1d7e930465b8a2f13',
        files: [],
    };

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Revert the checkout slot rollout',
            author,
            fromBranch: 'dana/checkout-slot-revert',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'waiting_for_review',
            checks: 'pending',
            updatedAt: UPDATED_AT,
            capabilities: { stickyShip: true, fileViewedSync: true, fileContent: true, commentIssues: true, iterations: false },
        },
        iterations: singleIteration(diff, [], UPDATED_AT),
        interdiffs: [],
        // No ownership zones without files: the lens exists but is empty.
        ownership: lens({ id: 'mine', label: 'My files', paths: [], zones: [] }),
        extraLenses: [
            lens({
                id: 'pci',
                label: 'PCI DSS',
                available: false,
                note: 'The PCI DSS scope is not published for this commit yet.',
            }),
        ],
        currentUser: reviewer,
        mutationEpoch: '2026-09-02T12:00:00.000Z',
    };
}
