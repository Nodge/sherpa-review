import fs from 'node:fs';
import path from 'node:path';

import type { DistributionVersion, UiUpdate, UiUpdateInstall } from '@sherpa/protocol';
import { rpcErrorSchema, UI_DEV_ENDPOINTS, UI_ENDPOINTS, uiUpdateCheckResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureHostPlugin } from './hosts/fixture/plugin.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { SettingsStore } from './settings-store.js';
import { makeTempSherpaDir, plainHostPlugin, postJson, removeTempSherpaDir } from './test-support.js';
import type { UpdateChannel, UpdateChannelRequest } from './update-channel.js';
import type { UpdateCheckOptions, UpdateCheckerOptions } from './update-check.js';
import { UpdateChecker } from './update-check.js';

/**
 * New version check through an update channel. Network access is forbidden in tests (docs/testing.md):
 * channel, transport, clock and cache file are injected.
 */

const CURRENT = '0.4.0';
const NOW = new Date('2026-09-03T12:00:00.000Z');

const LATEST: DistributionVersion = {
    version: '0.5.0',
    builtFrom: 'a71d4e2',
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: 'Update toast and shortcuts sheet.',
};

const INSTALL: UiUpdateInstall = { dir: '/opt/sherpa/skill', command: 'update-sherpa', readmeUrl: null };

const CHANNEL_ID = 'fake:sherpa';

type Latest = (request: UpdateChannelRequest) => Promise<DistributionVersion | null>;

/** Stub channel: `latest` returns the test value, `install` echoes the installation directory. */
function fakeChannel(latest: Latest) {
    const spy = vi.fn(latest);
    const channel: UpdateChannel = {
        id: CHANNEL_ID,
        latest: spy,
        install: (installDir) => ({ ...INSTALL, dir: installDir ?? INSTALL.dir }),
    };
    return { channel, latest: spy };
}

function resolving(version: DistributionVersion | null) {
    return fakeChannel(() => Promise.resolve(version));
}

function rejecting(error: unknown) {
    return fakeChannel(() => Promise.reject(error instanceof Error ? error : new Error(String(error))));
}

describe('version check through a channel', () => {
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

    function makeChecker(overrides: Partial<UpdateCheckerOptions> = {}): UpdateChecker {
        return new UpdateChecker({
            sherpaDir,
            settings: new SettingsStore(sherpaDir),
            currentVersion: CURRENT,
            cacheFile,
            now: () => NOW,
            channel: resolving(LATEST).channel,
            ...overrides,
        });
    }

    describe('version comparison', () => {
        it('puts a newer version in state in full, with the hint from the channel', async () => {
            const checker = makeChecker({ installDir: '/srv/sherpa/skill' });

            await checker.force();

            expect(checker.get()).toEqual({
                current: CURRENT,
                latest: '0.5.0',
                releasedAt: LATEST.releasedAt,
                whatsNew: LATEST.whatsNew,
                install: { ...INSTALL, dir: '/srv/sherpa/skill' },
            });
        });

        it('passes the transport and timeout signal to the channel', async () => {
            const transport = vi.fn() as unknown as typeof fetch;
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel, fetch: transport });

            await checker.force();

            expect(latest).toHaveBeenCalledTimes(1);
            const request = latest.mock.calls[0]?.[0];
            expect(request?.fetch).toBe(transport);
            expect(request?.signal).toBeInstanceOf(AbortSignal);
        });

        it('does not treat an older version as an update', async () => {
            const checker = makeChecker({ channel: resolving({ ...LATEST, version: '0.3.9' }).channel });

            expect(await forced(checker)).toBeNull();
        });

        it('does not treat the same version as an update', async () => {
            const checker = makeChecker({ channel: resolving({ ...LATEST, version: CURRENT }).channel });

            expect(await forced(checker)).toBeNull();
        });

        it('compares the minor version as a number, not a string', async () => {
            const checker = makeChecker({
                currentVersion: '0.9.0',
                channel: resolving({ ...LATEST, version: '0.10.0' }).channel,
            });

            expect((await forced(checker))?.latest).toBe('0.10.0');
        });

        it('unknown channel version means no update, without a failure', async () => {
            const checker = makeChecker({ channel: resolving(null).channel });

            const result = await checker.force();

            expect(result).toEqual({ update: null, failure: null });
            expect(stderrLines()).toHaveLength(0);
            expect(readCache()).toEqual({ channel: CHANNEL_ID, checkedAt: NOW.toISOString(), latest: null });
        });
    });

    describe('check failures', () => {
        it('handles a channel error with a line in stderr', async () => {
            const checker = makeChecker({ channel: rejecting(new Error('401 response')).channel });

            const result = await checker.force();

            expect(result.update).toBeNull();
            expect(result.failure).toContain('401');
            expect(stderrLines()).toHaveLength(1);
            expect(stderrLines()[0]).toContain('401');
        });

        it('handles a request timeout the same way', async () => {
            const checker = makeChecker({
                channel: rejecting(new DOMException('The operation was aborted.', 'TimeoutError')).channel,
            });

            expect(await forced(checker)).toBeNull();
            expect(stderrLines()).toHaveLength(1);
        });

        it('a failed recheck preserves an already known version', async () => {
            const { channel, latest } = resolving(LATEST);
            latest.mockResolvedValueOnce(LATEST).mockRejectedValueOnce(new Error('401 response'));
            const checker = makeChecker({ channel });
            await checker.force();

            const second = await checker.force();

            expect(second.failure).toContain('401');
            expect(second.update?.latest).toBe('0.5.0');
            // The failure must also stay out of the cache, or restarts would stay silent for half an hour too.
            expect(readCache()).toEqual({ channel: CHANNEL_ID, checkedAt: NOW.toISOString(), latest: LATEST });
        });
    });

    describe('cache', () => {
        it('reads a fresh cache from disk without asking the channel', async () => {
            writeCache({ channel: CHANNEL_ID, checkedAt: '2026-09-03T11:45:00.000Z', latest: LATEST });
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel });

            checker.start();
            await Promise.resolve();

            expect(checker.get()?.latest).toBe('0.5.0');
            expect(latest).not.toHaveBeenCalled();
        });

        it('asks the channel when the cache is stale', async () => {
            writeCache({ channel: CHANNEL_ID, checkedAt: '2026-09-03T11:00:00.000Z', latest: null });
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel });

            // Use `start()`, not `force()`: force always ignores TTL, so it does not test expiration.
            checker.start();
            await vi.waitFor(() => {
                expect(checker.get()?.latest).toBe('0.5.0');
            });

            expect(latest).toHaveBeenCalledTimes(1);
            expect(readCache()).toEqual({ channel: CHANNEL_ID, checkedAt: NOW.toISOString(), latest: LATEST });
        });

        it('treats a cache from the future as stale', async () => {
            writeCache({ channel: CHANNEL_ID, checkedAt: '2026-09-03T12:10:00.000Z', latest: null });
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel });

            checker.start();
            await vi.waitFor(() => {
                expect(latest).toHaveBeenCalledTimes(1);
            });
        });

        it('treats a corrupt cache as missing', async () => {
            fs.writeFileSync(cacheFile, '{ fragment');
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel });

            checker.start();
            await vi.waitFor(() => {
                expect(latest).toHaveBeenCalledTimes(1);
            });
        });

        it('ignores a fresh cache from another channel: all builds on the machine share the file', async () => {
            writeCache({ channel: 'other:sherpa', checkedAt: '2026-09-03T11:45:00.000Z', latest: { ...LATEST, version: '9.0.0' } });
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel });

            checker.start();
            await vi.waitFor(() => {
                expect(checker.get()?.latest).toBe('0.5.0');
            });

            expect(latest).toHaveBeenCalledTimes(1);
            expect(readCache()).toEqual({ channel: CHANNEL_ID, checkedAt: NOW.toISOString(), latest: LATEST });
        });

        it('asks the channel for a cache without a channel (written before the field existed)', async () => {
            writeCache({ checkedAt: '2026-09-03T11:45:00.000Z', latest: LATEST });
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel });

            checker.start();
            await vi.waitFor(() => {
                expect(latest).toHaveBeenCalledTimes(1);
            });
        });

        it('force ignores a fresh cache', async () => {
            writeCache({ channel: CHANNEL_ID, checkedAt: NOW.toISOString(), latest: null });
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ channel });

            expect((await forced(checker))?.latest).toBe('0.5.0');
            expect(latest).toHaveBeenCalledTimes(1);
        });

        it('never checks the 0.0.0 dev build', async () => {
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ currentVersion: '0.0.0', channel });

            checker.start();
            expect(await forced(checker)).toBeNull();
            expect(latest).not.toHaveBeenCalled();
        });

        it('disabled check (host with disablesUpdateCheck) skips the channel check but takes its hint', async () => {
            const { channel, latest } = resolving(LATEST);
            const checker = makeChecker({ enabled: false, channel, installDir: '/srv/sherpa/skill' });

            checker.start();
            await checker.force();
            const update = checker.setLatest(LATEST);

            expect(latest).not.toHaveBeenCalled();
            expect(update?.install).toEqual({ ...INSTALL, dir: '/srv/sherpa/skill' });
        });

        it('without a channel there is no check and never an update', async () => {
            const checker = makeChecker({ channel: null });
            writeCache({ channel: CHANNEL_ID, checkedAt: NOW.toISOString(), latest: LATEST });

            checker.start();
            expect(await checker.force()).toEqual({ update: null, failure: null });
            expect(checker.setLatest(LATEST)).toBeNull();
            expect(checker.get()).toBeNull();
        });
    });

    describe('concurrent checks', () => {
        it('a late response does not overwrite the result of a newer check', async () => {
            const pending: ((version: DistributionVersion) => void)[] = [];
            const { channel } = fakeChannel(
                () =>
                    new Promise((resolve) => {
                        pending.push(resolve);
                    }),
            );
            const checker = makeChecker({ channel });

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
            // The check from `start()` responds last, with an older version.
            pending[0]?.({ ...LATEST, version: '0.4.5' });
            await flush();

            expect(checker.get()?.latest).toBe('0.5.0');
            expect(readCache()).toEqual({ channel: CHANNEL_ID, checkedAt: NOW.toISOString(), latest: LATEST });
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
    /** Fixture host with a dev version endpoint and a "production" host without one. */
    const HOSTS = [fixtureHostPlugin, plainHostPlugin];

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

    async function start(
        prKey: string,
        updateCheck?: UpdateCheckOptions,
        updateChannel: UpdateChannel = resolving(LATEST).channel,
    ): Promise<SherpaServer> {
        const server = await startServer({
            feedbackChannel: null,
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            hosts: HOSTS,
            updateChannel,
            ...(updateCheck === undefined ? {} : { updateCheck }),
        });
        servers.push(server);
        return server;
    }

    it('force on a fixture host returns the contract without asking the channel', async () => {
        const { channel, latest } = resolving(LATEST);
        const server = await start('fixture-medium', { currentVersion: CURRENT }, channel);

        const response = await postJson(server.port, UI_ENDPOINTS.updateCheck, {}, server.token);

        expect(response.status).toBe(200);
        expect(uiUpdateCheckResponseSchema.parse(await response.json())).toEqual({ update: null });
        expect(latest).not.toHaveBeenCalled();
    });

    it('a failed check returns an error instead of "no updates"', async () => {
        const server = await start(
            'plain-4821',
            { currentVersion: CURRENT, cacheFile: path.join(sherpaDir, 'update-check.json') },
            rejecting(new Error('401 response')).channel,
        );

        const response = await postJson(server.port, UI_ENDPOINTS.updateCheck, {}, server.token);

        expect(response.status).toBe(502);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('host_unavailable');
    });

    it('dev endpoint injects a version into the fixture server, with the hint from the channel', async () => {
        const server = await start('fixture-medium', { installDir: '/srv/sherpa/skill' });

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
        expect(update?.install).toEqual({ ...INSTALL, dir: '/srv/sherpa/skill' });
    });

    it('dev endpoint shows no version on a server without an update channel', async () => {
        const server = await startServer({ updateChannel: null, feedbackChannel: null, prKey: 'fixture-medium', sherpaDir, longPollSeconds: 0.3, hosts: HOSTS });
        servers.push(server);

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.updateAvailable,
            { version: '9.9.9', releasedAt: null, whatsNew: null },
            server.token,
        );

        expect(uiUpdateCheckResponseSchema.parse(await response.json())).toEqual({ update: null });
    });

    it('has no dev endpoint for a non-fixture host prKey', async () => {
        const server = await start('plain-4821');

        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.updateAvailable,
            { version: '9.9.9', releasedAt: null, whatsNew: null },
            server.token,
        );

        expect(response.status).toBe(404);
    });
});
