import type { PriorityClass, TaskStatus, UiState, UiTask, WorkerStatus } from '@sherpa/protocol';
import { useState, useSyncExternalStore } from 'react';

import { ApiError, cancelTask, enqueueEchoTask } from './api.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * M0 UI shell: worker status, echo task creation and the queue with results.
 * Handoff states and design tokens start in M1. This only covers the full loop.
 */
export interface AppProps {
    readonly store: Store;
    readonly token: string;
}

export function App({ store, token }: AppProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

    if (snapshot.connection === 'fatal') {
        return (
            <main className="screen screen--message">
                <h1>Sherpa stopped</h1>
                <p>{snapshot.error}</p>
            </main>
        );
    }

    if (snapshot.state === null) {
        return (
            <main className="screen screen--message">
                <h1>Sherpa</h1>
                <p>{snapshot.connection === 'connecting' ? 'Connecting to the server…' : 'Server unavailable, reconnecting…'}</p>
            </main>
        );
    }

    return <Screen state={snapshot.state} connection={snapshot.connection} token={token} />;
}

function Screen({
    state,
    connection,
    token,
}: {
    state: UiState;
    connection: StoreSnapshot['connection'];
    token: string;
}) {
    return (
        <main className="screen">
            <header className="header">
                <WorkerPill worker={state.worker} />
                <span className="header__pr">{state.prKey}</span>
            </header>

            {connection === 'reconnecting' ? (
                <div className="banner banner--warn">
                    <strong>Server unavailable, reconnecting…</strong>
                    <p>This is the last known state. It will update automatically when the connection returns.</p>
                </div>
            ) : null}

            {state.worker.kind === 'disconnected' ? <DisconnectedBanner prKey={state.prKey} /> : null}

            <EnqueueForm token={token} />
            <TaskList tasks={state.tasks} worker={state.worker} token={token} />
        </main>
    );
}

function WorkerPill({ worker }: { worker: WorkerStatus }) {
    return (
        <span className={`pill pill--${worker.kind}`}>
            <span className="pill__dot" aria-hidden="true" />
            {workerLabel(worker)}
        </span>
    );
}

function workerLabel(worker: WorkerStatus): string {
    switch (worker.kind) {
        case 'never':
            return 'Agent has not connected yet';
        case 'connected':
            return `Agent · ${workerIdentity(worker.harness, worker.model, worker.workerId)}`;
        case 'disconnected':
            return 'Agent disconnected';
    }
}

/**
 * Worker identity: harness and model are free-form strings, both optional.
 * Without a harness, workerId remains, otherwise the status has nothing to identify it by.
 */
function workerIdentity(harness: string | undefined, model: string | undefined, workerId: string): string {
    return [harness ?? workerId, ...(model === undefined ? [] : [model])].join(' · ');
}

/** The "Agent disconnected" banner (SPEC §4.4): what happened, its consequence, one action. */
function DisconnectedBanner({ prKey }: { prKey: string }) {
    return (
        <div className="banner banner--offline">
            <strong>Agent disconnected</strong>
            <p>The session stopped responding. Tasks stay queued until the agent returns.</p>
            <p>Run the Sherpa skill again in an agent session. It will register the new session as a worker:</p>
            <CopyCommand command={`sherpa worker register --pr ${prKey}`} />
        </div>
    );
}

function CopyCommand({ command }: { command: string }) {
    const [copied, setCopied] = useState(false);

    const copy = (): void => {
        navigator.clipboard.writeText(command).then(
            () => {
                setCopied(true);
            },
            () => {
                setCopied(false);
            },
        );
    };

    return (
        <p className="command">
            <code>{command}</code>
            <button type="button" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
            </button>
        </p>
    );
}

function EnqueueForm({ token }: { token: string }) {
    const [text, setText] = useState('');
    const [priority, setPriority] = useState<PriorityClass>('interactive');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = (): void => {
        if (pending || text.trim() === '') {
            return;
        }

        setPending(true);
        setError(null);
        enqueueEchoTask(token, text, priority)
            .then(() => {
                setText('');
            })
            .catch((failure: unknown) => {
                setError(messageOf(failure));
            })
            .finally(() => {
                setPending(false);
            });
    };

    return (
        <form
            className="enqueue"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <label className="enqueue__label" htmlFor="echo-text">
                Echo task text
            </label>
            <textarea
                id="echo-text"
                className="enqueue__text"
                value={text}
                rows={3}
                maxLength={4000}
                placeholder="The agent will return this text as the result"
                onChange={(event) => {
                    setText(event.target.value);
                }}
            />
            <div className="enqueue__actions">
                <select
                    className="enqueue__priority"
                    aria-label="Priority"
                    value={priority}
                    onChange={(event) => {
                        setPriority(event.target.value === 'background' ? 'background' : 'interactive');
                    }}
                >
                    <option value="interactive">interactive</option>
                    <option value="background">background</option>
                </select>
                <button type="submit" disabled={pending || text.trim() === ''}>
                    Queue echo task
                </button>
            </div>
            {error === null ? null : <p className="enqueue__error">{error}</p>}
        </form>
    );
}

function TaskList({ tasks, worker, token }: { tasks: readonly UiTask[]; worker: WorkerStatus; token: string }) {
    if (tasks.length === 0) {
        return <p className="tasks__empty">No tasks yet.</p>;
    }

    // Newest first: the server returns the queue in submission order.
    return (
        <ul className="tasks">
            {[...tasks].reverse().map((task) => (
                <li key={task.id}>
                    <TaskCard task={task} worker={worker} token={token} />
                </li>
            ))}
        </ul>
    );
}

function TaskCard({ task, worker, token }: { task: UiTask; worker: WorkerStatus; token: string }) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const cancel = (): void => {
        setPending(true);
        setError(null);
        cancelTask(token, task.id)
            .catch((failure: unknown) => {
                setError(messageOf(failure));
            })
            .finally(() => {
                setPending(false);
            });
    };

    const cancellable = task.status === 'queued' || task.status === 'leased';

    return (
        <article className={`task task--${task.status}`}>
            <header className="task__header">
                <code className="task__id">sherpa/{task.id}</code>
                <span className="task__meta">
                    {task.type} · {task.priority === 'interactive' ? 'interactive' : 'background'}
                </span>
                <span className="task__status">{statusLabel(task.status)}</span>
                {task.attempt > 1 ? <span className="task__meta">attempt {task.attempt}</span> : null}
                {cancellable ? (
                    <button type="button" onClick={cancel} disabled={pending}>
                        Cancel
                    </button>
                ) : null}
            </header>

            {task.status === 'leased' ? <LeasedDetails task={task} worker={worker} /> : null}

            {task.result === null ? null : (
                <details className="task__result">
                    <summary>Result</summary>
                    <pre>{task.result}</pre>
                </details>
            )}

            {task.failReason === null ? null : <p className="task__fail">Reason: {task.failReason}</p>}
            {error === null ? null : <p className="task__fail">{error}</p>}
        </article>
    );
}

/**
 * Leased task. The lease outlives the session: the worker is considered disconnected before
 * the lease expires (`WORKER_DEAD_AFTER_SECONDS` is shorter than any `LEASE_TTL_SECONDS`), so there is
 * a window where the agent is gone but the task status is still `leased`. Showing "agent is working" then
 * is not allowed because it would contradict the "Agent disconnected" banner on the same screen (rpc-design §5, §7).
 */
function LeasedDetails({ task, worker }: { task: UiTask; worker: WorkerStatus }) {
    const progress = task.progressText === null ? '' : `: ${task.progressText}`;

    if (worker.kind === 'disconnected') {
        return (
            <>
                <p className="task__progress">
                    task is still leased to a disconnected agent
                    {task.progressText === null ? '' : `. Last reported: ${task.progressText}`}
                </p>
                <p className="task__hint">
                    It will return to the queue when the lease expires, or earlier if cancelled by hand.
                </p>
            </>
        );
    }

    return (
        <>
            <p className="task__progress">agent is working{progress}</p>
            {/* rpc-design §5: the session cannot be interrupted. Cancellation reaches the agent on its next call. */}
            <p className="task__hint">Cancellation will reach the agent on its next CLI call.</p>
        </>
    );
}

function statusLabel(status: TaskStatus): string {
    switch (status) {
        case 'queued':
            return 'queued';
        case 'leased':
            return 'with agent';
        case 'done':
            return 'done';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
    }
}

function messageOf(failure: unknown): string {
    if (failure instanceof ApiError) {
        return failure.message;
    }
    return 'Failed: unknown error. Check the server output in the terminal.';
}
