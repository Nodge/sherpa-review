import type { WorkerStatus } from '@sherpa/protocol';
import { WORKER_DEAD_AFTER_SECONDS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { RpcFailure } from './errors.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { WORKER_GAP_GRACE_SECONDS, WorkerRegistry } from './worker-registry.js';

const START = new Date('2026-08-19T12:00:00.000Z');

describe('worker lifecycle', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let offsetMs: number;
    /** Real time at which the test clock starts running on its own. null means the clock is stopped. */
    let runningSince: number | null;
    let registry: WorkerRegistry;
    let events: WorkerStatus[];
    /** Worker lease expiry, the same read-only value the queue exposes to the registry. */
    let leaseExpiries: Map<string, string>;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(`${sherpaDir}/worker.db`);
        offsetMs = 0;
        runningSince = null;
        leaseExpiries = new Map();
        registry = createRegistry();
        events = [];
        registry.subscribe((status) => events.push(status));
    });

    afterEach(async () => {
        registry.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function now(): Date {
        return new Date(START.getTime() + offsetMs + (runningSince === null ? 0 : Date.now() - runningSince));
    }

    function createRegistry(gapGraceSeconds?: number): WorkerRegistry {
        return new WorkerRegistry({
            db,
            now,
            leaseExpiryOf: (workerId) => leaseExpiries.get(workerId) ?? null,
            ...(gapGraceSeconds === undefined ? {} : { gapGraceSeconds }),
        });
    }

    /** The worker claimed a task: its lease expires in `seconds` and does not renew itself. */
    function leaseFor(workerId: string, seconds: number): void {
        leaseExpiries.set(workerId, new Date(now().getTime() + seconds * 1000).toISOString());
    }

    function advanceSeconds(seconds: number): void {
        offsetMs += seconds * 1000;
    }

    /** Starts the test clock in sync with real time: needed to test the death timer itself. */
    function startClock(): void {
        runningSince = Date.now();
    }

    function failureOf(run: () => unknown): RpcFailure {
        try {
            run();
        } catch (error) {
            if (error instanceof RpcFailure) {
                return error;
            }
            throw error;
        }
        throw new Error('expected RpcFailure, but the call succeeded');
    }

    describe('registration', () => {
        it('status is never before the first session', () => {
            expect(registry.status()).toEqual({ kind: 'never' });
            expect(events).toEqual([]);
        });

        it('register claims an empty slot and announces the connection', () => {
            registry.register('w-1', 'claude-code');

            expect(registry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-1',
                harness: 'claude-code',
                registeredAt: START.toISOString(),
            });
            expect(events).toHaveLength(1);
            expect(events[0]?.kind).toBe('connected');
        });

        it('repeated register from the same session renews it without a new registration', () => {
            registry.register('w-1', 'claude-code', 'claude-opus-5');
            advanceSeconds(60);
            registry.register('w-1');

            const status = registry.status();
            expect(status).toMatchObject({
                kind: 'connected',
                workerId: 'w-1',
                // Keeps the harness and model from the previous registration, and preserves the session start time.
                harness: 'claude-code',
                model: 'claude-opus-5',
                registeredAt: START.toISOString(),
            });
            expect(status.kind === 'connected' && status.lastSeenAt).toBe(
                new Date(START.getTime() + 60_000).toISOString(),
            );
            expect(events).toHaveLength(1);
        });

        it('announces the model with the harness and updates it on renewal', () => {
            registry.register('w-1', 'claude-code');
            expect(registry.status()).not.toHaveProperty('model');

            registry.register('w-1', 'claude-code', 'claude-opus-5');
            expect(registry.status()).toMatchObject({ harness: 'claude-code', model: 'claude-opus-5' });

            registry.register('w-1', 'claude-code', 'claude-sonnet-5');
            expect(registry.status()).toMatchObject({ model: 'claude-sonnet-5' });
        });

        it('fresh registration takes the slot from a live session and returns the evicted workerId', () => {
            registry.register('w-1', 'claude-code');
            advanceSeconds(1);

            // The previous session is still alive but yields anyway: the new session always wins.
            expect(registry.register('w-2', 'codex')).toBe('w-1');

            expect(registry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-2',
                harness: 'codex',
                registeredAt: new Date(START.getTime() + 1000).toISOString(),
            });
            expect(events.map((event) => event.kind)).toEqual(['connected', 'connected']);
        });

        it('evicted session connections do not affect the lifetime of the new owner', () => {
            registry.register('w-1');
            // The previous session is in long-poll: its connection is open during takeover.
            const closeOld = registry.holdConnection('w-1');

            expect(registry.register('w-2')).toBe('w-1');
            // ...and closes after it.
            closeOld();

            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-2' });
            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('a new session claims the slot after the old one dies and returns the evicted workerId', () => {
            expect(registry.register('w-1', 'claude-code')).toBeNull();
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            // The caller uses the evicted id to return leases of the dead session to the queue.
            expect(registry.register('w-2', 'codex')).toBe('w-1');

            expect(registry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-2',
                harness: 'codex',
                registeredAt: new Date(START.getTime() + (WORKER_DEAD_AFTER_SECONDS + 1) * 1000).toISOString(),
            });
            expect(events.map((event) => event.kind)).toEqual(['connected', 'connected']);
        });
    });

    describe('heartbeat', () => {
        it('calls extend liveness, a pause longer than the grace period kills the session', () => {
            registry.register('w-1');

            // Without an open connection or a lease, a session lives only for the gap between calls.
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            registry.touch('w-1');
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('a session without register claims a free slot itself', () => {
            expect(registry.touch('w-1')).toBeNull();

            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-1' });
            expect(events.map((event) => event.kind)).toEqual(['connected']);
        });

        it('heartbeat taking a slot from a dead session returns its workerId', () => {
            registry.register('w-1', 'claude-code', 'claude-opus-5');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            expect(registry.touch('w-2')).toBe('w-1');
            const status = registry.status();
            expect(status).toMatchObject({ kind: 'connected', workerId: 'w-2' });
            // The previous session's harness and model have nothing to do with the new one.
            expect(status).not.toHaveProperty('harness');
            expect(status).not.toHaveProperty('model');
        });

        it('heartbeat from another worker with a live owner returns worker_conflict', () => {
            registry.register('w-1');

            const failure = failureOf(() => {
                registry.touch('w-2');
            });
            expect(failure.code).toBe('worker_conflict');
            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-1' });
        });

        it('heartbeat does not produce a stream of events', () => {
            registry.register('w-1');
            advanceSeconds(10);
            registry.touch('w-1');
            advanceSeconds(10);
            registry.touch('w-1');

            expect(events).toHaveLength(1);
        });
    });

    describe('slot ownership', () => {
        it('allows the owner and an empty slot, rejects a different live owner', () => {
            expect(() => {
                registry.assertOwner('w-1');
            }).not.toThrow();

            registry.register('w-1');
            expect(() => {
                registry.assertOwner('w-1');
            }).not.toThrow();
            const failure = failureOf(() => {
                registry.assertOwner('w-2');
            });
            expect(failure.code).toBe('worker_conflict');
        });

        it('a dead owner does not block access', () => {
            registry.register('w-1');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            expect(() => {
                registry.assertOwner('w-2');
            }).not.toThrow();
        });
    });

    describe('connection-based liveness', () => {
        it('an open worker connection keeps the session alive indefinitely', () => {
            registry.register('w-1');
            registry.holdConnection('w-1');

            advanceSeconds(WORKER_DEAD_AFTER_SECONDS * 10);

            expect(registry.status().kind).toBe('connected');
            expect(events.map((event) => event.kind)).toEqual(['connected']);
        });

        it('a broken connection without a lease kills the session after the grace period', () => {
            registry.register('w-1');
            const close = registry.holdConnection('w-1');
            advanceSeconds(600);

            close();
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);
            // The countdown starts when the connection closes, not at the last call: minutes passed between them.
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('a broken connection with a lease keeps the session alive until the overall death deadline', () => {
            registry.register('w-1');
            // The lease lasts longer than the silence timeout, so the timeout expires first.
            leaseFor('w-1', WORKER_DEAD_AFTER_SECONDS * 2);
            registry.holdConnection('w-1')();

            advanceSeconds(WORKER_DEAD_AFTER_SECONDS - 1);
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('an expired lease does not keep the session alive: work ends with the lease', () => {
            registry.register('w-1');
            // The lease expires before the silence timeout, leaving only the gap grace period,
            // which has long since expired by then.
            leaseFor('w-1', WORKER_DEAD_AFTER_SECONDS / 2);
            registry.holdConnection('w-1')();

            advanceSeconds(WORKER_DEAD_AFTER_SECONDS / 2 - 1);
            expect(registry.status().kind).toBe('connected');

            advanceSeconds(2);
            expect(registry.status().kind).toBe('disconnected');
        });

        it('a new connection cancels the grace period countdown', () => {
            registry.register('w-1');
            registry.holdConnection('w-1')();
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 1);

            registry.holdConnection('w-1');
            advanceSeconds(WORKER_GAP_GRACE_SECONDS * 10);

            expect(registry.status().kind).toBe('connected');
            expect(events.map((event) => event.kind)).toEqual(['connected']);
        });

        it('a connection from another worker does not keep the slot owner alive', () => {
            registry.register('w-1');
            registry.holdConnection('w-2');

            advanceSeconds(WORKER_GAP_GRACE_SECONDS + 1);

            expect(registry.status()).toMatchObject({ kind: 'disconnected', workerId: 'w-1' });
        });

        it('timer announces disconnection after a broken connection without incoming requests', async () => {
            registry.close();
            registry = createRegistry(0.15);
            events = [];
            registry.subscribe((status) => events.push(status));

            startClock();
            registry.register('w-1');
            const close = registry.holdConnection('w-1');
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(events.map((event) => event.kind)).toEqual(['connected']);

            close();
            await new Promise((resolve) => setTimeout(resolve, 300));

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });

        it('sets the death timer to lease expiry, not the overall silence timeout', async () => {
            registry.close();
            registry = createRegistry(0.15);
            events = [];
            registry.subscribe((status) => events.push(status));

            startClock();
            registry.register('w-1');
            // `progress` advances the last call time but not lease expiry, so the lease can expire
            // well before 6 minutes of silence. The event must arrive when the lease expires.
            leaseFor('w-1', 0.2);
            registry.holdConnection('w-1')();

            await new Promise((resolve) => setTimeout(resolve, 400));

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });
    });

    describe('events', () => {
        it('checkNow announces disconnection of a silent session', () => {
            registry.register('w-1', 'claude-code');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            registry.checkNow();
            registry.checkNow();

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
            expect(events[1]).toMatchObject({ workerId: 'w-1', harness: 'claude-code' });
        });

        it('timer announces disconnection without incoming requests', async () => {
            registry.register('w-1');
            // Leave 80 ms until the death deadline and rearm the timer for the shifted clock,
            // which runs in sync with real time from this point.
            advanceSeconds(WORKER_GAP_GRACE_SECONDS - 0.08);
            startClock();
            registry.checkNow();
            expect(events.map((event) => event.kind)).toEqual(['connected']);

            await new Promise((resolve) => setTimeout(resolve, 300));

            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });

        it('unsubscribing stops receiving events', () => {
            const seen: WorkerStatus[] = [];
            const unsubscribe = registry.subscribe((status) => seen.push(status));

            registry.register('w-1');
            unsubscribe();
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);
            registry.checkNow();

            expect(seen.map((status) => status.kind)).toEqual(['connected']);
            expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected']);
        });
    });

    it('status survives a server restart: the slot is in storage', () => {
        registry.register('w-1', 'claude-code', 'claude-opus-5');
        registry.close();

        const restarted = new WorkerRegistry({ db, now: () => new Date(START.getTime() + offsetMs) });
        try {
            expect(restarted.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-1',
                harness: 'claude-code',
                model: 'claude-opus-5',
            });
        } finally {
            restarted.close();
        }
    });
});
