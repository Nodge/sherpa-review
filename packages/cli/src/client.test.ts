import { LONG_POLL_DEFAULT_SECONDS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { NEXT_TIMEOUT_MS, requestNext } from './client.js';
import { CliError } from './errors.js';

/**
 * The client aborts `next` later than the server. The response to an expired window is already in flight, and aborting it
 * would lose the assigned task.
 */
describe('client timeout for next', () => {
    it('outlasts the server window with a margin, but remains finite', () => {
        expect(NEXT_TIMEOUT_MS).toBe((LONG_POLL_DEFAULT_SECONDS + 30) * 1000);
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

        const failure = await requestNext(connection).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CliError);
        expect((failure as CliError).message).toContain('fixture-medium');
    });
});
