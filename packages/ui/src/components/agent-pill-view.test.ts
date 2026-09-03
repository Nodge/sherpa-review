import type { UiTask, WorkerStatus } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { agentPillView } from './agent-pill-view.js';
import { createT } from '../i18n/index.js';

const t = createT('en');

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'w-1',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-21T10:30:00.000Z',
    lastSeenAt: '2026-08-21T11:59:00.000Z',
};

function task(overrides: Partial<UiTask> & Pick<UiTask, 'id' | 'status'>): UiTask {
    return {
        type: 'echo',
        priority: 'interactive',
        heldByWorker: overrides.status === 'leased',
        attempt: 1,
        instructions: 'echo',
        progressText: null,
        result: null,
        failReason: null,
        createdAt: '2026-08-21T11:00:00.000Z',
        updatedAt: '2026-08-21T11:00:00.000Z',
        ...overrides,
    };
}

describe('agent pill', () => {
    it('shows the harness in the label when connected and idle', () => {
        const view = agentPillView(CONNECTED, [], t);

        expect(view.tone).toBe('connected');
        expect(view.label).toBe('Agent · claude-code');
    });

    it('uses the worker id in the label when the harness is absent', () => {
        const view = agentPillView({ ...CONNECTED, harness: undefined }, [], t);

        expect(view.label).toBe('Agent · w-1');
    });

    it('shows the working state with a queue count for a queued interactive task', () => {
        const view = agentPillView(
            CONNECTED,
            [
                task({ id: 1, status: 'leased' }),
                task({ id: 2, status: 'queued' }),
                task({ id: 3, status: 'done' }),
            ], t);

        expect(view.tone).toBe('working');
        expect(view.label).toBe('Agent working · 2 in queue');
    });

    it('also shows the agent as working for a background route generation task', () => {
        const view = agentPillView(CONNECTED, [
            task({ id: 1, status: 'leased', type: 'route.skeleton', priority: 'background' }),
        ], t);

        expect(view.tone).toBe('working');
        expect(view.label).toBe('Agent working · 1 in queue');
    });

    it('includes chat tasks in the total work and queue count', () => {
        const view = agentPillView(CONNECTED, [
            task({ id: 1, status: 'leased', type: 'chat' }),
            task({ id: 2, status: 'queued', type: 'chat' }),
        ], t);

        expect(view.label).toBe('Agent working · 2 in queue');
    });

    it('counts a cancelled task as work while the worker holds it', () => {
        const held = task({ id: 1, status: 'cancelled', type: 'chat', heldByWorker: true });

        expect(agentPillView(CONNECTED, [held], t)).toMatchObject({
            tone: 'working',
            label: 'Agent working · 1 in queue',
        });
        // The worker has responded. The task is no longer held, and there is no work left.
        expect(agentPillView(CONNECTED, [{ ...held, heldByWorker: false }], t).tone).toBe('connected');
    });

    it('shows the red state when the last task failed', () => {
        const view = agentPillView(
            CONNECTED,
            [
                task({ id: 1, status: 'done', updatedAt: '2026-08-21T11:00:00.000Z' }),
                task({ id: 2, status: 'failed', updatedAt: '2026-08-21T11:30:00.000Z' }),
            ], t);

        expect(view.tone).toBe('failed');
        expect(view.label).toBe('Agent · last task failed');
    });

    it('resets the state when success is newer than failure', () => {
        const view = agentPillView(
            CONNECTED,
            [
                task({ id: 1, status: 'failed', updatedAt: '2026-08-21T11:00:00.000Z' }),
                task({ id: 2, status: 'done', updatedAt: '2026-08-21T11:30:00.000Z' }),
            ], t);

        expect(view.tone).toBe('connected');
    });

    it('gives a disconnected worker precedence over both a failed task and the queue', () => {
        const view = agentPillView(
            { ...CONNECTED, kind: 'disconnected' },
            [task({ id: 1, status: 'queued' }), task({ id: 2, status: 'failed' })], t);

        expect(view.tone).toBe('disconnected');
        expect(view.label).toBe('Agent disconnected');
        expect(view.title).toContain('in queue: 1');
    });

    it('uses the same state for a worker that never connected without claiming a session in the tooltip', () => {
        const view = agentPillView({ kind: 'never' }, [], t);

        expect(view.tone).toBe('disconnected');
        expect(view.title).toBe('The agent has never connected to this PR');
    });

    it('includes the harness, model, session id, session age and queue length in the tooltip', () => {
        const view = agentPillView(CONNECTED, [task({ id: 1, status: 'queued' })], t);

        expect(view.title).toBe('claude-code · opus-5 · w-1 · session up 1 h 29 min · in queue: 1');
    });
});
