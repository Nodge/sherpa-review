import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { LONG_POLL_DEFAULT_SECONDS } from '@sherpa/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { NEXT_TIMEOUT_MS, requestNext, requestRegister } from './client.js';
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
            pid: 1,
            port: 1,
            token: 'broken\ntoken',
            workerId: 'w-1',
        };

        const target = { cliPath: '/opt/sherpa/sherpa-review.mjs', prKey: connection.prKey };

        const failure = await requestNext(connection, target).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CliError);
        expect((failure as CliError).message).toContain('fixture-medium');
    });
});

/**
 * After an upgrade, `up` reuses the previous release's live server. Its own hint may be stale, so on
 * `version_incompatible` the CLI prints the recovery itself: the pid to stop and what to rerun.
 */
describe('server of another version', () => {
    const PID = 4242;
    const LABELS = { harness: undefined, model: undefined, lang: undefined };
    let server: http.Server | undefined;

    afterEach(async () => {
        await new Promise((resolve) => server?.close(resolve));
        server = undefined;
    });

    async function serve(status: number, body: string) {
        server = http.createServer((_request, response) => {
            response.writeHead(status, { 'content-type': 'application/json' }).end(body);
        });
        await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        const connection = { prKey: 'fixture-medium', pid: PID, port, token: 't'.repeat(64), workerId: 'w-1' };
        return { connection, target: { cliPath: '/opt/sherpa/sherpa-review.mjs', prKey: connection.prKey } };
    }

    const STALE = JSON.stringify({
        error: { code: 'version_incompatible', message: 'Update the skill together with the CLI and restart the server.' },
    });

    it('on registration, names the pid and says to rerun the same command, not the stale server hint', async () => {
        const { connection, target } = await serve(409, STALE);

        const failure = await requestRegister(connection, target, LABELS).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CliError);
        expect((failure as CliError).message).toBe(
            `sherpa-review: a Sherpa server of another version is still running for this PR (pid ${String(PID)}), ` +
                'and this CLI cannot work with it.\n' +
                `Stop it with \`kill ${String(PID)}\`, or wait until it stops on its own after 15 idle minutes, ` +
                'then run the same command again.\nShow this text to the user and stop — do not start the worker loop.',
        );
    });

    it('in the loop, says to run the skill again and stop the loop', async () => {
        const { connection, target } = await serve(409, STALE);

        const message = await requestNext(connection, target).catch((error: unknown) => (error as CliError).message);

        expect(message).toContain(`\`kill ${String(PID)}\``);
        expect(message).toContain('then run the skill again.\nShow this text to the user and stop the loop.');
        expect(message).not.toContain('Update the skill');
    });

    // The same-version server may have just failed: telling the user to kill it would be wrong.
    it.each([
        ['a non-RPC error body', 500, '<html>not sherpa</html>'],
        ['a 2xx body outside the response schema', 200, JSON.stringify({ unexpected: true })],
    ])('reports %s as off-contract, without a kill hint', async (_case, status, body) => {
        const { connection, target } = await serve(status, body);

        const message = await requestRegister(connection, target, LABELS).catch((error: unknown) => (error as CliError).message);

        expect(message).toBe(
            'sherpa-review: the server replied off-contract — it may have failed, or it runs a build that speaks ' +
                'another protocol.\nShow this text to the user and stop — do not start the worker loop.',
        );
        expect(message).not.toContain('kill');
    });
});
