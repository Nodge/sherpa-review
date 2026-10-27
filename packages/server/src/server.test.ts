import fs from 'node:fs/promises';
import os from 'node:os';

import { PROTOCOL_VERSION, rpcErrorSchema, serverManifestSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServerAlreadyRunningError } from './errors.js';
import { claimManifest, readManifest } from './manifest.js';
import { manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { deadPid, get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { SERVER_VERSION } from './version.js';

const PR_KEY = 'pr-12345';

describe('startServer', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(prKey = PR_KEY, host?: string): Promise<SherpaServer> {
        // Live hosts are forbidden in tests (docs/testing.md). Without a host, the route doesn't warm up.
        const server = await startServer({
            updateChannel: null,
            feedbackChannel: null,
            prKey,
            sherpaDir,
            hosts: [],
            ...(host === undefined ? {} : { host }),
        });
        servers.push(server);
        return server;
    }

    describe('listen address', () => {
        it('accepts only IPv4 loopback when no address is given', async () => {
            const server = await start();

            expect((await get(server.port, '/healthz', server.token)).status).toBe(200);
            await expect(fetch(`http://[::1]:${String(server.port)}/healthz`)).rejects.toThrow();
        });

        it(':: accepts IPv6 and preserves IPv4 discovery and token validation', async () => {
            const server = await start(PR_KEY, '::');
            const url = `http://[::1]:${String(server.port)}/healthz`;

            expect((await fetch(url)).status).toBe(401);
            const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ ok: true, prKey: PR_KEY });
            expect((await get(server.port, '/healthz', server.token)).status).toBe(200);
            await expect(start()).rejects.toThrow(ServerAlreadyRunningError);
        });
    });

    describe('authentication', () => {
        it('/healthz returns 401 in rpcError format without a token', async () => {
            const server = await start();

            const response = await get(server.port, '/healthz');
            expect(response.status).toBe(401);

            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('unauthorized');
        });

        it('also returns 401 with the wrong token', async () => {
            const server = await start();

            const response = await get(server.port, '/healthz', 'a'.repeat(64));
            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('/healthz returns 200 and describes the server with a valid token', async () => {
            const server = await start();

            const response = await get(server.port, '/healthz', server.token);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                ok: true,
                prKey: PR_KEY,
                pid: process.pid,
                serverVersion: SERVER_VERSION,
                protocolVersion: PROTOCOL_VERSION,
            });
        });

        it('returns 404 bad_request for an unknown endpoint with a token', async () => {
            const server = await start();

            const response = await get(server.port, '/no-such-endpoint', server.token);
            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
        });

        it('still returns 401 for an unknown endpoint without a token because authentication precedes routing', async () => {
            const server = await start();

            const response = await get(server.port, '/no-such-endpoint');
            expect(response.status).toBe(401);
        });
    });

    describe('discovery manifest', () => {
        it('writes according to the protocol schema with 0600 permissions', async () => {
            const server = await start();
            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);

            const manifest = serverManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
            expect(manifest).toMatchObject({
                prKey: PR_KEY,
                port: server.port,
                uiHost: '127.0.0.1',
                pid: process.pid,
                token: server.token,
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: SERVER_VERSION,
            });
            expect(server.uiHost).toBe('127.0.0.1');

            const stat = await fs.stat(manifestPath);
            expect(stat.mode & 0o777).toBe(0o600);
        });

        it('uses the machine name in the UI link for an external listener, not the socket address', async () => {
            const server = await start(PR_KEY, '::');

            const manifest = await readManifest(manifestPathFor(sherpaDir, PR_KEY));
            // `http://[::]:<port>` goes nowhere. The manifest must contain the machine name.
            expect(manifest).toMatchObject({ port: server.port, uiHost: os.hostname() });
            expect(server.uiHost).toBe(os.hostname());
        });

        it('restricts state directories with 0700 permissions', async () => {
            await start();

            for (const dir of [sherpaDir, `${sherpaDir}/servers`, `${sherpaDir}/prs/${PR_KEY}`]) {
                const stat = await fs.stat(dir);
                expect(stat.mode & 0o777, dir).toBe(0o700);
            }
        });

        it('replaces a dead server manifest with its own', async () => {
            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
            await fs.mkdir(`${sherpaDir}/servers`, { recursive: true });
            await claimManifest(manifestPath, {
                prKey: PR_KEY,
                port: 65000,
                pid: await deadPid(),
                token: 'expired',
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: SERVER_VERSION,
                createdAt: new Date().toISOString(),
            });

            const server = await start();

            const manifest = await readManifest(manifestPath);
            expect(manifest).toMatchObject({ pid: process.pid, port: server.port, token: server.token });
        });
    });

    describe('one server per PR', () => {
        it('rejects a second startServer for the same PR with the live server details', async () => {
            const first = await start();

            await expect(start()).rejects.toThrow(ServerAlreadyRunningError);

            const error = await startServer({ updateChannel: null, feedbackChannel: null, prKey: PR_KEY, sherpaDir, hosts: [] }).catch(
                (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(ServerAlreadyRunningError);
            expect(error).toMatchObject({ prKey: PR_KEY, port: first.port, pid: process.pid });
        });

        it('leaves exactly one server after concurrent starts', async () => {
            const results = await Promise.allSettled([
                startServer({ updateChannel: null, feedbackChannel: null, prKey: PR_KEY, sherpaDir, hosts: [] }),
                startServer({ updateChannel: null, feedbackChannel: null, prKey: PR_KEY, sherpaDir, hosts: [] }),
                startServer({ updateChannel: null, feedbackChannel: null, prKey: PR_KEY, sherpaDir, hosts: [] }),
            ]);

            const started = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
            servers.push(...started);
            expect(started).toHaveLength(1);

            const winner = started[0];
            if (winner === undefined) {
                throw new Error('no server started');
            }

            const rejections = results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason as unknown] : [],
            );
            for (const reason of rejections) {
                expect(reason).toBeInstanceOf(ServerAlreadyRunningError);
                expect(reason).toMatchObject({ prKey: PR_KEY, port: winner.port, pid: process.pid });
            }

            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toMatchObject({
                port: winner.port,
                token: winner.token,
            });
            // Losing processes left no temporary claim files behind.
            expect(await fs.readdir(`${sherpaDir}/servers`)).toEqual([`${PR_KEY}.json`]);
        });

        it('starts another PR alongside it', async () => {
            const first = await start();
            const second = await start('pr-999');

            expect(second.port).not.toBe(first.port);
            expect(await readManifest(manifestPathFor(sherpaDir, 'pr-999'))).not.toBeNull();
        });
    });

    describe('close', () => {
        it('releases the port, removes the manifest and tolerates a repeated call', async () => {
            const server = await start();
            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);

            await server.close();
            await server.close();

            await expect(fs.stat(manifestPath)).rejects.toThrow();
            await expect(get(server.port, '/healthz', server.token)).rejects.toThrow();
        });
    });

    it('prevents an invalid PR key from writing outside the state directory', async () => {
        await expect(startServer({ updateChannel: null, feedbackChannel: null, prKey: '../escape', sherpaDir, hosts: [] })).rejects.toThrow(/Invalid PR key/);
    });
});
