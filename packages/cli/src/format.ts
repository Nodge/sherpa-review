import type { RpcError, RpcErrorCode, Task, TaskAckResponse, TaskCompleteResponse } from '@sherpa/protocol';
import { LONG_POLL_MAX_SECONDS, PROTOCOL_VERSION, RESULT_MAX_BYTES } from '@sherpa/protocol';

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
                `Task sherpa/${String(taskId)} declined successfully. The reviewer can see the reason.\n` +
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
        `sherpa: result is ${kilobytes(bytes)}, limit is ${kilobytes(RESULT_MAX_BYTES)}. Cannot submit this much.\n` +
        `Shorten ${file} and call \`sherpa task complete ${String(taskId)} --file ${file}\` again. ` +
        'The task is still yours. Nothing has been lost.'
    );
}

export function helpText(): string {
    const pollMinutes = String(Math.round(LONG_POLL_MAX_SECONDS / 60));

    return [
        `sherpa ${CLI_VERSION} (protocol ${PROTOCOL_VERSION}), Sherpa worker.`,
        '',
        'Commands:',
        '  sherpa up [--harness <name>]                start the PR server and register as its worker',
        '  sherpa worker register [--harness <name>]    register the session as the PR worker',
        `  sherpa worker next                          get the next task (waits up to ${pollMinutes} minutes)`,
        '  sherpa task complete <id> --file <path>     submit the task result',
        '  sherpa task progress <id> --text "<text>"  interim status for the reviewer',
        '  sherpa task fail <id> --reason "<text>"    decline the task with a reason',
        '',
        'Flags:',
        '  --pr <key>       PR to connect to. Defaults to SHERPA_PR',
        '  --harness <name>  harness label in worker status, for `up` and `worker register`',
        '  --version        CLI version',
    ].join('\n');
}

function nextStepFor(code: RpcErrorCode, role: CallRole): string | undefined {
    // On registration the server asks to wait and retry. The terminal instruction
    // contradicts that because a session denied worker access was never a worker.
    if (code === 'worker_conflict') {
        return role === 'register' ? undefined : WORKER_CONFLICT_STOP;
    }
    return NEXT_STEP_BY_CODE[code];
}

/** Another session took the worker slot during execution. This session cannot continue the loop. */
const WORKER_CONFLICT_STOP =
    'This session is no longer the worker for this PR: stop the loop and do not call `sherpa` again. ' +
    'Another session is continuing the work.';

/**
 * Next step by error code. `version_incompatible`, `lease_not_held` and `unknown_task`
 * already come with server instructions, so they are not repeated.
 */
const NEXT_STEP_BY_CODE: Partial<Record<RpcErrorCode, string>> = {
    unauthorized: 'The manifest token is stale. Restart the Sherpa skill.',
    bad_request: 'Check the command arguments and call it again.',
    result_too_large: 'The task is closed. The reviewer can see the reason. Call `sherpa worker next` for the next task.',
    internal: 'Retry the command. If the error persists, restart the Sherpa skill.',
};

function kilobytes(bytes: number): string {
    return `${String(Math.ceil(bytes / 1024))} KB`;
}
