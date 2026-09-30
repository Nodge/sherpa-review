import { describe, expect, it } from 'vitest';

import { createT, ru } from '../i18n/index.js';
import {
    availableShipMode,
    draftsCounterKey,
    isShipVerdict,
    noDraftsKey,
    partialPublicationFailure,
    publishConsequenceKey,
    publishDisabledReason,
    requestPublicationFailure,
    shipModeOf,
    shipModesOf,
    shipOptionDisabledKey,
} from './review-action-model.js';

const t = createT('ru');

describe('floating bar model', () => {
    it('blocks publishing with unsaved text, no connection or an in-flight request', () => {
        expect(publishDisabledReason({ t, connection: 'online', pendingComposer: true, publishing: false })).toBe(
            ru['ship.disabled.pending'],
        );
        expect(
            publishDisabledReason({ t, connection: 'reconnecting', pendingComposer: false, publishing: false }),
        ).toBe(ru['ship.disabled.offline']);
        expect(publishDisabledReason({ t, connection: 'online', pendingComposer: false, publishing: true })).toBe(
            ru['ship.disabled.publishing'],
        );
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                publishing: false,
                failure: true,
            }),
        ).toBe(ru['ship.disabled.retry']);
        expect(
            publishDisabledReason({ t, connection: 'online', pendingComposer: false, publishing: false }),
        ).toBeNull();
    });

    // Draft buffer: there is nothing to publish until the host accepts the text.
    it('blocks publishing while buffered drafts have not arrived', () => {
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 2,
                publishing: false,
            }),
        ).toBe(ru['ship.disabled.buffered'](2));
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 1,
                publishing: false,
            }),
        ).toBe(ru['ship.disabled.buffered'](1));
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 0,
                publishing: false,
            }),
        ).toBeNull();
    });

    it('lists split-button modes ship, sticky and comment from the PR modes in menu order', () => {
        expect(shipModesOf(['request_changes', 'comment', 'sticky_ship', 'ship'])).toEqual([
            'ship',
            'sticky_ship',
            'comment',
        ]);
        expect(shipModesOf(['comment'])).toEqual(['comment']);
    });

    it('uses the saved mode if available, then ship, then comment', () => {
        const all = shipModesOf(['comment', 'ship', 'sticky_ship', 'request_changes']);
        expect(availableShipMode('sticky_ship', all)).toBe('sticky_ship');
        expect(availableShipMode('comment', all)).toBe('comment');
        expect(availableShipMode('sticky_ship', ['ship', 'comment'])).toBe('ship');
        // Ship does not apply to own PRs on GitHub or local review.
        expect(availableShipMode('ship', ['comment'])).toBe('comment');
        expect(availableShipMode('sticky_ship', ['comment'])).toBe('comment');
        // Without comment, the host determines the modes. No modes means no button.
        expect(availableShipMode('comment', ['ship', 'sticky_ship'])).toBe('ship');
        expect(availableShipMode('comment', ['sticky_ship'])).toBe('sticky_ship');
        expect(availableShipMode('ship', [])).toBeNull();
    });

    it('remembers split-button modes but not Request changes', () => {
        expect(shipModeOf('ship')).toBe('ship');
        expect(shipModeOf('sticky_ship')).toBe('sticky_ship');
        expect(shipModeOf('comment')).toBe('comment');
        expect(shipModeOf('request_changes')).toBeNull();
    });

    it('treats only ship and sticky_ship as ship', () => {
        expect(isShipVerdict('ship')).toBe(true);
        expect(isShipVerdict('sticky_ship')).toBe(true);
        expect(isShipVerdict('comment')).toBe(false);
        expect(isShipVerdict('request_changes')).toBe(false);
    });

    it('disables menu rows outside the host modes and Comment without drafts', () => {
        const modes = shipModesOf(['comment', 'ship', 'request_changes']);
        expect(shipOptionDisabledKey('ship', modes, 0, 'pr')).toBeNull();
        expect(shipOptionDisabledKey('sticky_ship', modes, 2, 'pr')).toBe('ship.mode.sticky.unavailable');
        expect(shipOptionDisabledKey('ship', ['sticky_ship', 'comment'], 2, 'pr')).toBe('ship.mode.ship.unavailable');
        expect(shipOptionDisabledKey('comment', modes, 1, 'pr')).toBeNull();
        expect(shipOptionDisabledKey('comment', modes, 0, 'pr')).toBe('ship.noDrafts');
        expect(shipOptionDisabledKey('comment', ['comment'], 0, 'agent')).toBe('ship.noDraftsForAgent');
        expect(shipOptionDisabledKey('comment', ['ship'], 2, 'pr')).toBe('ship.mode.comment.unavailable');
    });

    it('shows the exact command consequence with the draft count', () => {
        expect(publishConsequenceKey('comment', 'pr')).toBe('ship.consequence.comment');
        expect(createT('en')(publishConsequenceKey('comment', 'pr'), 1)).toBe('Publishes 1 draft without a verdict');
        expect(publishConsequenceKey('request_changes', 'pr')).toBe('ship.consequence.requestChanges');
        expect(publishConsequenceKey('ship', 'pr')).toBe('ship.consequence.ship');
        expect(createT('en')(publishConsequenceKey('ship', 'pr'), 1)).toBe('Publishes 1 draft and approves the snapshot');
    });

    it('passes drafts to the agent for comment on the local host', () => {
        expect(publishConsequenceKey('comment', 'agent')).toBe('ship.consequence.commentAgent');
        expect(createT('en')(publishConsequenceKey('comment', 'agent'), 1)).toBe('Hands 1 draft to the agent');
        expect(draftsCounterKey('agent')).toBe('ship.draftsToAgent');
        expect(createT('en')(draftsCounterKey('agent'), 1)).toBe('1 draft goes to the agent');
        expect(draftsCounterKey('pr')).toBe('ship.drafts');
        expect(noDraftsKey('agent')).toBe('ship.noDraftsForAgent');
        expect(createT('en')(noDraftsKey('agent'))).toBe('no comments for the agent');
    });

    it('keeps the comment list on partial failure without reporting success', () => {
        const failure = partialPublicationFailure(
            'ship',
            {
                publishedCommentIds: ['ok'],
                failed: [{ commentId: 'bad', message: 'The review host refused' }],
                verdictApplied: false,
            },
            new Map([['bad', 'Fix the boundary']]),
            t,
        );

        expect(failure).toEqual({
            verdict: 'ship',
            failedCount: 1,
            comments: [{ commentId: 'bad', message: 'The review host refused', body: 'The boundary needs fixing' }],
            message: null,
        });
        expect(
            partialPublicationFailure(
                'ship',
                { publishedCommentIds: [], failed: [], verdictApplied: true },
                new Map(),
                t,
            ),
        ).toBeNull();
    });

    it('keeps the same verdict for an explicit retry after a network failure', () => {
        const error = new Error('server unavailable');
        expect(requestPublicationFailure('sticky_ship', 3, error)).toMatchObject({
            verdict: 'sticky_ship',
            failedCount: 3,
            message: 'server unavailable',
        });
    });
});
