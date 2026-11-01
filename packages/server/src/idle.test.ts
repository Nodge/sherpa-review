import { setTimeout as delay } from 'node:timers/promises';

import { PROTOCOL_VERSION, UI_ENDPOINTS, WORKER_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_IDLE_SECONDS, formatIdlePeriod, IdleWatch, readIdleSeconds } from './idle.js';
import { readManifest } from './manifest.js';
import { manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'pr-24680';

/** Live server threshold for integration checks: fractions of a second instead of a quarter hour. */
const SHORT_IDLE_SECONDS = 0.3;
/** Deliberately exceeds the threshold and several check ticks. */
const OVER_IDLE_MS = 900;
const WAIT_TIMEOUT_MS = 5000;

/** Controlled clock, using the same approach as queue and worker registry tests. */
function makeClock(): { now: () => Date; advance: (seconds: number) => void } {
    let current = Date.parse('2026-08-20T10:00:00.000Z');
    return {
        now: () => new Date(current),
        advance: (seconds) => {
            current += seconds * 1000;
        },
    };
}

describe('IdleWatch', () => {
    it('stops the server when the idle threshold is exceeded', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: DEFAULT_IDLE_SECONDS, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(DEFAULT_IDLE_SECONDS - 1);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        clock.advance(2);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('stops exactly once', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(600);
        watch.checkNow();
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('an open connection keeps the server alive indefinitely', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        const closed = watch.open();
        clock.advance(3600);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        // The countdown starts when the connection closes, not when it opens.
        closed();
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        clock.advance(61);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('a second connection keeps the server alive after the first closes', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        const first = watch.open();
        const second = watch.open();
        first();
        first();

        clock.advance(600);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        second();
        clock.advance(61);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('an incoming request resets the countdown', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(59);
        watch.open()();
        clock.advance(59);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();

        clock.advance(2);
        watch.checkNow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('a zero threshold disables automatic shutdown', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 0, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);

        clock.advance(86_400);
        watch.checkNow();
        expect(watch.enabled).toBe(false);
        expect(stop).not.toHaveBeenCalled();
    });

    it('does not stop after close()', () => {
        const clock = makeClock();
        const watch = new IdleWatch({ idleSeconds: 60, now: clock.now });
        const stop = vi.fn();
        watch.arm(stop);
        watch.close();

        clock.advance(600);
        watch.checkNow();
        expect(stop).not.toHaveBeenCalled();
    });
});

describe('readIdleSeconds', () => {
    it('defaults to a quarter hour when the variable is absent', () => {
        expect(readIdleSeconds({})).toBe(DEFAULT_IDLE_SECONDS);
        expect(DEFAULT_IDLE_SECONDS).toBe(900);
    });

    it('reads a number from the environment', () => {
        expect(readIdleSeconds({ SHERPA_IDLE_SECONDS: '2' })).toBe(2);
        expect(readIdleSeconds({ SHERPA_IDLE_SECONDS: '0' })).toBe(0);
    });

    it('invalid input, an empty value and a negative number use the default', () => {
        for (const raw of ['', '   ', 'soon', '-5', 'NaN']) {
            expect(readIdleSeconds({ SHERPA_IDLE_SECONDS: raw }), raw).toBe(DEFAULT_IDLE_SECONDS);
        }
    });
});

describe('formatIdlePeriod', () => {
    it('whole minutes use minutes, other values use seconds', () => {
        expect(formatIdlePeriod(900)).toBe('15 min');
        expect(formatIdlePeriod(60)).toBe('1 min');
        expect(formatIdlePeriod(2)).toBe('2 s');
        expect(formatIdlePeriod(90)).toBe('90 s');
    });
});

describe('server idle shutdown', () => {
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

    async function start(longPollSeconds?: number): Promise<SherpaServer> {
        // The review host is irrelevant here, and live hosts are forbidden in tests (docs/testing.md).
        const base = {
            prKey: PR_KEY,
            sherpaDir,
            idleSeconds: SHORT_IDLE_SECONDS,
            hosts: [],
            updateChannel: null,
            feedbackChannel: null,
        };
        const server = await startServer(
            longPollSeconds === undefined ? base : { ...base, longPollSeconds },
        );
        servers.push(server);
        return server;
    }

    function manifestOfPr(): Promise<unknown> {
        return readManifest(manifestPathFor(sherpaDir, PR_KEY));
    }

    it('shuts itself down and removes its manifest', async () => {
        const server = await start();
        expect(await manifestOfPr()).not.toBeNull();

        await waitFor(async () => (await manifestOfPr()) === null);
        // A released port means the server has fully shut down, beyond just removing the manifest.
        await expect(fetch(`http://127.0.0.1:${String(server.port)}/healthz`)).rejects.toThrow();
    });

    it('an open SSE channel keeps the server alive', async () => {
        const server = await start();
        const abort = new AbortController();
        const events = await fetch(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            { signal: abort.signal },
        );
        expect(events.status).toBe(200);
        // Drain the body, otherwise the disconnect from abort() surfaces as an unread stream error.
        void events.text().catch(() => undefined);

        await delay(OVER_IDLE_MS);
        expect(await manifestOfPr()).not.toBeNull();

        // Closing the tab restarts the countdown and the server shuts down.
        abort.abort();
        await waitFor(async () => (await manifestOfPr()) === null);
    });

    it('a pending long-poll `worker next` keeps the server alive', async () => {
        const server = await start(1.5);
        const pending = postJson(
            server.port,
            WORKER_ENDPOINTS.next,
            { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.0.0', workerId: 'session-in-loop' },
            server.token,
        );

        await delay(OVER_IDLE_MS);
        expect(await manifestOfPr()).not.toBeNull();

        const response = await pending;
        expect(response.status).toBe(200);
        await waitFor(async () => (await manifestOfPr()) === null);
    });

    it('requests delay shutdown', async () => {
        const server = await start();

        // Each gap must stay well under the threshold even on a loaded CI runner, where a fetch alone can take
        // tens of milliseconds. The total span is measured, not derived from the gap count.
        const started = Date.now();
        for (let attempt = 0; Date.now() - started < OVER_IDLE_MS; attempt += 1) {
            await delay((SHORT_IDLE_SECONDS * 1000) / 6);
            const health = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`, {
                headers: { authorization: `Bearer ${server.token}` },
            });
            expect(health.status, `request ${String(attempt)}`).toBe(200);
        }

        await waitFor(async () => (await manifestOfPr()) === null);
    });

    it('does not shut down with a zero threshold', async () => {
        const server = await startServer({ updateChannel: null, feedbackChannel: null, prKey: PR_KEY, sherpaDir, idleSeconds: 0, hosts: [] });
        servers.push(server);

        await delay(OVER_IDLE_MS);
        expect(await manifestOfPr()).not.toBeNull();
    });
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await condition()) {
            return;
        }
        await delay(25);
    }
    throw new Error('condition was not met within the allotted time');
}
