import type { AgentNote, ChatAnchor, ChatExchange, ChatExchangeStatus } from '@sherpa/protocol';
import { agentNoteSchema, chatExchangeSchema } from '@sherpa/protocol';

import { makeFileId } from '../patch.js';
import type { FixtureName } from './index.js';
import { MEDIUM_DIFF_ID, MEDIUM_HEAD_COMMIT } from './medium.js';

/** Chat history and local agent notes for the M3 gallery and end-to-end tests. */
export interface ChatFixtures {
    exchanges: ChatExchange[];
    notes: AgentNote[];
}

const P = {
    editWindow: 'services/orders/src/domain/edit-window.ts',
    editPolicy: 'services/orders/src/domain/policies/edit-policy.ts',
    handlers: 'services/orders/src/api/handlers.ts',
} as const;

const ANSWER_SELECTION = [
    'Status `409` here represents two states where a scheduled delivery can no longer be edited:',
    '',
    '- `edit-window-closed`: 30 minutes have passed since the order was placed.',
    '- `already-dispatched`: the courier picked up the order before the deadline.',
    '',
    'Both codes are selected through `REJECTION_STATUS`, and the response body keeps the machine-readable reason and remaining time:',
    '',
    '```ts',
    'res.status(REJECTION_STATUS[decision.reason]).json({',
    '    error: decision.reason,',
    '    remainingMs: policy.remainingMs(order),',
    '});',
    '```',
    '',
    'For `not-scheduled`, the status stays `400`: the edit window has not closed for express delivery, it does not apply to it.',
].join('\n');

const ANSWER_PR = [
    'The PR moves the 30-minute rule from scattered checks into the domain model.',
    '',
    '1. `domain/edit-window.ts` computes the deadline, early closure after dispatch, and shorter windows for fresh food and pharmacy items.',
    '2. `domain/policies/edit-policy.ts` returns machine-readable rejection reasons instead of free text.',
    '3. `api/handlers.ts` maps reasons to `409` or `400`, returns `remainingMs`, and writes audit records.',
    '4. Tests cover the 30-minute boundary, dispatch, express delivery, and category windows.',
    '',
    'The main flow after the change:',
    '',
    '```text',
    'Order → EditWindow.state → EditPolicy.decide → HTTP status + audit',
    '```',
    '',
    'The diff does not show rollout configuration beyond `docs/edit-window.md` and `.github/workflows/ci.yml`, so the actual flag values in each environment cannot be confirmed.',
].join('\n');

const ANSWER_CLASS = [
    'The class makes the time dependency explicit, rather than storing state.',
    '',
    '- Tests replace `Clock` with `FrozenClock`.',
    '- Window calculation lives in one place.',
    '- The caller does not pass `now` manually through the whole chain.',
    '',
    '```ts',
    'const window = new EditWindow(clock);',
    'const state = window.state({ order, slot });',
    '```',
    '',
    'The trade-off is that the time dependency is visible in the `EditWindow` constructor, but not in the `state` signature.',
].join('\n');

const ANSWER_DISPATCH = [
    'Dispatch closes the window only when it happens before the calculated deadline.',
    '',
    '```ts',
    'if (slot.dispatchedAt !== null && slot.dispatchedAt < closesAt) {',
    '    return { kind: "closed", closedAt: slot.dispatchedAt, cause: "dispatch" };',
    '}',
    '```',
    '',
    'If `dispatchedAt` is later than the deadline, the reason stays `deadline`. This preserves the first actual moment after which edits were forbidden.',
].join('\n');

const ANSWER_CATEGORY = [
    'The method starts with the default 30-minute window and chooses the shortest override among the order items.',
    '',
    '- Regular item: 30 minutes.',
    '- `FF-`: 10 minutes.',
    '- `PH-`: 5 minutes.',
    '',
    '```ts',
    'shortest = Math.min(shortest, override);',
    '```',
    '',
    'The current diff uses the equivalent check `override < shortest` instead of `Math.min`. A mixed basket containing a pharmacy item gets 5 minutes.',
].join('\n');

function anchor(path: string, start: number, end: number): ChatAnchor {
    return {
        fileId: makeFileId(MEDIUM_DIFF_ID, path),
        path,
        side: 'new',
        start,
        end,
    };
}

interface ExchangeSpec {
    id: number;
    question: string;
    anchor: ChatAnchor | null;
    status: ChatExchangeStatus;
    answer?: string;
    progressText?: string;
    error?: string;
    createdAt: string;
    updatedAt?: string;
}

function exchange(spec: ExchangeSpec): ChatExchange {
    return {
        id: spec.id,
        question: spec.question,
        anchor: spec.anchor,
        status: spec.status,
        // The fixture task snapshot contains no chat tasks, so no queue link is needed here.
        taskId: null,
        answer: spec.answer ?? null,
        progressText: spec.progressText ?? null,
        error: spec.error ?? null,
        createdAt: spec.createdAt,
        updatedAt: spec.updatedAt ?? spec.createdAt,
    };
}

function note(id: number, source: ChatExchange, createdAt: string): AgentNote {
    if (source.anchor === null || source.answer === null) {
        throw new Error(`exchange ${String(source.id)} cannot be used for a note`);
    }
    return {
        id,
        exchangeId: source.id,
        anchor: source.anchor,
        text: source.answer,
        commit: MEDIUM_HEAD_COMMIT,
        createdAt,
    };
}

function exchangeById(exchanges: readonly ChatExchange[], id: number): ChatExchange {
    const found = exchanges.find((item) => item.id === id);
    if (found === undefined) {
        throw new Error(`chat fixture has no exchange ${String(id)}`);
    }
    return found;
}

function makeMediumChatFixtures(): ChatFixtures {
    const exchanges = [
        exchange({
            id: 1,
            question: 'Why does a closed window return 409 instead of 400?',
            anchor: anchor(P.handlers, 48, 54),
            status: 'done',
            answer: ANSWER_SELECTION,
            createdAt: '2026-08-20T09:12:00.000Z',
            updatedAt: '2026-08-20T09:12:18.000Z',
        }),
        exchange({
            id: 2,
            question: 'Break down the mechanics and risks of this PR.',
            anchor: null,
            status: 'done',
            answer: ANSWER_PR,
            createdAt: '2026-08-20T09:15:00.000Z',
            updatedAt: '2026-08-20T09:15:31.000Z',
        }),
        exchange({
            id: 3,
            question: 'Which lines might the route leave unexplained?',
            anchor: null,
            status: 'queued',
            createdAt: '2026-08-20T09:16:00.000Z',
        }),
        exchange({
            id: 4,
            question: 'Check whether HTTP statuses match the domain rejection reasons.',
            anchor: anchor(P.editPolicy, 30, 43),
            status: 'running',
            progressText: 'Checking rejection reasons against API handlers',
            createdAt: '2026-08-20T09:17:00.000Z',
            updatedAt: '2026-08-20T09:17:09.000Z',
        }),
        exchange({
            id: 5,
            question: 'Does the PR leave a risk of payment data leaking?',
            anchor: null,
            status: 'failed',
            error: 'The agent finished the task without an answer after three validation attempts.',
            createdAt: '2026-08-20T09:18:00.000Z',
            updatedAt: '2026-08-20T09:19:04.000Z',
        }),
        exchange({
            id: 6,
            question: 'Compare the new contract with the previous client behaviour.',
            anchor: null,
            status: 'cancelled',
            createdAt: '2026-08-20T09:20:00.000Z',
            updatedAt: '2026-08-20T09:20:07.000Z',
        }),
        exchange({
            id: 7,
            question: 'Why is `EditWindow` a class instead of a pure function?',
            anchor: anchor(P.editWindow, 24, 32),
            status: 'done',
            answer: ANSWER_CLASS,
            createdAt: '2026-08-20T09:22:00.000Z',
            updatedAt: '2026-08-20T09:22:16.000Z',
        }),
        exchange({
            id: 8,
            question: 'How is the closure reason chosen between dispatch and the deadline?',
            anchor: anchor(P.editWindow, 29, 38),
            status: 'done',
            answer: ANSWER_DISPATCH,
            createdAt: '2026-08-20T09:23:00.000Z',
            updatedAt: '2026-08-20T09:23:14.000Z',
        }),
        exchange({
            id: 9,
            question: 'How is the window calculated for a mixed basket?',
            anchor: anchor(P.editWindow, 31, 43),
            status: 'done',
            answer: ANSWER_CATEGORY,
            createdAt: '2026-08-20T09:24:00.000Z',
            updatedAt: '2026-08-20T09:24:12.000Z',
        }),
    ];

    return {
        exchanges,
        notes: [
            note(1, exchangeById(exchanges, 1), '2026-08-20T09:12:18.000Z'),
            note(2, exchangeById(exchanges, 7), '2026-08-20T09:22:16.000Z'),
            note(3, exchangeById(exchanges, 8), '2026-08-20T09:23:14.000Z'),
            note(4, exchangeById(exchanges, 9), '2026-08-20T09:24:12.000Z'),
        ],
    };
}

const BUILDERS: Partial<Record<FixtureName, () => ChatFixtures>> = {
    medium: makeMediumChatFixtures,
};

function validate(fixtures: ChatFixtures): ChatFixtures {
    return {
        exchanges: fixtures.exchanges.map((item) => chatExchangeSchema.parse(item)),
        notes: fixtures.notes.map((item) => agentNoteSchema.parse(item)),
    };
}

const built = new Map<FixtureName, ChatFixtures | null>();

/** Builds chat fixtures from scratch, bypassing the cache. */
export function buildChatFixtures(name: FixtureName): ChatFixtures | null {
    const builder = BUILDERS[name];
    return builder === undefined ? null : validate(builder());
}

/** Fresh copy of the chat fixtures. Only `medium` currently has data. */
export function chatFixtures(name: FixtureName): ChatFixtures | null {
    let fixtures = built.get(name);
    if (fixtures === undefined) {
        fixtures = buildChatFixtures(name);
        built.set(name, fixtures);
    }
    return fixtures === null ? null : structuredClone(fixtures);
}
