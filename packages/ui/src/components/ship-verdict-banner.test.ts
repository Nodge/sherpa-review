import type { ReviewerVerdict } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { INITIAL_SHIP_VERDICT_WATCH, newShipVerdict, observeShipVerdicts } from './ship-verdict-banner.tsx';

/** "Someone else ships first": the event is another person's ship appearing, not the presence of a ship. */

function verdict(login: string, value: ReviewerVerdict['verdict']): ReviewerVerdict {
    return { user: { login, displayName: null, bot: false }, verdict: value };
}

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

describe('new ship by another reviewer', () => {
    it('first snapshot is the baseline and produces no events', () => {
        expect(newShipVerdict(null, [verdict('lead', 'ship')], NOW)).toBeNull();
    });

    it('new ship produces an event with the observation time', () => {
        expect(newShipVerdict([], [verdict('lead', 'ship')], NOW)).toEqual({
            login: 'lead',
            displayName: null,
            observedAt: NOW,
        });
    });

    it('sticky_ship counts as the same event', () => {
        expect(newShipVerdict([], [verdict('lead', 'sticky_ship')], NOW)?.login).toBe('lead');
    });

    it('previously seen ship produces no event and request_changes never did', () => {
        expect(newShipVerdict([verdict('lead', 'ship')], [verdict('lead', 'ship')], NOW)).toBeNull();
        expect(newShipVerdict([], [verdict('picky', 'request_changes')], NOW)).toBeNull();
    });

    it('ship by a second reviewer is a new event', () => {
        expect(
            newShipVerdict([verdict('lead', 'ship')], [verdict('lead', 'ship'), verdict('peer', 'ship')], NOW)?.login,
        ).toBe('peer');
    });
});

describe('observing verdicts', () => {
    it('own ship after own publication produces no banner but the next ship by someone else does', () => {
        const base = observeShipVerdicts(INITIAL_SHIP_VERDICT_WATCH, [], NOW);
        expect(base.event).toBeNull();

        // Publishing from Sherpa: our verdict is about to arrive in metadata.
        const published = { ...base.watch, ownShipPending: true };
        const own = observeShipVerdicts(published, [verdict('alice', 'ship')], NOW);
        expect(own.event).toBeNull();

        const other = observeShipVerdicts(own.watch, [verdict('alice', 'ship'), verdict('lead', 'ship')], NOW);
        expect(other.event?.login).toBe('lead');
    });

    it('own publication does not suppress ships that did not appear after it', () => {
        const base = observeShipVerdicts(INITIAL_SHIP_VERDICT_WATCH, [], NOW);
        const published = { ...base.watch, ownShipPending: true };

        // Snapshots without new verdicts do not consume the pending wait for our own ship.
        const quiet = observeShipVerdicts(published, [], NOW);
        expect(quiet.watch.ownShipPending).toBe(true);
    });
});
