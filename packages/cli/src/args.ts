import { LONG_POLL_CEILING_SECONDS } from '@sherpa/protocol';

import { CliError } from './errors.js';

/** Parsed CLI invocation. All command inputs are known after argument parsing. */
export type Command =
    | { readonly kind: 'version' }
    | { readonly kind: 'help' }
    | {
          readonly kind: 'up';
          readonly prKey: string | undefined;
          /** Harness label for worker status in the UI. Optional. */
          readonly harness: string | undefined;
          /** Worker model name for worker status in the UI. Optional. */
          readonly model: string | undefined;
          /** Skip opening the browser after a cold start. */
          readonly noOpen: boolean;
      }
    | {
          readonly kind: 'worker-next';
          readonly prKey: string | undefined;
          /** How long the harness can wait for a task. undefined lets the server decide. */
          readonly waitSeconds: number | undefined;
      }
    | {
          readonly kind: 'worker-register';
          readonly prKey: string | undefined;
          /** Harness label for worker status in the UI. Optional. */
          readonly harness: string | undefined;
          /** Worker model name for worker status in the UI. Optional. */
          readonly model: string | undefined;
      }
    | {
          readonly kind: 'task-complete';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly file: string;
      }
    | {
          readonly kind: 'task-progress';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly text: string;
      }
    | {
          readonly kind: 'task-fail';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly reason: string;
      };

const OPTIONS = ['--pr', '--file', '--text', '--reason', '--harness', '--model', '--wait-seconds'] as const;
const FLAGS = ['--no-open'] as const;
type OptionName = (typeof OPTIONS)[number];
type FlagName = (typeof FLAGS)[number];

type TaskSubcommand = 'complete' | 'progress' | 'fail';

/** Contract limit for free-form `harness` and `model` strings (`@sherpa/protocol`). */
const LABEL_MAX_CHARS = 64;

/**
 * Parse arguments. Any malformed input raises `CliError` with a hint for the correct invocation.
 * The model gets command syntax wrong, and the output should help it correct the call (rpc-design §1).
 */
export function parseArgs(argv: readonly string[]): Command {
    if (argv.includes('--version') || argv.includes('-v')) {
        return { kind: 'version' };
    }
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        return { kind: 'help' };
    }

    const { options, flags, positionals } = splitArgs(argv);
    const prKey = options.get('--pr');
    const group = positionals[0];

    if (group !== 'up' && flags.size > 0) {
        throw new CliError('sherpa: --no-open is only available for `sherpa up`.');
    }
    if (group === 'up') {
        return parseUpCommand(positionals, options, flags, prKey);
    }
    if (group === 'worker') {
        return parseWorkerCommand(positionals, options, prKey);
    }
    if (group === 'task') {
        return parseTaskCommand(positionals, options, prKey);
    }

    throw new CliError(
        `sherpa: unknown command ${JSON.stringify(positionals.join(' '))}.\n` +
            'Available: `sherpa up`, `sherpa worker next`, `sherpa task complete|progress|fail <id>`; ' +
            '`sherpa --help` lists them all.',
    );
}

/**
 * Harness or model label from an argument. The model supplies it in whatever form it chooses:
 * in quotes, in backticks, with surrounding whitespace, sometimes beyond the contract limit.
 * A string that is empty after sanitizing is equivalent to an absent parameter.
 */
export function sanitizeLabel(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw
        .replace(/^[\s'"`]+/u, '')
        .replace(/[\s'"`]+$/u, '')
        .slice(0, LABEL_MAX_CHARS)
        .trim();
    return trimmed === '' ? undefined : trimmed;
}

function parseUpCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    flags: ReadonlySet<FlagName>,
    prKey: string | undefined,
): Command {
    if (positionals.length > 1) {
        throw new CliError(
            `sherpa: unexpected arguments after \`up\`: ${positionals.slice(1).join(' ')}.\n` +
                'Expected `sherpa up [--pr <pr key>] [--harness <harness name>] [--model <model name>] [--no-open]`; ' +
                'without `--pr` the PR is taken from the Git branch of the current directory.',
        );
    }

    return {
        kind: 'up',
        prKey,
        harness: sanitizeLabel(options.get('--harness')),
        model: sanitizeLabel(options.get('--model')),
        noOpen: flags.has('--no-open'),
    };
}

function parseWorkerCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if ((sub !== 'next' && sub !== 'register') || positionals.length > 2) {
        throw new CliError(
            'sherpa: group `worker` has two commands — `sherpa worker next` and `sherpa worker register`.',
        );
    }
    if (sub === 'register') {
        return {
            kind: 'worker-register',
            prKey,
            harness: sanitizeLabel(options.get('--harness')),
            model: sanitizeLabel(options.get('--model')),
        };
    }
    return { kind: 'worker-next', prKey, waitSeconds: parseWaitSeconds(options.get('--wait-seconds')) };
}

/**
 * Requested wait for `worker next`: how long the harness can keep the call open (decision #35).
 * The bounds come from the contract (`LONG_POLL_CEILING_SECONDS`). Without the flag, the server decides.
 */
function parseWaitSeconds(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const seconds = Number(raw.trim());
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > LONG_POLL_CEILING_SECONDS) {
        throw new CliError(
            `sherpa: --wait-seconds must be a whole number of seconds from 1 to ` +
                `${String(LONG_POLL_CEILING_SECONDS)}, got ${JSON.stringify(raw)}.\n` +
                'Pass how long you are ready to wait for a task: slightly less than your tool timeout ' +
                'in the foreground, or up to an hour when you poll in the background.',
        );
    }
    return seconds;
}

function parseTaskCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if (sub !== 'complete' && sub !== 'progress' && sub !== 'fail') {
        throw new CliError(
            'sherpa: group `task` has three commands — `complete`, `progress`, `fail`.\n' +
                'For example: `sherpa task complete 42 --file answer.md`.',
        );
    }
    if (positionals.length > 3) {
        throw new CliError(
            `sherpa: unexpected arguments after \`task ${sub}\`: ${positionals.slice(3).join(' ')}.\n` +
                `Expected \`sherpa task ${sub} <id> ${requiredOptionOf(sub)} "..."\`.`,
        );
    }

    const taskId = parseTaskId(positionals[2], sub);

    switch (sub) {
        case 'complete':
            return { kind: 'task-complete', prKey, taskId, file: requireOption(options, '--file', sub) };
        case 'progress':
            return { kind: 'task-progress', prKey, taskId, text: requireOption(options, '--text', sub) };
        case 'fail':
            return { kind: 'task-fail', prKey, taskId, reason: requireOption(options, '--reason', sub) };
    }
}

function parseTaskId(raw: string | undefined, sub: TaskSubcommand): number {
    if (raw === undefined) {
        throw new CliError(
            `sherpa: no task number given.\nCall \`sherpa task ${sub} <id> ${requiredOptionOf(sub)} "..."\`; ` +
                'the task number comes from the output of `sherpa worker next`.',
        );
    }

    // `sherpa/42` instead of `42` is a common model mistake because that is how it sees the task number.
    const digits = raw.startsWith('sherpa/') ? raw.slice('sherpa/'.length) : raw;
    const taskId = Number(digits);
    if (!Number.isInteger(taskId) || taskId <= 0) {
        throw new CliError(
            `sherpa: the task number must be a positive number, got ${JSON.stringify(raw)}.\n` +
                'Take the number from the output of `sherpa worker next` (the `TASK sherpa/<id>` line).',
        );
    }
    return taskId;
}

function requireOption(options: ReadonlyMap<OptionName, string>, name: OptionName, sub: TaskSubcommand): string {
    const value = options.get(name);
    if (value === undefined || value === '') {
        throw new CliError(
            `sherpa: \`task ${sub}\` requires ${name}.\n` +
                `Call \`sherpa task ${sub} <id> ${name} ${name === '--file' ? '<path>' : '"..."'}\`.`,
        );
    }
    return value;
}

function requiredOptionOf(sub: TaskSubcommand): OptionName {
    switch (sub) {
        case 'complete':
            return '--file';
        case 'progress':
            return '--text';
        case 'fail':
            return '--reason';
    }
}

/** Both flag forms are supported: `--file path` and `--file=path`. */
function splitArgs(argv: readonly string[]): {
    options: ReadonlyMap<OptionName, string>;
    flags: ReadonlySet<FlagName>;
    positionals: readonly string[];
} {
    const options = new Map<OptionName, string>();
    const flags = new Set<FlagName>();
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        if (!arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }

        const separator = arg.indexOf('=');
        const name = separator === -1 ? arg : arg.slice(0, separator);
        if (isFlag(name)) {
            if (separator !== -1) {
                throw new CliError(`sherpa: flag ${name} does not take a value.`);
            }
            flags.add(name);
            continue;
        }
        if (!isOption(name)) {
            throw new CliError(
                `sherpa: unknown flag ${name}.\nAvailable: ${[...OPTIONS, ...FLAGS].join(', ')}, --version, --help.`,
            );
        }

        if (separator !== -1) {
            options.set(name, arg.slice(separator + 1));
            continue;
        }

        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new CliError(`sherpa: flag ${name} has no value.`);
        }
        options.set(name, value);
        index += 1;
    }

    return { options, flags, positionals };
}

function isOption(name: string): name is OptionName {
    return (OPTIONS as readonly string[]).includes(name);
}

function isFlag(name: string): name is FlagName {
    return (FLAGS as readonly string[]).includes(name);
}
