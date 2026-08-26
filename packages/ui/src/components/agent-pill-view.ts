import type { UiTask, WorkerStatus } from '@sherpa/protocol';

/**
 * Agent pill (SPEC §2.2): four states based on the actual M0 worker status.
 * Compute it outside the component so unit tests and the state gallery can use it.
 */

export type AgentTone = 'connected' | 'working' | 'failed' | 'disconnected';

export interface AgentPillView {
    readonly tone: AgentTone;
    readonly workerKind: WorkerStatus['kind'];
    readonly label: string;
    /** Tooltip: harness, model, session uptime and queue length (SPEC §2.2). */
    readonly title: string;
}

/** A task in progress or waiting in the queue is work the agent still has to do. */
function isPending(task: UiTask): boolean {
    return task.status === 'queued' || task.status === 'leased';
}

/**
 * "Last task failed" means the failure is newer than the last success. A success resets the state.
 * otherwise one old failure would color the pill for the rest of the session.
 */
function lastTaskFailed(tasks: readonly UiTask[]): boolean {
    const latestOf = (status: UiTask['status']): number =>
        tasks
            .filter((task) => task.status === status)
            .reduce((latest, task) => Math.max(latest, Date.parse(task.updatedAt)), Number.NEGATIVE_INFINITY);

    return latestOf('failed') > latestOf('done');
}

export function agentPillView(worker: WorkerStatus, tasks: readonly UiTask[]): AgentPillView {
    const pending = tasks.filter(isPending);

    if (worker.kind !== 'connected') {
        return {
            tone: 'disconnected',
            workerKind: worker.kind,
            label: 'Agent disconnected',
            title:
                worker.kind === 'never'
                    ? 'The agent has never connected to this PR'
                    : `${identity(worker)} · session not responding · queued: ${String(pending.length)}`,
        };
    }

    // Session uptime uses server data instead of the browser clock, so the pill remains
    // a pure function of state, with the same rendering in the gallery and tests.
    const uptime = formatUptime(Date.parse(worker.lastSeenAt) - Date.parse(worker.registeredAt));
    const title = `${identity(worker)} · session uptime ${uptime} · queued: ${String(pending.length)}`;

    // "Working" means there is work left, regardless of priority class. Route generation runs
    // in the background, but the reviewer waits for it at the screen just the same (M2-T10 decision).
    if (pending.length > 0) {
        return {
            tone: 'working',
            workerKind: worker.kind,
            label: `Agent working · ${String(pending.length)} queued`,
            title,
        };
    }

    if (lastTaskFailed(tasks)) {
        return { tone: 'failed', workerKind: worker.kind, label: 'Agent · task failed', title };
    }

    return {
        tone: 'connected',
        workerKind: worker.kind,
        label: `Agent · ${worker.harness ?? worker.workerId}`,
        title,
    };
}

/**
 * Worker identity: harness and model are free-form strings, both optional,
 * so the session id is always in the tooltip (SPEC §2.2).
 */
function identity(worker: Extract<WorkerStatus, { workerId: string }>): string {
    return [
        ...(worker.harness === undefined ? [] : [worker.harness]),
        ...(worker.model === undefined ? [] : [worker.model]),
        worker.workerId,
    ].join(' · ');
}

function formatUptime(ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 60) {
        return `${String(minutes)} min`;
    }

    const hours = Math.floor(minutes / 60);
    return `${String(hours)} h ${String(minutes % 60)} min`;
}
