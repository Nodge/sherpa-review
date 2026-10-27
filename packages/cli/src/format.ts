import type {
    RpcError,
    RpcErrorCode,
    Task,
    TaskAckResponse,
    TaskCompleteResponse,
} from '@sherpa/protocol';
import { PROTOCOL_VERSION, RESULT_MAX_BYTES } from '@sherpa/protocol';

import { CLI_VERSION } from './version.js';

/** How printed commands run the CLI: the `sherpa.mjs` file and the PR key the CLI connected to. */
export interface CommandTarget {
    readonly cliPath: string;
    readonly prKey: string;
}

/**
 * Command the CLI prints for the model: `node <sherpa.mjs> <words> --pr <key> [<placeholder>]`.
 * The full path and key let a command copied as is work from any cwd, without the checkout
 * where the CLI discovers the PR, or substituting the skill path. The caller quotes values in `words`
 * through `shellQuote`.
 * The placeholder (`--text "..."`) goes last. The model replaces it with its own text.
 */
function commandLine(target: CommandTarget, words: string, placeholder?: string): string {
    const parts = ['node', shellQuote(target.cliPath), words, '--pr', shellQuote(target.prKey)];
    return (placeholder === undefined ? parts : [...parts, placeholder]).join(' ');
}

export function workerNextCommand(target: CommandTarget): string {
    return commandLine(target, 'worker next');
}

export function taskCompleteCommand(target: CommandTarget, taskId: number, file: string): string {
    return commandLine(target, `task complete ${String(taskId)} --file ${shellQuote(file)}`);
}

export function taskProgressCommand(target: CommandTarget, taskId: number): string {
    return commandLine(target, `task progress ${String(taskId)}`, '--text "..."');
}

export function taskFailCommand(target: CommandTarget, taskId: number): string {
    return commandLine(target, `task fail ${String(taskId)}`, '--reason "..."');
}

/**
 * A word for a POSIX shell: safe text stays as is, the rest gets single quotes.
 * A leading `=` is quoted because zsh expands `=cmd` to the command path.
 */
export function shellQuote(value: string): string {
    return /^[\w@%+:,./-][\w@%+=:,./-]*$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Task in prompt format (`docs/protocol.md §4`). The model reads the output as text, so it contains
 * instructions, context paths, the CLI-assigned result file and ready-to-use submission commands.
 * Large context stays in files.
 */
export function formatTask(task: Task, resultFile: string, target: CommandTarget): string {
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
        `Write the result to ${resultFile} and submit it:`,
        `  ${taskCompleteCommand(target, task.id, resultFile)}`,
        `Interim status: ${taskProgressCommand(target, task.id)}`,
        `Cannot do it: ${taskFailCommand(target, task.id)}`,
    );

    return lines.join('\n');
}

/**
 * The only link the skill shows the reviewer. Keep its format stable.
 * The token is in the fragment: it never reaches the server but survives page reloads (`docs/protocol.md §8`).
 */
export function formatUiUrl(port: number, token: string, host = '127.0.0.1'): string {
    const authority = host.includes(':') ? `[${host}]` : host;
    return `http://${authority}:${String(port)}/#t=${token}`;
}

/** What is being reviewed locally, as a line in the `up` output. */
export interface LocalReviewSummary {
    /** How the server computes the base when none was given, in the VCS plugin wording. */
    readonly defaultBase: string;
    readonly repo: string;
    readonly branch: string;
    /** Explicit base. undefined means the server computes it. */
    readonly base: string | undefined;
    /** Instruction for the review outcome, confirmed by the server (`--verdicts`). null means review without verdicts. */
    readonly verdicts: string | null;
}

/**
 * `sherpa up` output: a link for the reviewer and the session's next step.
 * The output hides the server and registration. The model doesn't need to know about them.
 */
export function formatUpReady(uiUrl: string, target: CommandTarget, local: LocalReviewSummary | null = null): string {
    const lines = [uiUrl, ''];
    if (local !== null) {
        lines.push(
            `Reviewing the working tree of ${local.repo} on branch ${local.branch}, ` +
                `base ${local.base ?? local.defaultBase}.`,
        );
        if (local.verdicts !== null) {
            lines.push(
                'The reviewer finishes with Ship or Request changes; both arrive as a `review.feedback` task ' +
                    `that repeats the user's instruction: "${local.verdicts}".`,
            );
        }
    }

    lines.push(
        'Show this link to the user in full — it opens the review in their browser.',
        `Then run \`${workerNextCommand(target)}\` and follow the instructions in its output.`,
    );
    return lines.join('\n');
}

/** Worker work is finished. The word DONE tells the session to end (`docs/protocol.md §3`). */
export function formatDone(message: string): string {
    return `${message}\n\nDONE`;
}

/** `file` is the absolute file path from `complete`. A repeated command uses the same one. */
export function formatCompleteResponse(
    response: TaskCompleteResponse,
    taskId: number,
    file: string,
    target: CommandTarget,
): string {
    switch (response.kind) {
        case 'accepted':
            return `${response.message}\n${callForNextTask(target)}`;
        case 'rejected':
            return [
                `The result of task sherpa/${String(taskId)} was rejected:`,
                ...response.errors.map((error, index) => `  ${String(index + 1)}. ${error}`),
                `Fix it and call \`${taskCompleteCommand(target, taskId, file)}\` again.`,
            ].join('\n');
        case 'noop':
            return `${response.message}\n${callForNextTask(target)}`;
    }
}

export function formatProgressResponse(response: TaskAckResponse, taskId: number, target: CommandTarget): string {
    switch (response.kind) {
        case 'accepted':
            return `Status for task sherpa/${String(taskId)} recorded — carry on.`;
        case 'noop':
            return `${response.message}\n${callForNextTask(target)}`;
    }
}

export function formatFailResponse(response: TaskAckResponse, taskId: number, target: CommandTarget): string {
    switch (response.kind) {
        case 'accepted':
            return (
                `The refusal of task sherpa/${String(taskId)} is accepted, the reviewer sees the reason.\n` +
                callForNextTask(target)
            );
        case 'noop':
            return `${response.message}\n${callForNextTask(target)}`;
    }
}

function callForNextTask(target: CommandTarget): string {
    return `Call \`${workerNextCommand(target)}\` for the next task.`;
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
export function formatRpcError(error: RpcError['error'], role: CallRole, target: CommandTarget): string {
    const lines = [`sherpa: ${error.message}`];
    for (const detail of error.details ?? []) {
        lines.push(`  - ${detail}`);
    }

    const nextStep = nextStepFor(error.code, role, target);
    if (nextStep !== undefined) {
        lines.push(nextStep);
    }
    return lines.join('\n');
}

/**
 * Local rejection before sending. An oversized result would make the server fail the task,
 * but this leaves it leased so the model can try to shorten the file.
 */
export function formatOversizedResult(taskId: number, file: string, bytes: number, target: CommandTarget): string {
    return (
        `sherpa: the result is ${kilobytes(bytes)} while the limit is ${kilobytes(RESULT_MAX_BYTES)} — ` +
        `too large to submit.\nShorten ${file} and call ` +
        `\`${taskCompleteCommand(target, taskId, file)}\` again. ` +
        'The task stays yours, nothing is lost.'
    );
}

export function helpText(): string {
    const commands: readonly (readonly [string, string])[] = [
        [
            'sherpa up [--local <path> [--verdicts <instruction>]] [--harness <name>] [--model <name>] ' +
                '[--lang <ru|en>] [--no-open]',
            'start the review server and become its worker',
        ],
        [
            'sherpa worker register [--harness <name>] [--model <name>] [--lang <ru|en>]',
            'register this session as the PR worker',
        ],
        ['sherpa worker next', 'take the next task; waits for one as long as it takes'],
        ['sherpa task complete <id> --file <path>', 'submit the result of a task'],
        ['sherpa task progress <id> --text "<text>"', 'interim status for the reviewer'],
        ['sherpa task fail <id> --reason "<text>"', 'refuse a task with a reason'],
    ];
    const flags: readonly (readonly [string, string])[] = [
        ['--pr <key>', 'the PR to connect to; defaults to SHERPA_PR, then to the PR of the current branch here'],
        [
            '--local <path>',
            'review the working tree of this project directory instead of a PR; only for `up`',
        ],
        ['--base <ref>', 'what the working tree is compared with; only with `--local`'],
        [
            '--verdicts <instruction>',
            "the user's instruction for the outcome of the review, in their words; the reviewer then " +
                'finishes with Ship or Request changes instead of Comment; only with `--local`',
        ],
        ['--harness <name>', 'harness label in the worker status; for `up` and `worker register`'],
        ['--model <name>', 'model name in the worker status; for `up` and `worker register`'],
        [
            '--lang <ru|en>',
            'the language you speak with the reviewer in; hints the UI language, omit if unsure',
        ],
        ['--no-open', 'do not open the browser after `up` starts a new server'],
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

function nextStepFor(code: RpcErrorCode, role: CallRole, target: CommandTarget): string | undefined {
    // Our server doesn't return a conflict for registration, as it takes over the slot. But if one responds
    // (a different build), the terminal suffix is wrong: this session was never a worker.
    if (code === 'worker_conflict') {
        return role === 'register' ? undefined : WORKER_CONFLICT_STOP;
    }
    return NEXT_STEP_BY_CODE[code]?.(target);
}

/**
 * The worker slot went to another session during work, so the loop can't continue.
 * The phrase "stop the loop" is a marker from SKILL.md. Don't change it independently of that file.
 */
const WORKER_CONFLICT_STOP =
    'This session is no longer the worker of this PR: stop the loop and do not call `sherpa` again — ' +
    'another session has taken over.';

/**
 * Next step by error code. The server already supplies instructions for `version_incompatible` and `unknown_task`,
 * so don't repeat them. For `lease_not_held`, the server instruction names
 * `worker next` briefly. The CLI adds the full command.
 */
const NEXT_STEP_BY_CODE: Partial<Record<RpcErrorCode, (target: CommandTarget) => string>> = {
    unauthorized: () => 'The token from the manifest is stale — restart the Sherpa skill.',
    bad_request: () => 'Check the command arguments and call it again.',
    result_too_large: (target) =>
        `The task is closed and the reviewer sees why — call \`${workerNextCommand(target)}\` for the next one.`,
    lease_not_held: (target) => `The full \`worker next\` command: \`${workerNextCommand(target)}\``,
    internal: () => 'Repeat the command; if it keeps failing, restart the Sherpa skill.',
};

function kilobytes(bytes: number): string {
    return `${String(Math.ceil(bytes / 1024))} KB`;
}
