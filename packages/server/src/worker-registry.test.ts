import type { WorkerStatus } from '@sherpa/protocol';
import { WORKER_DEAD_AFTER_SECONDS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { RpcFailure } from './errors.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { WorkerRegistry } from './worker-registry.js';

const START = new Date('2026-08-19T12:00:00.000Z');

describe('worker lifecycle', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let offsetMs: number;
    /** Real time at which the test clock starts running on its own. null means the clock is stopped. */
    let runningSince: number | null;
    let registry: WorkerRegistry;
    let events: WorkerStatus[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(`${sherpaDir}/worker.db`);
        offsetMs = 0;
        runningSince = null;
        registry = new WorkerRegistry({
            db,
            now: () => new Date(START.getTime() + offsetMs + (runningSince === null ? 0 : Date.now() - runningSince)),
        });
        events = [];
        registry.subscribe((status) => events.push(status));
    });

    afterEach(async () => {
        registry.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

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
            registry.register('w-1', 'claude-code');
            advanceSeconds(60);
            registry.register('w-1');

            const status = registry.status();
            expect(status).toMatchObject({
                kind: 'connected',
                workerId: 'w-1',
                // The harness from the previous registration stays, and the session start time does not shift.
                harness: 'claude-code',
                registeredAt: START.toISOString(),
            });
            expect(status.kind === 'connected' && status.lastSeenAt).toBe(
                new Date(START.getTime() + 60_000).toISOString(),
            );
            expect(events).toHaveLength(1);
        });

        it('rejects a second live session with a readable message', () => {
            registry.register('w-1', 'claude-code');

            const failure = failureOf(() => {
                registry.register('w-2', 'codex');
            });

            expect(failure.code).toBe('worker_conflict');
            expect(failure.message).toContain('another live session');
            expect(failure.message).toContain('claude-code');
            expect(failure.message).toContain('start the Sherpa skill again');
            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-1' });
            expect(events).toHaveLength(1);
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
        it('calls keep the worker alive and silence past the timeout kills it', () => {
            registry.register('w-1');

            advanceSeconds(WORKER_DEAD_AFTER_SECONDS - 1);
            registry.touch('w-1');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS - 1);
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
            registry.register('w-1');
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS + 1);

            expect(registry.touch('w-2')).toBe('w-1');
            expect(registry.status()).toMatchObject({ kind: 'connected', workerId: 'w-2' });
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
            advanceSeconds(WORKER_DEAD_AFTER_SECONDS - 0.08);
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
        registry.register('w-1', 'claude-code');
        registry.close();

        const restarted = new WorkerRegistry({ db, now: () => new Date(START.getTime() + offsetMs) });
        try {
            expect(restarted.status()).toMatchObject({ kind: 'connected', workerId: 'w-1', harness: 'claude-code' });
        } finally {
            restarted.close();
        }
    });
});
