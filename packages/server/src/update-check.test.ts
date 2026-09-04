import fs from 'node:fs';
import path from 'node:path';

import type { DistributionVersion, UiUpdate } from '@sherpa/protocol';
import { rpcErrorSchema, UI_DEV_ENDPOINTS, UI_ENDPOINTS, uiUpdateCheckResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { SettingsStore } from './settings-store.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';
import type { UpdateCheckOptions, UpdateCheckerOptions } from './update-check.js';
import { classifyInstall, UpdateChecker } from './update-check.js';

/**
 * Check for a new version in main (M5-T9, task breakdown decision 7). Tests forbid network access (brief §7):
 * transport, clock, token and cache file are injected.
 */

const CURRENT = '0.4.0';
const NOW = new Date('2026-09-03T12:00:00.000Z');

const LATEST: DistributionVersion = {
    version: '0.5.0',
    builtFrom: 'a71d4e2',
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: 'Update toast and shortcuts sheet.',
};

describe('version check in main', () => {
    let sherpaDir: string;
    let cacheFile: string;
    /** Lines the check wrote to stderr: a failure must produce exactly one. */
    let lines: string[];
    let restoreStderr: () => void;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        cacheFile = path.join(sherpaDir, 'update-check.json');
        lines = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            lines.push(String(chunk));
            return true;
        });
        restoreStderr = () => {
            spy.mockRestore();
        };
    });

    afterEach(async () => {
        restoreStderr();
        await removeTempSherpaDir(sherpaDir);
    });

    /** `tree/blob` endpoint response: raw file JSON without a `{data}` envelope. */
    function respondWith(payload: unknown, status = 200) {
        return vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status })));
    }

    function makeChecker(overrides: Partial<UpdateCheckerOptions> = {}): UpdateChecker {
        return new UpdateChecker({
            sherpaDir,
            settings: new SettingsStore(sherpaDir),
            currentVersion: CURRENT,
            cacheFile,
            now: () => NOW,
            token: () => Promise.resolve('token'),
            fetch: respondWith(LATEST),
            ...overrides,
        });
    }

    describe('version comparison', () => {
        it('a version newer than the current one reaches state in full', async () => {
            const checker = makeChecker({ installDir: '/opt/sherpa/skill' });

            await checker.force();

            expect(checker.get()).toEqual({
                current: CURRENT,
                latest: '0.5.0',
                releasedAt: LATEST.releasedAt,
                whatsNew: LATEST.whatsNew,
                install: { kind: 'copy', dir: '/opt/sherpa/skill', command: null },
            });
        });

        it('does not treat an older version as an update', async () => {
            const checker = makeChecker({ fetch: respondWith({ ...LATEST, version: '0.3.9' }) });

            expect(await forced(checker)).toBeNull();
        });

        it('does not treat the same version as an update', async () => {
            const checker = makeChecker({ fetch: respondWith({ ...LATEST, version: CURRENT }) });

            expect(await forced(checker)).toBeNull();
        });

        it('compares the minor version as a number, not a string', async () => {
            const checker = makeChecker({
                currentVersion: '0.9.0',
                fetch: respondWith({ ...LATEST, version: '0.10.0' }),
            });

            expect((await forced(checker))?.latest).toBe('0.10.0');
        });
    });

    describe('check failures', () => {
        it('a 401 is handled with a line in stderr', async () => {
            const checker = makeChecker({ fetch: respondWith({ error: 'no' }, 401) });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
            expect(stderrLines()[0]).toContain('401');
        });

        it('handles a request timeout the same way', async () => {
            const timedOut = vi.fn(() =>
                Promise.reject(new DOMException('The operation was aborted.', 'TimeoutError')),
            ) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: timedOut });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
        });

        it('invalid JSON is handled the same way', async () => {
            const broken = vi.fn(() =>
                Promise.resolve(new Response('{ not json', { status: 200 })),
            ) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: broken });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
        });

        it('a response outside the schema is handled the same way', async () => {
            const checker = makeChecker({ fetch: respondWith({ version: 'the-day-before-yesterday' }) });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
        });

        it('a failed recheck preserves an already known version', async () => {
            const transport = vi
                .fn()
                .mockResolvedValueOnce(new Response(JSON.stringify(LATEST)))
                .mockResolvedValueOnce(new Response('{}', { status: 401 })) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: transport });
            await checker.force();

            const second = await checker.force();

            expect(second.failure).toContain('401');
            expect(second.update?.latest).toBe('0.5.0');
            // The failure must also stay out of the cache, or restarts would stay silent for half an hour too.
            expect(readCache()).toEqual({ checkedAt: NOW.toISOString(), latest: LATEST });
        });

        it('makes no network calls without a token', async () => {
            const transport = respondWith(LATEST);
            const checker = makeChecker({
                token: () => Promise.reject(new Error('no access token')),
                fetch: transport,
            });

            expect(await forced(checker)).toBeNull();
            expect(transport).not.toHaveBeenCalled();
            expect(stderrLines()).toHaveLength(1);
        });
    });

    describe('cache', () => {
        it('reads a fresh cache from disk without network calls', async () => {
            writeCache({ checkedAt: '2026-09-03T11:45:00.000Z', latest: LATEST });
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            checker.start();
            await Promise.resolve();

            expect(checker.get()?.latest).toBe('0.5.0');
            expect(transport).not.toHaveBeenCalled();
        });

        it('an expired cache triggers a request to main', async () => {
            writeCache({ checkedAt: '2026-09-03T11:00:00.000Z', latest: null });
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            // Use `start()`, not `force()`: force always ignores TTL, so it does not test expiration.
            checker.start();
            await vi.waitFor(() => {
                expect(checker.get()?.latest).toBe('0.5.0');
            });

            expect(transport).toHaveBeenCalledTimes(1);
            expect(readCache()).toEqual({ checkedAt: NOW.toISOString(), latest: LATEST });
        });

        it('treats a corrupt cache as missing', async () => {
            fs.writeFileSync(cacheFile, '{ fragment');
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            checker.start();
            await Promise.resolve();
            await Promise.resolve();

            expect(transport).toHaveBeenCalledTimes(1);
        });

        it('force ignores a fresh cache', async () => {
            writeCache({ checkedAt: NOW.toISOString(), latest: null });
            const transport = respondWith(LATEST);
            const checker = makeChecker({ fetch: transport });

            expect((await forced(checker))?.latest).toBe('0.5.0');
            expect(transport).toHaveBeenCalledTimes(1);
        });

        it('never checks the 0.0.0 dev build', async () => {
            const transport = respondWith(LATEST);
            const checker = makeChecker({ currentVersion: '0.0.0', fetch: transport });

            checker.start();
            expect(await forced(checker)).toBeNull();
            expect(transport).not.toHaveBeenCalled();
        });

        it('disabled checks on a fixture host make no network calls', async () => {
            const transport = respondWith(LATEST);
            const checker = makeChecker({ enabled: false, fetch: transport });

            checker.start();
            await checker.force();

            expect(transport).not.toHaveBeenCalled();
        });
    });

    describe('concurrent checks', () => {
        it('a late response does not overwrite the result of a newer check', async () => {
            const pending: ((payload: unknown) => void)[] = [];
            const transport = vi.fn(
                () =>
                    new Promise((resolve) => {
                        pending.push((payload) => {
                            resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
                        });
                    }),
            ) as unknown as typeof fetch;
            const checker = makeChecker({ fetch: transport });

            checker.start();
            await vi.waitFor(() => {
                expect(pending).toHaveLength(1);
            });
            const forcing = checker.force();
            await vi.waitFor(() => {
                expect(pending).toHaveLength(2);
            });
            pending[1]?.(LATEST);
            expect((await forcing).update?.latest).toBe('0.5.0');
            // The request from `start()` responds last with an older version.
            pending[0]?.({ ...LATEST, version: '0.4.5' });
            await flush();

            expect(checker.get()?.latest).toBe('0.5.0');
            expect(readCache()).toEqual({ checkedAt: NOW.toISOString(), latest: LATEST });
        });
    });

    describe('dismissed version', () => {
        it('"do not remind me about this version" hides the update', async () => {
            const settings = new SettingsStore(sherpaDir);
            const checker = makeChecker({ settings });
            await checker.force();

            settings.patch({ updates: { dismissedVersion: '0.5.0' } });

            expect(checker.get()).toBeNull();
        });

        it('shows this version when a different version was dismissed', async () => {
            const settings = new SettingsStore(sherpaDir);
            settings.patch({ updates: { dismissedVersion: '0.4.5' } });
            const checker = makeChecker({ settings });

            expect((await forced(checker))?.latest).toBe('0.5.0');
        });
    });

    describe('install classification', () => {
        it('a directory in a repository checkout gives git pull at the repository root', () => {
            expect(classifyInstall('/Users/x/quillmart/tools/sherpa/skill')).toEqual({
                
                dir: '/Users/x/quillmart',
                command: "cd '/Users/x/quillmart' && git pull",
            });
        });

        it('a space in the path does not break the terminal command', () => {
            expect(classifyInstall('/Users/x/My Work/tools/sherpa/skill').command).toBe(
                "cd '/Users/x/My Work' && git pull",
            );
        });

        it('a directory anywhere else is a copy without a command', () => {
            expect(classifyInstall('/opt/sherpa')).toEqual({ kind: 'copy', dir: '/opt/sherpa', command: null });
        });

        it('an unspecified directory is a copy in the server cwd', () => {
            expect(classifyInstall()).toEqual({ kind: 'copy', dir: process.cwd(), command: null });
        });
    });

    /** Force also returns a failure indicator. Most checks only need `update` itself. */
    async function forced(checker: UpdateChecker): Promise<UiUpdate | null> {
        return (await checker.force()).update;
    }

    /** Lets the unawaited check promise chain finish. */
    async function flush(): Promise<void> {
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }

    function stderrLines(): readonly string[] {
        return lines;
    }

    function writeCache(cache: unknown): void {
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
    }

    function readCache(): unknown {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
});

describe('version check endpoints', () => {
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

    async function start(prKey: string, updateCheck?: UpdateCheckOptions): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            ...(updateCheck === undefined ? {} : { updateCheck }),
        });
        servers.push(server);
        return server;
    }

    it('a forced check on a fixture host returns the contract without network calls', async () => {
        const server = await start('fixture-medium');

        const response = await postJson(server.port, UI_ENDPOINTS.updateCheck, {}, server.token);

        expect(response.status).toBe(200);
        expect(uiUpdateCheckResponseSchema.parse(await response.json())).toEqual({ update: null });
    });

    it('a failed check returns an error instead of "no updates"', async () => {
        const server = await start('github-quillmart--quillmart--4821', {
            currentVersion: CURRENT,
            cacheFile: path.join(sherpaDir, 'update-check.json'),
            token: () => Promise.resolve('token'),
            fetch: (() => Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof fetch,
        });

        const response = await postJson(server.port, UI_ENDPOINTS.updateCheck, {}, server.token);

        expect(response.status).toBe(502);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('host_unavailable');
    });

    it('the dev endpoint supplies a version to the fixture server', async () => {
        const server = await start('fixture-medium');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.updateAvailable,
            { version: '9.9.9', releasedAt: LATEST.releasedAt, whatsNew: LATEST.whatsNew },
            server.token,
        );

        expect(response.status).toBe(200);
        const { update } = uiUpdateCheckResponseSchema.parse(await response.json());
        expect(update?.latest).toBe('9.9.9');
        expect(update?.whatsNew).toBe(LATEST.whatsNew);
    });

    it('the dev endpoint is absent for a hosted prKey', async () => {
        const server = await start('github-quillmart--quillmart--4821');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.updateAvailable,
            { version: '9.9.9', releasedAt: null, whatsNew: null },
            server.token,
        );

        expect(response.status).toBe(404);
    });
});
