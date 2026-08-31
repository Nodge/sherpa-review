import { describe, expect, it, vi } from 'vitest';

import {
    availableShipMode,
    loadShipMode,
    partialPublicationFailure,
    publishConsequence,
    publishDisabledReason,
    requestPublicationFailure,
    saveShipMode,
} from './review-action-model.js';

describe('floating bar model', () => {
    it('blocks publishing with unsaved text, no connection or an in-flight request', () => {
        expect(publishDisabledReason({ connection: 'online', pendingComposer: true, publishing: false })).toBe(
            ru['ship.disabled.pending'],
        );
        expect(publishDisabledReason({ connection: 'reconnecting', pendingComposer: false, publishing: false })).toBe(
            'no connection to the server',
        );
        expect(publishDisabledReason({ connection: 'online', pendingComposer: false, publishing: true })).toBe(
            ru['ship.disabled.publishing'],
        );
        expect(
            publishDisabledReason({ connection: 'online', pendingComposer: false, publishing: false, failure: true }),
        ).toBe(ru['ship.disabled.retry']);
        expect(publishDisabledReason({ connection: 'online', pendingComposer: false, publishing: false })).toBeNull();
    });

    it('persists the mode and falls back from sticky on a host without the capability', () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
                values.set(key, value);
            },
        };

        saveShipMode('sticky_ship', storage);
        expect(loadShipMode(true, storage)).toBe('sticky_ship');
        expect(loadShipMode(false, storage)).toBe('ship');
        expect(availableShipMode('sticky_ship', false)).toBe('ship');
    });

    it('shows the exact command consequence with the draft count', () => {
        expect(publishConsequence('request_changes', 2)).toBe('Publishes 2 drafts and requests changes');
        expect(publishConsequence('ship', 1)).toBe('Publishes 1 draft and approves the snapshot');
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
        );

        expect(failure).toEqual({
            verdict: 'ship',
            failedCount: 1,
            comments: [{ commentId: 'bad', message: 'The review host refused', body: 'The boundary needs fixing' }],
            message: null,
        });
        expect(partialPublicationFailure('ship', { publishedCommentIds: [], failed: [], verdictApplied: true }, new Map())).toBeNull();
    });

    it('keeps the same verdict for an explicit retry after a network failure', () => {
        const error = new Error('server unavailable');
        expect(requestPublicationFailure('sticky_ship', 3, error)).toMatchObject({
            verdict: 'sticky_ship',
            failedCount: 3,
            message: 'server unavailable',
        });
    });

    it('keeps the mode working when storage is blocked', () => {
        const storage = { getItem: vi.fn(() => { throw new Error('denied'); }) };
        expect(loadShipMode(true, storage)).toBe('ship');
    });
});
