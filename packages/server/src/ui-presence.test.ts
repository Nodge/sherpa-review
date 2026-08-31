import { UI_GONE_GRACE_SECONDS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UiPresence } from './ui-presence.js';

const START = new Date('2026-08-31T12:00:00.000Z');

describe('UI presence', () => {
    let now: Date;
    let presence: UiPresence;

    beforeEach(() => {
        now = START;
        presence = new UiPresence({ now: () => now });
    });

    afterEach(() => {
        presence.close();
    });

    function advanceSeconds(seconds: number): void {
        now = new Date(now.getTime() + seconds * 1000);
        presence.checkNow();
    }

    it('never enters uiGone if the UI has never been opened', () => {
        advanceSeconds(UI_GONE_GRACE_SECONDS * 10);

        expect(presence.connectionCount).toBe(0);
        expect(presence.uiGone).toBe(false);
    });

    it('returning within the grace period cancels departure without a trace', () => {
        const disconnect = presence.connect();
        disconnect();
        advanceSeconds(UI_GONE_GRACE_SECONDS - 1);
        expect(presence.uiGone).toBe(false);

        const disconnectAgain = presence.connect();
        advanceSeconds(2);
        expect(presence.uiGone).toBe(false);

        disconnectAgain();
        advanceSeconds(UI_GONE_GRACE_SECONDS - 1);
        expect(presence.uiGone).toBe(false);
        advanceSeconds(1);
        expect(presence.uiGone).toBe(true);
    });

    it('multiple tabs: the grace period starts after the last one closes', () => {
        const disconnectFirst = presence.connect();
        const disconnectSecond = presence.connect();
        expect(presence.connectionCount).toBe(2);

        disconnectFirst();
        advanceSeconds(UI_GONE_GRACE_SECONDS * 2);
        expect(presence.uiGone).toBe(false);

        disconnectSecond();
        advanceSeconds(UI_GONE_GRACE_SECONDS);
        expect(presence.uiGone).toBe(true);
    });

    it('reconnecting after uiGone restores the live state', () => {
        const disconnect = presence.connect();
        disconnect();
        advanceSeconds(UI_GONE_GRACE_SECONDS);
        expect(presence.uiGone).toBe(true);

        presence.connect();

        expect(presence.connectionCount).toBe(1);
        expect(presence.uiGone).toBe(false);
    });
});
