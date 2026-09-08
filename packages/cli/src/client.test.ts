import { LONG_POLL_CEILING_SECONDS, LONG_POLL_DEFAULT_SECONDS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { nextTimeoutMs, requestNext } from './client.js';
import { CliError } from './errors.js';

/**
 * The client aborts `next` later than the server. The response to an expired window is already in flight, and aborting it
 * would mean losing the issued task. The margin is shared, but the deadline depends on the requested wait.
 */
describe('client timeout for next', () => {
    const SLACK_SECONDS = 30;

    it('derives from the requested wait', () => {
        expect(nextTimeoutMs(1)).toBe((1 + SLACK_SECONDS) * 1000);
        expect(nextTimeoutMs(540)).toBe((540 + SLACK_SECONDS) * 1000);
        expect(nextTimeoutMs(LONG_POLL_CEILING_SECONDS)).toBe((LONG_POLL_CEILING_SECONDS + SLACK_SECONDS) * 1000);
    });

    it('uses the server default without the flag: that is how long the server holds the call', () => {
        expect(nextTimeoutMs(undefined)).toBe((LONG_POLL_DEFAULT_SECONDS + SLACK_SECONDS) * 1000);
    });

    // An hour-long wait is valid for background polling, and the client must survive it.
    it('an hour-long wait does not hit undici\'s five-minute headersTimeout', () => {
        expect(nextTimeoutMs(3600)).toBeGreaterThan(300 * 1000);
    });
});

/**
 * The `next` transport builds its own request, and construction may fail before it reaches the network, for example,
 * on an invalid token from the manifest. To the caller, the server is just as unavailable
 * as with a socket failure. It must return a ready-to-use message, not a raw Node error.
 */
describe('next transport: failure before reaching the network', () => {
    it('invalid manifest token produces a CliError about an unavailable server', async () => {
        const connection = {
            prKey: 'fixture-medium',
            port: 1,
            token: 'broken\ntoken',
            workerId: 'w-1',
        };

        const failure = await requestNext(connection, 1).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CliError);
        expect((failure as CliError).message).toContain('fixture-medium');
    });
});
