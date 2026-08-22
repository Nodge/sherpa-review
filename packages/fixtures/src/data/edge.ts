import { anchor, comment, human, lens, thread } from '../builders.js';
import { tsLines } from '../content.js';
import type { FileSpec } from '../patch.js';
import { makeFileDiff } from '../patch.js';
import type { FixtureData } from './types.js';

/**
 * PR shape edge cases (SPEC §4.1) and diff rendering edge cases (SPEC §2.11, §2.14): rename,
 * deletion, binary, whitespace-only, one-sided file (additions only), empty file,
 * conflict, mode change. Everything the UI must display as a notice instead of an empty card.
 *
 * Sticky ship is disabled here (`stickyShip: false`). This is the only fixture that shows
 * how the UI hides a verdict unsupported by the host.
 */

const PR_ID = '5122';
const DIFF_ID = '196301';

/** Count from the SPEC §2.13 example ("2,412 changed lines — open file"). */
const HUGE_FILE_LINES = 2412;

const FILES: readonly FileSpec[] = [
    {
        // Rename with an edit: show the old path as "old → new" (SPEC §2.11).
        path: 'services/orders/src/infra/time/clock.ts',
        oldPath: 'services/orders/src/infra/clock.ts',
        changeType: 'move',
        hunks: [
            {
                oldStart: 1,
                newStart: 1,
                lines: [
                    ' export interface Clock {',
                    '-    now(): Date;',
                    '+    now(): Date;',
                    '+    timezone(): string;',
                    ' }',
                ],
            },
        ],
    },
    {
        // Full deletion: the card shows only −N and a struck-through name.
        path: 'services/orders/src/legacy/edit-window-v1.ts',
        changeType: 'delete',
        hunks: [
            {
                oldStart: 1,
                newStart: 0,
                lines: [
                    '-import { Order } from "../domain/order";',
                    '-',
                    '-/** Superseded by domain/edit-window.ts. */',
                    '-export function canEdit(order: Order, hours: number): boolean {',
                    '-    const deadline = order.checkoutAt.getTime() + hours * 3600_000;',
                    '-    return Date.now() < deadline;',
                    '-}',
                ],
            },
        ],
    },
    {
        // Binary: no patch at all. The UI shows "binary file not shown" + the size delta.
        path: 'services/orders/assets/edit-window-flow.png',
        changeType: 'modify',
        binary: true,
    },
    {
        // Whitespace-only: single-line notice, collapsed by default (SPEC §2.14).
        path: 'services/orders/src/api/schemas.ts',
        changeType: 'modify',
        hunks: [
            {
                oldStart: 12,
                newStart: 12,
                section: 'export const orderItemSchema',
                lines: [
                    ' export const orderItemSchema = z.object({',
                    '-    sku: z.string(), ',
                    '-    quantity: z.number().int().positive(),   ',
                    '+    sku: z.string(),',
                    '+    quantity: z.number().int().positive(),',
                    ' });',
                ],
            },
        ],
    },
    {
        // One-sided file: additions only, rendered at full width in split mode.
        path: 'services/orders/docs/rollout.md',
        changeType: 'add',
        hunks: [
            {
                oldStart: 0,
                newStart: 1,
                lines: [
                    '+# Rollout',
                    '+',
                    '+1. Ship behind `checkout_edit_window` (off).',
                    '+2. Enable for internal accounts, watch `checkout.edit_window.rejected`.',
                    '+3. Ramp to 100% over three days.',
                ],
            },
        ],
    },
    {
        // Empty file: no text diff, `patch: null` with zero counters.
        path: 'services/orders/src/infra/time/index.ts',
        changeType: 'add',
    },
    {
        // Conflict: exclude the file from route coverage calculations (SPEC §4.1).
        path: 'services/orders/src/domain/order.ts',
        changeType: 'conflict',
        hunks: [
            {
                oldStart: 34,
                newStart: 34,
                section: 'export interface Order',
                lines: [
                    ' export interface Order {',
                    '+<<<<<<< HEAD',
                    '+    readonly slot: DeliverySlot | null;',
                    '+=======',
                    '+    readonly slot?: DeliverySlot;',
                    '+>>>>>>> main',
                    '     readonly items: readonly OrderItem[];',
                    ' }',
                ],
            },
        ],
    },
    {
        // File above the collapse threshold (SPEC §2.13): its card starts collapsed
        // with "2,412 changed lines — open file".
        path: 'services/orders/src/payments/generated/psp-client.ts',
        changeType: 'add',
        generated: true,
        hunks: [{ oldStart: 0, newStart: 1, lines: tsLines('+', HUGE_FILE_LINES) }],
    },
    {
        // Mode change without content changes: the patch has only an `old mode`/`new mode` header,
        // No hunks, zero counts. The UI shows a single-line notice (SPEC §2.14).
        path: 'services/orders/scripts/rollout.sh',
        changeType: 'modify',
        oldMode: '100644',
        mode: '100755',
    },
];

export function makeEdgeFixture(): FixtureData {
    const reviewer = human('alice', 'Alice Ingram');
    const author = human('avery', 'Avery Vance');

    return {
        pr: {
            id: PR_ID,
            url: `https://github.com/quillmart/quillmart/pull/${PR_ID}`,
            title: 'Move the clock into infra/time and drop the legacy edit window',
            author,
            fromBranch: 'avery/clock-move',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'needs_work',
            updatedAt: '2026-08-19T13:20:00.000Z',
            capabilities: { stickyShip: false, fileViewedSync: true, fileContent: false },
        },
        diff: {
            diffId: DIFF_ID,
            baseCommit: '1d9f4b60c3a785e2f4b8d016c9a3e57b2048df61',
            headCommit: 'ab3e7c015d924f6b8e0a1c73d5628f409b1ec7a2',
            files: FILES.map((spec) => makeFileDiff(DIFF_ID, spec)),
        },
        threads: [
            thread({
                // File comment: has an anchor without a position.
                anchor: anchor(DIFF_ID, 'services/orders/assets/edit-window-flow.png'),
                root: comment({
                    id: '5120018',
                    author: reviewer,
                    body: 'The diagram still shows the old two-hour window.',
                    createdAt: '2026-08-19T13:05:00.000Z',
                }),
            }),
            thread({
                // Thread on a deleted file: anchor on the old side.
                anchor: anchor(DIFF_ID, 'services/orders/src/legacy/edit-window-v1.ts', {
                    side: 'old',
                    line: 5,
                    size: 2,
                }),
                outdated: true,
                root: comment({
                    id: '5120024',
                    author: author,
                    body: 'Deleting this also removes the last caller of `Date.now()` in the domain layer.',
                    createdAt: '2026-08-19T13:12:00.000Z',
                }),
            }),
        ],
        // Reviewer without an ownership zone: disable "My files" with an explanation (SPEC §4.2).
        ownership: lens({
            id: 'mine',
            label: 'My files',
            available: false,
            note: 'You do not own any CODEOWNERS zone touched by this PR.',
        }),
        extraLenses: [],
        currentUser: reviewer,
        mutationEpoch: '2026-08-20T09:00:00.000Z',
    };
}
