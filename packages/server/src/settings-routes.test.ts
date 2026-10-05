import type { UiSettings } from '@sherpa/protocol';
import { UI_ENDPOINTS, rpcErrorSchema, uiSettingsResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, patchJson, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'github-quillmart--quillmart--4242';
const OTHER_PR_KEY = 'github-quillmart--quillmart--4343';

describe('global UI settings endpoint', () => {
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

    /** No review host is provided on purpose. Settings must work on a server without one. */
    async function start(prKey = PR_KEY): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => null,
            feedback: { env: {} },
        });
        servers.push(server);
        return server;
    }

    async function readSettings(server: SherpaServer): Promise<UiSettings> {
        const response = await get(server.port, UI_ENDPOINTS.settings, server.token);
        expect(response.status).toBe(200);
        return uiSettingsResponseSchema.parse(await response.json()).settings;
    }

    it('returns defaults when there is no file', async () => {
        const server = await start();

        expect(await readSettings(server)).toEqual({
            diffMode: 'unified',
            shipMode: 'ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('patching one field returns the full set without changing adjacent fields', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { shipMode: 'sticky_ship' }, server.token);

        const response = await patchJson(server.port, UI_ENDPOINTS.settings, { diffMode: 'split' }, server.token);

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'auto',
            
            textSize: 'm',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
        expect(await readSettings(server)).toMatchObject({ diffMode: 'split', shipMode: 'sticky_ship' });
    });

    it.each([
        ['dark', false], ['light', false], ['auto', false],
        ['dark', true], ['light', true], ['auto', true],
    ] as const)('theme %s is readable by another server', async (theme) => {
        const first = await start();

        const response = await patchJson(first.port, UI_ENDPOINTS.settings, { theme }, first.token);

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toMatchObject({ theme });
        expect(await readSettings(first)).toMatchObject({ theme });

        const second = await start(OTHER_PR_KEY);
        expect(await readSettings(second)).toMatchObject({ theme });
    });

    
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { theme: 'light' }, server.token);
        
        

        await patchJson(server.port, UI_ENDPOINTS.settings, { theme: 'auto' }, server.token);
        expect(await readSettings(server)).toMatchObject({ theme: 'auto' });

        
        
    });

    it.each([{ theme: 'invalid-theme' }])('rejects an invalid new selection: %j', async (patch) => {
        const server = await start();
        const response = await patchJson(server.port, UI_ENDPOINTS.settings, patch, server.token);

        expect(response.status).toBe(400);
        
    });

    it('replaces a nested patch object in full without changing the language', async () => {
        const server = await start();

        const response = await patchJson(
            server.port,
            UI_ENDPOINTS.settings,
            { onboarding: { completedAt: null, step: 3 } },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiSettingsResponseSchema.parse(await response.json()).settings).toMatchObject({
            onboarding: { completedAt: null, step: 3 },
            locale: 'auto',
            theme: 'auto',
            
            textSize: 'm',
        });
    });

    it('a language patch does not reset onboarding', async () => {
        const server = await start();
        await patchJson(server.port, UI_ENDPOINTS.settings, { onboarding: { completedAt: null, step: 3 } }, server.token);

        await patchJson(server.port, UI_ENDPOINTS.settings, { locale: 'en' }, server.token);

        expect(await readSettings(server)).toMatchObject({ locale: 'en', onboarding: { completedAt: null, step: 3 } });
    });

    it('another PR server sees the same settings', async () => {
        const first = await start();
        const second = await start(OTHER_PR_KEY);

        await patchJson(first.port, UI_ENDPOINTS.settings, { diffMode: 'split' }, first.token);
        await patchJson(second.port, UI_ENDPOINTS.settings, { shipMode: 'sticky_ship' }, second.token);

        expect(await readSettings(first)).toMatchObject({ diffMode: 'split', shipMode: 'sticky_ship' });
    });

    it('returns bad_request for an invalid value', async () => {
        const server = await start();

        const response = await patchJson(server.port, UI_ENDPOINTS.settings, { diffMode: 'three-way' }, server.token);

        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
        expect(await readSettings(server)).toMatchObject({ diffMode: 'unified' });
    });

    it('does not respond without a token', async () => {
        const server = await start();

        expect((await get(server.port, UI_ENDPOINTS.settings)).status).toBe(401);
        expect((await patchJson(server.port, UI_ENDPOINTS.settings, { diffMode: 'split' })).status).toBe(401);
    });
});
