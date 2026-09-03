import { describe, expect, it } from 'vitest';

import { createT, ru } from '../i18n/index.js';
import {
    availableShipMode,
    partialPublicationFailure,
    publishConsequenceKey,
    publishDisabledReason,
    requestPublicationFailure,
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

    // Draft buffer (M5-T15): there is nothing to publish until the host accepts the text.
    it('blocks publishing while buffered drafts have not arrived', () => {
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 2,
                publishing: false,
            }),
        ).toBe('2 drafts not yet saved to the host. ship is unavailable until saved');
        expect(
            publishDisabledReason({
                t,
                connection: 'online',
                pendingComposer: false,
                bufferedDrafts: 1,
                publishing: false,
            }),
        ).toBe('1 draft not yet saved to the host. ship is unavailable until saved');
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

    it('falls back from sticky on a host without the capability', () => {
        expect(availableShipMode('sticky_ship', true)).toBe('sticky_ship');
        expect(availableShipMode('sticky_ship', false)).toBe('ship');
        expect(availableShipMode('ship', true)).toBe('ship');
    });

    it('shows the exact command consequence with the draft count', () => {
        expect(t(publishConsequenceKey('request_changes'), 2)).toBe('Опубликует 2 черновика и запросит изменения');
        expect(t(publishConsequenceKey('ship'), 1)).toBe('Опубликует 1 черновик и одобрит снапшот');
        expect(createT('en')(publishConsequenceKey('ship'), 1)).toBe('Publishes 1 draft and approves the snapshot');
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
