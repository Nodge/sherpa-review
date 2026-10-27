import { MEDIUM_DIFF_ID, MEDIUM_DIFF_ID_V2 } from '@sherpa/fixtures';
import { rpcErrorSchema, UI_DEV_ENDPOINTS, uiReviewDiffResponseSchema, uiReviewWriteAckSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixtureHostPlugin } from './hosts/fixture/plugin.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, plainHostPlugin, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * The "fixture receives a push" dev endpoint exists only for a fixture prKey and uses the same
 * token as UI endpoints.
 */

describe('server dev endpoints', () => {
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

    async function start(prKey: string): Promise<SherpaServer> {
        const server = await startServer({ updateChannel: null, feedbackChannel: null, prKey, sherpaDir, longPollSeconds: 0.3, hosts: [fixtureHostPlugin, plainHostPlugin] });
        servers.push(server);
        return server;
    }

    async function diffIdOf(server: SherpaServer): Promise<string> {
        const response = await get(server.port, '/api/ui/review/diff', server.token);
        return uiReviewDiffResponseSchema.parse(await response.json()).diff.diffId;
    }

    it('moves the review to the next iteration on fixture-medium', async () => {
        const server = await start('fixture-medium');
        expect(await diffIdOf(server)).toBe(MEDIUM_DIFF_ID);

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiReviewWriteAckSchema.parse(await response.json())).toEqual({ acknowledged: true });
        expect(await diffIdOf(server)).toBe(MEDIUM_DIFF_ID_V2);
    });

    it('reaches the end of the fixture on the second attempt on fixture-small', async () => {
        const server = await start('fixture-small');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );

        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
    });

    it('does not register this route for a prKey from another host', async () => {
        const server = await start('plain-4821');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );

        expect(response.status).toBe(404);
    });

    it('protects the dev endpoint with the same token as UI endpoints', async () => {
        const server = await start('fixture-medium');

        const response = await postJson(server.port, UI_DEV_ENDPOINTS.fixtureAdvanceIteration, {});

        expect(response.status).toBe(401);
        expect(await diffIdOf(server)).toBe(MEDIUM_DIFF_ID);
    });
});
