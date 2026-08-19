import { CliError } from './errors.js';

/** Parsed CLI invocation. All command inputs are known after argument parsing. */
export type Command =
    | { readonly kind: 'version' }
    | { readonly kind: 'help' }
    | { readonly kind: 'worker-next'; readonly prKey: string | undefined }
    | {
          readonly kind: 'worker-register';
          readonly prKey: string | undefined;
          /** Harness label for worker status in the UI. Optional. */
          readonly harness: string | undefined;
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

const OPTIONS = ['--pr', '--file', '--text', '--reason', '--harness'] as const;
type OptionName = (typeof OPTIONS)[number];

type TaskSubcommand = 'complete' | 'progress' | 'fail';

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

    const { options, positionals } = splitArgs(argv);
    const prKey = options.get('--pr');
    const group = positionals[0];

    if (group === 'worker') {
        return parseWorkerCommand(positionals, options, prKey);
    }
    if (group === 'task') {
        return parseTaskCommand(positionals, options, prKey);
    }

    throw new CliError(
        `sherpa: unknown command ${JSON.stringify(positionals.join(' '))}.\n` +
            'Available commands: `sherpa worker next`, `sherpa task complete|progress|fail <id>`. ' +
            '`sherpa --help` shows the full list.',
    );
}

function parseWorkerCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if ((sub !== 'next' && sub !== 'register') || positionals.length > 2) {
        throw new CliError(
            'sherpa: the `worker` group has two commands: `sherpa worker next` and `sherpa worker register`.',
        );
    }
    if (sub === 'register') {
        const harness = options.get('--harness');
        return { kind: 'worker-register', prKey, harness: harness === '' ? undefined : harness };
    }
    return { kind: 'worker-next', prKey };
}

function parseTaskCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if (sub !== 'complete' && sub !== 'progress' && sub !== 'fail') {
        throw new CliError(
            'sherpa: the `task` group has three commands: `complete`, `progress`, `fail`.\n' +
                'For example: `sherpa task complete 42 --file answer.md`.',
        );
    }
    if (positionals.length > 3) {
        throw new CliError(
            `sherpa: extra arguments for \`task ${sub}\`: ${positionals.slice(3).join(' ')}.\n` +
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
            `sherpa: task number is missing.\nCall \`sherpa task ${sub} <id> ${requiredOptionOf(sub)} "..."\`, ` +
                'using the task number from the output of `sherpa worker next`.',
        );
    }

    // `sherpa/42` instead of `42` is a common model mistake because that is how it sees the task number.
    const digits = raw.startsWith('sherpa/') ? raw.slice('sherpa/'.length) : raw;
    const taskId = Number(digits);
    if (!Number.isInteger(taskId) || taskId <= 0) {
        throw new CliError(
            `sherpa: task number must be a positive number, got ${JSON.stringify(raw)}.\n` +
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
    positionals: readonly string[];
} {
    const options = new Map<OptionName, string>();
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        if (!arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }

        const separator = arg.indexOf('=');
        const name = separator === -1 ? arg : arg.slice(0, separator);
        if (!isOption(name)) {
            throw new CliError(
                `sherpa: unknown flag ${name}.\nAvailable flags: ${OPTIONS.join(', ')}, --version, --help.`,
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

    return { options, positionals };
}

function isOption(name: string): name is OptionName {
    return (OPTIONS as readonly string[]).includes(name);
}
