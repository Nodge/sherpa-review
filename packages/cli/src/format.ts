import type { RpcError, RpcErrorCode, Task, TaskAckResponse, TaskCompleteResponse } from '@sherpa/protocol';
import {
    LONG_POLL_CEILING_SECONDS,
    LONG_POLL_DEFAULT_SECONDS,
    PROTOCOL_VERSION,
    RESULT_MAX_BYTES,
} from '@sherpa/protocol';

import { CLI_VERSION } from './version.js';

/**
 * Task in prompt format (rpc-design §4): the model reads the output as text, so it contains
 * instructions, context paths and ready-to-run submission commands. Large context stays in files.
 */
export function formatTask(task: Task): string {
    const lines = [
        `TASK sherpa/${String(task.id)} (${task.type}), attempt ${String(task.attempt)}`,
        '',
        task.instructions,
        '',
        `Context: ${task.contextFiles.length === 0 ? 'none' : task.contextFiles.join('\n')}`,
    ];

    if (task.resultSchemaFile !== undefined) {
        lines.push(`Result schema: ${task.resultSchemaFile} — the result is validated against it.`);
    }

    lines.push(
        '',
        'Save the result to a file and submit it:',
        `  sherpa task complete ${String(task.id)} --file <path>`,
        `Interim status: sherpa task progress ${String(task.id)} --text "..."`,
        `Cannot do it: sherpa task fail ${String(task.id)} --reason "..."`,
    );

    return lines.join('\n');
}

/**
 * The only link the skill shows the reviewer. Keep its format stable.
 * The token is in the fragment: it is not sent to the server, but survives page reloads (rpc-design §8).
 */
export function formatUiUrl(port: number, token: string): string {
    return `http://127.0.0.1:${String(port)}/#t=${token}`;
}

/**
 * `sherpa up` output: a link for the reviewer and the session's next step.
 * The output hides the server and registration. The model doesn't need to know about them.
 */
export function formatUpReady(uiUrl: string, prKey: string): string {
    return [
        uiUrl,
        '',
        'Show this link to the user in full — it opens the review in their browser.',
        `Then run \`sherpa worker next --pr ${prKey}\` and follow the instructions in its output.`,
    ].join('\n');
}

/** Worker work is finished: DONE signals the session to exit (rpc-design §3). */
export function formatDone(message: string): string {
    return `${message}\n\nDONE`;
}

export function formatCompleteResponse(response: TaskCompleteResponse, taskId: number): string {
    switch (response.kind) {
        case 'accepted':
            return `${response.message}\nCall \`sherpa worker next\` for the next task.`;
        case 'rejected':
            return [
                `The result of task sherpa/${String(taskId)} was rejected:`,
                ...response.errors.map((error, index) => `  ${String(index + 1)}. ${error}`),
                `Fix it and call \`sherpa task complete ${String(taskId)} --file <path>\` again.`,
            ].join('\n');
        case 'noop':
            return `${response.message}\nCall \`sherpa worker next\` for the next task.`;
    }
}

export function formatProgressResponse(response: TaskAckResponse, taskId: number): string {
    switch (response.kind) {
        case 'accepted':
            return `Status for task sherpa/${String(taskId)} recorded — carry on.`;
        case 'noop':
            return `${response.message}\nCall \`sherpa worker next\` for the next task.`;
    }
}

export function formatFailResponse(response: TaskAckResponse, taskId: number): string {
    switch (response.kind) {
        case 'accepted':
            return (
                `The refusal of task sherpa/${String(taskId)} is accepted, the reviewer sees the reason.\n` +
                'Call `sherpa worker next` for the next task.'
            );
        case 'noop':
            return `${response.message}\nCall \`sherpa worker next\` for the next task.`;
    }
}

/**
 * Call role in the worker lifecycle. Determines the next step on `worker_conflict`.
 * `register`: the session is only asking to become a worker and hasn't been one yet.
 * `worker`: the session worked as a worker and lost the slot.
 */
export type CallRole = 'register' | 'worker';

/**
 * Server error. Contract messages are already human-readable, so the CLI prints them as is
 * and adds the next step only where the message doesn't imply it.
 */
export function formatRpcError(error: RpcError['error'], role: CallRole): string {
    const lines = [`sherpa: ${error.message}`];
    for (const detail of error.details ?? []) {
        lines.push(`  - ${detail}`);
    }

    const nextStep = nextStepFor(error.code, role);
    if (nextStep !== undefined) {
        lines.push(nextStep);
    }
    return lines.join('\n');
}

/**
 * Local rejection before sending. An oversized result would make the server fail the task,
 * while here the task stays leased and the model can try shortening the file (decision log).
 */
export function formatOversizedResult(taskId: number, file: string, bytes: number): string {
    return (
        `sherpa: the result is ${kilobytes(bytes)} while the limit is ${kilobytes(RESULT_MAX_BYTES)} — ` +
        `too large to submit.\nShorten ${file} and call ` +
        `\`sherpa task complete ${String(taskId)} --file ${file}\` again. ` +
        'The task stays yours, nothing is lost.'
    );
}

export function helpText(): string {
    const commands: readonly (readonly [string, string])[] = [
        [
            'sherpa up [--harness <name>] [--model <name>] [--lang <ru|en>] [--no-open]',
            'start the PR server and become its worker',
        ],
        [
            'sherpa worker register [--harness <name>] [--model <name>] [--lang <ru|en>]',
            'register this session as the PR worker',
        ],
        [
            'sherpa worker next [--wait-seconds <n>]',
            'take the next task; waits out --wait-seconds, then reports an idle queue',
        ],
        ['sherpa task complete <id> --file <path>', 'submit the result of a task'],
        ['sherpa task progress <id> --text "<text>"', 'interim status for the reviewer'],
        ['sherpa task fail <id> --reason "<text>"', 'refuse a task with a reason'],
    ];
    const flags: readonly (readonly [string, string])[] = [
        ['--pr <key>', 'the PR to connect to. Defaults to SHERPA_PR, then to the PR of the Git branch here'],
        ['--harness <name>', 'harness label in the worker status; for `up` and `worker register`'],
        ['--model <name>', 'model name in the worker status; for `up` and `worker register`'],
        [
            '--lang <ru|en>',
            'the language you speak with the reviewer in; hints the UI language, omit if unsure',
        ],
        ['--no-open', 'do not open the browser after `up` starts a new server'],
        [
            '--wait-seconds <n>',
            `how long \`worker next\` may block, 1..${String(LONG_POLL_CEILING_SECONDS)}; ` +
                `default ${String(LONG_POLL_DEFAULT_SECONDS)}`,
        ],
        ['--version', 'CLI version'],
    ];

    return [
        `sherpa ${CLI_VERSION} (protocol ${PROTOCOL_VERSION}) — the Sherpa worker CLI.`,
        '',
        'Commands:',
        ...twoColumns(commands),
        '',
        'Flags:',
        ...twoColumns(flags),
    ].join('\n');
}

/** Help alignment. The description column is shared across the whole block. */
function twoColumns(rows: readonly (readonly [string, string])[]): string[] {
    const width = Math.max(...rows.map(([left]) => left.length));
    return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

function nextStepFor(code: RpcErrorCode, role: CallRole): string | undefined {
    // Our server doesn't return a conflict for registration, as it takes over the slot. But if one responds
    // (a different build), the terminal suffix is wrong: this session was never a worker.
    if (code === 'worker_conflict') {
        return role === 'register' ? undefined : WORKER_CONFLICT_STOP;
    }
    return NEXT_STEP_BY_CODE[code];
}

/**
 * The worker slot went to another session during work, so the loop can't continue.
 * The phrase "stop the loop" is a marker from SKILL.md. Don't change it independently of that file.
 */
const WORKER_CONFLICT_STOP =
    'This session is no longer the worker of this PR: stop the loop and do not call `sherpa` again — ' +
    'another session has taken over.';

/**
 * Next step by error code. `version_incompatible`, `lease_not_held` and `unknown_task`
 * already come with server instructions, so they are not repeated.
 */
const NEXT_STEP_BY_CODE: Partial<Record<RpcErrorCode, string>> = {
    unauthorized: 'The token from the manifest is stale — restart the Sherpa skill.',
    bad_request: 'Check the command arguments and call it again.',
    result_too_large:
        'The task is closed and the reviewer sees why — call `sherpa worker next` for the next one.',
    internal: 'Repeat the command; if it keeps failing, restart the Sherpa skill.',
};

function kilobytes(bytes: number): string {
    return `${String(Math.ceil(bytes / 1024))} KB`;
}
