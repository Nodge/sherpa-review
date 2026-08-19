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
 * Server error. Contract messages are already human-readable, so the CLI prints them as is
 * and adds the next step only where the message doesn't imply it.
 */
export function formatRpcError(error: RpcError['error']): string {
    const lines = [`sherpa: ${error.message}`];
    for (const detail of error.details ?? []) {
        lines.push(`  - ${detail}`);
    }

    const nextStep = NEXT_STEP_BY_CODE[error.code];
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
        `  sherpa worker next                          get the next task (waits up to ${pollMinutes} minutes)`,
        '  sherpa task complete <id> --file <path>     submit the task result',
        '  sherpa task progress <id> --text "<text>"  interim status for the reviewer',
        '  sherpa task fail <id> --reason "<text>"    decline the task with a reason',
        '',
        'Flags:',
        '  --pr <key>    PR to connect to. Defaults to SHERPA_PR',
        '  --version     CLI version',
    ].join('\n');
}

/**
 * Next step by error code. `version_incompatible`, `lease_not_held` and `unknown_task`
 * already come with server instructions, so they are not repeated.
 */
const NEXT_STEP_BY_CODE: Partial<Record<RpcErrorCode, string>> = {
    unauthorized: 'The manifest token is stale. Restart the Sherpa skill.',
    bad_request: 'Check the command arguments and call it again.',
    worker_conflict: 'Another session is working on this PR. Close it or wait for it to disconnect.',
    result_too_large: 'The task is closed. The reviewer can see the reason. Call `sherpa worker next` for the next task.',
    internal: 'Retry the command. If the error persists, restart the Sherpa skill.',
};

function kilobytes(bytes: number): string {
    return `${String(Math.ceil(bytes / 1024))} KB`;
}
