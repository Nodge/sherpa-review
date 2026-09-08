import type { UiTask, WorkerStatus } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';

/**
 * Agent pill (docs/design/SPEC-elements.md §2.2): four states based on actual
 * worker status.
 * Compute it outside the component so unit tests and the state gallery can use it.
 */

export type AgentTone = 'connected' | 'working' | 'failed' | 'disconnected';

export interface AgentPillView {
    readonly tone: AgentTone;
    readonly workerKind: WorkerStatus['kind'];
    readonly label: string;
    /** Tooltip: harness, model, session age and queue length (docs/design/SPEC-elements.md §2.2). */
    readonly title: string;
}

/**
 * A running or queued task is work the agent still needs to do. A cancelled task
 * still held by the worker counts too, since the worker remains busy until it responds.
 */
function isPending(task: UiTask): boolean {
    return task.status === 'queued' || task.heldByWorker;
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

export function agentPillView(worker: WorkerStatus, tasks: readonly UiTask[], t: Translate): AgentPillView {
    const pending = tasks.filter(isPending);

    if (worker.kind !== 'connected') {
        return {
            tone: 'disconnected',
            workerKind: worker.kind,
            label: t('agent.disconnected'),
            title:
                worker.kind === 'never'
                    ? t('agent.neverConnected')
                    : t('agent.notResponding', identity(worker), pending.length),
        };
    }

    // Session uptime uses server data instead of the browser clock, so the pill remains
    // a pure function of state, with the same rendering in the gallery and tests.
    const uptime = formatUptime(Date.parse(worker.lastSeenAt) - Date.parse(worker.registeredAt), t);
    const title = t('agent.uptime', identity(worker), uptime, pending.length);

    // "Working" means there is work left, regardless of priority class. Route generation runs
    // in the background, but the reviewer waits for it on screen just the same.
    if (pending.length > 0) {
        return {
            tone: 'working',
            workerKind: worker.kind,
            label: t('agent.working', pending.length),
            title,
        };
    }

    if (lastTaskFailed(tasks)) {
        return { tone: 'failed', workerKind: worker.kind, label: t('agent.taskFailed'), title };
    }

    return {
        tone: 'connected',
        workerKind: worker.kind,
        label: t('agent.idle', worker.harness ?? worker.workerId),
        title,
    };
}

/**
 * Worker identity: harness and model are free-form strings, both optional,
 * so the tooltip always includes the session id (docs/design/SPEC-elements.md §2.2).
 */
function identity(worker: Extract<WorkerStatus, { workerId: string }>): string {
    return [
        ...(worker.harness === undefined ? [] : [worker.harness]),
        ...(worker.model === undefined ? [] : [worker.model]),
        worker.workerId,
    ].join(' · ');
}

function formatUptime(ms: number, t: Translate): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 60) {
        return t('agent.uptime.minutes', minutes);
    }

    const hours = Math.floor(minutes / 60);
    return t('agent.uptime.hours', hours, minutes % 60);
}
